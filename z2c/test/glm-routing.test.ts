import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZcodeOfficialProvider } from "../src/providers/zcode/official.js";
import { loadConfig } from "../src/config.js";

/**
 * Table-driven GLM routing proof (2026-09-28 catalog policy): EVERY model the
 * runtime advertises × THAT model's own advertised reasoning levels must be
 * callable (create → attested readback; same-session switches), and anything
 * not advertised must fail closed — with no single-model constant anywhere
 * (neither Flash-only nor GLM-5.3-only) and no provider-registry push.
 *
 * Fixture: FAKE_APP_SERVER_FULL_CATALOG=1 advertises BOTH models with
 * DIFFERENT per-model level sets:
 *   GLM-5.3        → [medium, high, max]  (no low)
 *   GLM-5.3-Flash  → [low, high, max]     (no medium)
 * FAKE_APP_SERVER_EXTRA_MODEL adds a future model (GLM-5.4 → [low, medium]).
 */
const FAKE_APP_SERVER = join(process.cwd(), "test", "fixtures", "fake-app-server.mjs");

interface Harness {
  provider: ZcodeOfficialProvider;
  workspace: { workspacePath: string; workspaceKey: string };
  stateDir: string;
  wsDir: string;
}

async function buildHarness(extraModel?: string): Promise<Harness> {
  const stateDir = mkdtempSync(join(tmpdir(), "z2c-glm-"));
  const wsDir = mkdtempSync(join(tmpdir(), "z2c-glm-ws-"));
  process.env.FAKE_APP_SERVER_LOG = join(stateDir, "fixture-log.jsonl");
  process.env.FAKE_APP_SERVER_STATE = join(stateDir, "fixture-state.json");
  process.env.FAKE_APP_SERVER_FULL_CATALOG = "1";
  if (extraModel) process.env.FAKE_APP_SERVER_EXTRA_MODEL = extraModel;
  const cfg = { ...loadConfig(), stateDir, zcodeCliPath: FAKE_APP_SERVER, requestedModelId: null, requestedThoughtLevel: null };
  const provider = new ZcodeOfficialProvider(cfg);
  await provider.start();
  return { provider, workspace: { workspacePath: wsDir, workspaceKey: wsDir }, stateDir, wsDir };
}

async function stopHarness(h: Harness): Promise<void> {
  await h.provider.stop();
  rmSync(h.stateDir, { recursive: true, force: true });
  rmSync(h.wsDir, { recursive: true, force: true });
  delete process.env.FAKE_APP_SERVER_LOG;
  delete process.env.FAKE_APP_SERVER_STATE;
  delete process.env.FAKE_APP_SERVER_FULL_CATALOG;
  delete process.env.FAKE_APP_SERVER_EXTRA_MODEL;
}

/** The per-model advertised levels the fixture publishes (single truth). */
const ADVERTISED: Record<string, string[]> = {
  "GLM-5.3": ["medium", "high", "max"],
  "GLM-5.3-Flash": ["low", "high", "max"],
  "GLM-5.4": ["low", "medium"],
};

async function attest(h: Harness, sessionId: string) {
  return await h.provider.readSessionState(sessionId, h.workspace);
}

describe("GLM routing: every advertised model × its own advertised efforts", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness("GLM-5.4:low,medium");
  });
  afterEach(async () => {
    await stopHarness(h);
  });

  for (const [model, levels] of Object.entries(ADVERTISED)) {
    for (const effort of levels) {
      it(`create ${model}/${effort} → exact readback PASS`, async () => {
        const sessionId = await h.provider.createSession(h.workspace, { modelId: model, thoughtLevel: effort });
        const att = await attest(h, sessionId);
        assert.equal(att?.modelId, model);
        assert.equal(att?.thoughtLevel, effort);
        assert.equal(att?.providerId, "zai-api");
        // Availability evidence from the same snapshot includes the target.
        assert.ok(att?.availableModels?.some((m) => m.modelId === model && m.reasoningLevels.includes(effort)));
      });

      it(`same-session effort switch on ${model} to ${effort} → exact readback PASS`, async () => {
        const sessionId = await h.provider.createSession(h.workspace, { modelId: model });
        const result = await h.provider.updateSessionModel(h.workspace, sessionId, { thoughtLevel: effort });
        assert.equal(result.model_id, model);
        assert.equal(result.thoughtLevel, effort);
        const att = await attest(h, sessionId);
        assert.equal(att?.thoughtLevel, effort);
      });
    }

    it(`same-session model switch to ${model} → exact readback PASS (no effort request keeps target default)`, async () => {
      const sessionId = await h.provider.createSession(h.workspace, { modelId: "GLM-5.3-Flash", thoughtLevel: "low" });
      const result = await h.provider.updateSessionModel(h.workspace, sessionId, { modelId: model });
      assert.equal(result.model_id, model);
      const att = await attest(h, sessionId);
      assert.equal(att?.modelId, model);
      // No explicit effort: the session lands on a level ADVERTISED for the
      // target model (its default, or another advertised level) — never a
      // level from the previous model that the target does not advertise.
      const targetLevels = ADVERTISED[model]!;
      assert.ok(att?.thoughtLevel === null || targetLevels.includes(att.thoughtLevel),
        `observed effort ${att?.thoughtLevel} must be advertised for ${model}`);
    });

    it(`model+effort switch to ${model}/${ADVERTISED[model]![0]} in one update → exact readback PASS`, async () => {
      const sessionId = await h.provider.createSession(h.workspace, { modelId: "GLM-5.3", thoughtLevel: "max" });
      const result = await h.provider.updateSessionModel(h.workspace, sessionId, {
        modelId: model,
        thoughtLevel: ADVERTISED[model]![0]!,
      });
      assert.equal(result.model_id, model);
      assert.equal(result.thoughtLevel, ADVERTISED[model]![0]);
    });
  }

  it("rejects an unsupported model (fail closed, session torn down)", async () => {
    await assert.rejects(
      async () => h.provider.createSession(h.workspace, { modelId: "GLM-9-Nonexistent" }),
      /rejected by this ZCode runtime|not offered by this ZCode runtime/,
    );
    assert.equal((await h.provider.listSessions(h.workspace)).length, 0);
  });

  it("rejects an effort NOT advertised for the TARGET model even though the CURRENT model advertises it", async () => {
    // Session on Flash (advertises low); request GLM-5.3 (does NOT advertise low).
    const sessionId = await h.provider.createSession(h.workspace, { modelId: "GLM-5.3-Flash", thoughtLevel: "low" });
    await assert.rejects(
      async () => h.provider.updateSessionModel(h.workspace, sessionId, { modelId: "GLM-5.3", thoughtLevel: "low" }),
      /not advertised for the target model GLM-5.3/,
    );
    // Effort-only on the same model also enforces the target's own set.
    await assert.rejects(
      async () => h.provider.updateSessionModel(h.workspace, sessionId, { thoughtLevel: "medium" }),
      /not advertised/,
    );
  });

  it("rejects a provider route that does not offer the requested model (no route invention)", async () => {
    await assert.rejects(
      async () => h.provider.createSession(h.workspace, { modelId: "GLM-5.3", providerId: "builtin:elsewhere" }),
      /does not offer model|rejected by this ZCode runtime/,
    );
  });

  it("never pushes a provider registry (no silent route substitution surface)", async () => {
    const sessionId = await h.provider.createSession(h.workspace, { modelId: "GLM-5.3-Flash", thoughtLevel: "max" });
    await h.provider.updateSessionModel(h.workspace, sessionId, { modelId: "GLM-5.3" });
    assert.equal(h.provider.sentMethodNames.includes("workspace/updateProviderRegistry"), false);
  });
});

describe("GLM routing: partial catalog is never false absence (fail closed, never mis-admit)", () => {
  it("a snapshot without availability evidence rejects rather than treating the model as absent-or-present", async () => {
    // No FULL_CATALOG: the fixture's available[] carries no reasoning evidence
    // for a switch target → an explicit cross-model effort request must fail
    // closed (cannot prove), never silently execute.
    const stateDir = mkdtempSync(join(tmpdir(), "z2c-glm-partial-"));
    const wsDir = mkdtempSync(join(tmpdir(), "z2c-glm-partial-ws-"));
    process.env.FAKE_APP_SERVER_LOG = join(stateDir, "fixture-log.jsonl");
    process.env.FAKE_APP_SERVER_STATE = join(stateDir, "fixture-state.json");
    delete process.env.FAKE_APP_SERVER_FULL_CATALOG;
    delete process.env.FAKE_APP_SERVER_EXTRA_MODEL;
    const cfg = { ...loadConfig(), stateDir, zcodeCliPath: FAKE_APP_SERVER, requestedModelId: null, requestedThoughtLevel: null };
    const provider = new ZcodeOfficialProvider(cfg);
    try {
      await provider.start();
      const workspace = { workspacePath: wsDir, workspaceKey: wsDir };
      // Same-model effort switch still works via the current model's levels.
      const sessionId = await provider.createSession(workspace, { modelId: "GLM-5.3-Flash" });
      const result = await provider.updateSessionModel(workspace, sessionId, { thoughtLevel: "low" });
      assert.equal(result.thoughtLevel, "low");
      // Cross-model switch WITH an explicit effort: no target evidence → reject.
      await assert.rejects(
        async () => provider.updateSessionModel(workspace, sessionId, { modelId: "GLM-5.3", thoughtLevel: "medium" }),
        /not advertised|rejected by this ZCode runtime/,
      );
    } finally {
      await provider.stop();
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(wsDir, { recursive: true, force: true });
      delete process.env.FAKE_APP_SERVER_LOG;
      delete process.env.FAKE_APP_SERVER_STATE;
    }
  });
});
