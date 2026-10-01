import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type {
  AppServerClient,
  AppServerFactoryOptions,
  AppServerNotification,
  AppServerRequest,
  RpcId,
} from "../src/execution/app-server.js";
import { codexAppServerArgs } from "../src/execution/app-server.js";
import { CodexTaskManager, TaskError, evaluateCodexApproval, validateCodexTask } from "../src/execution/tasks.js";
import { prepareCodexRuntime } from "../src/execution/runtime.js";
import type { VerificationProfile } from "../src/execution/verification.js";
import { Workspace } from "../src/workspace/manager.js";
import { gitDiff } from "../src/workspace/git.js";
import { readExecutionRecords } from "../src/execution/records.js";
import { listExecutionOutputs, readExecutionOutput } from "../src/execution/output.js";
import { C2CSessionRegistry } from "../src/session/registry.js";
import { nullLogger } from "../src/logger/index.js";
import { getStateDir, writeSecureJson } from "../src/config/paths.js";
import { makeTmpDir, cleanup, write, makeGitRepo, git, isolateStateDir } from "./helpers.js";

class FakeAppServer implements AppServerClient {
  private notificationHandler: ((notification: AppServerNotification) => void | Promise<void>) | null = null;
  private requestHandler: ((request: AppServerRequest) => void | Promise<void>) | null = null;
  private responses = new Map<RpcId, unknown>();
  readonly requests: { method: string; params: unknown }[] = [];
  interrupted = false;
  closed = false;
  readonly verificationRequests: { method: string; params: unknown }[] = [];

  constructor(
    private readonly fixture?: string,
    private readonly completeTurn = true,
    private readonly unsafePath?: string,
    private readonly verificationResult: { exitCode: number | null; stdout: string; stderr: string } = {
      exitCode: 0,
      stdout: "10 passed\n",
      stderr: "",
    },
    private readonly reportedPaths?: string[]
  ) {}

  async initialize(): Promise<void> {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      // The official server echoes the started thread's model back.
      const requestedModel = (params as { model?: string } | undefined)?.model;
      return { thread: { id: "thread-fake-1" }, ...(requestedModel ? { model: requestedModel } : {}) } as T;
    }
    if (method === "turn/start") {
      if (this.completeTurn) queueMicrotask(() => this.complete());
      return { turn: { id: "turn-fake-1" } } as T;
    }
    if (method === "command/exec") {
      this.verificationRequests.push({ method, params });
      return this.verificationResult as T;
    }
    if (method === "turn/interrupt") {
      this.interrupted = true;
      queueMicrotask(() =>
        this.notificationHandler?.({
          method: "turn/completed",
          params: { threadId: "thread-fake-1", turnId: "turn-fake-1", status: "interrupted" },
        })
      );
      return {} as T;
    }
    return {} as T;
  }

  notify(): void {}

  setNotificationHandler(handler: (notification: AppServerNotification) => void | Promise<void>): void {
    this.notificationHandler = handler;
  }

  emit(notification: AppServerNotification): void {
    void this.notificationHandler?.(notification);
  }

  setRequestHandler(handler: (request: AppServerRequest) => void | Promise<void>): void {
    this.requestHandler = handler;
  }

  respond(id: RpcId, result: unknown): void {
    this.responses.set(id, result);
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.responses.set(id, { error: { code, message } });
  }

  async serverRequest(method: string, params: unknown): Promise<unknown> {
    const id = `approval-${this.responses.size + 1}`;
    await this.requestHandler?.({ id, method, params });
    return this.responses.get(id);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private complete(): void {
    if (this.fixture) fs.appendFileSync(this.fixture, "C2C_SMOKE_OK\n");
    if (this.unsafePath) fs.appendFileSync(this.unsafePath, "UNSCOPED_WRITE\n");
    const changedPaths = this.reportedPaths ?? [this.fixture ?? "tests/fixture.txt", ...(this.unsafePath ? [this.unsafePath] : [])];
    this.notificationHandler?.({
      method: "item/started",
      params: {
        threadId: "thread-fake-1",
        turnId: "turn-fake-1",
        item: {
          type: "fileChange",
          id: "file-fake-1",
          changes: changedPaths.map((filePath) => ({ path: filePath })),
        },
      },
    });
    this.notificationHandler?.({
      method: "item/completed",
      params: {
        threadId: "thread-fake-1",
        turnId: "turn-fake-1",
        item: {
          type: "commandExecution",
          id: "command-fake-1",
          command: "node --test",
          aggregatedOutput: "\u001b[32m1 pass\u001b[0m\n",
          exitCode: 0,
        },
      },
    });
    this.notificationHandler?.({
      method: "turn/completed",
      params: { threadId: "thread-fake-1", turnId: "turn-fake-1", status: "completed" },
    });
  }
}

async function waitForTerminal(manager: CodexTaskManager, taskId: string): Promise<ReturnType<CodexTaskManager["get"]>> {
  for (let i = 0; i < 100; i++) {
    const view = manager.get(taskId);
    if (["completed", "failed", "cancelled", "interrupted", "timed_out"].includes(view.status)) return view;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Task ${taskId} did not finish`);
}

async function waitForTurn(manager: CodexTaskManager, taskId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (manager.get(taskId).turnId === "turn-fake-1") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Task ${taskId} did not start a turn`);
}

describe("controlled Codex task execution", () => {
  let root: string;
  let workspace: Workspace;
  let fake: FakeAppServer;
  let manager: CodexTaskManager;

  function testVerificationProfile(workspaceId: string): VerificationProfile {
    return {
      id: "python-pytest",
      workspaceId,
      executable: "node",
      argv: ["--version"],
      cwd: "workspace",
      timeoutMs: 5_000,
      network: false,
      sandbox: "readOnly",
      summaryKind: "pytest",
    };
  }

  beforeEach(() => {
    isolateStateDir();
    root = makeTmpDir("task-ws");
    makeGitRepo(root);
    const fixture = write(root, "tests/fixture.txt", "before\n");
    git(root, "add", "tests/fixture.txt");
    git(root, "commit", "-m", "add task fixture");
    workspace = new Workspace(root);
    fake = new FakeAppServer(fixture);
    manager = new CodexTaskManager(workspace, {
      appServerFactory: () => fake,
      verificationProfileResolver: (current) => testVerificationProfile(current.id),
    });
  });

  afterEach(async () => {
    await manager.close();
    cleanup(root);
  });

  it("runs a scoped task and records reviewable changes and sanitized test output", async () => {
    const submitted = manager.submit({
      workspace_id: workspace.id,
      instruction: "Append the smoke marker to the existing fixture and run the permitted test.",
      write_scope: ["tests"],
      network: false,
      run_tests: true,
      approval_mode: "workspace_write",
    });
    expect(["queued", "running"]).toContain(submitted.status);

    const result = await waitForTerminal(manager, submitted.taskId);
    expect(result.status).toBe("completed");
    expect(result.changedFiles).toContain("tests/fixture.txt");
    expect(result.tests).toBe("10 passed");
    expect(submitted.network).toBe(false);
    expect(result.executionSummaryAvailable).toBe(true);

    const records = readExecutionRecords(workspace.id, 5);
    expect(records.at(-1)?.taskId).toBe(submitted.taskId);
    expect(records.at(-1)?.network).toBe(false);
    expect(records.at(-1)?.exitStatus).toBe("ok");
    expect(gitDiff(workspace, { mode: "unstaged" }).diff).toContain("C2C_SMOKE_OK");

    const outputs = listExecutionOutputs(workspace.id);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].taskId).toBe(submitted.taskId);
    expect(readExecutionOutput(workspace.id, outputs[0].id)).toMatchObject({ ok: true });
    expect(fake.verificationRequests).toHaveLength(1);
    expect(fake.verificationRequests[0].params).toMatchObject({
      command: ["node", "--version"],
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
  });

  it("passes a bridge-owned external Serena runtime to the official App Server adapter", async () => {
    let captured: AppServerFactoryOptions | null = null;
    manager = new CodexTaskManager(workspace, {
      appServerFactory: (options) => {
        captured = options;
        return fake;
      },
    });
    const submitted = manager.submit({
      workspace_id: workspace.id,
      instruction: "Append the smoke marker to the existing fixture.",
      write_scope: ["tests"],
      network: false,
      run_tests: false,
    });
    const result = await waitForTerminal(manager, submitted.taskId);

    expect(result.status).toBe("completed");
    expect(captured?.workspaceRoot).toBe(workspace.root);
    const serenaHome = captured?.env?.SERENA_HOME;
    expect(serenaHome).toBeTruthy();
    expect(captured?.serenaRuntimeHome).toBe(serenaHome);
    expect(captured?.networkAccess).toBe(false);
    expect(fs.realpathSync.native(serenaHome!)).not.toBe(workspace.root);
    expect(fs.existsSync(path.join(serenaHome!, "serena_config.yml"))).toBe(true);
    expect(fs.existsSync(path.join(serenaHome!, "projects", workspace.id, ".serena"))).toBe(true);
    const config = fs.readFileSync(path.join(serenaHome!, "serena_config.yml"), "utf8");
    expect(config).toContain("project_serena_folder_location:");
    expect(config).not.toContain(path.join(workspace.root, ".serena"));
  });

  it("accepts a normal pre-existing Serena config inside the runtime root", () => {
    const serenaHome = path.join(getStateDir(), "runtime", "workspaces-v2", workspace.id, "serena");
    fs.mkdirSync(serenaHome, { recursive: true });
    fs.writeFileSync(path.join(serenaHome, "serena_config.yml"), "# pre-existing regular file\n");

    const runtime = prepareCodexRuntime(root, workspace.id);

    expect(runtime.serenaHome.toLowerCase()).toContain(path.join("runtime", "workspaces-v2", workspace.id, "serena").toLowerCase());
    expect(fs.lstatSync(path.join(runtime.serenaHome, "serena_config.yml")).isFile()).toBe(true);
  });

  it("rejects a Serena runtime junction that escapes the C2C runtime root", () => {
    const outside = makeTmpDir("serena-runtime-escape");
    const serenaHome = path.join(getStateDir(), "runtime", "workspaces-v2", workspace.id, "serena");
    fs.mkdirSync(path.dirname(serenaHome), { recursive: true });
    try {
      try {
        fs.symlinkSync(outside, serenaHome, "junction");
      } catch {
        // Unelevated Windows runners may disallow junction creation. The
        // normal-file regression above remains deterministic on all runners.
        return;
      }
      expect(() => prepareCodexRuntime(root, workspace.id)).toThrow(/escaped/i);
    } finally {
      cleanup(outside);
    }
  });

  it("fails closed when the configured C2C state directory is inside the workspace", () => {
    process.env.C2C_STATE_DIR = root;
    expect(() => prepareCodexRuntime(root, workspace.id)).toThrow(/outside the connected workspace/);
  });

  it("does not attribute pre-existing dirty files to a new task", async () => {
    const existingUntracked = write(root, "tests/pre-existing.txt", "keep this\n");
    const existingTracked = write(root, "hello.txt", "pre-existing edit\n");
    const submitted = manager.submit({
      workspace_id: workspace.id,
      instruction: "Append the smoke marker to the fixture.",
      write_scope: ["tests"],
      network: false,
      run_tests: false,
    });
    const result = await waitForTerminal(manager, submitted.taskId);

    expect(result.status).toBe("completed");
    expect(result.changedFiles).toContain("tests/fixture.txt");
    expect(result.changedFiles).not.toContain("tests/pre-existing.txt");
    expect(result.changedFiles).not.toContain("hello.txt");
    expect(fs.readFileSync(existingUntracked, "utf8")).toBe("keep this\n");
    expect(fs.readFileSync(existingTracked, "utf8")).toBe("pre-existing edit\n");
  });

  it("still fails closed for an actual out-of-scope file-change event", async () => {
    const outside = path.join(root, "README.md");
    manager = new CodexTaskManager(workspace, {
      appServerFactory: () => new FakeAppServer(null, true, outside),
    });
    const submitted = manager.submit({
      workspace_id: workspace.id,
      instruction: "Attempt a change outside the declared directory.",
      write_scope: ["tests"],
      network: false,
      run_tests: false,
    });
    const result = await waitForTerminal(manager, submitted.taskId);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("WRITE_SCOPE_VIOLATION");
    expect(result.changedFiles).toContain("README.md");
  });

  it("does not treat the C2C runtime directory as a writable task scope", () => {
    const runtime = prepareCodexRuntime(root, workspace.id);
    const decision = evaluateCodexApproval(
      "item/commandExecution/requestApproval",
      {
        threadId: "thread-fake-1",
        turnId: "turn-fake-1",
        command: "node --test",
        cwd: root,
        additionalPermissions: { fileSystem: { write: [runtime.serenaProjectData] } },
      },
      {
        workspace,
        threadId: "thread-fake-1",
        turnId: "turn-fake-1",
        writableRoots: [path.join(root, "tests")],
        pendingItems: new Map(),
        active: true,
      }
    );

    expect(decision).toEqual({ decision: "decline", reason: "WRITE_SCOPE_VIOLATION" });
  });

  it("rejects invalid workspace, malformed tasks, out-of-scope writes, network, and escalation", () => {
    const base = {
      workspace_id: workspace.id,
      instruction: "change the fixture",
      write_scope: ["tests"],
      network: false,
    };
    expect(() => manager.submit({ ...base, workspace_id: "wrong-workspace" })).toThrowError(TaskError);
    expect(() => manager.submit({ ...base, instruction: { text: "no" } })).toThrowError(/instruction/);
    expect(() => manager.submit({ ...base, write_scope: ["../outside"] })).toThrowError(/outside|PATH_OUTSIDE_WORKSPACE/);
    expect(() => manager.submit({ ...base, write_scope: ["."] })).toThrowError(TaskError);
    try {
      manager.submit({ ...base, network: true });
      expect.unreachable("network escalation should be rejected");
    } catch (error) {
      expect(error).toMatchObject({ code: "NETWORK_NOT_ALLOWED" });
    }
    expect(() => manager.submit({ ...base, sandbox: "danger-full-access" })).toThrowError(/Unsupported task field/);
    expect(() => manager.submit({ ...base, approval_mode: "danger_full_access" })).toThrowError(/workspace_write/);
    expect(() => manager.submit({ ...base, profile: "developer-research" })).toThrowError(/Unsupported task field/);
  });

  it("defaults omitted network to online, honors explicit offline, and gates opt-in by mode", () => {
    try {
      validateCodexTask(workspace, {
        workspace_id: workspace.id,
        instruction: "ordinary task",
        write_scope: ["tests"],
      });
      expect.unreachable("omitted network (online default) must be rejected without full access");
    } catch (error) {
      expect(error).toMatchObject({ code: "NETWORK_NOT_ALLOWED" });
    }

    const explicitOffline = validateCodexTask(workspace, {
      workspace_id: workspace.id,
      instruction: "explicit offline task",
      write_scope: ["tests"],
      network: false,
    });
    expect(explicitOffline.network).toBe(false);

    const fullAccessDefault = validateCodexTask(workspace, {
      workspace_id: workspace.id,
      instruction: "full-access task with the online default",
      write_scope: ["tests"],
    }, { fullAccess: true });
    expect(fullAccessDefault.fullAccess).toBe(true);
    expect(fullAccessDefault.network).toBe(true);

    const fullAccessOptOut = validateCodexTask(workspace, {
      workspace_id: workspace.id,
      instruction: "full-access task with explicit offline",
      write_scope: ["tests"],
      network: false,
    }, { fullAccess: true });
    expect(fullAccessOptOut.network).toBe(false);

    const fullAccessOptIn = validateCodexTask(workspace, {
      workspace_id: workspace.id,
      instruction: "full-access task with explicit network opt-in",
      write_scope: ["tests"],
      network: true,
    }, { fullAccess: true });
    expect(fullAccessOptIn.network).toBe(true);
  });

  it("keeps the selected full-access mode while preserving each task's network decision", () => {
    const sessions = new C2CSessionRegistry();
    manager = new CodexTaskManager(workspace, {
      appServerFactory: () => fake,
      sessionRegistry: sessions,
      fullAccess: true,
    });
    const session = sessions.create({
      ownerId: "owner",
      workspaceId: workspace.id,
      title: "ordinary coding session",
      goalSummary: "keep the coding task in the selected local deployment mode",
    });
    const continued = manager.submit({
      workspace_id: workspace.id,
      instruction: "continue the ordinary coding task",
      write_scope: ["tests"],
      network: false,
      run_tests: false,
    }, { ownerId: "owner", sessionId: session.id });
    expect(continued.network).toBe(false);
    const upgraded = manager.submit({
      workspace_id: workspace.id,
      instruction: "continue with the explicitly authorized full-access mode",
      write_scope: ["tests"],
      network: true,
      run_tests: false,
    }, { ownerId: "owner", sessionId: session.id });
    expect(upgraded.network).toBe(true);
  });

  it.each(["queued", "running", "cancelling", "completed"])("never dispatches saved retired-backend work (%s)", async (status) => {
    await manager.close();
    const taskId = "c2c_deadbeef";
    const file = path.join(getStateDir(), "tasks", workspace.id, `${taskId}.json`);
    writeSecureJson(file, {
      taskId, workspaceId: workspace.id, ownerId: "owner",
      orchestrator: "retired-backend", provider: "codex",
      instructionHash: "historical", instruction: "do not replay this work",
      writeScope: ["tests"], network: false, runTests: false,
      approvalMode: "workspace_write", status,
      submittedAt: new Date().toISOString(), changedFiles: [], tests: null,
      outputIds: [], approvalEvents: [], executionRecorded: true,
    });
    manager = new CodexTaskManager(workspace, { appServerFactory: () => fake });
    const result = manager.get(taskId);
    expect(result.status).toBe(status === "completed" ? "completed" : "interrupted");
    if (status !== "completed") expect(result.error?.code).toBe("UNSUPPORTED_SAVED_BACKEND");
    expect(result).not.toHaveProperty("orchestrator");
    await manager.close();
    expect(fake.requests).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).status).toBe(result.status);
  });

  it("waits through a retryable Codex error notification for the matching completed turn", async () => {
    fake = new FakeAppServer(undefined, false);
    manager = new CodexTaskManager(workspace, { appServerFactory: () => fake });
    const task = manager.submit({ workspace_id: workspace.id, instruction: "Reply with a short marker.",
      write_scope: ["tests"], network: false, run_tests: false });
    await waitForTurn(manager, task.taskId);
    fake.emit({ method: "error", params: { threadId: "thread-fake-1", turnId: "turn-fake-1",
      error: { message: "temporary provider error" }, willRetry: true } });
    expect(manager.get(task.taskId).status).toBe("running");
    fake.emit({ method: "turn/completed", params: { threadId: "thread-fake-1", turnId: "turn-fake-1",
      turn: { id: "turn-fake-1", status: "completed", error: null } } });
    const result = await waitForTerminal(manager, task.taskId);
    expect(result.status).toBe("completed");
    expect(result.error).toBeNull();
  });

  it("extracts and classifies the official nested Codex model rejection", async () => {
    fake = new FakeAppServer(undefined, false);
    manager = new CodexTaskManager(workspace, { appServerFactory: () => fake });
    const task = manager.submit({ workspace_id: workspace.id, instruction: "Reply with a short marker.",
      write_scope: ["tests"], network: false, run_tests: false });
    await waitForTurn(manager, task.taskId);
    fake.emit({ method: "error", params: { threadId: "thread-fake-1", turnId: "turn-fake-1",
      error: { message: JSON.stringify({ type: "error", status: 400, error: {
        type: "invalid_request_error", message: "The 'gpt-6-sol' model is not supported for this account.",
      } }) }, willRetry: false } });
    const result = await waitForTerminal(manager, task.taskId);
    expect(result.status).toBe("failed");
    expect(result.error).toEqual({ code: "CODEX_MODEL_UNAVAILABLE",
      message: "The 'gpt-6-sol' model is not supported for this account." });
    expect(result.actionEvidence?.turnCompleted).toBe(false);
  });

  it("reads a failed turn's error when no earlier error notification arrived", async () => {
    fake = new FakeAppServer(undefined, false);
    manager = new CodexTaskManager(workspace, { appServerFactory: () => fake });
    const task = manager.submit({ workspace_id: workspace.id, instruction: "Reply with a short marker.",
      write_scope: ["tests"], network: false, run_tests: false });
    await waitForTurn(manager, task.taskId);
    fake.emit({ method: "turn/completed", params: { threadId: "thread-fake-1", turnId: "turn-fake-1",
      turn: { id: "turn-fake-1", status: "failed", error: {
        message: "Account usage limit exceeded", codexErrorInfo: "usageLimitExceeded",
      } } } });
    const result = await waitForTerminal(manager, task.taskId);
    expect(result.status).toBe("failed");
    expect(result.error).toEqual({ code: "CODEX_EXECUTION_FAILED", message: "Account usage limit exceeded" });
  });

  it("preserves a persisted effective network flag before exposing task metadata", () => {
    const taskId = "c2c_deadbeef";
    const file = path.join(getStateDir(), "tasks", workspace.id, `${taskId}.json`);
    writeSecureJson(file, {
      taskId,
      workspaceId: workspace.id,
      ownerId: "owner",
      instructionHash: "legacy",
      writeScope: ["tests"],
      network: true,
      runTests: false,
      approvalMode: "workspace_write",
      status: "completed",
      submittedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      changedFiles: [],
      tests: null,
      exitStatus: "ok",
      outputIds: [],
      approvalEvents: [],
      executionRecorded: true,
    });

    const reloaded = new CodexTaskManager(workspace, { fullAccess: true, appServerFactory: () => fake });
    manager = reloaded;
    expect(reloaded.get(taskId).network).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ network: true });
  });

  it("repairs a legacy task without a network field to the offline default", () => {
    const taskId = "c2c_abcdef12";
    const file = path.join(getStateDir(), "tasks", workspace.id, `${taskId}.json`);
    writeSecureJson(file, {
      taskId,
      workspaceId: workspace.id,
      ownerId: "owner",
      instructionHash: "legacy",
      writeScope: ["tests"],
      runTests: false,
      approvalMode: "workspace_write",
      status: "completed",
      submittedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      changedFiles: [],
      tests: null,
      exitStatus: "ok",
      outputIds: [],
      approvalEvents: [],
      executionRecorded: true,
    });

    const reloaded = new CodexTaskManager(workspace, { appServerFactory: () => fake });
    manager = reloaded;
    expect(reloaded.get(taskId).network).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ network: false });
  });

  it("uses the official interrupt lifecycle for cancellation", async () => {
    const delayed = new FakeAppServer(undefined, false);
    manager = new CodexTaskManager(workspace, { appServerFactory: () => delayed });
    const submitted = manager.submit({
      workspace_id: workspace.id,
      instruction: "wait for cancellation",
      write_scope: ["tests"],
      network: false,
      run_tests: false,
    });
    for (
      let i = 0;
      i < 100 && (!manager.get(submitted.taskId).threadId || !manager.get(submitted.taskId).turnId);
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const cancelled = await manager.cancel(submitted.taskId);
    expect(cancelled.status).toBe("cancelled");
    expect(delayed.interrupted).toBe(true);
    expect(readExecutionRecords(workspace.id, 5).at(-1)?.exitStatus).toBe("cancelled");
  });

  it("fails closed for stale, invalid, and network approval requests", async () => {
    fake = new FakeAppServer(undefined, false);
    manager = new CodexTaskManager(workspace, { appServerFactory: () => fake });
    const submitted = manager.submit({
      workspace_id: workspace.id,
      instruction: "hold for approval checks",
      write_scope: ["tests"],
      network: false,
      run_tests: false,
    });
    for (
      let i = 0;
      i < 100 && (!manager.get(submitted.taskId).threadId || !manager.get(submitted.taskId).turnId);
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // A stale approval is rejected before any command or file permission is inspected.
    const stale = await fake.serverRequest("item/commandExecution/requestApproval", {
      threadId: "thread-fake-1",
      turnId: "wrong-turn",
      command: "node --test",
      cwd: root,
    });
    expect(stale).toMatchObject({ error: { message: "STALE_APPROVAL" } });

    const network = await fake.serverRequest("item/commandExecution/requestApproval", {
      threadId: "thread-fake-1",
      turnId: "turn-fake-1",
      command: "curl https://example.invalid",
      cwd: root,
    });
    expect(network).toMatchObject({ error: { message: "NETWORK_NOT_ALLOWED" } });

    const invalid = evaluateCodexApproval(
      "item/commandExecution/requestApproval",
      { threadId: "thread-fake-1", turnId: "turn-fake-1", command: "node --test" },
      {
        workspace,
        threadId: "thread-fake-1",
        turnId: "turn-fake-1",
        writableRoots: [path.join(root, "tests")],
        pendingItems: new Map(),
        active: true,
      }
    );
    expect(invalid.decision).toBe("decline");

    const context = {
      workspace,
      threadId: "thread-fake-1",
      turnId: "turn-fake-1",
      writableRoots: [path.join(root, "tests")],
      pendingItems: new Map<string, unknown>([
        [
          "outside-file-change",
          { type: "fileChange", changes: [{ path: path.join(root, "hello.txt") }] },
        ],
      ]),
      active: true,
    };
    const outsideChange = evaluateCodexApproval(
      "item/fileChange/requestApproval",
      { itemId: "outside-file-change", threadId: "thread-fake-1", turnId: "turn-fake-1" },
      context
    );
    expect(outsideChange).toEqual({ decision: "decline", reason: "WRITE_SCOPE_VIOLATION" });

    const extraNetwork = evaluateCodexApproval(
      "item/commandExecution/requestApproval",
      {
        threadId: "thread-fake-1",
        turnId: "turn-fake-1",
        command: "node tests/smoke-check.js",
        cwd: root,
        additionalPermissions: { network: { enabled: true } },
      },
      context
    );
    expect(extraNetwork).toEqual({ decision: "decline", reason: "NETWORK_NOT_ALLOWED" });
  });

  it("accepts active command/file approvals in explicit full-access mode", () => {
    const decision = evaluateCodexApproval(
      "item/commandExecution/requestApproval",
      {
        threadId: "thread-fake-1",
        turnId: "turn-fake-1",
        command: "node --version",
        cwd: "C:/outside-the-workspace",
        additionalPermissions: { fileSystem: { write: ["C:/outside-the-workspace"] } },
      },
      {
        workspace,
        threadId: "thread-fake-1",
        turnId: "turn-fake-1",
        writableRoots: [path.join(root, "tests")],
        pendingItems: new Map(),
        active: true,
        fullAccess: true,
        network: true,
      }
    );
    expect(decision).toEqual({ decision: "accept", reason: "FULL_ACCESS" });

    const networkDecision = evaluateCodexApproval(
      "item/commandExecution/requestApproval",
      {
        threadId: "thread-fake-1",
        turnId: "turn-fake-1",
        command: "curl https://example.invalid",
        cwd: "C:/outside-the-workspace",
      },
      {
        workspace,
        threadId: "thread-fake-1",
        turnId: "turn-fake-1",
        writableRoots: [path.join(root, "tests")],
        pendingItems: new Map(),
        active: true,
        fullAccess: true,
        network: true,
      }
    );
    expect(networkDecision).toEqual({ decision: "accept", reason: "FULL_ACCESS" });

    const offlineFullAccessNetwork = evaluateCodexApproval(
      "item/commandExecution/requestApproval",
      {
        threadId: "thread-fake-1",
        turnId: "turn-fake-1",
        command: "curl https://example.invalid",
        cwd: "C:/outside-the-workspace",
      },
      {
        workspace,
        threadId: "thread-fake-1",
        turnId: "turn-fake-1",
        writableRoots: [path.join(root, "tests")],
        pendingItems: new Map(),
        active: true,
        fullAccess: true,
        network: false,
      }
    );
    expect(offlineFullAccessNetwork).toEqual({ decision: "decline", reason: "NETWORK_NOT_ALLOWED" });
  });

  it("bounds a stalled approval policy and finalizes the task", async () => {
    await manager.close();
    fake = new FakeAppServer(undefined, false);
    manager = new CodexTaskManager(workspace, {
      appServerFactory: () => fake,
      approvalTimeoutMs: 50,
      interruptGraceMs: 50,
      approvalEvaluator: async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { decision: "accept", reason: "SCOPED_COMMAND" };
      },
    });
    const submitted = manager.submit({
      workspace_id: workspace.id,
      instruction: "wait for approval timeout",
      write_scope: ["tests"],
      network: false,
      run_tests: false,
    });
    for (let i = 0; i < 100 && !manager.get(submitted.taskId).turnId; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const approval = await fake.serverRequest("item/commandExecution/requestApproval", {
      threadId: "thread-fake-1",
      turnId: "turn-fake-1",
      command: "node --version",
      cwd: root,
    });
    const result = await waitForTerminal(manager, submitted.taskId);
    expect(approval).toMatchObject({ error: { message: "APPROVAL_TIMEOUT" } });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("APPROVAL_TIMEOUT");
    expect(readExecutionRecords(workspace.id, 20).filter((record) => record.taskId === submitted.taskId)).toHaveLength(1);
  });

  it("returns a typed terminal failure when no verification profile is registered", async () => {
    await manager.close();
    fake = new FakeAppServer();
    manager = new CodexTaskManager(workspace, {
      appServerFactory: () => fake,
      verificationProfileResolver: () => null,
    });
    const result = manager.submit({
      workspace_id: workspace.id,
      instruction: "run the local verification",
      write_scope: ["tests"],
      network: false,
      run_tests: true,
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("NO_VERIFICATION_PROFILE");
    expect(result.exitStatus).toBe("failed");
    expect(result.tests).toBe("verification not run: no registered profile");
    expect(fake.requests).toHaveLength(0);
    expect(readExecutionRecords(workspace.id, 5).at(-1)).toMatchObject({
      taskId: result.taskId,
      exitStatus: "failed",
    });
  });

  it("turns a registered verification nonzero exit into a failed audited task", async () => {
    await manager.close();
    fake = new FakeAppServer(undefined, true, undefined, {
      exitCode: 1,
      stdout: "2 failed, 8 passed\n",
      stderr: "failure details\n",
    });
    manager = new CodexTaskManager(workspace, {
      appServerFactory: () => fake,
      verificationProfileResolver: (current) => testVerificationProfile(current.id),
    });
    const submitted = manager.submit({
      workspace_id: workspace.id,
      instruction: "make a controlled change and verify it",
      write_scope: ["tests"],
      network: false,
      run_tests: true,
    });
    const result = await waitForTerminal(manager, submitted.taskId);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("VERIFICATION_EXECUTION_FAILED");
    expect(result.exitStatus).toBe("failed");
    expect(result.tests).toBe("2 failed, 8 passed");
    expect(result.verification).toMatchObject({ status: "failed", exitCode: 1, network: false });
    expect(readExecutionOutput(workspace.id, result.outputIds.at(-1)!)).toMatchObject({ ok: true });
  });

  it("times out an unfinished turn, interrupts it, and writes one timeout record", async () => {
    await manager.close();
    fake = new FakeAppServer(undefined, false);
    manager = new CodexTaskManager(workspace, {
      appServerFactory: () => fake,
      taskTimeoutMs: 100,
      interruptGraceMs: 50,
      verificationProfileResolver: (current) => testVerificationProfile(current.id),
    });
    const submitted = manager.submit({
      workspace_id: workspace.id,
      instruction: "wait forever",
      write_scope: ["tests"],
      network: false,
      run_tests: false,
    });
    const result = await waitForTerminal(manager, submitted.taskId);

    expect(result.status).toBe("failed");
    expect(result.exitStatus).toBe("timeout");
    expect(result.error?.code).toBe("TASK_TIMEOUT");
    expect(fake.interrupted).toBe(true);
    expect(readExecutionRecords(workspace.id, 20).filter((record) => record.taskId === submitted.taskId)).toHaveLength(1);
  });

  it("makes cancellation win before completion and does not duplicate the audit record", async () => {
    await manager.close();
    fake = new FakeAppServer(undefined, false);
    manager = new CodexTaskManager(workspace, {
      appServerFactory: () => fake,
      verificationProfileResolver: (current) => testVerificationProfile(current.id),
    });
    const submitted = manager.submit({
      workspace_id: workspace.id,
      instruction: "wait for a cancellation race",
      write_scope: ["tests"],
      network: false,
      run_tests: false,
    });
    for (let i = 0; i < 100 && !manager.get(submitted.taskId).turnId; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const cancelled = await manager.cancel(submitted.taskId);
    expect(cancelled.status).toBe("cancelled");
    expect((await manager.cancel(submitted.taskId)).status).toBe("cancelled");
    expect(readExecutionRecords(workspace.id, 20).filter((record) => record.taskId === submitted.taskId)).toHaveLength(1);
  });

  it("does not accept a permission grant shape for an unknown approval request", async () => {
    fake = new FakeAppServer(undefined, false);
    await manager.close();
    manager = new CodexTaskManager(workspace, {
      appServerFactory: () => fake,
      verificationProfileResolver: (current) => testVerificationProfile(current.id),
    });
    const submitted = manager.submit({
      workspace_id: workspace.id,
      instruction: "hold for permission checks",
      write_scope: ["tests"],
      network: false,
      run_tests: false,
    });
    for (let i = 0; i < 100 && !manager.get(submitted.taskId).turnId; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const response = await fake.serverRequest("item/permissions/requestApproval", {
      threadId: "thread-fake-1",
      turnId: "turn-fake-1",
      permissions: { network: true },
    });
    expect(response).toMatchObject({ error: { message: "UNSUPPORTED_APPROVAL" } });
  });

  it("uses the explicitly selected full-access App Server mode", async () => {
    await manager.close();
    fake = new FakeAppServer(undefined, true);
    manager = new CodexTaskManager(workspace, {
      appServerFactory: () => fake,
      fullAccess: true,
    });
    const submitted = manager.submit({
      workspace_id: workspace.id,
      instruction: "perform the explicitly authorized full-access smoke task",
      write_scope: ["."],
      network: true,
      run_tests: false,
    });
    const result = await waitForTerminal(manager, submitted.taskId);

    expect(result.status).toBe("completed");
    expect(result.network).toBe(true);
    expect(fake.requests.find((request) => request.method === "thread/start")?.params).toMatchObject({
      sandbox: "danger-full-access",
    });
    expect(fake.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  });

  it("normalizes workspace path events and excludes external paths in full-access mode", async () => {
    await manager.close();
    const workspacePath = path.join(root, "src", "execution", "app-server.ts").replace(/\//g, "\\");
    const externalPath = path.join(path.dirname(root), "outside", "secret.txt").replace(/\//g, "\\");
    fake = new FakeAppServer(undefined, true, undefined, undefined, [workspacePath, externalPath]);
    manager = new CodexTaskManager(workspace, {
      appServerFactory: () => fake,
      fullAccess: true,
    });
    const submitted = manager.submit({
      workspace_id: workspace.id,
      instruction: "Report one workspace path and one external path.",
      write_scope: ["."],
      run_tests: false,
    });
    const result = await waitForTerminal(manager, submitted.taskId);

    expect(result.status).toBe("completed");
    expect(result.changedFiles).toContain("src/execution/app-server.ts");
    expect(result.changedFiles).not.toContain(externalPath.replace(/\\/g, "/"));
  });

  it("requires a bridge restart for an absolute workspace src path event", async () => {
    await manager.close();
    const workspacePath = path.join(root, "src", "execution", "app-server.ts").replace(/\//g, "\\");
    fake = new FakeAppServer(undefined, true, undefined, undefined, [workspacePath]);
    manager = new CodexTaskManager(workspace, {
      appServerFactory: () => fake,
      fullAccess: true,
      restartRequiredResolver: (changedFiles) => changedFiles.some((file) => /^(?:src)(?:\/|$)/i.test(file)),
    });
    const submitted = manager.submit({
      workspace_id: workspace.id,
      instruction: "Report an absolute bridge source path.",
      write_scope: ["."],
      run_tests: false,
    });
    const result = await waitForTerminal(manager, submitted.taskId);

    expect(result.changedFiles).toContain("src/execution/app-server.ts");
    expect(result.restartRequired).toBe(true);
  });

  it("preserves an explicit offline decision through the fake transport", async () => {
    await manager.close();
    fake = new FakeAppServer(undefined, true);
    manager = new CodexTaskManager(workspace, {
      appServerFactory: () => fake,
      fullAccess: true,
    });
    const submitted = manager.submit({
      workspace_id: workspace.id,
      instruction: "perform an ordinary offline full-access task",
      write_scope: ["."],
      network: false,
      run_tests: false,
    });
    const result = await waitForTerminal(manager, submitted.taskId);

    expect(result.status).toBe("completed");
    expect(result.network).toBe(false);
    expect(fake.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  });

  it("keeps bridge-owned verification offline after a coding task opts in to network", async () => {
    await manager.close();
    fake = new FakeAppServer(undefined, true);
    manager = new CodexTaskManager(workspace, {
      appServerFactory: () => fake,
      fullAccess: true,
      verificationProfileResolver: (current) => testVerificationProfile(current.id),
    });
    const submitted = manager.submit({
      workspace_id: workspace.id,
      instruction: "use the explicitly authorized network coding mode, then verify locally",
      write_scope: ["."],
      network: true,
      run_tests: true,
    });
    const result = await waitForTerminal(manager, submitted.taskId);

    expect(result.status).toBe("completed");
    expect(result.network).toBe(true);
    expect(result.networkRequested).toBe(true);
    expect(result.networkEffective).toBe(true);
    expect(result.networkReported).toBe(true);
    expect(result.networkPolicy).toEqual({ requested: true, effective: true, reported: true });
    expect(result.verification).toMatchObject({ network: false, status: "passed" });
    expect(fake.verificationRequests[0].params).toMatchObject({
      command: ["node", "--version"],
      sandboxPolicy: { networkAccess: false },
    });
    expect(readExecutionRecords(workspace.id, 5).at(-1)).toMatchObject({
      networkRequested: true,
      networkEffective: true,
      networkReported: true,
      networkPolicy: { requested: true, effective: true, reported: true },
    });
  });

  it.each([
    { label: "empty model", patch: { model: "" } },
    { label: "shell metacharacters in model", patch: { model: "gpt-6-astra; rm -rf /" } },
    { label: "oversized model", patch: { model: "g".repeat(65) } },
    { label: "invalid effort", patch: { effort: "max; rm -rf /" } },
    { label: "oversized effort", patch: { effort: "m".repeat(21) } },
  ])("rejects an out-of-bounds continuation pin ($label) before dispatch", ({ patch }) => {
    const continuation = {
      idempotencyKey: "invalid-pin", model: "gpt-6-sol", effort: "max", timeoutMs: 10000,
      authorize: () => true, ...patch,
    } as NonNullable<Parameters<CodexTaskManager["submit"]>[1]>["continuation"];
    expect(() => manager.submit({
      workspace_id: workspace.id, provider: "codex", instruction: "Validate the continuation model pin.",
      write_scope: ["tests"], network: false, run_tests: false,
    }, { ownerId: "owner", workspaceId: workspace.id, continuation })).toThrow("Continuation owner/model/budget mismatch");
  });

  it("routes an explicit catalog selection to thread/start and turn/start with echo confirmation", async () => {
    const selection = {
      model: "gpt-6-astra", effort: "max",
      binding_source: "explicit-task" as const,
      catalog_revision: "test-revision", catalog_confirmed: true,
    };
    const view = manager.submit({
      workspace_id: workspace.id, provider: "codex", instruction: "Run with the dynamically selected model.",
      write_scope: ["tests"], network: false, run_tests: false,
    }, { ownerId: "owner", workspaceId: workspace.id, selection });
    // The synchronous pump may already have started the task; the routing
    // assertions below are the real contract.
    expect(["queued", "running"]).toContain(view.status);
    const terminal = await waitForTerminal(manager, view.taskId);
    expect(terminal.status).toBe("completed");
    const threadStart = fake.requests.find((request) => request.method === "thread/start");
    const turnStart = fake.requests.find((request) => request.method === "turn/start");
    expect(threadStart?.params).toMatchObject({ model: "gpt-6-astra" });
    expect(turnStart?.params).toMatchObject({ model: "gpt-6-astra", effort: "max" });
    const finalized = manager.get(view.taskId);
    expect(finalized.selection).toMatchObject({ model: "gpt-6-astra", effort: "max", binding_source: "explicit-task" });
    expect(finalized.requestedSelection).toEqual({ model: null, effort: null });
    expect(finalized.dispatchedSelection).toEqual({
      thread: { model: "gpt-6-astra" },
      turn: { model: "gpt-6-astra", effort: "max", outcome: "accepted" },
    });
    // Honest evidence: thread/start echoes the model but never the effort, so
    // observed effort must be null — the dispatched max is NOT copied there.
    expect(finalized.observedSelection).toMatchObject({ model: "gpt-6-astra", effort: null, source: "thread/start" });
  });

  it("keeps requested/dispatched/observed evidence distinct for an explicit task selection", async () => {
    const selection = {
      model: "gpt-6-astra", effort: "high",
      binding_source: "explicit-task" as const,
      catalog_revision: "test-revision", catalog_confirmed: true,
    };
    const view = manager.submit({
      workspace_id: workspace.id, provider: "codex", instruction: "Explicit model and effort selection evidence.",
      write_scope: ["tests"], network: false, run_tests: false, model: "gpt-6-astra", effort: "high",
    }, { ownerId: "owner", workspaceId: workspace.id, selection });
    await waitForTerminal(manager, view.taskId);
    const finalized = manager.get(view.taskId);
    expect(finalized.requestedSelection).toEqual({ model: "gpt-6-astra", effort: "high" });
    expect(finalized.dispatchedSelection).toEqual({
      thread: { model: "gpt-6-astra" },
      turn: { model: "gpt-6-astra", effort: "high", outcome: "accepted" },
    });
    // No session readback exists for the fake thread id; observed stays the
    // thread/start echo with a null effort rather than the dispatched high.
    expect(finalized.observedSelection).toMatchObject({ model: "gpt-6-astra", effort: null });
  });

  it("cancelling between thread/start and turn/start never claims turn effort was dispatched", async () => {
    let taskId = "";
    const requests: { method: string }[] = [];
    const gatedFake: AppServerClient = {
      async initialize(): Promise<void> {},
      async request<T>(method: string): Promise<T> {
        requests.push({ method });
        if (method === "thread/start") {
          // Cancel while thread/start is in flight; the response still arrives
          // and the post-thread cancellation check fires before turn/start.
          void manager.cancel(taskId).catch(() => undefined);
          return { thread: { id: "thread-gated" }, model: "gpt-6-astra" } as T;
        }
        return {} as T;
      },
      notify(): void {},
      setNotificationHandler(): void {},
      setRequestHandler(): void {},
      respond(): void {},
      respondError(): void {},
      async close(): Promise<void> {},
    };
    manager = new CodexTaskManager(workspace, { appServerFactory: () => gatedFake });
    const view = manager.submit({
      workspace_id: workspace.id, provider: "codex", instruction: "Cancelled before the turn was dispatched.",
      write_scope: ["tests"], network: false, run_tests: false,
    }, { ownerId: "owner", workspaceId: workspace.id, selection: {
      model: "gpt-6-astra", effort: "max",
      binding_source: "explicit-task" as const,
      catalog_revision: "test-revision", catalog_confirmed: true,
    } });
    taskId = view.taskId;
    const terminal = await waitForTerminal(manager, taskId);
    expect(terminal.status).toBe("cancelled");
    // thread/start may prove the model, but turn/start was never sent: no
    // turn effort (or turn model) may be claimed as dispatched.
    const cancelledView = manager.get(taskId);
    expect(cancelledView.dispatchedSelection?.turn ?? null).toBeNull();
    expect(cancelledView.observedSelection?.effort ?? null).toBeNull();
    expect(requests.filter((request) => request.method === "turn/start")).toHaveLength(0);
  });

  // ── native session readback evidence (turn_context) ──────────────────────
  //
  // observeNativeModel requires protocol-shaped thread/turn ids (36-char
  // uuids) and reads them from CODEX_HOME. These tests stub CODEX_HOME at a
  // fixture directory and write session files with the exact shape the reader
  // consumes — no real Codex process and no inference is involved.

  const UUID_THREAD = "0f0e0d0c-1111-4222-8333-444455556666";
  const UUID_TURN = "aabbccdd-1111-4222-8333-444455556666";

  class EvidenceFake implements AppServerClient {
    readonly requests: { method: string; params: unknown }[] = [];
    private notificationHandler: ((notification: AppServerNotification) => void | Promise<void>) | null = null;
    constructor(
      private readonly model: string,
      private readonly effort: string,
      private readonly evidence: { model: string; effort: string } | null,
      private readonly evidenceHome: string
    ) {}
    async initialize(): Promise<void> {}
    async request<T>(method: string, params?: unknown): Promise<T> {
      this.requests.push({ method, params });
      if (method === "thread/start") {
        const requestedModel = (params as { model?: string } | undefined)?.model;
        return { thread: { id: UUID_THREAD }, ...(requestedModel ? { model: requestedModel } : {}) } as T;
      }
      if (method === "turn/start") {
        // The upstream evidence file is written while the turn is running, so
        // the terminal readback observes it exactly like a real session would.
        if (this.evidence) {
          writeCodexTurnEvidence(this.evidenceHome, UUID_THREAD, UUID_TURN, this.evidence.model, this.evidence.effort);
        }
        queueMicrotask(() => {
          this.notificationHandler?.({
            method: "turn/completed",
            params: { threadId: UUID_THREAD, turnId: UUID_TURN, status: "completed" },
          });
        });
        return { turn: { id: UUID_TURN } } as T;
      }
      return {} as T;
    }
    notify(): void {}
    setNotificationHandler(handler: (notification: AppServerNotification) => void | Promise<void>): void {
      this.notificationHandler = handler;
    }
    setRequestHandler(): void {}
    respond(): void {}
    respondError(): void {}
    async close(): Promise<void> {}
  }

  function writeCodexTurnEvidence(home: string, threadId: string, turnId: string, model: string, effort: string): void {
    const day = new Date().toISOString().slice(0, 10).replaceAll("-", "/");
    const dir = path.join(home, "sessions", day);
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const lines = [
      JSON.stringify({ type: "session_meta", timestamp: now, payload: { id: threadId } }),
      JSON.stringify({ type: "turn_context", timestamp: now, payload: { turn_id: turnId, thread_id: threadId, model, effort } }),
    ];
    fs.writeFileSync(path.join(dir, `rollout-${threadId}.jsonl`), lines.join("\n") + "\n");
  }

  async function runEvidenceTask(
    evidence: { model: string; effort: string } | null
  ): Promise<ReturnType<CodexTaskManager["get"]>> {
    const home = fs.mkdtempSync(path.join(path.dirname(workspace.root), "codex-home-"));
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const fake = new EvidenceFake("gpt-6-astra", "max", evidence, home);
      manager = new CodexTaskManager(workspace, { appServerFactory: () => fake });
      const view = manager.submit({
        workspace_id: workspace.id, provider: "codex", instruction: "Readback evidence task.",
        write_scope: ["tests"], network: false, run_tests: false,
      }, { ownerId: "owner", workspaceId: workspace.id, selection: {
        model: "gpt-6-astra", effort: "max",
        binding_source: "explicit-task" as const,
        catalog_revision: "test-revision", catalog_confirmed: true,
      } });
      const terminal = await waitForTerminal(manager, view.taskId);
      expect(terminal.status).toBe("completed");
      return manager.get(view.taskId);
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  it("A: upstream effort contradicting the dispatched effort is flagged as a mismatch", async () => {
    // requested/dispatched max, upstream reported low.
    const finalized = await runEvidenceTask({ model: "gpt-6-astra", effort: "low" });
    expect(finalized.dispatchedSelection?.turn).toMatchObject({ model: "gpt-6-astra", effort: "max", outcome: "accepted" });
    expect(finalized.observedSelection).toMatchObject({ model: "gpt-6-astra", effort: "low", source: "native_turn_context", mismatch: true });
  });

  it("B: no upstream effort evidence keeps observed effort unknown without a mismatch flag", async () => {
    const finalized = await runEvidenceTask(null);
    expect(finalized.observedSelection).toMatchObject({ model: "gpt-6-astra", effort: null, source: "thread/start" });
    expect(finalized.observedSelection?.mismatch).toBeUndefined();
  });

  it("C: max and ultra are distinct efforts — an ultra readback against a dispatched max mismatches", async () => {
    const finalized = await runEvidenceTask({ model: "gpt-6-astra", effort: "ultra" });
    expect(finalized.observedSelection).toMatchObject({ effort: "ultra", mismatch: true });
  });

  it("E: a model mismatch is flagged once and the task reaches exactly one stable terminal state", async () => {
    const finalized = await runEvidenceTask({ model: "gpt-5.6-sol", effort: "max" });
    expect(finalized.status).toBe("completed");
    expect(finalized.observedSelection).toMatchObject({ model: "gpt-5.6-sol", effort: "max", mismatch: true });
    // The execution record was written exactly once for this task.
    const records = readExecutionRecords(workspace.id).filter((record) => record.taskId === finalized.taskId);
    expect(records).toHaveLength(1);
  });


  it("keeps safe MCP configuration restricted while preserving explicit full access", () => {
    const safeArgs = codexAppServerArgs({ workspaceRoot: workspace.root, logger: nullLogger, fullAccess: false, networkAccess: false });
    expect(safeArgs).toContain("mcp_servers={}");
    expect(safeArgs).toContain("mcp_servers.firecrawl.enabled=false");

    const offlineFullArgs = codexAppServerArgs({ workspaceRoot: workspace.root, logger: nullLogger, fullAccess: true, networkAccess: false });
    expect(offlineFullArgs).toContain("mcp_servers={}");
    expect(offlineFullArgs).toContain("mcp_servers.firecrawl.enabled=false");

    const fullArgs = codexAppServerArgs({ workspaceRoot: workspace.root, logger: nullLogger, fullAccess: true, networkAccess: true });
    expect(fullArgs).not.toContain("mcp_servers={}");
    expect(fullArgs).not.toContain("mcp_servers.firecrawl.enabled=false");
  });

  it("persists an interrupted active task and its session across manager restart", async () => {
    await manager.close();
    fake = new FakeAppServer(undefined, false);
    const sessions = new C2CSessionRegistry();
    manager = new CodexTaskManager(workspace, {
      appServerFactory: () => fake,
      sessionRegistry: sessions,
      fullAccess: true,
    });
    const submitted = manager.submit({
      workspace_id: workspace.id,
      instruction: "hold this task so restart recovery can be checked",
      write_scope: ["."],
      run_tests: false,
    });
    for (let i = 0; i < 100 && !manager.get(submitted.taskId).turnId; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await manager.close();

    const interrupted = manager.get(submitted.taskId);
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.error?.code).toBe("BRIDGE_RESTARTED");
    expect(sessions.getOwned(submitted.sessionId!, "local", workspace.id).currentState).toBe("interrupted");

    const restartedSessions = new C2CSessionRegistry();
    const restarted = new CodexTaskManager(workspace, {
      appServerFactory: () => new FakeAppServer(),
      sessionRegistry: restartedSessions,
      fullAccess: true,
    });
    expect(restarted.get(submitted.taskId).status).toBe("interrupted");
    expect(restartedSessions.getOwned(submitted.sessionId!, "local", workspace.id).lastTaskId).toBe(submitted.taskId);
    manager = restarted;
  });

  it("keeps Serena and verification runtime state out of the workspace across repeated tasks", async () => {
    const serena = path.join(root, ".serena");
    fs.rmSync(serena, { recursive: true, force: true });
    for (let i = 0; i < 10; i++) {
      const submitted = manager.submit({
        workspace_id: workspace.id,
        instruction: `repeat isolated task ${i}`,
        write_scope: ["tests"],
        network: false,
        run_tests: false,
      });
      await waitForTerminal(manager, submitted.taskId);
      // Terminal publication precedes final App Server/runtime cleanup; wait
      // for that bounded cleanup before submitting the next task.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fs.existsSync(serena)).toBe(false);
  });
});
