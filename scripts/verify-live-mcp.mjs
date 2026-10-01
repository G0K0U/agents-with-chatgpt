#!/usr/bin/env node
/**
 * Deployment verification probe: runs the REAL OAuth/pairing flow against the
 * LIVE A2C bridge and reports the live MCP server identity + tool count.
 * Usage: node --import tsx scripts/verify-live-mcp.mjs [port]
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const port = process.argv[2] ?? "48765";
const base = `http://127.0.0.1:${port}`;
// Machine-independent config: A2C_STATE_DIR overrides the bridge state dir
// (default: $LOCALAPPDATA/codex-with-chatgpt); A2C_PROBE_RUNTIME_ID names the
// registered bridge workspace whose runtime/<id>.json carries the admin token.
const runtimeId = process.env.A2C_PROBE_RUNTIME_ID;
if (!runtimeId) { console.log("LIVE_MCP_FAIL: set A2C_PROBE_RUNTIME_ID (registered bridge workspace id)"); process.exit(1); }
const stateDir = process.env.A2C_STATE_DIR ?? join(process.env.LOCALAPPDATA ?? "", "codex-with-chatgpt");
const admin = JSON.parse(readFileSync(join(stateDir, "runtime", `${runtimeId}.json`), "utf8")).adminToken;
const REDIRECT_URI = "http://127.0.0.1:0/callback";
const b64url = (buf) => buf.toString("base64url");
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());

// 1. dynamic client registration
const reg = await (await fetch(`${base}/oauth/register`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "deploy-verify", redirect_uris: [REDIRECT_URI], grant_types: ["authorization_code"], token_endpoint_auth_method: "none", scope: "workspace.read execution.read execution.submit" }),
})).json();
if (!reg.client_id) { console.log("LIVE_MCP_FAIL: registration failed: " + JSON.stringify(reg).slice(0, 200)); process.exit(1); }

// 2. admin-created pairing session
const pairing = await (await fetch(`${base}/admin/pairing`, { method: "POST", headers: { authorization: `Bearer ${admin}` } })).json();
if (!pairing.code) { console.log("LIVE_MCP_FAIL: pairing session failed"); process.exit(1); }

// 3. authorize with the pairing code (PKCE)
const authorizeUrl = new URL(`${base}/oauth/authorize`);
authorizeUrl.searchParams.set("client_id", reg.client_id);
authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("state", "deploy");
authorizeUrl.searchParams.set("code_challenge", challenge);
authorizeUrl.searchParams.set("code_challenge_method", "S256");
authorizeUrl.searchParams.set("scope", "workspace.read execution.read execution.submit");
const page = await (await fetch(authorizeUrl, { redirect: "manual" })).text();
const requestId = page.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
if (!requestId) { console.log("LIVE_MCP_FAIL: no authorize request_id"); process.exit(1); }
const post = await fetch(`${base}/oauth/authorize`, {
  method: "POST", redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ request_id: requestId, pairing_code: pairing.code }),
});
const location = post.headers.get("location");
const code = location ? new URL(location).searchParams.get("code") : null;
if (!code) { console.log("LIVE_MCP_FAIL: authorize did not redirect with code"); process.exit(1); }

// 4. exchange for tokens
const tokenBody = await (await fetch(`${base}/oauth/token`, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code", code, client_id: reg.client_id,
    redirect_uri: REDIRECT_URI, code_verifier: verifier,
  }),
})).json();
if (!tokenBody?.access_token) { console.log("LIVE_MCP_FAIL: token exchange failed: " + JSON.stringify(tokenBody).slice(0, 200)); process.exit(1); }

// 5. MCP initialize + tools/list
const session = { token: tokenBody.access_token, id: null };
async function mcp(method, params) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${session.token}`, ...(session.id ? { "mcp-session-id": session.id } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: `id-${Math.random()}`, method, params }),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) session.id = sid;
  const raw = await res.text();
  let body = null;
  try { body = JSON.parse(raw); } catch {
    for (const line of raw.split(/\r?\n/).reverse()) {
      if (line.startsWith("data:")) { try { body = JSON.parse(line.slice(5).trim()); break; } catch { /* keep */ } }
    }
  }
  return body?.result ?? body;
}
const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "deploy-verify", version: "1" } });
const list = await mcp("tools/list", {});
const tools = (list?.tools ?? []).map((t) => t.name);
const zcodeSession = tools.filter((t) => t.startsWith("zcode_session"));
console.log("LIVE_MCP: " + JSON.stringify({
  server: init?.serverInfo?.name ?? null,
  serverVersion: init?.serverInfo?.version ?? null,
  toolCount: tools.length,
  zcodeSessionTools: zcodeSession,
  hasZcodeRuntimeCapabilities: tools.includes("zcode_runtime_capabilities"),
  hasZcodeWorkspaceList: tools.includes("zcode_workspace_list"),
  representativePreserved: ["workspace_info", "read_file", "search_workspace", "git_status", "git_diff", "execution_summary", "submit_codex_task", "zcode_enqueue_task", "zcode_get_task", "zcode_list_tasks", "zcode_cancel_task"].every((t) => tools.includes(t)),
}, null, 0));

// Optional live Z2C canary (harmless read-only turn on the engineering-ai workspace).
if (process.argv[3] === "--canary") {
  const engTool = (name, args) => mcp("tools/call", { name, arguments: args ?? {} });
  const caps = await engTool("zcode_runtime_capabilities", {});
  const capsText = (caps.content ?? []).map((c) => c.text).join("");
  console.log("Z2C_CAPS: " + capsText.slice(0, 260));
  // Resolve engineering-ai's A2C workspace id via the admin info endpoint.
  const runtime2 = JSON.parse(readFileSync(join(stateDir, "runtime", `${runtimeId}.json`), "utf8"));
  const info2 = await (await fetch(`http://127.0.0.1:${port}/admin/info`, { headers: { authorization: `Bearer ${runtime2.adminToken}` } })).json();
  const engA2cId = info2.authorizedWorkspaces.find((w) => /engineering/i.test(w.name))?.id;
  if (!engA2cId) { console.log("Z2C_CANARY: FAIL - engineering-ai not registered in A2C"); process.exit(1); }
  const created = await engTool("zcode_session_create", { workspace_id: engA2cId, access: "readonly", model: "GLM-5.3-Flash", thought_level: "max" });
  const createdText = (created.content ?? []).map((c) => c.text).join("");
  const createdJson = (() => { try { return JSON.parse(createdText); } catch { return null; } })();
  if (!createdJson?.session_id) { console.log("Z2C_CANARY: FAIL - create: " + createdText.slice(0, 200)); process.exit(1); }
  const wsList = await engTool("zcode_workspace_list", {});
  console.log("Z2C_WS: " + (wsList.content ?? []).map((c) => c.text).join("").slice(0, 260));
  const sent = await engTool("zcode_session_send", { workspace_id: engA2cId, session_id: createdJson.session_id, instruction: "Read-only sanity check. Do not use any tools. Reply with exactly: A2C LIVE CANARY OK", timeout_ms: 300000 });
  const sentText = (sent.content ?? []).map((c) => c.text).join("");
  const sentJson = (() => { try { return JSON.parse(sentText); } catch { return null; } })();
  const ok = sentJson?.output?.includes("A2C LIVE CANARY OK");
  console.log("Z2C_CANARY: " + (ok ? "PASS - real GLM turn: " + JSON.stringify(sentJson.output.slice(0, 80)) : "FAIL - " + sentText.slice(0, 200)));
  process.exit(ok ? 0 : 1);
}
process.exit(0);
