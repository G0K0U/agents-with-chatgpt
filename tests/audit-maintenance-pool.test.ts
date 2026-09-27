import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import type { TaskLifecycleEvent } from "../src/execution/audit-maintenance.js";
import { CodexTaskManagerPool } from "../src/execution/pool.js";
import type { CodexTaskManager, SubmitCodexTaskInput } from "../src/execution/tasks.js";
import type {
  AppServerClient,
  AppServerNotification,
  AppServerRequest,
  RpcId,
} from "../src/execution/app-server.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import { C2CSessionRegistry } from "../src/session/registry.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

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

  setRequestHandler(_handler: (request: AppServerRequest) => void | Promise<void>): void {}

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

describe("CodexTaskManagerPool onTaskLifecycleEvent propagation", () => {
  const temporaryDirectories: string[] = [];
  let stateDir: string;

  beforeEach(() => {
    stateDir = isolateStateDir();
  });

  afterEach(() => {
    for (const dir of temporaryDirectories.splice(0)) {
      cleanup(dir);
    }
    delete process.env.C2C_STATE_DIR;
  });

  it("propagates lifecycle events through pool-managed task managers", async () => {
    const wsDir = makeTmpDir("ws-audit-pool");
    temporaryDirectories.push(wsDir);
    write(wsDir, "src/index.ts", "export const x = 1;\n");

    const registry = new WorkspaceRegistry({ file: path.join(stateDir, "workspaces.json") });
    const registered = registry.registerTrusted({ name: "pool-ws", canonicalPath: wsDir });
    const sessionRegistry = new C2CSessionRegistry({ file: path.join(stateDir, "sessions.json") });

    const events: TaskLifecycleEvent[] = [];
    const pool = new CodexTaskManagerPool(registry, sessionRegistry, {
      stateDir,
      appServerFactory: () => new MockAppServerClient(false),
      onTaskLifecycleEvent: (event) => events.push(event),
    });

    const manager = pool.get(registered.id);

    const input: SubmitCodexTaskInput = {
      workspace_id: registered.id,
      instruction: "Verify pool lifecycle propagation",
      write_scope: ["src"],
      run_tests: false,
    };

    const view = manager.submit(input);
    expect(view.taskId).toBeDefined();

    await waitForTerminal(manager, view.taskId);

    // Assert submit/start/completed
    expect(events.map((e) => e.type)).toEqual(["submit", "start", "completed"]);
    expect(events[0].workspaceId).toBe(registered.id);
    expect(events[0].taskId).toBe(view.taskId);
    expect(events[1].workspaceId).toBe(registered.id);
    expect(events[1].taskId).toBe(view.taskId);
    expect(events[2].workspaceId).toBe(registered.id);
    expect(events[2].taskId).toBe(view.taskId);

    // Call setQueuePaused true/false and assert queue_paused/queue_resumed also reach collector
    manager.setQueuePaused(true);
    expect(events.map((e) => e.type)).toEqual(["submit", "start", "completed", "queue_paused"]);
    expect(events[3].workspaceId).toBe(registered.id);
    expect(events[3].paused).toBe(true);

    manager.setQueuePaused(false);
    expect(events.map((e) => e.type)).toEqual([
      "submit",
      "start",
      "completed",
      "queue_paused",
      "queue_resumed",
    ]);
    expect(events[4].workspaceId).toBe(registered.id);
    expect(events[4].paused).toBe(false);

    // Close pool
    await pool.close();
  });
});
