import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  AppServerClient,
  AppServerFactoryOptions,
  AppServerNotification,
  AppServerRequest,
  RpcId,
} from "../src/execution/app-server.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { getStateDir } from "../src/config/paths.js";
import { cleanup, makeGitRepo, makeTmpDir, write } from "./helpers.js";

class FullAccessFakeAppServer implements AppServerClient {
  private notificationHandler: ((notification: AppServerNotification) => void | Promise<void>) | null = null;
  private requestHandler: ((request: AppServerRequest) => void | Promise<void>) | null = null;
  private responses = new Map<RpcId, unknown>();

  async initialize(): Promise<void> {}

  async request<T>(method: string): Promise<T> {
    if (method === "thread/start") return { thread: { id: "thread-full-access" } } as T;
    if (method === "turn/start") {
      queueMicrotask(() => {
        this.notificationHandler?.({
          method: "item/completed",
          params: {
            threadId: "thread-full-access",
            turnId: "turn-full-access",
            item: { type: "commandExecution", id: "command-1", command: "echo full access", exitCode: 0 },
          },
        });
        this.notificationHandler?.({
          method: "turn/completed",
          params: { threadId: "thread-full-access", turnId: "turn-full-access", status: "completed" },
        });
      });
      return { turn: { id: "turn-full-access" } } as T;
    }
    if (method === "turn/interrupt") return {} as T;
    return {} as T;
  }

  notify(): void {}

  setNotificationHandler(handler: (notification: AppServerNotification) => void | Promise<void>): void {
    this.notificationHandler = handler;
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
    const result = await client.callTool({
      name: "get_codex_task",
      arguments: { workspace_id: workspaceId, task_id: taskId },
    });
    const task = jsonOf<Record<string, unknown>>(result);
    if (["completed", "failed", "cancelled", "interrupted", "timed_out"].includes(String(task.status))) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Task ${taskId} did not finish`);
}

describe("full-access bridge MCP lifecycle", () => {
  let root: string;
  let bridge: Bridge;
  let client: Client;
  let token: string;
  let bridgeWorkspaceId: string;
  let authFile: string;
  let externalTmpRoot: string;

  async function connect(accessToken: string): Promise<Client> {
    const next = new Client({ name: "full-access-e2e", version: "1.0.0" });
    await next.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }));
    return next;
  }

  beforeAll(async () => {
    externalTmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "c2c-full-access-")));
    delete process.env.C2C_TEST_TMP_ROOT;
    process.env.C2C_STATE_DIR = externalTmpRoot;
    root = makeTmpDir("full-access-ws");
    makeGitRepo(root);
    write(root, "package.json", JSON.stringify({ name: "full-access-e2e", scripts: { test: "node --version" } }));
    authFile = path.join(makeTmpDir("full-access-auth"), "store.json");
    const factory = (_options: AppServerFactoryOptions): AppServerClient => new FullAccessFakeAppServer();
    bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false, authStoreFile: authFile, fullAccess: true, appServerFactory: factory });
    bridgeWorkspaceId = bridge.registry.listMetadata().find((entry) => entry.name === "c2c-bridge")!.id;
    token = bridge.authStore.issueTokens({
      clientId: "full-access-owner",
      scopes: ["workspace.read", "execution.read", "execution.submit", "execution.cancel"],
    }).accessToken;
    client = await connect(token);
  });

  afterAll(async () => {
    await client?.close();
    await bridge?.close();
    cleanup(root);
    cleanup(externalTmpRoot);
    delete process.env.C2C_STATE_DIR;
  });

  it("describes network as an explicit per-task opt-in in the authorized deployment", async () => {
    const { tools } = await client.listTools();
    const submitTool = tools.find((tool) => tool.name === "submit_codex_task");
    const submitSchema = submitTool?.inputSchema as {
      properties?: { network?: { default?: unknown; description?: string } };
    } | undefined;
    expect(submitTool?.description).toContain("network access is opt-in per task");
    expect(submitSchema?.properties?.network?.default).toBe(false);
    expect(submitSchema?.properties?.network?.description).toContain("Opt in");
  });

  it("routes a full-access task, links it to a session, and hides raw thread ids", async () => {
    const submitted = jsonOf<{ taskId: string; sessionId: string; workspaceId: string; network: boolean }>(await client.callTool({
      name: "submit_codex_task",
      arguments: {
        workspace_id: bridgeWorkspaceId,
        instruction: "perform a full-access lifecycle smoke task",
        write_scope: ["."],
        run_tests: false,
      },
    }));
    expect(submitted.workspaceId).toBe(bridgeWorkspaceId);
    expect(submitted.sessionId).toMatch(/^c2cs_/);
    expect(submitted.network).toBe(false);

    const task = await waitForTerminal(client, bridgeWorkspaceId, submitted.taskId);
    expect(task.status).toBe("completed");
    expect(task).not.toHaveProperty("threadId");
    expect(task).not.toHaveProperty("turnId");

    const summary = jsonOf<{
      latestActiveSession: { id: string; workspaceId: string; lastTaskId?: string } | null;
      sessions: { id: string }[];
      records: { taskId: string; network: boolean }[];
    }>(await client.callTool({ name: "execution_summary", arguments: {} }));
    expect(summary.latestActiveSession?.id).toBe(submitted.sessionId);
    expect(summary.latestActiveSession?.workspaceId).toBe(bridgeWorkspaceId);
    expect(summary.latestActiveSession?.lastTaskId).toBe(submitted.taskId);
    expect(summary.sessions.some((session) => session.id === submitted.sessionId)).toBe(true);
    expect(summary.records.find((record) => record.taskId === submitted.taskId)?.network).toBe(false);
  });

  it("updates the same session on continuation and enforces owner checks", async () => {
    const firstSummary = jsonOf<{ latestActiveSession: { id: string; lastTaskId?: string } }>(await client.callTool({
      name: "execution_summary",
      arguments: { workspace_id: bridgeWorkspaceId },
    }));
    const sessionId = firstSummary.latestActiveSession!.id;
    const previousTaskId = firstSummary.latestActiveSession!.lastTaskId;
    const next = jsonOf<{ taskId: string; sessionId: string; network: boolean }>(await client.callTool({
      name: "submit_codex_task",
      arguments: {
        workspace_id: bridgeWorkspaceId,
        session_id: sessionId,
        instruction: "continue the same full-access smoke task",
        write_scope: ["."],
        network: false,
        run_tests: false,
      },
    }));
    expect(next.sessionId).toBe(sessionId);
    expect(next.network).toBe(false);
    expect(next.taskId).not.toBe(previousTaskId);
    const completed = await waitForTerminal(client, bridgeWorkspaceId, next.taskId);
    expect(completed.network).toBe(false);

    const networkUpgrade = await client.callTool({
      name: "submit_codex_task",
      arguments: {
        workspace_id: bridgeWorkspaceId,
        session_id: sessionId,
        instruction: "try to upgrade the continued task",
        write_scope: ["."],
        network: true,
        run_tests: false,
      },
    });
    expect(networkUpgrade.isError ?? false).toBe(false);
    const upgradedTask = jsonOf<{ taskId: string; network: boolean }>(networkUpgrade);
    expect(upgradedTask.network).toBe(true);
    expect((await waitForTerminal(client, bridgeWorkspaceId, upgradedTask.taskId)).network).toBe(true);
    expect(JSON.parse(fs.readFileSync(
      path.join(getStateDir(), "tasks", bridgeWorkspaceId, `${upgradedTask.taskId}.json`),
      "utf8"
    ))).toMatchObject({ network: true });
    const upgradedSummary = jsonOf<{ records: { taskId: string; network: boolean }[] }>(await client.callTool({
      name: "execution_summary",
      arguments: { workspace_id: bridgeWorkspaceId },
    }));
    expect(upgradedSummary.records.find((record) => record.taskId === upgradedTask.taskId)?.network).toBe(true);

    const otherToken = bridge.authStore.issueTokens({
      clientId: "full-access-other-owner",
      scopes: ["execution.read"],
    }).accessToken;
    const other = await connect(otherToken);
    const denied = await other.callTool({
      name: "get_codex_task",
      arguments: { workspace_id: bridgeWorkspaceId, task_id: next.taskId },
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("TASK_NOT_AUTHORIZED");
    await other.close();
  });

  it("does not upgrade network policy when switching authorized workspaces", async () => {
    const otherWorkspaceId = bridge.registry.listMetadata().find((entry) => entry.id !== bridgeWorkspaceId)!.id;
    const submitted = jsonOf<{ taskId: string; workspaceId: string; network: boolean }>(await client.callTool({
      name: "submit_codex_task",
      arguments: {
        workspace_id: otherWorkspaceId,
        instruction: "run an ordinary task in the other authorized workspace",
        write_scope: ["."],
        run_tests: false,
      },
    }));
    expect(submitted.workspaceId).toBe(otherWorkspaceId);
    expect(submitted.network).toBe(false);
    const completed = await waitForTerminal(client, otherWorkspaceId, submitted.taskId);
    expect(completed.network).toBe(false);

    const summary = jsonOf<{ records: { workspaceId: string; network: boolean }[] }>(await client.callTool({
      name: "execution_summary",
      arguments: { workspace_id: otherWorkspaceId },
    }));
    expect(summary.records.some((record) => record.workspaceId === otherWorkspaceId && record.network === false)).toBe(true);
  });

  it("does not infer a developer-research profile from ordinary submit", async () => {
    const result = await client.callTool({
      name: "submit_codex_task",
      arguments: {
        workspace_id: bridgeWorkspaceId,
        instruction: "ordinary task with an unsupported research profile",
        write_scope: ["."],
        developer_research: true,
        run_tests: false,
      } as Record<string, unknown>,
    });
    expect(result.isError).toBe(true);
  });

  it("keeps session state after bridge restart for a new client context", async () => {
    const seeded = jsonOf<{ taskId: string; sessionId: string }>(await client.callTool({
      name: "submit_codex_task",
      arguments: {
        workspace_id: bridgeWorkspaceId,
        instruction: "create the explicit session used by the restart regression",
        write_scope: ["."],
        run_tests: false,
      },
    }));
    await waitForTerminal(client, bridgeWorkspaceId, seeded.taskId);
    const before = jsonOf<{ latestActiveSession: { id: string; workspaceId: string } | null }>(await client.callTool({
      name: "execution_summary",
      arguments: { workspace_id: bridgeWorkspaceId, session_id: seeded.sessionId },
    }));
    const sessionId = seeded.sessionId;
    expect(before.latestActiveSession?.id).toBe(sessionId);
    await client.close();
    await bridge.close();

    const factory = (_options: AppServerFactoryOptions): AppServerClient => new FullAccessFakeAppServer();
    bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false, authStoreFile: authFile, fullAccess: true, appServerFactory: factory });
    client = await connect(token);

    const after = jsonOf<{ latestActiveSession: { id: string; workspaceId: string } | null }>(await client.callTool({
      name: "execution_summary",
      arguments: { workspace_id: bridgeWorkspaceId, session_id: sessionId },
    }));
    expect(after.latestActiveSession?.id).toBe(sessionId);
    expect(after.latestActiveSession?.workspaceId).toBe(bridgeWorkspaceId);
  });
});
