#!/usr/bin/env node
/**
 * Live E2E for the UNIFIED three-agent session/activity plane against the
 * running A2C gateway (release/LKG deployment):
 *
 *   1. two independently paired OAuth clients (owner + observer), both
 *      workspace-authorized — mirroring ChatGPT vs. another ChatGPT client;
 *   2. owner creates a ZCode session through the A2C semantic lane;
 *   3. agent_session_list shows ALL THREE providers (zcode + codex + gemini)
 *      in ONE projection, for both clients (shared observation);
 *   4. the observer READS the owner's session (observe ≠ control) and its
 *      visible messages;
 *   5. FOREIGN CONTROL DENIED: the observer's zcode_session_send on the
 *      owner's session fails with ZCODE_SESSION_NOT_OWNED, indistinguishable
 *      from an unknown session (no existence oracle);
 *   6. the owner's own send on the idle session completes (create →
 *      immediate-send when idle);
 *   7. agent_task_read + agent_output_read serve codex/gemini task and
 *      sanitized output bodies cross-client;
 *   8. agent_activity_list carries lifecycle events without message bodies.
 *
 * Read-only side effects: one real ZCode session is created and left in place
 * deliberately (it is the visible cross-client activity record).
 *
 * Machine-independent configuration (all via environment):
 *   A2C_E2E_STATE_DIR     bridge state dir (default: $LOCALAPPDATA/codex-with-chatgpt)
 *   A2C_E2E_RUNTIME_ID    registered bridge workspace id whose runtime/<id>.json to read (required)
 *   A2C_E2E_BASE          gateway base URL (default: http://127.0.0.1:48765, the product default port)
 *   A2C_E2E_WORKSPACE     workspace id for the zcode lane (default: A2C_E2E_RUNTIME_ID)
 */
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const stateDir = process.env.A2C_E2E_STATE_DIR ?? join(process.env.LOCALAPPDATA ?? "", "codex-with-chatgpt");
const RUNTIME_ID = process.env.A2C_E2E_RUNTIME_ID;
const missing = [["A2C_E2E_RUNTIME_ID", RUNTIME_ID]].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`[plane-e2e] missing required env: ${missing.join(", ")} (see header comment)`);
  process.exit(2);
}
const runtime = JSON.parse(readFileSync(join(stateDir, "runtime", `${RUNTIME_ID}.json`), "utf8"));
const base = process.env.A2C_E2E_BASE ?? "http://127.0.0.1:48765";
const admin = runtime.adminToken;
const WS = process.env.A2C_E2E_WORKSPACE ?? RUNTIME_ID;
const b64url = (buf) => buf.toString("base64url");
const results = [];
const note = (step, ok, detail) => { results.push({ step, ok, detail }); console.error(`[plane-e2e] ${ok ? "PASS" : "FAIL"} ${step}: ${detail}`); };

async function mintToken(deviceName) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const REDIRECT_URI = "http://127.0.0.1:0/callback";
  const reg = await (await fetch(base + "/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: deviceName, redirect_uris: [REDIRECT_URI], grant_types: ["authorization_code"], token_endpoint_auth_method: "none", scope: "workspace.read execution.read execution.submit execution.cancel" }),
  })).json();
  const pairing = await (await fetch(base + "/admin/pairing", { method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ deviceName }) })).json();
  const au = new URL(base + "/oauth/authorize");
  au.searchParams.set("client_id", reg.client_id); au.searchParams.set("redirect_uri", REDIRECT_URI); au.searchParams.set("response_type", "code"); au.searchParams.set("code_challenge", challenge); au.searchParams.set("code_challenge_method", "S256"); au.searchParams.set("scope", "workspace.read execution.read execution.submit execution.cancel");
  const page = await (await fetch(au, { redirect: "manual" })).text();
  const requestId = page.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
  const post = await fetch(base + "/oauth/authorize", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request_id: requestId, pairing_code: pairing.code }) });
  const code = new URL(post.headers.get("location")).searchParams.get("code");
  const tb = await (await fetch(base + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: REDIRECT_URI, code_verifier: verifier }) })).json();
  return { token: tb.access_token, clientId: reg.client_id };
}

const sids = new Map();
async function tool(token, name, args) {
  const sid = sids.get(token);
  const res = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: Math.random().toString(), method: "tools/call", params: { name, arguments: args } }) });
  const s2 = res.headers.get("mcp-session-id"); if (s2) sids.set(token, s2);
  const body = await res.json();
  return { isError: body?.result?.isError === true, text: (body?.result?.content ?? []).map((c) => c.text ?? "").join("\n") };
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
const data = (r) => firstJson(r.text);

async function main() {
  const owner = await mintToken("unified-plane-owner");
  const observer = await mintToken("unified-plane-observer");
  note("pairing", Boolean(owner.token) && Boolean(observer.token), "owner + observer tokens minted (two independent OAuth clients)");

  // ── 1. owner creates a ZCode session through the A2C semantic lane ────────
  const created = await tool(owner.token, "zcode_session_create", { workspace_id: WS, access: "write", model: "GLM-5.3-Flash", thought_level: "max" });
  const createdId = data(created)?.session_id;
  note("zcode-create", !created.isError && Boolean(createdId), `session=${createdId} attested=${JSON.stringify(data(created) && { model: data(created).model_id, thought: data(created).thought_level })}`);

  // ── 2. shared projection lists all three providers for BOTH clients ──────
  const listOwner = await tool(owner.token, "agent_session_list", { limit: 100 });
  const ownerView = data(listOwner);
  const providersOwner = [...new Set((ownerView?.sessions ?? []).map((s) => s.provider))].sort();
  note("plane-list-owner", !listOwner.isError && ["codex", "gemini", "zcode"].every((p) => providersOwner.includes(p)),
    `providers=${providersOwner.join(",")} sessions=${ownerView?.sessions?.length}; origins=${JSON.stringify((ownerView?.sessions ?? []).filter((s) => s.provider === "zcode").map((s) => s.origin))}`);

  const listObserver = await tool(observer.token, "agent_session_list", { limit: 100 });
  const observerView = data(listObserver);
  const observerSeesOwner = (observerView?.sessions ?? []).some((s) => s.session_id === createdId);
  note("plane-list-observer", !listObserver.isError && observerSeesOwner, `observer sees the owner's A2C zcode session in the same projection (${(observerView?.sessions ?? []).length} sessions)`);

  // ── 3. observe ≠ control on the owner's session ───────────────────────────
  const obsRead = await tool(observer.token, "agent_session_read", { session_id: createdId });
  const obsRecord = data(obsRead);
  note("observe-read", !obsRead.isError && obsRecord?.caller_can_control === false && obsRecord?.owner_client_id === owner.clientId,
    `observer reads owner session; caller_can_control=${obsRecord?.caller_can_control} owner=${obsRecord?.owner_client_id === owner.clientId ? "owner-client" : obsRecord?.owner_client_id}`);

  const obsMsgs = await tool(observer.token, "agent_session_messages", { session_id: createdId, limit: 10 });
  note("observe-messages", !obsMsgs.isError && Array.isArray(data(obsMsgs)?.messages), `observer reads visible messages (${data(obsMsgs)?.messages?.length ?? 0})`);

  // ── 4. foreign control denied, no existence oracle ────────────────────────
  const denied = await tool(observer.token, "zcode_session_send", { workspace_id: WS, session_id: createdId, instruction: "foreign control attempt — must be denied", timeout_ms: 30000 });
  const deniedCode = denied.isError ? denied.text.split(":")[0] : "(not denied)";
  const oracle = await tool(observer.token, "zcode_session_send", { workspace_id: WS, session_id: "sess_00000000-0000-0000-0000-000000000000", instruction: "x", timeout_ms: 30000 });
  const oracleCode = oracle.isError ? oracle.text.split(":")[0] : "(not denied)";
  note("foreign-control-denied", denied.isError && deniedCode === "ZCODE_SESSION_NOT_OWNED" && deniedCode === oracleCode,
    `foreign send → ${deniedCode}; unknown session → ${oracleCode} (indistinguishable)`);

  // ── 5. owner keeps control: create → immediate-send on the idle session ──
  const sent = await tool(owner.token, "zcode_session_send", {
    workspace_id: WS, session_id: createdId,
    instruction: "Read-only probe. Do not use tools, read files, or change anything. Reply only with the single line: UNIFIED-PLANE-OK",
    timeout_ms: 300000,
  });
  const output = data(sent)?.output ?? "";
  note("owner-immediate-send", !sent.isError && /UNIFIED-PLANE-OK/.test(output) && data(sent)?.turn === "completed",
    `owner send turn=${data(sent)?.turn} output=${JSON.stringify(output.slice(0, 60))}`);

  // ── 6. cross-client task + sanitized output reads (codex/gemini lanes) ───
  const withTasks = (ownerView?.sessions ?? []).filter((s) => (s.provider === "codex" || s.provider === "gemini") && s.taskIds?.length > 0)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
  if (withTasks) {
    const taskRead = await tool(observer.token, "agent_task_read", { workspace_id: withTasks.workspaceId ?? WS, task_id: withTasks.taskIds[0] });
    const task = data(taskRead);
    const outputId = task?.outputIds?.at(-1);
    const outRead = outputId ? await tool(observer.token, "agent_output_read", { workspace_id: withTasks.workspaceId ?? WS, output_id: outputId }) : { isError: true, text: "no output id" };
    note("task-output-read", !taskRead.isError && !outRead.isError && (outRead.text.length > 0),
      `${task?.provider} task=${task?.taskId} status=${task?.status} actionEvidence=${JSON.stringify(task?.actionEvidence)} outputId=${outputId} bodyChars=${outRead.text.length}`);
  } else {
    note("task-output-read", false, "no codex/gemini session with tasks in the projection (run scripts/a2c-final-e2e.mjs first)");
  }

  // ── 7. activity feed: lifecycle events, never message bodies ─────────────
  const activity = await tool(observer.token, "agent_activity_list", { limit: 100 });
  const activityBody = data(activity);
  const leaks = JSON.stringify(activityBody?.events ?? []).includes("UNIFIED-PLANE-OK");
  note("activity-feed", !activity.isError && (activityBody?.events?.length ?? 0) >= 3 && !leaks && typeof activityBody?.lastSeq === "number",
    `events=${activityBody?.events?.length} lastSeq=${activityBody?.lastSeq} bodyLeak=${leaks}`);

  const allOk = results.every((r) => r.ok);
  const report = { when: new Date().toISOString(), base, workspace: WS, allOk, results };
  writeFileSync(join(process.cwd(), "unified-plane-e2e.log"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!allOk) process.exit(1);
}

main().catch((err) => { note("fatal", false, String(err?.stack ?? err).slice(0, 400)); process.exit(1); });
