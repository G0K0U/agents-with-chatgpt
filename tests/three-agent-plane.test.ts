import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
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
import { a2cWorkspaceForZcodeGrant } from "../src/session-plane/adapters/zcode.js";
import { saveExecutionOutput } from "../src/execution/output.js";

/**
 * Focused verification for the formal three-Agent Session/Activity Plane:
 * 1. External ZCode observation (without caller ownership or A2C ownership).
 * 2. Mixed-agent aggregation (Codex, Gemini, ZCode) with exact provenance and bounded output references.
 * 3. Mutation rejection (cross-agent visibility is read-only; foreign and external mutation rejected).
 * 4. Ambiguous workspace/provenance fail-closed behavior.
 * 5. Semantic-tool regression protection for existing Z2C tools.
 */

const TEST_TOKEN = "z2cs_three_agent_test_token_0123456789";
const WS_ENG_PATH = "f:\workspaces\engineering-ai";
const WS_OTHER_PATH = "f:\workspaces\other-project";
const EXTERNAL_DESKTOP_ID = "sess_00000000-aaaa-bbbb-cccc-111111111111";
const LEGACY_DESKTOP_ID = "sess_00000000-aaaa-bbbb-cccc-222222222222";

const fakeState = {
  serverUrl: "",
  sessions: new Map<string, { workspace_id: string; model: string; thought: string }>(),
  nativeMessages: new Map<string, Array<Record<string, unknown>>>([
    [EXTERNAL_DESKTOP_ID, [
      { info: { role: "user" }, parts: [{ type: "text", text: "audit three-agent plane" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "all three agents projected cleanly" }] },
      { info: { role: "assistant" }, parts: [{ type: "thinking", text: "PRIVATE_THOUGHT_LEAK_TEST" }] },
    ]],
  ]),
  /** session_id → upstream coded error injected by zcode_session_observe. */
  observeErrors: new Map<string, string>(),
  discover: [
    {
      session_id: EXTERNAL_DESKTOP_ID,
      workspace_id: "ws_grant_eng",
      workspace_path: WS_ENG_PATH,
      status: "idle",
      title: "manual desktop session",
      updated_at: "2026-09-22T04:00:00.000Z",
      controlled_by_z2c: false,
      owner_client_id: null,
      access_mode: null,
      runtime_origin: "external",
    },
    {
      // Legacy session: discovery-listed but the runtime no longer considers
      // it live-readable (pre-restart app-server generation).
      session_id: LEGACY_DESKTOP_ID,
      workspace_id: "ws_grant_eng",
      workspace_path: WS_ENG_PATH,
      status: "idle",
      title: "pre-restart desktop session",
      updated_at: "2026-09-21T04:00:00.000Z",
      controlled_by_z2c: false,
      owner_client_id: null,
      access_mode: null,
      runtime_origin: "external",
    },
  ] as Array<Record<string, unknown>>,
};

function toolResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}
function upstreamError(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

let fakeHttp: import("node:http").Server | null = null;

async function startFakeService(): Promise<void> {
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
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          workspace_id: "ws_grant_eng",
          canonical_path: parsed.path,
          display_name: "test-grant",
          permissions: { read: true, write: true },
        }));
        return;
      }
      const mcp = new McpServer({ name: "z2c-service", version: "1" });
      mcp.registerTool("zcode_runtime_capabilities", { inputSchema: {} }, async () =>
        toolResult({ z2c_protocol_version: 1, provider: "zcode-official", provider_status: "healthy", zcode_runtime_version: "0.16.9" }));
      mcp.registerTool("zcode_workspace_list", { inputSchema: {} }, async () =>
        toolResult({ workspaces: [{ workspace_id: "ws_grant_eng", canonical_path: WS_ENG_PATH, permissions: { read: true, write: true } }] }));
      mcp.registerTool("zcode_session_create", {
        inputSchema: { workspace_id: z.string(), access: z.enum(["readonly", "write"]), model: z.string().optional(), thought_level: z.string().optional(), provider: z.string().optional() },
      }, async (args) => {
        const sid = `sess_${randomUUID()}`;
        fakeState.sessions.set(sid, { workspace_id: args.workspace_id, model: args.model ?? "GLM-5.3-Flash", thought: args.thought_level ?? "max" });
        return toolResult({
          session_id: sid,
          workspace_id: args.workspace_id,
          provider_id: "zai-api",
          model_id: args.model ?? "GLM-5.3-Flash",
          thought_level: args.thought_level ?? "max",
          collaboration_mode: "edit",
          plan_enabled: false,
          runtime_version: "0.16.9",
          binding_source: "official-session-read",
        });
      });
      mcp.registerTool("zcode_session_read", { inputSchema: { workspace_id: z.string(), session_id: z.string() } }, async (args) => {
        const s = fakeState.sessions.get(args.session_id);
        if (!s) return upstreamError("ZCODE_SESSION_UPSTREAM: session not found");
        return toolResult({
          session_id: args.session_id,
          workspace_id: args.workspace_id,
          provider_id: "zai-api",
          model_id: s.model,
          thought_level: s.thought,
          collaboration_mode: "edit",
          plan_enabled: false,
          runtime_version: "0.16.9",
          binding_source: "official-session-read",
        });
      });
      mcp.registerTool("zcode_session_send", {
        inputSchema: { workspace_id: z.string(), session_id: z.string(), instruction: z.string(), timeout_ms: z.number().optional() },
      }, async (args) => {
        const s = fakeState.sessions.get(args.session_id);
        if (!s) return upstreamError("ZCODE_SESSION_UPSTREAM: session not found");
        return toolResult({
          state: {
            session_id: args.session_id,
            workspace_id: args.workspace_id,
            provider_id: "zai-api",
            model_id: s.model,
            thought_level: s.thought,
            collaboration_mode: "edit",
            plan_enabled: false,
            runtime_version: "0.16.9",
            binding_source: "official-session-read",
          },
          output: "MUTATION_APPLIED_OUTPUT",
          turn: "completed",
        });
      });
      mcp.registerTool("zcode_session_set_model", {
        inputSchema: { workspace_id: z.string(), session_id: z.string(), model: z.string() },
      }, async (args) => {
        const s = fakeState.sessions.get(args.session_id);
        if (!s) return upstreamError("ZCODE_SESSION_UPSTREAM: session not found");
        s.model = args.model;
        return toolResult({ session_id: args.session_id, model_id: args.model });
      });
      mcp.registerTool("zcode_session_set_thought_level", {
        inputSchema: { workspace_id: z.string(), session_id: z.string(), thought_level: z.string() },
      }, async (args) => {
        const s = fakeState.sessions.get(args.session_id);
        if (!s) return upstreamError("ZCODE_SESSION_UPSTREAM: session not found");
        s.thought = args.thought_level;
        return toolResult({ session_id: args.session_id, thought_level: args.thought_level });
      });
      mcp.registerTool("zcode_session_discover", { inputSchema: { workspace_id: z.string().optional() } }, async () => {
        const createdEntries = [...fakeState.sessions.entries()].map(([sid, s]) => ({
          session_id: sid,
          workspace_id: s.workspace_id,
          workspace_path: WS_ENG_PATH,
          status: "idle",
          title: "created session",
          updated_at: new Date().toISOString(),
          controlled_by_z2c: true,
          owner_client_id: "local",
          access_mode: "write",
          runtime_origin: "z2c",
        }));
        return toolResult({ sessions: fakeState.discover.concat(createdEntries) });
      });
      mcp.registerTool("zcode_session_observe", { inputSchema: { workspace_id: z.string(), session_id: z.string() } }, async (args) => {
        const injected = fakeState.observeErrors.get(args.session_id);
        if (injected) return upstreamError(injected);
        return toolResult({
          session_id: args.session_id,
          workspace_id: args.workspace_id,
          provider_id: "zai-api",
          model_id: "GLM-5.3-Flash",
          thought_level: "high",
          collaboration_mode: "edit",
          plan_enabled: false,
          runtime_version: "0.16.9",
          binding_source: "official-session-read",
        });
      });
      mcp.registerTool("zcode_session_observe_messages", {
        inputSchema: { workspace_id: z.string(), session_id: z.string(), limit: z.number().optional() },
      }, async (args) => {
        const injected = fakeState.observeErrors.get(args.session_id);
        if (injected) return upstreamError(injected);
        const msgs = fakeState.nativeMessages.get(args.session_id) ?? [];
        return toolResult({ messages: msgs });
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
  fakeState.serverUrl = `http://127.0.0.1:${port}`;
  fakeHttp = httpServer;
}

const stateDir = mkdtempSync(join(tmpdir(), "three-agent-test-"));
const WORKSPACES = [
  { workspaceId: "ws_eng", canonicalPath: WS_ENG_PATH },
  { workspaceId: "ws_other", canonicalPath: WS_OTHER_PATH },
];

function writeTaskRecord(wsId: string, record: Record<string, unknown>): void {
  mkdirSync(join(stateDir, "tasks", wsId), { recursive: true });
  writeFileSync(join(stateDir, "tasks", wsId, `${record.taskId as string}.json`), JSON.stringify(record));
}

function authInfo(clientId?: string, authorizedIds = ["ws_eng"]) {
  if (!clientId) return undefined;
  return {
    clientId,
    scopes: ["execution.read", "execution.submit", "workspace.read"],
    extra: { authorizedWorkspaceIds: authorizedIds },
  };
}

const harness: { server?: McpServer } = {};

function callTool(name: string, args: unknown, auth?: ReturnType<typeof authInfo>): Promise<{ isError?: boolean; content: { text: string }[] }> {
  const servers = harness.server as unknown as { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> };
  const tool = servers._registeredTools[name];
  assert.ok(tool, `tool ${name} missing`);
  return tool.handler(args, { authInfo: auth }) as Promise<{ isError?: boolean; content: { text: string }[] }>;
}

function dataOf(res: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(res.content.map((c) => c.text).join("\n"));
}

describe("Three-Agent Session/Activity Plane", () => {
  beforeAll(async () => {
    await startFakeService();
    process.env.ZCODE_SESSION_URL = `${fakeState.serverUrl}/mcp`;
    process.env.ZCODE_SESSION_TOKEN = TEST_TOKEN;
    process.env.ZCODE_SESSION_SECURITY_FILE = join(stateDir, "nonexistent.json");
    resetZcodeSessionClientForTests();
    resetZcodeSessionOwnershipForTests();
    resetAgentPlaneForTests();

    // Populate durable task records for ChatGPT/Codex and Gemini/Antigravity
    writeTaskRecord("ws_eng", {
      taskId: "c2c_codex_task_01",
      workspaceId: "ws_eng",
      ownerId: "client-chatgpt",
      sessionId: "c2cs_codex_session_01",
      instruction: "implement session normalization",
      provider: "codex",
      providerModel: "gpt-6-astra",
      threadId: "thread_codex_789",
      status: "completed",
      submittedAt: "2026-09-22T03:30:00.000Z",
      completedAt: "2026-09-22T03:32:00.000Z",
      changedFiles: ["src/session-plane/types.ts"],
      outputIds: [101],
      outputAvailable: true,
      actionEvidence: { turnCompleted: true, changedFiles: 1, finalOutputCaptured: true },
      verification: { status: "passed", exitCode: 0, completedAt: "2026-09-22T03:32:15.000Z", outputId: 102 },
    });
    saveExecutionOutput("ws_eng", { command: "codex:final", raw: "SESSION NORMALIZATION ACCOMPLISHED", taskId: "c2c_codex_task_01", sessionId: "c2cs_codex_session_01" }, stateDir);

    writeTaskRecord("ws_eng", {
      taskId: "c2c_gemini_task_01",
      workspaceId: "ws_eng",
      ownerId: "client-gemini",
      sessionId: "c2cs_gemini_session_01",
      instruction: "verify antigravity plane alignment",
      provider: "gemini",
      providerModel: "gemini-3.8-flash-high",
      providerSessionId: "conv_agy_9999",
      status: "completed",
      submittedAt: "2026-09-22T03:35:00.000Z",
      completedAt: "2026-09-22T03:36:00.000Z",
      changedFiles: ["src/session-plane/plane.ts"],
      outputIds: [103],
      outputAvailable: true,
      actionEvidence: { turnCompleted: true, changedFiles: 1, finalOutputCaptured: true },
      verification: { status: "passed", exitCode: 0, completedAt: "2026-09-22T03:36:20.000Z", outputId: 104 },
    });
    saveExecutionOutput("ws_eng", { command: "gemini:final", raw: "ANTIGRAVITY ALIGNED WITH SHARED PLANE", taskId: "c2c_gemini_task_01", sessionId: "c2cs_gemini_session_01" }, stateDir);

    const server = new McpServer({ name: "a2c-three-agent", version: "0.2.0" });
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
        if (requestedId === "ws_eng") return { root: WS_ENG_PATH };
        if (requestedId === "ws_other") return { root: WS_OTHER_PATH };
        throw Object.assign(new Error("workspace forbidden"), { code: "WORKSPACE_NOT_AUTHORIZED" });
      },
      visibleWorkspaces: (auth) => {
        if (!auth) return WORKSPACES;
        const allowed = (auth as { extra?: { authorizedWorkspaceIds?: string[] } }).extra?.authorizedWorkspaceIds ?? [];
        return WORKSPACES.filter((w) => allowed.includes(w.workspaceId));
      },
      stateDir,
    });

    registerAgentPlaneTools(server, {
      ...common,
      visibleWorkspaces: (auth) => {
        if (!auth) return WORKSPACES;
        const allowed = (auth as { extra?: { authorizedWorkspaceIds?: string[] } }).extra?.authorizedWorkspaceIds ?? [];
        return WORKSPACES.filter((w) => allowed.includes(w.workspaceId));
      },
      stateDir,
    });

    harness.server = server;
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
    rmSync(stateDir, { recursive: true, force: true });
  });

  // ── Acceptance 1 & 2: External/Manual ZCode observation without ownership ──
  it("external/manual authorized ZCode session is observable without becoming A2C-owned", async () => {
    // 1. Discover via agent_session_list
    const listRes = await callTool("agent_session_list", { provider: "zcode" }, authInfo("client-observer", ["ws_eng"]));
    assert.equal(listRes.isError, undefined);
    const listData = dataOf(listRes) as { sessions: Array<{ session_id: string; origin: string; owner_client_id: string | null; controllers: string[] }> };
    const desktopSession = listData.sessions.find((s) => s.session_id === EXTERNAL_DESKTOP_ID);
    assert.ok(desktopSession, "external session must be listed");
    assert.equal(desktopSession!.origin, "desktop");
    assert.equal(desktopSession!.owner_client_id, null, "external session must not have A2C owner");
    assert.deepEqual(desktopSession!.controllers, ["local"], "controllers must remain local-only");

    // 2. Read session state via agent_session_read
    const readRes = await callTool("agent_session_read", { session_id: EXTERNAL_DESKTOP_ID }, authInfo("client-observer", ["ws_eng"]));
    assert.equal(readRes.isError, undefined);
    const readData = dataOf(readRes) as { session_id: string; caller_can_control: boolean; origin: string };
    assert.equal(readData.session_id, EXTERNAL_DESKTOP_ID);
    assert.equal(readData.caller_can_control, false, "observer cannot control external session");
    assert.equal(readData.origin, "desktop");

    // 3. Read session visible messages via agent_session_messages (sanitized, no CoT)
    const msgRes = await callTool("agent_session_messages", { session_id: EXTERNAL_DESKTOP_ID }, authInfo("client-observer", ["ws_eng"]));
    assert.equal(msgRes.isError, undefined);
    const msgData = dataOf(msgRes) as { messages: Array<{ role: string; text: string }> };
    assert.ok(msgData.messages.some((m) => m.role === "user" && m.text.includes("audit three-agent plane")));
    assert.ok(msgData.messages.some((m) => m.role === "assistant" && m.text.includes("all three agents projected cleanly")));
    const jsonStr = JSON.stringify(msgData);
    assert.ok(!jsonStr.includes("PRIVATE_THOUGHT_LEAK_TEST"), "hidden reasoning must never leak");
    assert.ok(!jsonStr.includes("thinking"), "thinking role must never appear in visible messages");
  });

  // ── Acceptance: legacy (pre-restart) ZCode sessions read coherently ──
  it("projects a discovery-listed legacy session as stale-runtime, and lane failures as errors — never as fake health", async () => {
    // Legacy session: discovery-listed, but the runtime answers every exact
    // read with the session-level "not associated" denial.
    fakeState.observeErrors.set(LEGACY_DESKTOP_ID,
      "SESSION_NOT_FOUND: session sess_00000000… is not associated with this workspace");
    try {
      const readRes = await callTool("agent_session_read", { session_id: LEGACY_DESKTOP_ID }, authInfo("client-observer", ["ws_eng"]));
      assert.equal(readRes.isError, undefined, readRes.content.map((c) => c.text).join());
      const readData = dataOf(readRes) as { live_read_status?: string; last_live_error?: string | null };
      assert.equal(readData.live_read_status, "stale-runtime", "legacy session must read as stale-runtime, not error");
      assert.ok(readData.last_live_error?.includes("not live-readable"), readData.last_live_error ?? "");

      const msgRes = await callTool("agent_session_messages", { session_id: LEGACY_DESKTOP_ID }, authInfo("client-observer", ["ws_eng"]));
      assert.equal(msgRes.isError, undefined);
      const msgData = dataOf(msgRes) as { live_read_status?: string; messages_readable?: boolean; messages: unknown[] };
      assert.equal(msgData.live_read_status, "stale-runtime");
      assert.equal(msgData.messages_readable, false);
      assert.deepEqual(msgData.messages, []);

      // Lane-level failure (z2c observation surface temporarily unavailable):
      // stays a plain error so a downed lane is never mistaken for a legacy session.
      fakeState.observeErrors.set(EXTERNAL_DESKTOP_ID,
        "SESSION_READ_UNAVAILABLE: session state read is temporarily unavailable (lane failure, not a session answer)");
      const laneRes = await callTool("agent_session_read", { session_id: EXTERNAL_DESKTOP_ID }, authInfo("client-observer", ["ws_eng"]));
      assert.equal(laneRes.isError, undefined);
      const laneData = dataOf(laneRes) as { live_read_status?: string };
      assert.equal(laneData.live_read_status, "error", "lane failures must stay errors");
    } finally {
      fakeState.observeErrors.delete(LEGACY_DESKTOP_ID);
      fakeState.observeErrors.delete(EXTERNAL_DESKTOP_ID);
    }
  });

  // ── Acceptance 1 & 5: Mixed-agent aggregation across Codex, Gemini, ZCode ──
  it("normalizes visibility across Codex, Gemini, and ZCode in a single projection", async () => {
    // 1. Shared session list includes all three providers
    const listRes = await callTool("agent_session_list", {}, authInfo(undefined));
    assert.equal(listRes.isError, undefined);
    const sessions = (dataOf(listRes) as { sessions: Array<{ session_id: string; provider: string; workspace_id: string }> }).sessions;
    const providers = new Set(sessions.map((s) => s.provider));
    assert.ok(providers.has("codex"), "Codex must appear in normalized session projection");
    assert.ok(providers.has("gemini"), "Gemini must appear in normalized session projection");
    assert.ok(providers.has("zcode"), "ZCode must appear in normalized session projection");

    // Verify Codex session
    const codex = sessions.find((s) => s.provider === "codex");
    assert.ok(codex);
    assert.equal(codex!.workspace_id, "ws_eng");

    // Verify Gemini session
    const gemini = sessions.find((s) => s.provider === "gemini");
    assert.ok(gemini);
    assert.equal(gemini!.workspace_id, "ws_eng");

    // 2. Cross-provider activity feed retains exact provenance and bounded output references
    const actRes = await callTool("agent_activity_list", { limit: 50 }, authInfo(undefined));
    assert.equal(actRes.isError, undefined);
    const events = (dataOf(actRes) as { events: Array<{ provider: string; workspace_id: string; output_ref?: { workspaceId: string; outputId: number } | null }> }).events;
    const actProviders = new Set(events.map((e) => e.provider));
    assert.ok(actProviders.has("codex"), "Codex activity present");
    assert.ok(actProviders.has("gemini"), "Gemini activity present");
    assert.ok(actProviders.has("zcode"), "ZCode activity present");

    // Check bounded output reference in task activity
    const codexCompleted = events.find((e) => e.provider === "codex" && e.output_ref);
    assert.ok(codexCompleted, "Codex task completion activity carries output reference");
    assert.deepEqual(codexCompleted!.output_ref, { workspaceId: "ws_eng", outputId: 101 });
  });

  // ── Acceptance 3: Unauthorized mutation of another client's or external session rejected ──
  it("rejects unauthorized mutation attempts with strict fail-closed denials and no oracle", async () => {
    // 1. Attempt to mutate external desktop session via zcode_session_send
    const sendDesktop = await callTool("zcode_session_send", {
      workspace_id: "ws_eng",
      session_id: EXTERNAL_DESKTOP_ID,
      instruction: "hijack desktop session",
    }, authInfo("client-attacker", ["ws_eng"]));
    assert.equal(sendDesktop.isError, true);
    assert.ok(sendDesktop.content[0].text.startsWith("ZCODE_SESSION_NOT_OWNED"));

    // 2. Create a session owned by client-A
    const createRes = await callTool("zcode_session_create", {
      workspace_id: "ws_eng",
      access: "write",
      model: "GLM-5.3-Flash",
    }, authInfo("client-A", ["ws_eng"]));
    assert.equal(createRes.isError, undefined);
    const ownedId = (dataOf(createRes) as { session_id: string }).session_id;

    // 3. Client-B attempts to mutate client-A's session via send
    const sendOther = await callTool("zcode_session_send", {
      workspace_id: "ws_eng",
      session_id: ownedId,
      instruction: "unauthorized injection",
    }, authInfo("client-B", ["ws_eng"]));
    assert.equal(sendOther.isError, true);
    assert.ok(sendOther.content[0].text.startsWith("ZCODE_SESSION_NOT_OWNED"));

    // 4. Client-B attempts to mutate model
    const setModelOther = await callTool("zcode_session_set_model", {
      workspace_id: "ws_eng",
      session_id: ownedId,
      model: "GLM-5.3-Flash",
    }, authInfo("client-B", ["ws_eng"]));
    assert.equal(setModelOther.isError, true);
    assert.ok(setModelOther.content[0].text.startsWith("ZCODE_SESSION_NOT_OWNED"));

    // 5. Client-B attempts to mutate thought level
    const setThoughtOther = await callTool("zcode_session_set_thought_level", {
      workspace_id: "ws_eng",
      session_id: ownedId,
      thought_level: "low",
    }, authInfo("client-B", ["ws_eng"]));
    assert.equal(setThoughtOther.isError, true);
    assert.ok(setThoughtOther.content[0].text.startsWith("ZCODE_SESSION_NOT_OWNED"));

    // 6. Non-existent session denial is identical to foreign session denial (no existence oracle)
    const oracleCheck = await callTool("zcode_session_send", {
      workspace_id: "ws_eng",
      session_id: "sess_nonexistent_00000000-1111-2222-333333333333",
      instruction: "probe",
    }, authInfo("client-B", ["ws_eng"]));
    assert.equal(oracleCheck.isError, true);
    assert.equal(
      sendOther.content[0].text.split(":")[0],
      oracleCheck.content[0].text.split(":")[0],
      "foreign and non-existent denials must have identical error code",
    );
  });

  // ── Acceptance 4: Ambiguous workspace/provenance fails closed ──
  it("fails closed on ambiguous workspace mapping and ambiguous activity events", async () => {
    // 1. Ambiguous parent grant path encompassing multiple distinct sibling workspaces
    const workspaces = [
      { workspaceId: "ws_a", canonicalPath: "f:\\projects\\alpha" },
      { workspaceId: "ws_b", canonicalPath: "f:\\projects\\beta" },
    ];
    // A grant pointing to "f:\projects" has 2 children with different workspace IDs
    const parentGrant = a2cWorkspaceForZcodeGrant("f:\\projects", workspaces);
    assert.equal(parentGrant, null, "ambiguous parent grant must fail closed to null");

    // 2. Ambiguous exact-length ties with different workspace IDs
    const tiedWorkspaces = [
      { workspaceId: "ws_1", canonicalPath: "f:\\data\\workspace" },
      { workspaceId: "ws_2", canonicalPath: "f:\\data\\workspace" },
    ];
    const tiedGrant = a2cWorkspaceForZcodeGrant("f:\\data\\workspace", tiedWorkspaces);
    assert.equal(tiedGrant, null, "ambiguous tied mappings must fail closed to null");

    // 3. Foreign workspace observation denial
    const foreignTask = await callTool("agent_task_read", {
      workspace_id: "ws_forbidden_999",
      task_id: "c2c_codex_task_01",
    }, authInfo("client-scoped", ["ws_eng"]));
    assert.equal(foreignTask.isError, true);
    assert.ok(foreignTask.content[0].text.startsWith("AGENT_PLANE_WORKSPACE_FORBIDDEN"));

    // 4. Activity events with null workspaceId are filtered for scoped OAuth clients
    const scopedActivity = await callTool("agent_activity_list", {}, authInfo("client-scoped", ["ws_eng"]));
    assert.equal(scopedActivity.isError, undefined);
    const scopedEvents = (dataOf(scopedActivity) as { events: Array<{ workspace_id: string | null }> }).events;
    assert.ok(scopedEvents.every((e) => e.workspace_id !== null), "scoped callers must never receive null workspace events");
  });

  // ── Acceptance 5: Semantic-tool regression protection ──
  it("preserves existing Z2C semantic tools for authorized owner and local operator", async () => {
    // 1. zcode_runtime_capabilities
    const caps = await callTool("zcode_runtime_capabilities", {}, authInfo("client-A", ["ws_eng"]));
    assert.equal(caps.isError, undefined);
    const capsData = dataOf(caps);
    assert.equal(capsData.z2c_protocol_version, 1);
    assert.equal(capsData.provider_status, "healthy");

    // 2. zcode_workspace_list
    const wsList = await callTool("zcode_workspace_list", {}, authInfo("client-A", ["ws_eng"]));
    assert.equal(wsList.isError, undefined);
    const wsData = dataOf(wsList) as { workspaces: Array<{ workspace_id: string; a2c_workspace_id: string }> };
    assert.ok(wsData.workspaces.some((w) => w.a2c_workspace_id === "ws_eng"));

    // 3. zcode_session_create for client-A
    const createRes = await callTool("zcode_session_create", {
      workspace_id: "ws_eng",
      access: "write",
      model: "GLM-5.3-Flash",
      thought_level: "max",
    }, authInfo("client-A", ["ws_eng"]));
    assert.equal(createRes.isError, undefined);
    const sid = (dataOf(createRes) as { session_id: string }).session_id;

    // 4. zcode_session_read by owner
    const readRes = await callTool("zcode_session_read", {
      workspace_id: "ws_eng",
      session_id: sid,
    }, authInfo("client-A", ["ws_eng"]));
    assert.equal(readRes.isError, undefined);
    assert.equal((dataOf(readRes) as { session_id: string }).session_id, sid);

    // 5. zcode_session_send by owner
    const sendRes = await callTool("zcode_session_send", {
      workspace_id: "ws_eng",
      session_id: sid,
      instruction: "legitimate owner instruction",
    }, authInfo("client-A", ["ws_eng"]));
    assert.equal(sendRes.isError, undefined);
    assert.equal((dataOf(sendRes) as { output: string }).output, "MUTATION_APPLIED_OUTPUT");

    // 6. zcode_session_set_model by owner
    const modelRes = await callTool("zcode_session_set_model", {
      workspace_id: "ws_eng",
      session_id: sid,
      model: "GLM-5.3-Flash",
    }, authInfo("client-A", ["ws_eng"]));
    assert.equal(modelRes.isError, undefined);

    // 7. zcode_session_set_thought_level by owner
    const thoughtRes = await callTool("zcode_session_set_thought_level", {
      workspace_id: "ws_eng",
      session_id: sid,
      thought_level: "high",
    }, authInfo("client-A", ["ws_eng"]));
    assert.equal(thoughtRes.isError, undefined);

    // 8. Local operator can also read and control
    const localRead = await callTool("zcode_session_read", {
      workspace_id: "ws_eng",
      session_id: sid,
    }, authInfo(undefined));
    assert.equal(localRead.isError, undefined);

    const localSend = await callTool("zcode_session_send", {
      workspace_id: "ws_eng",
      session_id: sid,
      instruction: "operator command",
    }, authInfo(undefined));
    assert.equal(localSend.isError, undefined);
  });
});
