import { randomBytes } from "node:crypto";
import { IDEMPOTENCY_KEY, requestFingerprint } from "./idempotency.js";
import type { AgentProvider } from "../../providers/types.js";
import {
  REQUIRED_BINDING_SOURCE,
  REQUIRED_START_PLAN_MODEL_ID,
  REQUIRED_START_PLAN_PROVIDER_ID,
} from "../../providers/types.js";
import type { Z2cConfig } from "../../config.js";
import { FileAuditLog } from "../../util/log.js";
import { newOutputId, newTaskId } from "../../util/ids.js";
import {
  Persistence,
  type QueueState,
} from "./persistence.js";
import {
  TERMINAL_STATES,
  publicView,
  type PublicTaskView,
  type TaskRecord,
} from "./model.js";
import {
  WorkspaceRegistry,
  WorkspaceError,
} from "../workspaces/registry.js";

export interface SubmitTaskInput {
  idempotency_key?: string;
  workspace_id: string;
  instruction: string;
  write_scope?: "workspace" | "readonly";
  network?: "default";
  mode?: "plan" | "build" | "edit";
  /** Resume an existing ZCode session instead of creating a new one. */
  resume_session_id?: string;
  /** Native continuation must dispatch without waiting behind queued work. */
  immediate?: boolean;
}

export class TaskEngineError extends Error {
  constructor(message: string, public readonly code: string, public readonly httpStatus = 400) {
    super(message);
    this.name = "TaskEngineError";
  }
}

export class TaskEngine {
  private dispatching = new Set<string>();
  /** Serializes the single workspace admission path across awaiting submits. */
  private admissions = new Map<string, Promise<void>>();

  constructor(
    private readonly cfg: Z2cConfig,
    private readonly provider: AgentProvider,
    private readonly workspaces: WorkspaceRegistry,
    private readonly store: Persistence,
    private readonly audit: FileAuditLog,
  ) {}

  /** Bootstrap only after restart reconciliation; running work is never resent. */
  startQueuedTasks(): void {
    if (this.provider.status !== "healthy") return;
    for (const workspaceId of Object.keys(this.store.data.queues)) this.kick(workspaceId);
  }

  private kick(workspaceId: string): void {
    void this.pump(workspaceId).catch(() => {
      this.audit.record("error", "queue.dispatch_blocked", { workspaceId, reason: "durable persistence unavailable" });
    });
  }

  private validateKeyedAdmission(task: TaskRecord, workspacePath: string): void {
    const proof = task.idempotency;
    if (!proof || !IDEMPOTENCY_KEY.test(proof.key) || !/^z2c_[A-Za-z0-9_-]{1,100}$/.test(task.taskId) ||
        proof.workspacePath !== workspacePath || !task.zcodeSessionId || !/^sess_[0-9a-f-]{36}$/i.test(task.zcodeSessionId) ||
        task.modelBinding?.provider_id !== REQUIRED_START_PLAN_PROVIDER_ID || task.modelBinding?.model_id !== REQUIRED_START_PLAN_MODEL_ID ||
        task.modelBinding.source !== REQUIRED_BINDING_SOURCE || requestFingerprint({ workspace_id: task.workspaceId, instruction: task.instruction,
          write_scope: task.writeScope, network: task.network, mode: task.mode, resume_session_id: task.resumeOfSessionId ?? undefined }) !== proof.fingerprint) {
      throw new TaskEngineError("durable admission binding cannot be proven", "IDEMPOTENCY_INVALID", 503);
    }
  }

  /**
   * One serialized admission path per workspace: capacity check, native
   * session establishment, and enqueue all happen in submission order under
   * the per-workspace admission gate, so concurrent submits can neither
   * overshoot capacity nor reorder FIFO while session creation awaits. The
   * response carries the real z2c task id and its sess_* id; instruction
   * execution then continues asynchronously via the workspace pump.
   *
   * Two-phase binding gate: create/resume the exact sess_*, read THAT
   * session's effective binding from the agent's own state, and accept only
   * the required Start Plan identity before the task is admitted. Unknown or
   * deviating binding stops admission before any instruction send.
   */
  async submitTask(input: SubmitTaskInput): Promise<PublicTaskView> {
    if (input.idempotency_key !== undefined && (typeof input.idempotency_key !== "string" || !IDEMPOTENCY_KEY.test(input.idempotency_key))) {
      throw new TaskEngineError("idempotency_key must be 1..128 ASCII letters, digits, underscores or hyphens, starting alphanumeric", "INVALID_IDEMPOTENCY_KEY");
    }
    const workspace = this.workspaces.resolveAuthorized(input.workspace_id);
    const instruction = input.idempotency_key ? input.instruction : input.instruction?.trim();
    if (!instruction?.trim()) throw new TaskEngineError("instruction required", "INVALID_INSTRUCTION");
    if (instruction.length > this.cfg.maxInstructionChars) {
      throw new TaskEngineError(
        `instruction exceeds ${this.cfg.maxInstructionChars} chars`,
        "INVALID_INSTRUCTION",
      );
    }
    if (input.resume_session_id && !/^sess_[0-9a-f-]{36}$/i.test(input.resume_session_id)) {
      throw new TaskEngineError("invalid resume_session_id", "INVALID_SESSION");
    }

    const workspaceId = workspace.workspaceId;
    const previous = this.admissions.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    this.admissions.set(workspaceId, current);
    await previous;
    let task!: TaskRecord;
    try {
      this.store.assertHealthy();
      if (this.workspaces.resolveAuthorized(workspaceId).canonicalPath !== workspace.canonicalPath) {
        throw new WorkspaceError("workspace changed during admission", "WORKSPACE_MISMATCH");
      }
      const fingerprint = requestFingerprint(input);
      if (input.idempotency_key) {
        const matches = this.store.data.tasks.filter(t => t.workspaceId === workspaceId && t.idempotency?.key === input.idempotency_key);
        if (matches.length > 1) throw new TaskEngineError("ambiguous durable key", "IDEMPOTENCY_INVALID", 503);
        const accepted = matches[0];
        if (accepted) {
          if (accepted.idempotency!.fingerprint !== fingerprint || accepted.idempotency!.workspacePath !== workspace.canonicalPath) {
            throw new TaskEngineError("key is already bound to a different request", "IDEMPOTENCY_CONFLICT", 409);
          }
          this.validateKeyedAdmission(accepted, workspace.canonicalPath);
          const view = publicView(accepted);
          view.idempotency!.replayed = true;
          this.audit.record("info", "task.idempotency_replayed", { workspaceId, taskId: accepted.taskId, key: input.idempotency_key });
          return view;
        }
      }
      if (this.provider.status !== "healthy") {
        // A transient provider outage (desktop agent died and re-registered,
        // headless child crashed) must not wedge the lane in `unreachable`
        // until the whole bridge restarts. One bounded re-probe; if the
        // provider still is not healthy, admission fails closed below.
        if (this.provider.status === "unreachable") {
          try { await this.provider.start(); } catch { /* fall through to the gate */ }
        }
      }
      if (this.provider.status !== "healthy") {
        throw new TaskEngineError(`provider not healthy (${this.provider.status})`, "PROVIDER_UNAVAILABLE", 503);
      }
      const q = this.store.getOrCreateQueue(workspaceId);
      if (input.immediate && (q.paused || q.activeTask || q.queuedTaskIds.length || this.dispatching.has(workspaceId))) {
        throw new TaskEngineError("Native session is paused or busy; instruction was not queued", "SESSION_BUSY", 409);
      }
      const activeOrQueued = (q.activeTask ? 1 : 0) + q.queuedTaskIds.length;
      if (activeOrQueued >= this.cfg.queue.maxQueuedPerWorkspace) {
        throw new TaskEngineError("workspace queue is full", "QUEUE_FULL", 429);
      }

      const wsRef = { workspacePath: workspace.canonicalPath, workspaceKey: workspace.canonicalPath };
      let sessionId: string;
      if (input.resume_session_id) {
        // Prove ownership before native resume can change session state.
        const prior = await this.provider.readSessionBinding(input.resume_session_id, wsRef);
        if (!prior || prior.provider_id !== REQUIRED_START_PLAN_PROVIDER_ID || prior.model_id !== REQUIRED_START_PLAN_MODEL_ID ||
            prior.source !== REQUIRED_BINDING_SOURCE) {
          throw new TaskEngineError("Existing native session workspace/model binding is unverified", "BINDING_UNVERIFIED", 503);
        }
        await this.provider.resumeSession(wsRef, input.resume_session_id);
        sessionId = input.resume_session_id;
      } else {
        sessionId = await this.provider.createSession(wsRef, { readonly: (input.write_scope ?? "workspace") === "readonly" });
        // Flash-only governed policy: a freshly created session inherits the
        // Desktop's currently selected model (which may be GLM main). When
        // the provider can switch models on the SAME session, move it to the
        // required model BEFORE admission. Switch failure is intentionally
        // not fatal here — the binding verification below fails closed when
        // the required identity is not observed, so an unswitched session is
        // rejected, never silently admitted.
        if (
          typeof (this.provider as { updateSessionModel?: unknown }).updateSessionModel === "function" &&
          this.provider.usesDesktopManagedAuth
        ) {
          await this.provider
            .updateSessionModel!(wsRef, sessionId, { modelId: REQUIRED_START_PLAN_MODEL_ID })
            .catch(() => undefined);
        }
      }
      // Single execution-identity source: read the EXACT session just
      // created/resumed through the native exact-session read surface, and
      // accept only the required Start Plan identity for THIS workspace.
      const binding = await this.provider.readSessionBinding(sessionId, wsRef);
      if (
        !binding ||
        binding.provider_id !== REQUIRED_START_PLAN_PROVIDER_ID ||
        binding.model_id !== REQUIRED_START_PLAN_MODEL_ID ||
        binding.source !== REQUIRED_BINDING_SOURCE
      ) {
        throw new TaskEngineError(
          `unverified execution binding for ${sessionId} (observed ` +
            `${binding ? `${binding.provider_id}/${binding.model_id}` : "unknown"}; ` +
            `requires ${REQUIRED_START_PLAN_PROVIDER_ID}/${REQUIRED_START_PLAN_MODEL_ID})`,
          "BINDING_UNVERIFIED",
          503,
        );
      }

      if (input.immediate && (q.paused || q.activeTask || q.queuedTaskIds.length || this.dispatching.has(workspaceId))) {
        throw new TaskEngineError("Native session became paused or busy; instruction was not queued", "SESSION_BUSY", 409);
      }
      task = {
        ...(input.idempotency_key ? { idempotency: { key: input.idempotency_key, fingerprint, workspacePath: workspace.canonicalPath } } : {}),
        taskId: newTaskId(),
        workspaceId,
        zcodeSessionId: sessionId,
        status: "queued",
        instruction,
        writeScope: input.write_scope ?? "workspace",
        network: input.network ?? "default",
        mode: input.mode ?? "build",
        createdAt: Date.now(),
        startedAt: null,
        completedAt: null,
        exitStatus: null,
        outputId: null,
        resumeOfSessionId: input.resume_session_id ?? null,
        modelBinding: binding,
      };
      if (this.workspaces.resolveAuthorized(workspaceId).canonicalPath !== workspace.canonicalPath) {
        throw new WorkspaceError("workspace changed during admission", "WORKSPACE_MISMATCH");
      }
      this.store.admitTask(task);
      this.audit.record("info", "task.submitted", {
        taskId: task.taskId,
        workspaceId,
        sessionId,
        binding: `${binding.provider_id}/${binding.model_id}`,
        mode: task.mode,
        writeScope: task.writeScope,
        resumeOf: task.resumeOfSessionId,
        queuedBehind: this.store.getOrCreateQueue(workspaceId).queuedTaskIds.length,
        queuePaused: q.paused,
      });
    } finally {
      release();
      if (this.admissions.get(workspaceId) === current) this.admissions.delete(workspaceId);
    }
    this.kick(workspaceId);
    return publicView(task);
  }

  getQueue(workspaceId: string): Required<Pick<QueueState, "paused">> & {
    workspaceId: string;
    activeTask: string | null;
    queuedTaskCount: number;
    nextQueuedTaskId: string | null;
  } {
    const workspace = this.workspaces.resolveAuthorized(workspaceId);
    const q = this.store.getOrCreateQueue(workspace.workspaceId);
    return {
      workspaceId: workspace.workspaceId,
      paused: q.paused,
      activeTask: q.activeTask,
      queuedTaskCount: q.queuedTaskIds.length,
      nextQueuedTaskId: q.queuedTaskIds[0] ?? null,
    };
  }

  pauseQueue(workspaceId: string): void {
    const workspace = this.workspaces.resolveAuthorized(workspaceId);
    const q = this.store.getOrCreateQueue(workspace.workspaceId);
    q.paused = true;
    this.store.saveQueue(workspace.workspaceId, q);
    this.audit.record("info", "queue.paused", { workspaceId: workspace.workspaceId });
  }

  resumeQueue(workspaceId: string): void {
    const workspace = this.workspaces.resolveAuthorized(workspaceId);
    const q = this.store.getOrCreateQueue(workspace.workspaceId);
    q.paused = false;
    this.store.saveQueue(workspace.workspaceId, q);
    this.audit.record("info", "queue.resumed", { workspaceId: workspace.workspaceId });
    this.kick(workspace.workspaceId);
  }

  /**
   * Serial dispatcher: one active writer per workspace, FIFO.
   * Paused workspaces never dispatch queued tasks.
   */
  private async pump(workspaceId: string): Promise<void> {
    if (this.dispatching.has(workspaceId)) return;
    this.dispatching.add(workspaceId);
    try {
      for (;;) {
        this.store.assertHealthy();
        const q = this.store.getOrCreateQueue(workspaceId);
        if (q.paused) return;
        if (q.activeTask) return;
        const next = q.queuedTaskIds[0];
        if (!next) return;
        q.activeTask = next;
        q.queuedTaskIds.shift();
        this.store.saveQueue(workspaceId, q);
        await this.runTask(next).catch((err) => {
          this.audit.record("error", "task.run_error", {
            taskId: next,
            error: String((err as Error)?.message ?? err).slice(0, 300),
          });
          const t = this.store.findTask(next);
          if (t && !TERMINAL_STATES.has(t.status)) {
            this.store.setStatus(next, "failed", String((err as Error)?.message ?? err).slice(0, 200));
          }
        });
        const q2 = this.store.getOrCreateQueue(workspaceId);
        q2.activeTask = null;
        this.store.saveQueue(workspaceId, q2);
      }
    } finally {
      this.dispatching.delete(workspaceId);
    }
  }

  private async runTask(taskId: string): Promise<void> {
    const task = this.store.findTask(taskId);
    if (!task) return;
    // Dispatch-time authorization: a workspace revoked while queued must not
    // execute. (Submit-time authorization is separate and also stays.)
    const workspace = this.workspaces.resolveAuthorized(task.workspaceId);
    if (task.idempotency) this.validateKeyedAdmission(task, workspace.canonicalPath);
    this.store.assertHealthy();
    this.store.setStatus(taskId, "running", undefined);
    this.audit.record("info", "task.started", { taskId, workspaceId: task.workspaceId });

    try {
      // The native session was established and binding-verified at submit
      // time; execution here is send-only.
      const binding = await this.provider.readSessionBinding(task.zcodeSessionId!, { workspacePath: workspace.canonicalPath, workspaceKey: workspace.canonicalPath });
      if (!binding || binding.provider_id !== REQUIRED_START_PLAN_PROVIDER_ID || binding.model_id !== REQUIRED_START_PLAN_MODEL_ID ||
          binding.source !== REQUIRED_BINDING_SOURCE) {
        throw new TaskEngineError("Native session binding changed before send", "BINDING_UNVERIFIED", 503);
      }
      // Scope the output read to THIS turn: snapshot the assistant-message
      // count before sending so a resumed session's prior history can never be
      // returned as this turn's reply.
      const assistantMarker = await Promise.resolve()
        .then(() => this.provider.snapshotAssistantMarker?.(task.zcodeSessionId!))
        .catch(() => undefined)
        ?? 0;
      const handle = await this.provider.send({
        sessionId: task.zcodeSessionId!,
        instruction: task.instruction,
        inputId: `z2c-${task.taskId}`,
        timeoutMs: 15 * 60_000,
      });
      const result = await handle.completion;

      const text = await this.provider.readAssistantOutput(
        task.zcodeSessionId!,
        this.cfg.maxOutputChars,
        { minAssistantCount: assistantMarker },
      );
      const outputId = newOutputId();
      this.store.saveOutput({
        outputId,
        taskId: task.taskId,
        workspaceId: task.workspaceId,
        sessionId: task.zcodeSessionId,
        text,
        createdAt: Date.now(),
      });
      task.outputId = outputId;

      // Cancellation may have raced with completion; never overwrite terminal truth.
      const fresh = this.store.findTask(taskId)!;
      if (TERMINAL_STATES.has(fresh.status)) {
        this.audit.record("info", "task.finished_ignored_terminal", {
          taskId,
          resultStatus: result.status,
          currentStatus: fresh.status,
        });
        return;
      }
      if (result.status === "completed") {
        this.store.setStatus(taskId, "completed", "ok");
      } else if (result.status === "stopped") {
        this.store.setStatus(taskId, "cancelled", "session stopped");
      } else {
        this.store.setStatus(taskId, "failed", result.detail ?? "turn failed");
      }
      this.audit.record("info", "task.finished", {
        taskId,
        sessionId: task.zcodeSessionId,
        status: result.status,
        outputId,
      });
    } catch (err) {
      const msg = String((err as Error)?.message ?? err).slice(0, 200);
      const t = this.store.findTask(taskId)!;
      if (t.status === "cancelled") {
        // cancellation raced with the failure — keep cancelled
      } else if (t.status !== "running") {
        // already terminal (e.g. cancelled while dispatching) — leave as-is
      } else {
        this.store.setStatus(taskId, "failed", msg);
      }
      this.audit.record("warn", "task.error", { taskId, error: msg });
      throw err;
    }
  }

  cancelTask(workspaceId: string | undefined, taskId: string): PublicTaskView {
    const task = this.store.findTask(taskId);
    if (!task) throw new TaskEngineError(`unknown task: ${taskId}`, "NOT_FOUND", 404);
    if (workspaceId && workspaceId !== task.workspaceId) {
      throw new TaskEngineError("task belongs to a different workspace", "WORKSPACE_MISMATCH", 403);
    }
    if (TERMINAL_STATES.has(task.status)) {
      return publicView(task); // deterministic response for already-terminal tasks
    }
    const q = this.store.getOrCreateQueue(task.workspaceId);
    const queueIdx = q.queuedTaskIds.indexOf(taskId);
    if (queueIdx >= 0) {
      q.queuedTaskIds.splice(queueIdx, 1);
      this.store.saveQueue(task.workspaceId, q);
      this.store.setStatus(taskId, "cancelled", "cancelled while queued");
    } else if (q.activeTask === taskId && task.zcodeSessionId) {
      void this.provider
        .stopSession(task.zcodeSessionId)
        .catch((err) =>
          this.audit.record("warn", "task.cancel_error", {
            taskId,
            error: String((err as Error)?.message ?? err).slice(0, 200),
          }),
        );
      this.store.setStatus(taskId, "cancelled", "session stop requested");
    } else {
      this.store.setStatus(taskId, "cancelled", "cancelled before dispatch");
    }
    this.audit.record("info", "task.cancelled", { taskId, workspaceId: task.workspaceId });
    return publicView(this.store.findTask(taskId)!);
  }

  getTask(workspaceId: string | undefined, taskId: string): PublicTaskView {
    const task = this.store.findTask(taskId);
    if (!task) throw new TaskEngineError(`unknown task: ${taskId}`, "NOT_FOUND", 404);
    if (workspaceId && workspaceId !== task.workspaceId) {
      throw new TaskEngineError("task belongs to a different workspace", "WORKSPACE_MISMATCH", 403);
    }
    return publicView(task);
  }

  getOutput(workspaceId: string | undefined, taskId: string, outputId: string): { output_id: string; task_id: string; session_id: string | null; text: string } {
    const task = this.store.findTask(taskId);
    if (!task) throw new TaskEngineError(`unknown task: ${taskId}`, "NOT_FOUND", 404);
    if (workspaceId && workspaceId !== task.workspaceId) {
      throw new TaskEngineError("task belongs to a different workspace", "WORKSPACE_MISMATCH", 403);
    }
    if (!task.outputId) {
      throw new TaskEngineError("task has no output yet", "NO_OUTPUT", 409);
    }
    // Ambiguous/unknown output ids fail closed — no prefix matching, no guessing.
    const entry = this.store.data.outputs.find(
      (o) => o.outputId === outputId && o.taskId === taskId,
    );
    if (!entry || entry.outputId !== task.outputId) {
      throw new TaskEngineError("output does not belong to this task", "OUTPUT_MISMATCH", 403);
    }
    if (entry.workspaceId !== task.workspaceId) {
      throw new TaskEngineError("output workspace mismatch", "WORKSPACE_MISMATCH", 403);
    }
    return { output_id: entry.outputId, task_id: entry.taskId, session_id: entry.sessionId, text: entry.text };
  }
}

export { WorkspaceError };
