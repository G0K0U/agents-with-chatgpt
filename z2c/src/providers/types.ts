/**
 * Agent-agnostic provider interface. The control plane (tasks/queue/workspaces)
 * talks only to this interface, so a future CodexProvider or other backend can
 * be added without touching security/task logic.
 */

export interface ProviderWorkspaceRef {
  workspacePath: string;
  workspaceKey: string;
}

export interface ProviderRunHandle {
  sessionId: string;
  /** Resolves when the turn reaches a terminal state. */
  completion: Promise<ProviderTurnResult>;
}

export type ProviderTurnStatus = "completed" | "failed" | "stopped";

export interface ProviderTurnResult {
  status: ProviderTurnStatus;
  detail?: string;
}

export interface ProviderSendOptions {
  sessionId: string;
  instruction: string;
  inputId: string;
  timeoutMs: number;
}

/** Options scoping an output read to the exact turn that was just executed. */
export interface ReadAssistantOutputOptions {
  /**
   * Number of assistant messages already present in the session BEFORE the
   * turn was sent (see snapshotAssistantMarker). Only messages beyond this
   * count may contribute output text; this prevents a resumed session's
   * history from being mistaken for the current turn's reply.
   */
  minAssistantCount?: number;
}

export interface ProviderSessionSummary {
  sessionId: string;
  workspacePath: string;
  status: string;
  title?: string;
  updatedAt?: number;
}

/**
 * Required Desktop execution identity. 2026-09-17 (PRODUCT POLICY): governed
 * ChatGPT-controlled GLM work is FLASH-ONLY on the coding-plan route. The
 * coding-plan Flash model is available on the live agent; the start-plan
 * route is unentitled and GLM main (GLM-5.3) is reserved for manual/native
 * ZCode use — never for governed C2C execution. Comparison targets only —
 * never evidence; the accepted binding must be OBSERVED from the agent's own
 * session state.
 */
export const REQUIRED_START_PLAN_PROVIDER_ID = "builtin:zai-coding-plan";
export const REQUIRED_START_PLAN_MODEL_ID = "GLM-5.3-Flash";

/**
 * The only binding evidence source admissible for governed execution: the
 * Desktop-managed exact-session read. The headless fallback provider reports
 * "session-read" — it cannot prove Desktop-managed auth and is therefore
 * FAIL-CLOSED at TaskEngine admission (unsupported for governed tasks).
 */
export const REQUIRED_BINDING_SOURCE = "desktop-session-read";

/** Effective provider/model binding, observed from real session/provider state. */
export interface ProviderBinding {
  provider_id: string;
  model_id: string;
  /** Where the binding was actually observed (e.g. "desktop-session-state"). */
  source: string;
}

/**
 * Same-session model/reasoning change request (Desktop-managed sessions
 * only). Implementations MUST operate on the existing native sessionId and
 * re-observe the resulting binding; a switch that cannot be confirmed on
 * re-read fails closed. At least one field is required.
 */
export interface SameSessionModelUpdate {
  modelId?: string;
  thoughtLevel?: string;
}

/** Binding re-observed from the session after a same-session update. */
export interface SameSessionModelUpdateResult {
  provider_id: string;
  model_id: string;
  thoughtLevel: string | null;
}

export interface AgentProvider {
  /** Present only on providers that can switch model/thought level on an existing session. */
  updateSessionModel?(workspace: ProviderWorkspaceRef, sessionId: string, change: SameSessionModelUpdate): Promise<SameSessionModelUpdateResult>;
  readonly name: string;
  /** Provider health; 'incompatible' must prevent task execution. */
  status: "healthy" | "incompatible" | "unreachable" | "stopped";
  statusDetail?: string;
  readonly providerVersion: string | null;
  readonly capabilityResult: CapabilityProbeResult | null;
  /** True when the provider never touches API-key based configuration. */
  readonly usesDesktopManagedAuth: boolean;

  /** Start the backend and verify required capabilities. Fail closed. */
  start(): Promise<void>;
  stop(): Promise<void>;

  listSessions(workspace: ProviderWorkspaceRef): Promise<ProviderSessionSummary[]>;
  /**
   * Create a session. `options.readonly` requests the agent-level read-only
   * (plan) mode so a governed readonly submission cannot mutate the
   * workspace even at the agent layer; workspace-write sessions run with
   * edit auto-approval (no interactive approver exists on this lane) while
   * non-edit tools still require approval.
   */
  createSession(workspace: ProviderWorkspaceRef, options?: { readonly?: boolean }): Promise<string>;
  resumeSession(workspace: ProviderWorkspaceRef, sessionId: string): Promise<void>;
  send(options: ProviderSendOptions): Promise<ProviderRunHandle>;
  stopSession(sessionId: string): Promise<void>;
  /**
   * Count assistant messages currently persisted for the session. Called
   * BEFORE a turn is sent so readAssistantOutput can scope its result to the
   * exact turn (resumed sessions carry prior history).
   */
  snapshotAssistantMarker(sessionId: string): Promise<number>;
  /** Bounded assistant text output for a session, scoped to the exact turn. */
  readAssistantOutput(sessionId: string, maxChars: number, opts?: ReadAssistantOutputOptions): Promise<string>;

  /**
   * Effective provider/model binding OBSERVED from the native exact-session
   * read surface (session/read) for this exact session. The returned
   * session's workspace association must match the authorized workspace;
   * missing or mismatched workspace/model reports null (unknown).
   */
  readSessionBinding(sessionId: string, workspace: ProviderWorkspaceRef): Promise<ProviderBinding | null>;
}

export interface CapabilityProbeResult {
  ok: boolean;
  expectedVersion: string;
  detectedVersion: string | null;
  required: Record<string, "present" | "missing" | "error">;
  preferred: Record<string, "present" | "missing" | "error">;
  checkedAt: string;
}
