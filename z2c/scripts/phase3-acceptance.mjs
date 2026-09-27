#!/usr/bin/env node
/**
 * Phase-3 LIVE acceptance driver. Runs the full product journey against the
 * REAL installed ZCode agent through the real service process:
 *
 *   clean start → pair client → authorize workspace → MCP capabilities →
 *   write session + real turn + attestation → readonly session + v4 plan →
 *   mutation probe → workspace revoke → client revoke → service restart →
 *   persistence checks → shutdown + orphan check.
 *
 * Every step prints PASS/FAIL evidence lines; any failure exits non-zero.
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const RUN_ID = `${Date.now()}`;
const STATE_DIR = join(ROOT, "test-workspace", `acceptance-state-${RUN_ID}`);
const WS_PATH = join(ROOT, "test-workspace", `acceptance-ws-${RUN_ID}`);
const PORT = "8767";
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL = "GLM-5.3-Flash";
const THOUGHT = "max";
const MARKER = "Z2C PHASE3 ACCEPTANCE OK";

mkdirSync(WS_PATH, { recursive: true });
const results = [];
const note = (step, ok, detail) => {
  results.push({ step, ok, detail });
  console.error(`[acceptance] ${ok ? "PASS" : "FAIL"} step ${step}: ${detail}`);
};
let service = null;
let serviceLog = "";

async function waitHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("service did not become healthy");
}

function startService() {
  service = spawn(process.execPath, ["--import", "tsx", join(ROOT, "src", "service", "main.ts")], {
    cwd: ROOT,
    env: { ...process.env, Z2C_STATE_DIR: STATE_DIR, Z2C_PORT: PORT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  service.stderr.on("data", (d) => { serviceLog += d; });
  service.stdout.on("data", (d) => { serviceLog += d; });
}

async function stopService() {
  if (!service || service.exitCode !== null) return;
  const stopper = spawn(process.execPath, ["--import", "tsx", join(ROOT, "src", "cli", "z2c.ts"), "stop"], {
    cwd: ROOT,
    env: { ...process.env, Z2C_STATE_DIR: STATE_DIR, Z2C_PORT: PORT },
    stdio: "ignore",
  });
  await new Promise((r) => stopper.on("exit", r));
  await new Promise((r) => setTimeout(r, 1500));
}

function api(path, method, secret, body) {
  return fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

let mcpSessionId = null;
async function mcp(token, method, params) {
  const res = await fetch(BASE + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(mcpSessionId ? { "mcp-session-id": mcpSessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) mcpSessionId = sid;
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function callTool(token, name, args) {
  const { body } = await mcp(token, "tools/call", { name, arguments: args ?? {} });
  if (body?.error) return { isError: true, code: body.error.code, text: JSON.stringify(body.error) };
  const result = body?.result ?? {};
  const text = result.content?.[0]?.text ?? "";
  return { isError: result.isError === true, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

function listAgentChildren() {
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*zcode.cjs*app-server*' } | Select-Object -ExpandProperty ProcessId"],
    { encoding: "utf8", timeout: 20000 },
  ).trim();
  return out ? out.split(/\s+/).map(Number) : [];
}

try {
  // Step 1-2: clean start without manual provider env.
  delete process.env.Z2C_PROVIDER; // migration note: stale User-level var is removed for this clean run
  mkdirSync(STATE_DIR, { recursive: true });
  startService();
  const health = await waitHealth(60000);
  note("1-2", health.status === "ok" && health.protocol_version === 1, `service healthy on ${PORT}, protocol v${health.protocol_version}, provider=${health.provider}`);

  // Step 3: pair a local test client.
  const secret = JSON.parse(readFileSync(join(STATE_DIR, "security.json"), "utf8")).secrets.find((s) => !s.retiredAt).secret;
  const begin = await api("/api/pairing/begin", "POST", secret, { deviceName: "acceptance-client" });
  const confirm = await api("/api/pairing/confirm", "POST", secret, { pairingId: begin.body.pairingId, code: begin.body.code });
  const clientToken = confirm.body.token;
  note("3", Boolean(clientToken), `paired clientId=${confirm.body.clientId}`);

  // Step 4: authorize one disposable workspace.
  const authorize = await api("/api/workspaces/authorize", "POST", secret, { path: WS_PATH, write: true, displayName: "acceptance" });
  note("4", authorize.status === 200 && authorize.body.permissions.write === true, `workspace ${authorize.body.workspaceId} authorized (read+write)`);

  // Step 5: MCP runtime capabilities call.
  const init = await mcp(clientToken, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "acceptance", version: "1" } });
  if (init.status !== 200) throw new Error(`MCP initialize failed: HTTP ${init.status}`);
  const caps = await callTool(clientToken, "zcode_runtime_capabilities");
  note("5", caps.json?.provider_status === "healthy" && caps.json?.zcode_runtime_version === "0.16.9", `capabilities: provider ${caps.json?.provider}, runtime ${caps.json?.zcode_runtime_version}`);

  // Step 6: create WRITE session.
  const created = await callTool(clientToken, "zcode_session_create", { workspace_id: authorize.body.workspaceId, access: "write", model: MODEL, thought_level: THOUGHT });
  note("6", !created.isError && created.json?.model_id === MODEL && created.json?.thought_level === THOUGHT, `write session ${created.json?.session_id} bound to ${created.json?.provider_id}/${created.json?.model_id}@${created.json?.thought_level}`);
  const sessionId = created.json?.session_id;

  // Step 7: harmless real turn.
  const sent = await callTool(clientToken, "zcode_session_send", { workspace_id: authorize.body.workspaceId, session_id: sessionId, instruction: `Read-only sanity check. Do not use any tools. Reply with exactly: ${MARKER}`, timeout_ms: 300000 });
  note("7", !sent.isError && (sent.json?.output ?? "").includes(MARKER), `turn completed; response: ${JSON.stringify((sent.json?.output ?? "").slice(0, 80))}`);

  // Step 8: exact attestation.
  const read = await callTool(clientToken, "zcode_session_read", { workspace_id: authorize.body.workspaceId, session_id: sessionId });
  note("8", read.json?.binding_source === "official-session-read" && read.json?.model_id === MODEL && read.json?.thought_level === THOUGHT && read.json?.runtime_version === "0.16.9", `attested ${read.json?.provider_id}/${read.json?.model_id}@${read.json?.thought_level} (v${read.json?.runtime_version}, source ${read.json?.binding_source})`);

  // Step 9: READONLY session with v4 plan.
  const ro = await callTool(clientToken, "zcode_session_create", { workspace_id: authorize.body.workspaceId, access: "readonly", model: MODEL, thought_level: THOUGHT });
  note("9", !ro.isError && ro.json?.plan_enabled === true, `readonly session ${ro.json?.session_id} planEnabled=${ro.json?.plan_enabled}`);

  // Step 10-11: mutation probe refused by the real agent.
  const probeFile = join(WS_PATH, "z2c-acceptance-probe.txt");
  const probe = await callTool(clientToken, "zcode_session_send", { workspace_id: authorize.body.workspaceId, session_id: ro.json.session_id, instruction: "Create a file named z2c-acceptance-probe.txt containing PROBE. This is an unattended probe: if you cannot write files in the current mode, say so in your reply instead of writing.", timeout_ms: 300000 });
  const fileCreated = existsSync(probeFile);
  const planStillOn = probe.json?.state?.plan_enabled === true;
  note("10-11", !fileCreated && planStillOn, `probe turn ${probe.turn ?? "?"}, fileCreated=${fileCreated}, planEnabled after probe=${planStillOn}; agent said: ${JSON.stringify((probe.json?.output ?? probe.text ?? "").slice(0, 200))}`);

  // Step 12: revoke workspace → further access fails.
  await api("/api/workspaces/revoke", "POST", secret, { workspaceId: authorize.body.workspaceId });
  const afterRevoke = await callTool(clientToken, "zcode_session_read", { workspace_id: authorize.body.workspaceId, session_id: sessionId });
  note("12", afterRevoke.isError && /WORKSPACE_NOT_AUTHORIZED|not authorized/i.test(afterRevoke.text), `client read after workspace revoke → ${JSON.stringify(afterRevoke.text.slice(0, 90))}`);

  // Step 13: revoke paired client → further client calls fail.
  await api("/api/pairing/revoke", "POST", secret, { clientId: confirm.body.clientId });
  const afterClientRevoke = await mcp(clientToken, "tools/call", { name: "zcode_runtime_capabilities", arguments: {} });
  note("13", afterClientRevoke.status === 401, `revoked client call → HTTP ${afterClientRevoke.status}`);

  // Step 14-15: restart service; persisted grants/revocations remain correct.
  await stopService();
  startService();
  await waitHealth(60000);
  const status = await api("/api/status", "GET", secret);
  const revokedGrantGone = !status.body.workspaces.some((w) => w.workspace_id === authorize.body.workspaceId);
  const clientRevoked = status.body.clients.every((c) => c.state === "REVOKED" || c.client_id !== confirm.body.clientId);
  const localPairing = JSON.parse(readFileSync(join(STATE_DIR, "pairing.json"), "utf8"));
  const revokedPersisted = localPairing.clients.some((c) => c.clientId === confirm.body.clientId && c.revokedAt);
  note("14-15", revokedGrantGone && clientRevoked && revokedPersisted, `after restart: revoked workspace absent=${revokedGrantGone}, revoked client not active=${clientRevoked}, revocation durable=${revokedPersisted}`);

  // Step 16: local secret still works; unauthenticated still rejected.
  const statusAgain = await api("/api/status", "GET", secret);
  const unauth = await api("/api/status", "GET", "wrong-secret");
  note("16", statusAgain.status === 200 && unauth.status === 401, `local secret works (${statusAgain.status}), unauthenticated rejected (${unauth.status})`);

  // Step 17-18: shutdown; no orphan agent remains.
  const before = listAgentChildren();
  await stopService();
  await new Promise((r) => setTimeout(r, 2000));
  const after = listAgentChildren().filter((pid) => before.includes(pid));
  const childrenFile = JSON.parse(readFileSync(join(STATE_DIR, "children.json"), "utf8"));
  const pidFileGone = !existsSync(join(STATE_DIR, "service.json"));
  note("17-18", after.length === 0 && childrenFile.children.length === 0 && pidFileGone, `agent children before=${before.length}, remaining after shutdown=${after.length}, children registry empty=${childrenFile.children.length === 0}, pid file removed=${pidFileGone}`);
} catch (err) {
  note("fatal", false, String(err?.stack ?? err).slice(0, 400));
} finally {
  if (service && service.exitCode === null) {
    service.kill();
    await new Promise((r) => setTimeout(r, 1000));
  }
  const failed = results.filter((r) => !r.ok);
  console.error(`\n[acceptance] ${results.length - failed.length}/${results.length} step groups passed`);
  console.log(JSON.stringify(results, null, 2));
  if (serviceLog && failed.length > 0) {
    console.error("--- service log tail ---\n" + serviceLog.slice(-1500));
  }
  process.exit(failed.length > 0 ? 1 : 0);
}
