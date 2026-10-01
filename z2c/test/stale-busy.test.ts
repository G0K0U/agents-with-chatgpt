import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionService, LOCAL_PRINCIPAL } from "../src/service/sessions.js";
import { loadWorkspaceGrants } from "../src/authz/grants.js";
import { loadSessionOwnership } from "../src/authz/ownership.js";
import type { AgentProvider, SessionStateAttestation, ProviderSendOptions, ProviderRunHandle } from "../src/providers/types.js";
import { FileAuditLog } from "../src/util/log.js";

const CANONICAL = "f:\workspaces\engineering-ai";

function buildAttestation(sessionId: string, status: string | null = "idle"): SessionStateAttestation {
  return {
    sessionId,
    workspaceKey: CANONICAL,
    workspacePath: CANONICAL,
    providerId: "zai-api",
    modelId: "GLM-5.3-Flash",
    thoughtLevel: "max",
    collaborationMode: "edit",
    planEnabled: false,
    bindingSource: "official-session-read",
    runtimeVersion: "0.16.9",
    status,
    observedAt: new Date().toISOString(),
    availableModels: [{ providerId: "zai-api", modelId: "GLM-5.3-Flash", reasoningLevels: ["low", "high", "max"], reasoningDefaultLevel: "max" }],
  };
}

class TestableProvider {
  readonly name = "zcode-official";
  readonly usesDesktopManagedAuth = true;
  status = "healthy" as const;
  statusDetail = "testable";
  providerVersion = "0.16.9";
  capabilityResult = null;
  childPid = null;

  stopSessionCalls: string[] = [];
  closeSessionCalls: string[] = [];
  sendInvocations: ProviderSendOptions[] = [];
  reportedStatus: string | null = "idle";
  failReadSessionState: Error | null = null;
  turnStatusToReturn: "completed" | "failed" | "stopped" = "completed";
  /** Simulated app-server child generation (bumped on respawn). */
  runtimeGeneration = 0;

  /**
   * Function controlling behavior of send(): returns handle or throws error.
   */
  sendHandler: (options: ProviderSendOptions) => Promise<ProviderRunHandle> = async (options) => {
    return {
      sessionId: options.sessionId,
      completion: Promise.resolve({ status: this.turnStatusToReturn }),
    };
  };

  async start() {}
  async stop() {}

  async createSession(ws: { workspaceKey: string }): Promise<string> {
    return `sess_${randomUUID()}`;
  }

  async resumeSession(): Promise<void> {}

  readSessionStateHandler?: (sessionId: string) => Promise<SessionStateAttestation>;

  async readSessionState(sessionId: string, _ws: { workspaceKey: string }): Promise<SessionStateAttestation> {
    if (this.readSessionStateHandler) {
      return this.readSessionStateHandler(sessionId);
    }
    if (this.failReadSessionState) {
      throw this.failReadSessionState;
    }
    return buildAttestation(sessionId, this.reportedStatus);
  }

  async send(options: ProviderSendOptions): Promise<ProviderRunHandle> {
    this.sendInvocations.push(options);
    return this.sendHandler(options);
  }

  async snapshotAssistantMarker(): Promise<number> {
    return 0;
  }

  async readAssistantOutput(sessionId: string, _maxChars: number, opts?: { minAssistantCount?: number }): Promise<string> {
    return `Assistant output for ${sessionId}`;
  }

  async stopSession(sessionId: string): Promise<void> {
    this.stopSessionCalls.push(sessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    this.closeSessionCalls.push(sessionId);
  }

  async setSessionCollaborationMode(): Promise<unknown> {
    return {};
  }

  async updateSessionModel(_ws: unknown, _sid: string, change: { modelId?: string }): Promise<{ provider_id: string; model_id: string; thoughtLevel: string | null }> {
    return { provider_id: "zai-api", model_id: change.modelId ?? "GLM-5.3-Flash", thoughtLevel: "max" };
  }

  async readSessionEvents(): Promise<Array<Record<string, unknown>>> {
    return [];
  }

  async readSessionMessages(): Promise<Array<Record<string, unknown>>> {
    return [];
  }

  async readSessionBinding(): Promise<{ provider_id: string; model_id: string; source: string } | null> {
    return null;
  }

  listSessions(): Array<Record<string, unknown>> {
    return [];
  }
}

interface TestContext {
  dir: string;
  ws: string;
  provider: TestableProvider;
  svc: SessionService;
  grantId: string;
  cleanup: () => void;
}

function setupTestContext(settleTotalMs = 100, settleStepMs = 20, settleLagMs = 0): TestContext {
  const dir = mkdtempSync(join(tmpdir(), "z2c-stale-"));
  const ws = mkdtempSync(join(tmpdir(), "z2c-stale-ws-"));
  const grants = loadWorkspaceGrants(dir);
  const grant = grants.authorize(ws, { write: true });
  const provider = new TestableProvider();
  const svc = new SessionService({
    provider: provider as unknown as AgentProvider,
    grants,
    ownership: loadSessionOwnership(dir),
    audit: new FileAuditLog(join(dir, "audit")),
    settleTotalMs,
    settleStepMs,
    settleLagMs,
  });
  return {
    dir,
    ws,
    provider,
    svc,
    grantId: grant.workspaceId,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    },
  };
}

describe("SessionService stale-busy recovery and safety gates", () => {
  it("completed turn -> stale -32010 + authoritative idle -> exactly one session/stop -> retry succeeds on SAME session", async () => {
    const ctx = setupTestContext();
    try {
      const created = await ctx.svc.createSession(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, access: "write" });
      const sessionId = created.session_id;

      // Turn 1 completes cleanly through the provider completion path
      const turn1 = await ctx.svc.send(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, session_id: sessionId, instruction: "turn 1" });
      assert.equal(turn1.turn, "completed");
      assert.deepEqual(ctx.provider.sendInvocations[0].executionGrant, {
        workspacePath: ctx.ws.toLowerCase(), write: true, mode: "machine-local-development",
      });
      assert.equal(ctx.provider.stopSessionCalls.length, 0, "Turn 1 must not call stopSession");

      // Turn 2: simulate ZCode 0.16.9 stuck prompt state where send throws -32010
      // but authoritative readSessionState reports 'idle'. When stopSession is invoked,
      // the controller clears and the subsequent retry succeeds.
      let busy = true;
      ctx.provider.reportedStatus = "idle";
      ctx.provider.sendHandler = async (options) => {
        if (busy) {
          throw new Error("ZCode Protocol error -32010: A prompt is already running for this session");
        }
        return {
          sessionId: options.sessionId,
          completion: Promise.resolve({ status: "completed" }),
        };
      };

      // When stopSession is called, it clears the stuck prompt
      const originalStopSession = ctx.provider.stopSession.bind(ctx.provider);
      ctx.provider.stopSession = async (sid: string) => {
        await originalStopSession(sid);
        busy = false; // native prompt aborted, next send will succeed
      };

      const sendsBeforeRecovery = ctx.provider.sendInvocations.length;
      const turn2 = await ctx.svc.send(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, session_id: sessionId, instruction: "turn 2" });
      for (const send of ctx.provider.sendInvocations) {
        assert.deepEqual(send.executionGrant, ctx.provider.sendInvocations[0].executionGrant);
      }
      assert.equal(turn2.turn, "completed");
      const recoverySends = ctx.provider.sendInvocations.slice(sendsBeforeRecovery);
      assert.ok(recoverySends.length >= 3, "normal settle retries precede recovery");
      assert.ok(recoverySends.every((send) => send.sessionId === sessionId && send.instruction === "turn 2"));
      assert.equal(turn2.state.session_id, sessionId, "Turn 2 must preserve the exact SAME session id");
      assert.equal(ctx.provider.stopSessionCalls.length, 1, "Must call stopSession exactly ONCE");
      assert.equal(ctx.provider.stopSessionCalls[0], sessionId, "stopSession must target the exact session id");
      assert.equal(ctx.provider.closeSessionCalls.length, 0, "Must NEVER close or replace the session");

      // Subsequent turn with no stale busy must succeed normally without calling stopSession again
      const turn3 = await ctx.svc.send(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, session_id: sessionId, instruction: "turn 3" });
      assert.equal(turn3.turn, "completed");
      assert.equal(ctx.provider.stopSessionCalls.length, 1, "Normal subsequent turn must not call stopSession");
    } finally {
      ctx.cleanup();
    }
  });

  it("a genuinely running state never invokes stop and remains SESSION_BUSY", async () => {
    const ctx = setupTestContext();
    try {
      const created = await ctx.svc.createSession(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, access: "write" });
      const sessionId = created.session_id;

      // Turn 1 completes
      await ctx.svc.send(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, session_id: sessionId, instruction: "turn 1" });

      // Turn 2 hits -32010 and authoritative readSessionState reports "running" (genuinely active prompt)
      ctx.provider.reportedStatus = "running";
      ctx.provider.sendHandler = async () => {
        throw new Error("ZCode Protocol error -32010: A prompt is already running for this session");
      };

      await assert.rejects(
        () => ctx.svc.send(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, session_id: sessionId, instruction: "turn 2" }),
        (err: { code?: string; httpStatus?: number }) => err.code === "SESSION_BUSY" && err.httpStatus === 409,
      );

      assert.equal(ctx.provider.stopSessionCalls.length, 0, "stopSession must NEVER be called when state is running");
    } finally {
      ctx.cleanup();
    }
  });

  it("a fresh/new session with no prior completed-turn evidence never invokes stop even if read state looks idle", async () => {
    const ctx = setupTestContext();
    try {
      const created = await ctx.svc.createSession(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, access: "write" });
      const sessionId = created.session_id;

      // Turn 1 immediately gets -32010, even though readSessionState returns "idle"
      ctx.provider.reportedStatus = "idle";
      ctx.provider.sendHandler = async () => {
        throw new Error("ZCode Protocol error -32010: A prompt is already running for this session");
      };

      await assert.rejects(
        () => ctx.svc.send(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, session_id: sessionId, instruction: "turn 1" }),
        (err: { code?: string; httpStatus?: number }) => err.code === "SESSION_BUSY" && err.httpStatus === 409,
      );

      assert.equal(ctx.provider.stopSessionCalls.length, 0, "Fresh session with no prior completed turn must NEVER invoke stopSession");
    } finally {
      ctx.cleanup();
    }
  });

  it("ambiguous/read failure never invokes stop", async () => {
    const ctx = setupTestContext();
    try {
      const created = await ctx.svc.createSession(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, access: "write" });
      const sessionId = created.session_id;

      // Turn 1 completes
      await ctx.svc.send(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, session_id: sessionId, instruction: "turn 1" });

      // Case A: authoritative readSessionState throws an Error during Gate 2B check
      let readCount = 0;
      ctx.provider.readSessionStateHandler = async (sid) => {
        readCount++;
        if (readCount === 1) {
          // Pre-send attestation succeeds
          return buildAttestation(sid, "idle");
        }
        // Gate 2B fresh state read throws
        throw new Error("session/read transport error");
      };
      ctx.provider.sendHandler = async () => {
        throw new Error("ZCode Protocol error -32010: A prompt is already running for this session");
      };

      await assert.rejects(
        () => ctx.svc.send(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, session_id: sessionId, instruction: "turn 2" }),
        (err: { code?: string; httpStatus?: number }) => err.code === "SESSION_BUSY" && err.httpStatus === 409,
      );
      assert.equal(ctx.provider.stopSessionCalls.length, 0, "Read failure must NEVER invoke stopSession");

      // Reset handler
      ctx.provider.readSessionStateHandler = undefined;

      // Complete another turn so positive evidence is freshly established
      ctx.provider.sendHandler = async (options) => ({
        sessionId: options.sessionId,
        completion: Promise.resolve({ status: "completed" }),
      });
      await ctx.svc.send(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, session_id: sessionId, instruction: "turn 1b" });

      // Case B: ambiguous status (null)
      ctx.provider.reportedStatus = null;
      ctx.provider.sendHandler = async () => {
        throw new Error("ZCode Protocol error -32010: A prompt is already running for this session");
      };

      await assert.rejects(
        () => ctx.svc.send(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, session_id: sessionId, instruction: "turn 2b" }),
        (err: { code?: string; httpStatus?: number }) => err.code === "SESSION_BUSY" && err.httpStatus === 409,
      );
      assert.equal(ctx.provider.stopSessionCalls.length, 0, "Ambiguous (null) status must NEVER invoke stopSession");

      // Case C: unknown status string
      ctx.provider.reportedStatus = "unknown_state";
      await assert.rejects(
        () => ctx.svc.send(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, session_id: sessionId, instruction: "turn 2c" }),
        (err: { code?: string; httpStatus?: number }) => err.code === "SESSION_BUSY" && err.httpStatus === 409,
      );
      assert.equal(ctx.provider.stopSessionCalls.length, 0, "Unknown status string must NEVER invoke stopSession");
    } finally {
      ctx.cleanup();
    }
  });

  it("normal sequential turns with no stale busy do not call stop", async () => {
    const ctx = setupTestContext();
    try {
      const created = await ctx.svc.createSession(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, access: "write" });
      const sessionId = created.session_id;

      for (let i = 1; i <= 4; i++) {
        const res = await ctx.svc.send(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, session_id: sessionId, instruction: `turn ${i}` });
        assert.equal(res.turn, "completed");
      }

      assert.equal(ctx.provider.stopSessionCalls.length, 0, "Sequential turns with no stale busy must never invoke stopSession");
    } finally {
      ctx.cleanup();
    }
  });

  it("failed-turn cleanup remains unchanged", async () => {
    const ctx = setupTestContext();
    try {
      const created = await ctx.svc.createSession(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, access: "write" });
      const sessionId = created.session_id;

      // Turn 1 fails during turn execution
      ctx.provider.turnStatusToReturn = "failed";
      await assert.rejects(
        () => ctx.svc.send(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, session_id: sessionId, instruction: "turn 1" }),
        (err: { code?: string; httpStatus?: number }) => err.code === "TURN_FAILED" && err.httpStatus === 502,
      );

      // Turn 2 gets -32010 and status is idle
      ctx.provider.reportedStatus = "idle";
      ctx.provider.sendHandler = async () => {
        throw new Error("ZCode Protocol error -32010: A prompt is already running for this session");
      };

      // Because Turn 1 failed, there is NO positive evidence of a completed turn
      await assert.rejects(
        () => ctx.svc.send(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, session_id: sessionId, instruction: "turn 2" }),
        (err: { code?: string; httpStatus?: number }) => err.code === "SESSION_BUSY" && err.httpStatus === 409,
      );

      assert.equal(ctx.provider.stopSessionCalls.length, 0, "Failed preceding turn must NOT allow stopSession recovery");
    } finally {
      ctx.cleanup();
    }
  });

  it("consumed eligibility: repeated unrelated -32010 after recovery cannot repeatedly call stopSession", async () => {
    const ctx = setupTestContext();
    try {
      const created = await ctx.svc.createSession(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, access: "write" });
      const sessionId = created.session_id;

      // Turn 1 completes
      await ctx.svc.send(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, session_id: sessionId, instruction: "turn 1" });

      // Turn 2: recovery is qualified, stopSession is called once, but retry STILL fails with -32010
      ctx.provider.reportedStatus = "idle";
      ctx.provider.sendHandler = async () => {
        throw new Error("ZCode Protocol error -32010: A prompt is already running for this session");
      };

      await assert.rejects(
        () => ctx.svc.send(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, session_id: sessionId, instruction: "turn 2" }),
        (err: { code?: string; httpStatus?: number }) => err.code === "SESSION_BUSY" && err.httpStatus === 409,
      );

      assert.equal(ctx.provider.stopSessionCalls.length, 1, "Recovery must invoke stopSession once on qualified stale-busy");

      // Turn 3: immediate next send attempt also throws -32010.
      // Eligibility was consumed, so stopSession must NOT be called again.
      await assert.rejects(
        () => ctx.svc.send(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, session_id: sessionId, instruction: "turn 3" }),
        (err: { code?: string; httpStatus?: number }) => err.code === "SESSION_BUSY" && err.httpStatus === 409,
      );

      assert.equal(ctx.provider.stopSessionCalls.length, 1, "stopSession must NOT be called again after eligibility was consumed");
    } finally {
      ctx.cleanup();
    }
  });

  for (const status of ["completed", "busy", "UNKNOWN", "unknown_state", "IDLE", " idle ", null, undefined]) {
    it(`rejects non-exact idle state ${String(status)} with fresh completion evidence`, async () => {
      const ctx = setupTestContext(0);
      try {
        const created = await ctx.svc.createSession(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, access: "write" });
        const req = { workspace_id: ctx.grantId, session_id: created.session_id, instruction: "original" };
        await ctx.svc.send(LOCAL_PRINCIPAL, req);
        ctx.provider.readSessionStateHandler = async (sid) => ({ ...buildAttestation(sid), status } as SessionStateAttestation);
        ctx.provider.sendHandler = async () => { throw new Error("-32010"); };
        await assert.rejects(ctx.svc.send(LOCAL_PRINCIPAL, req), { code: "SESSION_BUSY" });
        assert.equal(ctx.provider.stopSessionCalls.length, 0);
      } finally { ctx.cleanup(); }
    });
  }

  it("restart with RUNTIME evidence: no in-memory evidence, but authoritative idle + prior assistant history recovers exactly once", async () => {
    const ctx = setupTestContext();
    try {
      const created = await ctx.svc.createSession(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, access: "write" });
      const sessionId = created.session_id;

      // Simulate a service restart: in-memory completed-turn evidence is gone
      // (fresh SessionService). The runtime itself still proves the previous
      // turn: status idle + assistant history exists (marker > 0).
      ctx.provider.snapshotAssistantMarker = async () => 1;
      ctx.provider.reportedStatus = "idle";
      let busy = true;
      ctx.provider.sendHandler = async (options) => {
        if (busy) {
          throw new Error("ZCode Protocol error -32010: A prompt is already running for this session");
        }
        return { sessionId: options.sessionId, completion: Promise.resolve({ status: "completed" }) };
      };
      const originalStopSession = ctx.provider.stopSession.bind(ctx.provider);
      ctx.provider.stopSession = async (sid: string) => {
        await originalStopSession(sid);
        busy = false;
      };

      const turn = await ctx.svc.send(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, session_id: sessionId, instruction: "post-restart turn" });
      assert.equal(turn.turn, "completed");
      assert.equal(ctx.provider.stopSessionCalls.length, 1, "runtime evidence authorizes exactly one stop");
      assert.equal(ctx.provider.stopSessionCalls[0], sessionId);
      assert.equal(ctx.provider.closeSessionCalls.length, 0);
    } finally {
      ctx.cleanup();
    }
  });

  it("runtime generation change invalidates in-memory completed-turn evidence (no marker history -> never stops)", async () => {
    const ctx = setupTestContext();
    try {
      const created = await ctx.svc.createSession(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, access: "write" });
      const sessionId = created.session_id;
      const turn1 = await ctx.svc.send(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, session_id: sessionId, instruction: "turn 1" });
      assert.equal(turn1.turn, "completed");

      // The app-server child respawned: in-memory evidence from generation 0
      // must not authorize a stop in generation 1 (marker has no history).
      ctx.provider.runtimeGeneration = 1;
      ctx.provider.reportedStatus = "idle";
      ctx.provider.sendHandler = async () => {
        throw new Error("ZCode Protocol error -32010: A prompt is already running for this session");
      };
      await assert.rejects(
        () => ctx.svc.send(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, session_id: sessionId, instruction: "turn 2" }),
        (err: { code?: string }) => err.code === "SESSION_BUSY",
      );
      assert.equal(ctx.provider.stopSessionCalls.length, 0, "stale generation evidence must never authorize a stop");
    } finally {
      ctx.cleanup();
    }
  });

  it("runtime generation change still allows RUNTIME-evidence recovery (idle + prior history)", async () => {
    const ctx = setupTestContext();
    try {
      const created = await ctx.svc.createSession(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, access: "write" });
      const sessionId = created.session_id;
      await ctx.svc.send(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, session_id: sessionId, instruction: "turn 1" });
      ctx.provider.runtimeGeneration = 1;
      ctx.provider.snapshotAssistantMarker = async () => 1;
      ctx.provider.reportedStatus = "idle";
      let busy = true;
      ctx.provider.sendHandler = async (options) => {
        if (busy) {
          throw new Error("ZCode Protocol error -32010: A prompt is already running for this session");
        }
        return { sessionId: options.sessionId, completion: Promise.resolve({ status: "completed" }) };
      };
      const originalStopSession = ctx.provider.stopSession.bind(ctx.provider);
      ctx.provider.stopSession = async (sid: string) => { await originalStopSession(sid); busy = false; };
      const turn = await ctx.svc.send(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, session_id: sessionId, instruction: "turn 2" });
      assert.equal(turn.turn, "completed");
      assert.equal(ctx.provider.stopSessionCalls.length, 1);
    } finally {
      ctx.cleanup();
    }
  });

  it("concurrent busy sends can consume completed evidence only once", async () => {
    const ctx = setupTestContext(0);
    try {
      const created = await ctx.svc.createSession(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, access: "write" });
      const req = { workspace_id: ctx.grantId, session_id: created.session_id, instruction: "original" };
      await ctx.svc.send(LOCAL_PRINCIPAL, req);
      ctx.provider.sendHandler = async () => { throw new Error("-32010"); };
      await Promise.all([
        assert.rejects(ctx.svc.send(LOCAL_PRINCIPAL, req), { code: "SESSION_BUSY" }),
        assert.rejects(ctx.svc.send(LOCAL_PRINCIPAL, req), { code: "SESSION_BUSY" }),
      ]);
      assert.deepEqual(ctx.provider.stopSessionCalls, [created.session_id]);
      assert.equal(ctx.provider.closeSessionCalls.length, 0);
    } finally { ctx.cleanup(); }
  });

  it("an accepted failed turn consumes earlier completed evidence", async () => {
    const ctx = setupTestContext(0);
    try {
      const created = await ctx.svc.createSession(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, access: "write" });
      const req = { workspace_id: ctx.grantId, session_id: created.session_id, instruction: "original" };
      await ctx.svc.send(LOCAL_PRINCIPAL, req);
      ctx.provider.turnStatusToReturn = "failed";
      await assert.rejects(ctx.svc.send(LOCAL_PRINCIPAL, req), { code: "TURN_FAILED" });
      ctx.provider.sendHandler = async () => { throw new Error("-32010"); };
      await assert.rejects(ctx.svc.send(LOCAL_PRINCIPAL, req), { code: "SESSION_BUSY" });
      assert.equal(ctx.provider.stopSessionCalls.length, 0);
    } finally { ctx.cleanup(); }
  });

  it("stop failure propagates without retrying or rearming recovery", async () => {
    const ctx = setupTestContext(0);
    try {
      const created = await ctx.svc.createSession(LOCAL_PRINCIPAL, { workspace_id: ctx.grantId, access: "write" });
      const req = { workspace_id: ctx.grantId, session_id: created.session_id, instruction: "original" };
      await ctx.svc.send(LOCAL_PRINCIPAL, req);
      ctx.provider.sendHandler = async () => { throw new Error("-32010"); };
      ctx.provider.stopSession = async (sid) => {
        ctx.provider.stopSessionCalls.push(sid);
        throw new Error("stop failed");
      };
      await assert.rejects(ctx.svc.send(LOCAL_PRINCIPAL, req), /stop failed/);
      assert.equal(ctx.provider.sendInvocations.length, 2, "no send retry after stop failure");
      await assert.rejects(ctx.svc.send(LOCAL_PRINCIPAL, req), { code: "SESSION_BUSY" });
      assert.deepEqual(ctx.provider.stopSessionCalls, [created.session_id]);
    } finally { ctx.cleanup(); }
  });

});
