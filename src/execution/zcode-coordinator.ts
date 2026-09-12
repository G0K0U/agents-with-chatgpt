/**
 * C2C-owned governed ZCode scheduled-queue coordinator.
 *
 * This is the ONE process-side owner of the governed queue lifecycle:
 * claim → dispatch through the governed native Desktop lane → terminal
 * receipt. receipts.jsonl stays the lifecycle truth and only this
 * coordinator (via ZcodeCoordinatorStore) ever writes START / COMPLETED /
 * FAILED / CANCELLED receipts; the ChatGPT-facing control plane cannot.
 *
 * Contract:
 *  - starts exactly once per queue root per process; duplicate start is a
 *    no-op returning the live coordinator;
 *  - ownership is fenced through worker-state.json heartbeats: a second
 *    coordinator observing a fresh foreign heartbeat goes STANDBY and never
 *    dual-claims; ownership is taken over only when the heartbeat is stale
 *    or the previous owner wrote a stopped/graceful state;
 *  - dispatch happens ONLY through the native ZCode Desktop lane and only
 *    while its identity attestation holds (observed Desktop-managed GLM
 *    provider/model binding). No silent provider substitution: with the native lane down
 *    the coordinator degrades explicitly and claims nothing;
 *  - dispatch is idempotent per queue task_id (durable idempotency key), so
 *    a crash between intent and receipt recovers by re-dispatching the same
 *    key — never a duplicate execution;
 *  - CANCEL_REQUESTED is honored for queued tasks (terminal CANCELLED before
 *    any dispatch) and forwarded to the native lane for running tasks;
 *  - everything it writes is bounded and sanitized.
 */
import path from "node:path";
import {
  ZCODE_NATIVE_EXPECTED_PROVIDER,
  ZcodeControl,
  ZcodeControlError,
  ZcodeCoordinatorStore,
  resolveFixedZcodeQueueRoot,
  type ZcodeQueueResolutionOptions,
  type ZcodeTaskView,
} from "./zcode-control.js";
import { loadZcodeNativeConfig, ZcodeNativeClient } from "./zcode-native.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";

/** Structural native lane the coordinator dispatches through. */
export interface ZcodeCoordinatorNative {
  status(workspaceId: string): Promise<{
    available: boolean;
    provider?: { name: string } | null;
    capabilities_ok?: boolean;
    start_plan?: { attested: boolean; provider_id: string; model_id: string; mismatches?: string[] } | null;
  }>;
  submitTask(input: {
    workspace_id: string;
    instruction: string;
    idempotency_key?: string;
    write_scope?: "workspace" | "readonly";
    mode?: "plan" | "build" | "edit";
  }): Promise<{
    task_id: string;
    session_id: string | null;
    status: string;
    model_binding?: { provider_id: string; model_id: string } | null;
  }>;
  getTask(input: { workspace_id: string; task_id: string }): Promise<{
    task_id: string;
    status: string;
    exit_status?: string | null;
    model_binding?: { provider_id: string; model_id: string } | null;
  }>;
  cancelTask(input: { workspace_id: string; task_id: string }): Promise<{ task_id: string; status: string }>;
}

export interface ZcodeCoordinatorOptions {
  /** Absolute queue root (already resolved through the authorized hierarchy). */
  queueRoot: string;
  /** Z2C workspace id the queue's authorized workspace maps to. */
  workspaceId: string;
  /** Governed native lane; the real wiring wraps ZcodeNativeClient. */
  native: ZcodeCoordinatorNative | null;
  /** Local-time claim windows, e.g. "01:00-09:30,22:00-23:59". */
  windowSpec?: string;
  maxParallel?: number;
  pollMs?: number;
  now?: () => Date;
  logger?: { warn(message: string): void; info(message: string): void };
}

interface ActiveEntry {
  task_id: string;
  native_task_id: string | null;
  session_id: string | null;
  started_at: string;
  soft_errors: number;
}

const ACTIVE_ERROR_LIMIT = 3;

/** Parse "HH:mm-HH:mm[,HH:mm-HH:mm]" local-time windows; empty means always. */
export function parseCoordinatorWindows(spec: string | undefined): Array<{ start: number; end: number }> | null {
  const trimmed = spec?.trim();
  if (!trimmed) return null;
  const ranges: Array<{ start: number; end: number }> = [];
  for (const part of trimmed.split(",")) {
    const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(part.trim());
    if (!match) throw new ZcodeControlError("ZCODE_INVALID_TASK", `invalid coordinator window segment: ${part.slice(0, 40)}`);
    const [, sh, sm, eh, em] = match;
    const start = Number(sh) * 60 + Number(sm);
    const end = Number(eh) * 60 + Number(em);
    if (Number(sh) > 23 || Number(eh) > 23 || Number(sm) > 59 || Number(em) > 59 || start === end) {
      throw new ZcodeControlError("ZCODE_INVALID_TASK", `invalid coordinator window segment: ${part.slice(0, 40)}`);
    }
    ranges.push({ start, end });
  }
  return ranges.length > 0 ? ranges : null;
}

export function withinCoordinatorWindows(
  ranges: Array<{ start: number; end: number }> | null,
  now: Date
): boolean {
  if (!ranges) return true;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return ranges.some(({ start, end }) =>
    start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end
  );
}

/** Conflict rules preserved from the governed queue contract. */
export function coordinatorTasksConflict(
  a: Pick<ZcodeTaskView, "mode" | "resources" | "exclusive_paths">,
  b: Pick<ZcodeTaskView, "mode" | "resources" | "exclusive_paths">
): boolean {
  const blocking = (mode: ZcodeTaskView["mode"]) => mode === "write" || mode === null;
  if (!blocking(a.mode) || !blocking(b.mode)) return false;
  // An undeclared write is globally exclusive; declared writes conflict on
  // any resource or exclusive-path intersection.
  if (a.mode === null || b.mode === null) return true;
  const intersects = (x?: string[], y?: string[]) => {
    const left = new Set((x ?? []).map((entry) => entry.toLowerCase()));
    return (y ?? []).some((entry) => left.has(entry.toLowerCase()));
  };
  return intersects(a.resources, b.resources) || intersects(a.exclusive_paths, b.exclusive_paths);
}

/** Map the queue's authorized workspace to the Z2C workspace id. */
export function resolveCoordinatorWorkspaceId(queueRoot: string, registry: WorkspaceRegistry): string | null {
  const normalize = (value: string) =>
    process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value;
  const root = normalize(path.normalize(queueRoot));
  let best: { id: string; length: number } | null = null;
  for (const id of registry.enabledIds()) {
    let canonical: string;
    try {
      canonical = registry.get(id).canonicalPath;
    } catch {
      continue;
    }
    const base = normalize(path.normalize(canonical));
    const relative = path.relative(base, root);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    if (!best || base.length > best.length) best = { id, length: base.length };
  }
  return best?.id ?? null;
}

interface NativeCache {
  available: boolean;
  provider: string | null;
  model: string | null;
  attested: boolean;
  reason: string | null;
  observed_at: string;
  /** Set when an upstream call failed a workspace/task namespace check. */
  namespace_mismatch?: boolean;
}

export class ZcodeCoordinator {
  private readonly control: ZcodeControl;
  private readonly store: ZcodeCoordinatorStore;
  private readonly native: ZcodeCoordinatorNative | null;
  private readonly workspaceId: string;
  private readonly windows: Array<{ start: number; end: number }> | null;
  private readonly maxParallel: number;
  private readonly pollMs: number;
  private readonly now: () => Date;
  private readonly logger: { warn(message: string): void; info(message: string): void };

  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  private standby = false;
  private inFlight: Promise<unknown>[] = [];
  private lastError: string | null = null;
  private nativeCache: NativeCache | null = null;
  private readonly active = new Map<string, ActiveEntry>();
  private readonly startedAt = new Date().toISOString();

  constructor(options: ZcodeCoordinatorOptions) {
    this.control = new ZcodeControl(options.queueRoot);
    this.store = new ZcodeCoordinatorStore(options.queueRoot);
    this.native = options.native;
    this.workspaceId = options.workspaceId;
    this.windows = parseCoordinatorWindows(options.windowSpec);
    this.maxParallel = Math.min(3, Math.max(1, Math.floor(options.maxParallel ?? 1)));
    this.pollMs = Math.min(60_000, Math.max(1_000, Math.floor(options.pollMs ?? 15_000)));
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? { warn: () => {}, info: () => {} };
  }

  /** Begin the claim loop; adopts tracked/unfinished work from worker-state. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.adoptTrackedState();
    this.scheduleTick(0);
  }

  /** Graceful stop: no new claims; bounded wait for in-flight dispatch. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await Promise.race([
      Promise.allSettled(this.inFlight),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    try {
      this.writeState("stopped");
    } catch {
      // A stopped write failing must not break bridge shutdown.
    }
  }

  /** Bounded local status for tests and bridge diagnostics. */
  getStatus(): {
    running: boolean;
    standby: boolean;
    stopped: boolean;
    active: number;
    last_error: string | null;
    native: NativeCache | null;
    within_window: boolean;
  } {
    return {
      running: !this.stopped && !this.standby,
      standby: this.standby,
      stopped: this.stopped,
      active: this.active.size,
      last_error: this.lastError,
      native: this.nativeCache,
      within_window: withinCoordinatorWindows(this.windows, this.now()),
    };
  }

  private scheduleTick(delayMs?: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runTick().finally(() => this.scheduleTick(this.pollMs));
    }, delayMs ?? this.pollMs);
  }

  private adoptTrackedState(): void {
    const raw = this.store.readRawWorkerState();
    if (!raw) return;
    const entries = Array.isArray(raw.active) ? (raw.active as Record<string, unknown>[]) : [];
    for (const entry of entries) {
      const taskId = typeof entry.task_id === "string" ? entry.task_id : null;
      if (!taskId) continue;
      this.active.set(taskId, {
        task_id: taskId,
        native_task_id: typeof entry.native_task_id === "string" ? entry.native_task_id : null,
        session_id: typeof entry.session_id === "string" ? entry.session_id : null,
        started_at: typeof entry.started_at === "string" ? entry.started_at : new Date().toISOString(),
        soft_errors: 0,
      });
    }
  }

  /** Run one bounded coordinator tick. Never throws. */
  async runTick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    const tickPromise = this.tick().catch((error) => {
      this.lastError = error instanceof Error ? error.message.slice(0, 300) : "coordinator tick failed";
    });
    this.inFlight.push(tickPromise);
    try {
      await tickPromise;
    } finally {
      this.ticking = false;
      this.inFlight = this.inFlight.filter((entry) => entry !== tickPromise);
    }
  }

  private async tick(): Promise<void> {
    if (!this.assertOwnership()) return;
    this.lastError = null;
    await this.refreshNative();

    // Local-only cancellation resolution works even with the lane down.
    await this.resolveCancellations();

    if (this.nativeCache?.available && this.nativeCache.attested) {
      await this.pollActiveForTerminal();
      if (withinCoordinatorWindows(this.windows, this.now())) {
        await this.claimAndDispatch();
      }
    }

    this.writeState(this.active.size > 0 ? "running" : this.nativeCache?.available ? "idle" : "degraded");
  }

  /**
   * Ownership fence: take over only when no live foreign heartbeat exists.
   * A coordinator standing by writes nothing, so the active owner's
   * heartbeats stay authoritative and the old owner can never resume
   * claiming after ownership has moved.
   */
  private assertOwnership(): boolean {
    const raw = this.store.readRawWorkerState();
    const nowMs = this.now().getTime();
    if (raw && typeof raw === "object") {
      const owner = (raw.owner ?? null) as { pid?: unknown } | null;
      const ownerPid = owner && typeof owner.pid === "number" ? owner.pid : null;
      const updatedAt = typeof raw.updated_at === "string" ? Date.parse(raw.updated_at) : NaN;
      const heartbeatFresh = Number.isFinite(updatedAt) && nowMs - updatedAt < this.staleAfterMs();
      const graceful = raw.status === "stopped" || raw.status === "standby";
      if (ownerPid !== null && ownerPid !== process.pid && heartbeatFresh && !graceful) {
        this.standby = true;
        return false;
      }
    }
    this.standby = false;
    return true;
  }

  private staleAfterMs(): number {
    return Math.max(5 * this.pollMs, 60_000);
  }

  private async refreshNative(): Promise<void> {
    const observedAt = this.now().toISOString();
    if (!this.native) {
      this.nativeCache = {
        available: false,
        provider: null,
        model: null,
        attested: false,
        reason: "native lane not configured",
        observed_at: observedAt,
      };
      return;
    }
    try {
      const status = await this.native.status(this.workspaceId);
      const providerName = status.provider?.name ?? null;
      // Provider-level identity gate: reachable and served by the
      // Desktop-managed provider. The observed GLM model binding is
      // unobservable until a session exists (status is informational by
      // contract) and capability probes may be lazy (reported null) —
      // execution identity is proven PER TASK at admission by the governed
      // submit path (assertTaskBinding), which fails closed on any wrong
      // binding, provider, or session.
      const providerOk = providerName === ZCODE_NATIVE_EXPECTED_PROVIDER;
      const attested = status.available === true && providerOk;
      this.nativeCache = {
        available: status.available === true,
        provider: providerName,
        model: status.start_plan?.model_id ?? null,
        attested,
        reason: !status.available
          ? "native control plane unavailable"
          : !providerOk
            ? `provider=${providerName || "unknown"}`
            : null,
        observed_at: observedAt,
        ...(this.nativeCache?.namespace_mismatch ? { namespace_mismatch: true } : {}),
      };
    } catch (error) {
      this.nativeCache = {
        available: false,
        provider: null,
        model: null,
        attested: false,
        reason: (error instanceof Error ? error.message : "native status failed").slice(0, 200),
        observed_at: observedAt,
        ...(this.nativeCache?.namespace_mismatch ? { namespace_mismatch: true } : {}),
      };
    }
  }

  /** Honor CANCEL_REQUESTED: terminal-cancel undispached tasks, forward running ones. */
  private async resolveCancellations(): Promise<void> {
    const views = this.taskViews();
    for (const view of views) {
      if (!view.cancel_requested) continue;
      // Terminal guard: a task that already has a terminal merged status
      // (completed/failed/cancelled) must never receive another terminal
      // receipt from a later tick — cancellation is idempotent.
      if (
        view.status === "completed" ||
        view.status === "failed" ||
        view.status === "cancelled"
      ) {
        continue;
      }
      // Dispatched = a START receipt exists (or the merged status says
      // running). Anything not yet dispatched is terminal-cancelled locally;
      // a dispatched task gets its cancellation forwarded to the native lane
      // and the terminal receipt is written by the poll that observes it
      // (never forged locally).
      const dispatched =
        view.status === "running" || view.receipts.some((receipt) => receipt.event === "START");
      if (dispatched) {
        const entry = this.active.get(view.task_id);
        if (entry?.native_task_id) {
          try {
            await this.native!.cancelTask({
              workspace_id: this.workspaceId,
              task_id: entry.native_task_id,
            });
          } catch (error) {
            this.noteNativeError(error);
            this.lastError = error instanceof Error ? error.message.slice(0, 300) : "cancel forward failed";
          }
        }
        continue;
      }
      try {
        await this.store.appendReceipt({
          task_id: view.task_id,
          event: "CANCELLED",
          verification_summary: "cancelled before dispatch (CANCEL_REQUESTED while queued)",
        });
      } catch (error) {
        this.lastError = error instanceof Error ? error.message.slice(0, 300) : "cancel receipt failed";
      }
    }
  }

  private async pollActiveForTerminal(): Promise<void> {
    for (const entry of [...this.active.values()]) {
      if (!entry.native_task_id) continue;
      try {
        const task = await this.native!.getTask({
          workspace_id: this.workspaceId,
          task_id: entry.native_task_id,
        });
        entry.soft_errors = 0;
        const terminal = this.terminalFromNativeStatus(task.status, task.exit_status ?? null);
        if (!terminal) continue;
        await this.store.appendReceipt({
          task_id: entry.task_id,
          event: terminal.event,
          model: task.model_binding?.model_id ?? this.nativeCache?.model ?? null,
          session: entry.session_id,
          ...(terminal.event === "FAILED" ? { error: terminal.error } : {}),
        });
        this.active.delete(entry.task_id);
      } catch (error) {
        const coded = error as { upstreamCode?: string };
        this.noteNativeError(error);
        if (typeof coded?.upstreamCode === "string" && /NOT_FOUND|UNKNOWN/i.test(coded.upstreamCode)) {
          await this.store.appendReceipt({
            task_id: entry.task_id,
            event: "FAILED",
            error: "native task is no longer observable (lost session binding)",
          }).catch(() => {});
          this.active.delete(entry.task_id);
          continue;
        }
        entry.soft_errors += 1;
        if (entry.soft_errors >= ACTIVE_ERROR_LIMIT) {
          await this.store.appendReceipt({
            task_id: entry.task_id,
            event: "FAILED",
            error: "native task observation failed repeatedly; coordinator gave up bounded",
          }).catch(() => {});
          this.active.delete(entry.task_id);
        }
      }
    }
  }

  private terminalFromNativeStatus(
    status: string,
    exitStatus: string | null
  ): { event: "COMPLETED" | "FAILED" | "CANCELLED"; error?: string } | null {
    switch (status) {
      case "completed":
        return { event: "COMPLETED" };
      case "failed":
        return { event: "FAILED", error: exitStatus ? `native exit: ${exitStatus.slice(0, 200)}` : "native task failed" };
      case "cancelled":
      case "interrupted":
        return { event: "CANCELLED" };
      default:
        return null;
    }
  }

  private async claimAndDispatch(): Promise<void> {
    const views = this.taskViews();
    const cancelSet = new Set(views.filter((view) => view.cancel_requested).map((view) => view.task_id));
    const completed = new Set(
      views.filter((view) => view.status === "completed").map((view) => view.task_id)
    );
    const activeViews = views.filter((view) => this.active.has(view.task_id));

    for (const view of views) {
      if (this.active.size >= this.maxParallel) break;
      // Interrupted recovery: a START receipt without a terminal outcome and
      // without local tracking means a previous owner died mid-flight. It is
      // re-adopted by re-dispatching the SAME durable idempotency key — an
      // already-accepted task replays (no duplicate execution), a lost one is
      // dispatched fresh.
      const interrupted =
        view.status === "running" &&
        !this.active.has(view.task_id) &&
        view.receipts.some((receipt) => receipt.event === "START");
      if (view.status !== "queued" && !interrupted) continue;
      if (view.status === "queued" && view.cancel_requested) continue;
      const dependenciesReady = (view.depends_on ?? []).every((dep) => completed.has(dep));
      if (!interrupted && !dependenciesReady) continue;
      if (activeViews.some((running) => coordinatorTasksConflict(running, view))) continue;
      if (cancelSet.has(view.task_id) && !interrupted) continue;
      try {
        await this.dispatch(view, interrupted);
      } catch (error) {
        this.noteNativeError(error);
        this.lastError = error instanceof Error ? error.message.slice(0, 300) : "dispatch failed";
        this.logger.warn(`zcode coordinator dispatch failed for ${view.task_id}: ${this.lastError}`);
      }
    }
  }

  /** Surface namespace failures as an explicit workspace-binding layer fault. */
  private noteNativeError(error: unknown): void {
    if (!this.nativeCache) return;
    const coded = error as { upstreamCode?: string; code?: string };
    const combined = [coded?.upstreamCode, coded?.code, error instanceof Error ? error.message : ""]
      .filter(Boolean).join(" ");
    if (/NAMESPACE/i.test(combined)) {
      this.nativeCache.namespace_mismatch = true;
      this.nativeCache.reason = "workspace namespace mismatch against the native lane";
    }
  }

  private async dispatch(view: ZcodeTaskView, recovery: boolean): Promise<void> {
    const instruction = this.control.rawInstructionFor(view.task_id);
    if (!instruction) throw new ZcodeControlError("ZCODE_TASK_UNKNOWN", `queued instruction for ${view.task_id} vanished before dispatch`);
    const writeScope = view.mode === "read" || view.mode === "verify" ? "readonly" as const : "workspace" as const;
    const mode = view.mode === "verify" ? ("plan" as const) : ("build" as const);
    const dispatchPromise = this.store.withDispatchIntent({
      task_id: view.task_id,
      dispatch: async () =>
        this.native!.submitTask({
          workspace_id: this.workspaceId,
          instruction,
          idempotency_key: view.task_id,
          write_scope: writeScope,
          mode,
        }),
    });
    // The tracked promise only ever resolves; dispatch failures surface via
    // the awaited dispatchPromise below (never as an unhandled rejection).
    const tracked = dispatchPromise
      .then((nativeTask) => {
        this.active.set(view.task_id, {
          task_id: view.task_id,
          native_task_id: nativeTask.task_id,
          session_id: nativeTask.session_id,
          started_at: new Date().toISOString(),
          soft_errors: 0,
        });
      })
      .catch(() => {});
    this.inFlight.push(tracked);
    try {
      const nativeTask = await dispatchPromise;
      // A re-adopted task already carries its original START receipt; the
      // replay did not start a new execution, so no second START is written.
      if (!recovery) {
        await this.store.appendReceipt({
          task_id: view.task_id,
          event: "START",
          model: nativeTask.model_binding?.model_id ?? this.nativeCache?.model ?? null,
          session: nativeTask.session_id,
        });
      } else {
        this.logger.info(`zcode coordinator re-adopted ${view.task_id} (idempotency replay ${nativeTask.task_id})`);
      }
      await tracked;
    } finally {
      this.inFlight = this.inFlight.filter((entry) => entry !== tracked);
    }
  }

  private taskViews(): ZcodeTaskView[] {
    try {
      return this.control.listTasks(100).tasks;
    } catch (error) {
      this.lastError = error instanceof ZcodeControlError ? `${error.code}: ${error.message.slice(0, 200)}` : "queue read failed";
      return [];
    }
  }

  private writeState(status: "running" | "idle" | "degraded" | "stopped"): void {
    const now = this.now();
    this.store.writeWorkerState({
      schema: "engai.c2c_zcode_worker_state",
      status,
      owner: { pid: process.pid, started_at: this.startedAt },
      window: this.windows ? "configured" : null,
      within_window: withinCoordinatorWindows(this.windows, now),
      max_parallel: this.maxParallel,
      active: [...this.active.values()].map((entry) => ({
        task_id: entry.task_id,
        native_task_id: entry.native_task_id,
        session_id: entry.session_id,
        started_at: entry.started_at,
      })),
      last_error: this.lastError ?? (status === "degraded" ? (this.nativeCache?.reason ?? null) : null),
      native: this.nativeCache
        ? {
            available: this.nativeCache.available,
            provider: this.nativeCache.provider,
            model: this.nativeCache.model,
            attested: this.nativeCache.attested,
            reason: this.nativeCache.reason,
            observed_at: this.nativeCache.observed_at,
            ...(this.nativeCache.namespace_mismatch ? { namespace_mismatch: true } : {}),
          }
        : null,
      updated_at: now.toISOString(),
    });
  }
}

const coordinators = new Map<string, ZcodeCoordinator>();

/** Start exactly one coordinator per queue root per process. */
export function startZcodeCoordinator(options: ZcodeCoordinatorOptions): ZcodeCoordinator {
  const key = path.normalize(options.queueRoot).toLowerCase();
  const existing = coordinators.get(key);
  if (existing && !existing.getStatus().stopped) return existing;
  const coordinator = new ZcodeCoordinator(options);
  coordinators.set(key, coordinator);
  coordinator.start();
  return coordinator;
}

/** Test seam: forget cached coordinators. */
export function resetZcodeCoordinatorsForTests(): void {
  coordinators.clear();
}

/**
 * Native lane adapter around the governed Z2C client. Configuration is read
 * from the fixed local sources only; a missing/invalid configuration is
 * cached as an error so every tick degrades explicitly instead of crashing.
 */
export function lazyZcodeNativeAdapter(env: NodeJS.ProcessEnv = process.env): ZcodeCoordinatorNative {
  let cached: ZcodeNativeClient | Error | null = null;
  const getClient = (): ZcodeNativeClient => {
    if (cached instanceof Error) throw cached;
    if (!cached) {
      try {
        cached = new ZcodeNativeClient(loadZcodeNativeConfig(env));
      } catch (error) {
        cached = error instanceof Error ? error : new Error(String(error));
        throw cached;
      }
    }
    return cached;
  };
  return {
    status: (workspaceId) => getClient().status(workspaceId),
    submitTask: (input) => getClient().submitTask(input),
    getTask: (input) => getClient().getTask(input),
    cancelTask: (input) => getClient().cancelTask(input),
  };
}

export interface ZcodeCoordinatorWiring {
  registry: WorkspaceRegistry;
  workspaceRoot: string;
  stateDir?: string;
  logger?: { warn(message: string): void; info(message: string): void };
  env?: NodeJS.ProcessEnv;
}

/**
 * Bridge wiring: resolve the authorized queue root, map it to the governed
 * native workspace, and start the coordinator. Returns null (fail closed,
 * never throws) when the queue root or workspace binding cannot be resolved,
 * or when C2C_ZCODE_COORDINATOR_DISABLE is set.
 */
export function startZcodeCoordinatorFromEnvironment(wiring: ZcodeCoordinatorWiring): ZcodeCoordinator | null {
  const env = wiring.env ?? process.env;
  if (/^(1|true|yes)$/i.test(env.C2C_ZCODE_COORDINATOR_DISABLE?.trim() ?? "")) {
    return null;
  }
  const resolutionOptions: ZcodeQueueResolutionOptions = {
    workspaceRoot: wiring.workspaceRoot,
    stateDir: wiring.stateDir,
    registry: wiring.registry,
    env,
  };
  let queueRoot: string;
  try {
    queueRoot = resolveFixedZcodeQueueRoot(resolutionOptions);
  } catch (error) {
    wiring.logger?.warn(
      `ZCode coordinator disabled: queue root unresolved (${error instanceof Error ? error.message : String(error)})`
    );
    return null;
  }
  const workspaceId = resolveCoordinatorWorkspaceId(queueRoot, wiring.registry);
  if (!workspaceId) {
    wiring.logger?.warn("ZCode coordinator disabled: the queue root does not belong to an authorized workspace");
    return null;
  }
  const windowSpec = env.C2C_ZCODE_COORDINATOR_WINDOW?.trim() || undefined;
  try {
    parseCoordinatorWindows(windowSpec);
  } catch {
    wiring.logger?.warn("ZCode coordinator disabled: C2C_ZCODE_COORDINATOR_WINDOW is not a valid HH:mm-HH:mm list");
    return null;
  }
  const maxParallelRaw = env.C2C_ZCODE_COORDINATOR_MAX_PARALLEL?.trim();
  const maxParallel = maxParallelRaw ? Number(maxParallelRaw) : undefined;
  const pollMsRaw = env.C2C_ZCODE_COORDINATOR_POLL_MS?.trim();
  const pollMs = pollMsRaw ? Number(pollMsRaw) : undefined;
  return startZcodeCoordinator({
    queueRoot,
    workspaceId,
    native: lazyZcodeNativeAdapter(env),
    windowSpec,
    ...(maxParallel !== undefined && Number.isFinite(maxParallel) ? { maxParallel } : {}),
    ...(pollMs !== undefined && Number.isFinite(pollMs) ? { pollMs } : {}),
    logger: wiring.logger,
  });
}
