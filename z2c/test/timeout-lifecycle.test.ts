import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ZcodeOfficialProvider } from "../src/providers/zcode/official.js";
import { classifyDevelopmentOperation, permitsDevelopmentOperation } from "../src/providers/zcode/permissions.js";
import { ZcodeProtocol } from "../src/providers/zcode/protocol.js";
import { loadConfig } from "../src/config.js";
import type { ProviderSendOptions } from "../src/providers/types.js";

const FAKE_APP_SERVER = join(process.cwd(), "test", "fixtures", "fake-app-server.mjs");

// ── pure classifier: sanitized denial reason codes (decisions unchanged) ──

const ownedDirs: string[] = [];
after(() => {
  for (const dir of ownedDirs) {
    if (!resolve(dir).startsWith(resolve(process.cwd()) + sep)) throw new Error("test cleanup outside workspace");
    rmSync(dir, { recursive: true, force: true });
  }
});
const root = mkdtempSync(join(process.cwd(), "z2c-timeout-lifecycle-"));
ownedDirs.push(root);
const grants = new Map<string, NonNullable<ProviderSendOptions["executionGrant"]>>([
  ["ws-write", { workspacePath: root, write: true }],
  ["ws-read", { workspacePath: root, write: false }],
  ["ml-write", { workspacePath: root, write: true, mode: "machine-local-development" }],
]);

function request(toolName: string, input: unknown, sessionId = "ws-write", riskLevel = "medium") {
  return {
    requestId: "request",
    sessionId,
    toolCallId: "tool",
    toolName,
    input,
    riskLevel,
    options: [{ optionId: "allow_once", kind: "allow_once", response: { decision: "allow" } }],
  };
}

describe("permission denial reason codes (policy auto-denial, sanitized)", () => {
  const cases: Array<[unknown, string]> = [
    [request("Bash", { command: "node --version" }, "no-such-session"), "missing-active-grant"],
    [request("Bash", { command: "node --version", run_in_background: true }), "background-disallowed"],
    [request("Bash", { command: "node --version", dangerouslyDisableSandbox: true }), "sandbox-disable-denied"],
    [request("Bash", { command: "node --version", extra: 1 }), "unsupported-input"],
    [request("Bash", { command: "node -e 'process.env'" }), "unsupported-command"],
    [request("Bash", { command: "" }, "ml-write"), "unsupported-command"],
    [request("Write", { file_path: join(root, "..", "outside.ts") }), "outside-authorized-workspace"],
    [request("Write", { file_path: join(root, "new.ts") }, "ws-read"), "write-not-granted"],
    [request("Bash", { command: "node --version" }, "ws-read"), "write-not-granted"],
    [request("ExitPlanMode", {}), "unsupported-tool"],
    [{ ...request("Bash", { command: "node --version" }), options: [{ optionId: "always" }] }, "unsupported-decision-option"],
    [request("Bash", { command: "node --version" }, "ws-write", "mega"), "unsupported-risk-level"],
    [{ requestId: "request", toolCallId: "tool", toolName: "Bash", input: {}, riskLevel: "low", options: [] }, "malformed-request"],
  ];
  it("classifies every policy denial with a structured reason code", () => {
    for (const [params, expected] of cases) {
      const decision = classifyDevelopmentOperation(params, grants);
      assert.equal(decision.allowed, false, JSON.stringify(decision));
      assert.equal(decision.reason, expected);
    }
  });
  it("keeps permitsDevelopmentOperation decisions identical to the classifier", () => {
    for (const [params] of cases) assert.equal(permitsDevelopmentOperation(params, grants), false);
    assert.deepEqual(classifyDevelopmentOperation(request("Bash", { command: "pnpm --version" }), grants), { allowed: true, reason: null });
    assert.equal(permitsDevelopmentOperation(request("Bash", { command: "pnpm --version" }), grants), true);
  });
  it("emits sanitized policy decisions on the wire decision event", () => {
    class Transport extends EventEmitter { sent: unknown[] = []; write(v: unknown) { this.sent.push(v); } }
    const transport = new Transport();
    const protocol = new ZcodeProtocol(transport, (p) => classifyDevelopmentOperation(p, grants));
    const audit: unknown[] = [];
    protocol.on("permission-decision", (event) => audit.push(event));
    transport.emit("message", { id: 7, method: "interaction/requestPermission", params: request("Bash", { command: "SECRET_COMMAND_SENTINEL" }) });
    assert.deepEqual(transport.sent, [{ id: 7, result: { decision: "deny" } }]);
    assert.equal(audit.length, 1);
    const record = audit[0] as { allowed: boolean; reason: string | null; source: string; correlation: Record<string, unknown>; at: string };
    assert.equal(record.allowed, false);
    assert.equal(record.reason, "unsupported-command");
    assert.equal(record.source, "policy"); // policy auto-denial — never reported as a user rejection
    assert.equal(record.correlation.sessionId, "ws-write");
    assert.equal(record.correlation.toolName, "Bash");
    assert.ok(typeof record.at === "string" && !Number.isNaN(Date.parse(record.at)));
    assert.equal(JSON.stringify([transport.sent, audit]).includes("SECRET_COMMAND_SENTINEL"), false);
  });
});

// ── provider lifecycle: timeout → bounded stop handshake → grant cleanup ──

interface Harness {
  provider: ZcodeOfficialProvider;
  workspace: { workspacePath: string; workspaceKey: string };
  stateDir: string;
  logPath: string;
}

async function buildHarness(fixtureEnv: Record<string, string>): Promise<Harness> {
  const stateDir = mkdtempSync(join(tmpdir(), "z2c-tl-state-"));
  const workspace = mkdtempSync(join(tmpdir(), "z2c-tl-ws-"));
  const logPath = join(stateDir, "fixture-log.jsonl");
  process.env.FAKE_APP_SERVER_LOG = logPath;
  process.env.FAKE_APP_SERVER_STATE = join(stateDir, "fixture-state.json");
  for (const [k, v] of Object.entries(fixtureEnv)) process.env[k] = v;
  const cfg = {
    ...loadConfig(),
    stateDir,
    zcodeCliPath: FAKE_APP_SERVER,
    requestedModelId: "GLM-5.3-Flash",
    requestedThoughtLevel: "max",
  };
  const provider = new ZcodeOfficialProvider(cfg);
  await provider.start();
  return { provider, workspace: { workspacePath: workspace, workspaceKey: workspace }, stateDir, logPath };
}

async function stopHarness(h: Harness, fixtureEnv: Record<string, string>): Promise<void> {
  await h.provider.stop();
  rmSync(h.stateDir, { recursive: true, force: true });
  rmSync(h.workspace.workspacePath, { recursive: true, force: true });
  delete process.env.FAKE_APP_SERVER_LOG;
  delete process.env.FAKE_APP_SERVER_STATE;
  for (const k of Object.keys(fixtureEnv)) delete process.env[k];
}

function readJsonLog(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function waitFor(label: string, predicate: () => boolean, deadlineMs = 6000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`condition not observed in time: ${label}`);
}

async function sendGovernedTurn(h: Harness, sessionId: string, timeoutMs: number) {
  return h.provider.send({
    sessionId,
    instruction: "held turn for timeout lifecycle test",
    inputId: "in-timeout-lifecycle",
    timeoutMs,
    executionGrant: { workspacePath: h.workspace.workspacePath, write: true, mode: "machine-local-development" },
  });
}

async function createSession(h: Harness): Promise<string> {
  return h.provider.createSession(h.workspace, { modelId: "GLM-5.3-Flash", thoughtLevel: "max" });
}

describe("ZcodeOfficialProvider turn timeout lifecycle", () => {
  it("on timeout: requests bounded stop, resolves truthfully, revokes the grant (post-timeout permission denied)", async () => {
    const fixtureEnv = { FAKE_TURN_HOLD: "1", FAKE_PROBE_ON_STOP: "1" };
    const h = await buildHarness(fixtureEnv);
    try {
      assert.equal(h.provider.status, "healthy");
      const sessionId = await createSession(h);
      const handle = await sendGovernedTurn(h, sessionId, 500);
      const result = await handle.completion;
      assert.equal(result.status, "failed");
      assert.match(result.detail ?? "", /turn timeout after 500ms/);
      // Truthful state: cancellation was requested, but the turn's terminal
      // state was never observed — not a fabricated "stopped"/"completed".
      assert.match(result.detail ?? "", /cancellation requested, terminal state unobserved/);
      assert.match(result.detail ?? "", /execution grant revoked/);
      // The supported cancellation handshake actually fired.
      await waitFor("session/stop sent", () => readJsonLog(h.logPath).some((r) => r.method === "session/stop"));
      // Grant cleanup, proven through the post-timeout permission probe the
      // fixture sends right after session/stop: "pnpm --version" would be
      // admitted with a live grant, so a deny proves the revocation.
      await waitFor("post-timeout permission probe answered", () => readJsonLog(h.logPath).some((r) => r.probeDecision !== undefined));
      const probe = readJsonLog(h.logPath).find((r) => r.probeDecision !== undefined);
      assert.equal(probe?.probeDecision, "deny");
      // Denial observability: sanitized policy record with reason code and
      // correlation, never command contents, never a user rejection.
      const audit = readJsonLog(join(h.stateDir, "audit", "audit.log"));
      const denial = audit.find((r) => r.event === "interaction.resolved" && r.reason === "missing-active-grant");
      assert.ok(denial, "missing-active-grant denial was not audited");
      assert.equal(denial.decision, "deny");
      assert.equal(denial.source, "policy");
      assert.equal(denial.sessionId, sessionId);
      assert.equal(denial.toolName, "Bash");
      assert.equal(JSON.stringify(audit).includes("pnpm --version"), false);
      assert.equal(h.provider.status, "healthy");
    } finally {
      await stopHarness(h, fixtureEnv);
    }
  });

  it("on late completion after timeout: no resurrection, outcome recorded, promise settled once", async () => {
    const fixtureEnv = { FAKE_TURN_HOLD: "1", FAKE_TURN_COMPLETE_AFTER_MS: "700" };
    const h = await buildHarness(fixtureEnv);
    try {
      const sessionId = await createSession(h);
      const handle = await sendGovernedTurn(h, sessionId, 300);
      const result = await handle.completion;
      assert.match(result.detail ?? "", /terminal state unobserved/);
      // The turn completes anyway ~700ms in; the late terminal evidence must
      // be recorded and must not re-settle or re-arm anything.
      await waitFor("late terminal evidence audited", () =>
        readJsonLog(join(h.stateDir, "audit", "audit.log")).some(
          (r) => r.event === "turn.terminalAfterResolution" && r.sessionId === sessionId && r.type === "turn.completed",
        ));
      assert.equal(await handle.completion, result); // same fulfilled value — settled exactly once
      assert.equal(h.provider.status, "healthy");
      const audit = readJsonLog(join(h.stateDir, "audit", "audit.log"));
      assert.equal(audit.some((r) => r.event === "interaction.resolved" && r.decision === "allow"), false); // nothing re-armed
    } finally {
      await stopHarness(h, fixtureEnv);
    }
  });

  it("on stop failure: completion still resolves with an unconfirmed stop and protection retained", async () => {
    const fixtureEnv = { FAKE_TURN_HOLD: "1", FAKE_STOP_FAILS: "1" };
    const h = await buildHarness(fixtureEnv);
    try {
      const sessionId = await createSession(h);
      const handle = await sendGovernedTurn(h, sessionId, 300);
      const result = await handle.completion; // must resolve, never throw
      assert.equal(result.status, "failed");
      assert.match(result.detail ?? "", /terminal state unobserved/);
      // The stop was attempted (and failed) — the grant stays revoked and the
      // provider stays healthy.
      await waitFor("session/stop attempted", () => readJsonLog(h.logPath).some((r) => r.method === "session/stop"));
      await new Promise((r) => setTimeout(r, 150)); // let the handshake settle
      assert.equal(h.provider.status, "healthy");
    } finally {
      await stopHarness(h, fixtureEnv);
    }
  });

  it("rejects a new send while the post-timeout stop handshake is in flight", async () => {
    // The fixture holds its session/stop response for 800ms, making the
    // in-flight window deterministic.
    const fixtureEnv = { FAKE_TURN_HOLD: "1", FAKE_STOP_FAILS: "1", FAKE_STOP_DELAY_MS: "800" };
    const h = await buildHarness(fixtureEnv);
    try {
      const sessionId = await createSession(h);
      const handle = await sendGovernedTurn(h, sessionId, 200);
      await handle.completion;
      await assert.rejects(
        () => sendGovernedTurn(h, sessionId, 60000),
        /stop\/cancellation handshake is still in progress/,
      );
      // After the (failing) handshake completes (~800ms fixture delay), a new
      // send must be possible again — the block is bounded, never permanent.
      const deadline = Date.now() + 5000;
      let lifted = false;
      while (Date.now() < deadline && !lifted) {
        try {
          await sendGovernedTurn(h, sessionId, 60000);
          lifted = true;
        } catch (err) {
          assert.match(String((err as Error).message), /stop\/cancellation handshake is still in progress/);
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      assert.equal(lifted, true);
    } finally {
      await stopHarness(h, fixtureEnv);
    }
  });
});
