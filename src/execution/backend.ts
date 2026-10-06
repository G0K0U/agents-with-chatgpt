/**
 * Provider-neutral execution backend abstraction for C2C.
 * Supports "codex" (App Server) and "gemini" (Antigravity CLI harness).
 */

export type ExecutionProvider = "codex" | "gemini";

export interface BackendIdentity {
  providerSessionId: string;
  providerTurnId?: string;
}

export type TaskLifecyclePhase =
  | "QUEUED"
  | "SPAWNING_PROVIDER"
  | "PROVIDER_STARTED"
  | "SESSION_ESTABLISHING"
  | "SESSION_ESTABLISHED"
  | "EXECUTING"
  | "TERMINAL";

export interface BackendExecutionRequest {
  taskId: string;
  workspaceId: string;
  workspaceRoot: string;
  instruction: string;
  writeScope: string[];
  writableRoots: string[];
  networkRequested: boolean;
  networkEffective: boolean;
  fullAccess: boolean;
  runTests: boolean;
  sessionId?: string;
  providerSessionId?: string;
  model?: string;
  timeoutMs: number;
  /** Set false by background janitor lanes: their attempts must not write the shared on-demand evidence. */
  evidence?: boolean;
  onOutput?: (chunk: string) => void;
  onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
  /** Persist bridge-owned linkage before/while the remote turn runs. */
  onIdentity?: (identity: BackendIdentity) => void;
  /** Observable lifecycle transitions for bounded startup and diagnosis. */
  onLifecyclePhase?: (phase: TaskLifecyclePhase) => void;
}

export interface BackendExecutionResult {
  status: "completed" | "failed" | "cancelled" | "timed_out";
  provider: ExecutionProvider;
  providerRuntime: string;
  providerModel: string;
  requestedProvider?: ExecutionProvider | string;
  requestedModel?: string;
  dispatchedModel?: string;
  requestedSelection?: { model: string | null; effort: string | null } | null;
  dispatchedSelection?: unknown;
  actualProvider?: ExecutionProvider | string | null;
  actualModel?: string | null;
  observedModel?: string | null;
  observedSelection?: {
    model: string | null;
    effort: string | null;
    effortStatus?: "verified" | "unverified";
    source: string;
    mismatch?: boolean;
  } | null;
  failureDetails?: {
    reason: string;
    pool: string;
    retryAfter: number | null;
    resetAt: string | null;
    evidenceSource: string;
    rawEvidence?: string | null;
  };
  phaseDurations?: Record<string, number>;
  providerSessionId?: string;
  providerTurnId?: string;
  /** True when a dead/stale resumed session was discarded and a fresh session carried the task (G2). */
  sessionRecovered?: boolean;
  /** Set false by background janitor lanes: their attempts must not write the shared on-demand evidence. */
  evidence?: boolean;
  networkReported?: boolean;
  /** False means a remote writer could still be alive; retain the workspace lease. */
  quiescent?: boolean;
  output: string;
  changedFiles: string[];
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    thinkingTokens?: number;
    cacheReadTokens?: number;
    totalTokens?: number;
  };
  exitCode?: number | null;
  error?: {
    code: string;
    message: string;
    pool?: string | null;
    retryAfter?: number | string | null;
    resetAt?: string | null;
    reason?: string | null;
    evidenceSource?: string | null;
  };
}

export interface ExecutionBackend {
  readonly provider: ExecutionProvider;
  initialize(workspaceRoot: string): Promise<void>;
  execute(request: BackendExecutionRequest): Promise<BackendExecutionResult>;
  cancel(taskId: string, identity?: BackendIdentity): Promise<void>;
  close(): Promise<void>;
}
