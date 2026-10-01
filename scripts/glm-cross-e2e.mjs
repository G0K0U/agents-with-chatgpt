#!/usr/bin/env node
/**
 * GLM cross-root E2E through the LIVE A2C gateway: write session bound to the
 * approved parent root writes markers into TWO sibling roots (A2C_E2E_ROOT_A
 * and A2C_E2E_ROOT_B), reads them back, deletes them, and
 * survives set_model/set_thought_level setters with an immediate next send.
 */
import fs from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Machine-independent configuration (same scheme as scripts/a2c-final-e2e.mjs):
//   A2C_E2E_STATE_DIR             bridge state dir (default: $LOCALAPPDATA/codex-with-chatgpt)
//   A2C_E2E_RUNTIME_ID            registered bridge workspace id whose runtime/<id>.json to read (required)
//   A2C_E2E_BASE                  gateway base URL (default: http://127.0.0.1:48765)
//   A2C_E2E_SESSION_WORKSPACE_ID  A2C workspace the GLM session runs in (required)
//   A2C_E2E_ROOT_A/_B             sibling roots the cross-root markers use (required)
const stateDir = process.env.A2C_E2E_STATE_DIR ?? join(process.env.LOCALAPPDATA ?? "", "codex-with-chatgpt");
const RUNTIME_ID = process.env.A2C_E2E_RUNTIME_ID;
const engId = process.env.A2C_E2E_SESSION_WORKSPACE_ID;
const ROOT_A = process.env.A2C_E2E_ROOT_A;
const ROOT_B = process.env.A2C_E2E_ROOT_B;
const missing = [
  ["A2C_E2E_RUNTIME_ID", RUNTIME_ID], ["A2C_E2E_SESSION_WORKSPACE_ID", engId],
  ["A2C_E2E_ROOT_A", ROOT_A], ["A2C_E2E_ROOT_B", ROOT_B],
].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`[glm-cross] missing required env: ${missing.join(", ")} (see header comment)`);
  process.exit(2);
}
const runtime = JSON.parse(fs.readFileSync(join(stateDir, "runtime", `${RUNTIME_ID}.json`), "utf8"));
const base = process.env.A2C_E2E_BASE ?? "http://127.0.0.1:48765";
const b64url = (buf) => buf.toString("base64url");
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const REDIRECT_URI = "http://127.0.0.1:0/callback";
const reg = await (await fetch(base + "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "glm-cross", redirect_uris: [REDIRECT_URI], grant_types: ["authorization_code"], token_endpoint_auth_method: "none", scope: "workspace.read execution.read execution.submit execution.cancel" }) })).json();
const pairing = await (await fetch(base + "/admin/pairing", { method: "POST", headers: { authorization: `Bearer ${runtime.adminToken}`, "content-type": "application/json" }, body: JSON.stringify({ deviceName: "glm-cross" }) })).json();
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

const RUN = Date.now();
const markerA = join(ROOT_A, ".tooling", "glm-cross-" + RUN + ".txt");
const markerB = join(ROOT_B, ".tooling", "glm-cross-" + RUN + ".txt");

const createdRaw = await tool("zcode_session_create", { workspace_id: engId, access: "write", model: "GLM-5.3-Flash", thought_level: "max" });
const created = firstJson(createdRaw);
if (!created?.session_id) { console.error("create failed:", createdRaw.slice(0, 300)); process.exit(1); }
console.log("GLM session:", created.session_id, "attested:", created.provider_id + "/" + created.model_id + "@" + created.thought_level);

const instruction = "Full-access cross-repo fixture task. Create these two marker files:\n1. \"" + markerA + "\" containing exactly GLM-A\n2. \"" + markerB + "\" containing exactly GLM-B\nThen read both files back to confirm their contents.\nThen delete both files.\nThen reply with the single line: GLM-CROSS-DONE";
const send1 = await tool("zcode_session_send", { workspace_id: engId, session_id: created.session_id, instruction, timeout_ms: 600000 });
console.log("cross-root send:", send1.slice(0, 220));

const read1 = await tool("zcode_session_read", { workspace_id: engId, session_id: created.session_id });
const read1j = firstJson(read1);
console.log("read1 attested:", read1j?.provider_id + "/" + read1j?.model_id + "@" + read1j?.thought_level);

const setModelRaw = await tool("zcode_session_set_model", { workspace_id: engId, session_id: created.session_id, model: "GLM-5.3-Flash" });
const setModel = firstJson(setModelRaw);
console.log("setModel re-attested:", setModel?.model_id, "/", setModel?.thought_level);

const setThoughtRaw = await tool("zcode_session_set_thought_level", { workspace_id: engId, session_id: created.session_id, thought_level: "max" });
const setThought = firstJson(setThoughtRaw);
console.log("setThought re-attested:", setThought?.thought_level);

const send2Raw = await tool("zcode_session_send", { workspace_id: engId, session_id: created.session_id, instruction: "Read-only check. Do not use any tools. Reply with exactly: GLM-SECOND-SEND-OK", timeout_ms: 300000 });
console.log("second send:", send2Raw.slice(0, 150));

console.log("markers after cleanup:", existsSync(markerA), existsSync(markerB));
