import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { appendExecutionRecord, readExecutionRecords } from "../src/execution/records.js";
import { saveExecutionOutput } from "../src/execution/output.js";
import {
  ENGINEERING_AI_AUDIT_MIRROR_FILENAME,
  ENGINEERING_AI_ONEDRIVE_FOLDER,
} from "../src/execution/audit-mirror.js";
import { makeTmpDir, cleanup, write, makeGitRepo, git, isolateStateDir } from "./helpers.js";

let root: string;
let mirrorRoot: string;
let bridge: Bridge;
let client: Client;
let accessToken: string;

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text: string }[];
  return content?.[0]?.text ?? "";
}

function jsonOf<T = Record<string, unknown>>(result: { content?: unknown }): T {
  return JSON.parse(textOf(result)) as T;
}

beforeAll(async () => {
  isolateStateDir();
  root = makeTmpDir("mcp-ws");
  makeGitRepo(root);
  const mirrorContainer = makeTmpDir("mcp-onedrive");
  mirrorRoot = path.join(mirrorContainer, ENGINEERING_AI_ONEDRIVE_FOLDER);
  fs.mkdirSync(path.join(mirrorRoot, "Desktop", "Startup"), { recursive: true });
  write(root, "package.json", JSON.stringify({ name: "demo", scripts: { test: "vitest run" }, dependencies: { react: "^19.0.0" } }));
  write(root, ".env", "API_KEY=supersecret\n");
  // an uncommitted change so git_diff has content
  write(root, "src/index.ts", "export const answer = 43; // changed\n");

  bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("auth"), "store.json"),
    oneDriveRoot: mirrorRoot,
  });
  const tokens = bridge.authStore.issueTokens({
    clientId: "it-client",
    scopes: ["workspace.read", "workspace.search", "git.read", "execution.read", "audit_mirror.write"],
  });
  accessToken = tokens.accessToken;

  client = new Client({ name: "c2c-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await bridge.close();
  cleanup(root);
  cleanup(mirrorRoot);
});

describe("MCP tools over Streamable HTTP", () => {
  it("lists the complete stabilized tool surface and exposes its routing schemas", async () => {
    const { tools } = await client.listTools();
    // Six deprecated Omnigent tools were removed; exact native session read
    // was added. Keep the explicit names as the contract, not just a count.
    expect(tools).toHaveLength(28);
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "agent_route",
      "agent_usage_status",
      "cancel_codex_task",
      "execution_output",
      "execution_queue",
      "execution_summary",
      "get_codex_task",
      "git_diff",
      "git_status",
      "list_directory",
      "read_file",
      "search_workspace",
      "submit_codex_task",
      "test_status",
      "workspace_info",
      "write_engineering_ai_audit_mirror",
      "zcode_cancel_task",
      "zcode_enqueue_task",
      "zcode_get_task",
      "zcode_list_tasks",
      "zcode_native_cancel_task",
      "zcode_native_execution_output",
      "zcode_native_get_task",
      "zcode_native_read_session",
      "zcode_native_resume_session",
      "zcode_native_self_test",
      "zcode_native_status",
      "zcode_native_submit_task",
    ]);
    for (const name of ["zcode_native_read_session", "zcode_native_resume_session"]) {
      const schema = tools.find((tool) => tool.name === name)?.inputSchema;
      expect(schema?.required).toEqual(expect.arrayContaining(["workspace_id", "session_id"]));
    }
    const submitTool = tools.find((tool) => tool.name === "submit_codex_task");
    const submitSchema = submitTool?.inputSchema as {
      properties?: { network?: { default?: unknown; description?: string } };
    } | undefined;
    expect(submitTool?.description).toContain("network=true is rejected");
    expect(submitSchema?.properties?.network?.default).toBe(false);
    expect(submitSchema?.properties?.network?.description).toContain("Must remain false");

    const queueTool = tools.find((tool) => tool.name === "execution_queue");
    const queueSchema = queueTool?.inputSchema as {
      properties?: Record<string, { enum?: unknown[]; default?: unknown }>;
      required?: string[];
    } | undefined;
    expect(queueSchema?.required).toContain("workspace_id");
    expect(queueSchema?.properties?.action?.enum).toEqual(["status", "pause", "resume"]);

    const outputTool = tools.find((tool) => tool.name === "execution_output");
    const outputSchema = outputTool?.inputSchema as {
      properties?: Record<string, unknown>;
    } | undefined;
    expect(outputSchema?.properties).toEqual(expect.objectContaining({
      workspace_id: expect.anything(),
      task_id: expect.anything(),
      session_id: expect.anything(),
      action: expect.anything(),
      id: expect.anything(),
      limit: expect.anything(),
    }));

    const getTaskTool = tools.find((tool) => tool.name === "get_codex_task");
    const getTaskSchema = getTaskTool?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    } | undefined;
    expect(getTaskSchema?.required).toContain("task_id");
    expect(getTaskSchema?.properties).toEqual(expect.objectContaining({
      workspace_id: expect.anything(),
      session_id: expect.anything(),
      task_id: expect.anything(),
    }));
    // The task adapter is scoped; no generic command or unrestricted write tools exist.
    for (const forbidden of [
      "write_file",
      "delete_file",
      "execute_shell",
      "run_shell",
      "arbitrary_command",
      "command_exec",
      "git_commit",
      "install_package",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("writes only the fixed audit mirror and returns machine-readable evidence", async () => {
    const content = "# MCP mirror check\n\nPASS\n";
    const result = await client.callTool({
      name: "write_engineering_ai_audit_mirror",
      arguments: { content },
    });
    const evidence = jsonOf<{ success: boolean; code: string; resolvedTarget: string; byteCount: number; sha256: string }>(result);
    expect(result.isError ?? false).toBe(false);
    expect(evidence.success).toBe(true);
    expect(evidence.code).toBe("OK");
    expect(evidence.byteCount).toBe(Buffer.byteLength(content, "utf8"));
    expect(evidence.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(evidence.resolvedTarget, "utf8")).toBe(content);
    const summary = jsonOf<{ records: { auditMirror?: { code: string } }[] }>(
      await client.callTool({ name: "execution_summary", arguments: {} })
    );
    expect(summary.records.some((record) => record.auditMirror?.code === "OK")).toBe(true);

    const denied = await client.callTool({
      name: "write_engineering_ai_audit_mirror",
      arguments: { target_path: "Desktop/Startup/other.md", content },
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("MIRROR_TARGET_DENIED");
  });

  it("workspace_info returns identity and project detection", async () => {
    const result = await client.callTool({ name: "workspace_info", arguments: {} });
    const info = jsonOf<{ workspaceId: string; projectType: string; frameworks: string[]; git: { isRepo: boolean; branch: string } }>(result);
    expect(info.workspaceId).toBe(bridge.workspace.id);
    expect(info.projectType).toBe("node");
    expect(info.frameworks).toContain("React");
    expect(info.git.isRepo).toBe(true);
    expect(info.git.branch).toBe("main");
  });

  it("routes the same authorized connector to the pre-registered bridge workspace", async () => {
    const bridgeWorkspace = bridge.registry.listMetadata().find((entry) => entry.name === "c2c-bridge");
    expect(bridgeWorkspace).toBeTruthy();
    const selectedId = bridgeWorkspace!.id;

    const selectedInfo = jsonOf<{
      workspaceId: string;
      workspaceName: string;
      authorizedWorkspaces: { id: string; name: string; enabled: boolean; canonicalPath?: string }[];
    }>(await client.callTool({ name: "workspace_info", arguments: { workspace_id: selectedId } }));
    expect(selectedInfo.workspaceId).toBe(selectedId);
    expect(selectedInfo.workspaceName).toBe("c2c-bridge");
    expect(selectedInfo.authorizedWorkspaces.map((entry) => entry.id)).toContain(bridgeWorkspace!.id);
    expect(selectedInfo.authorizedWorkspaces.every((entry) => entry.canonicalPath === undefined)).toBe(true);

    const source = jsonOf<{ path: string; content: string }>(await client.callTool({
      name: "read_file",
      arguments: { workspace_id: selectedId, path: "package.json" },
    }));
    expect(source.path).toBe("package.json");
    expect(source.content).toContain("codex-with-chatgpt");

    const searched = jsonOf<{ matches: { path: string }[] }>(await client.callTool({
      name: "search_workspace",
      arguments: { workspace_id: selectedId, query: "CodexTaskManager", path: "src" },
    }));
    expect(searched.matches.some((match) => match.path === "src/execution/pool.ts")).toBe(true);

    const status = jsonOf<{ isRepo: boolean }>(await client.callTool({
      name: "git_status",
      arguments: { workspace_id: selectedId },
    }));
    expect(status.isRepo).toBe(true);
  });

  it("fails closed for unknown/unauthorized workspaces and absolute MCP paths", async () => {
    const bridgeWorkspace = bridge.registry.listMetadata().find((entry) => entry.name === "c2c-bridge");
    expect(bridgeWorkspace).toBeTruthy();

    const unauthorized = bridge.authStore.issueTokens({
      clientId: "single-workspace-client",
      scopes: ["workspace.read"],
      workspaceId: bridge.workspace.id,
    });
    const limitedClient = new Client({ name: "single-workspace", version: "1.0.0" });
    await limitedClient.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${unauthorized.accessToken}` } },
    }));

    const denied = await limitedClient.callTool({
      name: "workspace_info",
      arguments: { workspace_id: bridgeWorkspace!.id },
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("WORKSPACE_NOT_AUTHORIZED");

    const unknown = await client.callTool({ name: "workspace_info", arguments: { workspace_id: "deadbeef0000" } });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("WORKSPACE_NOT_FOUND");

    const absolute = await client.callTool({
      name: "read_file",
      arguments: { path: "C:\\Windows\\win.ini" },
    });
    expect(absolute.isError).toBe(true);
    expect(textOf(absolute)).toContain("INVALID_PATH");
    await limitedClient.close();
  });

  it("read_file returns hello.txt", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    const file = jsonOf<{ content: string; totalLines: number }>(result);
    expect(file.content).toContain("Hello from Codex with ChatGPT!");
  });

  it("read_file denies .env with ACCESS_DENIED_SENSITIVE_FILE and no content", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: ".env" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ACCESS_DENIED_SENSITIVE_FILE");
    expect(textOf(result)).not.toContain("supersecret");
  });

  it("read_file denies paths outside the workspace", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: "../../etc/hosts" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("PATH_OUTSIDE_WORKSPACE");
  });

  it("list_directory lists the tree", async () => {
    const result = await client.callTool({ name: "list_directory", arguments: { path: ".", depth: 2 } });
    const listing = jsonOf<{ entries: { path: string }[] }>(result);
    const paths = listing.entries.map((entry) => entry.path);
    expect(paths).toContain("hello.txt");
    expect(paths).toContain("src/index.ts");
    expect(paths).not.toContain(".env");
  });

  it("search_workspace finds matches", async () => {
    const result = await client.callTool({ name: "search_workspace", arguments: { query: "answer" } });
    const search = jsonOf<{ matches: { path: string; line: number }[] }>(result);
    expect(search.matches.some((match) => match.path === "src/index.ts")).toBe(true);
  });

  it("git_status reports the dirty file", async () => {
    const result = await client.callTool({ name: "git_status", arguments: {} });
    const status = jsonOf<{ isRepo: boolean; unstaged: { path: string }[] }>(result);
    expect(status.isRepo).toBe(true);
    expect(status.unstaged.some((entry) => entry.path === "src/index.ts")).toBe(true);
  });

  it("git_diff shows the change", async () => {
    const result = await client.callTool({ name: "git_diff", arguments: { mode: "unstaged" } });
    const diff = jsonOf<{ diff: string; hasMore: boolean }>(result);
    expect(diff.diff).toContain("answer = 43");
    expect(diff.hasMore).toBe(false);
  });

  it("git_diff paginates large diffs", async () => {
    const big = Array.from({ length: 20000 }, (_, i) => `content line ${i}`).join("\n");
    write(root, "big-change.txt", big);
    git(root, "add", "big-change.txt");
    const first = jsonOf<{ hasMore: boolean; nextOffset: number; totalBytes: number; returnedBytes: number }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged", max_bytes: 4096 } })
    );
    expect(first.hasMore).toBe(true);
    expect(first.returnedBytes).toBeLessThanOrEqual(4096);
    const second = jsonOf<{ offset: number; diff: string }>(
      await client.callTool({
        name: "git_diff",
        arguments: { mode: "staged", max_bytes: 4096, offset: first.nextOffset },
      })
    );
    expect(second.offset).toBe(first.nextOffset);
    expect(second.diff.length).toBeGreaterThan(0);
    git(root, "reset", "big-change.txt");
  });

  it("execution_summary and test_status read harness records", async () => {
    appendExecutionRecord(bridge.workspace.id, {
      taskId: "c2c_test1",
      iteration: 1,
      changedFiles: ["src/index.ts"],
      tests: "27 passed",
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
    });
    expect(readExecutionRecords(bridge.workspace.id, 20).find((record) => record.taskId === "c2c_test1")?.network).toBe(false);
    const summary = jsonOf<{ records: { taskId: string }[] }>(
      await client.callTool({ name: "execution_summary", arguments: {} })
    );
    expect(summary.records[0].taskId).toBe("c2c_test1");

    const status = jsonOf<{ available: boolean; tests: string; outputAvailable: boolean; outputId: number | null }>(
      await client.callTool({ name: "test_status", arguments: {} })
    );
    expect(status.available).toBe(true);
    expect(status.tests).toBe("27 passed");
    expect(status.outputAvailable).toBe(false);
    expect(status.outputId).toBeNull();
  });

  it("execution_output lists readable items and refuses restricted bodies", async () => {
    const readable = saveExecutionOutput(bridge.workspace.id, {
      command: "pnpm test",
      raw: "FAIL src/a.test.ts\nAssertionError: expected true",
      exitCode: 1,
    });
    const hidden = saveExecutionOutput(bridge.workspace.id, {
      command: "print-key",
      raw: "-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----",
      exitCode: 0,
    });
    const list = jsonOf<{ items: { id: number; status: string; command: string; text?: string }[] }>(
      await client.callTool({ name: "execution_output", arguments: { action: "list" } })
    );
    expect(list.items.some((item) => item.id === readable.id && item.status === "readable")).toBe(true);
    expect(list.items.some((item) => item.id === hidden.id && item.status === "restricted")).toBe(true);
    expect(list.items.every((item) => item.text === undefined)).toBe(true);

    const body = jsonOf<{ text: string }>(
      await client.callTool({ name: "execution_output", arguments: { action: "read", id: readable.id } })
    );
    expect(body.text).toContain("AssertionError");

    const denied = await client.callTool({
      name: "execution_output",
      arguments: { action: "read", id: hidden.id },
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("OUTPUT_RESTRICTED");
    expect(textOf(denied)).not.toContain("BEGIN RSA");

    const missing = await client.callTool({
      name: "execution_output",
      arguments: { action: "read", id: 999999 },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("NOT_FOUND");
  });

  it("enforces scopes per tool", async () => {
    const limited = bridge.authStore.issueTokens({ clientId: "limited", scopes: ["workspace.read"] });
    const limitedClient = new Client({ name: "limited", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${limited.accessToken}` } },
    });
    await limitedClient.connect(transport);
    // Scopes gate invocation, not discovery: a limited token must see the
    // same catalog, including native controls, without being able to use them.
    const [limitedCatalog, fullCatalog] = await Promise.all([
      limitedClient.listTools(), client.listTools(),
    ]);
    expect(limitedCatalog.tools.map((tool) => tool.name).sort()).toEqual(
      fullCatalog.tools.map((tool) => tool.name).sort(),
    );
    for (const name of ["zcode_native_read_session", "zcode_native_resume_session"]) {
      const nativeDenied = await limitedClient.callTool({
        name,
        arguments: {
          workspace_id: bridge.workspace.id,
          session_id: "sess_00000000-0000-0000-0000-000000000000",
          ...(name === "zcode_native_resume_session" ? { instruction: "must not dispatch" } : {}),
        },
      });
      expect(nativeDenied.isError).toBe(true);
      expect(textOf(nativeDenied)).toContain("INSUFFICIENT_SCOPE");
    }
    const denied = await limitedClient.callTool({ name: "git_diff", arguments: {} });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("INSUFFICIENT_SCOPE");
    const outputDenied = await limitedClient.callTool({
      name: "execution_output",
      arguments: { action: "list" },
    });
    expect(outputDenied.isError).toBe(true);
    expect(textOf(outputDenied)).toContain("INSUFFICIENT_SCOPE");
    const allowed = await limitedClient.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    expect(allowed.isError ?? false).toBe(false);
    await limitedClient.close();
  });

  it("requires explicit execution scopes and rejects a denied network request", async () => {
    const limited = bridge.authStore.issueTokens({
      clientId: "execution-limited",
      scopes: ["workspace.read", "execution.read"],
    });
    const limitedClient = new Client({ name: "execution-limited", version: "1.0.0" });
    await limitedClient.connect(
      new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${limited.accessToken}` } },
      })
    );
    const submitDenied = await limitedClient.callTool({
      name: "submit_codex_task",
      arguments: {
        workspace_id: bridge.workspace.id,
        instruction: "not submitted",
        write_scope: ["src"],
      },
    });
    expect(submitDenied.isError).toBe(true);
    expect(textOf(submitDenied)).toContain("INSUFFICIENT_SCOPE");
    const mirrorDenied = await limitedClient.callTool({
      name: "write_engineering_ai_audit_mirror",
      arguments: { content: "must not write" },
    });
    expect(mirrorDenied.isError).toBe(true);
    expect(textOf(mirrorDenied)).toContain("INSUFFICIENT_SCOPE");
    await limitedClient.close();

    const execution = bridge.authStore.issueTokens({
      clientId: "execution-client",
      scopes: ["execution.submit", "execution.read", "execution.cancel"],
    });
    const executionClient = new Client({ name: "execution-client", version: "1.0.0" });
    await executionClient.connect(
      new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${execution.accessToken}` } },
      })
    );
    const networkDenied = await executionClient.callTool({
      name: "submit_codex_task",
      arguments: {
        workspace_id: bridge.workspace.id,
        instruction: "must not start",
        write_scope: ["src"],
        network: true,
      },
    });
    expect(networkDenied.isError).toBe(true);
    expect(textOf(networkDenied)).toContain("NETWORK_NOT_ALLOWED");
    await executionClient.close();
  });

  it("git_diff over MCP excludes sensitive files like .npmrc and service-account*.json", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=supersecret-npm-token\n");
    write(root, "service-account-test.json", '{"private_key": "supersecret-sa-key"}\n');
    write(root, "src/visible.ts", "export const visible = 'safe-change';\n");

    git(root, "add", "-f", ".npmrc", "service-account-test.json", "src/visible.ts");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged" } })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).toContain("safe-change");
    expect(result.diff).not.toContain("supersecret-npm-token");
    expect(result.diff).not.toContain("supersecret-sa-key");

    git(root, "rm", "-f", "--cached", ".npmrc", "service-account-test.json", "src/visible.ts");
  });

  it("git_diff over MCP blocks sensitive-to-safe renames from leaking original content", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=mcp-secret-token-123\n");
    git(root, "add", "-f", ".npmrc");
    git(root, "commit", "-m", "add secret to rename");

    git(root, "mv", ".npmrc", "public_harmless.txt");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged" } })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).not.toContain("mcp-secret-token-123");
    expect(result.diff).not.toContain("public_harmless.txt");

    git(root, "reset", "--hard", "HEAD");
  });

  it("git_diff over MCP with path='src' blocks cross-boundary rename leaks from root secrets", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=root-mcp-scoped-secret\n");
    git(root, "add", "-f", ".npmrc");
    git(root, "commit", "-m", "add root secret for scoped test");

    // Rename root .npmrc to src/public.txt
    git(root, "mv", ".npmrc", "src/public.txt");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({
        name: "git_diff",
        arguments: { mode: "staged", path: "src" },
      })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).not.toContain("root-mcp-scoped-secret");
    expect(result.diff).not.toContain("src/public.txt");

    git(root, "reset", "--hard", "HEAD");
  });
});
