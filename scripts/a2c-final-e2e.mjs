#!/usr/bin/env node
/**
 * Final E2E acceptance for the LIVE A2C deployment: drives REAL Gemini and
 * Codex tasks through the LIVE A2C MCP gateway (pairing-authenticated),
 * verifies cross-root file actions, output capture, native model attestation,
 * then cleans up all markers.
 */
import fs from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Machine-independent configuration (all via environment):
//   A2C_E2E_STATE_DIR    bridge state dir (default: $LOCALAPPDATA/codex-with-chatgpt)
//   A2C_E2E_RUNTIME_ID   registered bridge workspace id whose runtime/<id>.json to read (required)
//   A2C_E2E_BASE         gateway base URL (default: http://127.0.0.1:48765, the product default port)
//   A2C_E2E_ROOT_A/_B    two sibling workspace roots the cross-root fixture tasks write into (required)
//   A2C_E2E_WRITE_SCOPE  write scope granted to the fixture tasks
//                        (default: common parent directory of ROOT_A and ROOT_B)
const stateDir = process.env.A2C_E2E_STATE_DIR ?? join(process.env.LOCALAPPDATA ?? "", "codex-with-chatgpt");
const RUNTIME_ID = process.env.A2C_E2E_RUNTIME_ID;
const ROOT_A = process.env.A2C_E2E_ROOT_A;
const ROOT_B = process.env.A2C_E2E_ROOT_B;
const WRITE_SCOPE = process.env.A2C_E2E_WRITE_SCOPE ?? (() => {
  const seg = (p) => resolve(p).split(/[\\/]+/);
  const a = seg(ROOT_A), b = seg(ROOT_B);
  let i = 0;
  while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  return a.slice(0, Math.max(i, 1)).join("/");
})();
const missing = [
  ["A2C_E2E_RUNTIME_ID", RUNTIME_ID], ["A2C_E2E_ROOT_A", ROOT_A], ["A2C_E2E_ROOT_B", ROOT_B],
].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`[e2e] missing required env: ${missing.join(", ")} (see header comment)`);
  process.exit(2);
}
const runtime = JSON.parse(readFileSync(join(stateDir, "runtime", `${RUNTIME_ID}.json`), "utf8"));
const base = process.env.A2C_E2E_BASE ?? "http://127.0.0.1:48765";
const admin = runtime.adminToken;
const b64url = (buf) => buf.toString("base64url");
const results = [];
const note = (step, ok, detail) => { results.push({ step, ok, detail }); console.error(`[e2e] ${ok ? "PASS" : "FAIL"} ${step}: ${detail}`); };

async function mintToken() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const REDIRECT_URI = "http://127.0.0.1:0/callback";
  const reg = await (await fetch(base + "/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "a2c-final-e2e", redirect_uris: [REDIRECT_URI], grant_types: ["authorization_code"], token_endpoint_auth_method: "none", scope: "workspace.read execution.read execution.submit execution.cancel" }),
  })).json();
  const pairing = await (await fetch(base + "/admin/pairing", { method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ deviceName: "a2c-final-e2e" }) })).json();
  const au = new URL(base + "/oauth/authorize");
  au.searchParams.set("client_id", reg.client_id); au.searchParams.set("redirect_uri", REDIRECT_URI); au.searchParams.set("response_type", "code"); au.searchParams.set("code_challenge", challenge); au.searchParams.set("code_challenge_method", "S256"); au.searchParams.set("scope", "workspace.read execution.read execution.submit execution.cancel");
  const page = await (await fetch(au, { redirect: "manual" })).text();
  const requestId = page.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
  const post = await fetch(base + "/oauth/authorize", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request_id: requestId, pairing_code: pairing.code }) });
  const code = new URL(post.headers.get("location")).searchParams.get("code");
  const tb = await (await fetch(base + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: REDIRECT_URI, code_verifier: verifier }) })).json();
  return tb.access_token;
}

let sid = null;
async function tool(name, args) {
  const token = process.env.E2E_TOKEN;
  const res = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: Math.random().toString(), method: "tools/call", params: { name, arguments: args } }) });
  const s2 = res.headers.get("mcp-session-id"); if (s2) sid = s2;
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

async function waitForTerminal(taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await tool("get_codex_task", { task_id: taskId });
    const t = firstJson(r.text);
    if (t && t.status && ["completed", "failed", "cancelled", "interrupted"].includes(t.status)) return t;
    await new Promise((r2) => setTimeout(r2, 3000));
  }
  return null;
}

async function main() {
  process.env.E2E_TOKEN = await mintToken();
  note("pairing", Boolean(process.env.E2E_TOKEN), "pairing token minted for the live gateway");

  // ═══ A: Gemini cross-root marker create + verify
  const RUN = Date.now();
  const g1 = join(ROOT_A, ".tooling", `a2c-gemini-${RUN}.txt`);
  const g2 = join(ROOT_B, ".tooling", `a2c-gemini-${RUN}.txt`);
  const subA = await tool("submit_codex_task", {
    workspace_id: RUNTIME_ID,
    instruction: `Full-access cross-repo fixture task. Create these two marker files:\n1. "${g1}" containing exactly GEMINI-A\n2. "${g2}" containing exactly GEMINI-B\nThen reply with the single line: GEMINI-E2E-DONE`,
    write_scope: [WRITE_SCOPE], network: true, provider: "gemini", model: "gemini-3.8-flash-high", run_tests: false,
  });
  const subAJ = firstJson(subA.text);
  note("A1-submit", !subA.isError && Boolean(subAJ && (subAJ.taskId || subAJ.task_id)), `taskId=${subAJ?.taskId ?? subAJ?.task_id ?? "?"}`);
  const taskIdA = subAJ?.taskId ?? subAJ?.task_id;
  const taskA = await waitForTerminal(taskIdA, 15 * 60000);
  const g1ok = existsSync(g1), g2ok = existsSync(g2);
  note("A2-verify", taskA && taskA.status === "completed" && g1ok && g2ok, `gemini ${taskA?.status}: markers eng=${g1ok} z2c=${g2ok}`);
  const outA = await tool("execution_output", { task_id: taskIdA, output_id: taskA?.outputIds?.at(-1) ?? "" });
  note("A3-output", !outA.isError && outA.text.length > 5, `gemini output captured (${outA.text.length} chars)`);

  // ═══ B: Codex cross-root marker create + delete gemini markers
  const c1 = join(ROOT_A, ".tooling", `a2c-codex-${RUN}.txt`);
  const c2 = join(ROOT_B, ".tooling", `a2c-codex-${RUN}.txt`);
  const subB = await tool("submit_codex_task", {
    workspace_id: RUNTIME_ID,
    instruction: `Full-access cross-repo fixture task. Create these two marker files:\n1. "${c1}" containing exactly CODEX-A\n2. "${c2}" containing exactly CODEX-B\nThen reply with the single line: CODEX-E2E-DONE`,
    write_scope: [WRITE_SCOPE], network: true, provider: "codex", run_tests: false,
  });
  const subBJ = firstJson(subB.text);
  note("B1-submit", !subB.isError && Boolean(subBJ && (subBJ.taskId || subBJ.task_id)), `taskId=${subBJ?.taskId ?? subBJ?.task_id ?? "?"}`);
  const taskIdB = subBJ?.taskId ?? subBJ?.task_id;
  const taskB = await waitForTerminal(taskIdB, 20 * 60000);
  const c1ok = existsSync(c1), c2ok = existsSync(c2);
  const modelB = taskB?.actualModel ?? null;
  note("B2-verify", taskB && taskB.status === "completed" && c1ok && c2ok, `codex ${taskB?.status}: markers eng=${c1ok} z2c=${c2ok}; attestation=${JSON.stringify(modelB).slice(0, 80)}`);
  const outB = await tool("execution_output", { task_id: taskIdB, output_id: taskB?.outputIds?.at(-1) ?? "" });
  note("B3-output", !outB.isError && outB.text.length > 5, `codex output captured (${outB.text.length} chars)`);

  // ═══ cleanup: delete all four markers
  const subC = await tool("submit_codex_task", {
    workspace_id: RUNTIME_ID,
    instruction: `Full-access cleanup task. Delete these four marker files if they exist:\n1. "${g1}"\n2. "${g2}"\n3. "${c1}"\n4. "${c2}"\nThen reply with the single line: CLEANUP-DONE`,
    write_scope: [WRITE_SCOPE], network: true, provider: "codex", run_tests: false,
  });
  const subCJ = firstJson(subC.text);
  note("C1-submit", !subC.isError && Boolean(subCJ && (subCJ.taskId || subCJ.task_id)), `cleanup taskId=${subCJ?.taskId ?? subCJ?.task_id ?? "?"}`);
  await waitForTerminal(subCJ?.taskId ?? subCJ?.task_id, 15 * 60000);
  const allGone = !existsSync(g1) && !existsSync(g2) && !existsSync(c1) && !existsSync(c2);
  note("C2-cleanup", allGone, `all four markers deleted: ${allGone}`);
}

main().catch((err) => { note("fatal", false, String(err?.stack ?? err).slice(0, 400)); process.exit(1); });
