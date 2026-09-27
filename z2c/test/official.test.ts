import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZcodeOfficialProvider, OFFICIAL_BINDING_SOURCE } from "../src/providers/zcode/official.js";
import { loadConfig } from "../src/config.js";

const FAKE_APP_SERVER = join(process.cwd(), "test", "fixtures", "fake-app-server.mjs");
const SECRET = "z2c-test-secret-do-not-leak-9f2c";

interface Harness {
  provider: ZcodeOfficialProvider;
  workspace: { workspacePath: string; workspaceKey: string };
  stateDir: string;
  logPath: string;
  envWithSecret: boolean;
}

async function buildHarness(opts?: { envSecret?: boolean; requestedModelId?: string | null; requestedThoughtLevel?: string | null }): Promise<Harness> {
  const stateDir = mkdtempSync(join(tmpdir(), "z2c-official-"));
  const workspace = mkdtempSync(join(tmpdir(), "z2c-official-ws-"));
  const logPath = join(stateDir, "fixture-log.jsonl");
  process.env.FAKE_APP_SERVER_LOG = logPath;
  process.env.FAKE_APP_SERVER_STATE = join(stateDir, "fixture-state.json");
  const cfg = {
    ...loadConfig(),
    stateDir,
    zcodeCliPath: FAKE_APP_SERVER,
    // If the parent env carries the legacy key material, the provider must
    // scrub it before spawn; the fixture reports what it actually saw.
    requestedModelId: opts && opts.requestedModelId !== undefined ? opts.requestedModelId : "GLM-5.3-Flash",
    requestedThoughtLevel: opts && opts.requestedThoughtLevel !== undefined ? opts.requestedThoughtLevel : "max",
  };
  const provider = new ZcodeOfficialProvider(cfg);
  if (opts?.envSecret) process.env.Z2C_MODEL_API_KEY = SECRET;
  await provider.start();
  return {
    provider,
    workspace: { workspacePath: workspace, workspaceKey: workspace },
    stateDir,
    logPath,
    envWithSecret: Boolean(opts?.envSecret),
  };
}

async function stopHarness(h: Harness): Promise<void> {
  await h.provider.stop();
  rmSync(h.stateDir, { recursive: true, force: true });
  rmSync(h.workspace.workspacePath, { recursive: true, force: true });
  delete process.env.Z2C_MODEL_API_KEY;
  delete process.env.FAKE_APP_SERVER_LOG;
  delete process.env.FAKE_APP_SERVER_STATE;
}

function readFixtureLog(h: Harness): Array<{ method: string; hasKeyMaterial: boolean }> {
  if (!existsSync(h.logPath)) return [];
  return readFileSync(h.logPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { method: string; hasKeyMaterial: boolean });
}

describe("ZcodeOfficialProvider (official open-source app-server contract)", () => {
  it("starts healthy via runtime/capabilities discovery", async () => {
    const h = await buildHarness();
    try {
      assert.equal(h.provider.status, "healthy");
      assert.deepEqual(h.provider.getRuntimeCapabilities(), { independentPlanState: true });
      assert.equal(h.provider.capabilityResult?.ok, true);
      for (const m of ["session/create", "session/send", "session/list", "session/stop", "session/read"]) {
        assert.equal(h.provider.capabilityResult?.required[m], "present", m);
      }
      assert.equal(h.provider.providerVersion, "0.16.9");
    } finally {
      await stopHarness(h);
    }
  });

  it("creates a native session and attests workspace + provider + model + thought level", async () => {
    const h = await buildHarness();
    try {
      const sessionId = await h.provider.createSession(h.workspace, {
        readonly: true,
        modelId: "GLM-5.3-Flash",
        thoughtLevel: "max",
      });
      assert.match(sessionId, /^sess_[0-9a-f-]{36}$/);
      const att = await h.provider.readSessionState(sessionId, h.workspace);
      assert.equal(att.sessionId, sessionId);
      assert.equal(att.workspaceKey, h.workspace.workspaceKey);
      assert.equal(att.workspacePath, h.workspace.workspacePath);
      assert.equal(att.providerId, "zai-api"); // resolved from ZCode's own state (same-provider request), never hardcoded
      assert.equal(att.modelId, "GLM-5.3-Flash");
      assert.equal(att.thoughtLevel, "max");
      // Readonly governance is proven by the v4 plan flag, NOT the legacy
      // mode field (the live runtime ignores plan at create).
      assert.equal(att.planEnabled, true);
    } finally {
      await stopHarness(h);
    }
  });

  it("readSessionBinding reports the exact session with the official evidence source", async () => {
    // Null policy: `{}`-create must leave the runtime DEFAULT model attested.
    const h = await buildHarness({ requestedModelId: null, requestedThoughtLevel: null });
    try {
      const a = await h.provider.createSession(h.workspace, {});
      const b = await h.provider.createSession(h.workspace, {});
      assert.notEqual(a, b);
      const binding = await h.provider.readSessionBinding(a, h.workspace);
      assert.ok(binding);
      assert.equal(binding.source, OFFICIAL_BINDING_SOURCE);
      assert.equal(binding.model_id, "GLM-5.3"); // created without requested model → runtime default attested
      // Exact-session readback: each session reports its own id/workspace.
      const otherWs = { workspacePath: "F:\\elsewhere", workspaceKey: "F:\\elsewhere" };
      assert.equal(await h.provider.readSessionBinding(a, otherWs), null); // workspace traversal rejected
      assert.equal(await h.provider.readSessionBinding("sess_00000000-0000-4000-8000-000000000000", h.workspace), null);
    } finally {
      await stopHarness(h);
    }
  });

  it("fails closed when the requested model is not offered by the runtime (session torn down)", async () => {
    const h = await buildHarness();
    try {
      await assert.rejects(
        async () => h.provider.createSession(h.workspace, { modelId: "GLM-9-Nonexistent" }),
        /rejected by this ZCode runtime|not offered by this ZCode runtime/,
      );
      // The unattested session was closed: nothing readable remains.
      const sessions = await h.provider.listSessions(h.workspace);
      assert.equal(sessions.length, 0);
    } finally {
      await stopHarness(h);
    }
  });

  it("fails closed when the requested thought level is not supported", async () => {
    const h = await buildHarness();
    try {
      await assert.rejects(
        async () => h.provider.createSession(h.workspace, { thoughtLevel: "ultra" }),
        /thought level ultra is not supported/,
      );
    } finally {
      await stopHarness(h);
    }
  });

  it("applies model/thought level and re-observes it after a same-session switch", async () => {
    const h = await buildHarness({ requestedModelId: null, requestedThoughtLevel: null });
    try {
      const sessionId = await h.provider.createSession(h.workspace, {});
      const result = await h.provider.updateSessionModel(h.workspace, sessionId, {
        modelId: "GLM-5.3-Flash",
        thoughtLevel: "max",
      });
      assert.equal(result.model_id, "GLM-5.3-Flash");
      assert.equal(result.thoughtLevel, "max");
      assert.equal(result.provider_id, "zai-api");
      await assert.rejects(
        async () => h.provider.updateSessionModel(h.workspace, sessionId, { modelId: "GLM-9-Nonexistent" }),
        /rejected by this ZCode runtime|not offered by this ZCode runtime/,
      );
    } finally {
      await stopHarness(h);
    }
  });

  it("establishes readonly lanes via the authoritative v4 CAS path (planEnabled observed, legacy mode ignored)", async () => {
    // The fixture mirrors live 0.16.9: plan requested at create is silently
    // ignored — the readonly guarantee must come from the v4 projection.
    const h = await buildHarness({ requestedModelId: null, requestedThoughtLevel: null });
    try {
      const sessionId = await h.provider.createSession(h.workspace, { readonly: true });
      const att = await h.provider.readSessionState(sessionId, h.workspace);
      assert.equal(att.planEnabled, true, "readonly session must attest planEnabled=true from the v4 projection");
      assert.equal(att.collaborationMode, "build"); // mode field unchanged (live behavior); the plan flag is authoritative
      assert.equal(att.bindingSource, OFFICIAL_BINDING_SOURCE);
      assert.equal(att.runtimeVersion, "0.16.9");
      assert.equal(att.providerId, "zai-api");
      // Switching back to a write mode clears the plan flag authoritatively.
      await h.provider.setSessionCollaborationMode!(sessionId, "edit");
      const after = await h.provider.readSessionState(sessionId, h.workspace);
      assert.equal(after.planEnabled, false);
      assert.equal(after.collaborationMode, "edit");
    } finally {
      await stopHarness(h);
    }
  });

  it("fails closed when the plan transition cannot be proven in the v4 state (session torn down)", async () => {
    process.env.FAKE_V4_DISABLE_PLAN = "1"; // command accepted but plan never established
    const h = await buildHarness({ requestedModelId: null, requestedThoughtLevel: null });
    try {
      await assert.rejects(
        async () => h.provider.createSession(h.workspace, { readonly: true }),
        /plan mode could not be established|was not observed|did not converge/i,
      );
      const sessions = await h.provider.listSessions(h.workspace);
      assert.equal(sessions.length, 0); // the unproven readonly session was closed
    } finally {
      delete process.env.FAKE_V4_DISABLE_PLAN;
      await stopHarness(h);
    }
  });

  it("recovers from a stale CAS verdict by refreshing the snapshot and retrying", async () => {
    process.env.FAKE_CAS_STALE_ONCE = "1"; // first switchCollaborationMode reports stale
    const h = await buildHarness({ requestedModelId: null, requestedThoughtLevel: null });
    try {
      const sessionId = await h.provider.createSession(h.workspace, { readonly: true });
      const att = await h.provider.readSessionState(sessionId, h.workspace);
      assert.equal(att.planEnabled, true); // retry after stale succeeded
    } finally {
      delete process.env.FAKE_CAS_STALE_ONCE;
      await stopHarness(h);
    }
  });

  it("plan evidence survives cold reconnect and resume", async () => {
    const h = await buildHarness({ requestedModelId: null, requestedThoughtLevel: null });
    try {
      const sessionId = await h.provider.createSession(h.workspace, { readonly: true, modelId: "GLM-5.3-Flash", thoughtLevel: "max" });
      // Real persisting turn so the session survives close (draft-only
      // sessions do not, mirroring live ZCode semantics).
      const handle = await h.provider.send({ sessionId, instruction: "plan probe", inputId: "z2c-plan-1", timeoutMs: 15000 });
      assert.equal((await handle.completion).status, "completed");
      await h.provider.stopSession(sessionId);
      await h.provider.closeSession(sessionId);
      await h.provider.stop();
      await h.provider.start();
      await h.provider.resumeSession(h.workspace, sessionId, { readonly: true });
      const v4 = await h.provider.subscribeSessionState(sessionId);
      assert.equal(v4.planEnabled, true, "plan must hold after readonly resume");
      assert.equal(v4.mode, "build"); // mode field unchanged; plan flag persisted
      const att = await h.provider.readSessionState(sessionId, h.workspace);
      assert.equal(att.modelId, "GLM-5.3-Flash"); // identity intact
      assert.equal(att.thoughtLevel, "max");
    } finally {
      await stopHarness(h);
    }
  });

  it("streams a turn: send resolves via session/event and output is scoped to the exact turn", async () => {
    const h = await buildHarness({ requestedModelId: null, requestedThoughtLevel: null });
    try {
      const sessionId = await h.provider.createSession(h.workspace, {});
      const marker = await h.provider.snapshotAssistantMarker(sessionId);
      assert.equal(marker, 0);
      const handle = await h.provider.send({
        sessionId,
        instruction: "Reply with exactly: Z2C OFFICIAL PATH OK",
        inputId: "z2c-test-input-1",
        timeoutMs: 15000,
      });
      const result = await handle.completion;
      assert.equal(result.status, "completed");
      const output = await h.provider.readAssistantOutput(sessionId, 16000, { minAssistantCount: marker });
      assert.match(output, /FAKE OFFICIAL REPLY/);
      // Second turn must not leak the first turn's reply (turn scoping).
      const marker2 = await h.provider.snapshotAssistantMarker(sessionId);
      assert.equal(marker2, 1);
      const handle2 = await h.provider.send({
        sessionId,
        instruction: "second turn",
        inputId: "z2c-test-input-2",
        timeoutMs: 15000,
      });
      assert.equal((await handle2.completion).status, "completed");
      const output2 = await h.provider.readAssistantOutput(sessionId, 16000, { minAssistantCount: marker2 });
      assert.match(output2, /second turn/);
      assert.doesNotMatch(output2, /Z2C OFFICIAL PATH OK/);
    } finally {
      await stopHarness(h);
    }
  });

  it("stops a running session and resumes it (reconnect + resume on the same session id)", async () => {
    const h = await buildHarness();
    try {
      const sessionId = await h.provider.createSession(h.workspace, { modelId: "GLM-5.3-Flash", thoughtLevel: "max" });
      await h.provider.send({ sessionId, instruction: "before stop", inputId: "z2c-in-1", timeoutMs: 15000 });
      await h.provider.stopSession(sessionId);

      // Reconnect: full provider restart, then cold resume of the same session.
      await h.provider.stop();
      await h.provider.start();
      await h.provider.resumeSession(h.workspace, sessionId);
      const att = await h.provider.readSessionState(sessionId, h.workspace);
      assert.equal(att.sessionId, sessionId);
      assert.equal(att.modelId, "GLM-5.3-Flash"); // binding survives resume
      assert.equal(att.thoughtLevel, "max");
      // Resumed history is scoped out of a fresh turn's output.
      const marker = await h.provider.snapshotAssistantMarker(sessionId);
      assert.equal(marker, 1);
      const handle = await h.provider.send({ sessionId, instruction: "after resume", inputId: "z2c-in-2", timeoutMs: 15000 });
      assert.equal((await handle.completion).status, "completed");
      const output = await h.provider.readAssistantOutput(sessionId, 16000, { minAssistantCount: marker });
      assert.match(output, /after resume/);
      assert.doesNotMatch(output, /before stop/);
      // Invalid session id format is rejected before any protocol traffic.
      await assert.rejects(async () => h.provider.resumeSession(h.workspace, "not-a-session-id"), /invalid ZCode session id/);
    } finally {
      await stopHarness(h);
    }
  });

  it("closes the native session cleanly (session/close removes it from the active list)", async () => {
    const h = await buildHarness();
    try {
      const sessionId = await h.provider.createSession(h.workspace, {});
      const before = await h.provider.listSessions(h.workspace);
      assert.equal(before.length, 1);
      await h.provider.closeSession?.(sessionId);
      // Close tears down the runtime: the session leaves the active list
      // (its record stays readable, like the real agent's closed sessions).
      const after = await h.provider.listSessions(h.workspace);
      assert.equal(after.length, 0);
    } finally {
      await stopHarness(h);
    }
  });

  it("never sends credential material, registry pushes, or legacy methods to the agent", async () => {
    const h = await buildHarness({ envSecret: true });
    try {
      const sessionId = await h.provider.createSession(h.workspace, { modelId: "GLM-5.3-Flash", thoughtLevel: "max" });
      await h.provider.send({ sessionId, instruction: "hi", inputId: "z2c-in-3", timeoutMs: 15000 });
      await h.provider.stopSession(sessionId);
      await h.provider.closeSession?.(sessionId);

      // Client-side view: the provider never emitted a registry push or any
      // legacy-lane method.
      const sent = h.provider.sentMethodNames;
      assert.ok(sent.length > 0);
      assert.equal(sent.includes("workspace/updateProviderRegistry"), false);
      assert.equal(sent.includes("session/updateRuntimeModelConfig"), false);
      for (const m of sent) assert.match(m, /^(session|runtime|workspace\/readPresentation|v4)\//, m);

      // Agent-side view: the fixture saw the same methods and NO key material
      // in its environment (the parent env DID carry the secret).
      const log = readFixtureLog(h);
      assert.ok(log.length > 0);
      for (const entry of log) {
        assert.equal(entry.hasKeyMaterial, false, `fixture saw key material on ${entry.method}`);
        assert.notEqual(entry.method, "workspace/updateProviderRegistry");
      }
      // The secret never appears in any provider-visible output surface.
      const output = await (async () => {
        try {
          return await h.provider.readAssistantOutput(sessionId, 16000);
        } catch {
          return ""; // session already closed — nothing to leak either way
        }
      })();
      assert.equal(output.includes(SECRET), false);
    } finally {
      await stopHarness(h);
    }
  });

  it("isolates from the legacy desktop lane: no registration state is read or written", { skip: process.platform !== "win32" }, async () => {
    const h = await buildHarness();
    try {
      const regDir = join(h.stateDir, "desktop-agents");
      assert.equal(existsSync(regDir), false);
      await h.provider.createSession(h.workspace, {});
      assert.equal(existsSync(regDir), false);
    } finally {
      await stopHarness(h);
    }
  });

  it("races a busy session: transient busy settles via bounded retry, persistent busy rejects", async () => {
    // Model the agent-side transient state right after a setter: the FIRST
    // send attempt hits "A prompt is already running", the retry succeeds.
    const h = await buildHarness();
    try {
      const { SessionService, LOCAL_PRINCIPAL } = await import("../src/service/sessions.js");
      const { loadWorkspaceGrants } = await import("../src/authz/grants.js");
      const { loadSessionOwnership } = await import("../src/authz/ownership.js");
      const { FileAuditLog } = await import("../src/util/log.js");
      const grants = loadWorkspaceGrants(h.stateDir);
      const grant = grants.authorize(h.workspace.workspacePath, { write: true });
      const svc = new SessionService({
        provider: h.provider,
        grants,
        ownership: loadSessionOwnership(h.stateDir),
        audit: new FileAuditLog(join(h.stateDir, "audit")),
        settleStepMs: 50,
        settleTotalMs: 2000,
      });
      const created = await svc.createSession(LOCAL_PRINCIPAL, { workspace_id: grant.workspaceId, access: "write" });
      const originalSend = h.provider.send.bind(h.provider);
      let busyAttempts = 0;
      h.provider.send = async (options: Parameters<typeof h.provider.send>[0]) => {
        if (busyAttempts++ === 0) {
          const err = new Error("ZCode Protocol error -32010: A prompt is already running for this session");
          throw err;
        }
        return originalSend(options);
      };
      const result = await svc.send(LOCAL_PRINCIPAL, { workspace_id: grant.workspaceId, session_id: created.session_id, instruction: "settle probe" });
      assert.equal(result.turn, "completed");
      assert.equal(busyAttempts, 2, "transient busy must be retried, not surfaced");
      // Persistent busy (real concurrent prompt) must reject within the window.
      const h2 = await buildHarness();
      try {
        const grants2 = loadWorkspaceGrants(h2.stateDir);
        const grant2 = grants2.authorize(h2.workspace.workspacePath, { write: true });
        const svc2 = new SessionService({
          provider: h2.provider,
          grants: grants2,
          ownership: loadSessionOwnership(h2.stateDir),
          audit: new FileAuditLog(join(h2.stateDir, "audit")),
          settleStepMs: 50,
          settleTotalMs: 1000,
        });
        const created2 = await svc2.createSession(LOCAL_PRINCIPAL, { workspace_id: grant2.workspaceId, access: "write" });
        h2.provider.send = async () => {
          throw new Error("ZCode Protocol error -32010: A prompt is already running for this session");
        };
        await assert.rejects(
          () => svc2.send(LOCAL_PRINCIPAL, { workspace_id: grant2.workspaceId, session_id: created2.session_id, instruction: "x", timeout_ms: 12000 }),
          /already running|busy/,
        );
      } finally {
        await stopHarness(h2);
      }
    } finally {
      await stopHarness(h);
    }
  });

  describe("ZCode builtin provider config spawn environment", () => {
    // A ZCode Desktop developer shell exports ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    // these tests exercise the resolution itself, so scrub the inherited value.
    let inheritedBuiltinConfig: string | undefined;
    beforeEach(() => {
      inheritedBuiltinConfig = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
      delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    });
    afterEach(() => {
      if (inheritedBuiltinConfig === undefined) delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
      else process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = inheritedBuiltinConfig;
    });
    it("sets ZCODE_BUILTIN_PROVIDER_CONFIG_FILE when packaged 0.16.9 layout exists", () => {
      const dir = mkdtempSync(join(tmpdir(), "z2c-spawn-test-"));
      try {
        const glmDir = join(dir, "resources", "glm");
        const configDir = join(dir, "resources", "config", "provider");
        mkdirSync(glmDir, { recursive: true });
        mkdirSync(configDir, { recursive: true });
        const cliPath = join(glmDir, "zcode.cjs");
        const configPath = join(configDir, "zcode-builtin.json");
        writeFileSync(cliPath, "console.log('0.16.9');\n", "utf8");
        writeFileSync(configPath, '{"providers":[]}\n', "utf8");

        const provider = new ZcodeOfficialProvider({
          ...loadConfig(),
          zcodeCliPath: cliPath,
        });
        const env = (provider as unknown as { spawnEnv(): Record<string, string> }).spawnEnv();
        assert.equal(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, configPath);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("respects caller explicit override in spawnEnv", () => {
      const explicit = "D:\\custom\\explicit-zcode-builtin.json";
      const oldEnv = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
      process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = explicit;
      try {
        const provider = new ZcodeOfficialProvider(loadConfig());
        const env = (provider as unknown as { spawnEnv(): Record<string, string> }).spawnEnv();
        assert.equal(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, explicit);
      } finally {
        if (oldEnv === undefined) {
          delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
        } else {
          process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = oldEnv;
        }
      }
    });

    it("leaves ZCODE_BUILTIN_PROVIDER_CONFIG_FILE unset when config file is missing", () => {
      const nonExistentCli = join(tmpdir(), "missing-zcode-dir", "zcode.cjs");
      const provider = new ZcodeOfficialProvider({
        ...loadConfig(),
        zcodeCliPath: nonExistentCli,
      });
      const env = (provider as unknown as { spawnEnv(): Record<string, string> }).spawnEnv();
      assert.equal(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, undefined);
    });

    it("sets ZCODE_BUILTIN_PROVIDER_CONFIG_FILE in paths with spaces", () => {
      const dirWithSpaces = mkdtempSync(join(tmpdir(), "z2c spawn spaces dir-"));
      try {
        const glmDir = join(dirWithSpaces, "resources", "glm");
        const configDir = join(dirWithSpaces, "resources", "config", "provider");
        mkdirSync(glmDir, { recursive: true });
        mkdirSync(configDir, { recursive: true });
        const cliPath = join(glmDir, "zcode.cjs");
        const configPath = join(configDir, "zcode-builtin.json");
        writeFileSync(cliPath, "console.log('0.16.9');\n", "utf8");
        writeFileSync(configPath, '{"providers":[]}\n', "utf8");

        const provider = new ZcodeOfficialProvider({
          ...loadConfig(),
          zcodeCliPath: cliPath,
        });
        const env = (provider as unknown as { spawnEnv(): Record<string, string> }).spawnEnv();
        assert.equal(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, configPath);
        assert.ok(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE.includes("spawn spaces dir"));
      } finally {
        rmSync(dirWithSpaces, { recursive: true, force: true });
      }
    });
  });
});
