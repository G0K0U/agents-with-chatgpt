import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readReleasePointer, type ParityState } from "../bridge/runtime-identity.js";
import { stableWorkspaceId } from "../workspace/identity.js";
import {
  reconcileCodexReadiness,
  reconcileAgyReadiness,
  strategyFor,
  ZcodeDesktopReconciler,
  type OnDemandReadiness,
  type ProviderBootstrapStrategy,
  type ProviderReadinessState,
  type ZcodeDesktopObservation,
} from "./provider-bootstrap.js";

/**
 * Bounded supervisor for the Agent-to-ChatGPT control plane.
 *
 * One lightweight process observes the control-plane surfaces and performs
 * TARGETED recovery: it never restarts the world because one lane failed.
 * It reuses the existing lifecycle primitives (runtime pointer, admin API,
 * restart handoff) instead of replacing them, and it never destroys durable
 * state: task records, terminal receipts, writer locks, auth state, and
 * workspace ownership are read-only to the supervisor.
 *
 * Recovery ladder (per component, bounded):
 *   re-probe -> refresh/reconcile metadata -> reconnect the affected provider
 *   -> restart the affected companion -> restart C2C only when C2C itself is
 *   unhealthy.
 *
 * Restarts are backoff-bounded: attempt 1 immediate, then 5s, 15s, 30s; after
 * that the component is FAILED and requires manual intervention. This makes
 * restart storms structurally impossible (bounded attempts + growing delay).
 */

export type ComponentState = "READY" | "DEGRADED" | "OFFLINE" | "RECOVERING" | "FAILED";

export const SUPERVISOR_SCHEMA = 2;

/** Result of the takeover/bootstrap reconciliation stage (persisted on the snapshot). */
export interface ProviderBootstrapReport {
  at: string;
  codex: OnDemandReadiness;
  gemini: OnDemandReadiness;
  zcode: {
    strategy: ProviderBootstrapStrategy;
    state: ProviderReadinessState;
    managed: boolean | null;
    desktopPid: number | null;
    registrationLive: boolean;
    detail?: string;
  };
}

/** Backoff schedule in ms; index = attempt number - 1. */
export const RECOVERY_DELAYS_MS = [0, 5_000, 15_000, 30_000];

export function recoveryDelayMs(attempt: number): number | null {
  if (attempt < 1) return null;
  if (attempt > RECOVERY_DELAYS_MS.length) return null; // FAILED: manual intervention
  return RECOVERY_DELAYS_MS[attempt - 1];
}

export interface ComponentObservation {
  state: ComponentState;
  detail?: string;
  /** A recovery action exists for this observation. */
  actionable?: boolean;
}

export interface ComponentStatus {
  component: string;
  state: ComponentState;
  detail?: string;
  attempts: number;
  lastOkAt: string | null;
  lastActionAt: string | null;
  lastAction?: string;
  nextRetryAt: string | null;
}

export interface SupervisorSnapshot {
  schema: number;
  pid: number;
  startedAt: string;
  tick: number;
  lastTickAt: string;
  overall: ComponentState;
  components: ComponentStatus[];
  recoveryLog: Array<{ at: string; component: string; action: string; outcome: string }>;
  /** Result of the most recent takeover bootstrap (R1.1); absent before the first takeover. */
  providerBootstrap?: ProviderBootstrapReport;
}

export interface SupervisorDeps {
  /** Repo root of the C2C installation (contains dist/ and releases/). */
  repoRoot: string;
  /** Canonical C2C state dir. */
  stateDir: string;
  /** Primary bridge workspace root (the supervised control-plane workspace). */
  workspaceRoot: string;
  /** Z2C companion repo root; sibling of repoRoot by default. */
  z2cRepoRoot?: string;
  /** Milliseconds between observation ticks. */
  intervalMs?: number;
  /** Injected clock for tests. */
  now?: () => Date;
  /** Injected sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected environment for the provider bootstrap (executable discovery). */
  env?: NodeJS.ProcessEnv;
  /** Injected process inventory for the provider bootstrap (test seam). */
  processInspector?: () => import("../bridge/runtime.js").BridgeProcessInspector | null;
  /** How long a managed-desktop launch waits for the fresh registration. */
  zcodeRegistrationWaitMs?: number;
  /** Test seam: suppress real process spawning. */
  spawnDetached?: (cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) => unknown;
  /** Test seams for probes. */
  probes?: Partial<SupervisorProbes>;
}

export interface SupervisorProbes {
  /** Local bridge health: workspace id + release identity, or null. */
  bridgeHealth: () => Promise<{ workspaceId: string; releaseId: string | null; sourceParity: ParityState; buildParity: ParityState; version: string } | null>;
  /** Public MCP endpoint reachable (expected unauthenticated 401). */
  publicMcp: () => Promise<boolean>;
  /** Z2C loopback listener liveness (HTTP probe). */
  z2cListener: () => Promise<boolean>;
  /** Managed ZCode Desktop + registration reconciliation observation. */
  zcodeDesktop: () => Promise<ZcodeDesktopObservation>;
  /** ZCode coordinator heartbeat age in ms, or null when absent. */
  coordinatorHeartbeatAgeMs: () => Promise<number | null>;
  /** Queue + writer surfaces (read-only observation). */
  queueState: () => Promise<{ paused: boolean; activeWriter: string | null }>;
  /** The bridge runtime pointer: pid/port/startedAt, or null. */
  bridgePointer: () => Promise<{ pid: number; port: number } | null>;
}

const Z2C_DEFAULT_PORT = 8766;

function httpProbe(url: string, timeoutMs = 4_000): Promise<{ ok: boolean; status: number }> {
  return new Promise((resolve) => {
    const url_ = new URL(url);
    const req = net.connect({ host: url_.hostname, port: Number(url_.port || 80) }, () => {
      req.write(`GET ${url_.pathname === "/" ? "/health" : url_.pathname} HTTP/1.1\r\nHost: ${url_.host}\r\nConnection: close\r\n\r\n`);
    });
    let buffer = "";
    const finish = (ok: boolean, status: number): void => {
      try { req.destroy(); } catch { /* probe cleanup */ }
      resolve({ ok, status });
    };
    req.setTimeout(timeoutMs, () => finish(false, 0));
    req.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(buffer);
      if (m) finish(Number(m[1]) < 500, Number(m[1]));
    });
    req.on("error", () => finish(false, 0));
  });
}

/** Liveness of a raw pid on Windows/POSIX without signaling it. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Map a managed-desktop observation onto the component model. Only a genuinely
 * absent desktop is actionable (bounded managed launch); unmanaged instances,
 * missing executables, and managed instances that never register are reported
 * as manual-intervention degradation — the supervisor never kills a Desktop
 * and never launches a duplicate next to an unmanaged one.
 */
export function desktopComponentObservation(obs: ZcodeDesktopObservation): ComponentObservation {
  switch (obs.state) {
    case "READY":
      return { state: "READY", detail: obs.detail };
    case "RECOVERING":
      return { state: "RECOVERING", detail: obs.detail };
    case "ZCODE_DESKTOP_ABSENT":
      return { state: "OFFLINE", detail: obs.detail, actionable: true };
    case "ZCODE_DESKTOP_UNMANAGED":
    case "ZCODE_DESKTOP_MANAGED_NOT_REGISTERED":
    case "ZCODE_DESKTOP_EXECUTABLE_NOT_FOUND":
    case "ZCODE_DESKTOP_EXECUTABLE_OVERRIDE_INVALID":
      return { state: "DEGRADED", detail: obs.detail, actionable: false };
    default:
      return { state: "DEGRADED", detail: obs.detail ?? obs.state, actionable: false };
  }
}

export class Supervisor {
  private readonly deps: Required<Pick<SupervisorDeps, "repoRoot" | "stateDir" | "workspaceRoot" | "intervalMs" | "now" | "sleep">> & SupervisorDeps;
  private readonly components = new Map<string, ComponentStatus & { nextRetryAtMs: number | null }>();
  private readonly recoveryLog: SupervisorSnapshot["recoveryLog"] = [];
  private stopped = false;
  private tick = 0;

  constructor(deps: SupervisorDeps) {
    this.deps = {
      intervalMs: 30_000,
      now: () => new Date(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...deps,
    };
    this.startedAt = this.deps.now().toISOString();
    for (const name of ["core", "tunnel", "runtime-identity", "queue-writer", "zcode-coordinator", "z2c-listener", "zcode-desktop", "providers"]) {
      this.components.set(name, {
        component: name,
        state: "RECOVERING",
        attempts: 0,
        lastOkAt: null,
        lastActionAt: null,
        nextRetryAt: null,
        nextRetryAtMs: null,
      });
    }
  }

  private iso(): string {
    return this.deps.now().toISOString();
  }

  private workspaceId(): string {
    if (!this.cachedWorkspaceId) this.cachedWorkspaceId = stableWorkspaceId(this.deps.workspaceRoot);
    return this.cachedWorkspaceId;
  }

  private cachedWorkspaceId: string | null = null;

  private log(component: string, action: string, outcome: string): void {
    this.recoveryLog.push({ at: this.iso(), component, action, outcome });
    if (this.recoveryLog.length > 200) this.recoveryLog.splice(0, this.recoveryLog.length - 200);
  }

  /** Default probes built from the real environment (overridable for tests). */
  private buildProbes(): SupervisorProbes {
    const z2cRepo = this.deps.z2cRepoRoot
      ?? path.resolve(this.deps.repoRoot, "..", "zcode-with-chatgpt");
    void z2cRepo;
    const workspaceId = this.workspaceId();
    return {
      bridgeHealth: async () => {
        const { findLiveBridge } = await import("../bridge/runtime.js");
        const fetchHealth = async (port: number) => {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4_000) });
            if (!res.ok) return null;
            const body = await res.json() as {
              workspaceId?: string; status?: string; release?: { releaseId?: string | null; sourceParity?: ParityState; buildParity?: ParityState; version?: string };
            };
            if (!body || body.status !== "ok" || !body.workspaceId) return null;
            return {
              workspaceId: body.workspaceId,
              releaseId: body.release?.releaseId ?? null,
              sourceParity: body.release?.sourceParity ?? "unknown",
              buildParity: body.release?.buildParity ?? "unknown",
              version: body.release?.version ?? "unknown",
            };
          } catch {
            return null;
          }
        };
        const live = await findLiveBridge(workspaceId, this.deps.workspaceRoot, { stateDir: this.deps.stateDir });
        if (live) return fetchHealth(live.port);
        // Shared state domain: another workspace's bridge may be the healthy
        // owner serving this workspace. Observe through the same verified
        // truth ensureBridge acts on, or a shared-domain takeover reports the
        // core as dead even though ensure-bridge keeps succeeding.
        const { findSharedBridgeObservation } = await import("../process/daemon.js");
        const shared = await findSharedBridgeObservation(workspaceId, this.deps.workspaceRoot, { stateDir: this.deps.stateDir });
        if (shared.state !== "healthy") return null;
        return fetchHealth(shared.runtime.port);
      },
      publicMcp: async () => {
        const { readLastEndpoint } = await import("../config/endpoint.js");
        const endpoint = readLastEndpoint(workspaceId, this.deps.stateDir);
        if (!endpoint?.mcpUrl) return false;
        try {
          const res = await fetch(endpoint.mcpUrl, { signal: AbortSignal.timeout(8_000) });
          return res.status === 401;
        } catch {
          return false;
        }
      },
      z2cListener: async () => {
        const probe = await httpProbe(`http://127.0.0.1:${Z2C_DEFAULT_PORT}/health`);
        return probe.ok;
      },
      zcodeDesktop: async () => this.zcodeDesktopReconciler().observe(),
      coordinatorHeartbeatAgeMs: async () => {
        const { describeControlPlane } = await import("../execution/zcode-control.js");
        const status = describeControlPlane({ workspaceRoot: this.deps.workspaceRoot, stateDir: this.deps.stateDir });
        return status.coordinator.heartbeat_age_ms;
      },
      queueState: async () => {
        const { readWorkspaceQueuePauseState } = await import("../execution/queue-state.js");
        const paused = readWorkspaceQueuePauseState(workspaceId, this.deps.stateDir).paused;
        let activeWriter: string | null = null;
        const lockFile = path.join(this.deps.stateDir, "locks", `${workspaceId}.json`);
        if (fs.existsSync(lockFile)) {
          try {
            const lock = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { holder?: { provider?: string; taskId?: string } };
            if (lock.holder?.provider) activeWriter = `${lock.holder.provider}:${lock.holder.taskId ?? ""}`;
          } catch { /* unreadable lock: report no writer rather than guessing */ }
        }
        return { paused, activeWriter };
      },
      bridgePointer: async () => {
        const { findLiveBridge } = await import("../bridge/runtime.js");
        const live = await findLiveBridge(workspaceId, this.deps.workspaceRoot, { stateDir: this.deps.stateDir });
        return live ? { pid: live.pid, port: live.port } : null;
      },
      ...(this.deps.probes ?? {}),
    };
  }

  private probes(): SupervisorProbes {
    return this.buildProbes();
  }

  // ── recovery actions ───────────────────────────────────────────────────────

  private spawnDetached(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): unknown {
    if (this.deps.spawnDetached) return this.deps.spawnDetached(cmd, args, opts);
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.unref();
    return child;
  }

  private z2cRepo(): string {
    return this.deps.z2cRepoRoot ?? path.resolve(this.deps.repoRoot, "..", "zcode-with-chatgpt");
  }

  private async actionRestartZ2c(): Promise<string> {
    const repo = this.z2cRepo();
    const entry = path.join(repo, "dist", "index.js");
    if (!fs.existsSync(entry)) return `Z2C entry missing: ${entry}`;
    // Pin desktop mode: auto-detection would silently fall back to the
    // headless provider when no agent is registered yet, changing the lane's
    // identity semantics behind the operator's back.
    this.spawnDetached(process.execPath, [entry], {
      cwd: repo,
      env: { ...process.env, Z2C_PROVIDER: "desktop" },
    });
    return "z2c respawned";
  }

  /** Managed ZCode Desktop reconciler bound to this supervisor's environment. */
  zcodeDesktopReconciler(): ZcodeDesktopReconciler {
    const spawnDetached = this.deps.spawnDetached
      ? (cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) =>
          this.deps.spawnDetached!(cmd, args, opts) as { pid?: number } | void
      : undefined;
    return new ZcodeDesktopReconciler({
      workspaceRoot: this.deps.workspaceRoot,
      stateDir: this.deps.stateDir,
      z2cRepoRoot: this.z2cRepo(),
      now: this.deps.now,
      sleep: this.deps.sleep,
      env: this.deps.env,
      ...(this.deps.processInspector ? { processInspector: this.deps.processInspector } : {}),
      ...(this.deps.zcodeRegistrationWaitMs !== undefined ? { registrationWaitMs: this.deps.zcodeRegistrationWaitMs } : {}),
      ...(spawnDetached ? { spawnDetached } : {}),
    });
  }

  private async actionLaunchManagedDesktop(): Promise<string> {
    return this.zcodeDesktopReconciler().launchManagedDesktop();
  }

  private async actionRestartBridge(): Promise<string> {
    const { ensureBridge } = await import("../process/daemon.js");
    const result = await ensureBridge(this.deps.workspaceRoot, { stateDir: this.deps.stateDir });
    return result ? "bridge ensured" : "bridge ensure returned no process";
  }

  private async actionStartTunnel(): Promise<string> {
    const { findLiveBridge } = await import("../bridge/runtime.js");
    const found = await findLiveBridge(this.workspaceId(), this.deps.workspaceRoot, { stateDir: this.deps.stateDir });
    if (!found) return "no live bridge for tunnel start";
    // The admin token is only known to CLI holders of the runtime pointer;
    // without it the strongest safe action is a bounded re-probe.
    const { readRuntimeState } = await import("../bridge/runtime.js");
    const pointer = readRuntimeState(this.deps.workspaceRoot, this.deps.stateDir);
    if (!pointer?.adminToken || !pointer.adminTokenKnown) return "admin token unavailable; tunnel start requires operator (c2c doctor)";
    const res = await fetch(`http://127.0.0.1:${found.port}/admin/tunnel/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${pointer.adminToken}` },
      signal: AbortSignal.timeout(90_000),
    });
    return res.ok ? "tunnel start accepted" : `tunnel start rejected (${res.status})`;
  }

  private async attempt(component: string, action: () => Promise<string>): Promise<void> {
    const status = this.components.get(component)!;
    status.state = "RECOVERING";
    status.lastActionAt = this.iso();
    try {
      const outcome = await action();
      this.log(component, status.lastAction ?? component, outcome);
      // Re-observe once after the action; the next tick confirms readiness.
    } catch (err) {
      this.log(component, status.lastAction ?? component, `error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── observation + recovery ladder ──────────────────────────────────────────

  private observeComponent(
    name: string,
    observation: ComponentObservation,
    recovery?: { action: string; run: () => Promise<string> },
  ): void {
    const status = this.components.get(name)!;
    status.detail = observation.detail;
    if (observation.state === "READY") {
      status.state = "READY";
      status.attempts = 0;
      status.nextRetryAt = null;
      status.nextRetryAtMs = null;
      status.lastOkAt = this.iso();
      return;
    }
    // Non-actionable degradation is reported, never auto-repaired.
    if (!observation.actionable || !recovery) {
      status.state = observation.state;
      return;
    }
    const nowMs = this.deps.now().getTime();
    // Budget exhausted: attempt 4 was the last one the ladder allows.
    if (status.attempts > 0 && recoveryDelayMs(status.attempts + 1) === null) {
      status.state = "FAILED";
      status.detail = `${observation.detail ?? "unhealthy"}; recovery attempts exhausted (${status.attempts}) — manual intervention required`;
      return;
    }
    if (status.nextRetryAtMs !== null && nowMs < status.nextRetryAtMs) {
      status.state = observation.state;
      return;
    }
    const attemptNo = status.attempts + 1;
    status.attempts = attemptNo;
    status.lastAction = recovery.action;
    // Gate the NEXT attempt by the delay that follows this one (attempt 1 is
    // immediate, then 5s, 15s, 30s — the documented ladder).
    const nextDelay = recoveryDelayMs(attemptNo + 1);
    status.nextRetryAtMs = nextDelay === null ? null : nowMs + nextDelay;
    status.nextRetryAt = nextDelay === null ? null : new Date(nowMs + nextDelay).toISOString();
    void this.attempt(name, recovery.run);
  }

  /**
   * Takeover/bootstrap reconciliation (R1.1): runs once after the lock is
   * acquired, before the tick loop. Bounded, idempotent, non-destructive and
   * provider-isolated:
   *   - codex / agy: local readiness only (READY_ON_DEMAND / EXECUTABLE_MISSING);
   *     never spawns a persistent process and never spends provider quota.
   *   - zcode: ensure the Z2C listener, then reconcile the managed Desktop
   *     (launch only when genuinely absent). A second takeover over a healthy
   *     desktop performs no launch.
   */
  async bootstrapOnTakeover(): Promise<ProviderBootstrapReport> {
    const probes = this.probes();
    this.log("providers", "bootstrap-on-takeover", "started");

    const codex = await reconcileCodexReadiness().catch((error: unknown): OnDemandReadiness => ({
      strategy: "on-demand", state: "EXECUTABLE_MISSING", executableAvailable: false,
      detail: error instanceof Error ? error.message : String(error),
    }));
    const gemini = reconcileAgyReadiness({ stateDir: this.deps.stateDir });

    // 1. Ensure the Z2C listener (bounded: trigger respawn, fixed-step wait).
    let z2cOk = false;
    try {
      z2cOk = await probes.z2cListener();
      if (!z2cOk) {
        await this.attempt("z2c-listener", () => this.actionRestartZ2c());
        for (let i = 0; i < 10 && !z2cOk; i++) {
          await this.deps.sleep(1_000);
          z2cOk = await probes.z2cListener().catch(() => false);
        }
      }
    } catch (error) {
      this.log("z2c-listener", "bootstrap-probe", `error: ${error instanceof Error ? error.message : String(error)}`);
    }

    // 2. Reconcile the managed ZCode Desktop (launch is idempotent and bounded).
    let zcode: ProviderBootstrapReport["zcode"];
    try {
      const obs = await probes.zcodeDesktop();
      if (obs.state === "ZCODE_DESKTOP_ABSENT") {
        await this.attempt("zcode-desktop", () => this.actionLaunchManagedDesktop());
      }
      const after = await probes.zcodeDesktop();
      zcode = {
        strategy: strategyFor("zcode"),
        state: after.state,
        managed: after.managed,
        desktopPid: after.desktopPid,
        registrationLive: after.registrationLive,
        ...(after.detail ? { detail: after.detail } : {}),
      };
    } catch (error) {
      zcode = {
        strategy: strategyFor("zcode"),
        state: "RECOVERING",
        managed: null,
        desktopPid: null,
        registrationLive: false,
        detail: `bootstrap reconciliation error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const report: ProviderBootstrapReport = { at: this.iso(), codex, gemini, zcode };
    this.lastProviderBootstrap = report;
    this.log("providers", "bootstrap-on-takeover", `codex=${codex.state} gemini=${gemini.state} zcode=${zcode.state}`);
    // Persist immediately so operators see the takeover result even before tick 1.
    this.persist(this.snapshot());
    return report;
  }

  private lastProviderBootstrap: ProviderBootstrapReport | null = null;

  /** One bounded observation + recovery pass. Returns the snapshot written to disk. */
  async runTick(): Promise<SupervisorSnapshot> {
    this.tick += 1;
    const probes = this.probes();

    // 1. core: bridge process + local health.
    const health = await probes.bridgeHealth().catch(() => null);
    this.observeComponent("core", health
      ? { state: "READY" }
      : { state: "OFFLINE", detail: "no healthy local bridge", actionable: true },
      { action: "ensure-bridge", run: () => this.actionRestartBridge() });

    // 2. tunnel: public MCP must answer the expected unauthenticated 401.
    if (health) {
      const publicOk = await probes.publicMcp().catch(() => false);
      this.observeComponent("tunnel", publicOk
        ? { state: "READY" }
        : { state: "DEGRADED", detail: "public MCP not answering with expected 401", actionable: true },
        { action: "tunnel-start", run: () => this.actionStartTunnel() });
    } else {
      this.observeComponent("tunnel", { state: "OFFLINE", detail: "core offline" });
    }

    // 3. runtime identity: drift is reported; activation is operator work.
    if (health) {
      const pointer = readReleasePointer(this.deps.repoRoot);
      const lkgCurrent = !pointer || pointer.releaseId === health.releaseId;
      this.observeComponent("runtime-identity", lkgCurrent
        ? { state: "READY" }
        : { state: "DEGRADED", detail: `running release ${health.releaseId ?? "unknown"} != activated ${pointer!.releaseId}; restart (or activate) to converge`, actionable: false });
    } else {
      this.observeComponent("runtime-identity", { state: "OFFLINE", detail: "core offline" });
    }

    // 4. queue + writer (read-only; supervisor never touches writer state).
    {
      const queue = await probes.queueState().catch(() => null);
      this.observeComponent("queue-writer", queue
        ? { state: "READY", detail: queue.paused ? "paused (by design)" : undefined }
        : { state: "DEGRADED", detail: "queue state unreadable", actionable: false });
    }

    // 5. ZCode coordinator heartbeat (stale heartbeat degrades, never restarts core).
    {
      const age = await probes.coordinatorHeartbeatAgeMs().catch(() => null);
      this.observeComponent("zcode-coordinator", age === null
        ? { state: "DEGRADED", detail: "no coordinator heartbeat (coordinator disabled or no queue root)" }
        : age < 5 * 60_000
          ? { state: "READY" }
          : { state: "DEGRADED", detail: `coordinator heartbeat stale (${Math.round(age / 1000)}s)` });
    }

    // 6. Z2C listener: restart the companion when its port is gone.
    const z2cOk = await probes.z2cListener().catch(() => false);
    this.observeComponent("z2c-listener", z2cOk
      ? { state: "READY" }
      : { state: "OFFLINE", detail: "z2c not listening on 127.0.0.1:8766", actionable: true },
      { action: "restart-z2c", run: () => this.actionRestartZ2c() });

    // 7. ZCode managed desktop + registration lane: reconcile desired state.
    //    READY = live registration for this workspace (no action). Absent =
    //    bounded managed launch through the existing retry ladder. Unmanaged
    //    Desktop (running without the proxy) is reported, never killed and
    //    never duplicated.
    {
      const obs = await probes.zcodeDesktop().catch((err: unknown) => ({
        state: "ZCODE_DESKTOP_MANAGED_NOT_REGISTERED",
        detail: `zcode desktop probe failed: ${err instanceof Error ? err.message : String(err)}`,
        managed: null,
        desktopPid: null,
        registrationLive: false,
      }) as ZcodeDesktopObservation);
      this.observeComponent("zcode-desktop", desktopComponentObservation(obs),
        obs.state === "ZCODE_DESKTOP_ABSENT"
          ? { action: "managed-desktop-launch", run: () => this.actionLaunchManagedDesktop() }
          : undefined);
    }

    // 8. providers: surface signals only; deep canaries are release-gate work.
    this.observeComponent("providers", { state: z2cOk ? "READY" : "DEGRADED", detail: z2cOk ? undefined : "zcode lane degraded (z2c offline)" });

    const snapshot = this.snapshot();
    this.persist(snapshot);
    return snapshot;
  }

  snapshot(): SupervisorSnapshot {
    const components = [...this.components.values()].map(({ nextRetryAtMs: _omit, ...rest }) => rest);
    const overall: ComponentState = components.some(c => c.state === "FAILED")
      ? "FAILED"
      : components.some(c => c.state === "OFFLINE")
        ? "OFFLINE"
        : components.some(c => c.state === "RECOVERING")
          ? "RECOVERING"
          : components.some(c => c.state === "DEGRADED")
            ? "DEGRADED"
            : "READY";
    return {
      schema: SUPERVISOR_SCHEMA,
      pid: process.pid,
      startedAt: this.startedAt,
      tick: this.tick,
      lastTickAt: this.iso(),
      overall,
      components,
      recoveryLog: [...this.recoveryLog],
      ...(this.lastProviderBootstrap ? { providerBootstrap: this.lastProviderBootstrap } : {}),
    };
  }

  private startedAt: string;

  private dir(): string {
    return path.join(this.deps.stateDir, "supervisor");
  }

  private persist(snapshot: SupervisorSnapshot): void {
    fs.mkdirSync(this.dir(), { recursive: true });
    const tmp = path.join(this.dir(), `status.json.tmp-${process.pid}`);
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, path.join(this.dir(), "status.json"));
  }

  /** Single-instance lock; returns false when another live supervisor holds it. */
  acquireLock(): boolean {
    fs.mkdirSync(this.dir(), { recursive: true });
    const lockFile = path.join(this.dir(), "supervisor.lock");
    if (fs.existsSync(lockFile)) {
      try {
        const old = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid: number; identity: string };
        if (pidAlive(old.pid) && old.identity !== this.identity()) return false;
      } catch { /* stale unparseable lock is reclaimable */ }
    }
    const tmp = path.join(this.dir(), `supervisor.lock.tmp-${process.pid}`);
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, identity: this.identity(), acquiredAt: this.iso() }), { mode: 0o600 });
    fs.renameSync(tmp, lockFile);
    return true;
  }

  releaseLock(): void {
    try { fs.rmSync(path.join(this.dir(), "supervisor.lock"), { force: true }); } catch { /* best effort */ }
  }

  private identity(): string {
    return createHash("sha256").update(`${process.pid}:${this.deps.now().getTime()}`).digest("hex").slice(0, 16);
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.runTick();
      } catch (err) {
        this.log("supervisor", "tick", `error: ${err instanceof Error ? err.message : String(err)}`);
      }
      await this.deps.sleep(this.deps.intervalMs);
    }
  }

  stop(): void {
    this.stopped = true;
  }
}

/** Directory of the running module (dist/supervisor or src/supervisor). */
export function supervisorModuleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}
