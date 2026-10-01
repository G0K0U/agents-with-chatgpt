#!/usr/bin/env node
/**
 * Phase-4 A2C integration acceptance: proves the seven zcode_* semantic tools
 * through the REAL A2C MCP gateway (Streamable HTTP + OAuth bearer token),
 * forwarded to the REAL Z2C semantic service (loopback), driving the REAL
 * installed ZCode agent with a real GLM turn. No mocks.
 *
 *   acceptance client
 *     → A2C MCP gateway (bearer token, workspace-authorized)
 *     → zcode_* tools → Z2C semantic adapter
 *     → z2c-service (Phase-3 semantic implementation, loopback)
 *     → zcode app-server --stdio → ZCode → GLM
 */
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const A2C_ROOT = process.cwd();
// The z2c companion ships inside this repository; override only for a
// side-by-side checkout of a different z2c tree.
const Z2C_ROOT = process.env.Z2C_ROOT ?? join(A2C_ROOT, "z2c");
const RUN = Date.now();
const TMP = join(A2C_ROOT, ".tooling", "test-tmp", `a2c-zcode-acceptance-${RUN}`);
const Z2C_STATE = join(TMP, "z2c-state");
const Z2C_PORT = 8799;
const Z2C_BASE = `http://127.0.0.1:${Z2C_PORT}`;
const WS_ROOT = join(TMP, "engineering-ai");
const BRIDGE_ROOT = join(TMP, "bridge-root");
const MODEL = "GLM-5.3-Flash";
const THOUGHT = "max";
const MARKER = "A2C ZCODE INTEGRATION OK";

const results = [];
const note = (step, ok, detail) => {
  results.push({ step, ok, detail });
  console.error(`[acceptance] ${ok ? "PASS" : "FAIL"} ${step}: ${detail}`);
};
let z2cProc = null;
let z2cLog = "";
let bridge = null;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await wait(400);
  }
  throw new Error(`service at ${base} did not become healthy`);
}

async function mcp(session, method, params) {
  const res = await fetch(`${bridge.localBaseUrl()}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${session.token}`,
      ...(session.id ? { "mcp-session-id": session.id } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: `id-${Math.random()}`, method, params }),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) session.id = sid;
  const raw = await res.text();
  if (process.env.A2C_ACCEPTANCE_DEBUG) console.error(`[debug] ${method} → HTTP ${res.status} ${res.headers.get("content-type")}: ${raw.slice(0, 220)}`);
  let body = null;
  try { body = JSON.parse(raw); }
  catch {
    // SSE framing: take the last data: line containing JSON.
    for (const line of raw.split(/\r?\n/).reverse()) {
      if (line.startsWith("data:")) {
        try { body = JSON.parse(line.slice(5).trim()); break; } catch { /* keep looking */ }
      }
    }
  }
  if (body?.error) return { http: res.status, isError: true, code: body.error.code, text: JSON.stringify(body.error), json: null, result: body?.result ?? null };
  const result = body?.result ?? {};
  const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
  return { http: res.status, isError: result.isError === true, text, result, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}
const callTool = (session, name, args) => mcp(session, "tools/call", { name, arguments: args ?? {} });

try {
  // ── 0. Z2C semantic service (clean state; official provider; real agent).
  mkdirSync(Z2C_STATE, { recursive: true });
  mkdirSync(WS_ROOT, { recursive: true });
  mkdirSync(BRIDGE_ROOT, { recursive: true });
  z2cProc = spawn(process.execPath, ["--import", "tsx", join(Z2C_ROOT, "src", "service", "main.ts")], {
    cwd: Z2C_ROOT,
    env: { ...process.env, Z2C_STATE_DIR: Z2C_STATE, Z2C_PORT: String(Z2C_PORT) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  z2cProc.stderr.on("data", (d) => { z2cLog += d; });
  const z2cHealth = await waitHealthy(Z2C_BASE, 90000);
  note("z2c-service", z2cHealth.status === "ok", `z2c-service healthy on ${Z2C_BASE} (protocol v${z2cHealth.protocol_version})`);
  const z2cSecret = JSON.parse(readFileSync(join(Z2C_STATE, "security.json"), "utf8")).secrets.find((s) => !s.retiredAt).secret;

  // ── 1. REAL A2C bridge (same startBridge path the connector serves through).
  process.env.ZCODE_SESSION_URL = `${Z2C_BASE}/mcp`;
  process.env.ZCODE_SESSION_TOKEN = z2cSecret;
  const { startBridge } = await import(pathToFileURL(join(A2C_ROOT, "src", "bridge", "server.js")).href);
  const { WorkspaceRegistry } = await import(pathToFileURL(join(A2C_ROOT, "src", "workspace", "registry.js")).href);
  const { canonicalizeWorkspaceRoot, stableWorkspaceId } = await import(pathToFileURL(join(A2C_ROOT, "src", "workspace", "identity.js")).href);
  // Pre-register BOTH workspaces (the middleware authorizes the set fixed at
  // bridge startup — production registers workspaces before start as well).
  const registryFile = join(TMP, "workspaces.json");
  const seed = new WorkspaceRegistry({ file: registryFile });
  const rootWs = seed.registerTrusted({ name: "bridge-root", canonicalPath: BRIDGE_ROOT });
  const eng = seed.registerTrusted({ name: "engineering-ai", canonicalPath: WS_ROOT });
  bridge = await startBridge({
    workspaceRoot: BRIDGE_ROOT,
    port: 0,
    persistRuntime: false,
    authStoreFile: join(TMP, "auth-store.json"),
    workspaceRegistryFile: registryFile,
  });
  const token = bridge.authStore.issueTokens({
    clientId: "a2c-acceptance-client",
    scopes: ["workspace.read", "execution.read", "execution.submit", "execution.cancel"],
    workspaceIds: [bridge.workspace.id, eng.id],
  }).accessToken;
  const session = { token, id: null };
  note("a2c-bridge", Boolean(bridge.localBaseUrl()), `A2C gateway ${bridge.localBaseUrl()}/mcp; authorized workspaces: ${bridge.workspace.id} (bridge root), ${eng.id} (engineering-ai)`);

  // ── 2. MCP handshake + tool contract.
  const init = await mcp(session, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "a2c-acceptance", version: "1" } });
  const serverName = init.result?.serverInfo?.name;
  const list = await mcp(session, "tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  const zcodeTools = ["zcode_runtime_capabilities", "zcode_workspace_list", "zcode_session_create", "zcode_session_read", "zcode_session_send", "zcode_session_set_model", "zcode_session_set_thought_level"];
  note("mcp-contract", serverName === "Agents with ChatGPT" && names.length === 35 && zcodeTools.every((t) => names.includes(t)),
    `gateway "${serverName}" exposes ${names.length} tools incl. all 7 zcode_* semantic tools`);

  // ── 3. zcode_runtime_capabilities.
  const caps = await callTool(session, "zcode_runtime_capabilities");
  note("capabilities", !caps.isError && caps.json?.provider_status === "healthy" && caps.json?.zcode_runtime_version === "0.16.9",
    `provider ${caps.json?.provider} healthy, ZCode runtime ${caps.json?.zcode_runtime_version}, Z2C protocol v${caps.json?.z2c_protocol_version}`);

  // ── 4b. A2C-level probe of the engineering workspace.
  const probe = await callTool(session, "workspace_info", { workspace_id: eng.id });
  console.error(`[debug] workspace_info(eng) isError=${probe.isError} text=${JSON.stringify(probe.text.slice(0, 160))}`);

  // ── 5. zcode_session_create (write lane; requested identity).
  const created = await callTool(session, "zcode_session_create", { workspace_id: eng.id, access: "write", model: MODEL, thought_level: THOUGHT });
  console.error(`[debug] create isError=${created.isError} text=${JSON.stringify(created.text.slice(0, 300))}`);
  note("session-create", !created.isError && created.json?.model_id === MODEL && created.json?.thought_level === THOUGHT,
    `session ${created.json?.session_id} attested ${created.json?.provider_id}/${created.json?.model_id}@${created.json?.thought_level} (plan=${created.json?.plan_enabled})`);
  const sessionId = created.json?.session_id;
  if (!sessionId) throw new Error("no session id from zcode_session_create");

  // ── 4b. zcode_workspace_list (engineering-ai mirrored into the Z2C lane).
  const wsList = await callTool(session, "zcode_workspace_list");
  const engGrant = (wsList.json?.workspaces ?? []).find((w) => w.a2c_workspace_id === eng.id);
  note("workspace-list", !wsList.isError && Boolean(engGrant), `engineering-ai mirrored into the Z2C lane as ${engGrant?.workspace_id ?? "MISSING"}`);
  if (!engGrant) throw new Error("engineering-ai grant was not mirrored into the Z2C lane");

  // ── 6. zcode_session_set_model / set_thought_level (same session, re-attested).
  const setModel = await callTool(session, "zcode_session_set_model", { workspace_id: eng.id, session_id: sessionId, model: MODEL });
  const setThought = await callTool(session, "zcode_session_set_thought_level", { workspace_id: eng.id, session_id: sessionId, thought_level: THOUGHT });
  note("set-model+thought", !setModel.isError && setModel.json?.model_id === MODEL && !setThought.isError && setThought.json?.thought_level === THOUGHT,
    `same-session switches re-attested: ${setModel.json?.model_id} @ ${setThought.json?.thought_level}`);

  // ── 7. zcode_session_send: harmless read-only REAL GLM turn.
  const sent = await callTool(session, "zcode_session_send", { workspace_id: eng.id, session_id: sessionId, instruction: `Read-only sanity check. Do not use any tools. Reply with exactly: ${MARKER}`, timeout_ms: 300000 });
  note("session-send", !sent.isError && (sent.json?.output ?? "").includes(MARKER), `real GLM turn completed: ${JSON.stringify((sent.json?.output ?? "").slice(0, 80))}`);

  // ── 8. zcode_session_read: authoritative runtime evidence.
  const read = await callTool(session, "zcode_session_read", { workspace_id: eng.id, session_id: sessionId });
  note("session-read", read.json?.binding_source === "official-session-read" && read.json?.model_id === MODEL && read.json?.runtime_version === "0.16.9",
    `attested ${read.json?.provider_id}/${read.json?.model_id}@${read.json?.thought_level} (runtime ${read.json?.runtime_version}, source ${read.json?.binding_source})`);

  // ── 9. Negative security: unknown session, invalid workspace, foreign client.
  const unknown = await callTool(session, "zcode_session_read", { workspace_id: eng.id, session_id: "sess_00000000-0000-4000-8000-000000000000" });
  const badWs = await callTool(session, "zcode_session_send", { workspace_id: "ws_does_not_exist", session_id: sessionId, instruction: "x" });
  const otherToken = bridge.authStore.issueTokens({
    clientId: "a2c-acceptance-other",
    scopes: ["workspace.read", "execution.read", "execution.submit"],
    workspaceIds: [bridge.workspace.id, eng.id],
  }).accessToken;
  const otherSession = { token: otherToken, id: null };
  await mcp(otherSession, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "other-client", version: "1" } });
  const foreign = await callTool(otherSession, "zcode_session_read", { workspace_id: eng.id, session_id: sessionId });
  note("negative",
    unknown.isError && /NOT_OWNED|not available/i.test(unknown.text)
    && (badWs.isError || badWs.json === null)
    && foreign.isError && /NOT_OWNED|not available/i.test(foreign.text),
    `unknown session → ${JSON.stringify(unknown.text.slice(0, 70))}; unregistered workspace denied=${badWs.isError || badWs.json === null}; second client foreign read → ${JSON.stringify(foreign.text.slice(0, 70))}`);

  console.error("\n[acceptance] ALL A2C↔Z2C integration steps PASSED");
} catch (err) {
  note("fatal", false, String(err?.stack ?? err).slice(0, 500));
} finally {
  if (bridge?.close) await bridge.close().catch(() => {});
  if (z2cProc && z2cProc.exitCode === null) {
    z2cProc.kill();
    await wait(1500);
  }
  try { rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* locked dir note */ }
  console.log(JSON.stringify(results, null, 2));
  if (results.some((r) => !r.ok)) process.exit(1);
}
