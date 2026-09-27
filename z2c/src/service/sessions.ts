import type { AgentProvider, SessionStateAttestation } from "../providers/types.js";
import { assertGovernedAttestation, AttestationError } from "../authz/attestation.js";
import { loadWorkspaceGrants, GrantError, type WorkspaceAccess, type WorkspaceGrants } from "../authz/grants.js";
import { loadSessionOwnership, OwnershipError, type OwnedSession, type SessionOwnership } from "../authz/ownership.js";
import { LOCAL_PRINCIPAL, type Principal } from "../authz/pairing.js";
import { canonicalizeWorkspacePath, isSubPath } from "../core/workspaces/registry.js";
import type { AuditSink } from "../util/log.js";

/**
 * Transport-neutral semantic session service: the ONLY authorization layer
 * between any transport (local MCP, future relay, management API) and the
 * ZcodeOfficialProvider. Every call resolves the principal, re-validates the
 * workspace grant, enforces session ownership, and returns SANITIZED
 * authoritative state — never credentials, headers, or raw config.
 *
 * Sanitized attestation shape (public contract, versioned by
 * Z2C_PROTOCOL_VERSION):
 *   { session_id, workspace_id, provider_id, model_id, thought_level,
 *     collaboration_mode, plan_enabled, runtime_version, binding_source }
 */

export class SessionServiceError extends Error {
  constructor(message: string, public readonly code: string, public readonly httpStatus = 400) {
    super(message);
    this.name = "SessionServiceError";
  }
}

export interface SanitizedSessionState {
  session_id: string;
  workspace_id: string;
  provider_id: string | null;
  model_id: string | null;
  thought_level: string | null;
  collaboration_mode: string | null;
  plan_enabled: boolean | null;
  runtime_version: string | null;
  binding_source: string;
}

export interface SessionServiceDeps {
  provider: AgentProvider;
  grants: WorkspaceGrants;
  ownership: SessionOwnership;
  audit: AuditSink;
  settleTotalMs?: number;
  settleStepMs?: number;
  settleLagMs?: number;
}

function sanitize(att: SessionStateAttestation, workspaceId: string): SanitizedSessionState {
  return {
    session_id: att.sessionId,
    workspace_id: workspaceId,
    provider_id: att.providerId,
    model_id: att.modelId,
    thought_level: att.thoughtLevel,
    collaboration_mode: att.collaborationMode,
    plan_enabled: att.planEnabled,
    runtime_version: att.runtimeVersion,
    binding_source: att.bindingSource,
  };
}

function requireOfficialSessionService(deps: SessionServiceDeps): void {
  if (typeof deps.provider.readSessionState !== "function") {
    throw new SessionServiceError(
      "the semantic session surface requires the official provider (zcode-official)",
      "PROVIDER_UNSUPPORTED",
      503,
    );
  }
}

async function attestedState(
  deps: SessionServiceDeps,
  sessionId: string,
  wsRef: { workspacePath: string; workspaceKey: string },
  readonly: boolean,
): Promise<SessionStateAttestation> {
  // readSessionState throws on workspace mismatch; null fields mean "not proven".
  const att = await deps.provider.readSessionState!(sessionId, wsRef);
  assertGovernedAttestation(att, { readonly });
  return att;
}

export interface SessionCreateRequest {
  workspace_id: string;
  access: WorkspaceAccess;
  model?: string;
  thought_level?: string;
  provider?: string;
}

function sanitizeSessionMessages(rawMessages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object") continue;
    const info = (raw.info && typeof raw.info === "object" ? raw.info : {}) as Record<string, unknown>;
    const role = typeof info.role === "string" ? info.role : typeof raw.role === "string" ? raw.role : null;
    if (role !== "user" && role !== "assistant") continue;

    const rawParts = Array.isArray(raw.parts) ? raw.parts : [];
    const visibleParts: Array<{ type: "text"; text: string }> = [];
    for (const p of rawParts) {
      if (!p || typeof p !== "object") continue;
      const part = p as Record<string, unknown>;
      // Exclude hidden reasoning and tool internals
      if (
        part.type === "reasoning" ||
        part.type === "tool" ||
        part.type === "step-start" ||
        part.type === "step-finish" ||
        part.type === "snapshot" ||
        part.type === "patch" ||
        part.type === "compaction"
      ) {
        continue;
      }
      if (part.type === "text" && typeof part.text === "string") {
        const text = part.text.length > 32_000 ? part.text.slice(0, 32_000) + "…[truncated]" : part.text;
        visibleParts.push({ type: "text", text });
      }
    }

    if (visibleParts.length === 0 && typeof (info.text ?? raw.text) === "string") {
      const fallback = String(info.text ?? raw.text);
      const text = fallback.length > 32_000 ? fallback.slice(0, 32_000) + "…[truncated]" : fallback;
      visibleParts.push({ type: "text", text });
    }

    if (visibleParts.length === 0) continue;

    result.push({
      role,
      info: {
        role,
        ...(typeof info.messageId === "string" ? { messageId: info.messageId } : {}),
        ...(typeof info.id === "string" ? { messageId: info.id } : {}),
        ...(typeof info.time === "number" || (info.time && typeof info.time === "object") ? { time: info.time } : {}),
      },
      parts: visibleParts,
    });
  }
  return result;
}

export class SessionService {
  /**
   * Positive evidence that the immediately preceding turn for this exact session
   * reached a terminal/completed state through this live service's provider completion path.
   * Required by Mandatory Safety Gate 2A before stale-busy (-32010) recovery is permitted.
   */
  private readonly priorTurnCompletedSessions = new Set<string>();

  constructor(private readonly deps: SessionServiceDeps) {}

  private wsRef(workspaceId: string): { wsRef: { workspacePath: string; workspaceKey: string }; workspaceId: string } {
    const grant = this.deps.grants.getActive(workspaceId);
    if (!grant) throw new GrantError(`workspace is not authorized: ${workspaceId}`, "WORKSPACE_NOT_AUTHORIZED");
    return { wsRef: { workspacePath: grant.canonicalPath, workspaceKey: grant.canonicalPath }, workspaceId };
  }

  private owned(principal: Principal, sessionId: string, access: WorkspaceAccess): OwnedSession {
    return this.deps.ownership.assertCanAccess(principal, sessionId, access);
  }

  async createSession(principal: Principal, req: SessionCreateRequest): Promise<SanitizedSessionState> {
    requireOfficialSessionService(this.deps);
    const access = req.access ?? "readonly";
    const { wsRef, workspaceId } = this.wsRef(req.workspace_id);
    // Grant check with the access the session will run under.
    this.deps.grants.authorizeAccess(workspaceId, access);
    const sessionId = await this.deps.provider.createSession(wsRef, {
      readonly: access === "readonly",
      ...(req.model ? { modelId: req.model } : {}),
      ...(req.thought_level ? { thoughtLevel: req.thought_level } : {}),
      ...(req.provider ? { providerId: req.provider } : {}),
    });
    try {
      const att = await attestedState(this.deps, sessionId, wsRef, access === "readonly");
      this.deps.ownership.record({ sessionId, workspaceId, clientId: principal.clientId ?? "local", accessMode: access });
      this.deps.audit.record("info", "session.created", { sessionId, workspaceId, access, clientId: principal.clientId ?? "local", model: att.modelId });
      this.priorTurnCompletedSessions.delete(sessionId);
      return sanitize(att, workspaceId);
    } catch (err) {
      // Fail closed: an unattestable session is torn down and never owned.
      await this.deps.provider.closeSession?.(sessionId).catch(() => undefined);
      throw err;
    }
  }

  async resumeSession(principal: Principal, req: { workspace_id: string; session_id: string; access: WorkspaceAccess }): Promise<SanitizedSessionState> {
    requireOfficialSessionService(this.deps);
    const { wsRef, workspaceId } = this.wsRef(req.workspace_id);
    this.deps.grants.authorizeAccess(workspaceId, req.access);
    this.owned(principal, req.session_id, req.access);
    await this.deps.provider.resumeSession(wsRef, req.session_id, { readonly: req.access === "readonly" });
    const att = await attestedState(this.deps, req.session_id, wsRef, req.access === "readonly");
    this.deps.ownership.touch(req.session_id);
    this.priorTurnCompletedSessions.delete(req.session_id);
    return sanitize(att, workspaceId);
  }

  async read(principal: Principal, req: { workspace_id: string; session_id: string }): Promise<SanitizedSessionState> {
    requireOfficialSessionService(this.deps);
    const { wsRef, workspaceId } = this.wsRef(req.workspace_id);
    this.deps.grants.authorizeAccess(workspaceId, "readonly");
    const owned = this.owned(principal, req.session_id, "readonly");
    const att = await this.deps.provider.readSessionState!(req.session_id, wsRef);
    this.deps.ownership.touch(req.session_id);
    void owned;
    return sanitize(att, workspaceId);
  }

  async send(principal: Principal, req: { workspace_id: string; session_id: string; instruction: string; timeout_ms?: number }): Promise<{ state: SanitizedSessionState; output: string; turn: string }> {
    requireOfficialSessionService(this.deps);
    const { wsRef, workspaceId } = this.wsRef(req.workspace_id);
    // Sending TEXT into a readonly session is allowed — the agent-layer plan
    // mode is what blocks mutations (live-proven). Ownership "readonly" access
    // means read/talk; mutation of session CONFIG (setModel/setMode/close)
    // requires write below.
    const owned = this.owned(principal, req.session_id, "readonly");
    // The grant must permit the session's OWN access mode on every send.
    this.deps.grants.authorizeAccess(workspaceId, owned.accessMode);
    // Consume synchronously before any await: only this send may use the evidence.
    const priorTurnCompleted = this.priorTurnCompletedSessions.delete(req.session_id);
    const att = await attestedState(this.deps, req.session_id, wsRef, owned.accessMode === "readonly");
    void att;
    const marker = await this.deps.provider.snapshotAssistantMarker?.(req.session_id).catch(() => undefined) ?? 0;
    // Transient-busy settle: model/thought setters return after the mutation is
    // attested, but the agent's turn slot can clear a beat later. A send that
    // fails with the transient "prompt already running" signature is retried
    // with a bounded settle window; a prompt that is STILL running after the
    // window is a real concurrent prompt and is rejected (fail-closed).
    const SETTLE_TOTAL_MS = this.deps.settleTotalMs ?? 5_000;
    const SETTLE_STEP_MS = this.deps.settleStepMs ?? 400;
    const settleDeadline = Date.now() + SETTLE_TOTAL_MS;
    let handle: Awaited<ReturnType<typeof this.deps.provider.send>>;
    for (;;) {
      try {
        handle = await this.deps.provider.send({
          sessionId: req.session_id,
          instruction: req.instruction,
          inputId: `z2csess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timeoutMs: Math.min(Math.max(req.timeout_ms ?? 5 * 60_000, 10_000), 15 * 60_000),
        });
        break;
      } catch (err) {
        const message = String((err as Error)?.message ?? err);
        const transient = /already running for this session|-32010\b/i.test(message);
        if (transient && Date.now() + SETTLE_STEP_MS <= settleDeadline) {
          await new Promise((r) => setTimeout(r, SETTLE_STEP_MS));
          continue;
        }

        // Bounded settle window exhausted (or non-transient error).
        // Mandatory Safety Gate 1: Never call stopSession merely because -32010 occurred.
        // Mandatory Safety Gate 2: Recovery allowed ONLY if BOTH:
        //   A. this live service has positive evidence that the immediately preceding turn
        //      for the exact same session reached a terminal/completed state through the provider completion path; AND
        //   B. a fresh authoritative readSessionState for that exact session reports a non-running terminal/idle state.
        if (transient && priorTurnCompleted) {
          let freshState: SessionStateAttestation | null = null;
          try {
            freshState = await this.deps.provider.readSessionState!(req.session_id, wsRef);
          } catch {
            freshState = null;
          }
          // Native session state uses exactly "idle"; all other values fail closed.
          if (freshState?.status === "idle") {
            // Qualified stale-busy!
            // Evidence was already consumed at send entry, before the state read.
            this.deps.audit.record("warn", "session.stale_busy_recovered", {
              sessionId: req.session_id,
              workspaceId,
              status: freshState?.status ?? null,
            });
            // Gate 4: On qualified stale-busy only: invoke provider.stopSession(sessionId) once,
            // re-read/settle if needed, then retry the original send once. Preserve session id and history/context.
            // Never close/create replacement session.
            await this.deps.provider.stopSession(req.session_id);
            try {
              handle = await this.deps.provider.send({
                sessionId: req.session_id,
                instruction: req.instruction,
                inputId: `z2csess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                timeoutMs: Math.min(Math.max(req.timeout_ms ?? 5 * 60_000, 10_000), 15 * 60_000),
              });
              break;
            } catch (retryErr) {
              const retryMsg = String((retryErr as Error)?.message ?? retryErr);
              throw new SessionServiceError(`session is busy: ${retryMsg.slice(0, 200)}`, "SESSION_BUSY", 409);
            }
          }
        }

        // Gate 3: If no prior terminal evidence, or state is running/busy/ambiguous/read fails,
        // preserve existing behavior: retry normally then fail SESSION_BUSY; do not interrupt.
        // Consume eligibility (Gate 5) and fail closed.
        this.priorTurnCompletedSessions.delete(req.session_id);
        throw new SessionServiceError(`session is busy: ${message.slice(0, 200)}`, "SESSION_BUSY", 409);
      }
    }
    try {
      const turn = await handle.completion;
      if (turn.status !== "completed") {
        this.priorTurnCompletedSessions.delete(req.session_id);
        throw new SessionServiceError(`turn did not complete: ${turn.detail ?? turn.status}`, "TURN_FAILED", 502);
      }
      // Interaction-resolution lag: plan/denial transitions project slightly
      // after the turn completes; let the projection settle before the
      // authoritative attestation read.
      const lag = this.deps.settleLagMs ?? 1500;
      if (lag > 0) {
        await new Promise((r) => setTimeout(r, lag));
      }
      const output = await this.deps.provider.readAssistantOutput(req.session_id, 16_000, { minAssistantCount: marker });
      this.deps.ownership.touch(req.session_id);
      this.deps.audit.record("info", "session.sent", { sessionId: req.session_id, workspaceId, clientId: principal.clientId ?? "local" });
      const state = await this.deps.provider.readSessionState!(req.session_id, wsRef);
      // Turn reached completed state through provider completion path: positive evidence installed.
      this.priorTurnCompletedSessions.add(req.session_id);
      return { state: sanitize(state, workspaceId), output, turn: turn.status };
    } catch (err) {
      this.priorTurnCompletedSessions.delete(req.session_id);
      throw err;
    }
  }

  async events(principal: Principal, req: { workspace_id: string; session_id: string; after_seq?: number; limit?: number }): Promise<Array<Record<string, unknown>>> {
    const { wsRef } = this.wsRef(req.workspace_id);
    this.deps.grants.authorizeAccess(req.workspace_id, "readonly");
    this.owned(principal, req.session_id, "readonly");
    if (typeof this.deps.provider.readSessionEvents !== "function") {
      throw new SessionServiceError("provider does not expose session events", "PROVIDER_UNSUPPORTED", 503);
    }
    const events = await this.deps.provider.readSessionEvents(req.session_id, { afterSeq: req.after_seq, limit: Math.min(req.limit ?? 50, 200) });
    this.deps.ownership.touch(req.session_id);
    void wsRef;
    return events.map((e) => {
      const { trace, ...rest } = e as Record<string, unknown> & { trace?: unknown };
      void trace; // drop transport-internal fields from the public surface
      return rest;
    });
  }

  async messages(principal: Principal, req: { workspace_id: string; session_id: string; limit?: number }): Promise<Array<Record<string, unknown>>> {
    this.deps.grants.authorizeAccess(req.workspace_id, "readonly");
    this.owned(principal, req.session_id, "readonly");
    if (typeof this.deps.provider.readSessionMessages !== "function") {
      throw new SessionServiceError("provider does not expose session messages", "PROVIDER_UNSUPPORTED", 503);
    }
    return this.deps.provider.readSessionMessages(req.session_id, { limit: Math.min(req.limit ?? 50, 200) });
  }

  async stop(principal: Principal, req: { workspace_id: string; session_id: string }): Promise<{ stopped: boolean }> {
    const { wsRef } = this.wsRef(req.workspace_id);
    void wsRef;
    this.deps.grants.authorizeAccess(req.workspace_id, "readonly");
    this.owned(principal, req.session_id, "readonly");
    this.priorTurnCompletedSessions.delete(req.session_id);
    await this.deps.provider.stopSession(req.session_id);
    this.deps.audit.record("info", "session.stopped", { sessionId: req.session_id, clientId: principal.clientId ?? "local" });
    return { stopped: true };
  }

  async close(principal: Principal, req: { workspace_id: string; session_id: string }): Promise<{ closed: boolean }> {
    this.deps.grants.authorizeAccess(req.workspace_id, "readonly");
    this.owned(principal, req.session_id, "write");
    this.priorTurnCompletedSessions.delete(req.session_id);
    await this.deps.provider.closeSession?.(req.session_id);
    this.deps.ownership.forget(req.session_id);
    this.deps.audit.record("info", "session.closed", { sessionId: req.session_id, clientId: principal.clientId ?? "local" });
    return { closed: true };
  }

  async setModel(principal: Principal, req: { workspace_id: string; session_id: string; model: string }): Promise<SanitizedSessionState> {
    const { wsRef, workspaceId } = this.wsRef(req.workspace_id);
    this.deps.grants.authorizeAccess(req.workspace_id, "readonly");
    this.owned(principal, req.session_id, "write");
    if (typeof (this.deps.provider as { updateSessionModel?: unknown }).updateSessionModel !== "function") {
      throw new SessionServiceError("provider does not support same-session model updates", "PROVIDER_UNSUPPORTED", 503);
    }
    this.priorTurnCompletedSessions.delete(req.session_id);
    await (this.deps.provider as { updateSessionModel: (ws: typeof wsRef, sid: string, c: { modelId?: string; thoughtLevel?: string }) => Promise<{ provider_id: string; model_id: string; thoughtLevel: string | null }> })
      .updateSessionModel(wsRef, req.session_id, { modelId: req.model });
    const att = await attestedState(this.deps, req.session_id, wsRef, false);
    return sanitize(att, workspaceId);
  }

  async setThoughtLevel(principal: Principal, req: { workspace_id: string; session_id: string; thought_level: string }): Promise<SanitizedSessionState> {
    const { wsRef, workspaceId } = this.wsRef(req.workspace_id);
    this.deps.grants.authorizeAccess(req.workspace_id, "readonly");
    this.owned(principal, req.session_id, "write");
    if (typeof (this.deps.provider as { updateSessionModel?: unknown }).updateSessionModel !== "function") {
      throw new SessionServiceError("provider does not support same-session thought updates", "PROVIDER_UNSUPPORTED", 503);
    }
    this.priorTurnCompletedSessions.delete(req.session_id);
    await (this.deps.provider as { updateSessionModel: (ws: typeof wsRef, sid: string, c: { thoughtLevel?: string }) => Promise<{ provider_id: string; model_id: string; thoughtLevel: string | null }> })
      .updateSessionModel(wsRef, req.session_id, { thoughtLevel: req.thought_level });
    const att = await attestedState(this.deps, req.session_id, wsRef, false);
    return sanitize(att, workspaceId);
  }

  async setMode(principal: Principal, req: { workspace_id: string; session_id: string; mode: "plan" | "build" | "edit" | "yolo" }): Promise<SanitizedSessionState> {
    const { wsRef, workspaceId } = this.wsRef(req.workspace_id);
    this.deps.grants.authorizeAccess(req.workspace_id, "readonly");
    this.owned(principal, req.session_id, "write");
    if (typeof this.deps.provider.setSessionCollaborationMode !== "function") {
      throw new SessionServiceError("provider does not support collaboration-mode switching", "PROVIDER_UNSUPPORTED", 503);
    }
    this.priorTurnCompletedSessions.delete(req.session_id);
    await this.deps.provider.setSessionCollaborationMode(req.session_id, req.mode);
    const att = await attestedState(this.deps, req.session_id, wsRef, false);
    return sanitize(att, workspaceId);
  }

  list(principal: Principal): Array<SanitizedSessionState & { access_mode: WorkspaceAccess }> {
    return this.deps.ownership.listFor(principal).map((s) => ({
      session_id: s.sessionId,
      workspace_id: s.workspaceId,
      provider_id: null,
      model_id: null,
      thought_level: null,
      collaboration_mode: null,
      plan_enabled: null,
      runtime_version: null,
      binding_source: "ownership-registry",
      access_mode: s.accessMode,
    }));
  }

  // ── Native session observation (shared agent-plane support) ───────────────
  //
  // OBSERVE and CONTROL are separate capabilities. These methods expose the
  // native session/list + session/read + session/messages surface for the
  // provider-neutral shared session plane: they make sessions that were NOT
  // created through Z2C (Desktop/manual/other clients of the runtime) visible
  // to the LOCAL OPERATOR without granting any control over them. Ownership
  // and the fail-closed control path above are unchanged; paired clients are
  // never allowed to observe native sessions they do not own.

  private requireLocalOperator(principal: Principal, action: string): void {
    if (principal.kind !== "local") {
      throw new SessionServiceError(
        `native session ${action} is local-operator only`,
        "OBSERVE_LOCAL_ONLY",
        403,
      );
    }
  }

  /**
   * Discover native sessions per authorized workspace via `session/list`,
   * canonical-root filtered: a reported session is only listed when its
   * observed workspace path canonicalizes INSIDE the matching grant. Sessions
   * owned by Z2C carry their owner projection; everything else is marked
   * external (Desktop/manual origin). Observe-only — no control is implied.
   */
  async discover(principal: Principal, req?: { workspace_id?: string }): Promise<Array<Record<string, unknown>>> {
    this.requireLocalOperator(principal, "discovery");
    if (typeof this.deps.provider.listSessions !== "function") {
      throw new SessionServiceError("provider does not expose session discovery", "PROVIDER_UNSUPPORTED", 503);
    }
    const grants = this.deps.grants.list().filter((g) => g.permissions.read && (req?.workspace_id === undefined || g.workspaceId === req.workspace_id));
    if (req?.workspace_id !== undefined && grants.length === 0) {
      throw new GrantError(`workspace is not authorized: ${req.workspace_id}`, "WORKSPACE_NOT_AUTHORIZED");
    }
    const discovered: Array<Record<string, unknown>> = [];
    const seenSessions = new Set<string>();

    for (const grant of grants) {
      let summaries: Awaited<ReturnType<AgentProvider["listSessions"]>>;
      try {
        summaries = await this.deps.provider.listSessions({ workspacePath: grant.canonicalPath, workspaceKey: grant.canonicalPath });
      } catch {
        continue; // a broken lane must not hide the other workspaces' sessions
      }
      for (const s of summaries) {
        if (seenSessions.has(s.sessionId)) continue;
        let canonical: string;
        try {
          canonical = canonicalizeWorkspacePath(s.workspacePath);
        } catch {
          continue; // uncanonicalizable path → never projected
        }
        const grantCanonical = canonicalizeWorkspacePath(grant.canonicalPath);
        if (canonical !== grantCanonical && !isSubPath(grantCanonical, canonical)) continue;
        seenSessions.add(s.sessionId);
        const owned = this.deps.ownership.get(s.sessionId) ?? null;
        discovered.push({
          session_id: s.sessionId,
          workspace_id: grant.workspaceId,
          workspace_path: grant.canonicalPath,
          status: s.status,
          title: s.title ?? null,
          updated_at: typeof s.updatedAt === "number" ? new Date(s.updatedAt).toISOString() : null,
          controlled_by_z2c: owned !== null,
          owner_client_id: owned?.clientId ?? null,
          access_mode: owned?.accessMode ?? null,
          runtime_origin: owned ? "z2c" : "external",
        });
      }
    }
    this.deps.audit.record("info", "session.discovered", { count: discovered.length, workspace_id: req?.workspace_id ?? null });
    return discovered;
  }

  /**
   * Authoritative sanitized state for ANY discovered native session in an
   * authorized workspace (local operator only). Workspace binding is enforced
   * by the provider's exact-session read (it throws on mismatch). Governance
   * attestation is deliberately NOT asserted here: native/manual sessions are
   * legal without satisfying the governed-execution policy, so observation
   * reports the OBSERVED identity with null (unproven) fields rather than
   * failing — policy gates control, not observation.
   */
  async observe(principal: Principal, req: { workspace_id: string; session_id: string }): Promise<SanitizedSessionState> {
    this.requireLocalOperator(principal, "observation");
    requireOfficialSessionService(this.deps);
    const { wsRef, workspaceId } = this.wsRef(req.workspace_id);
    this.deps.grants.authorizeAccess(workspaceId, "readonly");
    let att: SessionStateAttestation;
    try {
      att = await this.deps.provider.readSessionState!(req.session_id, wsRef);
    } catch {
      throw new SessionServiceError(
        `session ${req.session_id.slice(0, 12)} is not associated with this workspace`,
        "SESSION_NOT_FOUND",
        404,
      );
    }
    const grantCanonical = canonicalizeWorkspacePath(wsRef.workspacePath);
    const attCanonical = att.workspacePath ? canonicalizeWorkspacePath(att.workspacePath) : null;
    if (!attCanonical || (attCanonical !== grantCanonical && !isSubPath(grantCanonical, attCanonical))) {
      throw new SessionServiceError(
        `session ${req.session_id.slice(0, 12)} is not associated with this workspace`,
        "SESSION_NOT_FOUND",
        404,
      );
    }
    return sanitize(att, workspaceId);
  }

  /**
   * Visible message history for ANY discovered native session in an
   * authorized workspace (local operator only). The read is bound to the
   * authorized workspace through the provider's workspace-checked session
   * state read BEFORE any message is returned, so a session id from outside
   * the approved roots can never leak its content.
   */
  async observeMessages(principal: Principal, req: { workspace_id: string; session_id: string; limit?: number }): Promise<Array<Record<string, unknown>>> {
    this.requireLocalOperator(principal, "message observation");
    requireOfficialSessionService(this.deps);
    const { wsRef, workspaceId } = this.wsRef(req.workspace_id);
    this.deps.grants.authorizeAccess(workspaceId, "readonly");
    // Workspace binding proof for this exact session (throws on mismatch or unknown).
    let att: SessionStateAttestation;
    try {
      att = await this.deps.provider.readSessionState!(req.session_id, wsRef);
    } catch {
      throw new SessionServiceError(
        `session ${req.session_id.slice(0, 12)} is not associated with this workspace`,
        "SESSION_NOT_FOUND",
        404,
      );
    }
    const grantCanonical = canonicalizeWorkspacePath(wsRef.workspacePath);
    const attCanonical = att.workspacePath ? canonicalizeWorkspacePath(att.workspacePath) : null;
    if (!attCanonical || (attCanonical !== grantCanonical && !isSubPath(grantCanonical, attCanonical))) {
      throw new SessionServiceError(
        `session ${req.session_id.slice(0, 12)} is not associated with this workspace`,
        "SESSION_NOT_FOUND",
        404,
      );
    }
    if (typeof this.deps.provider.readSessionMessages !== "function") {
      throw new SessionServiceError("provider does not expose session messages", "PROVIDER_UNSUPPORTED", 503);
    }
    const rawMessages = await this.deps.provider.readSessionMessages(req.session_id, { limit: Math.min(req.limit ?? 50, 200) });
    return sanitizeSessionMessages(rawMessages);
  }
}

export { AttestationError, GrantError, OwnershipError, LOCAL_PRINCIPAL };
