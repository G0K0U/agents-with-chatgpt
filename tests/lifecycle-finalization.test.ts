import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  AppServerClient,
  AppServerNotification,
  AppServerRequest,
  RpcId,
} from "../src/execution/app-server.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { appendExecutionRecord, readExecutionRecords } from "../src/execution/records.js";
import { C2CSessionRegistry } from "../src/session/registry.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

interface TaskIdentity {
  taskId: string;
  sessionId: string;
  ownerId: string;
}

/** App Server fixture that emits lower-level interrupted evidence before the final turn result. */
class LifecycleFinalizationFake implements AppServerClient {
  private notificationHandler: ((notification: AppServerNotification) => void | Promise<void>) | null = null;
  private requestHandler: ((request: AppServerRequest) => void | Promise<void>) | null = null;
  private readonly identity: Promise<TaskIdentity>;
  private resolveIdentity!: (identity: TaskIdentity) => void;
  private evidenceWritten = false;
  onIntermediateEvidence?: (identity: TaskIdentity) => void;

  constructor(private readonly workspaceId: string) {
    this.identity = new Promise((resolve) => {
      this.resolveIdentity = resolve;
    });
  }

  setTaskIdentity(identity: TaskIdentity): void {
    this.resolveIdentity(identity);
  }

  async initialize(): Promise<void> {}

  async request<T>(method: string): Promise<T> {
    if (method === "thread/start") return { thread: { id: "thread-lifecycle-finalization" } } as T;
    if (method === "turn/start") {
      const identity = await this.identity;
      if (!this.evidenceWritten) {
        this.evidenceWritten = true;
        appendExecutionRecord(this.workspaceId, {
          taskId: identity.taskId,
          workspaceId: this.workspaceId,
          ownerId: identity.ownerId,
          sessionId: identity.sessionId,
          taskStatus: "interrupted",
          iteration: 1,
          changedFiles: [],
          tests: null,
          exitStatus: "blocked",
          timestamp: "2026-09-03T00:00:00.100Z",
          network: false,
        });
        this.onIntermediateEvidence?.(identity);
      }
      queueMicrotask(() => {
        this.notificationHandler?.({
          method: "turn/completed",
          params: {
            threadId: "thread-lifecycle-finalization",
            turnId: "turn-lifecycle-finalization",
            status: "completed",
          },
        });
      });
      return { turn: { id: "turn-lifecycle-finalization" } } as T;
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

async function waitForTerminal(client: Client, workspaceId: string, taskId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i++) {
    const task = jsonOf<Record<string, unknown>>(await client.callTool({
      name: "get_codex_task",
      arguments: { workspace_id: workspaceId, task_id: taskId },
    }));
    if (["completed", "failed", "cancelled", "interrupted", "timed_out"].includes(String(task.status))) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Task ${taskId} did not finish`);
}

describe("C2C live task finalization truth", () => {
  let stateRoot: string;
  let root: string;
  let bridge: Bridge;
  let client: Client;
  let fake: LifecycleFinalizationFake;

  beforeAll(async () => {
    stateRoot = isolateStateDir();
    root = makeTmpDir("lifecycle-finalization-workspace");
    makeGitRepo(root);
    write(root, "package.json", JSON.stringify({ name: "lifecycle-finalization" }));
    fake = new LifecycleFinalizationFake(new Workspace(root).id);
    bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      authStoreFile: `${makeTmpDir("lifecycle-finalization-auth")}\\store.json`,
      fullAccess: false,
      appServerFactory: () => fake,
    });
    const token = bridge.authStore.issueTokens({
      clientId: "lifecycle-owner",
      scopes: ["workspace.read", "execution.read", "execution.submit", "execution.cancel"],
    }).accessToken;
    client = new Client({ name: "lifecycle-finalization-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));
  });

  afterAll(async () => {
    await client?.close();
    await bridge?.close();
    cleanup(root);
    cleanup(stateRoot);
    delete process.env.C2C_STATE_DIR;
  });

  it("keeps interrupted evidence historical while finalizing task, session, and summary as completed", async () => {
    fake.onIntermediateEvidence = (identity) => {
      bridge.sessions.updateFromTask({
        sessionId: identity.sessionId,
        ownerId: identity.ownerId,
        workspaceId: bridge.workspace.id,
        taskId: identity.taskId,
        status: "interrupted",
        changedFiles: [],
        tests: null,
        verificationStatus: null,
      });
    };
    const submitted = jsonOf<{ taskId: string; sessionId: string; workspaceId: string }>(await client.callTool({
      name: "submit_codex_task",
      arguments: {
        workspace_id: bridge.workspace.id,
        instruction: "complete the lifecycle finalization regression",
        write_scope: ["src"],
        run_tests: false,
      },
    }));
    fake.setTaskIdentity({
      taskId: submitted.taskId,
      sessionId: submitted.sessionId,
      ownerId: "lifecycle-owner",
    });

    const terminal = await waitForTerminal(client, submitted.workspaceId, submitted.taskId);
    expect(terminal).toMatchObject({ status: "completed", exitStatus: "ok" });

    // Model a late lower-level session update arriving after the task registry
    // has already published its authoritative completed result.
    bridge.sessions.updateFromTask({
      sessionId: submitted.sessionId,
      ownerId: "lifecycle-owner",
      workspaceId: submitted.workspaceId,
      taskId: submitted.taskId,
      status: "interrupted",
      changedFiles: [],
      tests: null,
      verificationStatus: null,
    });

    expect(bridge.sessions.getOwned(submitted.sessionId, "lifecycle-owner", submitted.workspaceId)).toMatchObject({
      lastTaskId: submitted.taskId,
      currentState: "completed",
    });

    const summary = jsonOf<{
      sessions: { id: string; currentState: string }[];
      records: { taskId: string; taskStatus: string | null; exitStatus: string }[];
    }>(await client.callTool({
      name: "execution_summary",
      arguments: { workspace_id: submitted.workspaceId, session_id: submitted.sessionId },
    }));
    expect(summary.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: submitted.sessionId, currentState: "completed" }),
    ]));

    const evidence = readExecutionRecords(submitted.workspaceId, 100).filter((record) => record.taskId === submitted.taskId);
    expect(evidence.map((record) => [record.taskStatus, record.exitStatus])).toEqual([
      ["interrupted", "blocked"],
      ["completed", "ok"],
    ]);
    expect(summary.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: submitted.taskId, taskStatus: "interrupted", exitStatus: "blocked" }),
      expect.objectContaining({ taskId: submitted.taskId, taskStatus: "completed", exitStatus: "ok" }),
    ]));

    const persistedSession = new C2CSessionRegistry({ file: bridge.sessions.file }).getOwned(
      submitted.sessionId,
      "lifecycle-owner",
      submitted.workspaceId
    );
    expect(persistedSession.currentState).toBe("completed");
  });
});
