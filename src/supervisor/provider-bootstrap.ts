import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { getSystemProcessInspector, type BridgeProcessInspector } from "../bridge/runtime.js";
import { getStateDir } from "../config/paths.js";
import { stableWorkspaceId } from "../workspace/identity.js";

/**
 * Provider bootstrap & reconciliation (Stability R1.1).
 *
 * Each provider declares a bootstrap strategy and the takeover/tick paths
 * reconcile observed state toward it:
 *
 *   codex / agy  → "on-demand": only local, cost-free readiness checks
 *                  (executable resolves, isolated state preparable). No
 *                  persistent process, no remote canary, no quota spend.
 *   zcode        → "managed-persistent": the real ZCode Desktop GUI is the
 *                  lane. When absent it is launched WITH the desktop-agent
 *                  proxy environment so the registration → Z2C → workspace
 *                  binding → native attestation chain can come up on its own.
 *                  This module never weakens attestation, never substitutes
 *                  the headless shim, and never kills an unmanaged Desktop.
 *
 * Desired-state rules for the managed ZCode Desktop:
 *   no registration, no Desktop process             → launch managed Desktop
 *   registration live for this exact workspace       → READY, do nothing
 *   Desktop process present, registration absent     → ZCODE_DESKTOP_UNMANAGED
 *                                                      (DEGRADED, manual restart;
 *                                                      a second launch would be
 *                                                      redirected into the
 *                                                      existing single-instance
 *                                                      GUI, and killing it could
 *                                                      destroy unsaved work)
 *   supervisor-owned Desktop alive, no registration  → wait while young, then
 *                                                      ZCODE_DESKTOP_MANAGED_NOT_REGISTERED
 *                                                      (manual; no auto-kill)
 */

export type ProviderBootstrapStrategy = "on-demand" | "managed-persistent";

export type ProviderReadinessState =
  | "READY"
  | "READY_ON_DEMAND"
  | "EXECUTABLE_MISSING"
  | "ZCODE_DESKTOP_ABSENT"
  | "ZCODE_DESKTOP_UNMANAGED"
  | "ZCODE_DESKTOP_MANAGED_NOT_REGISTERED"
  | "ZCODE_DESKTOP_EXECUTABLE_NOT_FOUND"
  | "ZCODE_DESKTOP_EXECUTABLE_OVERRIDE_INVALID"
  | "RECOVERING";

/** Cheap local readiness for an on-demand provider (never spawns, never probes remotely). */
export interface OnDemandReadiness {
  strategy: "on-demand";
  state: "READY_ON_DEMAND" | "EXECUTABLE_MISSING";
  executableAvailable: boolean;
  detail?: string;
}

export function strategyFor(provider: "codex" | "gemini" | "zcode"): ProviderBootstrapStrategy {
  return provider === "zcode" ? "managed-persistent" : "on-demand";
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isRegularFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Same registration layout scripts/desktop-agent-proxy.mjs publishes. */
export function desktopAgentsDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.Z2C_STATE_DIR
    || path.join(env.LOCALAPPDATA || "", "z2c");
  return path.join(base, "desktop-agents");
}

/** Mirrors the proxy's own workspace-hash registration file name. */
export function registrationPathFor(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const hash = createHash("sha1").update(workspaceRoot.toLowerCase()).digest("hex").slice(0, 16);
  return path.join(desktopAgentsDir(env), `agent-${hash}.json`);
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const n = path.normalize(p).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? n.toLowerCase() : n;
  };
  return norm(a) === norm(b);
}

// ── Codex / AGY on-demand readiness ─────────────────────────────────────────

export async function reconcileCodexReadiness(options: {
  env?: NodeJS.ProcessEnv;
  resolveExecutable?: () => string;
} = {}): Promise<OnDemandReadiness> {
  try {
    let resolve = options.resolveExecutable;
    if (!resolve) {
      // Late-bound so the supervisor process does not pull the app-server
      // module graph in statically.
      const { resolveCodexExecutable } = await import("../execution/app-server.js");
      resolve = () => resolveCodexExecutable({ env: options.env });
    }
    const executable = resolve();
    return { strategy: "on-demand", state: "READY_ON_DEMAND", executableAvailable: true, detail: executable };
  } catch (error) {
    return {
      strategy: "on-demand",
      state: "EXECUTABLE_MISSING",
      executableAvailable: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Bounded AGY resolution: standard install location only; no drive scan, no PATH execution. */
export function resolveAgyExecutable(env: NodeJS.ProcessEnv = process.env, isFile = isRegularFile): string | null {
  const localAppData = env.LOCALAPPDATA;
  if (localAppData) {
    const defaultPath = path.join(localAppData, "agy", "bin", "agy.exe");
    if (isFile(defaultPath)) return defaultPath;
  }
  return null;
}

export function reconcileAgyReadiness(options: {
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  isFile?: (p: string) => boolean;
  ensureProviderDir?: (dir: string) => string;
} = {}): OnDemandReadiness {
  const isFile = options.isFile ?? isRegularFile;
  const executable = resolveAgyExecutable(options.env, isFile);
  if (!executable) {
    return {
      strategy: "on-demand",
      state: "EXECUTABLE_MISSING",
      executableAvailable: false,
      detail: "agy.exe not found in %LOCALAPPDATA%\\agy\\bin",
    };
  }
  try {
    const ensure = options.ensureProviderDir ?? ((dir: string) => fs.mkdirSync(dir, { recursive: true }));
    const base = options.stateDir ?? getStateDir();
    const providerDir = path.join(base, "providers", "antigravity");
    ensure(providerDir);
    fs.accessSync(providerDir, fs.constants.W_OK);
  } catch (error) {
    return {
      strategy: "on-demand",
      state: "EXECUTABLE_MISSING",
      executableAvailable: true,
      detail: `isolated provider state not preparable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // Local prerequisites only: no startup canary, no quota spend. A real
  // provider interaction remains the only path to AUTH_ERROR/MODEL_UNAVAILABLE
  // evidence, reported by the task lane, never fabricated here.
  return { strategy: "on-demand", state: "READY_ON_DEMAND", executableAvailable: true, detail: executable };
}

// ── ZCode Desktop executable discovery ──────────────────────────────────────

export class ZcodeDesktopExecutableError extends Error {
  constructor(public readonly code: "ZCODE_DESKTOP_EXECUTABLE_NOT_FOUND" | "ZCODE_DESKTOP_EXECUTABLE_OVERRIDE_INVALID", message: string) {
    super(message);
  }
}

/**
 * Bounded discovery of the ZCode Desktop executable: explicit override,
 * then standard installation locations, then the installed proxy metadata
 * (a registration points at <install>\resources\glm\zcode.cjs).
 */
export function resolveZcodeDesktopExecutable(options: {
  env?: NodeJS.ProcessEnv;
  registrationsDir?: string;
  isFile?: (p: string) => boolean;
} = {}): string {
  const env = options.env ?? process.env;
  const isFile = options.isFile ?? isRegularFile;
  const override = env.C2C_ZCODE_DESKTOP_EXECUTABLE;
  if (override !== undefined) {
    if (!override || !path.isAbsolute(override) || !isFile(override) ||
        (process.platform === "win32" && path.extname(override).toLowerCase() !== ".exe")) {
      throw new ZcodeDesktopExecutableError(
        "ZCODE_DESKTOP_EXECUTABLE_OVERRIDE_INVALID",
        "C2C_ZCODE_DESKTOP_EXECUTABLE must reference an absolute existing native executable file",
      );
    }
    return path.normalize(override);
  }
  const candidates: string[] = [];
  const localAppData = env.LOCALAPPDATA;
  if (localAppData) candidates.push(path.join(localAppData, "Programs", "ZCode", "ZCode.exe"));
  if (env.ProgramFiles) candidates.push(path.join(env.ProgramFiles, "ZCode", "ZCode.exe"));
  if (env["ProgramFiles(x86)"]) candidates.push(path.join(env["ProgramFiles(x86)"], "ZCode", "ZCode.exe"));
  // Existing installed executable metadata: the proxy records the bundled CLI
  // it was started with; the Desktop root sits three levels above it.
  const dir = options.registrationsDir ?? desktopAgentsDir(env);
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!file.startsWith("agent-") || !file.endsWith(".json")) continue;
      try {
        const reg = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as { zcodeCli?: string };
        if (typeof reg.zcodeCli === "string" && reg.zcodeCli) {
          const root = path.dirname(path.dirname(path.dirname(path.resolve(reg.zcodeCli))));
          if (path.basename(root).toLowerCase() === "zcode") {
            candidates.push(path.join(root, "ZCode.exe"));
          }
        }
      } catch { /* unreadable registration is not metadata */ }
    }
  } catch { /* no registrations dir */ }
  for (const candidate of candidates) {
    if (isFile(candidate)) return path.normalize(candidate);
  }
  throw new ZcodeDesktopExecutableError(
    "ZCODE_DESKTOP_EXECUTABLE_NOT_FOUND",
    "ZCode Desktop executable not found in standard locations; set C2C_ZCODE_DESKTOP_EXECUTABLE",
  );
}

// ── Managed ZCode Desktop reconciliation ────────────────────────────────────

export interface ZcodeDesktopOwnershipRecord {
  schema: 1;
  /** Safe metadata only: never credentials. */
  managed: true;
  pid: number;
  /** OS process-creation identity captured after spawn; guards against PID reuse. */
  processStartIdentity: string | null;
  startedAt: string;
  generation: string;
  workspace: string;
  workspaceId: string;
  executablePath: string;
  executablePathHash: string;
}

export interface ZcodeDesktopObservation {
  state: ProviderReadinessState;
  detail?: string;
  managed: boolean | null;
  desktopPid: number | null;
  registrationLive: boolean;
  /** Present only when launching is the correct next action (idempotent, bounded). */
  launch?: () => Promise<string>;
}

export interface ZcodeDesktopReconcilerDeps {
  workspaceRoot: string;
  stateDir: string;
  z2cRepoRoot: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  spawnDetached?: (cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) => { pid?: number } | void;
  processInspector?: () => BridgeProcessInspector | null;
  registrationsDir?: string;
  ownershipFile?: string;
  /** How long a launch waits for the fresh registration before yielding back to reconciliation. */
  registrationWaitMs?: number;
}

const MANAGED_START_GRACE_MS = 90_000;

function readRegistration(file: string): { pid: number; workspace: string } | null {
  try {
    const reg = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown; workspace?: unknown };
    if (typeof reg.pid !== "number" || typeof reg.workspace !== "string") return null;
    return { pid: reg.pid, workspace: reg.workspace };
  } catch {
    return null;
  }
}

export class ZcodeDesktopReconciler {
  private readonly deps: Required<Pick<ZcodeDesktopReconcilerDeps, "workspaceRoot" | "stateDir" | "z2cRepoRoot" | "now" | "sleep" | "registrationWaitMs">> & ZcodeDesktopReconcilerDeps;

  constructor(deps: ZcodeDesktopReconcilerDeps) {
    this.deps = {
      env: process.env,
      now: () => new Date(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      registrationWaitMs: 20_000,
      ...deps,
    };
  }

  private regPath(): string {
    if (this.deps.registrationsDir) {
      return path.join(this.deps.registrationsDir, path.basename(registrationPathFor(this.deps.workspaceRoot, this.deps.env)));
    }
    return registrationPathFor(this.deps.workspaceRoot, this.deps.env);
  }

  private ownershipFile(): string {
    return this.deps.ownershipFile ?? path.join(this.deps.stateDir, "supervisor", "zcode-desktop.json");
  }

  private inspector(): BridgeProcessInspector | null {
    if (this.deps.processInspector) return this.deps.processInspector();
    try {
      return getSystemProcessInspector();
    } catch {
      return null;
    }
  }

  private readRecord(): ZcodeDesktopOwnershipRecord | null {
    try {
      const rec = JSON.parse(fs.readFileSync(this.ownershipFile(), "utf8")) as ZcodeDesktopOwnershipRecord;
      if (rec.schema !== 1 || rec.managed !== true || typeof rec.pid !== "number") return null;
      if (!samePath(rec.workspace, this.deps.workspaceRoot)) return null;
      return rec;
    } catch {
      return null;
    }
  }

  /** Liveness of the recorded managed instance with PID-reuse protection. */
  private recordLive(rec: ZcodeDesktopOwnershipRecord, rows: ReturnType<BridgeProcessInspector["list"]>): boolean {
    if (!pidAlive(rec.pid)) return false;
    const row = rows?.find(r => r.pid === rec.pid);
    if (!row) return rows === null || rows === undefined; // inspector unavailable: pid liveness only
    if (rec.processStartIdentity) return row.processStartIdentity === rec.processStartIdentity;
    return samePath(row.executable, rec.executablePath);
  }

  private desktopPids(resolvedExe: string, rows: ReturnType<BridgeProcessInspector["list"]>): number[] {
    if (!rows) return [];
    return rows.filter(r => samePath(r.executable, resolvedExe)).map(r => r.pid);
  }

  /** Observe desired vs actual state. Side-effect free. */
  observe(): ZcodeDesktopObservation {
    const env = this.deps.env;
    let resolvedExe: string;
    try {
      resolvedExe = resolveZcodeDesktopExecutable({ env, registrationsDir: this.deps.registrationsDir });
    } catch (error) {
      const code = error instanceof ZcodeDesktopExecutableError ? error.code : "ZCODE_DESKTOP_EXECUTABLE_NOT_FOUND";
      return {
        state: code === "ZCODE_DESKTOP_EXECUTABLE_OVERRIDE_INVALID"
          ? "ZCODE_DESKTOP_EXECUTABLE_OVERRIDE_INVALID"
          : "ZCODE_DESKTOP_EXECUTABLE_NOT_FOUND",
        detail: error instanceof Error ? error.message : String(error),
        managed: null,
        desktopPid: null,
        registrationLive: false,
      };
    }

    const reg = readRegistration(this.regPath());
    const workspaceMatches = reg ? samePath(reg.workspace, this.deps.workspaceRoot) : false;
    if (reg && workspaceMatches && pidAlive(reg.pid)) {
      const rows = this.inspector()?.list() ?? null;
      const rec = this.readRecord();
      const pids = this.desktopPids(resolvedExe, rows);
      return {
        state: "READY",
        managed: rec ? (this.recordLive(rec, rows) || null) : null,
        desktopPid: pids[0] ?? reg.pid,
        registrationLive: true,
      };
    }

    const rows = this.inspector()?.list() ?? null;
    const rec = this.readRecord();
    const recAlive = rec ? this.recordLive(rec, rows) : false;
    if (recAlive && rec) {
      const ageMs = this.deps.now().getTime() - Date.parse(rec.startedAt);
      if (ageMs < MANAGED_START_GRACE_MS) {
        return {
          state: "RECOVERING",
          detail: `managed ZCode Desktop starting (pid ${rec.pid}); waiting for registration`,
          managed: true,
          desktopPid: rec.pid,
          registrationLive: false,
        };
      }
      return {
        state: "ZCODE_DESKTOP_MANAGED_NOT_REGISTERED",
        detail: `managed ZCode Desktop (pid ${rec.pid}) produced no registration; manual managed restart required`,
        managed: true,
        desktopPid: rec.pid,
        registrationLive: false,
      };
    }

    const pids = this.desktopPids(resolvedExe, rows);
    if (pids.length > 0) {
      return {
        state: "ZCODE_DESKTOP_UNMANAGED",
        detail: `ZCode Desktop is running without the managed proxy (pids: ${pids.join(", ")}); manual managed restart required`,
        managed: false,
        desktopPid: pids[0],
        registrationLive: false,
      };
    }

    const detail = reg && !workspaceMatches
      ? `registration exists for a different workspace; managed launch required for this workspace`
      : reg
        ? "stale desktop-agent registration (pid dead); managed launch required"
        : "no live desktop-agent registration and no ZCode Desktop process";
    return {
      state: "ZCODE_DESKTOP_ABSENT",
      detail,
      managed: null,
      desktopPid: null,
      registrationLive: false,
      launch: () => this.launchManagedDesktop(),
    };
  }

  /**
   * Deterministic managed launch. Idempotent: re-checks registration and
   * Desktop presence before spawning, injects the proxy environment via a
   * direct (shell-less) spawn with no credentials on the command line,
   * persists safe ownership metadata, then waits a bounded time for the fresh
   * registration. Never kills anything.
   */
  async launchManagedDesktop(): Promise<string> {
    // Idempotency re-check: a concurrent tick or takeover may have acted first.
    const current = this.observe();
    if (current.state === "READY") return "registration already live; no launch";
    if (current.state === "RECOVERING" || current.state === "ZCODE_DESKTOP_MANAGED_NOT_REGISTERED") {
      return `managed Desktop already running (pid ${current.desktopPid}); no launch`;
    }
    if (current.state === "ZCODE_DESKTOP_UNMANAGED") return "unmanaged ZCode Desktop present; no launch (manual managed restart required)";

    const resolvedExe = resolveZcodeDesktopExecutable({ env: this.deps.env, registrationsDir: this.deps.registrationsDir });
    const proxy = path.join(this.deps.z2cRepoRoot, "scripts", "desktop-agent-proxy.mjs");
    if (!isRegularFile(proxy)) return `desktop-agent-proxy missing: ${proxy}`;
    const env: NodeJS.ProcessEnv = {
      ...this.deps.env,
      ZCODE_AGENT_SERVER_COMMAND: process.execPath,
      ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([proxy, "--stdio"]),
    };
    const child = this.deps.spawnDetached
      ? this.deps.spawnDetached(resolvedExe, [], { cwd: this.deps.workspaceRoot, env })
      : this.spawnProduction(resolvedExe, env);
    const pid = child?.pid ?? 0;
    const startedAt = this.deps.now().toISOString();
    this.writeRecord({
      schema: 1,
      managed: true,
      pid,
      processStartIdentity: await this.captureProcessIdentity(pid),
      startedAt,
      generation: randomUUID(),
      workspace: this.deps.workspaceRoot,
      workspaceId: stableWorkspaceId(this.deps.workspaceRoot),
      executablePath: resolvedExe,
      executablePathHash: createHash("sha256").update(resolvedExe.toLowerCase()).digest("hex"),
    });

    // Bounded wait for the fresh registration (fixed step count so injected
    // fake clocks in tests cannot stretch or loop the wait).
    const waitSteps = Math.max(0, Math.round(this.deps.registrationWaitMs / 1_000));
    for (let i = 0; i < waitSteps; i++) {
      await this.deps.sleep(1_000);
      const reg = readRegistration(this.regPath());
      if (reg && samePath(reg.workspace, this.deps.workspaceRoot) && pidAlive(reg.pid)) {
        return `managed ZCode Desktop launched (pid ${pid}); registration live`;
      }
    }
    return `managed ZCode Desktop launched (pid ${pid}); registration not yet live (reconciliation continues)`;
  }

  private spawnProduction(cmd: string, env: NodeJS.ProcessEnv): { pid?: number } {
    const child = spawn(cmd, [], {
      cwd: this.deps.workspaceRoot,
      env,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.unref();
    return { pid: child.pid };
  }

  private async captureProcessIdentity(pid: number): Promise<string | null> {
    if (!pid) return null;
    const inspector = this.inspector();
    if (!inspector) return null;
    for (let i = 0; i < 5; i++) {
      const row = inspector.list()?.find(r => r.pid === pid);
      if (row?.processStartIdentity) return row.processStartIdentity;
      await this.deps.sleep(300);
    }
    return null;
  }

  private writeRecord(record: ZcodeDesktopOwnershipRecord): void {
    const file = this.ownershipFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}
