import fs from "node:fs";
import path from "node:path";
import { getSystemProcessInspector, type BridgeProcessInspector, type BridgeProcessIdentity } from "../bridge/runtime.js";
import { installationRoot } from "../bridge/runtime-identity.js";
import { getStateDir } from "../config/paths.js";
import type { ComponentState, RecoveryLogEntry, SupervisorSnapshot } from "./supervisor.js";

export interface SupervisorLockRecord {
  pid: number;
  identity: string;
  acquiredAt: string;
  processStartIdentity?: string | null;
  workspaceRoot?: string;
  stateDir?: string;
  executable?: string;
  entry?: string;
}

export interface SupervisorObservation {
  ok: boolean;
  running: boolean | null;
  state: "running" | "stopped" | "stale" | "unknown" | "absent";
  pid: number | null;
  processStartIdentity?: string | null;
  processStatus: "same" | "dead" | "reused" | "unknown" | "absent" | "legacy_ambiguous" | "unrelated";
  processReason?: string;
  heartbeatAgeMs: number | null;
  heartbeatStale: boolean;
  overall: ComponentState;
  snapshot: SupervisorSnapshot | null;
  lock: SupervisorLockRecord | null;
  detail?: string;
}

export interface SupervisorStopResult {
  ok: boolean;
  stopped: boolean;
  pid?: number;
  reason?: string;
}

function sameLockGeneration(left: SupervisorLockRecord, right: SupervisorLockRecord): boolean {
  return left.pid === right.pid && left.identity === right.identity &&
    left.processStartIdentity === right.processStartIdentity && left.executable === right.executable &&
    left.entry === right.entry && left.stateDir === right.stateDir && left.workspaceRoot === right.workspaceRoot;
}

function equalPath(a: string, b: string): boolean {
  return process.platform === "win32" || process.platform === "darwin"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function tokenizeCommandLine(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  for (let index = 0; index < commandLine.length; index += 1) {
    const char = commandLine[index];
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && commandLine[index + 1] === quote) {
        current += commandLine[index + 1];
        index += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function optionValue(tokens: readonly string[], option: string): string | null {
  const inline = tokens.find((token) => token.startsWith(`${option}=`));
  if (inline) return inline.slice(option.length + 1);
  const index = tokens.indexOf(option);
  return index >= 0 ? tokens[index + 1] ?? null : null;
}

export function validateCanonicalStateFile(filePath: string): { ok: boolean; path: string; error?: string } {
  try {
    if (!path.isAbsolute(filePath)) {
      return { ok: false, path: filePath, error: "Path must be absolute" };
    }
    if (!fs.existsSync(filePath)) {
      return { ok: false, path: filePath, error: "File does not exist" };
    }
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { ok: false, path: filePath, error: "File must be a regular non-symlink file" };
    }
    if (stat.size > 1_048_576) {
      return { ok: false, path: filePath, error: "File size exceeds limit (1MB)" };
    }
    const real = fs.realpathSync.native(filePath);
    if (!equalPath(real, filePath)) {
      return { ok: false, path: filePath, error: "File path contains symlink or reparse point" };
    }
    return { ok: true, path: real };
  } catch (err) {
    return { ok: false, path: filePath, error: err instanceof Error ? err.message : String(err) };
  }
}

export function readSupervisorLock(stateDir: string): { exists: boolean; lock: SupervisorLockRecord | null; error?: string } {
  const file = path.join(stateDir, "supervisor", "supervisor.lock");
  if (!fs.existsSync(file)) {
    return { exists: false, lock: null };
  }
  const valid = validateCanonicalStateFile(file);
  if (!valid.ok) {
    return { exists: true, lock: null, error: valid.error };
  }
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { exists: true, lock: null, error: "Malformed lock content: not an object" };
    }
    const pid = parsed.pid;
    if (!Number.isInteger(pid) || (pid as number) <= 0) {
      return { exists: true, lock: null, error: `Invalid lock PID: ${String(pid)}` };
    }
    if (typeof parsed.identity !== "string" || !parsed.identity) {
      return { exists: true, lock: null, error: "Invalid lock identity" };
    }
    const lock: SupervisorLockRecord = {
      pid: Number(pid),
      identity: String(parsed.identity),
      acquiredAt: typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : new Date(0).toISOString(),
      ...(typeof parsed.processStartIdentity === "string" ? { processStartIdentity: parsed.processStartIdentity } : {}),
      ...(typeof parsed.workspaceRoot === "string" ? { workspaceRoot: parsed.workspaceRoot } : {}),
      ...(typeof parsed.stateDir === "string" ? { stateDir: parsed.stateDir } : {}),
      ...(typeof parsed.executable === "string" ? { executable: parsed.executable } : {}),
      ...(typeof parsed.entry === "string" ? { entry: parsed.entry } : {}),
    };
    return { exists: true, lock };
  } catch (err) {
    return { exists: true, lock: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export function readSupervisorSnapshot(stateDir: string): { exists: boolean; snapshot: SupervisorSnapshot | null; error?: string } {
  const file = path.join(stateDir, "supervisor", "status.json");
  if (!fs.existsSync(file)) {
    return { exists: false, snapshot: null };
  }
  const valid = validateCanonicalStateFile(file);
  if (!valid.ok) {
    return { exists: true, snapshot: null, error: valid.error };
  }
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<SupervisorSnapshot>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { exists: true, snapshot: null, error: "Malformed snapshot content: not an object" };
    }
    if (!Number.isInteger(parsed.pid) || (parsed.pid as number) <= 0) {
      return { exists: true, snapshot: null, error: `Invalid snapshot PID: ${String(parsed.pid)}` };
    }
    if (!parsed.overall || typeof parsed.overall !== "string") {
      return { exists: true, snapshot: null, error: "Invalid snapshot overall state" };
    }
    // Older snapshots predate recoveryLog. Keep their valid status while giving
    // callers the same required shape as a current snapshot. A present but
    // malformed history is corrupt state, not a reason to silently erase it.
    const recoveryLog: RecoveryLogEntry[] = parsed.recoveryLog === undefined ? [] : parsed.recoveryLog;
    if (!Array.isArray(recoveryLog) || recoveryLog.some((entry) =>
      !entry || typeof entry.at !== "string" || typeof entry.component !== "string"
      || typeof entry.action !== "string" || typeof entry.outcome !== "string")) {
      return { exists: true, snapshot: null, error: "Invalid snapshot recovery log" };
    }
    return { exists: true, snapshot: { ...parsed, recoveryLog } as SupervisorSnapshot };
  } catch (err) {
    return { exists: true, snapshot: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface ProcessInspectionResult {
  status: "same" | "dead" | "reused" | "unknown" | "unrelated" | "legacy_ambiguous";
  processInfo?: BridgeProcessIdentity;
  reason?: string;
}

function trustedSupervisorEntry(entry: string): boolean {
  if (!path.isAbsolute(entry)) return false;
  const root = installationRoot();
  const relative = path.relative(root, entry).replaceAll("\\", "/");
  if (relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) return false;
  if (!["bin/a2c.js", "bin/c2c.js", "dist/cli/index.js", "src/cli/index.ts"].includes(relative)
      && !/^releases\/[^/]+\/cli\/index\.js$/.test(relative)) return false;
  try {
    const stat = fs.lstatSync(entry);
    return stat.isFile() && !stat.isSymbolicLink() && equalPath(fs.realpathSync.native(entry), entry);
  } catch {
    return false;
  }
}

function exactlyOneOption(tokens: readonly string[], option: string): string | null {
  const values: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === option) {
      if (index + 1 >= tokens.length) return null;
      values.push(tokens[++index]);
    } else if (tokens[index].startsWith(`${option}=`)) {
      values.push(tokens[index].slice(option.length + 1));
    }
  }
  return values.length === 1 && values[0].length > 0 ? values[0] : null;
}

export function inspectSupervisorProcess(
  pid: number,
  expected: {
    startIdentity?: string | null;
    stateDir?: string;
    workspaceRoot?: string;
    executable?: string;
    entry?: string;
  },
  inspector: BridgeProcessInspector = getSystemProcessInspector()
): ProcessInspectionResult {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { status: "unrelated", reason: "invalid_pid" };
  }

  let isDeadBySignal = false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      isDeadBySignal = true;
    }
  }

  let rows: readonly BridgeProcessIdentity[] | null = null;
  try {
    rows = inspector.list();
  } catch {
    rows = null;
  }

  if (rows === null) {
    if (isDeadBySignal) return { status: "dead" };
    return { status: "unknown", reason: "process_inventory_unavailable" };
  }

  const row = rows.find((r) => r.pid === pid);
  if (!row) {
    if (isDeadBySignal) return { status: "dead" };
    return { status: "unknown", reason: "process_omitted_from_inventory" };
  }

  // A persisted generation can prove the old instance has ended even when a
  // historical snapshot lacks the lock's executable/entry fields. This check
  // never authorizes signalling the process now occupying the reused PID.
  if (expected.startIdentity && row.processStartIdentity &&
      row.processStartIdentity !== expected.startIdentity) {
    return { status: "reused", processInfo: row, reason: "start_identity_mismatch" };
  }

  // Legacy locks without a complete command binding can be observed, but
  // cannot authorize a signal to an otherwise plausible Node process.
  if (!expected.executable || !expected.entry || !expected.workspaceRoot || !expected.stateDir ||
      !expected.startIdentity || !trustedSupervisorEntry(expected.entry)) {
    return { status: "legacy_ambiguous", processInfo: row, reason: "incomplete_supervisor_identity" };
  }
  if (!row.executable || !row.commandLine) {
    return { status: "unknown", processInfo: row, reason: "process_command_unavailable" };
  }
  if (!equalPath(row.executable, expected.executable)) {
    return { status: "reused", processInfo: row, reason: "executable_mismatch" };
  }

  // The exact trusted entry must immediately precede the command pair.
  // Merely finding the words somewhere in argv would trust arbitrary scripts.
  const tokens = tokenizeCommandLine(row.commandLine);
  const commandIndex = tokens.findIndex((token, index) => token === "supervisor" && tokens[index + 1] === "run");
  if (commandIndex < 2 || !equalPath(path.resolve(tokens[0]), expected.executable) ||
      !equalPath(path.resolve(tokens[commandIndex - 1]), expected.entry)) {
    return { status: "reused", processInfo: row, reason: "command_mismatch" };
  }

  const commandOptions = tokens.slice(commandIndex + 2);
  const cmdWs = exactlyOneOption(commandOptions, "--workspace");
  if (!cmdWs || !path.isAbsolute(cmdWs) || !equalPath(path.resolve(cmdWs), path.resolve(expected.workspaceRoot))) {
    return { status: "unrelated", processInfo: row, reason: "workspace_mismatch" };
  }

  const cmdState = exactlyOneOption(commandOptions, "--state-dir");
  if (!cmdState || !path.isAbsolute(cmdState) || !equalPath(path.resolve(cmdState), path.resolve(expected.stateDir))) {
    return { status: "unrelated", processInfo: row, reason: "state_dir_mismatch" };
  }

  // Verify OS creation identity
  if (!row.processStartIdentity) {
    return { status: "unknown", processInfo: row, reason: "process_start_identity_missing" };
  }
  if (row.processStartIdentity !== expected.startIdentity) {
    return { status: "reused", processInfo: row, reason: "start_identity_mismatch" };
  }
  return { status: "same", processInfo: row };
}

export function observeSupervisorStatus(
  stateDir: string,
  workspaceRoot?: string,
  options?: {
    inspector?: BridgeProcessInspector;
    now?: () => Date;
    heartbeatStaleMs?: number;
  }
): SupervisorObservation {
  const lockResult = readSupervisorLock(stateDir);
  const snapResult = readSupervisorSnapshot(stateDir);

  const lock = lockResult.lock;
  const snapshot = snapResult.snapshot;
  const targetPid = lock?.pid ?? snapshot?.pid ?? null;

  if (!lock && !snapshot) {
    return {
      ok: false,
      running: false,
      state: "absent",
      pid: null,
      processStatus: "absent",
      heartbeatAgeMs: null,
      heartbeatStale: false,
      overall: "OFFLINE",
      snapshot: null,
      lock: null,
      detail: lockResult.error || snapResult.error || "No supervisor lock or status found",
    };
  }

  if (targetPid === null || targetPid <= 0) {
    return {
      ok: false,
      running: null,
      state: "unknown",
      pid: targetPid,
      processStatus: "unrelated",
      heartbeatAgeMs: null,
      heartbeatStale: false,
      overall: "FAILED",
      snapshot,
      lock,
      detail: "Invalid or non-positive PID in state files",
    };
  }

  const inspector = options?.inspector ?? getSystemProcessInspector();
  const expectedStart = lock?.processStartIdentity ?? snapshot?.processStartIdentity;
  const proc = inspectSupervisorProcess(
    targetPid,
    {
      startIdentity: expectedStart,
      stateDir,
      workspaceRoot: workspaceRoot ?? lock?.workspaceRoot,
      executable: lock?.executable,
      entry: lock?.entry,
    },
    inspector
  );

  const nowMs = (options?.now ?? (() => new Date()))().getTime();
  const staleThreshold = options?.heartbeatStaleMs ?? 90_000;

  let heartbeatAgeMs: number | null = null;
  if (snapshot?.lastTickAt) {
    const t = Date.parse(snapshot.lastTickAt);
    if (!Number.isNaN(t)) {
      heartbeatAgeMs = nowMs - t;
    }
  }

  const heartbeatStale = heartbeatAgeMs === null || heartbeatAgeMs > staleThreshold || heartbeatAgeMs < -5_000;

  // Process proved dead
  if (proc.status === "dead") {
    return {
      ok: false,
      running: false,
      state: "stopped",
      pid: targetPid,
      processStartIdentity: expectedStart ?? null,
      processStatus: "dead",
      heartbeatAgeMs,
      heartbeatStale,
      overall: "OFFLINE",
      snapshot,
      lock,
      detail: `Supervisor process (PID ${targetPid}) is dead`,
    };
  }

  // PID reused or unrelated process
  if (proc.status === "reused" || proc.status === "unrelated") {
    return {
      ok: false,
      running: false,
      state: "stopped",
      pid: targetPid,
      processStartIdentity: expectedStart ?? null,
      processStatus: proc.status,
      processReason: proc.reason,
      heartbeatAgeMs,
      heartbeatStale,
      overall: "OFFLINE",
      snapshot,
      lock,
      detail: `Supervisor PID ${targetPid} was reused or belongs to an unrelated process (${proc.reason ?? ""})`,
    };
  }

  // Process identity unknown / missing proof
  if (proc.status === "unknown" || proc.status === "legacy_ambiguous") {
    return {
      ok: false,
      running: null,
      state: "unknown",
      pid: targetPid,
      processStartIdentity: expectedStart ?? null,
      processStatus: proc.status,
      processReason: proc.reason,
      heartbeatAgeMs,
      heartbeatStale,
      overall: "DEGRADED",
      snapshot,
      lock,
      detail: `Supervisor process identity proof unavailable (${proc.reason ?? ""})`,
    };
  }

  const snapshotMatchesLock = Boolean(lock && snapshot && lock.pid === snapshot.pid &&
    lock.identity === snapshot.identity && lock.processStartIdentity === snapshot.processStartIdentity &&
    lock.stateDir && snapshot.stateDir && equalPath(path.resolve(lock.stateDir), path.resolve(snapshot.stateDir)) &&
    lock.workspaceRoot && snapshot.workspaceRoot && equalPath(path.resolve(lock.workspaceRoot), path.resolve(snapshot.workspaceRoot)));
  if (!snapshotMatchesLock) {
    return {
      ok: false, running: null, state: "unknown", pid: targetPid,
      processStartIdentity: expectedStart ?? null, processStatus: "same",
      heartbeatAgeMs, heartbeatStale: true, overall: "DEGRADED", snapshot, lock,
      detail: "Supervisor heartbeat does not match the current lock generation",
    };
  }

  // Process and heartbeat belong to the same verified generation.
  let effectiveOverall: ComponentState = snapshot?.overall ?? "RECOVERING";
  if (heartbeatStale) {
    // Stale heartbeat must degrade / fail, not remain indefinitely RECOVERING or false READY
    effectiveOverall = heartbeatAgeMs !== null && heartbeatAgeMs > 10 * 60_000 ? "FAILED" : "DEGRADED";
  }

  return {
    ok: !heartbeatStale && (effectiveOverall === "READY" || effectiveOverall === "DEGRADED"),
    running: true,
    state: heartbeatStale ? "stale" : "running",
    pid: targetPid,
    processStartIdentity: proc.processInfo?.processStartIdentity ?? expectedStart ?? null,
    processStatus: proc.status,
    heartbeatAgeMs,
    heartbeatStale,
    overall: effectiveOverall,
    snapshot,
    lock,
    detail: heartbeatStale
      ? `Supervisor heartbeat is stale (${Math.round((heartbeatAgeMs ?? 0) / 1000)}s old)`
      : undefined,
  };
}

export async function stopSupervisorProcess(
  stateDir: string,
  workspaceRoot?: string,
  options?: {
    inspector?: BridgeProcessInspector;
    timeoutMs?: number;
    signalProcess?: (pid: number, signal: string | number) => void;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<SupervisorStopResult> {
  const lockResult = readSupervisorLock(stateDir);
  if (!lockResult.exists || !lockResult.lock) {
    // Check if snapshot exists and process is already dead
    const snapResult = readSupervisorSnapshot(stateDir);
    if (snapResult.snapshot) {
      const inspector = options?.inspector ?? getSystemProcessInspector();
      const proc = inspectSupervisorProcess(snapResult.snapshot.pid, {}, inspector);
      if (proc.status === "dead") {
        return { ok: false, stopped: false, pid: snapResult.snapshot.pid, reason: "already_dead" };
      }
    }
    return { ok: false, stopped: false, reason: lockResult.error ?? "absent" };
  }

  const lock = lockResult.lock;
  if (!Number.isInteger(lock.pid) || lock.pid <= 0) {
    return { ok: false, stopped: false, pid: lock.pid, reason: "invalid_pid" };
  }

  const inspector = options?.inspector ?? getSystemProcessInspector();
  const proc = inspectSupervisorProcess(
    lock.pid,
    {
      startIdentity: lock.processStartIdentity,
      stateDir,
      workspaceRoot: workspaceRoot ?? lock.workspaceRoot,
      executable: lock.executable,
      entry: lock.entry,
    },
    inspector
  );

  // If already dead, clean up only same-owned lock if start identity matches
  if (proc.status === "dead") {
    if (lock.processStartIdentity) {
      const lockFile = path.join(stateDir, "supervisor", "supervisor.lock");
      try {
        const recheck = readSupervisorLock(stateDir);
        if (recheck.lock && sameLockGeneration(recheck.lock, lock)) {
          fs.rmSync(lockFile, { force: true });
        }
      } catch { /* best effort */ }
    }
    return { ok: false, stopped: false, pid: lock.pid, reason: "already_dead" };
  }

  // If reused, unrelated, or unknown: NEVER send a signal!
  if (proc.status === "reused") {
    return { ok: false, stopped: false, pid: lock.pid, reason: "reused_pid" };
  }
  if (proc.status === "unrelated") {
    return { ok: false, stopped: false, pid: lock.pid, reason: "unrelated_process" };
  }
  if (proc.status === "unknown") {
    return { ok: false, stopped: false, pid: lock.pid, reason: "process_identity_unavailable" };
  }
  if (proc.status === "legacy_ambiguous") {
    // Legacy ambiguous lock must not be force-killed or blindly unlinked
    return { ok: false, stopped: false, pid: lock.pid, reason: "legacy_ambiguous_lock" };
  }

  // Exact owned process: revalidate lock content and generation immediately before signaling
  const lockFile = path.join(stateDir, "supervisor", "supervisor.lock");
  const preSignalLock = readSupervisorLock(stateDir);
  if (!preSignalLock.lock || !sameLockGeneration(preSignalLock.lock, lock)) {
    return { ok: false, stopped: false, pid: lock.pid, reason: "lock_generation_changed" };
  }
  const preSignalProcess = inspectSupervisorProcess(lock.pid, {
    startIdentity: lock.processStartIdentity,
    stateDir,
    workspaceRoot: workspaceRoot ?? lock.workspaceRoot,
    executable: lock.executable,
    entry: lock.entry,
  }, inspector);
  if (preSignalProcess.status !== "same") {
    return { ok: false, stopped: false, pid: lock.pid, reason: `process_changed_before_signal:${preSignalProcess.status}` };
  }

  // Send signal
  const sendSignal = options?.signalProcess ?? ((p: number, s: string | number) => process.kill(p, s));
  try {
    sendSignal(lock.pid, "SIGTERM");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      // Process exited right before signal
    } else {
      return { ok: false, stopped: false, pid: lock.pid, reason: `signal_failed: ${String(err)}` };
    }
  }

  // Wait for proved exit
  const timeoutMs = options?.timeoutMs ?? 5_000;
  const sleep = options?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  let provedExit = false;

  while (Date.now() < deadline) {
    await sleep(100);
    const check = inspectSupervisorProcess(
      lock.pid,
      { startIdentity: lock.processStartIdentity, stateDir,
        workspaceRoot: workspaceRoot ?? lock.workspaceRoot, executable: lock.executable, entry: lock.entry },
      inspector
    );
    if (check.status === "dead" || check.status === "reused") {
      provedExit = true;
      break;
    }
  }

  if (!provedExit) {
    return { ok: false, stopped: false, pid: lock.pid, reason: "stop_timed_out" };
  }

  // Clear ONLY same-owned lock after proved exit
  try {
    const postExitLock = readSupervisorLock(stateDir);
    if (postExitLock.lock && sameLockGeneration(postExitLock.lock, lock)) {
      fs.rmSync(lockFile, { force: true });
    }
  } catch { /* best effort */ }

  return { ok: true, stopped: true, pid: lock.pid };
}
