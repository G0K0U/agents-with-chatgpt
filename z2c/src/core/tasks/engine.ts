import { type EntitlementPlan, entitlementPlan, entitlementAccessMode, requireSupportedEntitlement } from "../../providers/entitlement.js";
import { randomBytes } from "node:crypto";
import { IDEMPOTENCY_KEY, requestFingerprint } from "./idempotency.js";
import { classifyTaskFailure } from "./failure-class.js";
import type { AgentProvider } from "../../providers/types.js";
import {
  ADMISSIBLE_PROVIDER_ROUTES,
  REQUIRED_BINDING_SOURCES,
  RETIRED_PROVIDER_IDS,
} from "../../providers/types.js";
import { isAdmissibleObservedBinding } from "../../authz/attestation.js";
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
  entitlement_plan?: EntitlementPlan;
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
  /**
   * Explicit native identity request. Preference, never proof: the provider
   * resolves both against the exact session's OWN advertised availability
   * (settings.model.available[] + per-model reasoning.levels), applies them,
   * and the OBSERVED binding must equal the request or admission fails closed.
   * No silent substitution, no silent downgrade/upgrade.
   */
  model_id?: string;
  thought_level?: string;
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

  /**
   * Catalog-driven governed admission (2026-09-28 policy): the binding must be
   * OBSERVED from an authoritative exact-session read on an admissible,
   * non-retired provider ROUTE, and the observed model must be advertised by
   * the runtime in the SAME snapshot. Any advertised model × its own
   * advertised reasoning levels is admissible; single-model constants (the
   * old Flash-only and GLM-5.3-only rules) are gone. An explicitly requested
   * identity must match the observation exactly.
   */
  private governedBinding(
    binding: TaskRecord["modelBinding"],
    requested?: { modelId?: string | null; thoughtLevel?: string | null; entitlementPlan?: EntitlementPlan | null },
  ): boolean {
    if (!isAdmissibleObservedBinding(binding ?? undefined)) return false;
    const b = binding!;
    if (requested?.modelId && b.model_id !== requested.modelId) return false;
    if (requested?.thoughtLevel && b.thoughtLevel !== requested.thoughtLevel) return false;
    // Non-DEFAULT entitlement requests are admitted ONLY on the runtime's own
    // registry-backed readback for this exact session; missing evidence or a
    // different observed access mode fails closed (no provider-id inference).
    if (requested?.entitlementPlan && requested.entitlementPlan !== "DEFAULT") {
      const expectedMode = entitlementAccessMode(requested.entitlementPlan);
      if (!expectedMode) return false;
      if (!b.entitlement || b.entitlement.source !== "provider-registry") return false;
      if (b.entitlement.observed !== expectedMode) return false;
    }
    return true;
  }

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
        !this.governedBinding(task.modelBinding, { modelId: task.requestedModelId, thoughtLevel: task.requestedThoughtLevel, entitlementPlan: task.entitlementPlan ?? "DEFAULT" }) ||
        // Readonly replay requires persisted authoritative plan evidence.
        (task.writeScope === "readonly" && task.modelBinding?.planEnabled !== true) ||
        requestFingerprint({ workspace_id: task.workspaceId, instruction: task.instruction,
          write_scope: task.writeScope, network: task.network, mode: task.mode,
          model_id: task.requestedModelId ?? undefined, thought_level: task.requestedThoughtLevel ?? undefined,
          entitlement_plan: task.entitlementPlan, resume_session_id: task.resumeOfSessionId ?? undefined }) !== proof.fingerprint) {
      throw new TaskEngineError("durable admission binding cannot be proven", "IDEMPOTENCY_INVALID", 503);
    }
  }

  /**
   * OBSERVED execution evidence for the exact session, from the richest
   * authoritative surface the provider offers. Providers with a full
   * attestation surface (official lane) contribute thoughtLevel /
   * collaboration state / planEnabled / runtime version; anything absent is
   * recorded as "not proven" (null) and validated by the caller.
   * Requested or configured values never appear here.
   */
  private async collectExecutionEvidence(
    sessionId: string,
    wsRef: { workspacePath: string; workspaceKey: string },
    readonlyLane: boolean,
  ): Promise<NonNullable<TaskRecord["modelBinding"]>> {
    if (typeof this.provider.readSessionState === "function") {
      try {
        const state = await this.provider.readSessionState(sessionId, wsRef);
        return {
          provider_id: state.providerId ?? "",
          model_id: state.modelId ?? "",
          source: state.bindingSource,
          thoughtLevel: state.thoughtLevel,
          collaborationMode: state.collaborationMode,
          planEnabled: state.planEnabled,
          runtimeVersion: state.runtimeVersion,
          workspaceKey: state.workspaceKey,
          availableModels: state.availableModels ?? null,
          // Exact-session entitlement readback (registry-backed on patched
          // runtimes); null access_mode / non-registry source = unproven.
          entitlement: state.entitlement
            ? { requested: state.entitlement.requested, observed: state.entitlement.access_mode, source: state.entitlement.source }
            : null,
        };
      } catch {
        return null as unknown as NonNullable<TaskRecord["modelBinding"]>;
      }
    }
    const binding = await this.provider.readSessionBinding(sessionId, wsRef);
    if (!binding) return null as unknown as NonNullable<TaskRecord["modelBinding"]>;
    return { provider_id: binding.provider_id, model_id: binding.model_id, source: binding.source };
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
    if (input.model_id !== undefined && (typeof input.model_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.model_id))) {
      throw new TaskEngineError("model_id must be 1..64 model id characters", "INVALID_MODEL");
    }
    if (input.thought_level !== undefined && (typeof input.thought_level !== "string" || !/^[a-z0-9_-]{1,20}$/.test(input.thought_level))) {
      throw new TaskEngineError("thought_level must be 1..20 lowercase level characters", "INVALID_THOUGHT_LEVEL");
    }
    const workspace = this.workspaces.resolveAuthorized(input.workspace_id);
    requireSupportedEntitlement(input.entitlement_plan, this.provider.entitlementSelection ?? null);
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
      const readonlyLane = (input.write_scope ?? "workspace") === "readonly";
      let sessionId: string;
      if (input.resume_session_id) {
        // A DEFAULT request must not erase a previously pinned entitlement;
        // pinned non-DEFAULT plans stay gated on the runtime's capability.
        for (const priorTask of this.store.data.tasks.filter(t => t.zcodeSessionId === input.resume_session_id)) {
          requireSupportedEntitlement(priorTask.entitlementPlan, this.provider.entitlementSelection ?? null);
        }
        // Prove ownership before native resume can change session state.
        // The governed constraint is the FULL OBSERVED binding from the same
        // authoritative collection the post-resume admission gate uses:
        // authoritative read source + admissible non-retired route + model
        // advertised in the SAME snapshot + (for retired start routes) the
        // session's own registry-backed entitlement readback. The narrow
        // binding read carries none of that evidence, so official-lane resume
        // must not rely on it. Workspace association is enforced inside the
        // authoritative read; any read failure is "unverified" (fail closed).
        // An explicitly requested identity must already match the observation
        // (resume never switches).
        const prior = await this.collectExecutionEvidence(input.resume_session_id, wsRef, readonlyLane);
        if (!prior || !isAdmissibleObservedBinding(prior)) {
          throw new TaskEngineError("Existing native session workspace/model binding is unverified", "BINDING_UNVERIFIED", 503);
        }
        if (input.model_id && prior.model_id !== input.model_id) {
          throw new TaskEngineError(
            `resume keeps the session identity (session is ${prior.model_id}, requested ${input.model_id})`,
            "BINDING_UNVERIFIED", 503,
          );
        }
        if (input.thought_level && prior.thoughtLevel !== input.thought_level) {
          throw new TaskEngineError(
            `resume keeps the session identity (session effort is ${prior.thoughtLevel ?? "unproven"}, requested ${input.thought_level})`,
            "BINDING_UNVERIFIED", 503,
          );
        }
        await this.provider.resumeSession(wsRef, input.resume_session_id, { readonly: readonlyLane, entitlementPlan: input.entitlement_plan });
        sessionId = input.resume_session_id;
      } else {
        sessionId = await this.provider.createSession(wsRef, {
          readonly: readonlyLane,
          entitlementPlan: input.entitlement_plan,
          // Explicit requests are hard constraints; the configured identity is
          // a PREFERENCE the provider applies only when the runtime itself
          // advertises it (preference is never admission evidence).
          ...(input.model_id ? { modelId: input.model_id } : { preferredModelId: this.cfg.requestedModelId }),
          ...(input.thought_level ? { thoughtLevel: input.thought_level } : this.cfg.requestedThoughtLevel ? { preferredThoughtLevel: this.cfg.requestedThoughtLevel } : {}),
          ...(this.cfg.requestedProviderId ? { providerId: this.cfg.requestedProviderId } : {}),
        });
      }
      // Single execution-identity source: the FULL OBSERVED attestation of the
      // exact session (workspace/provider/model/thought/collaboration state)
      // from authoritative native surfaces. Requested or configured values are
      // never execution proof; an explicit request must match the observation
      // exactly (no silent substitution, downgrade, or upgrade).
      const binding = await this.collectExecutionEvidence(sessionId, wsRef, readonlyLane);
      if (
        !this.governedBinding(binding, { modelId: input.model_id ?? null, thoughtLevel: input.thought_level ?? null, entitlementPlan: input.entitlement_plan ?? "DEFAULT" })
      ) {
        const entitlementObserved = binding?.entitlement?.source === "provider-registry"
          ? binding.entitlement.observed ?? "unproven"
          : "unproven";
        const requested = input.model_id || input.thought_level
          ? ` (requested ${input.model_id ?? "-"}/${input.thought_level ?? "-"})` : "";
        throw new TaskEngineError(
          `unverified execution binding for ${sessionId} (observed ` +
            `${binding ? `${binding.provider_id}/${binding.model_id}` : "unknown"}${requested}; ` +
            `entitlement observed: ${entitlementObserved}; ` +
            `requires an authoritative session read on an admissible route advertising the observed model` +
            `${input.entitlement_plan && input.entitlement_plan !== "DEFAULT" ? ` and attesting ${input.entitlement_plan}` : ""})`,
          "BINDING_UNVERIFIED",
          503,
        );
      }
      // Readonly governance: plan mode must be OBSERVED on the authoritative
      // v4 projection. A readonly lane whose plan state is null/unproven is
      // rejected — never silently executed in an edit/build-approving mode.
      if (readonlyLane && binding.planEnabled !== true) {
        throw new TaskEngineError(
          `readonly lane for ${sessionId} lacks authoritative plan evidence ` +
            `(observed planEnabled: ${String(binding.planEnabled)})`,
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
        entitlementPlan: entitlementPlan(input.entitlement_plan),
        requestedModelId: input.model_id ?? null,
        requestedThoughtLevel: input.thought_level ?? null,
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
        thoughtLevel: binding.thoughtLevel ?? null,
        requested: input.model_id || input.thought_level ? `${input.model_id ?? "-"}/${input.thought_level ?? "-"}` : null,
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

  /**
   * Read-only durable-idempotency resolution: the task admitted under exactly
   * this key in this workspace, or null when no such task was ever admitted.
   * Never mutates, never submits; used by callers to resolve a lost submit
   * response without re-dispatching. An ambiguous duplicate key is a store
   * integrity failure and fails closed.
   */
  resolveKeyedTask(workspaceId: string, key: string): PublicTaskView | null {
    if (!IDEMPOTENCY_KEY.test(key)) {
      throw new TaskEngineError("invalid idempotency key", "INVALID_IDEMPOTENCY_KEY");
    }
    const matches = this.store.data.tasks.filter(t => t.workspaceId === workspaceId && t.idempotency?.key === key);
    if (matches.length > 1) throw new TaskEngineError("ambiguous durable key", "IDEMPOTENCY_INVALID", 503);
    return matches[0] ? publicView(matches[0]) : null;
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
    if (/^(true|1)$/i.test(process.env.PRODUCT_TASK_DISPATCH_PAUSED ?? "")) return;
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
            failureClass: classifyTaskFailure(String((err as Error)?.message ?? err)),
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

  /**
   * Transient -32010 ("a prompt is already running") settle for the governed
   * task lane. The runtime's own session status is the authoritative busy
   * truth: a prompt that is genuinely running keeps the session busy; a
   * session the runtime reports IDLE (with prior assistant history proving a
   * previous turn existed and terminalized — e.g. after a service restart
   * lost in-process evidence) is safely recoverable with exactly one
   * stopSession + one retry, mirroring the semantic lane's gates. Anything
   * else fails closed with SESSION_BUSY; the prompt is never interrupted on
   * suspicion alone.
   */
  private async sendWithBusySettle(
    task: TaskRecord,
    workspace: { workspacePath: string; workspaceKey: string },
    assistantMarker: number,
  ): Promise<Awaited<ReturnType<AgentProvider["send"]>>> {
    const wsRef = { workspacePath: workspace.workspacePath, workspaceKey: workspace.workspaceKey };
    const sendOnce = () => this.provider.send({
      entitlementPlan: task.entitlementPlan,
      executionGrant: { workspacePath: workspace.workspacePath, write: task.writeScope === "workspace", mode: task.writeScope === "workspace" ? "machine-local-development" : "workspace" },
      sessionId: task.zcodeSessionId!,
      instruction: task.instruction,
      inputId: `z2c-${task.taskId}`,
      timeoutMs: 15 * 60_000,
    });
    try {
      return await sendOnce();
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (!/already running for this session|-32010\b/i.test(message)) throw error;
      const readState = this.provider.readSessionState?.bind(this.provider);
      if (typeof readState !== "function") throw error;
      // Bounded authoritative settle: the runtime clears busy on terminal
      // success/failure/interruption; wait briefly for that transition.
      const settleMs = this.cfg.busySettleMs ?? 30_000;
      const deadline = Date.now() + settleMs;
      let idle = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const state = await readState(task.zcodeSessionId!, wsRef);
          if (state?.status === "idle") { idle = true; break; }
        } catch { /* unreadable state → keep waiting within the budget */ }
      }
      if (!idle) {
        throw new TaskEngineError(`Native session is busy: ${message.slice(0, 160)}`, "SESSION_BUSY", 409);
      }
      this.audit.record("warn", "task.stale_busy_recovered", { taskId: task.taskId, sessionId: task.zcodeSessionId });
      try {
        return await sendOnce();
      } catch (retryError) {
        const retryMessage = String((retryError as Error)?.message ?? retryError);
        throw new TaskEngineError(`Native session is busy: ${retryMessage.slice(0, 160)}`, "SESSION_BUSY", 409);
      }
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
    // Turn-scope output marker (see below) — hoisted so the failure path can
    // read the same turn's partial output for the checkpoint record.
    let assistantMarker = 0;

    try {
      // The native session was established and binding-verified at submit
      // time; re-read the FULL authoritative evidence before each send:
      // workspace association, governed model identity, and — for readonly
      // lanes — the v4 plan flag must still be observed.
      requireSupportedEntitlement(task.entitlementPlan, this.provider.entitlementSelection ?? null);
      const dispatchReadonly = task.writeScope === "readonly";
      const binding = await this.collectExecutionEvidence(task.zcodeSessionId!, { workspacePath: workspace.canonicalPath, workspaceKey: workspace.canonicalPath }, dispatchReadonly);
      if (!this.governedBinding(binding, { modelId: task.requestedModelId, thoughtLevel: task.requestedThoughtLevel, entitlementPlan: task.entitlementPlan ?? "DEFAULT" })) {
        throw new TaskEngineError("Native session binding changed before send", "BINDING_UNVERIFIED", 503);
      }
      if (dispatchReadonly && binding.planEnabled !== true) {
        throw new TaskEngineError("Readonly session lost authoritative plan mode before send", "BINDING_UNVERIFIED", 503);
      }
      // Scope the output read to THIS turn: snapshot the assistant-message
      // count before sending so a resumed session's prior history can never be
      // returned as this turn's reply.
      assistantMarker = await Promise.resolve()
        .then(() => this.provider.snapshotAssistantMarker?.(task.zcodeSessionId!))
        .catch(() => undefined)
        ?? 0;
      const handle = await this.sendWithBusySettle(task, { workspacePath: workspace.canonicalPath, workspaceKey: workspace.canonicalPath }, assistantMarker);
      const result = await handle.completion;

      const text = await this.provider.readAssistantOutput(
        task.zcodeSessionId!,
        this.cfg.maxOutputChars,
        // Failed turn output is a partial checkpoint, not a new result. A
        // post-stop model error must not overwrite an observed local deadline.
        { minAssistantCount: assistantMarker, allowModelError: result.status !== "completed" },
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
      const exitStatusNow = this.store.findTask(taskId)!.exitStatus;
      this.audit.record("info", "task.finished", {
        taskId,
        sessionId: task.zcodeSessionId,
        status: result.status,
        outputId,
        failureClass: result.status === "completed" ? null : classifyTaskFailure(exitStatusNow),
      });
    } catch (err) {
      const msg = String((err as Error)?.message ?? err).slice(0, 200);
      const t = this.store.findTask(taskId)!;
      // Partial-output checkpoint: whatever the model produced BEFORE the
      // failure (timeout, model_request_cancelled, mid-turn error) stays
      // readable on the normal output surface. Best-effort only — the error
      // itself remains the terminal record and must never become "success".
      if (task.zcodeSessionId && !t.outputId) {
        try {
          const partial = await this.provider.readAssistantOutput(
            task.zcodeSessionId,
            this.cfg.maxOutputChars,
            { minAssistantCount: assistantMarker, allowModelError: true },
          );
          if (partial.trim()) {
            const partialOutputId = newOutputId();
            this.store.saveOutput({
              outputId: partialOutputId,
              taskId: task.taskId,
              workspaceId: task.workspaceId,
              sessionId: task.zcodeSessionId,
              text: partial,
              createdAt: Date.now(),
            });
            this.store.attachOutput(taskId, partialOutputId);
            this.audit.record("info", "task.partial_output_saved", {
              taskId,
              sessionId: task.zcodeSessionId,
              chars: partial.length,
            });
          }
        } catch { /* no recoverable output — the error remains the record */ }
      }
      if (t.status === "cancelled") {
        // cancellation raced with the failure — keep cancelled
      } else if (t.status !== "running") {
        // already terminal (e.g. cancelled while dispatching) — leave as-is
      } else {
        this.store.setStatus(taskId, "failed", msg);
      }
      this.audit.record("warn", "task.error", { taskId, error: msg, failureClass: classifyTaskFailure(msg) });
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
