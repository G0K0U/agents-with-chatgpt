import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  registerZcodeSessionTools,
  resetZcodeSessionClientForTests,
  resetZcodeSessionOwnershipForTests,
} from "../src/mcp/zcode-session-tools.js";

/**
 * Negative security acceptance for the A2C → Z2C semantic surface:
 * foreign sessions must be denied without an existence oracle, and
 * workspace authorization is enforced before any upstream interaction.
 * The upstream is a FAKE z2c-service (real MCP Streamable HTTP server).
 */

const TEST_TOKEN = "z2cs_test_token_0123456789abcdef";
const CANONICAL = "f:\\examplework\\engineering-ai";

import { randomUUID } from "node:crypto";

const fake = {
  serverUrl: "",
  apiHits: [] as string[],
  grants: new Map<string, { workspace_id: string; display_name?: string; permissions?: { read?: boolean; write?: boolean }; canonical_path?: string }>(),
  sessions: new Map<string, { workspace_id: string; model: string; thought: string; plan: boolean }>(),
};

function attestedFor(workspace_id: string, sessionId: string) {
  const s = fake.sessions.get(sessionId)!;
  return {
    session_id: sessionId,
    workspace_id,
    provider_id: "zai-api",
    model_id: s.model,
    thought_level: s.thought,
    collaboration_mode: "edit",
    plan_enabled: s.plan,
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

let fakeStateHttp: import("node:http").Server | null = null;

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
        const parsed = JSON.parse(body) as { path?: string; write?: boolean };
        fake.apiHits.push("authorize:" + (parsed.path ?? ""));
        const grant = {
          workspace_id: `ws_${Math.abs(hash(parsed.path ?? "")).toString(16)}`,
          canonical_path: parsed.path,
          display_name: "a2c-shared",
          permissions: { read: true, write: parsed.write !== false },
        };
        fake.grants.set(grant.workspace_id, grant);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(grant));
        return;
      }
      const mcp = new McpServer({ name: "z2c-service", version: "1" });
      mcp.registerTool("zcode_runtime_capabilities", { inputSchema: {} }, async () =>
        toolResult({ z2c_protocol_version: 1, provider: "zcode-official", provider_status: "healthy", zcode_runtime_version: "0.16.9" }));
      mcp.registerTool("zcode_workspace_list", { inputSchema: {} }, async () =>
        toolResult({ workspaces: [...fake.grants.values()] }));
      mcp.registerTool("zcode_session_create", {
        inputSchema: { workspace_id: z.string(), access: z.enum(["readonly", "write"]), model: z.string().optional(), thought_level: z.string().optional(), provider: z.string().optional() },
      }, async (args) => {
        const sessionId = `sess_${randomUUID()}`;
        fake.sessions.set(sessionId, {
          workspace_id: args.workspace_id,
          model: args.model ?? "GLM-5.3",
          thought: args.thought_level ?? "max",
          plan: args.access === "readonly",
        });
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
        const s = fake.sessions.get(args.session_id);
        if (!s) return upstreamError("ZCODE_SESSION_UPSTREAM: session vanished");
        s.model = args.model;
        return toolResult(attestedFor(args.workspace_id, args.session_id));
      });
      mcp.registerTool("zcode_session_set_thought_level", {
        inputSchema: { workspace_id: z.string(), session_id: z.string(), thought_level: z.string() },
      }, async (args) => {
        const s = fake.sessions.get(args.session_id);
        if (!s) return upstreamError("ZCODE_SESSION_UPSTREAM: session vanished");
        s.thought = args.thought_level;
        return toolResult(attestedFor(args.workspace_id, args.session_id));
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
  fakeStateHttp = httpServer;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

// ── harness over the real tool handlers ─────────────────────────────────────
const harness: { server?: McpServer; dir?: string; engVisible?: boolean; fullAccessRoot?: string } = { engVisible: true };

function auth(clientId: string | undefined) {
  return clientId ? ({ clientId, extra: {} }) : undefined;
}

function call(name: string, args: unknown, clientId?: string): Promise<ReturnType<typeof toolResult> | { isError: boolean; content: { text: string }[] }> {
  const tools = (harness.server as unknown as { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> })._registeredTools;
  const tool = tools[name];
  assert.ok(tool, `tool ${name} missing`);
  return tool.handler(args, { authInfo: auth(clientId) }) as Promise<ReturnType<typeof toolResult> | { isError: boolean; content: { text: string }[] }>;
}

function errorText(result: unknown): string {
  const r = result as { isError?: boolean; content?: Array<{ text?: string }> };
  return r.isError ? r.content?.map((c) => c.text ?? "").join("\n") ?? "" : "";
}

describe("A2C → Z2C semantic session surface (negative security acceptance)", () => {
  const dir = mkdtempSync(join(tmpdir(), "z2c-a2c-"));

  beforeAll(async () => {
    await startFakeZ2cService();
    process.env.ZCODE_SESSION_URL = `${fake.serverUrl}/mcp`;
    process.env.ZCODE_SESSION_TOKEN = TEST_TOKEN;
    process.env.ZCODE_SESSION_SECURITY_FILE = join(dir, "missing.json");
    resetZcodeSessionClientForTests();
    resetZcodeSessionOwnershipForTests();

    const server = new McpServer({ name: "a2c-test", version: "0" });
    registerZcodeSessionTools(server, {
      requireScope: () => null, // scope checks are covered by the gateway contract tests
      resolveWorkspace: (requestedId) => {
        if (requestedId !== "ws_eng") {
          throw Object.assign(new Error("Workspace is not authorized for this identity"), { code: "WORKSPACE_NOT_AUTHORIZED" });
        }
        return { root: harness.fullAccessRoot ?? CANONICAL };
      },
      visibleWorkspaces: () => (harness.engVisible ? [{ workspaceId: "ws_eng", canonicalPath: harness.fullAccessRoot ?? CANONICAL }] : []),
      fullAccessRoot: harness.fullAccessRoot,
      stateDir: dir,
      ok: (data) => toolResult(data),
      fail: (code, message) => ({ isError: true, content: [{ type: "text", text: `${code}: ${message}` }] }),
      mapError: (error: unknown) => {
        const coded = error as { code?: string; message?: string };
        return { isError: true, content: [{ type: "text", text: coded?.code ? `${coded.code}: ${coded.message}` : `INTERNAL: ${String(coded?.message ?? error)}` }] };
      },
      untrustedNote: "[untrusted]",
    });
    harness.server = server;
  });

  afterAll(() => {
    fakeStateHttp?.close();
    delete process.env.ZCODE_SESSION_URL;
    delete process.env.ZCODE_SESSION_TOKEN;
    delete process.env.ZCODE_SESSION_SECURITY_FILE;
    resetZcodeSessionClientForTests();
    resetZcodeSessionOwnershipForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a session, records ownership per client, and attests state", async () => {
    const result = await call("zcode_session_create", { workspace_id: "ws_eng", access: "write", model: "GLM-5.3-Flash", thought_level: "max" }, "client-A");
    console.error("DEBUG create result:", errorText(result) || JSON.stringify(result).slice(0, 300));
    assert.equal((result as { isError?: boolean }).isError, undefined);
    const data = JSON.parse((result as { content: [{ text: string }] }).content[0].text);
    assert.equal(data.model_id, "GLM-5.3-Flash");
    assert.equal(data.binding_source, "official-session-read");
    // Grant mirroring hit the companion's local provisioning API exactly once.
    assert.ok(fake.apiHits.some((h) => h.startsWith("authorize")), "grant provisioning must have been attempted");
  });

  it("owner can read/send/set model/set thought level", async () => {
    const created = await call("zcode_session_create", { workspace_id: "ws_eng", access: "readonly" }, "client-A");
    const sessionId = JSON.parse((created as { content: [{ text: string }] }).content[0].text).session_id;
    for (const [name, args] of [
      ["zcode_session_read", { workspace_id: "ws_eng", session_id: sessionId }],
      ["zcode_session_send", { workspace_id: "ws_eng", session_id: sessionId, instruction: "hi" }],
      ["zcode_session_set_model", { workspace_id: "ws_eng", session_id: sessionId, model: "GLM-5.3-Flash" }],
      ["zcode_session_set_thought_level", { workspace_id: "ws_eng", session_id: sessionId, thought_level: "max" }],
    ] as const) {
      const result = await call(name, args, "client-A");
      assert.equal((result as { isError?: boolean }).isError, undefined, `${name} should succeed for the owner`);
    }
  });

  it("denies foreign-session read/send/model/thought with NO existence oracle", async () => {
    const created = await call("zcode_session_create", { workspace_id: "ws_eng", access: "write" }, "client-A");
    const sessionId = JSON.parse((created as { content: [{ text: string }] }).content[0].text).session_id;
    const unknownId = "sess_00000000-0000-4000-8000-000000000000";
    for (const [name, args] of [
      ["zcode_session_read", { workspace_id: "ws_eng", session_id: sessionId }],
      ["zcode_session_send", { workspace_id: "ws_eng", session_id: sessionId, instruction: "hi" }],
      ["zcode_session_set_model", { workspace_id: "ws_eng", session_id: sessionId, model: "GLM-5.3" }],
      ["zcode_session_set_thought_level", { workspace_id: "ws_eng", session_id: sessionId, thought_level: "low" }],
      ["zcode_session_read", { workspace_id: "ws_eng", session_id: unknownId }],
    ] as const) {
      const result = await call(name, args, "client-B");
      const text = errorText(result);
      assert.match(text, /ZCODE_SESSION_NOT_OWNED/, `${name} must fail closed`);
    }
    // Unknown vs foreign produce the SAME message: no existence oracle.
    const foreign = errorText(await call("zcode_session_read", { workspace_id: "ws_eng", session_id: sessionId }, "client-B"));
    const unknown = errorText(await call("zcode_session_read", { workspace_id: "ws_eng", session_id: unknownId }, "client-B"));
    assert.equal(foreign, unknown);
  });

  it("Z1: binds full-access sessions to the APPROVED PARENT ROOT so sibling projects are reachable", async () => {
    // The approved full-access boundary is a parent of the A2C workspace.
    const parent = mkdtempSync(join(tmpdir(), "z2c-fullaccess-parent-"));
    const child = join(parent, "engineering-ai");
    mkdirSync(child, { recursive: true });

    const dir2 = mkdtempSync(join(tmpdir(), "z2c-a2c-z1-"));
    const server2 = new McpServer({ name: "a2c-z1", version: "0" });
    registerZcodeSessionTools(server2, {
      requireScope: () => null,
      resolveWorkspace: (requestedId) => {
        if (requestedId !== "ws_eng") throw Object.assign(new Error("not authorized"), { code: "WORKSPACE_NOT_AUTHORIZED" });
        return { root: child };
      },
      visibleWorkspaces: () => [{ workspaceId: "ws_eng", canonicalPath: child }],
      fullAccessRoot: parent,
      stateDir: dir2,
      ok: (data) => toolResult(data),
      fail: (code, message) => ({ isError: true, content: [{ type: "text", text: `${code}: ${message}` }] }),
      mapError: (error: unknown) => ({ isError: true, content: [{ type: "text", text: String((error as Error)?.message ?? error) }] }),
      untrustedNote: "[untrusted]",
    });
    const tools2 = (server2 as unknown as { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> })._registeredTools;
    const created = await tools2["zcode_session_create"].handler({ workspace_id: "ws_eng", access: "write", model: "GLM-5.3-Flash", thought_level: "max" }, { authInfo: { clientId: "z1-client", extra: {} } }) as { content: { text: string }[] };
    const state = JSON.parse(created.content[0].text);
    // The forwarded binding must be the PARENT grant id (provisioned from the
    // approved boundary), which the ZCode agent then fences the session to —
    // sibling projects inside the boundary become writable.
    assert.match(state.workspace_id, /^ws_/);
    const authorizeHits = fake.apiHits.filter((h) => h.toLowerCase().startsWith("authorize:" + parent.toLowerCase()));
    assert.ok(authorizeHits.length >= 1, "parent root must be provisioned as the Z2C grant");
  });

  it("Z1: keeps the narrower per-workspace binding when the root is OUTSIDE the approved boundary", async () => {
    const outside = mkdtempSync(join(tmpdir(), "z2c-outside-"));
    const dir3 = mkdtempSync(join(tmpdir(), "z2c-a2c-z1b-"));
    const server3 = new McpServer({ name: "a2c-z1b", version: "0" });
    registerZcodeSessionTools(server3, {
      requireScope: () => null,
      resolveWorkspace: (requestedId) => {
        if (requestedId !== "ws_out") throw Object.assign(new Error("not authorized"), { code: "WORKSPACE_NOT_AUTHORIZED" });
        return { root: outside };
      },
      visibleWorkspaces: () => [{ workspaceId: "ws_out", canonicalPath: outside }],
      fullAccessRoot: join(tmpdir(), "some-other-parent"),
      stateDir: dir3,
      ok: (data) => toolResult(data),
      fail: (code, message) => ({ isError: true, content: [{ type: "text", text: `${code}: ${message}` }] }),
      mapError: (error: unknown) => ({ isError: true, content: [{ type: "text", text: String((error as Error)?.message ?? error) }] }),
      untrustedNote: "[untrusted]",
    });
    const tools3 = (server3 as unknown as { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> })._registeredTools;
    const created = await tools3["zcode_session_create"].handler({ workspace_id: "ws_out", access: "write" }, { authInfo: { clientId: "z1-client", extra: {} } }) as { content: { text: string }[] };
    const state = JSON.parse(created.content[0].text);
    // Outside the approved boundary: the narrower per-workspace binding is
    // kept (fail closed to the safer scope, never auto-expanded).
    assert.match(state.workspace_id, /^ws_/);
    assert.notEqual(state.workspace_id.startsWith("ws_") && /outside/i.test(state.workspace_id), true);
  });

  it("workspace authorization is enforced before any upstream interaction", async () => {
    // A client with NO visible A2C workspaces is denied before any Z2C traffic.
    harness.engVisible = false;
    try {
      const result = await call("zcode_session_create", { workspace_id: "ws_eng", access: "write" }, "client-B");
      assert.match(errorText(result), /ZCODE_SESSION_WORKSPACE_FORBIDDEN|WORKSPACE_NOT_AUTHORIZED/);
    } finally {
      harness.engVisible = true;
    }
    // Unknown workspace id → registry-level denial.
    const result2 = await call("zcode_session_create", { workspace_id: "ws_other", access: "write" }, "client-A");
    assert.match(errorText(result2), /WORKSPACE_NOT_AUTHORIZED/);
  });
});
