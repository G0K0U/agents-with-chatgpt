import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  AppServerClient,
  AppServerNotification,
  AppServerRequest,
  RpcId,
} from "../src/execution/app-server.js";
import { CodexTaskManager } from "../src/execution/tasks.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { workspaceQueueStateFile } from "../src/execution/queue-state.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

class QueueFakeAppServer implements AppServerClient {
  private notificationHandler: ((notification: AppServerNotification) => void | Promise<void>) | null = null;
  private requestHandler: ((request: AppServerRequest) => void | Promise<void>) | null = null;

  constructor(
    private readonly completes: boolean,
    private readonly startedInstructions: string[],
    private readonly label: string,
  ) {}

  async initialize(): Promise<void> {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (method === "thread/start") return { thread: { id: `thread-${this.label}` } } as T;
    if (method === "turn/start") {
      const input = (params as { input?: { text?: string }[] } | undefined)?.input?.[0]?.text;
      if (input) this.startedInstructions.push(input);
      if (this.completes) {
        queueMicrotask(() => {
          this.notificationHandler?.({
            method: "turn/completed",
            params: {
              threadId: `thread-${this.label}`,
              turnId: `turn-${this.label}`,
              status: "completed",
            },
          });
        });
      }
      return { turn: { id: `turn-${this.label}` } } as T;
    }
    if (method === "turn/interrupt") {
      queueMicrotask(() => {
        this.notificationHandler?.({
          method: "turn/completed",
          params: {
            threadId: `thread-${this.label}`,
            turnId: `turn-${this.label}`,
            status: "interrupted",
          },
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

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text: string }[];
  return content?.[0]?.text ?? "";
}

function jsonOf<T>(result: { content?: unknown }): T {
  return JSON.parse(textOf(result)) as T;
}

async function waitForTerminal(manager: CodexTaskManager, taskId: string): Promise<ReturnType<CodexTaskManager["get"]>> {
  for (let i = 0; i < 200; i++) {
    const task = manager.get(taskId);
    if (["completed", "failed", "cancelled", "interrupted", "timed_out"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Task ${taskId} did not finish`);
}

describe("persistent per-workspace queue pause", () => {
  const directories: string[] = [];
  const managers: CodexTaskManager[] = [];
  let bridge: Bridge | null = null;
  let client: Client | null = null;

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    client = null;
    await bridge?.close().catch(() => undefined);
    bridge = null;
    for (const manager of managers.splice(0)) await manager.close().catch(() => undefined);
    for (const directory of directories.splice(0)) cleanup(directory);
    delete process.env.C2C_STATE_DIR;
  });

  function makeWorkspace(label: string): Workspace {
    const root = makeTmpDir(label);
    directories.push(root);
    makeGitRepo(root);
    write(root, "src/fixture.ts", "export const fixture = true;\n");
    return new Workspace(root);
  }

  it("holds queued work, leaves the running task alone, preserves FIFO order, and resumes", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("queue-pause-fifo");
    const started: string[] = [];
    let serverNumber = 0;
    const manager = new CodexTaskManager(workspace, {
      appServerFactory: () => new QueueFakeAppServer(serverNumber++ > 0, started, `fifo-${serverNumber}`),
      maxQueueSize: 10,
    });
    managers.push(manager);

    const running = manager.submit({
      workspace_id: workspace.id,
      instruction: "hold the already running writer",
      write_scope: ["src"],
      run_tests: false,
    });
    for (let i = 0; i < 100 && manager.get(running.taskId).status !== "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(manager.get(running.taskId).status).toBe("running");

    expect(manager.setQueuePaused(true)).toMatchObject({
      workspaceId: workspace.id,
      paused: true,
      state: "paused",
      activeTask: { taskId: running.taskId, status: "running" },
    });

    const firstQueued = manager.submit({
      workspace_id: workspace.id,
      instruction: "first task after the freeze",
      write_scope: ["src"],
      run_tests: false,
    });
    const secondQueued = manager.submit({
      workspace_id: workspace.id,
      instruction: "second task after the freeze",
      write_scope: ["src"],
      run_tests: false,
    });
    expect(firstQueued).toMatchObject({ status: "queued", queuePosition: expect.any(Number) });
    expect(secondQueued.queuePosition).toBe(firstQueued.queuePosition! + 1);

    await manager.cancel(running.taskId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(manager.get(firstQueued.taskId).status).toBe("queued");
    expect(manager.get(secondQueued.taskId).status).toBe("queued");
    expect(manager.getQueueState()).toMatchObject({
      paused: true,
      queuedTaskCount: 2,
      nextQueuedTaskId: firstQueued.taskId,
      activeTask: null,
    });

    expect(manager.setQueuePaused(false)).toMatchObject({ paused: false, state: "running" });
    expect((await waitForTerminal(manager, firstQueued.taskId)).status).toBe("completed");
    expect((await waitForTerminal(manager, secondQueued.taskId)).status).toBe("completed");
    expect(started.findIndex((instruction) => instruction.includes("first task after the freeze")))
      .toBeLessThan(started.findIndex((instruction) => instruction.includes("second task after the freeze")));
  });

  it("persists the freeze across manager reconstruction while another workspace runs independently", async () => {
    isolateStateDir();
    const firstWorkspace = makeWorkspace("queue-pause-persisted");
    const secondWorkspace = makeWorkspace("queue-pause-isolated");

    const first = new CodexTaskManager(firstWorkspace, {
      appServerFactory: () => new QueueFakeAppServer(true, [], "persisted-before-restart"),
    });
    managers.push(first);
    expect(first.setQueuePaused(true).paused).toBe(true);
    const queued = first.submit({
      workspace_id: firstWorkspace.id,
      instruction: "wait for an explicit queue resume",
      write_scope: ["src"],
      run_tests: false,
    });
    expect(queued.status).toBe("queued");
    const persistedPosition = queued.queuePosition;
    expect(JSON.parse(fs.readFileSync(workspaceQueueStateFile(firstWorkspace.id), "utf8"))).toMatchObject({
      version: 1,
      workspaceId: firstWorkspace.id,
      paused: true,
    });

    await first.close();
    const restarted = new CodexTaskManager(firstWorkspace, {
      appServerFactory: () => new QueueFakeAppServer(true, [], "persisted-after-restart"),
    });
    managers.push(restarted);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(restarted.getQueueState()).toMatchObject({ paused: true, state: "paused", nextQueuedTaskId: queued.taskId });
    expect(restarted.get(queued.taskId)).toMatchObject({ status: "queued", queuePosition: persistedPosition });

    const independent = new CodexTaskManager(secondWorkspace, {
      appServerFactory: () => new QueueFakeAppServer(true, [], "isolated-workspace"),
    });
    managers.push(independent);
    const independentTask = independent.submit({
      workspace_id: secondWorkspace.id,
      instruction: "run while the first workspace is frozen",
      write_scope: ["src"],
      run_tests: false,
    });
    expect((await waitForTerminal(independent, independentTask.taskId)).status).toBe("completed");
    expect(independent.getQueueState()).toMatchObject({ paused: false, state: "running" });

    expect(restarted.setQueuePaused(false)).toMatchObject({ paused: false, state: "running" });
    expect((await waitForTerminal(restarted, queued.taskId)).status).toBe("completed");
  });

  it("exposes a required-workspace MCP control with scoped ACLs and restart-visible state", async () => {
    isolateStateDir();
    const workspaceRoot = makeWorkspace("queue-pause-mcp");
    const authFile = path.join(makeTmpDir("queue-pause-auth"), "store.json");
    const registryFile = path.join(makeTmpDir("queue-pause-registry"), "workspaces.json");
    const sessionFile = path.join(makeTmpDir("queue-pause-sessions"), "registry.json");
    directories.push(path.dirname(authFile), path.dirname(registryFile), path.dirname(sessionFile));

    bridge = await startBridge({
      workspaceRoot: workspaceRoot.root,
      port: 0,
      persistRuntime: false,
      authStoreFile: authFile,
      workspaceRegistryFile: registryFile,
      sessionRegistryFile: sessionFile,
    });
    const bridgeWorkspaceId = bridge.registry.listMetadata().find((entry) => entry.name === "c2c-bridge")!.id;
    const ownerToken = bridge.authStore.issueTokens({
      clientId: "queue-owner",
      workspaceIds: [workspaceRoot.id, bridgeWorkspaceId],
      scopes: ["execution.read", "execution.queue"],
    }).accessToken;
    const limitedToken = bridge.authStore.issueTokens({
      clientId: "queue-read-only",
      workspaceIds: [workspaceRoot.id],
      scopes: ["execution.read"],
    }).accessToken;
    const singleWorkspaceToken = bridge.authStore.issueTokens({
      clientId: "queue-single-workspace",
      workspaceId: workspaceRoot.id,
      scopes: ["execution.read", "execution.queue"],
    }).accessToken;

    client = new Client({ name: "queue-pause", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${ownerToken}` } },
    }));
    expect(jsonOf<{ paused: boolean }>(await client.callTool({
      name: "execution_queue",
      arguments: { workspace_id: workspaceRoot.id, action: "status" },
    })).paused).toBe(false);
    expect(jsonOf<{ paused: boolean; state: string }>(await client.callTool({
      name: "execution_queue",
      arguments: { workspace_id: workspaceRoot.id, action: "pause" },
    })).state).toBe("paused");
    const summary = jsonOf<{ queuePaused: boolean; queueStates: { workspaceId: string; paused: boolean }[] }>(
      await client.callTool({ name: "execution_summary", arguments: { workspace_id: workspaceRoot.id } })
    );
    expect(summary.queuePaused).toBe(true);
    expect(summary.queueStates).toEqual([expect.objectContaining({ workspaceId: workspaceRoot.id, paused: true })]);
    expect(jsonOf<{ paused: boolean }>(await client.callTool({
      name: "execution_queue",
      arguments: { workspace_id: bridgeWorkspaceId, action: "status" },
    })).paused).toBe(false);

    const missingWorkspace = await client.callTool({ name: "execution_queue", arguments: { action: "status" } });
    expect(missingWorkspace.isError).toBe(true);
    expect(textOf(missingWorkspace)).toContain("workspace_id");

    await client.close();
    client = null;
    await bridge.close();
    bridge = null;

    bridge = await startBridge({
      workspaceRoot: workspaceRoot.root,
      port: 0,
      persistRuntime: false,
      authStoreFile: authFile,
      workspaceRegistryFile: registryFile,
      sessionRegistryFile: sessionFile,
    });
    client = new Client({ name: "queue-pause-restarted", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${ownerToken}` } },
    }));
    expect(jsonOf<{ paused: boolean; state: string }>(await client.callTool({
      name: "execution_queue",
      arguments: { workspace_id: workspaceRoot.id, action: "status" },
    })).state).toBe("paused");

    const limitedClient = new Client({ name: "queue-read-only", version: "1.0.0" });
    await limitedClient.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${limitedToken}` } },
    }));
    const missingQueueScope = await limitedClient.callTool({
      name: "execution_queue",
      arguments: { workspace_id: workspaceRoot.id, action: "pause" },
    });
    expect(missingQueueScope.isError).toBe(true);
    expect(textOf(missingQueueScope)).toContain("INSUFFICIENT_SCOPE");
    await limitedClient.close();

    const singleWorkspaceClient = new Client({ name: "queue-single-workspace", version: "1.0.0" });
    await singleWorkspaceClient.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${singleWorkspaceToken}` } },
    }));
    const unauthorizedWorkspace = await singleWorkspaceClient.callTool({
      name: "execution_queue",
      arguments: { workspace_id: bridgeWorkspaceId, action: "status" },
    });
    expect(unauthorizedWorkspace.isError).toBe(true);
    expect(textOf(unauthorizedWorkspace)).toContain("WORKSPACE_NOT_AUTHORIZED");
    const unauthorizedPause = await singleWorkspaceClient.callTool({
      name: "execution_queue",
      arguments: { workspace_id: bridgeWorkspaceId, action: "pause" },
    });
    expect(unauthorizedPause.isError).toBe(true);
    expect(textOf(unauthorizedPause)).toContain("WORKSPACE_NOT_AUTHORIZED");
    await singleWorkspaceClient.close();

    expect(jsonOf<{ paused: boolean }>(await client.callTool({
      name: "execution_queue",
      arguments: { workspace_id: workspaceRoot.id, action: "resume" },
    })).paused).toBe(false);
  });
});
