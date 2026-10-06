import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZcodeOfficialProvider } from "../src/providers/zcode/official.js";
import { loadConfig } from "../src/config.js";

const FAKE_APP_SERVER = join(process.cwd(), "test", "fixtures", "fake-app-server.mjs");

interface Harness {
  provider: ZcodeOfficialProvider;
  stateDir: string;
  workspace: string;
}

async function buildHarness(opts?: { allowed?: string }): Promise<Harness> {
  const stateDir = mkdtempSync(join(tmpdir(), "z2c-plan-switch-"));
  const workspace = mkdtempSync(join(tmpdir(), "z2c-plan-switch-ws-"));
  process.env.FAKE_APP_SERVER_LOG = join(stateDir, "fixture-log.jsonl");
  process.env.FAKE_APP_SERVER_STATE = join(stateDir, "fixture-state.json");
  process.env.FAKE_ENTITLEMENT = "1";
  delete process.env.FAKE_ENTITLEMENT_ALLOWED;
  if (opts?.allowed) process.env.FAKE_ENTITLEMENT_ALLOWED = opts.allowed;
  const cfg = { ...loadConfig(), stateDir, zcodeCliPath: FAKE_APP_SERVER };
  const provider = new ZcodeOfficialProvider(cfg);
  await provider.start();
  return { provider, stateDir, workspace };
}

async function stopHarness(h: Harness): Promise<void> {
  await h.provider.stop();
  rmSync(h.stateDir, { recursive: true, force: true });
  rmSync(h.workspace, { recursive: true, force: true });
  delete process.env.FAKE_APP_SERVER_LOG;
  delete process.env.FAKE_APP_SERVER_STATE;
  delete process.env.FAKE_ENTITLEMENT;
  delete process.env.FAKE_ENTITLEMENT_ALLOWED;
}

describe("entitlement-constrained model switch (runtime is the authority)", () => {
  afterEach(() => {
    delete process.env.FAKE_ENTITLEMENT;
    delete process.env.FAKE_ENTITLEMENT_ALLOWED;
  });

  it("switches to a model absent from the current-model-scoped snapshot when the runtime serves it", async () => {
    // Regression (2026-10-01): the snapshot's model availability is scoped to
    // the CURRENT model, so a switch target is normally ABSENT from the
    // evidence. Zero evidence must not be treated as absence — the create
    // proceeds and the runtime's own per-setModel entitlement check decides.
    const h = await buildHarness({ allowed: "GLM-5.3,GLM-5.3-Flash" });
    try {
      const ws = { workspacePath: h.workspace, workspaceKey: h.workspace };
      // Session default is GLM-5.3; requesting Flash exercises the switch.
      const sessionId = await h.provider.createSession(ws, {
        readonly: true,
        entitlementPlan: "START",
        modelId: "GLM-5.3-Flash",
        thoughtLevel: "max",
      });
      const att = await h.provider.readSessionState(sessionId, ws);
      assert.equal(att.modelId, "GLM-5.3-Flash");
      assert.equal(att.thoughtLevel, "max");
      assert.equal(att.entitlement?.observed, "START");
      assert.equal(att.entitlement?.source, "provider-registry");
    } finally {
      await stopHarness(h);
    }
  });

  it("fails closed with the RUNTIME's verdict when the plan does not declare the model", async () => {
    const h = await buildHarness({ allowed: "GLM-5.3" });
    try {
      const ws = { workspacePath: h.workspace, workspaceKey: h.workspace };
      await assert.rejects(
        () =>
          h.provider.createSession(ws, {
            readonly: true,
            entitlementPlan: "START",
            modelId: "GLM-5.3-Flash",
            thoughtLevel: "max",
          }),
        /rejected by this ZCode runtime|does not declare model/,
      );
    } finally {
      await stopHarness(h);
    }
  });
});
