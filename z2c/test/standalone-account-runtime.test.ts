import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZcodeOfficialProvider } from "../src/providers/zcode/official.js";
import { loadConfig } from "../src/config.js";

const FAKE_APP_SERVER = join(process.cwd(), "test", "fixtures", "fake-app-server.mjs");
const SECRET = "z2c-test-secret-do-not-leak-4d81";

// The test runner inherits the machine's real deployment env, which may carry
// live opt-in flags (e.g. Z2C_STANDALONE_ACCOUNT_RUNTIME=1 at User scope).
// The default-fail-closed assertions must observe the factory default, so
// scrub both non-sensitive boolean flags per test and restore them after.
const SAVED_STANDALONE_ENV = {
  standalone: process.env.Z2C_STANDALONE_ACCOUNT_RUNTIME,
  childFlag: process.env.ZCODE_PROTOCOL_STANDALONE_ACCOUNT_RUNTIME,
};

function isolateStandaloneEnv(): void {
  delete process.env.Z2C_STANDALONE_ACCOUNT_RUNTIME;
  delete process.env.ZCODE_PROTOCOL_STANDALONE_ACCOUNT_RUNTIME;
}

function restoreStandaloneEnv(): void {
  if (SAVED_STANDALONE_ENV.standalone === undefined) {
    delete process.env.Z2C_STANDALONE_ACCOUNT_RUNTIME;
  } else {
    process.env.Z2C_STANDALONE_ACCOUNT_RUNTIME = SAVED_STANDALONE_ENV.standalone;
  }
  if (SAVED_STANDALONE_ENV.childFlag === undefined) {
    delete process.env.ZCODE_PROTOCOL_STANDALONE_ACCOUNT_RUNTIME;
  } else {
    process.env.ZCODE_PROTOCOL_STANDALONE_ACCOUNT_RUNTIME = SAVED_STANDALONE_ENV.childFlag;
  }
}

interface Harness {
  provider: ZcodeOfficialProvider;
  stateDir: string;
  workspace: string;
  logPath: string;
}

async function buildHarness(opts?: {
  standaloneAccountRuntime?: boolean;
  envSecret?: boolean;
  /** Simulates a parent process that itself inherited the machine-wide opt-in. */
  inheritedChildFlag?: boolean;
}): Promise<Harness> {
  // The child must not inherit a machine-wide standalone opt-in; the flag is
  // cfg-derived only (official.ts sets it solely from standaloneAccountRuntime).
  isolateStandaloneEnv();
  // Applied after the scrub so adversarial tests control the parent env
  // explicitly; the module-load snapshot still restores it in afterEach.
  if (opts?.inheritedChildFlag) process.env.ZCODE_PROTOCOL_STANDALONE_ACCOUNT_RUNTIME = "1";
  const stateDir = mkdtempSync(join(tmpdir(), "z2c-standalone-"));
  const workspace = mkdtempSync(join(tmpdir(), "z2c-standalone-ws-"));
  const logPath = join(stateDir, "fixture-log.jsonl");
  process.env.FAKE_APP_SERVER_LOG = logPath;
  process.env.FAKE_APP_SERVER_STATE = join(stateDir, "fixture-state.json");
  if (opts?.envSecret) process.env.Z2C_MODEL_API_KEY = SECRET;
  const cfg = {
    ...loadConfig(),
    stateDir,
    zcodeCliPath: FAKE_APP_SERVER,
    standaloneAccountRuntime: opts?.standaloneAccountRuntime === true,
  };
  const provider = new ZcodeOfficialProvider(cfg);
  await provider.start();
  return { provider, stateDir, workspace, logPath };
}

async function stopHarness(h: Harness): Promise<void> {
  await h.provider.stop();
  rmSync(h.stateDir, { recursive: true, force: true });
  rmSync(h.workspace, { recursive: true, force: true });
  delete process.env.FAKE_APP_SERVER_LOG;
  delete process.env.FAKE_APP_SERVER_STATE;
  delete process.env.Z2C_MODEL_API_KEY;
}

interface FixtureLine {
  method: string;
  hasKeyMaterial: boolean;
  standaloneAccountRuntime: boolean;
}

function readFixtureLog(h: Harness): FixtureLine[] {
  if (!existsSync(h.logPath)) return [];
  return readFileSync(h.logPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as FixtureLine);
}

function readAuditEvents(h: Harness): Array<Record<string, unknown>> {
  const auditPath = join(h.stateDir, "audit", "audit.log");
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("standalone account runtime opt-in (config semantics)", () => {
  beforeEach(isolateStandaloneEnv);
  afterEach(restoreStandaloneEnv);

  // normalization is exercised through loadConfig() to keep the security
  // test's export allow-list for config.ts intact (fail-closed semantics
  // live inside the module, not on its public surface).
  it("is fail-closed: only 1/true enable; everything else (incl. unset) is false", () => {
    const raw = (v: string | undefined) => {
      process.env.Z2C_STANDALONE_ACCOUNT_RUNTIME = v as string;
      return loadConfig().standaloneAccountRuntime;
    };
    assert.equal(loadConfig().standaloneAccountRuntime, false);
    assert.equal(raw(""), false);
    assert.equal(raw("0"), false);
    assert.equal(raw("false"), false);
    assert.equal(raw("yes"), false);
    assert.equal(raw("on"), false);
    assert.equal(raw("1"), true);
    assert.equal(raw(" true "), true);
    assert.equal(raw("TRUE"), true);
  });

  it("loadConfig defaults to disabled when the env is absent", () => {
    delete process.env.Z2C_STANDALONE_ACCOUNT_RUNTIME;
    assert.equal(loadConfig().standaloneAccountRuntime, false);
  });

  it("loadConfig honors an explicit opt-in", () => {
    process.env.Z2C_STANDALONE_ACCOUNT_RUNTIME = "1";
    assert.equal(loadConfig().standaloneAccountRuntime, true);
  });
});

describe("official provider child env carries the opt-in flag", () => {
  afterEach(restoreStandaloneEnv);

  it("default: child env has NO standalone flag and the audit records false", async () => {
    const h = await buildHarness();
    try {
      assert.equal(h.provider.status, "healthy");
      const first = readFixtureLog(h).find((l) => l.method === "runtime/capabilities");
      assert.ok(first, "fixture must have observed the capabilities probe");
      assert.equal(first.standaloneAccountRuntime, false);
      const event = readAuditEvents(h).find((e) => e.event === "provider.configSource");
      assert.ok(event, "startup audit event must exist");
      assert.equal(event.standaloneAccountRuntime, false);
    } finally {
      await stopHarness(h);
    }
  });

  it("opt-in: child env carries ZCODE_PROTOCOL_STANDALONE_ACCOUNT_RUNTIME=1 and the audit records true", async () => {
    const h = await buildHarness({ standaloneAccountRuntime: true });
    try {
      assert.equal(h.provider.status, "healthy");
      const first = readFixtureLog(h).find((l) => l.method === "runtime/capabilities");
      assert.ok(first);
      assert.equal(first.standaloneAccountRuntime, true);
      const event = readAuditEvents(h).find((e) => e.event === "provider.configSource");
      assert.ok(event);
      assert.equal(event.standaloneAccountRuntime, true);
    } finally {
      await stopHarness(h);
    }
  });

  // Adversarial: the parent process itself carries the machine-wide "1".
  // cfg=false must strip it before spawn (regression for the pass-through
  // leak where an inherited flag silently opted the child in); cfg=true must
  // still opt the child in explicitly.
  it("adversarial: parent env carries the flag but cfg=false strips it before spawn", async () => {
    const h = await buildHarness({ standaloneAccountRuntime: false, inheritedChildFlag: true });
    try {
      assert.equal(h.provider.status, "healthy");
      const first = readFixtureLog(h).find((l) => l.method === "runtime/capabilities");
      assert.ok(first, "fixture must have observed the capabilities probe");
      assert.equal(first.standaloneAccountRuntime, false);
      const event = readAuditEvents(h).find((e) => e.event === "provider.configSource");
      assert.ok(event, "startup audit event must exist");
      assert.equal(event.standaloneAccountRuntime, false);
    } finally {
      await stopHarness(h);
    }
  });

  it("adversarial: parent env carries the flag and cfg=true still opts the child in", async () => {
    const h = await buildHarness({ standaloneAccountRuntime: true, inheritedChildFlag: true });
    try {
      assert.equal(h.provider.status, "healthy");
      const first = readFixtureLog(h).find((l) => l.method === "runtime/capabilities");
      assert.ok(first);
      assert.equal(first.standaloneAccountRuntime, true);
      const event = readAuditEvents(h).find((e) => e.event === "provider.configSource");
      assert.ok(event);
      assert.equal(event.standaloneAccountRuntime, true);
    } finally {
      await stopHarness(h);
    }
  });

  it("credential scrub still holds with the opt-in enabled (secret never reaches the child)", async () => {
    const h = await buildHarness({ standaloneAccountRuntime: true, envSecret: true });
    try {
      assert.equal(h.provider.status, "healthy");
      const lines = readFixtureLog(h).filter((l) => l.method === "runtime/capabilities");
      assert.ok(lines.length > 0);
      for (const line of lines) {
        assert.equal(line.hasKeyMaterial, false, "legacy key material must be scrubbed");
        assert.equal(line.standaloneAccountRuntime, true);
      }
    } finally {
      await stopHarness(h);
    }
  });
});
