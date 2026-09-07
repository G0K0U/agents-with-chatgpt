import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type {
  AppServerClient,
  AppServerNotification,
  AppServerRequest,
  RpcId,
} from "../src/execution/app-server.js";
import { CodexTaskManager } from "../src/execution/tasks.js";
import { appendExecutionRecord, readExecutionRecords } from "../src/execution/records.js";
import {
  acquireWorkspaceSlot,
  readWorkspaceSlot,
  releaseWorkspaceSlot,
} from "../src/execution/slot.js";
import { C2CSessionRegistry } from "../src/session/registry.js";
import { Workspace } from "../src/workspace/manager.js";
import { getStateDir, writeSecureJson } from "../src/config/paths.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

class BootstrapFakeAppServer implements AppServerClient {
  private notificationHandler: ((notification: AppServerNotification) => void | Promise<void>) | null = null;
  private requestHandler: ((request: AppServerRequest) => void | Promise<void>) | null = null;

  constructor(private readonly completes = true) {}

  async initialize(): Promise<void> {}

  async request<T>(method: string): Promise<T> {
    if (method === "thread/start") return { thread: { id: "thread-bootstrap" } } as T;
    if (method === "turn/start") {
      if (this.completes) {
        queueMicrotask(() => {
          this.notificationHandler?.({
            method: "turn/completed",
            params: { threadId: "thread-bootstrap", turnId: "turn-bootstrap", status: "completed" },
          });
        });
      }
      return { turn: { id: "turn-bootstrap" } } as T;
    }
    if (method === "turn/interrupt") {
      queueMicrotask(() => {
        this.notificationHandler?.({
          method: "turn/completed",
          params: { threadId: "thread-bootstrap", turnId: "turn-bootstrap", status: "interrupted" },
        });
      });
    }
    return {} as T;
  }

  notify(): void {}

  setNotificationHandler(handler: (notification: AppServerNotification) => void | Promise<void>): void {
    this.notificationHandler = handler;
  }

  setRequestHandler(handler: (request: AppServerRequest) => void | Promise<void>): void {
    this.requestHandler = handler;
  }

  respond(_id: RpcId, _result: unknown): void {}

  respondError(_id: RpcId, _code: number, _message: string): void {}

  async close(): Promise<void> {}
}

async function waitForTerminal(manager: CodexTaskManager, taskId: string): Promise<ReturnType<CodexTaskManager["get"]>> {
  for (let i = 0; i < 100; i++) {
    const task = manager.get(taskId);
    if (["completed", "failed", "cancelled", "interrupted", "timed_out"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Task ${taskId} did not finish`);
}

describe("Codex bootstrap task/session/slot state", () => {
  let root: string;
  let workspace: Workspace;
  let sessions: C2CSessionRegistry;
  let manager: CodexTaskManager;

  function newManager(fake = new BootstrapFakeAppServer(), registry = sessions): CodexTaskManager {
    return new CodexTaskManager(workspace, {
      appServerFactory: () => fake,
      sessionRegistry: registry,
      taskTimeoutMs: 5_000,
      interruptGraceMs: 50,
    });
  }

  beforeEach(() => {
    isolateStateDir();
    root = makeTmpDir("bootstrap-state-workspace");
    makeGitRepo(root);
    write(root, "tests/fixture.txt", "bootstrap\n");
    workspace = new Workspace(root);
    sessions = new C2CSessionRegistry();
    manager = newManager();
  });

  afterEach(async () => {
    await manager.close();
    cleanup(root);
    delete process.env.C2C_STATE_DIR;
  });

  it("persists the task before returning and keeps session.lastTaskId equal", () => {
    const submitted = manager.submit({
      workspace_id: workspace.id,
      instruction: "persist before acknowledgement",
      write_scope: ["tests"],
      run_tests: false,
    });

    const immediate = manager.get(submitted.taskId);
    expect(immediate.taskId).toBe(submitted.taskId);
    expect(immediate.sessionId).toBe(submitted.sessionId);
    expect(sessions.getOwned(submitted.sessionId!, "local", workspace.id).lastTaskId).toBe(submitted.taskId);
  });

  it("supports submit followed immediately by cancel and releases the slot", async () => {
    await manager.close();
    manager = newManager(new BootstrapFakeAppServer(false));

    const submitted = manager.submit({
      workspace_id: workspace.id,
      instruction: "cancel immediately after submit",
      write_scope: ["tests"],
      run_tests: false,
    });
    const cancelled = await manager.cancel(submitted.taskId);

    expect(cancelled.status).toBe("cancelled");
    expect(readWorkspaceSlot(workspace.id)).toBeNull();
  });

  it("clears a ghost lock when the referenced task is missing", () => {
    acquireWorkspaceSlot(workspace.id, "c2c_abcdef01");
    expect(readWorkspaceSlot(workspace.id)?.taskId).toBe("c2c_abcdef01");

    expect(() => manager.get("c2c_abcdef01")).toThrow();
    expect(readWorkspaceSlot(workspace.id)).toBeNull();
  });

  it("clears an orphaned terminal-task lock during manager restart", async () => {
    const submitted = manager.submit({
      workspace_id: workspace.id,
      instruction: "create a terminal task for restart reconciliation",
      write_scope: ["tests"],
      run_tests: false,
    });
    await waitForTerminal(manager, submitted.taskId);
    acquireWorkspaceSlot(workspace.id, submitted.taskId);
    expect(readWorkspaceSlot(workspace.id)?.taskId).toBe(submitted.taskId);

    await manager.close();
    const restartedSessions = new C2CSessionRegistry({ file: sessions.file });
    manager = newManager(new BootstrapFakeAppServer(), restartedSessions);

    expect(readWorkspaceSlot(workspace.id)).toBeNull();
  });

  it("releases the workspace slot exactly once when a task reaches terminal", async () => {
    const submitted = manager.submit({
      workspace_id: workspace.id,
      instruction: "release the writer slot at terminal",
      write_scope: ["tests"],
      run_tests: false,
    });
    const terminal = await waitForTerminal(manager, submitted.taskId);

    expect(terminal.status).toBe("completed");
    expect(readWorkspaceSlot(workspace.id)).toBeNull();
    expect(releaseWorkspaceSlot(workspace.id, submitted.taskId)).toBe(false);
  });

  it("reconciles a terminal blocked execution record over stale running task metadata", async () => {
    await manager.close();
    const session = sessions.create({
      ownerId: "local",
      workspaceId: workspace.id,
      title: "stale task recovery",
      goalSummary: "reconcile task and execution truth after a crash",
    });
    const taskId = "c2c_0a3a9c832495";
    const submittedAt = "2026-09-02T11:00:00.000Z";
    const completedAt = "2026-09-02T11:05:38.793Z";
    const taskFile = path.join(getStateDir(), "tasks", workspace.id, `${taskId}.json`);
    writeSecureJson(taskFile, {
      taskId,
      workspaceId: workspace.id,
      ownerId: "local",
      sessionId: session.id,
      instruction: "recover the stale task lifecycle",
      instructionHash: "legacy-hash",
      writeScope: ["tests"],
      fullAccess: false,
      networkRequested: false,
      networkEffective: false,
      networkReported: false,
      network: false,
      runTests: false,
      approvalMode: "workspace_write",
      status: "running",
      submittedAt,
      startedAt: submittedAt,
      changedFiles: [],
      tests: null,
      outputIds: [],
      approvalEvents: [],
      executionRecorded: false,
    });
    appendExecutionRecord(workspace.id, {
      taskId,
      workspaceId: workspace.id,
      ownerId: "local",
      sessionId: session.id,
      iteration: 1,
      changedFiles: ["tests/fixture.txt"],
      tests: "verification blocked",
      exitStatus: "blocked",
      timestamp: completedAt,
      network: false,
    });
    acquireWorkspaceSlot(workspace.id, taskId);

    const restartedSessions = new C2CSessionRegistry({ file: sessions.file });
    manager = newManager(new BootstrapFakeAppServer(), restartedSessions);
    const repaired = manager.get(taskId);

    expect(repaired).toMatchObject({
      taskId,
      status: "failed",
      exitStatus: "blocked",
      completedAt,
      executionSummaryAvailable: true,
      error: { code: "CODEX_EXECUTION_FAILED" },
    });
    expect(repaired.changedFiles).toEqual(["tests/fixture.txt"]);
    expect(restartedSessions.getOwned(session.id, "local", workspace.id)).toMatchObject({
      lastTaskId: taskId,
      currentState: "failed",
    });
    expect(readWorkspaceSlot(workspace.id)).toBeNull();
    expect(readExecutionRecords(workspace.id, 100).filter((record) => record.taskId === taskId)).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(taskFile, "utf8"))).toMatchObject({
      status: "failed",
      executionRecorded: true,
    });
  });

  it("lets final completed task truth win over an early and late-stale interrupted record", async () => {
    await manager.close();
    const session = sessions.create({
      ownerId: "local",
      workspaceId: workspace.id,
      title: "final session truth",
      goalSummary: "keep the completed task authoritative after restart",
      id: "c2cs_efa378104ff4585c5fba285b",
    });
    const taskId = "c2c_8b7502ef1fe6";
    const taskFile = path.join(getStateDir(), "tasks", workspace.id, `${taskId}.json`);
    const early = "2026-09-02T13:40:00.000Z";
    const completedAt = "2026-09-02T13:42:29.000Z";
    const verification = {
      profileId: "c2c-bridge-in-process",
      workspaceId: workspace.id,
      executable: "node.exe",
      argvHash: "a".repeat(64),
      cwd: "c2c-runtime:/verification" as const,
      startedAt: "2026-09-02T13:42:20.000Z",
      completedAt,
      exitCode: 0,
      network: false as const,
      sandbox: "workspaceWrite" as const,
      status: "passed" as const,
    };
    writeSecureJson(taskFile, {
      taskId,
      workspaceId: workspace.id,
      ownerId: "local",
      sessionId: session.id,
      instruction: "finish the bridge stabilization task",
      instructionHash: "final-task-hash",
      writeScope: ["tests"],
      queuePosition: 17,
      fullAccess: false,
      networkRequested: false,
      networkEffective: false,
      networkReported: false,
      network: false,
      runTests: true,
      approvalMode: "workspace_write",
      status: "completed",
      submittedAt: "2026-09-02T13:30:00.000Z",
      completedAt,
      changedFiles: ["src/execution/tasks.ts"],
      tests: "verification passed",
      exitStatus: "ok",
      outputIds: [],
      approvalEvents: [],
      verification,
      executionRecorded: false,
    });

    appendExecutionRecord(workspace.id, {
      taskId,
      workspaceId: workspace.id,
      ownerId: "local",
      sessionId: session.id,
      taskStatus: "interrupted",
      iteration: 1,
      changedFiles: [],
      tests: null,
      exitStatus: "blocked",
      timestamp: early,
      network: false,
    });
    appendExecutionRecord(workspace.id, {
      taskId,
      workspaceId: workspace.id,
      ownerId: "local",
      sessionId: session.id,
      taskStatus: "completed",
      iteration: 1,
      changedFiles: ["src/execution/tasks.ts"],
      tests: "verification passed",
      exitStatus: "ok",
      timestamp: completedAt,
      network: false,
      verification,
    });
    // A buffered/late historical line can arrive after the final task record.
    // Its append position must not be allowed to regress the task or session.
    appendExecutionRecord(workspace.id, {
      taskId,
      workspaceId: workspace.id,
      ownerId: "local",
      sessionId: session.id,
      taskStatus: "interrupted",
      iteration: 1,
      changedFiles: [],
      tests: null,
      exitStatus: "blocked",
      timestamp: "2026-09-02T13:41:00.000Z",
      network: false,
    });

    const restartedSessions = new C2CSessionRegistry({ file: sessions.file });
    manager = newManager(new BootstrapFakeAppServer(), restartedSessions);

    expect(manager.get(taskId)).toMatchObject({
      taskId,
      status: "completed",
      exitStatus: "ok",
      tests: "verification passed",
      verification: { status: "passed", exitCode: 0 },
    });
    expect(restartedSessions.getOwned(session.id, "local", workspace.id)).toMatchObject({
      lastTaskId: taskId,
      currentState: "completed",
      verificationStatus: "passed",
    });
  });

  it("preserves immutable network truth when history is appended out of timestamp order", async () => {
    await manager.close();
    const session = sessions.create({
      ownerId: "local",
      workspaceId: workspace.id,
      title: "network truth",
      goalSummary: "preserve the original network policy across restart",
    });
    const taskId = "c2c_0a3a9c832495";
    const taskFile = path.join(getStateDir(), "tasks", workspace.id, `${taskId}.json`);
    writeSecureJson(taskFile, {
      taskId,
      workspaceId: workspace.id,
      ownerId: "local",
      sessionId: session.id,
      instruction: "preserve the explicitly requested network policy",
      instructionHash: "network-task-hash",
      writeScope: ["tests"],
      queuePosition: 18,
      fullAccess: true,
      networkRequested: true,
      networkEffective: true,
      networkReported: null,
      network: true,
      runTests: false,
      approvalMode: "workspace_write",
      status: "running",
      submittedAt: "2026-09-02T11:00:00.000Z",
      startedAt: "2026-09-02T11:00:01.000Z",
      changedFiles: [],
      tests: null,
      outputIds: [],
      approvalEvents: [],
      executionRecorded: false,
    });

    // The later timeout evidence is written first, followed by a stale early
    // blocked line. Bootstrap must use event time, not JSONL append position.
    appendExecutionRecord(workspace.id, {
      taskId,
      workspaceId: workspace.id,
      ownerId: "local",
      sessionId: session.id,
      taskStatus: "failed",
      iteration: 1,
      changedFiles: [],
      tests: null,
      exitStatus: "timeout",
      timestamp: "2026-09-02T11:35:28.693Z",
      networkRequested: true,
      networkEffective: true,
      network: true,
    });
    appendExecutionRecord(workspace.id, {
      taskId,
      workspaceId: workspace.id,
      ownerId: "local",
      sessionId: session.id,
      iteration: 1,
      changedFiles: [],
      tests: null,
      exitStatus: "blocked",
      timestamp: "2026-09-02T11:05:38.793Z",
      network: false,
    });

    const restartedSessions = new C2CSessionRegistry({ file: sessions.file });
    manager = newManager(new BootstrapFakeAppServer(), restartedSessions);
    const recovered = manager.get(taskId);

    expect(recovered).toMatchObject({
      taskId,
      status: "failed",
      networkRequested: true,
      networkEffective: true,
      network: true,
      networkPolicy: { requested: true, effective: true },
    });
    expect(recovered.networkReported).toBeNull();
    expect(JSON.parse(fs.readFileSync(taskFile, "utf8"))).toMatchObject({
      networkRequested: true,
      networkEffective: true,
      network: true,
    });
  });

  it("repairs a terminal task that was persisted before its audit line", async () => {
    await manager.close();
    const taskId = "c2c_1234abcd5678";
    const completedAt = "2026-09-02T12:05:00.000Z";
    const taskFile = path.join(getStateDir(), "tasks", workspace.id, `${taskId}.json`);
    writeSecureJson(taskFile, {
      taskId,
      workspaceId: workspace.id,
      ownerId: "local",
      instruction: "repair a task whose audit append was interrupted",
      instructionHash: "terminal-task-hash",
      writeScope: ["tests"],
      queuePosition: 7,
      fullAccess: false,
      networkRequested: false,
      networkEffective: false,
      networkReported: false,
      network: false,
      runTests: false,
      approvalMode: "workspace_write",
      status: "completed",
      submittedAt: "2026-09-02T12:00:00.000Z",
      completedAt,
      changedFiles: ["tests/fixture.txt"],
      tests: null,
      outputIds: [],
      approvalEvents: [],
      executionRecorded: false,
    });

    const restarted = newManager(new BootstrapFakeAppServer());
    manager = restarted;
    const repaired = manager.get(taskId);

    expect(repaired).toMatchObject({
      taskId,
      status: "completed",
      completedAt,
      executionSummaryAvailable: true,
    });
    expect(readExecutionRecords(workspace.id, 100).filter((record) => record.taskId === taskId)).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(taskFile, "utf8"))).toMatchObject({
      status: "completed",
      executionRecorded: true,
    });
  });

  it("preserves a queued task across controlled manager restart and replays it FIFO", async () => {
    await manager.close();
    manager = newManager(new BootstrapFakeAppServer(false));

    const running = manager.submit({
      workspace_id: workspace.id,
      instruction: "hold the writer so the next task is queued",
      write_scope: ["tests"],
      run_tests: false,
    });
    for (let i = 0; i < 100; i++) {
      if (manager.get(running.taskId).status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(manager.get(running.taskId).status).toBe("running");

    const queued = manager.submit({
      workspace_id: workspace.id,
      instruction: "resume this queued task after the controlled restart",
      write_scope: ["tests"],
      run_tests: false,
    });
    expect(manager.get(queued.taskId)).toMatchObject({ status: "queued", queuePosition: expect.any(Number) });

    await manager.close();
    const restartedSessions = new C2CSessionRegistry({ file: sessions.file });
    manager = newManager(new BootstrapFakeAppServer(true), restartedSessions);

    const resumed = await waitForTerminal(manager, queued.taskId);
    expect(resumed.status).toBe("completed");
    expect(resumed.error).toBeNull();
    expect(manager.get(running.taskId).status).toBe("interrupted");
    expect(restartedSessions.getOwned(queued.sessionId!, "local", workspace.id).currentState).toBe("completed");
  });
});
