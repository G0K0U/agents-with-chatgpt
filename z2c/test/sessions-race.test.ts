import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionService, LOCAL_PRINCIPAL } from "../src/service/sessions.js";
import { loadWorkspaceGrants } from "../src/authz/grants.js";
import { loadSessionOwnership } from "../src/authz/ownership.js";
import type { AgentProvider, SessionStateAttestation, ProviderSendOptions } from "../src/providers/types.js";
import { FileAuditLog } from "../src/util/log.js";

const CANONICAL = "f:\\examplework\\engineering-ai";

function attestation(sessionId: string): SessionStateAttestation {
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
    status: "idle",
    observedAt: new Date().toISOString(),
  };
}

class FakeProvider {
  readonly name = "zcode-official";
  readonly usesDesktopManagedAuth = true;
  status = "healthy" as const;
  statusDetail = "fake";
  providerVersion = "0.16.9";
  capabilityResult = null;
  childPid = null;
  /** Number of consecutive busy rejections before a send is accepted. */
  busyRemaining = 0;
  sends = 0;
  async start() {}
  async stop() {}
  async createSession(ws: { workspaceKey: string }): Promise<string> {
    return `sess_${crypto.randomUUID()}`;
  }
  async resumeSession(): Promise<void> {}
  async readSessionState(sessionId: string, ws: { workspaceKey: string }): Promise<SessionStateAttestation> {
    return attestation(sessionId);
  }
  async send(options: ProviderSendOptions): Promise<{ sessionId: string; completion: Promise<{ status: string; detail?: string }> }> {
    this.sends += 1;
    if (this.busyRemaining > 0) {
      this.busyRemaining -= 1;
      throw new Error("ZCode Protocol error -32010: A prompt is already running for this session");
    }
    return { sessionId: options.sessionId, completion: Promise.resolve({ status: "completed" }) };
  }
  async snapshotAssistantMarker(): Promise<number> { return 0; }
  async readAssistantOutput(): Promise<string> { return "SETTLED OK"; }
  async stopSession(): Promise<void> {}
  async closeSession(): Promise<void> {}
  async setSessionCollaborationMode(): Promise<unknown> { return {}; }
  async updateSessionModel(_ws: unknown, _sid: string, change: { modelId?: string }): Promise<{ provider_id: string; model_id: string; thoughtLevel: string | null }> {
    return { provider_id: "zai-api", model_id: change.modelId ?? "GLM-5.3-Flash", thoughtLevel: "max" };
  }
  async readSessionEvents(): Promise<Array<Record<string, unknown>>> { return []; }
  async readSessionMessages(): Promise<Array<Record<string, unknown>>> { return []; }
  async readSessionBinding(): Promise<{ provider_id: string; model_id: string; source: string } | null> { return null; }
  listSessions(): Array<Record<string, unknown>> { return []; }
}

describe("SessionService send settle semantics (setter→send busy race)", () => {
  it("retries the transient busy window and completes without surfacing the race", async () => {
    const dir = mkdtempSync(join(tmpdir(), "z2c-race-"));
    const ws = mkdtempSync(join(tmpdir(), "z2c-race-ws-"));
    const grants = loadWorkspaceGrants(dir);
    const grant = grants.authorize(ws, { write: true });
    const provider = new FakeProvider();
    const svc = new SessionService({ provider: provider as unknown as AgentProvider, grants, ownership: loadSessionOwnership(dir), audit: new FileAuditLog(join(dir, "audit")) });
    const created = await svc.createSession(LOCAL_PRINCIPAL, { workspace_id: grant.workspaceId, access: "write" });
    const sessionId = created.session_id;
    provider.busyRemaining = 2; // two transient -32010 rejections, then success
    const result = await svc.send(LOCAL_PRINCIPAL, { workspace_id: grant.workspaceId, session_id: sessionId, instruction: "settle probe" });
    assert.equal(result.turn, "completed");
    assert.match(result.output, /SETTLED OK/);
    assert.ok(provider.sends >= 3, "the send must have been retried after transient busy");
    rmSync(dir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });

  it("rejects a REAL concurrent prompt after the bounded settle window (fail-closed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "z2c-race2-"));
    const ws = mkdtempSync(join(tmpdir(), "z2c-race2-ws-"));
    const grants = loadWorkspaceGrants(dir);
    const grant = grants.authorize(ws, { write: true });
    const provider = new FakeProvider();
    const svc = new SessionService({ provider: provider as unknown as AgentProvider, grants, ownership: loadSessionOwnership(dir), audit: new FileAuditLog(join(dir, "audit")) });
    const created = await svc.createSession(LOCAL_PRINCIPAL, { workspace_id: grant.workspaceId, access: "write" });
    const sessionId = created.session_id;
    provider.busyRemaining = Number.MAX_SAFE_INTEGER; // a real concurrent prompt never clears
    await assert.rejects(
      () => svc.send(LOCAL_PRINCIPAL, { workspace_id: grant.workspaceId, session_id: sessionId, instruction: "x", timeout_ms: 12000 }),
      (e: { code?: string; httpStatus?: number }) => e.code === "SESSION_BUSY" && e.httpStatus === 409,
    );
    assert.ok(provider.sends >= 1);
    rmSync(dir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });
});

import { randomUUID as crypto_randomUUID } from "node:crypto";
const crypto = { randomUUID: crypto_randomUUID };
