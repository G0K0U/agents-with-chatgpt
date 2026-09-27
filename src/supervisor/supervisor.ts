import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { resolveZ2cRepoRoot } from "../config/z2c-repo.js";
import { readReleasePointer, type ParityState } from "../bridge/runtime-identity.js";
import { getSystemProcessInspector } from "../bridge/runtime.js";
import { stableWorkspaceId } from "../workspace/identity.js";
import { sharedEnv } from "../config/env.js";
import {
  readSupervisorLock,
  inspectSupervisorProcess,
  type SupervisorLockRecord,
} from "./control.js";
export * from "./control.js";
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
 * Deployment/provider policy (P3): a deployment declares which provider lanes
 * exist and which of those are required. Disabled lanes are never launched,
 * never recovered, and never degrade overall health; enabled+required lanes
 * behave exactly as before. Defaults preserve the full three-provider
 * deployment, so an unconfigured machine is unchanged.
 *
 *   C2C_ENABLED_PROVIDERS   comma list of codex|gemini|glm (default: all)
 *   C2C_REQUIRED_PROVIDERS  comma list; defaults to the enabled set
 */
export type ProviderName = "codex" | "gemini" | "glm";

export interface ProviderPolicy {
  enabled: ReadonlySet<ProviderName>;
  required: ReadonlySet<ProviderName>;
}

export const ALL_PROVIDERS: readonly ProviderName[] = ["codex", "gemini", "glm"];

export function parseProviderPolicy(env: NodeJS.ProcessEnv = process.env): ProviderPolicy {
  const parse = (raw: string | undefined, fallback: readonly ProviderName[]): Set<ProviderName> => {
    if (!raw || !raw.trim()) return new Set(fallback);
    const items = raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry): entry is ProviderName => (ALL_PROVIDERS as readonly string[]).includes(entry));
    return new Set(items);
  };
  const enabled = parse(sharedEnv("ENABLED_PROVIDERS", env), ALL_PROVIDERS);
  const required = parse(sharedEnv("REQUIRED_PROVIDERS", env), [...enabled]);
  for (const name of [...required]) {
    if (!enabled.has(name)) required.delete(name); // required ⊆ enabled
  }
  return { enabled, required };
}

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

/**
 * DISABLED marks a component excluded by provider policy: it is not observed,
 * not recovered, and does not count toward overall health (neutral like READY).
 */
export type ComponentState = "READY" | "DEGRADED" | "OFFLINE" | "RECOVERING" | "FAILED" | "DISABLED";

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
    /** Desired workspaces whose desktop-agent registration was not live. */
    missingWorkspaceRoots?: string[];
    detail?: string;
  };
}

/** Per-provider truth for the operator-facing health projection (additive). */
export interface ProviderHealth {
  codex: {
    callable: boolean;
    state: string;
  };
  gemini: {
    callable: boolean;
    state: string;
    detail?: string;
    activeSessions?: number;
  };
  glm: {
    callable: boolean;
    desktop: string;
    z2c: "READY" | "OFFLINE";
    coordinator: "READY" | "DEGRADED";
    controlPlane: string;
    workspaceBinding: string;
    attested: boolean | null;
    detail?: string;
  };
}

/**
 * Fast recovery ladder in ms; index = attempt number - 1. Once this budget is
 * exhausted the component does NOT deadlock in FAILED: it drops to a bounded
 * slow lane (SLOW_RECOVERY_ATTEMPTS further attempts, 30 minutes apart). A
 * live incident showed the fast ladder exhausting inside a transient window
 * (ZCode Desktop restoring its windows ignored workspace-open requests for a
 * few minutes) and then never retrying again, permanently wedging the GLM
 * lane behind a condition that later resolved on its own. Slow-lane retries
 * stay far below any storm threshold while still converging.
 */
export const RECOVERY_DELAYS_MS = [0, 5_000, 15_000, 30_000];
export const SLOW_RECOVERY_DELAY_MS = 30 * 60_000;
export const SLOW_RECOVERY_ATTEMPTS = 4;
/** Total attempt budget: fast ladder + slow lane. */
export const RECOVERY_ATTEMPT_BUDGET = RECOVERY_DELAYS_MS.length + SLOW_RECOVERY_ATTEMPTS;

export function recoveryDelayMs(attempt: number): number | null {
  if (attempt < 1) return null;
  if (attempt <= RECOVERY_DELAYS_MS.length) return RECOVERY_DELAYS_MS[attempt - 1];
  if (attempt <= RECOVERY_ATTEMPT_BUDGET) return SLOW_RECOVERY_DELAY_MS;
  return null; // truly exhausted: manual intervention
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

export interface RecoveryLogEntry {
  at: string;
  component: string;
  action: string;
  outcome: string;
}

export interface SupervisorSnapshot {
  schema: number;
  pid: number;
  startedAt: string;
  tick: number;
  lastTickAt: string;
  overall: ComponentState;
  components: ComponentStatus[];
  /** Bounded recovery history. Legacy snapshots without this field read as an empty history. */
  recoveryLog: RecoveryLogEntry[];
  /** Authoritative OS creation identity captured from process inventory. */
  processStartIdentity?: string | null;
  /** Lock identity / generation of this supervisor process. */
  identity?: string;
  workspaceRoot?: string;
  stateDir?: string;
  /** Result of the most recent takeover bootstrap (R1.1); absent before the first takeover. */
  providerBootstrap?: ProviderBootstrapReport;
  /** Independent per-provider callable truth (Codex / Gemini / GLM); additive. */
  providerHealth?: ProviderHealth;
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
  /**
   * Additional workspace roots whose desktop-agent registrations are desired
   * state (e.g. the Engineering AI product workspace). Resolved by default
   * from the authorized workspace registry / queue-root resolution.
   */
  desiredZcodeWorkspaceRoots?: string[];
  /**
   * Deployment/provider policy. Default: parsed from C2C_ENABLED_PROVIDERS /
   * C2C_REQUIRED_PROVIDERS with the full three-provider deployment enabled,
   * so an unconfigured environment behaves exactly as before.
   */
  providerPolicy?: ProviderPolicy;
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
  /** Cheap local GLM control-plane layer status (queue root, binding, native). */
  glmControlPlane: () => Promise<Pick<import("../execution/zcode-control.js").ZcodeControlPlaneStatus, "level" | "workspace_binding" | "native">>;
  /** Queue + writer surfaces (read-only observation). */
  queueState: () => Promise<{ paused: boolean; activeWriter: string | null }>;
  /** The bridge runtime pointer: pid/port/startedAt, or null. */
  bridgePointer: () => Promise<{ pid: number; port: number } | null>;
}

const Z2C_DEFAULT_PORT = 8766;

/**
 * Bounded raw HTTP liveness probe. Settles EXACTLY once from the first of:
 * a parsed HTTP status line, a socket error, an idle-socket timeout, the
 * socket closing (peer accepted and closed with no usable response), or an
 * independent total wall-clock deadline. The deadline guards against a peer
 * that trickles bytes to keep the idle timer alive. A close before a status
 * line is a failed probe — an incomplete response must never read as
 * healthy. Timers, listeners, and the socket are always cleaned up.
 */
export function httpProbe(url: string, timeoutMs = 4_000): Promise<{ ok: boolean; status: number }> {
  return new Promise((resolve) => {
    const url_ = new URL(url);
    let settled = false;
    let totalDeadline: NodeJS.Timeout | null = null;
    const socket = net.connect({ host: url_.hostname, port: Number(url_.port || 80) }, () => {
      socket.write(`GET ${url_.pathname === "/" ? "/health" : url_.pathname} HTTP/1.1\r\nHost: ${url_.host}\r\nConnection: close\r\n\r\n`);
    });
    const finish = (ok: boolean, status: number): void => {
      if (settled) return;
      settled = true;
      if (totalDeadline !== null) clearTimeout(totalDeadline);
      socket.setTimeout(0);
      socket.removeAllListeners();
      try { socket.destroy(); } catch { /* probe cleanup */ }
      resolve({ ok, status });
    };
    // Independent total deadline: even bytes trickling just fast enough to
    // defeat the idle timeout cannot hold the probe open past timeoutMs.
    totalDeadline = setTimeout(() => finish(false, 0), timeoutMs);
    socket.setTimeout(timeoutMs, () => finish(false, 0));
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      buffer += chunk.toString("utf8");
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(buffer);
      if (m) finish(Number(m[1]) < 500, Number(m[1]));
    });
    socket.on("error", () => finish(false, 0));
    // Peer closed with no parsed status (or mid-response): bounded failure,
    // never a hang and never a false positive.
    socket.on("close", () => finish(false, 0));
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
 * Map a managed-desktop observation onto the component model. Genuinely
 * absent desktops, missing workspace registrations, and unmanaged instances
 * are actionable through bounded, officially supported mechanisms (managed
 * launch, single-instance workspace-open request, one graceful close +
 * relaunch). Only a Desktop that REFUSED a graceful close (possible unsaved
 * user work) is reported as manual-intervention degradation — the supervisor
 * never force-kills a Desktop and never launches a duplicate next to a live one.
 */
export function desktopComponentObservation(obs: ZcodeDesktopObservation): ComponentObservation {
  switch (obs.state) {
    case "READY":
      return { state: "READY", detail: obs.detail };
    case "DISABLED":
      return { state: "DISABLED", detail: obs.detail };
    case "RECOVERING":
      return { state: "RECOVERING", detail: obs.detail };
    case "ZCODE_DESKTOP_ABSENT":
      return { state: "OFFLINE", detail: obs.detail, actionable: true };
    case "ZCODE_DESKTOP_UNMANAGED":
      return { state: "DEGRADED", detail: obs.detail, actionable: true };
    case "ZCODE_DESKTOP_MANAGED_NOT_REGISTERED":
    case "ZCODE_WORKSPACE_NOT_OPEN":
      return { state: "DEGRADED", detail: obs.detail, actionable: true };
    case "ZCODE_DESKTOP_EXECUTABLE_NOT_FOUND":
    case "ZCODE_DESKTOP_EXECUTABLE_OVERRIDE_INVALID":
    case "USER_ACTION_REQUIRED_UNSAVED_STATE":
      return { state: "DEGRADED", detail: obs.detail, actionable: false };
    default:
      return { state: "DEGRADED", detail: obs.detail ?? obs.state, actionable: false };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class Supervisor {
  private readonly deps: Required<Pick<SupervisorDeps, "repoRoot" | "stateDir" | "workspaceRoot" | "intervalMs" | "now" | "sleep">> & SupervisorDeps;
  private readonly providerPolicy: ProviderPolicy;
  private readonly manageZcodeDesktop: boolean;
  private readonly components = new Map<string, ComponentStatus & { nextRetryAtMs: number | null }>();
  private readonly recoveryLog: SupervisorSnapshot["recoveryLog"] = [];
  private readonly activeRecoveries = new Set<string>();
  private readonly recoveryTasks = new Map<string, Promise<void>>();
  private processStartIdentity: string | null = null;
  private stopped = false;
  private resolveStop: (() => void) | null = null;
  private readonly stopSignal = new Promise<void>((resolve) => { this.resolveStop = resolve; });
  private tick = 0;

  constructor(deps: SupervisorDeps) {
    this.deps = {
      intervalMs: 30_000,
      now: () => new Date(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...deps,
    };
    this.providerPolicy = deps.providerPolicy ?? parseProviderPolicy(deps.env ?? process.env);
    // The official Z2C app-server path does not require a Desktop proxy or
    // Desktop relaunch. Legacy Desktop reconciliation is explicit opt-in.
    this.manageZcodeDesktop = (deps.env ?? process.env).A2C_MANAGE_ZCODE_DESKTOP === "1";
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
        const shared = await this.sharedBridge();
        const mcpUrl = shared.state === "healthy" && shared.runtime.publicUrl
          ? `${shared.runtime.publicUrl.replace(/\/$/, "")}/mcp` : null;
        if (!mcpUrl) return false;
        try {
          const res = await fetch(mcpUrl, { signal: AbortSignal.timeout(8_000) });
          return res.status === 401;
        } catch {
          return false;
        }
      },
      z2cListener: async () => {
        const probe = await httpProbe(`http://127.0.0.1:${Z2C_DEFAULT_PORT}/health`);
        return probe.ok;
      },
      zcodeDesktop: async () => (await this.zcodeDesktopReconciler()).observe(),
      coordinatorHeartbeatAgeMs: async () => {
        const { describeControlPlane } = await import("../execution/zcode-control.js");
        const status = describeControlPlane({ workspaceRoot: this.deps.workspaceRoot, stateDir: this.deps.stateDir });
        return status.coordinator.heartbeat_age_ms;
      },
      glmControlPlane: async () => {
        const { describeControlPlane } = await import("../execution/zcode-control.js");
        const status = describeControlPlane({ workspaceRoot: this.deps.workspaceRoot, stateDir: this.deps.stateDir });
        return { level: status.level, workspace_binding: status.workspace_binding, native: status.native };
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
        const shared = await this.sharedBridge();
        return shared.state === "healthy" ? { pid: shared.runtime.pid, port: shared.runtime.port } : null;
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
    return this.deps.z2cRepoRoot ?? resolveZ2cRepoRoot(this.deps.repoRoot);
  }

  private async actionRestartZ2c(): Promise<string> {
    const repo = this.z2cRepo();
    // A2C speaks the semantic service contract. A legacy task bridge on the
    // same port would appear reachable but cannot satisfy that contract.
    const semanticEntry = path.join(repo, "dist", "service", "main.js");
    if (!fs.existsSync(semanticEntry)) throw new Error(`Z2C semantic entry missing: ${semanticEntry}`);
    this.spawnDetached(process.execPath, [semanticEntry], {
      cwd: repo,
      env: {
        ...process.env, ...this.deps.env,
        Z2C_PROVIDER: "official",
        ZCODE_AGENT_SERVER_COMMAND: undefined,
        ZCODE_AGENT_SERVER_ARGS_JSON: undefined,
      },
    });
    return "z2c semantic service spawn requested";
  }

  /** Managed ZCode Desktop reconciler bound to this supervisor's environment. */
  async zcodeDesktopReconciler(): Promise<ZcodeDesktopReconciler> {
    const spawnDetached = this.deps.spawnDetached
      ? (cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) =>
          this.deps.spawnDetached!(cmd, args, opts) as { pid?: number } | void
      : undefined;
    const desiredRoots = await this.desiredZcodeWorkspaceRoots();
    return new ZcodeDesktopReconciler({
      workspaceRoot: this.deps.workspaceRoot,
      stateDir: this.deps.stateDir,
      z2cRepoRoot: this.z2cRepo(),
      now: this.deps.now,
      sleep: this.deps.sleep,
      env: this.deps.env,
      ...(desiredRoots.length ? { desiredWorkspaceRoots: desiredRoots } : {}),
      ...(this.deps.processInspector ? { processInspector: this.deps.processInspector } : {}),
      ...(this.deps.zcodeRegistrationWaitMs !== undefined ? { registrationWaitMs: this.deps.zcodeRegistrationWaitMs } : {}),
      ...(spawnDetached ? { spawnDetached } : {}),
    });
  }

  /**
   * Desired desktop workspaces beyond this supervisor's own workspace root.
   * Default: the authorized Engineering AI product workspace (it hosts the
   * governed ZCode queue and the GLM native lane binding). Resolution is
   * bounded to the registered workspace sources — never a drive scan.
   */
  private desiredZcodeWorkspaceRootsPromise: Promise<string[]> | null = null;
  private desiredZcodeWorkspaceRoots(): Promise<string[]> {
    this.desiredZcodeWorkspaceRootsPromise ??= (async () => {
      const explicit = this.deps.desiredZcodeWorkspaceRoots;
      if (explicit) return explicit;
      try {
        const { resolveEngineeringAiWorkspaceRoot } = await import("../execution/zcode-control.js");
        const root = resolveEngineeringAiWorkspaceRoot(
          { workspaceRoot: this.deps.workspaceRoot, stateDir: this.deps.stateDir },
          this.deps.env ?? process.env,
        );
        return root ? [root] : [];
      } catch {
        return [];
      }
    })();
    return this.desiredZcodeWorkspaceRootsPromise;
  }

  private async actionLaunchManagedDesktop(): Promise<string> {
    return (await this.zcodeDesktopReconciler()).launchManagedDesktop();
  }

  private async actionOpenZcodeWorkspaces(): Promise<string> {
    const reconciler = await this.zcodeDesktopReconciler();
    const obs = reconciler.observe();
    if (obs.openWorkspaces) return obs.openWorkspaces();
    if (obs.state === "ZCODE_DESKTOP_ABSENT" && obs.launch) return obs.launch();
    return `no open request possible in state ${obs.state}`;
  }

  private async actionManagedDesktopRestart(): Promise<string> {
    const reconciler = await this.zcodeDesktopReconciler();
    const obs = reconciler.observe();
    if (obs.managedRestart) return obs.managedRestart();
    return `no managed restart possible in state ${obs.state}`;
  }

  private async actionRestartBridge(): Promise<string> {
    const { ensureBridge } = await import("../process/daemon.js");
    const result = await ensureBridge(this.deps.workspaceRoot, { stateDir: this.deps.stateDir });
    return result ? "bridge ensured" : "bridge ensure returned no process";
  }

  private async sharedBridge() {
    const { findSharedBridgeObservation } = await import("../process/daemon.js");
    return findSharedBridgeObservation(this.workspaceId(), this.deps.workspaceRoot, { stateDir: this.deps.stateDir });
  }

  private async actionStartTunnel(): Promise<string> {
    const observation = await this.sharedBridge();
    if (observation.state !== "healthy") return "no authenticated shared bridge for tunnel start";
    const pointer = observation.runtime;
    const res = await fetch(`http://127.0.0.1:${pointer.port}/admin/tunnel/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${pointer.adminToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? "tunnel start accepted" : `tunnel start rejected (${res.status})`;
  }

  private async attempt(component: string, action: () => Promise<string>): Promise<void> {
    if (this.activeRecoveries.has(component)) return;
    this.activeRecoveries.add(component);
    const status = this.components.get(component)!;
    status.state = "RECOVERING";
    status.lastActionAt = this.iso();
    try {
      const outcome = await action();
      this.log(component, status.lastAction ?? component, outcome);
      // Re-observe once after the action; the next tick confirms readiness.
    } catch (err) {
      this.log(component, status.lastAction ?? component, `error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // A timeout or a slow provider response is not proof that a mutation
      // stopped. Keep the lane fenced until the underlying promise settles.
      this.activeRecoveries.delete(component);
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
    if (this.activeRecoveries.has(name)) {
      status.state = "RECOVERING";
      return;
    }
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
    // Total budget exhausted (fast ladder + slow lane): manual intervention.
    if (status.attempts > 0 && recoveryDelayMs(status.attempts + 1) === null) {
      status.state = "FAILED";
      status.detail = `${observation.detail ?? "unhealthy"}; recovery attempts exhausted (${status.attempts}) — manual intervention required`;
      return;
    }
    if (status.nextRetryAtMs !== null && nowMs < status.nextRetryAtMs) {
      status.state = observation.state;
      if (status.attempts >= RECOVERY_DELAYS_MS.length) {
        status.detail = `${observation.detail ?? "unhealthy"}; fast ladder exhausted — slow-lane recovery every ${Math.round(SLOW_RECOVERY_DELAY_MS / 60_000)}m (${status.attempts}/${RECOVERY_ATTEMPT_BUDGET} done)`;
      }
      return;
    }
    const attemptNo = status.attempts + 1;
    status.attempts = attemptNo;
    status.lastAction = recovery.action;
    // Slow-lane attempts keep the observation state visible with an explicit
    // note instead of the old permanent-FAILED wedge.
    status.detail = attemptNo > RECOVERY_DELAYS_MS.length
      ? `${observation.detail ?? "unhealthy"}; fast ladder exhausted — slow-lane recovery every ${Math.round(SLOW_RECOVERY_DELAY_MS / 60_000)}m (attempt ${attemptNo}/${RECOVERY_ATTEMPT_BUDGET})`
      : observation.detail;
    // Gate the NEXT attempt by the delay that follows this one (attempt 1 is
    // immediate, then 5s, 15s, 30s, then the slow lane).
    const nextDelay = recoveryDelayMs(attemptNo + 1);
    status.nextRetryAtMs = nextDelay === null ? null : nowMs + nextDelay;
    status.nextRetryAt = nextDelay === null ? null : new Date(nowMs + nextDelay).toISOString();
    const task = this.attempt(name, recovery.run);
    this.recoveryTasks.set(name, task);
    void task.finally(() => {
      if (this.recoveryTasks.get(name) === task) this.recoveryTasks.delete(name);
    });
  }

  /** Await an already-started recovery without dispatching another action. */
  async waitForRecovery(component: string): Promise<void> {
    await this.recoveryTasks.get(component);
  }

  /** Do not release this generation's lock while a dispatched action remains in flight. */
  async waitForRecoveries(): Promise<void> {
    await Promise.allSettled([...this.recoveryTasks.values()]);
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
    const glmEnabled = this.providerPolicy.enabled.has("glm");

    // 1. Ensure the Z2C listener (bounded: trigger respawn, fixed-step wait).
    //    Skipped entirely when the GLM lane is disabled by provider policy.
    let z2cOk = false;
    if (!glmEnabled) {
      this.log("z2c-listener", "bootstrap-probe", "skipped: glm disabled by provider policy");
    } else try {
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

    // 2. Reconcile the managed ZCode Desktop: launch when genuinely absent,
    //    open desired workspaces when the Desktop is alive without them, and
    //    perform ONE graceful close + managed relaunch on an unmanaged
    //    Desktop. Every action is idempotent and bounded. Skipped when the
    //    GLM lane is disabled by provider policy.
    let zcode: ProviderBootstrapReport["zcode"];
    if (!glmEnabled) {
      zcode = {
        strategy: strategyFor("zcode"),
        state: "DISABLED",
        managed: null,
        desktopPid: null,
        registrationLive: false,
        detail: "glm disabled by provider policy",
      };
      this.log("zcode-desktop", "bootstrap-probe", "skipped: glm disabled by provider policy");
    } else if (!this.manageZcodeDesktop) {
      zcode = {
        strategy: strategyFor("zcode"), state: "DISABLED", managed: null,
        desktopPid: null, registrationLive: false,
        detail: "Desktop management is not used by the official Z2C service",
      };
      this.log("zcode-desktop", "bootstrap-probe", "skipped: official Z2C service does not manage Desktop");
    } else try {
      const obs = await probes.zcodeDesktop();
      if (obs.state === "ZCODE_DESKTOP_ABSENT") {
        await this.attempt("zcode-desktop", () => this.actionLaunchManagedDesktop());
      } else if (obs.state === "ZCODE_DESKTOP_UNMANAGED") {
        await this.attempt("zcode-desktop", () => this.actionManagedDesktopRestart());
      } else if (obs.state === "ZCODE_DESKTOP_MANAGED_NOT_REGISTERED" || obs.state === "ZCODE_WORKSPACE_NOT_OPEN") {
        await this.attempt("zcode-desktop", () => this.actionOpenZcodeWorkspaces());
      }
      const after = await probes.zcodeDesktop();
      zcode = {
        strategy: strategyFor("zcode"),
        state: after.state,
        managed: after.managed,
        desktopPid: after.desktopPid,
        registrationLive: after.registrationLive,
        missingWorkspaceRoots: after.missingWorkspaceRoots,
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
  private lastDesktopObservation: ZcodeDesktopObservation | null = null;
  private lastProviderHealth: ProviderHealth | null = null;

  /** Cheap, local-only Codex readiness for the health projection. */
  private async codexReadiness(): Promise<OnDemandReadiness> {
    try {
      return await reconcileCodexReadiness({ env: this.deps.env });
    } catch (error) {
      return {
        strategy: "on-demand",
        state: "EXECUTABLE_MISSING",
        executableAvailable: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Gemini on-demand readiness plus durable last-attempt evidence. Zero
   * active sessions is normal for an on-demand provider and never degrades
   * it; only executable loss or fresh real-task evidence (auth/quota) does.
   */
  private async geminiReadiness(): Promise<Omit<OnDemandReadiness, "state"> & { state: "READY_ON_DEMAND" | "EXECUTABLE_MISSING" | "AUTH_REQUIRED" | "QUOTA_BLOCKED" | "FAILED" }> {
    const local = reconcileAgyReadiness({ stateDir: this.deps.stateDir, env: this.deps.env });
    if (local.state !== "READY_ON_DEMAND") return local;
    try {
      // Late-bound so the supervisor does not pull the antigravity module
      // graph in statically.
      const { readAntigravityAttemptEvidence, antigravityEvidenceReadiness } = await import("../execution/antigravity.js");
      const evidence = readAntigravityAttemptEvidence(this.deps.stateDir);
      const blocked = evidence ? antigravityEvidenceReadiness(evidence) : null;
      if (blocked) {
        return { ...local, state: blocked.state, detail: blocked.detail };
      }
    } catch { /* evidence unreadable: local readiness stands */ }
    return local;
  }

  /** One bounded observation + recovery pass. Returns the snapshot written to disk. */
  async runTick(): Promise<SupervisorSnapshot> {
    this.tick += 1;
    const probes = this.probes();
    const glmEnabled = this.providerPolicy.enabled.has("glm");

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
    if (!glmEnabled) {
      this.observeComponent("zcode-coordinator", { state: "DISABLED", detail: "glm disabled by provider policy" });
    } else {
      const age = await probes.coordinatorHeartbeatAgeMs().catch(() => null);
      this.observeComponent("zcode-coordinator", age === null
        ? { state: "DEGRADED", detail: "no coordinator heartbeat (coordinator disabled or no queue root)" }
        : age < 5 * 60_000
          ? { state: "READY" }
          : { state: "DEGRADED", detail: `coordinator heartbeat stale (${Math.round(age / 1000)}s)` });
    }

    // 6. Z2C listener: restart the companion when its port is gone. Disabled
    //    lanes are never probed and never respawned.
    if (!glmEnabled) {
      this.observeComponent("z2c-listener", { state: "DISABLED", detail: "glm disabled by provider policy" });
    } else {
      const z2cOk = await probes.z2cListener().catch(() => false);
      this.observeComponent("z2c-listener", z2cOk
        ? { state: "READY" }
        : { state: "OFFLINE", detail: "z2c not listening on 127.0.0.1:8766", actionable: true },
        { action: "restart-z2c", run: () => this.actionRestartZ2c() });
    }

    // 7. ZCode managed desktop + registration lane: reconcile desired state.
    //    READY = live registrations for every desired workspace (no action).
    //    Absent = bounded managed launch; missing workspace registrations =
    //    official workspace-open request; unmanaged Desktop = one graceful
    //    close + managed relaunch (refusal → explicit user-action state). The
    //    supervisor never force-kills a Desktop and never duplicates one.
    if (!glmEnabled || !this.manageZcodeDesktop) {
      this.observeComponent("zcode-desktop", { state: "DISABLED", detail: glmEnabled
        ? "official Z2C service does not manage Desktop" : "glm disabled by provider policy" });
      this.lastDesktopObservation = null;
    } else {
      const obs = await probes.zcodeDesktop().catch((err: unknown) => ({
        state: "ZCODE_DESKTOP_MANAGED_NOT_REGISTERED",
        detail: `zcode desktop probe failed: ${err instanceof Error ? err.message : String(err)}`,
        managed: null,
        desktopPid: null,
        registrationLive: false,
        missingWorkspaceRoots: [],
      }) as ZcodeDesktopObservation);
      const observation = desktopComponentObservation(obs);
      // Closing the unmanaged instance removes the blocker. Its exhausted
      // close budget must not prevent the distinct managed-launch recovery.
      // Reset only on this observed transition, never on repeated absence.
      if (obs.state === "ZCODE_DESKTOP_ABSENT" &&
          (this.lastDesktopObservation?.state === "ZCODE_DESKTOP_UNMANAGED" ||
           this.lastDesktopObservation?.state === "USER_ACTION_REQUIRED_UNSAVED_STATE")) {
        const desktop = this.components.get("zcode-desktop")!;
        desktop.attempts = 0;
        desktop.nextRetryAt = null;
        desktop.nextRetryAtMs = null;
      }
      const recovery =
        obs.state === "ZCODE_DESKTOP_ABSENT" && obs.launch
          ? { action: "managed-desktop-launch", run: () => this.actionLaunchManagedDesktop() }
          : (obs.state === "ZCODE_WORKSPACE_NOT_OPEN" || obs.state === "ZCODE_DESKTOP_MANAGED_NOT_REGISTERED") && obs.openWorkspaces
            ? { action: "open-zcode-workspaces", run: () => this.actionOpenZcodeWorkspaces() }
            : obs.state === "ZCODE_DESKTOP_UNMANAGED" && obs.managedRestart
              ? { action: "managed-desktop-graceful-restart", run: () => this.actionManagedDesktopRestart() }
              : undefined;
      this.observeComponent("zcode-desktop", observation, recovery);
      this.lastDesktopObservation = obs;
    }

    // 8. providers: independent per-provider callable truth. A healthy Z2C
    //    port does NOT mean GLM is usable, and zero Gemini sessions does NOT
    //    mean Gemini is broken. Codex/Gemini are on-demand (local readiness);
    //    GLM needs desktop + z2c + coordinator + workspace binding. Only
    //    REQUIRED providers degrade the component; enabled-but-optional
    //    failures stay visible in providerHealth without degrading overall.
    {
      const policy = this.providerPolicy;
      const glmOff = !policy.enabled.has("glm");
      const codexOff = !policy.enabled.has("codex");
      const geminiOff = !policy.enabled.has("gemini");

      const codex = codexOff
        ? { strategy: "on-demand" as const, state: "DISABLED" as const, executableAvailable: false, detail: "codex disabled by provider policy" }
        : await this.codexReadiness();
      const gemini = geminiOff
        ? { strategy: "on-demand" as const, state: "DISABLED" as const, executableAvailable: false, detail: "gemini disabled by provider policy" }
        : await this.geminiReadiness();

      let z2cOk = false;
      let coordinatorAge: number | null = null;
      let controlPlane: Pick<import("../execution/zcode-control.js").ZcodeControlPlaneStatus, "level" | "workspace_binding" | "native"> = {
        level: "QUEUE_ROOT_MISSING",
        workspace_binding: "UNRESOLVED" as const,
        native: { observed: false, available: null, provider: null, model: null, attested: null, observed_at: null },
      };
      let desktop: ZcodeDesktopObservation | null = null;
      if (!glmOff) {
        z2cOk = await probes.z2cListener().catch(() => false);
        coordinatorAge = await probes.coordinatorHeartbeatAgeMs().catch(() => null);
        controlPlane = await probes.glmControlPlane().catch(() => controlPlane);
        desktop = this.lastDesktopObservation;
      }
      const glmDesktopReady = !this.manageZcodeDesktop || desktop?.state === "READY";
      const glmCallable = !glmOff && glmDesktopReady
        && z2cOk
        && coordinatorAge !== null && coordinatorAge < 5 * 60_000
        && controlPlane.level === "READY" && controlPlane.workspace_binding === "OK"
        && controlPlane.native.attested === true;
      const geminiCallable = gemini.state !== "EXECUTABLE_MISSING" && gemini.state !== "DISABLED";
      const providerHealth: ProviderHealth = {
        codex: { callable: codex.state === "READY_ON_DEMAND", state: codex.state },
        gemini: {
          callable: geminiCallable,
          state: gemini.state,
          ...(gemini.detail ? { detail: gemini.detail } : {}),
        },
        glm: {
          callable: glmCallable,
          desktop: glmOff ? "DISABLED" : this.manageZcodeDesktop ? (desktop?.state ?? "UNKNOWN") : "NOT_REQUIRED_OFFICIAL",
          z2c: z2cOk ? "READY" : "OFFLINE",
          coordinator: coordinatorAge !== null && coordinatorAge < 5 * 60_000 ? "READY" : "DEGRADED",
          controlPlane: controlPlane.level,
          workspaceBinding: controlPlane.workspace_binding,
          attested: controlPlane.native.attested,
          ...(glmCallable || glmOff ? {} : { detail: `desktop=${this.manageZcodeDesktop ? desktop?.state ?? "UNKNOWN" : "not-required"} z2c=${z2cOk ? "READY" : "OFFLINE"} coordinator=${coordinatorAge === null ? "unknown" : `${Math.round(coordinatorAge / 1000)}s`} control=${controlPlane.level} attested=${controlPlane.native.attested ?? "unknown"}` }),
        },
      };
      if (glmOff) {
        providerHealth.glm.controlPlane = "DISABLED";
        providerHealth.glm.detail = "glm disabled by provider policy";
      }
      this.lastProviderHealth = providerHealth;
      const broken: string[] = [];
      const optional: string[] = [];
      const require = (name: ProviderName, callable: boolean, label: string): void => {
        if (callable) return;
        if (policy.required.has(name)) broken.push(label);
        else if (policy.enabled.has(name)) optional.push(label);
      };
      require("codex", providerHealth.codex.callable, `codex=${providerHealth.codex.state}`);
      require("gemini", geminiCallable, `gemini=${providerHealth.gemini.state}`);
      require("glm", glmCallable, `glm=${providerHealth.glm.detail ?? providerHealth.glm.desktop}`);
      this.observeComponent("providers", broken.length === 0
        ? { state: "READY", detail: [
            "codex=" + (codexOff ? "disabled" : "callable"),
            "gemini=" + (geminiOff ? "disabled" : `callable(${gemini.state})`),
            "glm=" + (glmOff ? "disabled" : "callable"),
            ...(optional.length > 0 ? [`optional-degraded: ${optional.join(" ")}`] : []),
          ].join(" ") }
        : { state: "DEGRADED", detail: [...broken, ...(optional.length > 0 ? [`optional-degraded: ${optional.join(" ")}`] : [])].join(" ") });
    }

    const snapshot = this.snapshot();
    this.persist(snapshot);
    return snapshot;
  }

  snapshot(): SupervisorSnapshot {
    const components = [...this.components.values()].map(({ nextRetryAtMs: _omit, ...rest }) => rest);
    // DISABLED components are policy-excluded and never color overall health.
    const active = components.filter((c) => c.state !== "DISABLED");
    const overall: ComponentState = active.some(c => c.state === "FAILED")
      ? "FAILED"
      : active.some(c => c.state === "OFFLINE")
        ? "OFFLINE"
        : active.some(c => c.state === "RECOVERING")
          ? "RECOVERING"
          : active.some(c => c.state === "DEGRADED")
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
      processStartIdentity: this.processStartIdentity,
      identity: this.lockIdentity,
      workspaceRoot: this.deps.workspaceRoot,
      stateDir: this.deps.stateDir,
      ...(this.lastProviderBootstrap ? { providerBootstrap: this.lastProviderBootstrap } : {}),
      ...(this.lastProviderHealth ? { providerHealth: this.lastProviderHealth } : {}),
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

  private readonly lockIdentity = createHash("sha256").update(`${process.pid}:${Math.random()}`).digest("hex");
  private lockServer: net.Server | null = null;

  /** OS-held mutex serializes Windows takeover even when stale metadata exists. */
  async acquireLock(): Promise<boolean> {
    fs.mkdirSync(this.dir(), { recursive: true });
    const lockFile = path.join(this.dir(), "supervisor.lock");
    if (process.platform === "win32") {
      const domain = fs.realpathSync.native(this.deps.stateDir).toLowerCase();
      const key = createHash("sha256").update(domain).digest("hex").slice(0, 32);
      const server = net.createServer(socket => socket.destroy());
      const acquired = await new Promise<boolean>(resolve => {
        server.once("error", () => resolve(false));
        server.listen(`\\\\.\\pipe\\c2c-supervisor-${key}`, () => resolve(true));
      });
      if (!acquired) return false;
      this.lockServer = server;
      server.unref();
    }
    try {
      const inspector = this.deps.processInspector?.() ?? getSystemProcessInspector();
      if (fs.existsSync(lockFile)) {
        const old = JSON.parse(fs.readFileSync(lockFile, "utf8")) as {
          pid?: number; processStartIdentity?: string;
        };
        const stalePid = old.pid;
        if (typeof stalePid !== "number" || !Number.isInteger(stalePid) || stalePid <= 0) {
          this.closeLockServer();
          return false;
        }
        if (pidAlive(stalePid)) {
          // A live PID may belong to a different process generation. Only an
          // OS-observed generation mismatch permits replacing this stale lock.
          const row = inspector.list()?.find((candidate) => candidate.pid === stalePid);
          if (typeof old.processStartIdentity !== "string" || old.processStartIdentity.length === 0 ||
              !row?.processStartIdentity ||
              row.processStartIdentity === old.processStartIdentity) {
            this.closeLockServer();
            return false;
          }
        }
        // On Windows the OS mutex proves no other new supervisor can race us.
        if (!this.lockServer) return false;
        fs.rmSync(lockFile);
      }
      const current = inspector.list()?.find((row) => row.pid === process.pid);
      const executable = fs.realpathSync.native(process.execPath);
      const entry = process.argv[1] ? fs.realpathSync.native(path.resolve(process.argv[1])) : null;
      if (!current?.processStartIdentity || !current.executable || !entry ||
          (process.platform === "win32"
            ? current.executable.toLowerCase() !== executable.toLowerCase()
            : current.executable !== executable)) {
        this.closeLockServer();
        return false;
      }
      this.processStartIdentity = current.processStartIdentity;
      fs.writeFileSync(lockFile, JSON.stringify({
        pid: process.pid,
        identity: this.lockIdentity,
        acquiredAt: this.iso(),
        processStartIdentity: current.processStartIdentity,
        workspaceRoot: fs.realpathSync.native(this.deps.workspaceRoot),
        stateDir: fs.realpathSync.native(this.deps.stateDir),
        executable,
        entry,
      }), { flag: "wx", mode: 0o600 });
      return true;
    } catch {
      this.closeLockServer();
      return false;
    }
  }

  private closeLockServer(): void {
    this.lockServer?.close();
    this.lockServer = null;
  }

  releaseLock(): void {
    const file = path.join(this.dir(), "supervisor.lock");
    try {
      const current = JSON.parse(fs.readFileSync(file, "utf8")) as { identity?: string };
      if (current.identity === this.lockIdentity) fs.rmSync(file);
    } catch { /* another owner or absent metadata */ }
    this.closeLockServer();
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.runTick();
      } catch (err) {
        this.log("supervisor", "tick", `error: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!this.stopped) await Promise.race([this.deps.sleep(this.deps.intervalMs), this.stopSignal]);
    }
  }

  stop(): void {
    this.stopped = true;
    this.resolveStop?.();
  }
}

/** Directory of the running module (dist/supervisor or src/supervisor). */
export function supervisorModuleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}
