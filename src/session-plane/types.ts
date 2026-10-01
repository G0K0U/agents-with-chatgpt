/**
 * Provider-neutral shared session/activity plane — public record shapes.
 *
 * One projection joins all agent providers (codex, gemini/antigravity, zcode, dsh)
 * and both origins (created through A2C vs. native/Desktop/manual runtime
 * sessions discovered through their local runtime surfaces). OBSERVE and
 * CONTROL are separate capabilities: these records describe visibility only;
 * control stays owner-bound in each provider's own enforcement path.
 */

export type AgentProviderName = "codex" | "gemini" | "zcode" | "dsh";

/**
 * Where a session was created:
 *   a2c     — through this A2C bridge (any provider lane)
 *   native  — through the provider runtime outside A2C but under a local
 *             control lane (e.g. the Z2C companion service)
 *   desktop — through the provider's own Desktop/manual UI, discovered from
 *             native runtime state, never controlled remotely
 */
export type AgentSessionOrigin = "a2c" | "native" | "desktop";

/** Visible-message shape: visible user instructions and assistant responses only. */
export interface AgentPlaneMessage {
  role: "user" | "assistant";
  text: string;
  truncated?: boolean;
  /** Reference to the durable execution-output body (workspace-scoped id). */
  outputRef?: { workspaceId: string; outputId: number } | null;
  /** Present instead of text when the output body is restricted/not readable. */
  restricted?: boolean;
  at: string | null;
}

export interface AgentSessionRecord {
  /** Provider-neutral stable key. */
  sessionId: string;
  provider: AgentProviderName;
  origin: AgentSessionOrigin;
  /** A2C workspace identity the session is fenced to. */
  workspaceId: string;
  /** Canonical workspace root binding (internal projection field). */
  canonicalRoot: string;
  /** Native runtime session id (e.g. sess_… for ZCode). */
  nativeSessionId: string | null;
  /** Provider-internal identity (Codex thread id / AGY conversation id). */
  providerSessionId: string | null;
  /** Owner projection: controlling client id, "local" = local operator. */
  ownerClientId: string | null;
  /** Principals allowed to CONTROL (owner, "local", delegated controllers). */
  controllers: string[];
  model: string | null;
  /** Reasoning effort / thought level where the provider exposes one. */
  thoughtLevel: string | null;
  status: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  taskIds: string[];
  /** Last visible user instruction (redacted, bounded). */
  lastUserInstruction: string | null;
  /** Durable assistant response reference (execution-output id), if captured. */
  lastAssistantOutput: { workspaceId: string; outputId: number } | null;
  changedFilesCount: number;
  verificationStatus: string | null;
  /** Z2C grant id for zcode sessions (internal, used for live reads). */
  zcodeWorkspaceId?: string;
  observedAt: string;
  /**
   * Honest live-read evidence for zcode sessions. A cached projection that
   * failed to refresh live is never disguised as a live success.
   *   "stale-runtime" — the session is discovery-listed but not live-readable
   *   in the current runtime generation (legacy/pre-restart or closed); the
   *   projection keeps last-known metadata until the session is explicitly
   *   resumed. Not an error and never auto-migrated.
   */
  live_read_status?: "ok" | "error" | "skipped" | "stale-cache" | "stale-runtime";
  messages_readable?: boolean | null;
  last_live_error?: string | null;
}

export interface AgentActivityEvent {
  /** Monotonic per-deployment sequence (cursor for pagination). */
  seq: number;
  /** Stable identity of the fact (dedup across syncs/restarts). */
  key: string;
  at: string;
  type:
    | "session.created"
    | "session.updated"
    | "session.discovered"
    | "task.created"
    | "task.updated"
    | "task.completed"
    | "task.failed";
  provider: AgentProviderName;
  workspaceId: string | null;
  sessionId: string | null;
  taskId: string | null;
  /** Short bounded, redacted summary (never message bodies). */
  summary: string;
  /** Bounded sanitized evidence/output reference if captured. */
  outputRef?: { workspaceId: string; outputId: number } | null;
}

export interface AgentTaskView {
  taskId: string;
  workspaceId: string;
  sessionId: string | null;
  provider: AgentProviderName | null;
  providerSessionId: string | null;
  model: string | null;
  effort?: string | null;
  selectionScope?: string | null;
  status: string;
  exitStatus: string | null;
  submittedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  ownerId: string | null;
  instructionPreview: string | null;
  changedFilesCount: number;
  changedFiles: string[];
  networkRequested: boolean | null;
  networkEffective: boolean | null;
  outputIds: number[];
  outputAvailable: boolean;
  actionEvidence: {
    turnCompleted: boolean;
    changedFiles: number;
    finalOutputCaptured: boolean;
  } | null;
  nativeEvidence?: { terminalSeq: number | null; terminalReason: string | null;
    toolCalls: number; toolResults: number; servedModel?: string | null;
    servedEffort?: string | null; servedProvider?: string | null } | null;
  verification: {
    status: string | null;
    exitCode: number | null;
    completedAt: string | null;
    outputId: number | null;
  } | null;
  error: { code?: string; message?: string } | null;
}
