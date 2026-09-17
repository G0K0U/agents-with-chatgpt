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
 *   registrations live for every desired workspace   → READY, do nothing
 *   Desktop alive, desired workspace registration    → workspace-open request
 *   missing (workspace closed in the Desktop)          via the Desktop's own
 *                                                      single-instance CLI
 *                                                      (officially supported;
 *                                                      never injects anything)
 *   unmanaged Desktop (no C2C proxy env), no usable  → ONE graceful
 *     registration                                     application-level close
 *                                                      (WM_CLOSE, never force
 *                                                      kill): exits → managed
 *                                                      relaunch; refuses (e.g.
 *                                                      unsaved work) →
 *                                                      USER_ACTION_REQUIRED_UNSAVED_STATE
 *   supervisor-owned Desktop alive, no registration  → wait while young, then
 *                                                      bounded workspace-open
 *                                                      request (no auto-kill)
 */

export type ProviderBootstrapStrategy = "on-demand" | "managed-persistent";

export type ProviderReadinessState =
  | "READY"
  | "READY_ON_DEMAND"
  | "DISABLED"
  | "EXECUTABLE_MISSING"
  | "ZCODE_DESKTOP_ABSENT"
  | "ZCODE_DESKTOP_UNMANAGED"
  | "ZCODE_DESKTOP_MANAGED_NOT_REGISTERED"
  | "ZCODE_DESKTOP_EXECUTABLE_NOT_FOUND"
  | "ZCODE_DESKTOP_EXECUTABLE_OVERRIDE_INVALID"
  | "ZCODE_WORKSPACE_NOT_OPEN"
  | "USER_ACTION_REQUIRED_UNSAVED_STATE"
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

/**
 * Production graceful close: Windows `taskkill` WITHOUT /F posts WM_CLOSE to
 * the process's windows, so the Desktop runs its normal close path (including
 * unsaved-work prompts) and simply keeps running when the user/work refuses.
 * POSIX sends SIGTERM. Returns true only when the process actually exited
 * within the bounded wait; a refusal is honored, never escalated to a kill.
 */
async function gracefulCloseProduction(
  pid: number,
  sleep: (ms: number) => Promise<void>,
  restartWaitMs: number,
): Promise<boolean> {
  if (!pid || pid <= 0) return false;
  let exited = !pidAlive(pid);
  if (!exited) {
    const child = spawn(
      process.platform === "win32" ? "taskkill" : "kill",
      process.platform === "win32" ? ["/PID", String(pid)] : [String(pid)],
      { stdio: "ignore", windowsHide: true },
    );
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
  }
  const steps = Math.max(1, Math.round(restartWaitMs / 1_000));
  for (let i = 0; i < steps && !exited; i++) {
    await sleep(1_000);
    exited = !pidAlive(pid);
  }
  return exited;
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
  /** Desired workspaces whose desktop-agent registration is not live. */
  missingWorkspaceRoots: string[];
  /** Present only when launching is the correct next action (idempotent, bounded). */
  launch?: () => Promise<string>;
  /** Present when the Desktop just needs desired workspaces opened in it (official argv redirect). */
  openWorkspaces?: () => Promise<string>;
  /** Present when the unmanaged Desktop may be gracefully closed and relaunched managed. */
  managedRestart?: () => Promise<string>;
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
  /**
   * Additional workspace roots (besides workspaceRoot) whose desktop-agent
   * registrations are desired state — e.g. the Engineering AI product
   * workspace hosting the governed ZCode queue. Registration liveness for
   * every desired root is required before the Desktop lane reports READY.
   */
  desiredWorkspaceRoots?: string[];
  /** How long a workspace-open request waits for the fresh registration. */
  openWaitMs?: number;
  /** How long a graceful close wait may hold before declaring refusal. */
  restartWaitMs?: number;
  /** Test seam: request a graceful window close; true when the process exited. */
  gracefulClose?: (pid: number) => Promise<boolean>;
}

const MANAGED_START_GRACE_MS = 90_000;
/** Refusal evidence (possible unsaved work) is honored for this long after a graceful close attempt. */
const RESTART_REFUSAL_TTL_MS = 6 * 60 * 60_000;

/** Safe metadata about one graceful-close attempt of an unmanaged Desktop (never credentials). */
export interface ZcodeDesktopRestartRecord {
  schema: 1;
  pid: number;
  processStartIdentity: string | null;
  at: string;
  outcome: "closed" | "refused";
}

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
  private readonly deps: Required<Pick<ZcodeDesktopReconcilerDeps, "workspaceRoot" | "stateDir" | "z2cRepoRoot" | "now" | "sleep" | "registrationWaitMs" | "openWaitMs" | "restartWaitMs">> & ZcodeDesktopReconcilerDeps;

  constructor(deps: ZcodeDesktopReconcilerDeps) {
    this.deps = {
      env: process.env,
      now: () => new Date(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      registrationWaitMs: 20_000,
      openWaitMs: 30_000,
      restartWaitMs: 45_000,
      ...deps,
    };
  }

  private regPath(): string {
    if (this.deps.registrationsDir) {
      return path.join(this.deps.registrationsDir, path.basename(registrationPathFor(this.deps.workspaceRoot, this.deps.env)));
    }
    return registrationPathFor(this.deps.workspaceRoot, this.deps.env);
  }

  private regPathForRoot(root: string): string {
    if (this.deps.registrationsDir) {
      return path.join(this.deps.registrationsDir, path.basename(registrationPathFor(root, this.deps.env)));
    }
    return registrationPathFor(root, this.deps.env);
  }

  /** All workspace roots whose registrations are desired state, primary first, deduplicated. */
  private desiredRoots(): string[] {
    const roots = [this.deps.workspaceRoot, ...(this.deps.desiredWorkspaceRoots ?? [])];
    const seen = new Set<string>();
    for (const root of roots) {
      const key = path.normalize(root).toLowerCase();
      if (!seen.has(key)) seen.add(key);
    }
    return [...seen.keys()].map((key) => roots.find((r) => path.normalize(r).toLowerCase() === key)!);
  }

  private ownershipFile(): string {
    return this.deps.ownershipFile ?? path.join(this.deps.stateDir, "supervisor", "zcode-desktop.json");
  }

  private restartRecordFile(): string {
    return path.join(this.deps.stateDir, "supervisor", "zcode-desktop-restart.json");
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
    const mine = rows.filter(r => samePath(r.executable, resolvedExe));
    if (mine.length === 0) return [];
    // Electron-style multi-process install. The GUI main (browser) process is
    // the one launched with the bare executable path: helpers carry
    // `--type=...`, and the Desktop's own windowless agent children carry the
    // agent/app-server arguments — only the true main's command line is the
    // executable alone. Lifecycle actions (graceful close) must address that
    // process; children have no window and would ignore WM_CLOSE.
    const mains = mine.filter(r => {
      const bare = (r.commandLine ?? "").trim().replace(/^"(.*)"$/s, "$1").trim();
      return bare.length > 0 && samePath(bare, resolvedExe);
    });
    if (mains.length > 0) return mains.map(r => r.pid);
    return mine.map(r => r.pid);
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
        missingWorkspaceRoots: [],
      };
    }

    const roots = this.desiredRoots();
    const rootStates = roots.map((root) => {
      const reg = readRegistration(this.regPathForRoot(root));
      return {
        root,
        live: Boolean(reg && samePath(reg.workspace, root) && pidAlive(reg.pid)),
        reg,
      };
    });
    const missingRoots = rootStates.filter((entry) => !entry.live).map((entry) => entry.root);
    if (missingRoots.length === 0) {
      const primary = rootStates[0];
      const rows = this.inspector()?.list() ?? null;
      const rec = this.readRecord();
      const pids = this.desktopPids(resolvedExe, rows);
      return {
        state: "READY",
        managed: rec ? (this.recordLive(rec, rows) || null) : null,
        desktopPid: pids[0] ?? primary.reg!.pid,
        registrationLive: true,
        missingWorkspaceRoots: [],
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
          missingWorkspaceRoots: missingRoots,
        };
      }
    }
    // A live registration proves a Desktop is hosting it. Missing desired
    // workspaces then mean the Desktop just has them closed: the official
    // single-instance open request is the correct, non-destructive recovery —
    // never a relaunch (that could duplicate the Desktop), never a kill.
    if (rootStates.some((entry) => entry.live)) {
      return {
        state: "ZCODE_WORKSPACE_NOT_OPEN",
        detail: `ZCode Desktop is running with live registrations but lacks them for: ${missingRoots.join(", ")}`,
        managed: recAlive && rec ? true : null,
        desktopPid: recAlive && rec ? rec.pid : (rootStates.find((entry) => entry.live)!.reg!.pid),
        registrationLive: false,
        missingWorkspaceRoots: missingRoots,
        openWorkspaces: () => this.requestWorkspaceOpen(missingRoots),
      };
    }
    if (recAlive && rec) {
      // Managed but no desired workspace is registered: same official open
      // request recovery while the Desktop is alive.
      return {
        state: "ZCODE_DESKTOP_MANAGED_NOT_REGISTERED",
        detail: `managed ZCode Desktop (pid ${rec.pid}) is alive without live registrations for: ${missingRoots.join(", ")}`,
        managed: true,
        desktopPid: rec.pid,
        registrationLive: false,
        missingWorkspaceRoots: missingRoots,
        openWorkspaces: () => this.requestWorkspaceOpen(missingRoots),
      };
    }

    const pids = this.desktopPids(resolvedExe, rows);
    if (pids.length > 0) {
      const refusal = this.readRestartRefusal(pids[0], rows);
      if (refusal) {
        return {
          state: "USER_ACTION_REQUIRED_UNSAVED_STATE",
          detail: `unmanaged ZCode Desktop (pid ${pids[0]}) declined a graceful close (possible unsaved user work); operator action required to relaunch it with the C2C agent proxy`,
          managed: false,
          desktopPid: pids[0],
          registrationLive: false,
          missingWorkspaceRoots: missingRoots,
        };
      }
      return {
        state: "ZCODE_DESKTOP_UNMANAGED",
        detail: `ZCode Desktop is running without the managed proxy (pids: ${pids.join(", ")}); one graceful close + managed relaunch is pending`,
        managed: false,
        desktopPid: pids[0],
        registrationLive: false,
        missingWorkspaceRoots: missingRoots,
        managedRestart: () => this.attemptManagedRestart(pids[0], rows),
      };
    }

    const primaryReg = rootStates[0].reg;
    const detail = primaryReg && !samePath(primaryReg.workspace, this.deps.workspaceRoot)
      ? `registration exists for a different workspace; managed launch required for this workspace`
      : primaryReg
        ? "stale desktop-agent registration (pid dead); managed launch required"
        : "no live desktop-agent registration and no ZCode Desktop process";
    return {
      state: "ZCODE_DESKTOP_ABSENT",
      detail,
      managed: null,
      desktopPid: null,
      registrationLive: false,
      missingWorkspaceRoots: missingRoots,
      launch: () => this.launchManagedDesktop(),
    };
  }

  /**
   * Deterministic managed launch. Idempotent: re-checks registration and
   * Desktop presence before spawning, injects the proxy environment via a
   * direct (shell-less) spawn with no credentials on the command line,
   * persists safe ownership metadata, then waits a bounded time for the fresh
   * registration. The workspace path is passed as the official CLI argument
   * (and cwd) so the Desktop opens it on first launch. Never kills anything.
   */
  async launchManagedDesktop(): Promise<string> {
    // Idempotency re-check: a concurrent tick or takeover may have acted first.
    const current = this.observe();
    if (current.state === "READY") return "registration already live; no launch";
    if (current.state === "RECOVERING" || current.state === "ZCODE_DESKTOP_MANAGED_NOT_REGISTERED" || current.state === "ZCODE_WORKSPACE_NOT_OPEN") {
      return `managed Desktop already running (pid ${current.desktopPid}); no launch`;
    }
    if (current.state === "ZCODE_DESKTOP_UNMANAGED") return "unmanaged ZCode Desktop present; graceful managed restart required before any launch";
    if (current.state === "USER_ACTION_REQUIRED_UNSAVED_STATE") return "unmanaged ZCode Desktop refused a graceful close; operator action required";

    const resolvedExe = resolveZcodeDesktopExecutable({ env: this.deps.env, registrationsDir: this.deps.registrationsDir });
    const proxy = path.join(this.deps.z2cRepoRoot, "scripts", "desktop-agent-proxy.mjs");
    if (!isRegularFile(proxy)) return `desktop-agent-proxy missing: ${proxy}`;
    const env: NodeJS.ProcessEnv = {
      ...this.deps.env,
      ZCODE_AGENT_SERVER_COMMAND: process.execPath,
      ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([proxy, "--stdio"]),
    };
    const child = this.deps.spawnDetached
      ? this.deps.spawnDetached(resolvedExe, ["--open-workspace", this.deps.workspaceRoot], { cwd: this.deps.workspaceRoot, env })
      : this.spawnProduction(resolvedExe, env, this.deps.workspaceRoot);
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
        await this.ensureDesiredWorkspaceRegistrations();
        return `managed ZCode Desktop launched (pid ${pid}); registration live`;
      }
    }
    // The Desktop may ignore argv on first launch (session restore instead):
    // request any still-missing desired workspace through the same official
    // single-instance open path, then yield back to reconciliation.
    await this.ensureDesiredWorkspaceRegistrations();
    const live = readRegistration(this.regPath());
    if (live && samePath(live.workspace, this.deps.workspaceRoot) && pidAlive(live.pid)) {
      return `managed ZCode Desktop launched (pid ${pid}); registration live`;
    }
    return `managed ZCode Desktop launched (pid ${pid}); registration not yet live (reconciliation continues)`;
  }

  /**
   * Open every desired workspace whose registration is still missing by
   * spawning the Desktop executable with the workspace path as its argument —
   * the officially supported single-instance workspace-open request. Bounded
   * wait for the fresh registrations; reconciliation continues on later ticks.
   */
  async requestWorkspaceOpen(roots?: string[]): Promise<string> {
    const resolvedExe = resolveZcodeDesktopExecutable({ env: this.deps.env, registrationsDir: this.deps.registrationsDir });
    const proxy = path.join(this.deps.z2cRepoRoot, "scripts", "desktop-agent-proxy.mjs");
    if (!isRegularFile(proxy)) return `desktop-agent-proxy missing: ${proxy}`;
    const rows = this.inspector()?.list() ?? null;
    const targetRoots = roots ?? this.desiredRoots();
    // No live Desktop process to redirect into: an open request would START a
    // fresh unmanaged instance. Report instead — the launch path owns that
    // case (this method never recurses into launchManagedDesktop).
    if (!rows || this.desktopPids(resolvedExe, rows).length === 0) {
      return "no running ZCode Desktop to receive the workspace open request; managed launch required";
    }
    // The proxy env makes the open request productive even when the running
    // instance happens to be fresh (its agent spawns then register); for the
    // redirect path itself the running Desktop's own env decides.
    const env: NodeJS.ProcessEnv = {
      ...this.deps.env,
      ZCODE_AGENT_SERVER_COMMAND: process.execPath,
      ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([proxy, "--stdio"]),
    };
    for (const root of targetRoots) {
      this.deps.spawnDetached
        ? this.deps.spawnDetached(resolvedExe, ["--open-workspace", root], { cwd: root, env })
        : this.spawnProduction(resolvedExe, env, root);
    }
    const waitSteps = Math.max(0, Math.round(this.deps.openWaitMs / 1_000));
    for (let i = 0; i < waitSteps; i++) {
      await this.deps.sleep(1_000);
      if (targetRoots.every((root) => {
        const reg = readRegistration(this.regPathForRoot(root));
        return reg && samePath(reg.workspace, root) && pidAlive(reg.pid);
      })) {
        return `workspace open request accepted; registrations live for: ${targetRoots.join(", ")}`;
      }
    }
    return `workspace open request sent for: ${targetRoots.join(", ")}; registrations not yet live (reconciliation continues)`;
  }

  /** Open desired workspaces that still lack a live registration (best effort). */
  private async ensureDesiredWorkspaceRegistrations(): Promise<void> {
    const missing = this.desiredRoots().filter((root) => {
      const reg = readRegistration(this.regPathForRoot(root));
      return !(reg && samePath(reg.workspace, root) && pidAlive(reg.pid));
    });
    if (missing.length === 0) return;
    try {
      await this.requestWorkspaceOpen(missing);
    } catch {
      // Reconciliation retries on the next tick; a failed open request must
      // not fail the launch itself.
    }
  }

  private readRestartRecords(): ZcodeDesktopRestartRecord | null {
    try {
      const rec = JSON.parse(fs.readFileSync(this.restartRecordFile(), "utf8")) as ZcodeDesktopRestartRecord;
      if (rec.schema !== 1 || typeof rec.pid !== "number" || typeof rec.at !== "string") return null;
      return rec;
    } catch {
      return null;
    }
  }

  /** A prior graceful close that this exact Desktop generation refused. */
  private readRestartRefusal(pid: number, rows: ReturnType<BridgeProcessInspector["list"]>): boolean {
    const rec = this.readRestartRecords();
    if (!rec || rec.pid !== pid || rec.outcome !== "refused") return false;
    const age = this.deps.now().getTime() - Date.parse(rec.at);
    if (age > RESTART_REFUSAL_TTL_MS) return false;
    if (rec.processStartIdentity) {
      const row = rows?.find((r) => r.pid === pid);
      return row ? row.processStartIdentity === rec.processStartIdentity : true;
    }
    return true;
  }

  /**
   * ONE safe application-level recovery of an unmanaged Desktop: request a
   * graceful window close (WM_CLOSE; the app keeps running and can prompt for
   * unsaved work), wait bounded, and only when the process actually exited
   * perform the managed relaunch. A process that does not exit is honored as
   * a refusal (possible unsaved user work): recorded, never force-killed, and
   * surfaced as USER_ACTION_REQUIRED_UNSAVED_STATE. One attempt per Desktop
   * generation (pid + process-start identity).
   */
  async attemptManagedRestart(pid: number, rows?: ReturnType<BridgeProcessInspector["list"]> | null): Promise<string> {
    let identity: string | null = null;
    if (rows) identity = rows.find((r) => r.pid === pid)?.processStartIdentity ?? null;
    if (!identity) identity = await this.captureProcessIdentity(pid);
    const prior = this.readRestartRecords();
    if (prior && prior.pid === pid && (prior.processStartIdentity ?? null) === (identity ?? null)) {
      return prior.outcome === "refused"
        ? "graceful close already refused by this Desktop; operator action required"
        : "graceful close already attempted for this Desktop";
    }

    const exited = await this.gracefulClose(pid);
    this.writeRestartRecord({ schema: 1, pid, processStartIdentity: identity, at: this.deps.now().toISOString(), outcome: exited ? "closed" : "refused" });
    if (!exited) {
      return `unmanaged ZCode Desktop (pid ${pid}) did not close gracefully (possible unsaved work); no force kill was attempted — operator action required`;
    }

    // Give the exiting instance a moment to release the single-instance lock,
    // then relaunch managed with the proxy environment.
    const settleSteps = 5;
    for (let i = 0; i < settleSteps; i++) {
      await this.deps.sleep(1_000);
      const rowsNow = this.inspector()?.list() ?? null;
      const resolvedExe = this.resolveExeOrNull();
      if (!resolvedExe || !rowsNow || this.desktopPids(resolvedExe, rowsNow).length === 0) break;
    }
    return this.launchManagedDesktop();
  }

  private resolveExeOrNull(): string | null {
    try {
      return resolveZcodeDesktopExecutable({ env: this.deps.env, registrationsDir: this.deps.registrationsDir });
    } catch {
      return null;
    }
  }

  private gracefulClose(pid: number): Promise<boolean> {
    if (this.deps.gracefulClose) return this.deps.gracefulClose(pid);
    return gracefulCloseProduction(pid, this.deps.sleep, this.deps.restartWaitMs);
  }

  private writeRestartRecord(record: ZcodeDesktopRestartRecord): void {
    const file = this.restartRecordFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  private spawnProduction(cmd: string, env: NodeJS.ProcessEnv, workspaceRoot: string): { pid?: number } {
    const child = spawn(cmd, ["--open-workspace", workspaceRoot], {
      cwd: workspaceRoot,
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
