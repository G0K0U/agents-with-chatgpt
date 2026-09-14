import fs from "node:fs";
import path from "node:path";
import { readWorkspaceQueuePauseState } from "../execution/queue-state.js";
import { releaseStatus, type ReleaseStatus } from "./release.js";
import type { RuntimeState } from "../bridge/runtime.js";
import type { ReleasePointer } from "../bridge/runtime-identity.js";

/**
 * One operational truth source (Phase: unified doctor). Assembles the
 * operator-facing view from durable local surfaces only — runtime pointer,
 * queue/writer state files, release pointer, supervisor status, and bounded
 * liveness probes. Never exposes secrets (admin tokens are stripped) and
 * never fails the whole report because one section is unreadable.
 */

export interface UnifiedSection<T> {
  state: "READY" | "DEGRADED" | "OFFLINE" | "UNKNOWN";
  data: T | null;
  error?: string;
}

export interface CoreSectionData {
  workspaceId: string;
  pid: number;
  port: number;
  startedAt: string;
  stateDomainGeneration: string | null;
  publicUrl: string | null;
}
export interface RuntimeSectionData {
  releaseId: string | null;
  sourceParity: string;
  buildParity: string;
  version: string | null;
}
export interface ReleaseSectionData {
  pointer: ReleasePointer | null;
  distReleaseId: string | null;
  drift: string[];
}
export interface TunnelSectionData {
  publicUrl: string | null;
  mcpUrl: string | null;
}
export interface QueueSectionData {
  workspaceId: string;
  paused: boolean;
  activeWriter: string | null;
}
export interface SupervisorSectionData {
  overall: string;
  /** Explicit naming: this section describes the R1 runtime supervisor only. */
  runtimeSupervisor: string;
  pid: number;
  lastTickAt: string;
  components: Record<string, string>;
}
export interface ProvidersSectionData {
  codex: {
    strategy: "on-demand";
    state: string;
    executableAvailable: boolean;
  };
  gemini: {
    strategy: "on-demand";
    state: string;
    executableAvailable: boolean;
    liveSession: boolean;
  };
  zcode: {
    strategy: "managed-persistent";
    state: string;
    managed: boolean | null;
    desktopPid: number | null;
    registrationLive: boolean;
    workspaceBinding: string;
    attested: boolean | null;
  };
}

export interface UnifiedReport {
  core: UnifiedSection<CoreSectionData>;
  runtime: UnifiedSection<RuntimeSectionData>;
  release: UnifiedSection<ReleaseSectionData>;
  tunnel: UnifiedSection<TunnelSectionData>;
  queue: UnifiedSection<QueueSectionData>;
  supervisor: UnifiedSection<SupervisorSectionData>;
  providers: UnifiedSection<ProvidersSectionData>;
}

function section<T>(state: UnifiedSection<T>["state"], data: T | null, error?: string): UnifiedSection<T> {
  return { state, data, error } as UnifiedSection<T>;
}

export interface UnifiedReportInputs {
  repoRoot: string;
  stateDir: string;
  workspaceId: string;
  workspaceRoot: string;
  runtime: RuntimeState | null;
  /** Release identity reported by the running process, when known. */
  runningReleaseId?: string | null;
  now?: Date;
}

function z2cRepoRoot(repoRoot: string): string {
  return path.resolve(repoRoot, "..", "zcode-with-chatgpt");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function buildUnifiedReport(inputs: UnifiedReportInputs): Promise<UnifiedReport> {
  const { repoRoot, stateDir, workspaceId, workspaceRoot, runtime } = inputs;

  // ── core ───────────────────────────────────────────────────────────────────
  const core: UnifiedReport["core"] = runtime
    ? section<CoreSectionData>("READY", {
        workspaceId: runtime.workspaceId,
        pid: runtime.pid,
        port: runtime.port,
        startedAt: runtime.startedAt,
        stateDomainGeneration: runtime.stateDomainGeneration ?? null,
        publicUrl: runtime.publicUrl,
      })
    : section<CoreSectionData>("OFFLINE", {
        workspaceId: workspaceId,
        pid: 0,
        port: 0,
        startedAt: "",
        stateDomainGeneration: null,
        publicUrl: null,
      }, "no healthy bridge runtime pointer");

  // ── runtime identity (from the running process via /health release block) ─
  let runtimeSection: UnifiedReport["runtime"] = section<RuntimeSectionData>("UNKNOWN", null, "runtime identity unavailable");
  if (runtime) {
    try {
      const res = await fetch(`http://127.0.0.1:${runtime.port}/health`, { signal: AbortSignal.timeout(4_000) });
      const body = await res.json() as { release?: { releaseId?: string | null; sourceParity?: string; buildParity?: string; version?: string } };
      const release = body.release ?? null;
      const ok = release ? release.sourceParity === "ok" && release.buildParity === "ok" : false;
      runtimeSection = section<RuntimeSectionData>(ok ? "READY" : "DEGRADED", release
        ? {
            releaseId: release.releaseId ?? null,
            sourceParity: release.sourceParity ?? "unknown",
            buildParity: release.buildParity ?? "unknown",
            version: release.version ?? null,
          }
        : null, release ? undefined : "running process reports no release identity (stale build?)");
    } catch (error) {
      runtimeSection = section<RuntimeSectionData>("UNKNOWN", null, error instanceof Error ? error.message : String(error));
    }
  }

  // ── release (on-disk truth vs running) ─────────────────────────────────────
  let release: UnifiedReport["release"];
  try {
    const status: ReleaseStatus = releaseStatus(repoRoot, inputs.runningReleaseId ?? null);
    const blocking = status.drift.filter((d) => d !== "LKG_AHEAD_OF_DIST");
    release = section<ReleaseSectionData>(blocking.length ? "DEGRADED" : "READY", {
      pointer: status.pointer,
      distReleaseId: status.distReleaseId,
      drift: status.drift,
    });
  } catch (error) {
    release = section<ReleaseSectionData>("UNKNOWN", null, error instanceof Error ? error.message : String(error));
  }

  // ── tunnel (persisted endpoint; deep probe lives in the doctor checks) ────
  let mcpUrl: string | null = null;
  try {
    const { readLastEndpoint } = await import("../config/endpoint.js");
    mcpUrl = readLastEndpoint(workspaceId, stateDir)?.mcpUrl ?? null;
  } catch { /* endpoint file unreadable */ }
  const tunnel = section<TunnelSectionData>(
    runtime?.publicUrl ? "READY" : "DEGRADED",
    { publicUrl: runtime?.publicUrl ?? null, mcpUrl },
    runtime?.publicUrl ? undefined : "no public URL on the runtime pointer",
  );

  // ── queue + writer (read-only durable state) ───────────────────────────────
  let queue: UnifiedReport["queue"];
  try {
    const pausedState = readWorkspaceQueuePauseState(workspaceId, stateDir);
    let activeWriter: string | null = null;
    const lockFile = path.join(stateDir, "locks", `${workspaceId}.json`);
    if (fs.existsSync(lockFile)) {
      try {
        const lock = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { holder?: { provider?: string; taskId?: string } };
        if (lock.holder?.provider) activeWriter = `${lock.holder.provider}:${lock.holder.taskId ?? ""}`;
      } catch { /* unreadable lock: report no writer rather than guessing */ }
    }
    queue = section<QueueSectionData>("READY", { workspaceId, paused: pausedState.paused, activeWriter });
  } catch (error) {
    queue = section<QueueSectionData>("UNKNOWN", null, error instanceof Error ? error.message : String(error));
  }

  // ── supervisor snapshot ────────────────────────────────────────────────────
  let supervisor: UnifiedReport["supervisor"] = section<SupervisorSectionData>("OFFLINE", null, "no supervisor status; start with `c2c supervisor start`");
  try {
    const file = path.join(stateDir, "supervisor", "status.json");
    if (fs.existsSync(file)) {
      const snap = JSON.parse(fs.readFileSync(file, "utf8")) as {
        overall: string; pid: number; lastTickAt: string; components?: Array<{ component: string; state: string }>;
      };
      const live = pidAlive(snap.pid);
      const ageMs = (inputs.now ?? new Date()).getTime() - Date.parse(snap.lastTickAt);
      if (!live) supervisor = section<SupervisorSectionData>("OFFLINE", null, `supervisor pid ${snap.pid} is not running`);
      else if (ageMs > 3 * 60_000) supervisor = section<SupervisorSectionData>("DEGRADED", null, `supervisor heartbeat stale (${Math.round(ageMs / 1000)}s)`);
      else {
        const components: Record<string, string> = {};
        for (const c of snap.components ?? []) components[c.component] = c.state;
        supervisor = section<SupervisorSectionData>(
          snap.overall === "READY" ? "READY" : snap.overall === "DEGRADED" ? "DEGRADED" : snap.overall === "FAILED" ? "OFFLINE" : "DEGRADED",
          { overall: snap.overall, runtimeSupervisor: snap.overall, pid: snap.pid, lastTickAt: snap.lastTickAt, components },
        );
      }
    }
  } catch (error) {
    supervisor = section<SupervisorSectionData>("UNKNOWN", null, error instanceof Error ? error.message : String(error));
  }

  // ── providers (R1.1 bootstrap semantics; local surfaces only, no secrets) ─
  let providers: UnifiedReport["providers"];
  try {
    const { reconcileCodexReadiness, reconcileAgyReadiness, ZcodeDesktopReconciler } =
      await import("../supervisor/provider-bootstrap.js");
    const codex = await reconcileCodexReadiness();
    const gemini = reconcileAgyReadiness({ stateDir });
    const reconciler = new ZcodeDesktopReconciler({ workspaceRoot, stateDir, z2cRepoRoot: z2cRepoRoot(repoRoot) });
    const zcodeObs = reconciler.observe();
    // Workspace binding + attestation come from the control-plane status layers
    // (cheap local reads); this report never overstates them.
    let workspaceBinding = "UNKNOWN";
    let attested: boolean | null = null;
    try {
      const { describeControlPlane } = await import("../execution/zcode-control.js");
      const cp = describeControlPlane({ workspaceRoot, stateDir });
      workspaceBinding = cp.workspace_binding;
      attested = cp.native.attested;
    } catch { /* control-plane status unavailable */ }
    providers = section<ProvidersSectionData>(
      codex.state === "READY_ON_DEMAND" && gemini.state === "READY_ON_DEMAND" && zcodeObs.state === "READY"
        ? "READY" : "DEGRADED",
      {
        codex: { strategy: "on-demand", state: codex.state, executableAvailable: codex.executableAvailable },
        gemini: { strategy: "on-demand", state: gemini.state, executableAvailable: gemini.executableAvailable, liveSession: false },
        zcode: {
          strategy: "managed-persistent",
          state: zcodeObs.state,
          managed: zcodeObs.managed,
          desktopPid: zcodeObs.desktopPid,
          registrationLive: zcodeObs.registrationLive,
          workspaceBinding,
          attested,
        },
      },
    );
  } catch (error) {
    providers = section<ProvidersSectionData>("UNKNOWN", null, error instanceof Error ? error.message : String(error));
  }

  return { core, runtime: runtimeSection, release, tunnel, queue, supervisor, providers };
}
