import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { TaskLifecycleEvent } from "../src/execution/audit-maintenance.js";
import {
  CodexTaskManager,
  type SubmitCodexTaskInput,
} from "../src/execution/tasks.js";
import type {
  AppServerClient,
  AppServerNotification,
  AppServerRequest,
  RpcId,
} from "../src/execution/app-server.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

class MockAppServerClient implements AppServerClient {
  private notificationHandler: ((notification: AppServerNotification) => void | Promise<void>) | null = null;
  readonly requests: { method: string; params: unknown }[] = [];
  interrupted = false;
  closed = false;

  constructor(
    private readonly shouldFail = false,
    private readonly manualComplete = false
  ) {}

  async initialize(): Promise<void> {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      return { thread: { id: "thread-mock-1" } } as T;
    }
    if (method === "turn/start") {
      if (!this.manualComplete) {
        queueMicrotask(() => {
          if (this.shouldFail) {
            this.sendNotification({
              method: "error",
              params: {
                threadId: "thread-mock-1",
                turnId: "turn-mock-1",
                message: "Simulated worker execution failure",
              },
            });
          } else {
            this.sendNotification({
              method: "turn/completed",
              params: {
                threadId: "thread-mock-1",
                turnId: "turn-mock-1",
                status: "completed",
              },
            });
          }
        });
      }
      return { turn: { id: "turn-mock-1" } } as T;
    }
    if (method === "turn/interrupt") {
      this.interrupted = true;
      queueMicrotask(() => {
        this.sendNotification({
          method: "turn/completed",
          params: {
            threadId: "thread-mock-1",
            turnId: "turn-mock-1",
            status: "interrupted",
          },
        });
      });
      return {} as T;
    }
    return {} as T;
  }

  notify(_method: string, _params?: unknown): void {}

  setNotificationHandler(handler: (notification: AppServerNotification) => void | Promise<void>): void {
    this.notificationHandler = handler;
  }

  setRequestHandler(_handler: (request: AppServerRequest) => void | Promise<void>): void {
    // Handled in full-access / approval flows if tested
  }

  respond(_id: RpcId, _result: unknown): void {}

  respondError(_id: RpcId, _code: number, _message: string): void {}

  sendNotification(notification: AppServerNotification): void {
    void this.notificationHandler?.(notification);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

async function waitForTerminal(
  manager: CodexTaskManager,
  taskId: string
): Promise<ReturnType<CodexTaskManager["get"]>> {
  for (let i = 0; i < 200; i++) {
    const task = manager.get(taskId);
    if (["completed", "failed", "cancelled", "interrupted", "timed_out"].includes(task.status)) {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Task ${taskId} did not finish within timeout`);
}

describe("CodexTaskManager lifecycle callback plumbing", () => {
  const temporaryDirectories: string[] = [];
  let stateDir: string;

  beforeEach(() => {
    stateDir = isolateStateDir();
  });

  afterEach(() => {
    for (const dir of temporaryDirectories.splice(0)) {
      cleanup(dir);
    }
  });

  function createTestWorkspace(name: string): Workspace {
    const dir = makeTmpDir(name);
    temporaryDirectories.push(dir);
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "index.ts"), "export const x = 1;\n");
    return new Workspace(dir);
  }

  it("emits submit -> start -> completed in deterministic order with durable record snapshots", async () => {
    const workspace = createTestWorkspace("ws-lifecycle-happy");
    const events: TaskLifecycleEvent[] = [];

    const manager = new CodexTaskManager(workspace, {
      stateDir,
      appServerFactory: () => new MockAppServerClient(false),
      onTaskLifecycleEvent: (event) => events.push(event),
    });

    const input: SubmitCodexTaskInput = {
      workspace_id: workspace.id,
      instruction: "Add feature A",
      write_scope: ["src"],
      network: false,
      run_tests: false,
    };

    const view = manager.submit(input);
    expect(view.taskId).toBeDefined();
    expect(["queued", "running"]).toContain(view.status);

    await waitForTerminal(manager, view.taskId);

    expect(events.length).toBe(3);

    // 1. Submit event
    const submitEv = events[0];
    expect(submitEv.type).toBe("submit");
    expect(submitEv.workspaceId).toBe(workspace.id);
    expect(submitEv.taskId).toBe(view.taskId);
    expect(submitEv.record?.status).toBe("queued");
    expect(submitEv.timestamp).toBe(submitEv.record?.submittedAt);

    // 2. Start event
    const startEv = events[1];
    expect(startEv.type).toBe("start");
    expect(startEv.workspaceId).toBe(workspace.id);
    expect(startEv.taskId).toBe(view.taskId);
    expect(startEv.record?.status).toBe("running");
    expect(startEv.timestamp).toBe(startEv.record?.startedAt);

    // 3. Completed event
    const completedEv = events[2];
    expect(completedEv.type).toBe("completed");
    expect(completedEv.workspaceId).toBe(workspace.id);
    expect(completedEv.taskId).toBe(view.taskId);
    expect(completedEv.record?.status).toBe("completed");
    expect(completedEv.record?.exitStatus).toBe("ok");
    expect(completedEv.timestamp).toBe(completedEv.record?.completedAt);
    expect(Array.isArray(completedEv.record?.changedFiles)).toBe(true);
    expect(typeof completedEv.record?.restartRequired).toBe("boolean");

    await manager.close();
  });

  it("emits queue_paused and queue_resumed only after queue pause state is durably written", async () => {
    const workspace = createTestWorkspace("ws-lifecycle-queue");
    const events: TaskLifecycleEvent[] = [];

    const manager = new CodexTaskManager(workspace, {
      stateDir,
      onTaskLifecycleEvent: (event) => events.push(event),
    });

    // 1. Pause queue
    const pauseState = manager.setQueuePaused(true);
    expect(pauseState.paused).toBe(true);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("queue_paused");
    expect(events[0].paused).toBe(true);
    expect(events[0].workspaceId).toBe(workspace.id);
    expect(events[0].taskId).toBeUndefined();
    expect(events[0].timestamp).toBe(pauseState.updatedAt);

    // 2. Resume queue
    const resumeState = manager.setQueuePaused(false);
    expect(resumeState.paused).toBe(false);
    expect(events.length).toBe(2);
    expect(events[1].type).toBe("queue_resumed");
    expect(events[1].paused).toBe(false);
    expect(events[1].workspaceId).toBe(workspace.id);
    expect(events[1].taskId).toBeUndefined();
    expect(events[1].timestamp).toBe(resumeState.updatedAt);

    await manager.close();
  });

  it("does not emit cancelling as cancelled; emits cancelled only when terminal", async () => {
    const workspace = createTestWorkspace("ws-lifecycle-cancel");
    const events: TaskLifecycleEvent[] = [];

    const manager = new CodexTaskManager(workspace, {
      stateDir,
      appServerFactory: () => new MockAppServerClient(false, true), // manual completion
      onTaskLifecycleEvent: (event) => events.push(event),
    });

    const input: SubmitCodexTaskInput = {
      workspace_id: workspace.id,
      instruction: "Long running task",
      write_scope: ["src"],
      network: false,
      run_tests: false,
    };

    const view = manager.submit(input);

    // Wait until start is emitted
    for (let i = 0; i < 200; i++) {
      if (events.some((e) => e.type === "start")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(events.map((e) => e.type)).toEqual(["submit", "start"]);

    // Cancel task while running
    const cancelPromise = manager.cancel(view.taskId);

    // Verify "cancelling" is never emitted as an event type
    const midTypes = events.map((e) => e.type);
    expect(midTypes).not.toContain("cancelling");
    expect(midTypes).not.toContain("cancelled");

    // Complete cancellation
    await cancelPromise;
    await waitForTerminal(manager, view.taskId);

    const finalTypes = events.map((e) => e.type);
    expect(finalTypes).toEqual(["submit", "start", "cancelled"]);

    const cancelledEv = events.find((e) => e.type === "cancelled");
    expect(cancelledEv?.record?.status).toBe("cancelled");
    expect(cancelledEv?.record?.completedAt).toBeDefined();

    await manager.close();
  });

  it("emits failed terminal event when a task fails", async () => {
    const workspace = createTestWorkspace("ws-lifecycle-fail");
    const events: TaskLifecycleEvent[] = [];

    const manager = new CodexTaskManager(workspace, {
      stateDir,
      appServerFactory: () => new MockAppServerClient(true), // will send error notification
      onTaskLifecycleEvent: (event) => events.push(event),
    });

    const input: SubmitCodexTaskInput = {
      workspace_id: workspace.id,
      instruction: "Failing task",
      write_scope: ["src"],
      network: false,
      run_tests: false,
    };

    const view = manager.submit(input);

    await waitForTerminal(manager, view.taskId);

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toEqual(["submit", "start", "failed"]);

    const failedEv = events.find((e) => e.type === "failed");
    expect(failedEv?.record?.status).toBe("failed");
    expect(failedEv?.record?.error).toBeDefined();

    await manager.close();
  });

  it("emits recovered terminal event on startup recovery and does not duplicate on subsequent reloads", async () => {
    const workspace = createTestWorkspace("ws-lifecycle-recovery");
    const taskId = "c2c_1234567890abcdef";
    const now = new Date().toISOString();
    const taskDir = path.join(stateDir, "tasks", workspace.id);
    fs.mkdirSync(taskDir, { recursive: true });

    // Simulate an abandoned running task left on disk after an ungraceful crash
    const abandonedRecord = {
      taskId,
      workspaceId: workspace.id,
      instruction: "Abandoned task from crash",
      instructionHash: "hash123",
      writeScope: ["src"],
      fullAccess: false,
      networkRequested: false,
      networkEffective: false,
      networkReported: null,
      network: false,
      runTests: false,
      approvalMode: "workspace_write",
      provider: "codex",
      status: "running",
      submittedAt: now,
      startedAt: now,
      changedFiles: [],
      tests: null,
      outputIds: [],
      approvalEvents: [],
      executionRecorded: false,
    };
    fs.writeFileSync(path.join(taskDir, `${taskId}.json`), JSON.stringify(abandonedRecord));

    // 1. Manager starts up, performs recovery, and emits interrupted terminal event
    const eventsManager1: TaskLifecycleEvent[] = [];
    const manager1 = new CodexTaskManager(workspace, {
      stateDir,
      onTaskLifecycleEvent: (event) => eventsManager1.push(event),
    });

    expect(eventsManager1.length).toBe(1);
    expect(eventsManager1[0].type).toBe("interrupted");
    expect(eventsManager1[0].taskId).toBe(taskId);
    expect(eventsManager1[0].record?.status).toBe("interrupted");
    expect(eventsManager1[0].timestamp).toBe(eventsManager1[0].record?.completedAt);

    await manager1.close();

    // 2. Second manager starts up; task is already terminal; no duplicate emitted
    const eventsManager2: TaskLifecycleEvent[] = [];
    const manager2 = new CodexTaskManager(workspace, {
      stateDir,
      onTaskLifecycleEvent: (event) => eventsManager2.push(event),
    });

    expect(eventsManager2.length).toBe(0);

    await manager2.close();
  });
});
