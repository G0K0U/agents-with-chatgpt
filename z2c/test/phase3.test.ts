import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { loadWorkspaceGrants, GrantError } from "../src/authz/grants.js";
import { loadPairing, PairingError, LOCAL_PRINCIPAL, type Principal } from "../src/authz/pairing.js";
import { loadSessionOwnership, OwnershipError } from "../src/authz/ownership.js";
import { loadOrCreateSecurity } from "../src/service/security.js";
import { SessionService } from "../src/service/sessions.js";
import { buildZ2cService, buildMcpServer, runAsPrincipal } from "../src/service/server.js";
import { existingService, cleanupOrphanChildren } from "../src/service/main.js";
import { parseSessionSettingsCatalog } from "../src/providers/zcode/official.js";
import type { SessionSnapshot } from "../src/providers/zcode/official.js";
import type { AgentProvider, SessionStateAttestation, ProviderSendOptions } from "../src/providers/types.js";
import { permitsDevelopmentOperation } from "../src/providers/zcode/permissions.js";
import type { TaskEngine } from "../src/core/tasks/engine.js";
import { FileAuditLog } from "../src/util/log.js";

// ── in-process official-style provider (session-attestation semantics) ──────
const ATTESTATION: Omit<SessionStateAttestation, "sessionId" | "workspaceKey" | "workspacePath"> = {
  providerId: "zai-api",
  modelId: "GLM-5.3-Flash",
  thoughtLevel: "max",
  collaborationMode: "edit",
  planEnabled: false,
  bindingSource: "official-session-read",
  runtimeVersion: "0.16.9",
  status: "idle",
  observedAt: "test",
  // The runtime's own advertisement for the observed model (catalog evidence
  // required by the 2026-09-28 catalog-driven admission policy).
  availableModels: [{ providerId: "zai-api", modelId: "GLM-5.3-Flash", reasoningLevels: ["low", "high", "max"], reasoningDefaultLevel: "max" }],
};

class FakeOfficialProvider {
  readonly name = "zcode-official";
  readonly usesDesktopManagedAuth = true;
  status = "healthy" as const;
  statusDetail = "fake";
  providerVersion = "0.16.9";
  capabilityResult = { ok: true, expectedVersion: "0.16.x", detectedVersion: "0.16.9", required: {}, preferred: {}, checkedAt: "test" };
  childPid = 424242;
  sessionPlan = new Map<string, boolean>();
  closed = new Set<string>();
  sends: ProviderSendOptions[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async createSession(ws: { workspaceKey: string }, options?: { readonly?: boolean }): Promise<string> {
    const sessionId = `sess_${Math.random().toString(16).slice(2).padEnd(12, "0")}-fake`;
    this.sessionPlan.set(sessionId, options?.readonly === true);
    return sessionId;
  }
  async resumeSession(ws: { workspaceKey: string }, sessionId: string, options?: { readonly?: boolean }): Promise<void> {
    if (options?.readonly) this.sessionPlan.set(sessionId, true);
  }
  async readSessionState(sessionId: string, ws: { workspaceKey: string }): Promise<SessionStateAttestation> {
    if (this.closed.has(sessionId)) throw new Error("session closed");
    return {
      ...ATTESTATION,
      sessionId,
      workspaceKey: ws.workspaceKey,
      workspacePath: ws.workspacePath,
      planEnabled: this.sessionPlan.get(sessionId) ?? false,
    };
  }
  async send(opts: ProviderSendOptions): Promise<{ sessionId: string; completion: Promise<{ status: string }> }> {
    this.sends.push(opts);
    return { sessionId: opts.sessionId, completion: Promise.resolve({ status: "completed" }) };
  }
  async snapshotAssistantMarker(): Promise<number> { return 0; }
  async readAssistantOutput(): Promise<string> { return "FAKE OUTPUT"; }
  async stopSession(): Promise<void> {}
  async closeSession(sessionId: string): Promise<void> { this.closed.add(sessionId); }
  async setSessionCollaborationMode(sessionId: string, mode: string): Promise<unknown> {
    this.sessionPlan.set(sessionId, mode === "plan");
    return { ok: true };
  }
  async updateSessionModel(ws: unknown, sessionId: string, change: { modelId?: string }): Promise<{ provider_id: string; model_id: string; thoughtLevel: string | null }> {
    return { provider_id: "zai-api", model_id: change.modelId ?? "GLM-5.3-Flash", thoughtLevel: "max" };
  }
  async readSessionEvents(): Promise<Array<Record<string, unknown>>> { return [{ type: "turn.completed" }]; }
  async readSessionMessages(): Promise<Array<Record<string, unknown>>> { return [{ info: { role: "assistant" } }]; }
}

// ── harness ─────────────────────────────────────────────────────────────────
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "z2c-p3-"));
}

interface Harness {
  dir: string;
  wsPath: string;
  grants: ReturnType<typeof loadWorkspaceGrants>;
  pairing: ReturnType<typeof loadPairing>;
  ownership: ReturnType<typeof loadSessionOwnership>;
  security: ReturnType<typeof loadOrCreateSecurity>;
  sessions: SessionService;
  provider: InstanceType<typeof FakeOfficialProvider>;
}

function buildSessions(dir: string): Harness {
  const grants = loadWorkspaceGrants(dir);
  const pairing = loadPairing(dir);
  const ownership = loadSessionOwnership(dir);
  const security = loadOrCreateSecurity(dir);
  const provider = new FakeOfficialProvider() as unknown as InstanceType<typeof FakeOfficialProvider> & AgentProvider;
  const audit = new FileAuditLog(join(dir, "audit"));
  const sessions = new SessionService({ provider: provider as unknown as AgentProvider, grants, ownership, audit });
  const wsPath = mkdtempSync(join(tmpdir(), "z2c-p3-ws-"));
  return { dir, wsPath, grants, pairing, ownership, security, sessions, provider };
}

// ── security ────────────────────────────────────────────────────────────────
describe("service security", () => {
  it("authenticates the current secret and rejects wrong ones in constant time", () => {
    const dir = tempDir();
    const security = loadOrCreateSecurity(dir);
    assert.equal(security.authenticate(security.currentSecret().secret), true);
    assert.equal(security.authenticate("nope"), false);
    assert.equal(security.authenticate(undefined), false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rotation keeps the old secret valid for the grace window, then retires it", () => {
    const dir = tempDir();
    const security = loadOrCreateSecurity(dir);
    const old = security.currentSecret().secret;
    const fresh = security.rotate();
    assert.notEqual(fresh.secret, old);
    assert.equal(security.authenticate(old), true); // grace window
    assert.equal(security.authenticate(fresh.secret), true);
    security.state.secrets[1]!.retiredAt = Date.now() - security.state.rotationGraceMs - 1;
    assert.equal(security.authenticate(old), false); // grace elapsed
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── pairing ─────────────────────────────────────────────────────────────────
describe("pairing state machine", () => {
  it("moves UNPAIRED → PAIRING_PENDING → PAIRED, burns the code, shows the token once", () => {
    const h = buildSessions(tempDir());
    assert.equal(h.pairing.pairingState(), "UNPAIRED");
    const req = h.pairing.beginPairing("test device");
    assert.equal(req.state, "PAIRING_PENDING");
    assert.match(req.code, /^\d{6}$/);
    const confirmed = h.pairing.confirmPairing(req.pairingId, req.code);
    assert.equal(confirmed.state, "PAIRED");
    assert.match(confirmed.token, /^z2cpair_/);
    // Single use: same code again → not found.
    assert.throws(() => h.pairing.confirmPairing(req.pairingId, req.code), (e: PairingError) => e.code === "PAIRING_NOT_FOUND");
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("rejects wrong codes (bounded attempts) and expired requests", () => {
    const h = buildSessions(tempDir());
    const req = h.pairing.beginPairing("d");
    assert.throws(() => h.pairing.confirmPairing(req.pairingId, "000000"), (e: PairingError) => e.code === "PAIRING_CODE_MISMATCH");
    const confirmed = h.pairing.confirmPairing(req.pairingId, req.code); // second attempt still fine
    assert.equal(confirmed.state, "PAIRED");
    const req2 = h.pairing.beginPairing("d2");
    h.pairing.confirmPairing(req2.pairingId, req2.code);
    const req3 = h.pairing.beginPairing("expired");
    // Force expiry on disk, then reload — a restarted service must honor it.
    const file = JSON.parse(readFileSync(join(h.dir, "pairing.json"), "utf8"));
    file.pending[0]!.expiresAt = Date.now() - 1;
    writeFileSync(join(h.dir, "pairing.json"), JSON.stringify(file));
    const reloaded = loadPairing(h.dir);
    assert.throws(() => reloaded.confirmPairing(req3.pairingId, req3.code), (e: PairingError) => e.code === "PAIRING_EXPIRED");
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("paired client tokens authenticate; revocation kills them; re-pairing works", () => {
    const h = buildSessions(tempDir());
    const req = h.pairing.beginPairing("chatgpt");
    const confirmed = h.pairing.confirmPairing(req.pairingId, req.code);
    const principal = h.pairing.authenticate(confirmed.token);
    assert.equal(principal?.kind, "client");
    assert.equal(principal?.clientId, confirmed.clientId);
    h.pairing.revoke(confirmed.clientId);
    assert.equal(h.pairing.authenticate(confirmed.token), null, "revoked pairing must not authenticate");
    // Re-pairing creates a NEW identity.
    const req2 = h.pairing.beginPairing("chatgpt");
    const confirmed2 = h.pairing.confirmPairing(req2.pairingId, req2.code);
    assert.notEqual(confirmed2.clientId, confirmed.clientId);
    rmSync(h.dir, { recursive: true, force: true });
  });
});

// ── workspace grants ────────────────────────────────────────────────────────
describe("workspace authorization", () => {
  it("authorizes canonical paths, rejects traversal and mismatched paths", () => {
    const h = buildSessions(tempDir());
    const grant = h.grants.authorize(h.wsPath, { write: true });
    h.grants.authorizeAccess(grant.workspaceId, "readonly", h.wsPath); // exact path ok
    assert.throws(() => h.grants.authorizeAccess(grant.workspaceId, "readonly", join(h.wsPath, "..", "elsewhere")), (e: GrantError) => e.code === "WORKSPACE_PATH_MISMATCH");
    assert.throws(() => h.grants.authorizeAccess(grant.workspaceId, "readonly", "relative/path"), (e: GrantError) => e.code === "INVALID_PATH");
    assert.throws(() => h.grants.authorizeAccess("ws_unknown", "read" as never), (e: GrantError) => e.code === "WORKSPACE_NOT_AUTHORIZED");
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("a read-only grant cannot be used for write access; revocation blocks everything", () => {
    const h = buildSessions(tempDir());
    const grant = h.grants.authorize(h.wsPath, { write: false });
    h.grants.authorizeAccess(grant.workspaceId, "readonly");
    assert.throws(() => h.grants.authorizeAccess(grant.workspaceId, "write"), (e: GrantError) => e.code === "WRITE_NOT_GRANTED");
    h.grants.revoke(grant.workspaceId);
    assert.throws(() => h.grants.authorizeAccess(grant.workspaceId, "readonly"), (e: GrantError) => e.code === "WORKSPACE_NOT_AUTHORIZED");
    rmSync(h.dir, { recursive: true, force: true });
  });
});

// ── session ownership + semantic service ────────────────────────────────────
describe("session ownership and the semantic SessionService", () => {
  it("Individual sends grant arbitrary local tools only to authorized write sessions", async () => {
    const h = buildSessions(tempDir());
    try {
      const grant = h.grants.authorize(h.wsPath, { write: true });
      for (const access of ["write", "readonly"] as const) {
        const state = await h.sessions.createSession(LOCAL_PRINCIPAL, { workspace_id: grant.workspaceId, access });
        await h.sessions.send(LOCAL_PRINCIPAL, { workspace_id: grant.workspaceId, session_id: state.session_id, instruction: "check" });
        const dispatch = h.provider.sends.at(-1)!.executionGrant!;
        assert.equal(dispatch.write, access === "write");
        assert.equal(dispatch.mode, access === "write" ? "machine-local-development" : "workspace");
        const active = new Map([[state.session_id, dispatch]]);
        for (const [toolName, input] of [
          ["Read", { file_path: join(h.dir, "source.ts") }],
          ["Write", { file_path: join(h.dir, "source.ts"), content: "test" }],
          ["Edit", { file_path: join(h.dir, "source.ts"), old_string: "a", new_string: "b" }],
          ["Glob", { path: h.dir, pattern: "*" }],
          ["Grep", { path: h.dir, pattern: "test" }],
          ["Bash", { command: `git -C "${h.dir}" status` }],
          ["Bash", { command: `pnpm --dir "${h.dir}" --version` }],
          ["Bash", { command: `powershell -NoProfile -Command 'Get-ChildItem -LiteralPath "${h.dir}"'` }],
        ] as const) {
          assert.equal(permitsDevelopmentOperation({ sessionId: state.session_id, requestId: "r", toolCallId: "t", toolName, input,
            riskLevel: "medium", options: [{ optionId: "allow_once", kind: "allow_once", response: { decision: "allow" } }] }, active), access === "write", toolName);
        }
      }
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
      rmSync(h.wsPath, { recursive: true, force: true });
    }
  });
  it("create attests identity and records ownership; readonly sessions require plan", async () => {
    const h = buildSessions(tempDir());
    const grant = h.grants.authorize(h.wsPath, { write: true });
    const state = await h.sessions.createSession(LOCAL_PRINCIPAL, { workspace_id: grant.workspaceId, access: "write", model: "GLM-5.3-Flash", thought_level: "max" });
    assert.equal(state.model_id, "GLM-5.3-Flash");
    assert.equal(state.plan_enabled, false);
    assert.equal(state.binding_source, "official-session-read");
    // Readonly create establishes plan (provider fake mirrors the CAS flow).
    const ro = await h.sessions.createSession(LOCAL_PRINCIPAL, { workspace_id: grant.workspaceId, access: "readonly" });
    assert.equal(ro.plan_enabled, true);
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("cross-client session access is rejected; unknown sessions never appear", async () => {
    const h = buildSessions(tempDir());
    const grant = h.grants.authorize(h.wsPath, { write: true });
    const clientA: Principal = { kind: "client", clientId: "cli_a", deviceName: "a" };
    const clientB: Principal = { kind: "client", clientId: "cli_b", deviceName: "b" };
    const state = await runAsPrincipal(clientA, () => h.sessions.createSession(clientA, { workspace_id: grant.workspaceId, access: "write" }));
    // Owner can read; the other client cannot.
    await h.sessions.read(clientA, { workspace_id: grant.workspaceId, session_id: state.session_id });
    await assert.rejects(
      () => h.sessions.read(clientB, { workspace_id: grant.workspaceId, session_id: state.session_id }),
      (e: OwnershipError) => e.code === "OWNERSHIP_DENIED",
    );
    // Session-id guessing (unknown session) → NOT_OWNED, even for local.
    await assert.rejects(
      () => h.sessions.read(LOCAL_PRINCIPAL, { workspace_id: grant.workspaceId, session_id: "sess_00000000-0000-4000-8000-000000000000" }),
      (e: OwnershipError) => e.code === "SESSION_NOT_OWNED",
    );
    // list only shows the owner's sessions.
    assert.equal(h.sessions.list(clientB).length, 0);
    assert.equal(h.sessions.list(clientA).length, 1);
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("write ops on a readonly session are rejected (SESSION_READONLY)", async () => {
    const h = buildSessions(tempDir());
    const grant = h.grants.authorize(h.wsPath, { write: true });
    const state = await h.sessions.createSession(LOCAL_PRINCIPAL, { workspace_id: grant.workspaceId, access: "readonly" });
    await assert.rejects(
      () => h.sessions.setModel(LOCAL_PRINCIPAL, { workspace_id: grant.workspaceId, session_id: state.session_id, model: "GLM-5.3" }),
      (e: OwnershipError) => e.code === "SESSION_READONLY",
    );
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("revoking the workspace grant blocks further session access", async () => {
    const h = buildSessions(tempDir());
    const grant = h.grants.authorize(h.wsPath, { write: true });
    const state = await h.sessions.createSession(LOCAL_PRINCIPAL, { workspace_id: grant.workspaceId, access: "write" });
    h.grants.revoke(grant.workspaceId);
    await assert.rejects(
      () => h.sessions.read(LOCAL_PRINCIPAL, { workspace_id: grant.workspaceId, session_id: state.session_id }),
      (e: GrantError) => e.code === "WORKSPACE_NOT_AUTHORIZED",
    );
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("send requires the grant to still permit the session's access mode", async () => {
    const h = buildSessions(tempDir());
    const grant = h.grants.authorize(h.wsPath, { write: true });
    const state = await h.sessions.createSession(LOCAL_PRINCIPAL, { workspace_id: grant.workspaceId, access: "write" });
    // Downgrade the grant to read-only, then try to send (write access).
    grant.permissions.write = false;
    await assert.rejects(
      () => h.sessions.send(LOCAL_PRINCIPAL, { workspace_id: grant.workspaceId, session_id: state.session_id, instruction: "x" }),
      (e: GrantError) => e.code === "WRITE_NOT_GRANTED",
    );
    rmSync(h.dir, { recursive: true, force: true });
  });
});

// ── HTTP service: auth boundaries + semantic-only MCP surface ───────────────
describe("local service HTTP surface", () => {
  const harness: { server?: ReturnType<typeof buildZ2cService>; baseUrl?: string; token?: string; dir?: string; cleanup?: (() => void)[] } = {};

  before(async () => {
    const dir = tempDir();
    const wsPath = mkdtempSync(join(tmpdir(), "z2c-p3-ws-"));
    const security = loadOrCreateSecurity(dir);
    const grants = loadWorkspaceGrants(dir);
    const pairing = loadPairing(dir);
    const ownership = loadSessionOwnership(dir);
    const audit = new FileAuditLog(join(dir, "audit"));
    const provider = new FakeOfficialProvider() as unknown as AgentProvider;
    const sessions = new SessionService({ provider, grants, ownership, audit });
    const engineStub = { submitTask: async () => ({}) } as unknown as TaskEngine;
    const server = buildZ2cService({
      cfg: { host: "127.0.0.1", port: 0 },
      provider,
      engine: engineStub,
      sessions,
      security,
      pairing,
      grants,
      ownership,
      audit,
    });
    await new Promise<void>((resolve) => server.httpServer.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.httpServer.address() as AddressInfo).port;
    harness.server = server;
    harness.baseUrl = `http://127.0.0.1:${port}`;
    harness.dir = dir;
    harness.token = security.currentSecret().secret;
    harness.cleanup = [() => rmSync(dir, { recursive: true, force: true }), () => rmSync(wsPath, { recursive: true, force: true })];
  });

  after(() => {
    harness.server?.close();
    for (const fn of harness.cleanup ?? []) fn();
  });

  function request(method: string, path: string, token?: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<{ status: number; body: any }> {
    return fetch(harness.baseUrl! + path, {
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(extraHeaders ?? {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
  }

  it("rejects unauthenticated and wrong-secret callers (knowing the port is not enough)", async () => {
    assert.equal((await request("GET", "/api/status")).status, 401);
    assert.equal((await request("GET", "/api/status", "wrong-secret")).status, 401);
    assert.equal((await request("POST", "/api/workspaces/authorize", "wrong-secret", { path: "C:\\x" })).status, 401);
  });

  it("serves health openly but with no sensitive data; management API is secret-gated", async () => {
    const health = await request("GET", "/health");
    assert.equal(health.status, 200);
    assert.deepEqual(Object.keys(health.body).sort(), ["protocol_version", "provider", "status"]);
    const ok = await request("GET", "/api/status", harness.token);
    assert.equal(ok.status, 200);
  });

  it("pairing flow over the management API: paired clients cannot manage grants", async () => {
    const begin = await request("POST", "/api/pairing/begin", harness.token, { deviceName: "chatgpt-connector" });
    assert.equal(begin.status, 200);
    const confirm = await request("POST", "/api/pairing/confirm", harness.token, { pairingId: begin.body.pairingId, code: begin.body.code });
    assert.equal(confirm.status, 200);
    const clientToken = confirm.body.token as string;
    // A paired client passes /mcp auth but is rejected on the management API.
    const mcpProbe = await request("POST", "/mcp", clientToken, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } }, { accept: "application/json, text/event-stream" });
    assert.equal(mcpProbe.status, 200);
    const mgmt = await request("POST", "/api/workspaces/authorize", clientToken, { path: "C:\\x" });
    assert.equal(mgmt.status, 403);
    // Revocation: further client calls fail.
    await request("POST", "/api/pairing/revoke", harness.token, { clientId: confirm.body.clientId });
    const after = await request("POST", "/mcp", clientToken, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } }, { accept: "application/json, text/event-stream" });
    assert.equal(after.status, 401);
  });

  it("MCP surface includes semantic tools and the complete local governed task adapter", () => {
    const server = buildMcpServer({
      cfg: { host: "127.0.0.1", port: 0 },
      provider: new FakeOfficialProvider() as unknown as AgentProvider,
      engine: { submitTask: async () => ({}) } as unknown as TaskEngine,
      sessions: new SessionService({ provider: new FakeOfficialProvider() as unknown as AgentProvider, grants: loadWorkspaceGrants(tempDir()), ownership: loadSessionOwnership(tempDir()), audit: new FileAuditLog(join(tempDir(), "audit")) }),
      security: loadOrCreateSecurity(tempDir()),
      pairing: loadPairing(tempDir()),
      grants: loadWorkspaceGrants(tempDir()),
      ownership: loadSessionOwnership(tempDir()),
      audit: new FileAuditLog(join(tempDir(), "audit")),
    });
    const tools = Object.keys((server as any)._registeredTools ?? {});
    const expected = [
      "zcode_runtime_capabilities", "zcode_workspace_list", "zcode_session_list", "zcode_session_create",
      "zcode_session_resume", "zcode_session_read", "zcode_session_send", "zcode_session_events",
      "zcode_session_messages", "zcode_session_stop", "zcode_session_close", "zcode_session_set_model",
      "zcode_session_set_thought_level", "zcode_session_set_mode",
      "zcode_session_discover", "zcode_session_observe", "zcode_session_observe_messages",
      "zcode_model_catalog",
      "submit_zcode_task", "provider_status", "get_zcode_task", "cancel_zcode_task",
      "execution_output", "resume_zcode_session",
    ];
    for (const name of expected) assert.ok(tools.includes(name), `missing canonical tool: ${name}`);
    const forbidden = ["raw_rpc", "call_rpc", "arbitrary_method", "shell", "arbitrary_command", "arbitrary_file_read", "arbitrary_file_write"];
    for (const name of Object.keys(tools)) {
      for (const bad of forbidden) assert.ok(!name.toLowerCase().includes(bad), `forbidden tool surface: ${name}`);
    }
  });

  it("zcode_model_catalog reports honest evidence levels and never creates sessions", async () => {
    const dir = tempDir();
    const base = new FakeOfficialProvider();
    let lifecycleCalls = 0;
    // The most recent native session is NOT active (the real -32004 failure
    // observed live); the older one is readable. observeSessionSettings is
    // the REAL provider parser applied to native-shaped session snapshots,
    // so the test covers native snapshot → parser → tool output.
    const nativeSnapshots: Record<string, SessionSnapshot> = {
      "sess_native-old": {
        settings: {
          model: {
            current: { providerId: "zai-api", modelId: "GLM-5.3-Flash" },
            available: [
              { ref: { providerId: "zai-api", modelId: "GLM-5.3-Flash" }, label: "GLM-5.3-Flash", reasoning: { levels: ["medium", "max"], defaultLevel: "max" } },
              { ref: { providerId: "zai-api", modelId: "GLM-5.3" }, label: "GLM-5.3", reasoning: { levels: ["medium", "high"], defaultLevel: "medium" } },
            ],
          },
          thoughtLevel: { enabled: true, current: "max", defaultLevel: "medium", available: [{ value: "high" }, { value: "max" }] },
        },
      },
    };
    const withObservation = Object.assign(base, {
      createSession: async (...args: Parameters<typeof base.createSession>) => { lifecycleCalls += 1; return base.createSession(...args); },
      resumeSession: async (...args: Parameters<typeof base.resumeSession>) => { lifecycleCalls += 1; return base.resumeSession(...args); },
      listSessions: async () => [
        { sessionId: "sess_native-recent", updatedAt: 10 },
        { sessionId: "sess_native-old", updatedAt: 5 },
      ],
      observeSessionSettings: (sessionId: string) => {
        // The most recent session is not active in this runtime: the real
        // -32004 failure. Only the older session is readable.
        if (sessionId === "sess_native-recent") {
          return Promise.reject(new Error("ZCode Protocol error -32004: Session is not active: " + sessionId));
        }
        const snap = nativeSnapshots[sessionId];
        if (!snap) return Promise.reject(new Error("ZCode Protocol error -32004: Session is not active: " + sessionId));
        return Promise.resolve(parseSessionSettingsCatalog(sessionId, new Date().toISOString(), snap));
      },
      requestedIdentity: () => ({ modelId: "GLM-5.3-Flash", thoughtLevel: null, providerId: null }),
    });
    const server = buildMcpServer({
      cfg: { host: "127.0.0.1", port: 0 }, provider: withObservation as unknown as AgentProvider,
      engine: { submitTask: async () => ({}) } as unknown as TaskEngine,
      sessions: new SessionService({ provider: withObservation as unknown as AgentProvider, grants: loadWorkspaceGrants(dir), ownership: loadSessionOwnership(dir), audit: new FileAuditLog(join(dir, "audit")) }),
      security: loadOrCreateSecurity(dir), pairing: loadPairing(dir),
      grants: loadWorkspaceGrants(dir), ownership: loadSessionOwnership(dir), audit: new FileAuditLog(join(dir, "audit")),
    });
    const registered = (server as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }> }> })._registeredTools;
    const tool = registered["zcode_model_catalog"];
    assert.ok(tool, "zcode_model_catalog must be registered");
    // Paired clients get configured-only evidence.
    const clientPrincipal: Principal = { kind: "client", clientId: "paired", deviceName: "test" };
    const clientResult = await runAsPrincipal(clientPrincipal, () => tool.handler({}));
    const clientPayload = JSON.parse(clientResult.content[0].text) as Record<string, unknown>;
    assert.equal(clientPayload.evidence_source, "configured");
    assert.ok(clientPayload.runtime_settings === null);
    // The local operator gets the runtime's own advertisement via the readable
    // candidate; the not-active most-recent session was skipped with an honest
    // attempt record, and no session lifecycle operation was issued.
    const localResult = await runAsPrincipal(LOCAL_PRINCIPAL, () => tool.handler({}));
    const localPayload = JSON.parse(localResult.content[0].text) as Record<string, unknown>;
    assert.equal(localPayload.evidence_source, "session-settings-observed");
    assert.equal(localPayload.observed_session_id, "sess_native-old");
    const attempts = localPayload.attempts as Array<{ session_id: string; outcome: string }>;
    // Every actual attempt is recorded — including the successful one.
    assert.deepEqual(attempts.map((a) => a.outcome), ["session-not-active", "observed"]);
    assert.ok(attempts[0].session_id.startsWith("sess_native-re"));
    assert.equal(lifecycleCalls, 0);
    assert.equal(localPayload.candidates_considered, 2);
    assert.equal(localPayload.candidates_attempted, 2);
    assert.equal(localPayload.candidates_observed, 1);
    const settings = localPayload.runtime_settings as {
      source_session_id: string;
      current: { provider_id: string; model_id: string; thought_level: string };
      current_model_thought_levels: string[];
      models: Array<{ provider_id: string; model_id: string; reasoning_levels: string[]; reasoning_default_level: string }>;
    };
    assert.equal(settings.source_session_id, "sess_native-old");
    assert.deepEqual(settings.models.map((m) => m.model_id), ["GLM-5.3-Flash", "GLM-5.3"]);
    // Per-model reasoning evidence is preserved per model — not copied across.
    assert.deepEqual(settings.models[0].reasoning_levels, ["medium", "max"]);
    assert.equal(settings.models[0].reasoning_default_level, "max");
    assert.deepEqual(settings.models[1].reasoning_levels, ["medium", "high"]);
    assert.equal(settings.models[0].provider_id, "zai-api");
    assert.equal(settings.current.model_id, "GLM-5.3-Flash");
    assert.deepEqual(settings.current_model_thought_levels, ["high", "max"]);
  });

  it("zcode_model_catalog classifies unreadable candidates honestly", async () => {
    const dir = tempDir();
    const base = new FakeOfficialProvider();
    const withObservation = Object.assign(base, {
      listSessions: async () => [
        { sessionId: "sess_a", updatedAt: 10 },
        { sessionId: "sess_b", updatedAt: 5 },
      ],
      observeSessionSettings: async (sessionId: string) => {
        throw new Error("ZCode Protocol error -32004: Session is not active: " + sessionId);
      },
      requestedIdentity: () => ({ modelId: "GLM-5.3-Flash", thoughtLevel: null, providerId: null }),
    });
    const server = buildMcpServer({
      cfg: { host: "127.0.0.1", port: 0 }, provider: withObservation as unknown as AgentProvider,
      engine: { submitTask: async () => ({}) } as unknown as TaskEngine,
      sessions: new SessionService({ provider: withObservation as unknown as AgentProvider, grants: loadWorkspaceGrants(dir), ownership: loadSessionOwnership(dir), audit: new FileAuditLog(join(dir, "audit")) }),
      security: loadOrCreateSecurity(dir), pairing: loadPairing(dir),
      grants: loadWorkspaceGrants(dir), ownership: loadSessionOwnership(dir), audit: new FileAuditLog(join(dir, "audit")),
    });
    const registered = (server as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }> }> })._registeredTools;
    const result = await runAsPrincipal(LOCAL_PRINCIPAL, () => registered["zcode_model_catalog"]!.handler({}));
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;
    assert.equal(payload.evidence_source, "all-candidates-unreadable");
    assert.equal((payload.attempts as unknown[]).length, 2);
    assert.ok(payload.runtime_settings === null);
    assert.ok(String(payload.note).includes("no readable native session"));

    // Permission problems are not retried across candidates: the scan stops
    // with the honest classification instead of hammering every candidate.
    const withPermission = Object.assign(new FakeOfficialProvider(), {
      listSessions: async () => [{ sessionId: "sess_x", updatedAt: 10 }, { sessionId: "sess_y", updatedAt: 5 }],
      observeSessionSettings: async () => { throw new Error("401 unauthorized against runtime"); },
      requestedIdentity: () => ({ modelId: "GLM-5.3-Flash", thoughtLevel: null, providerId: null }),
    });
    const server2 = buildMcpServer({
      cfg: { host: "127.0.0.1", port: 0 }, provider: withPermission as unknown as AgentProvider,
      engine: { submitTask: async () => ({}) } as unknown as TaskEngine,
      sessions: new SessionService({ provider: withPermission as unknown as AgentProvider, grants: loadWorkspaceGrants(dir), ownership: loadSessionOwnership(dir), audit: new FileAuditLog(join(dir, "audit")) }),
      security: loadOrCreateSecurity(dir), pairing: loadPairing(dir),
      grants: loadWorkspaceGrants(dir), ownership: loadSessionOwnership(dir), audit: new FileAuditLog(join(dir, "audit")),
    });
    const registered2 = (server2 as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }> }> })._registeredTools;
    const denied = await runAsPrincipal(LOCAL_PRINCIPAL, () => registered2["zcode_model_catalog"]!.handler({}));
    const deniedPayload = JSON.parse(denied.content[0].text) as Record<string, unknown>;
    const deniedAttempts = deniedPayload.attempts as Array<{ outcome: string }>;
    assert.equal(deniedAttempts.length, 1);
    assert.equal(deniedAttempts[0].outcome, "permission");
    assert.equal(deniedPayload.evidence_source, "all-candidates-unreadable");

    // No native sessions at all: an explicit evidence gap, not an empty catalog.
    const withNone = Object.assign(new FakeOfficialProvider(), {
      listSessions: async () => [],
      observeSessionSettings: async () => null,
      requestedIdentity: () => ({ modelId: "GLM-5.3-Flash", thoughtLevel: null, providerId: null }),
    });
    const server3 = buildMcpServer({
      cfg: { host: "127.0.0.1", port: 0 }, provider: withNone as unknown as AgentProvider,
      engine: { submitTask: async () => ({}) } as unknown as TaskEngine,
      sessions: new SessionService({ provider: withNone as unknown as AgentProvider, grants: loadWorkspaceGrants(dir), ownership: loadSessionOwnership(dir), audit: new FileAuditLog(join(dir, "audit")) }),
      security: loadOrCreateSecurity(dir), pairing: loadPairing(dir),
      grants: loadWorkspaceGrants(dir), ownership: loadSessionOwnership(dir), audit: new FileAuditLog(join(dir, "audit")),
    });
    const registered3 = (server3 as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }> }> })._registeredTools;
    const none = await runAsPrincipal(LOCAL_PRINCIPAL, () => registered3["zcode_model_catalog"]!.handler({}));
    const nonePayload = JSON.parse(none.content[0].text) as Record<string, unknown>;
    assert.equal(nonePayload.evidence_source, "no-candidates");
    assert.ok(nonePayload.runtime_settings === null);
  });

  it("parseSessionSettingsCatalog preserves native per-model reasoning and normalizes both thought-level spellings", () => {
    const native = {
      settings: {
        model: {
          current: { providerId: "zai-api", modelId: "GLM-5.3-Flash" },
          available: [
            { ref: { providerId: "zai-api", modelId: "GLM-5.3-Flash" }, label: "GLM-5.3-Flash", reasoning: { levels: ["medium", "max"], defaultLevel: "max" } },
            // No provider ref and no reasoning: stays null/empty, never inferred.
            { modelId: "mystery-model" },
          ],
        },
        thoughtLevel: { enabled: true, current: "max", defaultLevel: "medium", available: ["high", "max"] },
      },
    } as unknown as SessionSnapshot;
    const catalog = parseSessionSettingsCatalog("sess_p", "2026-09-26T00:00:00.000Z", native);
    assert.ok(catalog);
    assert.equal(catalog.source_session_id, "sess_p");
    assert.deepEqual(catalog.models[0], {
      provider_id: "zai-api", model_id: "GLM-5.3-Flash", label: "GLM-5.3-Flash",
      reasoning_levels: ["medium", "max"], reasoning_default_level: "max",
      // No access evidence on the entry → null, never a fabricated plan.
      access_mode: null,
    });
    // Missing identity is NOT filled from the current selection.
    assert.equal(catalog.models[1].provider_id, null);
    assert.deepEqual(catalog.models[1].reasoning_levels, []);
    assert.equal(catalog.models[1].access_mode, null);
    assert.equal(catalog.current?.model_id, "GLM-5.3-Flash");
    assert.equal(catalog.current?.access_mode, null);
    // Both `[{value}]` and `string[]` spellings normalize to string[].
    assert.deepEqual(catalog.current_model_thought_levels, ["high", "max"]);
    // No settings at all → null (no fabricated evidence).
    assert.equal(parseSessionSettingsCatalog("sess_q", "2026-09-26T00:00:00.000Z", { settings: {} } as unknown as SessionSnapshot), null);
  });

  it("parseSessionSettingsCatalog passes access_mode through per source field and never invents a plan", () => {
    const native = {
      settings: {
        model: {
          current: { providerId: "account:zai-start-plan", modelId: "GLM-5.3-Flash", accessMode: "start-plan" },
          available: [
            { providerId: "account:zai-start-plan", modelId: "GLM-5.3-Flash", accessMode: "start-plan" },
            // accountAccess.mode is the fallback source when accessMode is absent.
            { ref: { providerId: "zai-api", modelId: "GLM-5.3-Flash" }, accountAccess: { mode: "individual-coding-plan" } },
            // Both present: accessMode is the source of truth, no merging.
            { modelId: "glm-dual", accessMode: "start-plan", accountAccess: { mode: "individual-coding-plan" } },
            // Unrecognized spelling stays verbatim — an observed fact, never remapped to a known plan.
            { modelId: "glm-experimental", accessMode: "team-experimental" },
          ],
        },
      },
    } as unknown as SessionSnapshot;
    const catalog = parseSessionSettingsCatalog("sess_a", "2026-10-01T00:00:00.000Z", native);
    assert.ok(catalog);
    assert.equal(catalog.current?.access_mode, "start-plan");
    assert.deepEqual(
      catalog.models.map((m) => m.access_mode),
      ["start-plan", "individual-coding-plan", "start-plan", "team-experimental"],
    );
  });

  it("governed compatibility tools deny paired clients before reaching the task engine", async () => {
    let calls = 0;
    const dir = tempDir();
    const provider = new FakeOfficialProvider() as unknown as AgentProvider;
    const server = buildMcpServer({
      cfg: { host: "127.0.0.1", port: 0 }, provider,
      engine: {
        submitTask: async () => { calls++; return {}; },
        getTask: () => { calls++; return {}; },
        cancelTask: () => { calls++; return {}; },
        getOutput: () => { calls++; return {}; },
        getQueue: () => { calls++; return { activeTask: null }; },
      } as unknown as TaskEngine,
      sessions: new SessionService({ provider, grants: loadWorkspaceGrants(dir), ownership: loadSessionOwnership(dir), audit: new FileAuditLog(join(dir, "audit")) }),
      security: loadOrCreateSecurity(dir), pairing: loadPairing(dir),
      grants: loadWorkspaceGrants(dir), ownership: loadSessionOwnership(dir), audit: new FileAuditLog(join(dir, "audit")),
    });
    const registered = (server as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean }> }> })._registeredTools;
    const principal: Principal = { kind: "client", clientId: "foreign", deviceName: "test" };
    for (const [name, args] of [
      ["submit_zcode_task", { workspace_id: "ws", instruction: "x" }],
      ["provider_status", { workspace_id: "ws" }],
      ["get_zcode_task", { workspace_id: "ws", task_id: "z2c_x" }],
      ["cancel_zcode_task", { workspace_id: "ws", task_id: "z2c_x" }],
      ["execution_output", { workspace_id: "ws", task_id: "z2c_x", output_id: "out_x" }],
      ["resume_zcode_session", { workspace_id: "ws", session_id: "sess_00000000-0000-0000-0000-000000000000", instruction: "x" }],
    ] as const) {
      const result = await runAsPrincipal(principal, () => registered[name]!.handler(args));
      assert.equal(result.isError, true, `${name} must reject foreign principal`);
    }
    assert.equal(calls, 0);
  });

  it("provider_status relays the observed entitlement capability and never invents true", async () => {
    const dir = tempDir();
    const engine = { getQueue: () => ({ paused: false, activeTask: null, queuedTaskCount: 0 }) } as unknown as TaskEngine;
    const invoke = async (provider: AgentProvider): Promise<Record<string, unknown>> => {
      const server = buildMcpServer({
        cfg: { host: "127.0.0.1", port: 0 }, provider, engine,
        sessions: new SessionService({ provider, grants: loadWorkspaceGrants(dir), ownership: loadSessionOwnership(dir), audit: new FileAuditLog(join(dir, "audit")) }),
        security: loadOrCreateSecurity(dir), pairing: loadPairing(dir),
        grants: loadWorkspaceGrants(dir), ownership: loadSessionOwnership(dir), audit: new FileAuditLog(join(dir, "audit")),
      });
      const registered = (server as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> }> })._registeredTools;
      const result = await runAsPrincipal(LOCAL_PRINCIPAL, () => registered["provider_status"]!.handler({ workspace_id: "ws" }));
      return JSON.parse(result.content[0].text) as Record<string, unknown>;
    };

    // Observed true is relayed verbatim — exactly what the runtime advertised.
    const supported = await invoke(Object.assign(new FakeOfficialProvider(), { entitlementSelection: { entitlementSelection: true } }) as unknown as AgentProvider);
    assert.deepEqual(supported.entitlement_capability, { entitlementSelection: true });

    // Observed false stays false — never promoted to true.
    const unsupported = await invoke(Object.assign(new FakeOfficialProvider(), { entitlementSelection: { entitlementSelection: false } }) as unknown as AgentProvider);
    assert.deepEqual(unsupported.entitlement_capability, { entitlementSelection: false });

    // Absent provider support stays null (fail closed), never fabricated.
    const absent = await invoke(new FakeOfficialProvider() as unknown as AgentProvider);
    assert.equal(absent.entitlement_capability, null);
  });

  it("sanitized outputs never contain credential-ish fields", async () => {
    const dir = harness.dir!;
    const grants = loadWorkspaceGrants(dir);
    const grant = grants.authorize(mkdtempSync(join(tmpdir(), "z2c-p3-ws2-")), { write: true });
    const sessions = harness.server;
    void sessions;
    const provider = new FakeOfficialProvider() as unknown as AgentProvider;
    const ownership = loadSessionOwnership(dir);
    const svc = new SessionService({ provider, grants, ownership, audit: new FileAuditLog(join(tempDir(), "audit")) });
    const state = await svc.createSession(LOCAL_PRINCIPAL, { workspace_id: grant.workspaceId, access: "write" });
    const serialized = JSON.stringify(state);
    for (const forbidden of ["apiKey", "authorization", "cookie", "token", "credential"]) {
      assert.ok(!serialized.toLowerCase().includes(forbidden), `sanitized state contains '${forbidden}'`);
    }
  });
});

// ── daemon lifecycle pieces ─────────────────────────────────────────────────
describe("daemon pid/orphan handling", () => {
  it("existingService detects live pid files and ignores stale ones", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "service.json"), JSON.stringify({ version: 1, pid: 999999999, installId: "inst_x", startedAt: 1, port: 8766, protocolVersion: 1 }));
    assert.equal(existingService(dir), null, "dead pid must not count as running");
    writeFileSync(join(dir, "service.json"), JSON.stringify({ version: 1, pid: process.pid, installId: "inst_x", startedAt: 1, port: 8766, protocolVersion: 1 }));
    assert.ok(existingService(dir), "own live pid counts as running");
    rmSync(dir, { recursive: true, force: true });
  });

  it("orphan cleanup never kills a pid whose command line is not a zcode app-server", async () => {
    const dir = tempDir();
    // Current process is alive but is NOT a zcode.cjs app-server → must survive.
    writeFileSync(join(dir, "children.json"), JSON.stringify({ version: 1, children: [{ pid: process.pid, recordedAt: Date.now() }] }));
    const killed = await cleanupOrphanChildren(dir);
    assert.equal(killed, 0);
    assert.ok(existsSync(process.cwd())); // we are still alive
    rmSync(dir, { recursive: true, force: true });
  });
});

// -- doctor: stale legacy configuration detection -----------------------------
describe("doctor (migration diagnostics)", () => {
  it("flags a stale Phase-1 Z2C_PROVIDER leftover without failing the run", async () => {
    const { runDoctor } = await import("../src/cli/doctor.js");
    const previous = process.env.Z2C_PROVIDER;
    const previousPort = process.env.Z2C_PORT;
    process.env.Z2C_PROVIDER = "desktop";
    process.env.Z2C_PORT = "59999"; // unassigned port -> health checks fail fast, reported as info
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...c: unknown[]) => logs.push(c.join(" "));
    try {
      const code = await runDoctor();
      assert.equal(code, 0, "stale config is a warning, not an error");
    } finally {
      console.log = originalLog;
      if (previous !== undefined) process.env.Z2C_PROVIDER = previous;
      else delete process.env.Z2C_PROVIDER;
      if (previousPort !== undefined) process.env.Z2C_PORT = previousPort;
      else delete process.env.Z2C_PORT;
    }
    const joined = logs.join("\n");
    assert.match(joined, /stale-env-z2c-provider/);
    assert.match(joined, /Phase-1 leftover/);
    assert.doesNotMatch(joined, /z2cs_[0-9a-f]+/); // never prints the service secret
  });
});
