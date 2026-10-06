import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionService, SessionServiceError } from "../src/service/sessions.js";
import { loadWorkspaceGrants } from "../src/authz/grants.js";
import { loadSessionOwnership } from "../src/authz/ownership.js";
import { LOCAL_PRINCIPAL, type Principal } from "../src/authz/pairing.js";
import { FileAuditLog } from "../src/util/log.js";
import type { AgentProvider, SessionStateAttestation } from "../src/providers/types.js";

/**
 * Shared agent-plane observation: native session/list discovery + local-only
 * observe (state + messages) for sessions that were NOT created through Z2C.
 * OBSERVE and CONTROL are separate capabilities: paired clients can neither
 * discover nor observe foreign native sessions, and ownership control stays
 * fail-closed even for the local operator's observation surface.
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "z2c-observe-"));
}

const WS_PATH = mkdtempSync(join(tmpdir(), "z2c-observe-ws-")).toLowerCase();
const OTHER_PATH = mkdtempSync(join(tmpdir(), "z2c-observe-other-")).toLowerCase();

const ATTESTATION: Omit<SessionStateAttestation, "sessionId" | "workspaceKey" | "workspacePath"> = {
  providerId: "zai-api",
  modelId: "GLM-5.3-Flash",
  thoughtLevel: "max",
  collaborationMode: "edit",
  planEnabled: false,
  bindingSource: "official-session-read",
  runtimeVersion: "0.16.9",
  status: "idle",
  observedAt: "test",  availableModels: [{ providerId: "zai-api", modelId: "GLM-5.3-Flash", reasoningLevels: ["low", "high", "max"], reasoningDefaultLevel: "max" }],
};

class ObserveFakeProvider {
  readonly name = "zcode-official";
  readonly usesDesktopManagedAuth = true;
  status = "healthy" as const;
  statusDetail = "fake";
  providerVersion = "0.16.9";
  capabilityResult = null;
  childPid = null;
  /** Native session/list projection, as the real runtime would report. */
  readonly nativeSessions = [
    { sessionId: "sess_11111111-1111-1111-1111-111111111111", workspacePath: WS_PATH, status: "idle", title: "desktop session", updatedAt: 1700000000000 },
    { sessionId: "sess_22222222-2222-2222-2222-222222222222", workspacePath: OTHER_PATH, status: "idle", title: "outside grant", updatedAt: 1700000001000 },
    { sessionId: "sess_33333333-3333-3333-3333-333333333333", workspacePath: `${WS_PATH}\\nested`, status: "running", title: null, updatedAt: 1700000002000 },
  ];
  readonly messages = new Map<string, Array<Record<string, unknown>>>();

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async listSessions(workspace?: { workspacePath: string }) {
    if (!workspace) return this.nativeSessions.map((s) => ({ ...s }));
    return this.nativeSessions
      .filter((s) => s.workspacePath.toLowerCase().startsWith(workspace.workspacePath.toLowerCase()))
      .map((s) => ({ ...s }));
  }
  async readSessionState(sessionId: string, ws: { workspaceKey: string; workspacePath: string }): Promise<SessionStateAttestation> {
    // Test seam: inject lane-level failures (transport/timeout) for a session id.
    const injected = this.readFailure?.(sessionId) ?? null;
    if (injected) throw injected;
    const native = this.nativeSessions.find((s) => s.sessionId === sessionId);
    if (!native || !native.workspacePath.toLowerCase().startsWith(ws.workspacePath.toLowerCase())) {
      throw new Error(`session ${sessionId.slice(0, 12)} is not associated with this workspace`);
    }
    return { ...ATTESTATION, sessionId, workspaceKey: ws.workspaceKey, workspacePath: native.workspacePath };
  }

  readFailure: ((sessionId: string) => Error | null) | null = null;
  async readSessionMessages(sessionId: string, opts?: { limit?: number }) {
    const all = this.messages.get(sessionId) ?? [];
    return opts?.limit ? all.slice(0, opts.limit) : all;
  }
  async createSession(): Promise<string> { throw new Error("not used"); }
  async resumeSession(): Promise<void> {}
  async send(): Promise<never> { throw new Error("not used"); }
  async stopSession(): Promise<void> {}
  async snapshotAssistantMarker(): Promise<number> { return 0; }
  async readAssistantOutput(): Promise<string> { return ""; }
  async readSessionBinding(): Promise<null> { return null; }
}

function build(): { service: SessionService; provider: ObserveFakeProvider; dir: string; ownership: ReturnType<typeof loadSessionOwnership>; workspaceId: string } {
  const dir = tempDir();
  const grants = loadWorkspaceGrants(dir);
  const grant = grants.authorize(WS_PATH, { displayName: "observe-fixture", write: true });
  const ownership = loadSessionOwnership(dir);
  const provider = new ObserveFakeProvider();
  const service = new SessionService({
    provider: provider as unknown as AgentProvider,
    grants,
    ownership,
    audit: new FileAuditLog(join(dir, "audit")),
  });
  return { service, provider, dir, ownership, workspaceId: grant.workspaceId };
}

const CLIENT: Principal = { kind: "client", clientId: "cli_deadbeef", deviceName: "observer-test" };

describe("native session discovery (shared plane)", () => {
  it("lists native sessions canonical-root filtered, external origin, for the local operator", async () => {
    const { service, dir } = build();
    try {
      const sessions = await service.discover(LOCAL_PRINCIPAL);
      const ids = sessions.map((s) => s.session_id);
      // Inside the grant (incl. nested subpath) — visible.
      assert.ok(ids.includes("sess_11111111-1111-1111-1111-111111111111"));
      assert.ok(ids.includes("sess_33333333-3333-3333-3333-333333333333"));
      // Outside every grant — canonical-root filtering denies the escape.
      assert.ok(!ids.includes("sess_22222222-2222-2222-2222-222222222222"));
      const external = sessions.find((s) => s.session_id === "sess_11111111-1111-1111-1111-111111111111")!;
      assert.equal(external.runtime_origin, "external");
      assert.equal(external.controlled_by_z2c, false);
      assert.equal(external.owner_client_id, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks Z2C-controlled sessions with their owner projection", async () => {
    const { service, ownership, dir } = build();
    try {
      ownership.record({ sessionId: "sess_11111111-1111-1111-1111-111111111111", workspaceId: "ws_x", clientId: "cli_owner", accessMode: "write" });
      const sessions = await service.discover(LOCAL_PRINCIPAL);
      const owned = sessions.find((s) => s.session_id === "sess_11111111-1111-1111-1111-111111111111")!;
      assert.equal(owned.controlled_by_z2c, true);
      assert.equal(owned.owner_client_id, "cli_owner");
      assert.equal(owned.access_mode, "write");
      assert.equal(owned.runtime_origin, "z2c");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ownership staleness: markStale demotes a session and any live use clears it", async () => {
    const { ownership, dir } = build();
    try {
      const sid = "sess_22222222-2222-2222-2222-222222222222";
      ownership.record({ sessionId: sid, workspaceId: "ws_x", clientId: "cli_owner", accessMode: "write" });
      assert.equal(ownership.get(sid)?.staleAt, undefined);
      ownership.markStale(sid);
      assert.ok(typeof ownership.get(sid)?.staleAt === "number", "staleAt set by markStale");
      ownership.touch(sid);
      assert.equal(ownership.get(sid)?.staleAt, undefined, "live use clears the demotion");
      // markStale on an unknown session is a no-op (no fabrication).
      ownership.markStale("sess_33333333-3333-3333-3333-333333333333");
      assert.equal(ownership.get("sess_33333333-3333-3333-3333-333333333333"), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("denies paired clients discovery, observation, and message observation (observe ≠ control, fail closed)", async () => {
    const { service, dir } = build();
    try {
      await assert.rejects(
        () => service.discover(CLIENT),
        (err: SessionServiceError) => err.code === "OBSERVE_LOCAL_ONLY" && err.httpStatus === 403,
      );
      await assert.rejects(
        () => service.observe(CLIENT, { workspace_id: "ws_x", session_id: "sess_11111111-1111-1111-1111-111111111111" }),
        (err: SessionServiceError) => err.code === "OBSERVE_LOCAL_ONLY",
      );
      await assert.rejects(
        () => service.observeMessages(CLIENT, { workspace_id: "ws_x", session_id: "sess_11111111-1111-1111-1111-111111111111" }),
        (err: SessionServiceError) => err.code === "OBSERVE_LOCAL_ONLY",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("native session observation (shared plane)", () => {
  it("observes state of a discovered native session and binds messages to the authorized workspace", async () => {
    const { service, provider, dir, workspaceId } = build();
    try {
      const state = await service.observe(LOCAL_PRINCIPAL, { workspace_id: workspaceId, session_id: "sess_11111111-1111-1111-1111-111111111111" });
      assert.equal(state.session_id, "sess_11111111-1111-1111-1111-111111111111");
      assert.equal(state.model_id, "GLM-5.3-Flash");

      provider.messages.set("sess_11111111-1111-1111-1111-111111111111", [
        { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "hi" }] },
      ]);
      const messages = await service.observeMessages(LOCAL_PRINCIPAL, { workspace_id: workspaceId, session_id: "sess_11111111-1111-1111-1111-111111111111" });
      assert.equal(messages.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never observes a session whose workspace binding lies outside the grant (no escape)", async () => {
    const { service, dir, workspaceId } = build();
    try {
      await assert.rejects(
        () => service.observe(LOCAL_PRINCIPAL, { workspace_id: workspaceId, session_id: "sess_22222222-2222-2222-2222-222222222222" }),
        /not associated with this workspace/,
      );
      await assert.rejects(
        () => service.observeMessages(LOCAL_PRINCIPAL, { workspace_id: workspaceId, session_id: "sess_22222222-2222-2222-2222-222222222222" }),
        /not associated with this workspace/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a provable lane failure as SESSION_READ_UNAVAILABLE, never disguised as a session answer", async () => {
    const { service, provider, dir, workspaceId } = build();
    try {
      provider.readFailure = () => new Error("connect ECONNREFUSED 127.0.0.1:8766");
      await assert.rejects(
        () => service.observe(LOCAL_PRINCIPAL, { workspace_id: workspaceId, session_id: "sess_11111111-1111-1111-1111-111111111111" }),
        (err: SessionServiceError) => err.code === "SESSION_READ_UNAVAILABLE" && err.httpStatus === 503,
      );
      provider.readFailure = () => new Error("timeout waiting for session/read");
      await assert.rejects(
        () => service.observeMessages(LOCAL_PRINCIPAL, { workspace_id: workspaceId, session_id: "sess_11111111-1111-1111-1111-111111111111" }),
        (err: SessionServiceError) => err.code === "SESSION_READ_UNAVAILABLE" && err.httpStatus === 503,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a not-active session as SESSION_NOT_ACTIVE/410 with an honest, resume-free message", async () => {
    const { service, provider, dir, workspaceId } = build();
    try {
      // A pre-restart/legacy session: the runtime reports it not active. This
      // is a session-level answer about THIS runtime's readability — NOT a
      // lane failure, NOT proof the workspace binding is wrong, and NOT a
      // promise that a resume will succeed.
      provider.readFailure = () => new Error("ZCode Protocol error -32004: Session is not active: sess_legacy");
      await assert.rejects(
        () => service.observe(LOCAL_PRINCIPAL, { workspace_id: workspaceId, session_id: "sess_11111111-1111-1111-1111-111111111111" }),
        (err: SessionServiceError) => err.code === "SESSION_NOT_ACTIVE" && err.httpStatus === 410
          && /not readable in the current runtime/.test(err.message)
          && !/resume/i.test(err.message)
          && !/not associated/.test(err.message),
      );
      await assert.rejects(
        () => service.observeMessages(LOCAL_PRINCIPAL, { workspace_id: workspaceId, session_id: "sess_11111111-1111-1111-1111-111111111111" }),
        (err: SessionServiceError) => err.code === "SESSION_NOT_ACTIVE" && err.httpStatus === 410,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a proven session-not-found as the established session-level 404 denial", async () => {
    const { service, provider, dir, workspaceId } = build();
    try {
      provider.readFailure = () => new Error("session not found: sess_gone");
      await assert.rejects(
        () => service.observe(LOCAL_PRINCIPAL, { workspace_id: workspaceId, session_id: "sess_11111111-1111-1111-1111-111111111111" }),
        (err: SessionServiceError) => err.code === "SESSION_NOT_FOUND" && err.httpStatus === 404
          && /not associated with this workspace/.test(err.message),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on an unclassifiable read error with a neutral message (no workspace-mismatch claim)", async () => {
    const { service, provider, dir, workspaceId } = build();
    try {
      provider.readFailure = () => new Error("runtime exploded unexpectedly");
      await assert.rejects(
        () => service.observe(LOCAL_PRINCIPAL, { workspace_id: workspaceId, session_id: "sess_11111111-1111-1111-1111-111111111111" }),
        (err: SessionServiceError) => err.code === "SESSION_NOT_FOUND" && err.httpStatus === 404
          && /could not be confirmed in this runtime/.test(err.message)
          && !/not associated/.test(err.message),
      );
      await assert.rejects(
        () => service.observeMessages(LOCAL_PRINCIPAL, { workspace_id: workspaceId, session_id: "sess_11111111-1111-1111-1111-111111111111" }),
        (err: SessionServiceError) => err.code === "SESSION_NOT_FOUND" && err.httpStatus === 404,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps control fail-closed: an observed external session is still not owned/s controllable", async () => {
    const { ownership, dir } = build();
    try {
      // The observation plane records NO ownership: control checks stay 404.
      assert.throws(
        () => ownership.assertCanAccess(LOCAL_PRINCIPAL, "sess_11111111-1111-1111-1111-111111111111", "readonly"),
        (err: { code?: string }) => err.code === "SESSION_NOT_OWNED",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discovers one owned and one external session in same grant, verifies runtime_origin, observes state and messages, and denies foreign-workspace session", async () => {
    const { service, provider, ownership, dir, workspaceId } = build();
    try {
      const ownedSid = "sess_33333333-3333-3333-3333-333333333333";
      const externalSid = "sess_11111111-1111-1111-1111-111111111111";
      const foreignSid = "sess_22222222-2222-2222-2222-222222222222";

      // 1. Owned session record
      ownership.record({
        sessionId: ownedSid,
        workspaceId,
        clientId: "cli_z2c_owner",
        accessMode: "readonly",
      });

      // 2. Set up messages with hidden reasoning, tool internals, and visible text
      provider.messages.set(externalSid, [
        { info: { role: "user" }, parts: [{ type: "text", text: "what is the status?" }] },
        {
          info: { role: "assistant" },
          parts: [
            { type: "reasoning", text: "internal reasoning - must be hidden" },
            { type: "tool", tool: "read_file", state: { status: "completed" } },
            { type: "text", text: "all systems operational" },
          ],
        },
      ]);
      provider.messages.set(ownedSid, [
        { info: { role: "user" }, parts: [{ type: "text", text: "owned prompt" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "owned response" }] },
      ]);
      provider.messages.set(foreignSid, [
        { info: { role: "user" }, parts: [{ type: "text", text: "foreign prompt" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "foreign response" }] },
      ]);

      // 3. Discovery: both same-workspace sessions discover, foreign is excluded
      const discovered = await service.discover(LOCAL_PRINCIPAL, { workspace_id: workspaceId });
      const ids = discovered.map((s) => s.session_id);

      assert.ok(ids.includes(ownedSid), "owned session must be discovered");
      assert.ok(ids.includes(externalSid), "external session must be discovered");
      assert.ok(!ids.includes(foreignSid), "foreign workspace session must NOT be discovered");

      // Verify external session fields
      const ext = discovered.find((s) => s.session_id === externalSid)!;
      assert.equal(ext.runtime_origin, "external");
      assert.equal(ext.controlled_by_z2c, false);
      assert.equal(ext.owner_client_id, null);
      assert.equal(ext.access_mode, null);
      assert.equal(ext.workspace_id, workspaceId);

      // Verify owned session fields
      const owned = discovered.find((s) => s.session_id === ownedSid)!;
      assert.equal(owned.runtime_origin, "z2c");
      assert.equal(owned.controlled_by_z2c, true);
      assert.equal(owned.owner_client_id, "cli_z2c_owner");
      assert.equal(owned.access_mode, "readonly");
      assert.equal(owned.workspace_id, workspaceId);

      // 4. Observe state: both same-workspace sessions work (read-only)
      const extState = await service.observe(LOCAL_PRINCIPAL, { workspace_id: workspaceId, session_id: externalSid });
      assert.equal(extState.session_id, externalSid);
      assert.equal(extState.workspace_id, workspaceId);
      assert.equal(extState.model_id, "GLM-5.3-Flash");

      const ownedState = await service.observe(LOCAL_PRINCIPAL, { workspace_id: workspaceId, session_id: ownedSid });
      assert.equal(ownedState.session_id, ownedSid);
      assert.equal(ownedState.workspace_id, workspaceId);

      // 5. Observe messages: both work, reasoning and tool internals stripped
      const extMessages = await service.observeMessages(LOCAL_PRINCIPAL, { workspace_id: workspaceId, session_id: externalSid });
      assert.equal(extMessages.length, 2);
      assert.equal(extMessages[0].role, "user");
      assert.deepEqual(extMessages[0].parts, [{ type: "text", text: "what is the status?" }]);
      assert.equal(extMessages[1].role, "assistant");
      // Only visible text part survives:
      assert.deepEqual(extMessages[1].parts, [{ type: "text", text: "all systems operational" }]);

      const ownedMessages = await service.observeMessages(LOCAL_PRINCIPAL, { workspace_id: workspaceId, session_id: ownedSid });
      assert.equal(ownedMessages.length, 2);
      assert.equal(ownedMessages[0].role, "user");
      assert.equal(ownedMessages[1].role, "assistant");

      // 6. Foreign workspace session is denied on observe & observeMessages (fail closed, no oracle)
      await assert.rejects(
        () => service.observe(LOCAL_PRINCIPAL, { workspace_id: workspaceId, session_id: foreignSid }),
        /not associated with this workspace/,
      );
      await assert.rejects(
        () => service.observeMessages(LOCAL_PRINCIPAL, { workspace_id: workspaceId, session_id: foreignSid }),
        /not associated with this workspace/,
      );

      // Unknown session is denied with the exact same error (fail closed, no oracle)
      await assert.rejects(
        () => service.observe(LOCAL_PRINCIPAL, { workspace_id: workspaceId, session_id: "sess_00000000-0000-0000-0000-000000000000" }),
        /not associated with this workspace/,
      );
      await assert.rejects(
        () => service.observeMessages(LOCAL_PRINCIPAL, { workspace_id: workspaceId, session_id: "sess_00000000-0000-0000-0000-000000000000" }),
        /not associated with this workspace/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("catalog observation candidate outcomes (cold-start reconciliation)", () => {
  it("invokes onCandidateOutcome with FULL session ids and classified outcomes", async () => {
    const { observeZcodeCatalog } = await import("../src/service/server.js");
    const attempts: Array<{ sessionId: string; outcome: string }> = [];
    const port = {
      listSessions: async () => [
        { sessionId: "sess_aaaaaaaaaa-1111-1111-1111-111111111111", updatedAt: 2 },
        { sessionId: "sess_bbbbbbbbbb-2222-2222-2222-222222222222", updatedAt: 1 },
      ],
      observeSessionSettings: async (sessionId: string) => {
        if (sessionId.startsWith("sess_aa")) {
          throw new Error("ZCode Protocol error -32004: Session is not active: " + sessionId);
        }
        return { settings: { model: { current: { providerId: "zai-api", modelId: "GLM-5.3-Flash" }, available: [{ ref: { providerId: "zai-api", modelId: "GLM-5.3-Flash" }, reasoning: { levels: ["low", "high", "max"], defaultLevel: "max" } }] }, thoughtLevel: { enabled: true, current: "max", available: [{ value: "low" }, { value: "high" }, { value: "max" }] } } };
      },
    };
    const result = await observeZcodeCatalog(port, { budgetMs: 8000, maxCandidates: 5, onCandidateOutcome: (sid, outcome) => attempts.push({ sessionId: sid, outcome }) });
    assert.equal(result.evidenceSource, "session-settings-observed");
    assert.deepEqual(attempts, [
      { sessionId: "sess_aaaaaaaaaa-1111-1111-1111-111111111111", outcome: "session-not-active" },
      { sessionId: "sess_bbbbbbbbbb-2222-2222-2222-222222222222", outcome: "observed" },
    ]);
  });
});
