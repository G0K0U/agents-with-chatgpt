/**
 * Live PoC driver (Tests 1–10). Spawns the real Z2C bridge on 127.0.0.1,
 * drives its MCP surface over HTTP, and verifies the full lifecycle against
 * the real ZCode app-server/GLM agent. Run: npx tsx test/live.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const PORT = 8799;
const STATE_DIR = resolve("live-state");
const BASE = `http://127.0.0.1:${PORT}`;
const WS = "z2c-test";
const PROOF = "Z2C_POC_OK_LIVE";

let token = "";
const results: Array<[string, string]> = [];

function pass(name: string, detail = ""): void {
  results.push(["PASS", name + (detail ? ` — ${detail}` : "")]);
  console.log(`PASS ${name} ${detail}`);
}
function fail(name: string, detail = ""): void {
  results.push(["FAIL", name + (detail ? ` — ${detail}` : "")]);
  console.log(`FAIL ${name} ${detail}`);
}

let mcpSessionId: string | null = null;

async function mcpRaw(body: unknown, timeoutMs = 60000): Promise<{ status: number; headers: Headers; json: any }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        ...(mcpSessionId ? { "mcp-session-id": mcpSessionId } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) mcpSessionId = sid;
    const ct = res.headers.get("content-type") ?? "";
    let json: any = null;
    if (ct.includes("application/json")) json = await res.json();
    else if (ct.includes("text/event-stream")) {
      const text = await res.text();
      for (const line of text.split("\n")) {
        if (line.startsWith("data:")) {
          try { json = JSON.parse(line.slice(5).trim()); } catch { /* keep last */ }
        }
      }
    }
    return { status: res.status, headers: res.headers, json };
  } finally {
    clearTimeout(t);
  }
}

let initialized = false;
async function ensureMcpInit(): Promise<void> {
  if (initialized) return;
  await mcpRaw({ jsonrpc: "2.0", id: 0, method: "initialize", params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "z2c-live-test", version: "0.0.1" },
  } });
  await mcpRaw({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  initialized = true;
}

async function mcp(name: string, args: Record<string, unknown>, timeoutMs = 60000): Promise<Record<string, unknown>> {
  await ensureMcpInit();
  const { json } = await mcpRaw({
    jsonrpc: "2.0", id: Date.now(), method: "tools/call",
    params: { name, arguments: args },
  }, timeoutMs);
  const result = json?.result ?? json;
  const text = result?.content?.[0]?.text ?? JSON.stringify(json);
  if (result?.isError) throw new Error(text);
  return JSON.parse(text) as Record<string, unknown>;
}

async function mcpExpectError(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    await mcp(name, args);
    throw new Error("expected error, got success");
  } catch (err) {
    return String((err as Error).message);
  }
}

async function waitTaskTerminal(taskId: string, timeoutMs = 300000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    last = await mcp("get_zcode_task", { workspace_id: WS, task_id: taskId }, 30000);
    if (["completed", "failed", "cancelled", "interrupted"].includes(last.status as string)) return last;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return last;
}

function snapshotTree(dir: string): string {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      const p = join(d, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else out.push(`${p}|${st.size}|${Math.floor(st.mtimeMs / 1000)}`);
    }
  };
  walk(dir);
  return out.sort().join("\n");
}

let bridge: ChildProcess | null = null;

async function startBridge(): Promise<void> {
  bridge = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
    env: { ...process.env, Z2C_STATE_DIR: STATE_DIR, Z2C_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridge.stderr!.on("data", (d) => process.stderr.write(`[bridge] ${d}`));
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("bridge did not become healthy");
}

async function main(): Promise<void> {
  await startBridge();
  const authDeadline = Date.now() + 30000;
  while (!existsSync(join(STATE_DIR, "auth.json")) && Date.now() < authDeadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  token = JSON.parse(readFileSync(join(STATE_DIR, "auth.json"), "utf8")).bearerToken;

  // ── Test 1: provider handshake / capability probe
  const status = await mcp("provider_status", {});
  const caps = status.capabilities as { ok: boolean; detectedVersion: string; required: Record<string, string> } | null;
  if (status.status === "healthy" && caps?.ok && caps.detectedVersion?.startsWith("0.16.")) {
    pass("T1 handshake+capabilities", `ZCode ${caps.detectedVersion}, required=${JSON.stringify(caps.required)}`);
  } else {
    fail("T1 handshake+capabilities", JSON.stringify(status).slice(0, 300));
  }

  // auth: bad token must be rejected
  const savedToken = token;
  token = "wrong-token";
  const bad = await fetch(`${BASE}/mcp`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  token = savedToken;
  bad.status === 401 ? pass("T1b auth rejects bad token") : fail("T1b auth rejects bad token", String(bad.status));

  // security: bounded tool surface via tools/list (proper MCP session)
  await ensureMcpInit();
  const listRes = await mcpRaw({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const toolNames = (listRes.json?.result?.tools as Array<{ name: string }> | undefined)?.map((t) => t.name).sort() ?? [];
  const allowed = ["cancel_zcode_task", "execution_output", "execution_queue", "get_zcode_task", "provider_status", "resume_zcode_session", "submit_zcode_task", "workspace_info"];
  JSON.stringify(toolNames) === JSON.stringify(allowed)
    ? pass("T1c bounded tool surface", toolNames.join(", "))
    : fail("T1c bounded tool surface", toolNames.join(", "));

  // ── Test 2: session list read-only happens inside T10; here check workspace_info
  const wsInfo = await mcp("workspace_info", { workspace_id: WS });
  wsInfo.workspace_id === WS ? pass("T2 workspace_info") : fail("T2 workspace_info");
  const badWs = await mcpExpectError("workspace_info", { workspace_id: "not-a-workspace" });
  badWs.includes("UNKNOWN_WORKSPACE") ? pass("T2b unknown workspace rejected") : fail("T2b unknown workspace rejected", badWs);

  // ── Test 3+4+5: submit harmless task, wait terminal, fetch output
  const submitted = await mcp("submit_zcode_task", {
    workspace_id: WS,
    instruction: `Create no files and run no commands. Reply with exactly: ${PROOF}`,
    write_scope: "readonly",
    mode: "build",
  });
  const taskId = submitted.task_id as string;
  /^z2c_/.test(taskId)
    ? pass("T3 task submitted", `task=${taskId}`)
    : fail("T3 create disposable session", JSON.stringify(submitted));

  const done = await waitTaskTerminal(taskId);
  const sessId = done.session_id as string | null;
  done.status === "completed" && /^sess_/.test(sessId ?? "")
    ? pass("T5 lifecycle queued→running→completed", `session=${sessId}`)
    : fail("T5 lifecycle", `status=${done.status} exit=${JSON.stringify(done.exit_status)}`);

  // ── Test 4: structured output
  const outErr = await mcpExpectError("execution_output", { workspace_id: WS, task_id: taskId, output_id: "z2co_wrong" });
  outErr.includes("OUTPUT_MISMATCH") ? pass("T4b ambiguous output fails closed") : fail("T4b", outErr);
  // get real output id from the bounded task view and fetch the output
  const rec = done as { output_id?: string | null };
  if (typeof rec.output_id === "string" && rec.output_id) {
    const out = await mcp("execution_output", { workspace_id: WS, task_id: taskId, output_id: rec.output_id });
    String(out.text).includes(PROOF)
      ? pass("T4 structured output contains proof text", `output=${rec.output_id}`)
      : fail("T4 structured output", String(out.text).slice(0, 200));
  } else {
    fail("T4 structured output", `task view output_id=${JSON.stringify(rec.output_id)}`);
  }

  // ── Test 6: cancellation of a long-running task
  const longTask = await mcp("submit_zcode_task", {
    workspace_id: WS,
    instruction: "Without using any tools, write a detailed 1500-word essay about the history of operating systems. Take your time and be thorough.",
    mode: "build",
  });
  const longId = longTask.task_id as string;
  const deadline = Date.now() + 120000;
  let wasRunning = false;
  while (Date.now() < deadline) {
    const t = await mcp("get_zcode_task", { workspace_id: WS, task_id: longId });
    if (t.status === "running") { wasRunning = true; break; }
    if (["completed", "failed"].includes(t.status as string)) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  const cancelled = await mcp("cancel_zcode_task", { workspace_id: WS, task_id: longId });
  const cState = await waitTaskTerminal(longId, 60000);
  wasRunning && cancelled.status === "cancelled" && cState.status === "cancelled"
    ? pass("T6 cancel running task", `wasRunning=${wasRunning}`)
    : fail("T6 cancel", `wasRunning=${wasRunning} state=${cState.status}`);

  // ── Test 7: resume existing disposable session
  const resumed = await mcp("resume_zcode_session", {
    workspace_id: WS,
    session_id: sessId,
    instruction: `What exact text did I previously ask you to reply with? Reply with only that exact text, nothing else.`,
  });
  const rDone = await waitTaskTerminal(resumed.task_id as string);
  if (rDone.status === "completed") {
    const rOut = await mcp("execution_output", { workspace_id: WS, task_id: resumed.task_id, output_id: (rDone as { output_id?: string }).output_id ?? "" });
    String(rOut.text).includes(PROOF)
      ? pass("T7 resume preserves session context", String(rOut.text).slice(0, 60))
      : fail("T7 resume output", String(rOut.text).slice(0, 200));
  } else {
    fail("T7 resume", JSON.stringify(rDone).slice(0, 200));
  }

  // ── Test 8: queue pause prevents dispatch; resume drains FIFO
  await mcp("execution_queue", { workspace_id: WS, action: "pause" });
  const qTask = await mcp("submit_zcode_task", { workspace_id: WS, instruction: `Create no files. Reply with exactly: QUEUE_DRAIN_OK` });
  await new Promise((r) => setTimeout(r, 6000));
  const qState1 = await mcp("get_zcode_task", { workspace_id: WS, task_id: qTask.task_id });
  qState1.status === "queued"
    ? pass("T8 paused workspace does not dispatch")
    : fail("T8 paused workspace does not dispatch", String(qState1.status));
  await mcp("execution_queue", { workspace_id: WS, action: "resume" });
  const qDone = await waitTaskTerminal(qTask.task_id as string);
  qDone.status === "completed" ? pass("T8b resume drains queue") : fail("T8b resume drains", String(qDone.status));

  // ── Test 9: bridge restart preserves registry truth
  const preRestart = await mcp("get_zcode_task", { workspace_id: WS, task_id: taskId });
  bridge?.kill();
  await new Promise((r) => setTimeout(r, 3000));
  await startBridge();
  // new bridge process → MCP session state is gone; re-initialize
  initialized = false;
  mcpSessionId = null;
  const postRestart = await mcp("get_zcode_task", { workspace_id: WS, task_id: taskId });
  JSON.stringify(postRestart) === JSON.stringify(preRestart)
    ? pass("T9 restart preserves task registry")
    : fail("T9 restart", `${JSON.stringify(preRestart)} vs ${JSON.stringify(postRestart)}`);
  const s2 = await mcp("provider_status", {});
  s2.status === "healthy" ? pass("T9b provider healthy after restart") : fail("T9b", String(s2.status));

  // ── Test 10: real ZCode Desktop ecosystem interop (direct app-server session/list)
  const { ZcodeProvider } = await import("../src/providers/zcode/client.js");
  const { loadConfig } = await import("../src/config.js");
  const cfg = loadConfig();
  const p = new ZcodeProvider(cfg);
  await p.start();
  const sessions = await p.listSessions({
    workspacePath: resolve("test-workspace").toLowerCase(),
    workspaceKey: resolve("test-workspace").toLowerCase(),
  });
  const found = sessions.some((s) => s.sessionId === sessId);
  found
    ? pass("T10 session visible in shared ZCode session store", `${sessions.length} sessions in test workspace`)
    : fail("T10 desktop interop", `sess ${sessId} not found among ${sessions.length}`);
  await p.stop();

  // ── Engineering AI untouched check
  const marker = join(STATE_DIR, "engineering-ai-before.snapshot");
  if (existsSync(marker)) {
    const before = readFileSync(marker, "utf8");
    const after = snapshotTree(resolve("../engineering-ai"));
    before === after ? pass("T11 engineering-ai unmodified") : fail("T11 engineering-ai modified!");
  } else {
    fail("T11 engineering-ai", "baseline snapshot missing");
  }

  const fails = results.filter((r) => r[0] === "FAIL");
  console.log(`\n=== LIVE RESULT: ${results.length - fails.length}/${results.length} passed ===`);
  process.exit(fails.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("LIVE FATAL:", err);
  process.exit(1);
});
