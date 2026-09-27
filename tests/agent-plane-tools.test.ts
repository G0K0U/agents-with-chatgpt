import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  registerZcodeSessionTools,
  resetZcodeSessionClientForTests,
  resetZcodeSessionOwnershipForTests,
  zcodeSessionClient,
} from "../src/mcp/zcode-session-tools.js";
import {
  registerAgentPlaneTools,
  resetAgentPlaneForTests,
} from "../src/mcp/agent-plane-tools.js";

/**
 * Live-path acceptance for the shared session/activity plane over the A2C
 * public MCP gateway: A2C-created ZCode sessions and native/Desktop-discovered
 * sessions appear in ONE projection; observation across clients works while
 * control stays owner-bound (foreign control denied, no oracle).
 */

const TEST_TOKEN = "z2cs_test_token_0123456789abcdef";
const CANONICAL = "f:\\examplework\\engineering-ai";
const DESKTOP_SESSION = "sess_dddddddd-4444-4444-4444-444444444444";

const fake = {
  serverUrl: "",
  sessions: new Map<string, { workspace_id: string; model: string; thought: string }>(),
  nativeMessages: new Map<string, Array<Record<string, unknown>>>([
    [DESKTOP_SESSION, [
      { info: { role: "user" }, parts: [{ type: "text", text: "refactor the parser module" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "parsed 12 files" }] },
      { info: { role: "assistant" }, parts: [{ type: "thinking", text: "HIDDEN REASONING MUST NOT LEAK" }] },
    ]],
  ]),
  discover: [
    {
      session_id: DESKTOP_SESSION,
      workspace_id: "ws_grant",
      workspace_path: CANONICAL,
      status: "idle",
      title: "desktop session",
      updated_at: "2026-09-22T03:00:00.000Z",
      controlled_by_z2c: false,
      owner_client_id: null,
      access_mode: null,
      runtime_origin: "external",
    },
    {
      session_id: "sess_eeeeeeee-5555-5555-5555-555555555555",
      workspace_id: "ws_grant_escape",
      workspace_path: "d:\\outside",
      status: "idle",
      title: "escape attempt",
      updated_at: "2026-09-22T03:01:00.000Z",
      controlled_by_z2c: false,
      owner_client_id: null,
      access_mode: null,
      runtime_origin: "external",
    },
  ] as Array<Record<string, unknown>>,
};

function attestedFor(workspace_id: string, sessionId: string) {
  const s = fake.sessions.get(sessionId)!;
  return {
    session_id: sessionId,
    workspace_id,
    provider_id: "zai-api",
    model_id: s?.model ?? "GLM-5.3-Flash",
    thought_level: s?.thought ?? "max",
    collaboration_mode: "edit",
    plan_enabled: false,
    runtime_version: "0.16.9",
    binding_source: "official-session-read",
  };
}

function toolResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}
function upstreamError(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

let fakeHttp: import("node:http").Server | null = null;

async function startFakeZ2cService(): Promise<void> {
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${TEST_TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (req.url?.startsWith("/api/workspaces/authorize")) {
        let body = "";
        for await (const c of req) body += c;
        const parsed = JSON.parse(body) as { path?: string };
        const grant = {
          workspace_id: "ws_grant",
          canonical_path: parsed.path,
          display_name: "a2c-shared",
          permissions: { read: true, write: true },
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(grant));
        return;
      }
      const mcp = new McpServer({ name: "z2c-service", version: "1" });
      mcp.registerTool("zcode_runtime_capabilities", { inputSchema: {} }, async () =>
        toolResult({ z2c_protocol_version: 1, provider: "zcode-official", provider_status: "healthy", zcode_runtime_version: "0.16.9" }));
      mcp.registerTool("zcode_workspace_list", { inputSchema: {} }, async () =>
        toolResult({ workspaces: [{ workspace_id: "ws_grant", canonical_path: CANONICAL, permissions: { read: true, write: true } }] }));
      mcp.registerTool("zcode_session_create", {
        inputSchema: { workspace_id: z.string(), access: z.enum(["readonly", "write"]), model: z.string().optional(), thought_level: z.string().optional(), provider: z.string().optional() },
      }, async (args) => {
        const sessionId = `sess_${randomUUID()}`;
        fake.sessions.set(sessionId, { workspace_id: args.workspace_id, model: args.model ?? "GLM-5.3-Flash", thought: args.thought_level ?? "max" });
        return toolResult(attestedFor(args.workspace_id, sessionId));
      });
      mcp.registerTool("zcode_session_read", { inputSchema: { workspace_id: z.string(), session_id: z.string() } }, async (args) => {
        if (!fake.sessions.has(args.session_id)) return upstreamError("ZCODE_SESSION_UPSTREAM: session vanished");
        return toolResult(attestedFor(args.workspace_id, args.session_id));
      });
      mcp.registerTool("zcode_session_send", {
        inputSchema: { workspace_id: z.string(), session_id: z.string(), instruction: z.string(), timeout_ms: z.number().optional() },
      }, async (args) => {
        if (!fake.sessions.has(args.session_id)) return upstreamError("ZCODE_SESSION_UPSTREAM: session vanished");
        return toolResult({ state: attestedFor(args.workspace_id, args.session_id), output: "FAKE TURN OK", turn: "completed" });
      });
      mcp.registerTool("zcode_session_set_model", {
        inputSchema: { workspace_id: z.string(), session_id: z.string(), model: z.string() },
      }, async (args) => {
        if (!fake.sessions.has(args.session_id)) return upstreamError("ZCODE_SESSION_UPSTREAM: session vanished");
        fake.sessions.get(args.session_id)!.model = args.model;
        return toolResult(attestedFor(args.workspace_id, args.session_id));
      });
      mcp.registerTool("zcode_session_set_thought_level", {
        inputSchema: { workspace_id: z.string(), session_id: z.string(), thought_level: z.string() },
      }, async (args) => {
        if (!fake.sessions.has(args.session_id)) return upstreamError("ZCODE_SESSION_UPSTREAM: session vanished");
        fake.sessions.get(args.session_id)!.thought = args.thought_level;
        return toolResult(attestedFor(args.workspace_id, args.session_id));
      });
      mcp.registerTool("zcode_session_discover", { inputSchema: { workspace_id: z.string().optional() } }, async () =>
        toolResult({ sessions: fake.discover.concat(
          [...fake.sessions.entries()].map(([sessionId, s]) => ({
            session_id: sessionId,
            workspace_id: s.workspace_id,
            workspace_path: CANONICAL,
            status: "idle",
            title: "created session",
            updated_at: new Date().toISOString(),
            controlled_by_z2c: true,
            owner_client_id: "local",
            access_mode: "write",
            runtime_origin: "z2c",
          })),
        ) }));
      mcp.registerTool("zcode_session_observe", { inputSchema: { workspace_id: z.string(), session_id: z.string() } }, async (args) => {
        if (!fake.sessions.has(args.session_id) && args.session_id !== DESKTOP_SESSION) {
          return upstreamError("ZCODE_SESSION_UPSTREAM: session is not associated with this workspace");
        }
        return toolResult(attestedFor(args.workspace_id, args.session_id));
      });
      mcp.registerTool("zcode_session_observe_messages", {
        inputSchema: { workspace_id: z.string(), session_id: z.string(), limit: z.number().optional() },
      }, async (args) => {
        const messages = fake.nativeMessages.get(args.session_id);
        if (!messages && !fake.sessions.has(args.session_id)) {
          return upstreamError("ZCODE_SESSION_UPSTREAM: session is not associated with this workspace");
        }
        return toolResult({ messages: messages ?? [{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }] });
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    })().catch(() => {
      try { res.writeHead(500).end(); } catch { /* noop */ }
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as { port: number }).port;
  fake.serverUrl = `http://127.0.0.1:${port}`;
  fakeHttp = httpServer;
}

// ── harness over the real tool handlers ─────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "agent-plane-tools-"));
const VISIBLE = [{ workspaceId: "ws_eng", canonicalPath: CANONICAL }];

function auth(clientId?: string) {
  if (!clientId) return undefined;
  return { clientId, extra: { authorizedWorkspaceIds: ["ws_eng"] } };
}

function call(name: string, args: unknown, clientId?: string): Promise<{ isError?: boolean; content: { text: string }[] }> {
  // Both tool families live on one server, mirroring the real gateway.
  const servers = harness.server as unknown as { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> };
  const tool = servers._registeredTools[name];
  assert.ok(tool, `tool ${name} missing`);
  return tool.handler(args, { authInfo: auth(clientId) }) as Promise<{ isError?: boolean; content: { text: string }[] }>;
}

function dataOf(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content.map((c) => c.text).join("\n"));
}

const harness: { server?: McpServer } = {};

describe("shared session/activity plane over the A2C MCP gateway", () => {
  beforeAll(async () => {
    await startFakeZ2cService();
    process.env.ZCODE_SESSION_URL = `${fake.serverUrl}/mcp`;
    process.env.ZCODE_SESSION_TOKEN = TEST_TOKEN;
    process.env.ZCODE_SESSION_SECURITY_FILE = join(dir, "missing.json");
    resetZcodeSessionClientForTests();
    resetZcodeSessionOwnershipForTests();
    resetAgentPlaneForTests();

    const server = new McpServer({ name: "a2c-test", version: "0" });
    const common = {
      requireScope: () => null,
      ok: (data: unknown) => toolResult(data),
      fail: (code: string, message: string) => ({ isError: true, content: [{ type: "text", text: `${code}: ${message}` }] }),
      mapError: (error: unknown) => {
        const coded = error as { code?: string; message?: string };
        return { isError: true, content: [{ type: "text", text: coded?.code ? `${coded.code}: ${coded.message}` : `INTERNAL: ${String((error as Error)?.message ?? error)}` }] };
      },
      untrustedNote: "[untrusted]",
    };
    registerZcodeSessionTools(server, {
      ...common,
      resolveWorkspace: (requestedId) => {
        if (requestedId !== "ws_eng") {
          throw Object.assign(new Error("Workspace is not authorized for this identity"), { code: "WORKSPACE_NOT_AUTHORIZED" });
        }
        return { root: CANONICAL };
      },
      visibleWorkspaces: () => VISIBLE,
      stateDir: dir,
    });
    registerAgentPlaneTools(server, {
      ...common,
      visibleWorkspaces: (authInfo) => {
        const raw = (authInfo as { extra?: { authorizedWorkspaceIds?: string[] } } | undefined)?.extra?.authorizedWorkspaceIds;
        if (!authInfo) return VISIBLE;
        return raw && raw.length > 0 ? VISIBLE : [];
      },
      stateDir: dir,
    });
    harness.server = server;
    // Force the plane to construct against the configured fake URL.
    void zcodeSessionClient();
  });

  afterAll(() => {
    fakeHttp?.close();
    delete process.env.ZCODE_SESSION_URL;
    delete process.env.ZCODE_SESSION_TOKEN;
    delete process.env.ZCODE_SESSION_SECURITY_FILE;
    resetZcodeSessionClientForTests();
    resetZcodeSessionOwnershipForTests();
    resetAgentPlaneForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("A2C-created ZCode session appears in the shared projection next to Desktop-originated sessions", async () => {
    const created = await call("zcode_session_create", { workspace_id: "ws_eng", access: "write", model: "GLM-5.3-Flash", thought_level: "max" }, "client-A");
    assert.equal(created.isError, undefined, created.content.map((c) => c.text).join());
    const createdId = (dataOf(created) as { session_id: string }).session_id;

    const list = await call("agent_session_list", { provider: "zcode" }, undefined);
    assert.equal(list.isError, undefined);
    const sessions = (dataOf(list) as { sessions: Array<{ session_id: string; origin: string; provider: string }> }).sessions;
    const ids = sessions.map((s) => s.session_id);
    assert.ok(ids.includes(createdId), "A2C-created session must be projected");
    assert.ok(ids.includes(DESKTOP_SESSION), "Desktop-originated session must be projected");
    assert.ok(!ids.includes("sess_eeeeeeee-5555-5555-5555-555555555555"), "outside-root sessions are never projected");
    const a2cRecord = sessions.find((s) => s.session_id === createdId)!;
    assert.equal(a2cRecord.origin, "a2c");
    const desktopRecord = sessions.find((s) => s.session_id === DESKTOP_SESSION)!;
    assert.equal(desktopRecord.origin, "desktop");
  });

  it("Desktop/native session messages are observable with reasoning filtered out", async () => {
    const result = await call("agent_session_messages", { session_id: DESKTOP_SESSION, limit: 10 }, "client-A");
    assert.equal(result.isError, undefined, result.content.map((c) => c.text).join());
    const body = JSON.stringify(dataOf(result));
    assert.ok(body.includes("refactor the parser module"));
    assert.ok(body.includes("parsed 12 files"));
    assert.ok(!body.includes("HIDDEN REASONING MUST NOT LEAK"));
    assert.ok(!body.includes("thinking"));
  });

  it("same-workspace observer can READ another client's session but CANNOT control it", async () => {
    const created = await call("zcode_session_create", { workspace_id: "ws_eng", access: "write" }, "client-A");
    const createdId = (dataOf(created) as { session_id: string }).session_id;

    // Observation is allowed for a same-workspace client.
    const observed = await call("agent_session_messages", { session_id: createdId }, "client-B");
    assert.equal(observed.isError, undefined, observed.content.map((c) => c.text).join());
    const read = await call("agent_session_read", { session_id: createdId }, "client-B");
    const record = dataOf(read) as { caller_can_control: boolean; owner_client_id: string | null };
    assert.equal(record.owner_client_id, "client-A");
    assert.equal(record.caller_can_control, false, "observer must not be projected as controller");

    // Control is denied for the non-owner (fail-closed, before any upstream call).
    const denied = await call("zcode_session_send", { workspace_id: "ws_eng", session_id: createdId, instruction: "malicious override" }, "client-B");
    assert.equal(denied.isError, true);
    assert.ok(denied.content[0].text.startsWith("ZCODE_SESSION_NOT_OWNED"));

    // The same denial for a session that does not exist at all (no oracle).
    const oracle = await call("zcode_session_send", { workspace_id: "ws_eng", session_id: "sess_99999999-9999-9999-9999-999999999999", instruction: "x" }, "client-B");
    assert.equal(oracle.isError, true);
    assert.equal(
      denied.content[0].text.split(":")[0],
      oracle.content[0].text.split(":")[0],
      "denials for foreign and unknown sessions must be indistinguishable",
    );

    // Desktop session control is denied for every MCP client (local-operator bound).
    const desktopControl = await call("zcode_session_send", { workspace_id: "ws_eng", session_id: DESKTOP_SESSION, instruction: "take over" }, "client-A");
    assert.equal(desktopControl.isError, true);
    assert.ok(desktopControl.content[0].text.startsWith("ZCODE_SESSION_NOT_OWNED"));
  });

  it("owner retains control of its own A2C-created session", async () => {
    const created = await call("zcode_session_create", { workspace_id: "ws_eng", access: "write" }, "client-A");
    const createdId = (dataOf(created) as { session_id: string }).session_id;
    const sent = await call("zcode_session_send", { workspace_id: "ws_eng", session_id: createdId, instruction: "do the thing" }, "client-A");
    assert.equal(sent.isError, undefined, sent.content.map((c) => c.text).join());
    const modelSwitch = await call("zcode_session_set_model", { workspace_id: "ws_eng", session_id: createdId, model: "GLM-5.3-Flash" }, "client-A");
    assert.equal(modelSwitch.isError, undefined);
  });

  it("agent_task_read and agent_output_read enforce the workspace boundary", async () => {
    const denied = await call("agent_task_read", { workspace_id: "ws_foreign", task_id: "c2c_xxxxxxxxx1" }, undefined);
    assert.equal(denied.isError, true);
    assert.ok(denied.content[0].text.startsWith("AGENT_PLANE_WORKSPACE_FORBIDDEN"));
    const deniedOutput = await call("agent_output_read", { workspace_id: "ws_foreign", output_id: 1 }, undefined);
    assert.equal(deniedOutput.isError, true);
    assert.ok(deniedOutput.content[0].text.startsWith("AGENT_PLANE_WORKSPACE_FORBIDDEN"));
  });

  it("activity feed records discovery and creation without message content", async () => {
    const activity = await call("agent_activity_list", { provider: "zcode", limit: 50 }, undefined);
    assert.equal(activity.isError, undefined);
    const body = JSON.stringify(dataOf(activity));
    assert.ok(body.includes("session.discovered") || body.includes("session.created"));
    assert.ok(!body.includes("refactor the parser module"), "activity must not carry message bodies");
  });
});
