import { type EntitlementAttestation, type EntitlementPlan, type EntitlementSelectionSupport, type unobservedEntitlement } from "./entitlement.js";
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
  entitlementPlan?: EntitlementPlan;
  /** Internal dispatch grant, never accepted from provider reverse requests. */
  executionGrant?: { workspacePath: string; write: boolean; mode?: "workspace" | "machine-local-development" };
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
  /**
   * When the turn carries a model error on its assistant message (e.g.
   * model_request_cancelled after a bounded cancellation), collect the text
   * produced BEFORE the error and surface the error inline instead of
   * throwing. Failure paths use this so partial checkpoint output stays
   * readable; success paths keep the throwing behavior (a model error must
   * fail the turn, never pass as success).
   */
  allowModelError?: boolean;
}

export interface ProviderSessionSummary {
  sessionId: string;
  workspacePath: string;
  status: string;
  title?: string;
  updatedAt?: number;
}

/**
 * Preferred Desktop execution identity. 2026-09-28 (UPDATED PRODUCT POLICY):
 * governed ChatGPT-controlled GLM work supports ALL models and effort levels
 * advertised by the live ZCode runtime — including GLM-5.3, GLM-5.3-Flash,
 * and any future model the runtime catalog publishes. The preferred default
 * is GLM-5.3 + max when advertised; explicit requests for any advertised
 * model/effort are honored. The coding-plan route is the preferred provider
 * when available. Comparison targets only — never evidence; the accepted
 * binding must be OBSERVED from the agent's own session state.
 *
 * Historical note (2026-09-17): governed work was Flash-only on the
 * coding-plan route; that restriction is removed.
 */
export const PREFERRED_START_PLAN_PROVIDER_ID = "builtin:zai-coding-plan";
export const PREFERRED_START_PLAN_MODEL_ID = "GLM-5.3";
/** @deprecated Use PREFERRED_START_PLAN_PROVIDER_ID. Kept for backward compatibility. */
export const REQUIRED_START_PLAN_PROVIDER_ID = PREFERRED_START_PLAN_PROVIDER_ID;
/** @deprecated Use PREFERRED_START_PLAN_MODEL_ID. Kept for backward compatibility. */
export const REQUIRED_START_PLAN_MODEL_ID = PREFERRED_START_PLAN_MODEL_ID;

/**
 * RETIRED provider routes: observed bindings from these routes are rejected
 * regardless of model. Route strings alone are never sufficient for admission
 * (the authoritative exact-session read is), but they ARE sufficient for
 * revocation. The start-plan route was revoked by the 2026-09-16 entitlement
 * change.
 */
export const RETIRED_PROVIDER_IDS: ReadonlySet<string> = new Set(["builtin:zai-start-plan"]);

/**
 * Admissible provider ROUTES for governed execution: the legacy Desktop
 * coding-plan route, the official standalone app-server route (whose live
 * sessions observe `zai-api` as the provider id on ZCode 0.16.9), and the
 * account-scoped INDIVIDUAL coding-plan routes published by the standalone
 * account runtime (`account:<family>-individual-coding-plan`, observed live as
 * `account:zai-individual-coding-plan` — 2026-10-01 chat admission repair).
 *
 * The START account routes (`account:zai-start-plan`,
 * `account:bigmodel-start-plan`) deliberately stay OUT of this set: Start
 * sessions are admitted through their registry-attested entitlement in
 * attestation.isAdmissibleObservedBinding, and an attested INDIVIDUAL must
 * never open the Start route (team/off-peak routes stay inadmissible: no Z2C
 * billing semantic). Admission ALWAYS additionally requires authoritative
 * exact-session evidence and a non-retired, live-advertised model (see
 * engine.governedBinding / assertGovernedAttestation).
 */
export const ADMISSIBLE_PROVIDER_ROUTES: ReadonlySet<string> = new Set([
  "builtin:zai-coding-plan",
  "zai-api",
  "account:zai-individual-coding-plan",
  "account:bigmodel-individual-coding-plan",
]);

/**
 * The only binding evidence sources admissible for governed execution:
 * authoritative exact-session reads. "desktop-session-read" is the legacy
 * Desktop-attached lane; "official-session-read" is the official standalone
 * app-server lane (open-source ZCode; provider auth resolved in-process).
 */
export const REQUIRED_BINDING_SOURCE = "desktop-session-read";
export const OFFICIAL_BINDING_SOURCE = "official-session-read";
export const REQUIRED_BINDING_SOURCES: ReadonlySet<string> = new Set([
  REQUIRED_BINDING_SOURCE,
  OFFICIAL_BINDING_SOURCE,
]);

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
  readonly expectedRuntimeVersion?: string;
  readonly capabilityResult: CapabilityProbeResult | null;
  /** True when the provider never touches API-key based configuration. */
  readonly usesDesktopManagedAuth: boolean;
  /**
   * Entitlement selection capability of the connected runtime (observed from
   * `runtime/capabilities`). Null/absent = the runtime cannot select or attest
   * semantic entitlements; START/INDIVIDUAL plans must fail closed.
   */
  readonly entitlementSelection?: EntitlementSelectionSupport | null;
  /**
   * Optional runtime generation: increments whenever the provider (re)spawns
   * its backend. Callers cache runtime-local evidence keyed to this number
   * and must invalidate it when it changes.
   */
  readonly runtimeGeneration?: number;

  /** Start the backend and verify required capabilities. Fail closed. */
  start(): Promise<void>;
  stop(): Promise<void>;

  listSessions(workspace?: ProviderWorkspaceRef, opts?: { timeoutMs?: number }): Promise<ProviderSessionSummary[]>;
  observeSessionSettings?(sessionId: string, opts?: { timeoutMs?: number }): Promise<unknown>;
  requestedIdentity?(): { modelId: string | null; thoughtLevel: string | null; providerId: string | null };
  /**
   * Create a session. `options.readonly` requests the agent-level read-only
   * (plan) mode so a governed readonly submission cannot mutate the
   * workspace even at the agent layer; implementations must ATTEST the
   * effective mode from authoritative state and fail closed if it cannot be
   * proven. `options.modelId`/`options.thoughtLevel`/`options.providerId`
   * request a native identity as HARD constraints (fail closed when the
   * runtime does not offer them); `options.preferredModelId`/
   * `preferredThoughtLevel` are PREFERENCES: applied only when the runtime's
   * own availability advertises them, never admission evidence. Model/thought
   * resolution uses ZCode's OWN availability state (never a hardcoded provider
   * id) and is attested on the exact session before the id is returned.
   */
  createSession(workspace: ProviderWorkspaceRef, options?: { onCreated?: (sessionId: string) => void; entitlementPlan?: EntitlementPlan; readonly?: boolean; modelId?: string; thoughtLevel?: string; providerId?: string; preferredModelId?: string; preferredThoughtLevel?: string }): Promise<string>;
  /**
   * Resume a native session. `options.readonly` re-establishes plan mode via
   * the authoritative v4 path when the provider supports it — live ZCode
   * resets collaboration state to workspace defaults on cold resume, so a
   * readonly lane must re-apply and re-attest before any send.
   */
  resumeSession(workspace: ProviderWorkspaceRef, sessionId: string, options?: { entitlementPlan?: EntitlementPlan; readonly?: boolean }): Promise<void>;
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

  /** Optional: clean native teardown of a session runtime (session/close). */
  closeSession?(sessionId: string): Promise<void>;

  /** Optional: authoritative collaboration-mode state (official provider). */
  readSessionState?(sessionId: string, workspace: ProviderWorkspaceRef): Promise<SessionStateAttestation>;

  /** Optional: switch collaboration mode via the authoritative v4 CAS path (official provider). */
  setSessionCollaborationMode?(sessionId: string, mode: "plan" | "build" | "edit" | "yolo"): Promise<unknown>;

  /** Optional: bounded event read for a session (official `session/events`). */
  readSessionEvents?(sessionId: string, opts?: { afterSeq?: number; limit?: number }): Promise<Array<Record<string, unknown>>>;

  /** Optional: bounded message read for a session (official `session/messages`). */
  readSessionMessages?(sessionId: string, opts?: { limit?: number }): Promise<Array<Record<string, unknown>>>;

  /** Optional: OS pid of the spawned agent child, when one is running. */
  readonly childPid?: number | null;
}

/**
 * Full observed execution identity of one governed session. Every field is
 * OBSERVED from native state (session/read + v4 projection) — requested or
 * configured values are never execution proof. Null fields mean "not
 * proven"; admission treats them accordingly (fail closed).
 */
export interface SessionStateAttestation {
  /** Exact-session entitlement evidence; absence = unproven (fail closed). */
  entitlement?: EntitlementAttestation;
  sessionId: string;
  workspaceKey: string | null;
  workspacePath: string | null;
  providerId: string | null;
  modelId: string | null;
  thoughtLevel: string | null;
  collaborationMode: string | null;
  /** Authoritative plan evidence (v4 config.planEnabled); null = not proven. */
  planEnabled: boolean | null;
  bindingSource: string;
  runtimeVersion: string | null;
  status: string | null;
  observedAt: string;
  /**
   * Models the runtime advertised for THIS session in the same authoritative
   * snapshot (settings.model.available[]). Null = the snapshot carried no
   * availability evidence; admission treats that as "not proven" (fail closed
   * on surfaces that require catalog evidence).
   */
  availableModels?: Array<{
    providerId: string | null;
    modelId: string;
    reasoningLevels: string[];
    reasoningDefaultLevel: string | null;
  }> | null;
}

export interface CapabilityProbeResult {
  ok: boolean;
  expectedVersion: string;
  detectedVersion: string | null;
  required: Record<string, "present" | "missing" | "error">;
  preferred: Record<string, "present" | "missing" | "error">;
  checkedAt: string;
}
