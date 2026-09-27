export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export const TERMINAL_STATES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const);

export interface TaskRecord {
  idempotency?: { key: string; fingerprint: string; workspacePath: string };
  taskId: string;
  workspaceId: string;
  zcodeSessionId: string | null;
  status: TaskStatus;
  instruction: string;
  /** Requested, not necessarily enforced — see permission classification. */
  writeScope: "workspace" | "readonly";
  network: "default";
  mode: "plan" | "build" | "edit";
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  exitStatus: string | null;
  outputId: string | null;
  resumeOfSessionId: string | null;
  /**
   * Binding OBSERVED from the exact session's own state at admission
   * (session/read). Null only on legacy records that never had a verified
   * session. The Phase-2 fields (thoughtLevel/collaborationMode/planEnabled/
   * runtimeVersion/workspaceKey) are present only when the provider exposes
   * the full authoritative attestation (official lane); absent/null = not
   * proven — admission treats them accordingly (fail closed).
   */
  modelBinding: {
    provider_id: string;
    model_id: string;
    source: string;
    thoughtLevel?: string | null;
    collaborationMode?: string | null;
    planEnabled?: boolean | null;
    runtimeVersion?: string | null;
    workspaceKey?: string | null;
  } | null;
}

/** Bounded public view — never includes full conversation history. */
export interface PublicTaskView {
  idempotency?: { protocol: "workspace-task-v1"; key: string; request_fingerprint: string; replayed: boolean };
  task_id: string;
  session_id: string | null;
  workspace_id: string;
  status: TaskStatus;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  exit_status: string | null;
  output_id: string | null;
  model_binding: { provider_id: string; model_id: string; source: string } | null;
}

export function publicView(t: TaskRecord): PublicTaskView {
  return {
    ...(t.idempotency ? { idempotency: { protocol: "workspace-task-v1" as const, key: t.idempotency.key,
      request_fingerprint: t.idempotency.fingerprint, replayed: false } } : {}),
    task_id: t.taskId,
    session_id: t.zcodeSessionId,
    workspace_id: t.workspaceId,
    status: t.status,
    created_at: new Date(t.createdAt).toISOString(),
    started_at: t.startedAt ? new Date(t.startedAt).toISOString() : null,
    completed_at: t.completedAt ? new Date(t.completedAt).toISOString() : null,
    exit_status: t.exitStatus,
    output_id: t.outputId,
    model_binding: t.modelBinding,
  };
}
