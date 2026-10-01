#!/usr/bin/env node
/**
 * Readonly first-turn canary: reproduces the prompt_failed observation with
 * full failure-payload diagnostics. Expects: create readonly session →
 * first real turn → capture terminal status + bottom error.
 *
 * Machine-independent configuration (all via environment):
 *   A2C_PROBE_STATE_DIR      bridge state dir (default: $LOCALAPPDATA/codex-with-chatgpt)
 *   A2C_PROBE_RUNTIME_ID     registered bridge workspace id whose runtime/<id>.json to read (required)
 *   A2C_PROBE_WORKSPACE_ID   workspace id the zcode_session_* calls target (required)
 *   A2C_PROBE_BASE           gateway base URL (default: http://127.0.0.1:48765, the product default port)
 */
import fs from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { join } from "node:path";
const stateDir = process.env.A2C_PROBE_STATE_DIR ?? join(process.env.LOCALAPPDATA ?? "", "codex-with-chatgpt");
const RUNTIME_ID = process.env.A2C_PROBE_RUNTIME_ID;
const WORKSPACE_ID = process.env.A2C_PROBE_WORKSPACE_ID;
const missing = [
  ["A2C_PROBE_RUNTIME_ID", RUNTIME_ID], ["A2C_PROBE_WORKSPACE_ID", WORKSPACE_ID],
].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`[ro-probe] missing required env: ${missing.join(", ")} (see header comment)`);
  process.exit(2);
}
const runtime = JSON.parse(fs.readFileSync(join(stateDir, "runtime", `${RUNTIME_ID}.json`), "utf8"));
const base = process.env.A2C_PROBE_BASE ?? "http://127.0.0.1:48765";
const b64url = (buf) => buf.toString("base64url");
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const REDIRECT_URI = "http://127.0.0.1:0/callback";
const reg = await (await fetch(base + "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "ro-probe", redirect_uris: [REDIRECT_URI], grant_types: ["authorization_code"], token_endpoint_auth_method: "none", scope: "workspace.read execution.read execution.submit execution.cancel" }) })).json();
const pairing = await (await fetch(base + "/admin/pairing", { method: "POST", headers: { authorization: `Bearer ${runtime.adminToken}`, "content-type": "application/json" }, body: JSON.stringify({ deviceName: "ro-probe" }) })).json();
const au = new URL(base + "/oauth/authorize");
au.searchParams.set("client_id", reg.client_id); au.searchParams.set("redirect_uri", REDIRECT_URI); au.searchParams.set("response_type", "code"); au.searchParams.set("code_challenge", challenge); au.searchParams.set("code_challenge_method", "S256"); au.searchParams.set("scope", "workspace.read execution.read execution.submit execution.cancel");
const page = await (await fetch(au, { redirect: "manual" })).text();
const requestId = page.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
const post = await fetch(base + "/oauth/authorize", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request_id: requestId, pairing_code: pairing.code }) });
const code = new URL(post.headers.get("location")).searchParams.get("code");
const tb = await (await fetch(base + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: REDIRECT_URI, code_verifier: verifier }) })).json();
const token = tb.access_token;
let sid = null;
async function tool(name, args) {
  const res = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: Math.random().toString(), method: "tools/call", params: { name, arguments: args } }) });
  const s2 = res.headers.get("mcp-session-id"); if (s2) sid = s2;
  const body = await res.json();
  return (body?.result?.content ?? []).map((c) => c.text).join("\n");
}
function firstJson(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}
const engId = WORKSPACE_ID;
const created = firstJson(await tool("zcode_session_create", { workspace_id: engId, access: "readonly", model: "GLM-5.3-Flash", thought_level: "max" }));
if (!created?.session_id) { console.error("create failed:", created); process.exit(1); }
console.log("readonly session:", created.session_id, "attested:", created.provider_id + "/" + created.model_id + "@" + created.thought_level);
const sent = await tool("zcode_session_send", { workspace_id: engId, session_id: created.session_id, instruction: "Read-only check. Do not use any tools. Reply with exactly: RO-TURN-OK", timeout_ms: 300000 });
console.log("send result:", sent.slice(0, 400));
const read = await tool("zcode_session_read", { workspace_id: engId, session_id: created.session_id });
const rj = firstJson(read);
console.log("post-turn attested:", rj?.provider_id + "/" + rj?.model_id + "@" + rj?.thought_level, "status:", rj?.status);
const msgs = await tool("zcode_session_messages", { workspace_id: engId, session_id: created.session_id });
console.log("session messages:", msgs);
