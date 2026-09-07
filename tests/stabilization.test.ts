import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  AppServerClient,
  AppServerNotification,
  AppServerRequest,
  RpcId,
} from "../src/execution/app-server.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { getStateDir, writeSecureJson } from "../src/config/paths.js";
import { BRIDGE_REPOSITORY_ROOT } from "../src/execution/verification.js";
import { saveExecutionOutput } from "../src/execution/output.js";
import { Workspace } from "../src/workspace/manager.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

class HoldingAppServer implements AppServerClient {
  private notificationHandler: ((notification: AppServerNotification) => void | Promise<void>) | null = null;
  private requestHandler: ((request: AppServerRequest) => void | Promise<void>) | null = null;

  constructor(private readonly label: string) {}

  async initialize(): Promise<void> {}

  async request<T>(method: string): Promise<T> {
    if (method === "thread/start") return { thread: { id: `thread-${this.label}` } } as T;
    if (method === "turn/start") return { turn: { id: `turn-${this.label}` } } as T;
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

async function waitForStatus(
  client: Client,
  workspaceId: string,
  taskId: string,
  expected: string,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i++) {
    const result = await client.callTool({
      name: "get_codex_task",
      arguments: { workspace_id: workspaceId, task_id: taskId },
    });
    const task = jsonOf<Record<string, unknown>>(result);
    if (task.status === expected) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Task ${taskId} did not reach ${expected}`);
}

describe("C2C stabilization routing and lifecycle", () => {
  let stateRoot: string;
  let root: string;
  let bridge: Bridge;
  let client: Client;
  let workspaceId: string;
  let bridgeWorkspaceId: string;
  let remoteWorkspaceId: string;
  let remoteRoot: string;

  beforeAll(async () => {
    stateRoot = isolateStateDir();
    root = makeTmpDir("stabilization-workspace");
    makeGitRepo(root);
    write(root, "workspace-marker.txt", "engineering-fixture-only\n");
    write(root, "package.json", JSON.stringify({ name: "engineering-fixture", scripts: { test: "vitest run" } }));
    write(root, "hello.txt", "root-dirty-for-routing\n");

    remoteRoot = makeTmpDir("stabilization-remote-workspace");
    makeGitRepo(remoteRoot);
    const remoteWorkspace = new Workspace(remoteRoot);
    remoteWorkspaceId = remoteWorkspace.id;
    const workspaceRegistryFile = path.join(makeTmpDir("stabilization-registry"), "workspaces.json");
    const configuredRegistry = new WorkspaceRegistry({ file: workspaceRegistryFile });
    configuredRegistry.registerTrusted({ name: "stabilization-remote", canonicalPath: remoteRoot });

    const workspace = new Workspace(root);
    bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("stabilization-auth"), "store.json"),
      workspaceRegistryFile,
      fullAccess: false,
      appServerFactory: ({ workspaceRoot }) => new HoldingAppServer(new Workspace(workspaceRoot).id),
    });
    workspaceId = workspace.id;
    bridgeWorkspaceId = bridge.registry.listMetadata().find((entry) => entry.name === "c2c-bridge")!.id;
    // The bridge self-referential workspace id is derived from the actual
    // repository root on whatever machine runs the suite — never a constant.
    expect(bridgeWorkspaceId).toBe(new Workspace(BRIDGE_REPOSITORY_ROOT).id);

    const accessToken = bridge.authStore.issueTokens({
      clientId: "stabilization-owner",
      workspaceIds: [workspaceId, bridgeWorkspaceId, remoteWorkspaceId],
      scopes: [
        "workspace.read",
        "workspace.search",
        "git.read",
        "execution.read",
        "execution.submit",
        "execution.cancel",
      ],
    }).accessToken;
    client = new Client({ name: "stabilization-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }));
  });

  afterAll(async () => {
    await client?.close();
    await bridge?.close();
    cleanup(root);
    cleanup(remoteRoot);
    cleanup(stateRoot);
    delete process.env.C2C_STATE_DIR;
  });

  it("routes every workspace read/review operation through the explicit workspace id", async () => {
    const fixtureInfo = jsonOf<{ workspaceId: string }>(await client.callTool({
      name: "workspace_info",
      arguments: { workspace_id: workspaceId },
    }));
    expect(fixtureInfo.workspaceId).toBe(workspaceId);

    const bridgeInfo = jsonOf<{ workspaceId: string; workspaceName: string }>(await client.callTool({
      name: "workspace_info",
      arguments: { workspace_id: bridgeWorkspaceId },
    }));
    expect(bridgeInfo).toMatchObject({ workspaceId: bridgeWorkspaceId, workspaceName: "c2c-bridge" });

    const file = jsonOf<{ content: string }>(await client.callTool({
      name: "read_file",
      arguments: { workspace_id: workspaceId, path: "workspace-marker.txt" },
    }));
    expect(file.content).toContain("engineering-fixture-only");

    const listing = jsonOf<{ entries: { path: string }[] }>(await client.callTool({
      name: "list_directory",
      arguments: { workspace_id: workspaceId, path: ".", depth: 1 },
    }));
    expect(listing.entries.map((entry) => entry.path)).toContain("workspace-marker.txt");

    const search = jsonOf<{ matches: { path: string }[] }>(await client.callTool({
      name: "search_workspace",
      arguments: { workspace_id: workspaceId, query: "engineering-fixture-only" },
    }));
    expect(search.matches.some((match) => match.path === "workspace-marker.txt")).toBe(true);

    const status = jsonOf<{ isRepo: boolean }>(await client.callTool({
      name: "git_status",
      arguments: { workspace_id: workspaceId },
    }));
    expect(status.isRepo).toBe(true);
    const diff = jsonOf<{ diff: string }>(await client.callTool({
      name: "git_diff",
      arguments: { workspace_id: workspaceId, mode: "unstaged" },
    }));
    expect(diff.diff).toContain("root-dirty-for-routing");
  });

  it("locates and cancels queued tasks by immutable task id, without a default workspace lookup", async () => {
    const running = jsonOf<{ taskId: string; sessionId: string }>(await client.callTool({
      name: "submit_codex_task",
      arguments: {
        workspace_id: workspaceId,
        instruction: "hold the fixture workspace writer",
        write_scope: ["src"],
        run_tests: false,
      },
    }));
    await waitForStatus(client, workspaceId, running.taskId, "running");

    const queued = jsonOf<{ taskId: string; sessionId: string; status: string; queuePosition: number | null }>(await client.callTool({
      name: "submit_codex_task",
      arguments: {
        workspace_id: workspaceId,
        instruction: "remain queued until the first fixture task is cancelled",
        write_scope: ["src"],
        run_tests: false,
      },
    }));
    expect(queued).toMatchObject({ status: "queued", queuePosition: expect.any(Number) });

    const summary = jsonOf<{
      latestActiveSession: { id: string; lastTaskId?: string } | null;
      activeTask: { taskId: string; workspaceId: string; status: string } | null;
      queuedTasks: { taskId: string; sessionId: string | null; status: string }[];
    }>(await client.callTool({ name: "execution_summary", arguments: {} }));
    expect(summary.activeTask).toMatchObject({ taskId: running.taskId, workspaceId, status: "running" });
    expect(summary.latestActiveSession?.lastTaskId).not.toBe(queued.taskId);
    expect(summary.queuedTasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: queued.taskId, sessionId: queued.sessionId, status: "queued" }),
    ]));

    const taskById = jsonOf<{ taskId: string; workspaceId: string; status: string }>(await client.callTool({
      name: "get_codex_task",
      arguments: { task_id: queued.taskId },
    }));
    expect(taskById).toMatchObject({ taskId: queued.taskId, workspaceId, status: "queued" });

    const wrongWorkspace = await client.callTool({
      name: "get_codex_task",
      arguments: { workspace_id: bridgeWorkspaceId, task_id: queued.taskId },
    });
    expect(wrongWorkspace.isError).toBe(true);
    expect(textOf(wrongWorkspace)).toContain("WORKSPACE_MISMATCH");

    const cancelledQueued = jsonOf<{ taskId: string; workspaceId: string; status: string }>(await client.callTool({
      name: "cancel_codex_task",
      arguments: { task_id: queued.taskId },
    }));
    expect(cancelledQueued).toMatchObject({ taskId: queued.taskId, workspaceId, status: "cancelled" });

    const cancelledRunning = jsonOf<{ taskId: string; workspaceId: string; status: string }>(await client.callTool({
      name: "cancel_codex_task",
      arguments: { task_id: running.taskId },
    }));
    expect(cancelledRunning).toMatchObject({ taskId: running.taskId, workspaceId, status: "cancelled" });
  });

  it("finds and cancels queued and running tasks by id in a non-default workspace", async () => {
    const running = jsonOf<{ taskId: string; workspaceId: string }>(await client.callTool({
      name: "submit_codex_task",
      arguments: {
        workspace_id: remoteWorkspaceId,
        instruction: "hold the non-default bridge workspace writer",
        write_scope: ["src"],
        run_tests: false,
      },
    }));
    await waitForStatus(client, remoteWorkspaceId, running.taskId, "running");

    const queued = jsonOf<{ taskId: string; workspaceId: string; status: string }>(await client.callTool({
      name: "submit_codex_task",
      arguments: {
        workspace_id: remoteWorkspaceId,
        instruction: "remain queued in the non-default workspace",
        write_scope: ["src"],
        run_tests: false,
      },
    }));
    expect(queued.status).toBe("queued");

    expect(jsonOf<{ taskId: string; workspaceId: string }>(await client.callTool({
      name: "get_codex_task",
      arguments: { task_id: queued.taskId },
    }))).toMatchObject({ taskId: queued.taskId, workspaceId: remoteWorkspaceId });
    expect(jsonOf<{ taskId: string; workspaceId: string; status: string }>(await client.callTool({
      name: "cancel_codex_task",
      arguments: { task_id: queued.taskId },
    }))).toMatchObject({ taskId: queued.taskId, workspaceId: remoteWorkspaceId, status: "cancelled" });
    expect(jsonOf<{ taskId: string; workspaceId: string; status: string }>(await client.callTool({
      name: "cancel_codex_task",
      arguments: { task_id: running.taskId },
    }))).toMatchObject({ taskId: running.taskId, workspaceId: remoteWorkspaceId, status: "cancelled" });
  });

  it("denies task access before resolving an unauthorized workspace", async () => {
    const submitted = jsonOf<{ taskId: string }>(await client.callTool({
      name: "submit_codex_task",
      arguments: {
        workspace_id: workspaceId,
        instruction: "seed a task for the unauthorized workspace regression",
        write_scope: ["src"],
        run_tests: false,
      },
    }));
    await waitForStatus(client, workspaceId, submitted.taskId, "running");

    const limitedToken = bridge.authStore.issueTokens({
      clientId: "stabilization-limited-owner",
      workspaceIds: [workspaceId],
      scopes: ["execution.read", "execution.cancel"],
    }).accessToken;
    const limitedClient = new Client({ name: "stabilization-limited", version: "1.0.0" });
    await limitedClient.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${limitedToken}` } },
    }));
    try {
      const read = await limitedClient.callTool({
        name: "get_codex_task",
        arguments: { workspace_id: remoteWorkspaceId, task_id: submitted.taskId },
      });
      expect(read.isError).toBe(true);
      expect(textOf(read)).toContain("WORKSPACE_NOT_AUTHORIZED");

      const cancel = await limitedClient.callTool({
        name: "cancel_codex_task",
        arguments: { workspace_id: remoteWorkspaceId, task_id: submitted.taskId },
      });
      expect(cancel.isError).toBe(true);
      expect(textOf(cancel)).toContain("WORKSPACE_NOT_AUTHORIZED");
    } finally {
      await limitedClient.close();
      await client.callTool({
        name: "cancel_codex_task",
        arguments: { workspace_id: workspaceId, task_id: submitted.taskId },
      });
    }
  });

  it("fails closed when an immutable task id exists in two authorized workspaces", async () => {
    const taskId = "c2c_f00dbaad1234";
    const timestamp = "2026-09-02T12:00:00.000Z";
    const taskRecord = (selectedWorkspaceId: string) => ({
      taskId,
      workspaceId: selectedWorkspaceId,
      ownerId: "stabilization-owner",
      instruction: "synthetic duplicate task id for routing regression",
      instructionHash: "synthetic-test-hash",
      writeScope: ["src"],
      queuePosition: 900,
      fullAccess: false,
      networkRequested: false,
      networkEffective: false,
      networkReported: false,
      network: false,
      runTests: false,
      approvalMode: "workspace_write",
      status: "completed",
      submittedAt: timestamp,
      completedAt: timestamp,
      changedFiles: [],
      tests: null,
      outputIds: [],
      approvalEvents: [],
      executionRecorded: true,
    });
    writeSecureJson(
      path.join(getStateDir(), "tasks", workspaceId, `${taskId}.json`),
      taskRecord(workspaceId),
    );
    writeSecureJson(
      path.join(getStateDir(), "tasks", bridgeWorkspaceId, `${taskId}.json`),
      taskRecord(bridgeWorkspaceId),
    );

    const read = await client.callTool({ name: "get_codex_task", arguments: { task_id: taskId } });
    expect(read.isError).toBe(true);
    expect(textOf(read)).toContain("TASK_WORKSPACE_AMBIGUOUS");

    const cancel = await client.callTool({ name: "cancel_codex_task", arguments: { task_id: taskId } });
    expect(cancel.isError).toBe(true);
    expect(textOf(cancel)).toContain("TASK_WORKSPACE_AMBIGUOUS");

    const explicit = jsonOf<{ taskId: string; workspaceId: string }>(await client.callTool({
      name: "get_codex_task",
      arguments: { workspace_id: bridgeWorkspaceId, task_id: taskId },
    }));
    expect(explicit).toMatchObject({ taskId, workspaceId: bridgeWorkspaceId });
  });

  it("disambiguates historical workspace-local output ids instead of reading the default namespace", async () => {
    const fixtureOutput = saveExecutionOutput(workspaceId, {
      command: "fixture test",
      raw: "fixture output 39",
      exitCode: 0,
      ownerId: "stabilization-owner",
      taskId: "c2c_aaaaaaaa",
    });
    const bridgeOutput = saveExecutionOutput(bridgeWorkspaceId, {
      command: "bridge test",
      raw: "bridge output 40",
      exitCode: 0,
      ownerId: "stabilization-owner",
      taskId: "c2c_bbbbbbbb",
    });
    expect(fixtureOutput.id).toBe(1);
    expect(bridgeOutput.id).toBe(1);

    const ambiguous = await client.callTool({
      name: "execution_output",
      arguments: { action: "read", id: 1 },
    });
    expect(ambiguous.isError).toBe(true);
    expect(textOf(ambiguous)).toContain("OUTPUT_WORKSPACE_AMBIGUOUS");

    const fixture = jsonOf<{ workspaceId: string; text: string }>(await client.callTool({
      name: "execution_output",
      arguments: { action: "read", workspace_id: workspaceId, id: 1 },
    }));
    expect(fixture).toMatchObject({ workspaceId, text: "fixture output 39" });

    const wrongSession = await client.callTool({
      name: "execution_output",
      arguments: { action: "read", workspace_id: workspaceId, session_id: "c2cs_0000000000000000", id: 1 },
    });
    expect(wrongSession.isError).toBe(true);
    expect(textOf(wrongSession)).toContain("OUTPUT_SESSION_MISMATCH");

    const listed = jsonOf<{ items: { workspaceId: string; id: number }[] }>(await client.callTool({
      name: "execution_output",
      arguments: { action: "list" },
    }));
    expect(listed.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ workspaceId, id: 1 }),
      expect.objectContaining({ workspaceId: bridgeWorkspaceId, id: 1 }),
    ]));

    const missing = await client.callTool({
      name: "execution_output",
      arguments: { action: "read", workspace_id: bridgeWorkspaceId, id: 999999 },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("NOT_FOUND");
  });
});
