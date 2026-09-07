import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ensureDir,
  getDefaultStateDir,
  getStateDir,
  packagedStateDirCandidates,
  readJsonIfExists,
  writeSecureJson,
} from "../config/paths.js";
import { stableWorkspaceId } from "../workspace/identity.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { readStateDomainOwnerStatus } from "./state-owner.js";

/**
 * Runtime state file: how the CLI/Skill finds a running bridge for a
 * workspace. Contains the admin token, so it is 0600 and lives in the user
 * state dir, never in the project.
 */
export interface RuntimeState {
  service: string;
  version: string;
  workspaceId: string;
  workspaceRoot: string;
  pid: number;
  port: number;
  adminToken: string;
  /** False when ownership was recovered without access to the live admin secret. */
  adminTokenKnown?: boolean;
  publicUrl: string | null;
  startedAt: string;
  /** State domain used by this bridge generation, when available. */
  stateDir?: string;
  stateDomainGeneration?: string;
}

export function runtimeFile(workspaceId: string, stateDir?: string): string {
  return path.join(ensureDir(path.join(getStateDir(stateDir), "runtime")), `${workspaceId}.json`);
}

// Recovery may need to inspect a previously validated packaged-domain
// pointer while this process is already frozen to the canonical domain. Keep
// this path read/cleanup-only and do not route it through stateful subsystem
// initialization or directory creation.
function runtimeFileAt(workspaceId: string, stateDir: string): string {
  return path.join(path.resolve(stateDir), "runtime", `${workspaceId}.json`);
}

export function writeRuntimeState(state: RuntimeState, stateDir?: string): void {
  // Never unlink the last authenticated pointer on a Windows rename failure.
  writeSecureJson(runtimeFile(state.workspaceId, state.stateDir ?? stateDir), state, { durable: true });
}

export function readRuntimeState(workspaceId: string, stateDir?: string): RuntimeState | null {
  const value = readJsonIfExists<unknown>(runtimeFile(workspaceId, stateDir));
  return parseRuntimeState(value, workspaceId);
}

/** Read a validated legacy runtime pointer without changing the process domain. */
export function readRuntimeStateAt(workspaceId: string, stateDir: string): RuntimeState | null {
  return parseRuntimeState(readJsonIfExists<unknown>(runtimeFileAt(workspaceId, stateDir)), workspaceId);
}

function parseRuntimeState(value: unknown, workspaceId: string): RuntimeState | null {
  if (!isRuntimeState(value) || value.workspaceId !== workspaceId) return null;
  return {
    ...value,
    publicUrl: value.publicUrl ?? null,
    adminTokenKnown: value.adminTokenKnown ?? true,
  };
}

type RuntimeFence = Pick<RuntimeState, "pid" | "port" | "startedAt" | "stateDomainGeneration">;

export function clearRuntimeState(workspaceId: string, expectedStartedAt?: string | RuntimeFence, stateDir?: string): void {
  const file = runtimeFile(workspaceId, stateDir);
  clearRuntimeFile(file, expectedStartedAt);
}

/** Remove only the exact, already-validated legacy runtime pointer. */
export function clearRuntimeStateAt(workspaceId: string, expectedStartedAt: string | RuntimeFence | undefined, stateDir: string): void {
  clearRuntimeFile(runtimeFileAt(workspaceId, stateDir), expectedStartedAt);
}

function clearRuntimeFile(file: string, expectedStartedAt?: string | RuntimeFence): void {
  if (expectedStartedAt !== undefined) {
    const current = readJsonIfExists<RuntimeFence>(file);
    // An older process must never remove a newer process's runtime record.
    if (!current) return;
    if (typeof expectedStartedAt === "string") {
      if (current.stateDomainGeneration || current.startedAt !== expectedStartedAt) return;
    } else if (current.startedAt !== expectedStartedAt.startedAt || current.pid !== expectedStartedAt.pid ||
        current.port !== expectedStartedAt.port || current.stateDomainGeneration !== expectedStartedAt.stateDomainGeneration) return;
  }
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // ignore
  }
}

export interface HealthPayload {
  service: string;
  version: string;
  workspaceId: string;
  status: string;
}

export interface BridgeProcessIdentity {
  pid: number;
  executable: string;
  commandLine: string;
  listeningPorts: readonly number[];
  /** OS process-creation identity used to defend against PID reuse. */
  processStartIdentity?: string;
}

export interface BridgeProcessInspector {
  /** Return a point-in-time process inventory, or null when inspection failed. */
  list(): readonly BridgeProcessIdentity[] | null;
}

export type BridgeProbe = (port: number, timeoutMs?: number) => Promise<HealthPayload | null>;

export type ProcessSignalProbe = (pid: number, signal?: number | string) => void;

export type ProcessLiveness = "alive" | "dead" | "unknown";

export interface BridgeObservationOptions {
  workspaceRoot?: string;
  /** Explicit state domain for lifecycle inspection; defaults to the frozen process domain. */
  stateDir?: string;
  processInspector?: BridgeProcessInspector;
  probe?: BridgeProbe;
  /** Compatibility option: discovery is now always non-destructive. */
  repairRuntime?: boolean;
  /**
   * Independent signal-0 probe test seam; defaults to process.kill(pid, 0).
   * A probe credits only ESRCH as positively dead. Successful signal means live;
   * EPERM, EACCES, or any unknown error fails closed.
   */
  signalProcess?: ProcessSignalProbe;
  /** Direct test seam for process liveness checking. */
  isProcessAlive?: (pid: number) => boolean | ProcessLiveness;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isRuntimeState(value: unknown): value is RuntimeState {
  if (!isRecord(value)) return false;
  const row = value as Partial<RuntimeState>;
  return (
    row.service === SERVICE_NAME &&
    typeof row.version === "string" &&
    typeof row.workspaceId === "string" &&
    row.workspaceId.length > 0 &&
    typeof row.workspaceRoot === "string" &&
    row.workspaceRoot.length > 0 &&
    Number.isInteger(row.pid) &&
    Number(row.pid) > 0 &&
    Number.isInteger(row.port) &&
    Number(row.port) > 0 &&
    Number(row.port) <= 65_535 &&
    typeof row.adminToken === "string" &&
    (row.adminTokenKnown === undefined || typeof row.adminTokenKnown === "boolean") &&
    (row.adminTokenKnown === false || row.adminToken.length > 0) &&
    (row.publicUrl === null || row.publicUrl === undefined || typeof row.publicUrl === "string") &&
    typeof row.startedAt === "string" &&
    row.startedAt.length > 0 &&
    (row.stateDir === undefined || (typeof row.stateDir === "string" && path.isAbsolute(row.stateDir))) &&
    (row.stateDomainGeneration === undefined || (
      typeof row.stateDomainGeneration === "string" &&
      /^[0-9a-f-]{36}$/i.test(row.stateDomainGeneration)
    ))
  );
}

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  let canonical = resolved;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch {
    // The path may be a command-line argument for a file that has not been
    // created yet. Comparing its resolved spelling is still useful.
  }
  return CASE_INSENSITIVE ? canonical.toLowerCase() : canonical;
}

function canonicalWorkspaceRoot(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
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

function bridgeEntrypoints(): string[] {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  return [
    path.join(repositoryRoot, "dist", "cli", "index.js"),
    path.join(repositoryRoot, "src", "cli", "index.ts"),
    path.join(repositoryRoot, "bin", "c2c.js"),
  ].map(comparablePath);
}

function bridgeCommandTokens(processInfo: BridgeProcessIdentity): string[] {
  return tokenizeCommandLine(processInfo.commandLine);
}

/** True when a process is a bridge `serve` command from this installation. */
export function isBridgeServeProcess(processInfo: BridgeProcessIdentity): boolean {
  if (comparablePath(processInfo.executable) !== comparablePath(process.execPath)) return false;
  const tokens = bridgeCommandTokens(processInfo);
  return tokens.includes("serve") && tokens.some((token) => bridgeEntrypoints().includes(comparablePath(token)));
}

/** Extract the bridge-owned workspace argument from a validated serve command. */
export function bridgeProcessWorkspaceRoot(processInfo: BridgeProcessIdentity): string | null {
  if (!isBridgeServeProcess(processInfo)) return null;
  return optionValue(bridgeCommandTokens(processInfo), "--workspace");
}

/** Extract an explicit state-domain override from a validated serve command. */
export function bridgeProcessStateDir(processInfo: BridgeProcessIdentity): string | null {
  if (!isBridgeServeProcess(processInfo)) return null;
  return optionValue(bridgeCommandTokens(processInfo), "--state-dir");
}

/** Validate process identity before a runtime record may be used for control. */
export function isOwnedBridgeProcess(
  processInfo: BridgeProcessIdentity,
  workspaceId: string,
  workspaceRoot: string
): boolean {
  const expectedRoot = canonicalWorkspaceRoot(workspaceRoot);
  if (stableWorkspaceId(expectedRoot) !== workspaceId) return false;
  if (!isBridgeServeProcess(processInfo)) return false;

  const tokens = bridgeCommandTokens(processInfo);
  const commandWorkspace = optionValue(tokens, "--workspace");
  return commandWorkspace !== null && comparablePath(commandWorkspace) === comparablePath(expectedRoot);
}

function stateDirMatches(left: string | undefined, right: string): boolean {
  if (!left) return true;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return CASE_INSENSITIVE ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function systemBinary(name: string): string | null {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) return null;
  const candidate = path.join(systemRoot, "System32", name);
  try {
    if (fs.statSync(candidate).isFile()) return candidate;
  } catch {
    // Inspection is fail-closed when the platform query is unavailable.
  }
  return null;
}

interface RawProcessRow {
  pid: number;
  executable: string;
  commandLine: string;
  processStartIdentity?: string;
}

function windowsProcessRows(): RawProcessRow[] | null {
  const powershell = systemBinary("WindowsPowerShell\\v1.0\\powershell.exe");
  if (!powershell) return null;
  const query = [
    "$OutputEncoding = [System.Text.UTF8Encoding]::new()",
    "Get-CimInstance -ClassName Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress -Depth 3",
  ].join("; ");
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", query], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) return null;
  const stdout = String(result.stdout ?? "");
  if (!stdout.trim()) return [];
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((value) => {
      if (!isRecord(value)) return [];
      const pid = value.ProcessId;
      const executable = value.ExecutablePath;
      const commandLine = value.CommandLine;
      const creationDate = value.CreationDate;
      if (
        !Number.isInteger(pid) ||
        Number(pid) <= 0 ||
        typeof executable !== "string" ||
        typeof commandLine !== "string"
      ) return [];
      const processStartIdentity = typeof creationDate === "string" && creationDate.length > 0
        ? creationDate
        : undefined;
      return [{ pid: Number(pid), executable, commandLine, processStartIdentity }];
    });
  } catch {
    return null;
  }
}

function parseEndpointPort(endpoint: string): number | null {
  const match = endpoint.trim().match(/:(\d+)$/);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function windowsListeningPorts(): Map<number, Set<number>> | null {
  const netstat = systemBinary("netstat.exe");
  if (!netstat) return null;
  const result = spawnSync(netstat, ["-ano", "-p", "tcp"], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) return null;
  const stdout = String(result.stdout ?? "");
  const ports = new Map<number, Set<number>>();
  for (const line of stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields[0]?.toUpperCase() !== "TCP" || fields[3]?.toUpperCase() !== "LISTENING") continue;
    const port = parseEndpointPort(fields[1] ?? "");
    const pid = Number(fields[4]);
    if (!port || !Number.isInteger(pid) || pid <= 0) continue;
    const owned = ports.get(pid) ?? new Set<number>();
    owned.add(port);
    ports.set(pid, owned);
  }
  return ports;
}

function posixProcessRows(): RawProcessRow[] | null {
  if (!fs.existsSync("/proc")) return null;
  const rows: RawProcessRow[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync("/proc", { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      const executable = fs.realpathSync.native(`/proc/${entry.name}/exe`);
      const commandLine = fs.readFileSync(`/proc/${entry.name}/cmdline`).toString("utf8").replace(/\0/g, " ").trim();
      const stat = fs.readFileSync(`/proc/${entry.name}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      const fields = closeParen >= 0 ? stat.slice(closeParen + 2).trim().split(/\s+/) : [];
      // /proc/<pid>/stat field 22 is the process start time.  After the
      // comm field, it is index 19 in this remainder.
      const processStartIdentity = fields[19] ? `proc-start:${fields[19]}` : undefined;
      if (commandLine) rows.push({ pid, executable, commandLine, processStartIdentity });
    } catch {
      // Processes can exit between directory enumeration and inspection.
    }
  }
  return rows;
}

function posixListeningPorts(): Map<number, Set<number>> | null {
  const candidates = ["/usr/bin/ss", "/bin/ss", "/usr/sbin/ss", "/sbin/ss", "/usr/bin/netstat", "/bin/netstat"];
  for (const binary of candidates) {
    if (!fs.existsSync(binary)) continue;
    const args = binary.endsWith("ss") ? ["-ltnp"] : ["-ltnp"];
    const result = spawnSync(binary, args, { encoding: "utf8", timeout: 5_000 });
    if (result.status !== 0 || result.error) continue;
    const stdout = String(result.stdout ?? "");
    const ports = new Map<number, Set<number>>();
    for (const line of stdout.split(/\r?\n/)) {
      const portMatch = line.match(/\s(?:\[?[^\s:]+\]?):(\d+)\s/);
      const pidMatch = line.match(/pid=(\d+)/);
      if (!portMatch || !pidMatch) continue;
      const port = Number(portMatch[1]);
      const pid = Number(pidMatch[1]);
      if (!Number.isInteger(port) || port <= 0 || port > 65_535 || !Number.isInteger(pid) || pid <= 0) continue;
      const owned = ports.get(pid) ?? new Set<number>();
      owned.add(port);
      ports.set(pid, owned);
    }
    return ports;
  }
  return null;
}

function systemProcessInspector(): BridgeProcessInspector {
  return {
    list: () => {
      const rows = process.platform === "win32" ? windowsProcessRows() : posixProcessRows();
      if (rows === null) return null;
      const ports = process.platform === "win32" ? windowsListeningPorts() : posixListeningPorts();
      if (ports === null) return null;
      return rows
        .map((row) => ({
          ...row,
          listeningPorts: [...(ports.get(row.pid) ?? new Set<number>())].sort((a, b) => a - b),
        }))
        .sort((a, b) => a.pid - b.pid);
    },
  };
}

/** Process inventory used by the state-domain owner and lifecycle controls. */
export function getSystemProcessInspector(): BridgeProcessInspector {
  return systemProcessInspector();
}

/** Probe a port and check whether a healthy c2c bridge for the workspace answers. */
export async function probeBridge(
  port: number,
  timeoutMs = 2000
): Promise<HealthPayload | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const body = (await response.json()) as HealthPayload;
    if (body.service !== SERVICE_NAME) return null;
    return body;
  } catch {
    return null;
  }
}

export type BridgeObservation =
  | { state: "healthy"; runtime: RuntimeState; reconciled: boolean }
  | { state: "stopped"; runtime: RuntimeState | null; reason: "runtime_missing" | "pid_missing" }
  | {
      state: "unknown";
      runtime: RuntimeState | null;
      reason:
        | "probe_failed"
        | "pid_unknown"
        | "workspace_mismatch"
        | "stale_runtime"
        | "ownership_unknown"
        | "duplicate_bridges"
        | "runtime_initializing"
        | "admin_proof_unavailable"
        | "runtime_unreadable"
        | "runtime_changed";
    };

export function safeProbe(probe: BridgeProbe, port: number): Promise<HealthPayload | null> {
  return probe(port, 500).catch(() => null);
}

function sameRuntimePointer(a: RuntimeState | null, b: RuntimeState | null): boolean {
  return Boolean(
    a &&
      b &&
      a.workspaceId === b.workspaceId &&
      a.pid === b.pid &&
      a.port === b.port &&
      a.startedAt === b.startedAt &&
      a.workspaceRoot === b.workspaceRoot &&
      a.stateDir === b.stateDir &&
      a.stateDomainGeneration === b.stateDomainGeneration &&
      a.adminToken === b.adminToken &&
      a.adminTokenKnown === b.adminTokenKnown
  );
}

function resolvedWorkspaceRoot(workspaceRoot: string | undefined, runtime: RuntimeState | null): string | null {
  const candidate = workspaceRoot?.trim() || runtime?.workspaceRoot;
  return candidate ? canonicalWorkspaceRoot(candidate) : null;
}

interface ValidBridgeCandidate {
  processInfo: BridgeProcessIdentity;
  port: number;
  health: HealthPayload;
}

async function discoverValidBridges(
  processes: readonly BridgeProcessIdentity[],
  workspaceId: string,
  workspaceRoot: string,
  probe: BridgeProbe,
  stateDir: string
): Promise<ValidBridgeCandidate[]> {
  const candidates: ValidBridgeCandidate[] = [];
  const seenPids = new Set<number>();
  for (const processInfo of [...processes].sort((a, b) => a.pid - b.pid)) {
    if (seenPids.has(processInfo.pid)) continue;
    if (!isOwnedBridgeProcess(processInfo, workspaceId, workspaceRoot)) continue;
    const explicitStateDir = bridgeProcessStateDir(processInfo);
    if (explicitStateDir && !stateDirMatches(explicitStateDir, stateDir)) continue;
    // A pre-fix bridge had no state-domain identity in argv. It can only be
    // attributed to the canonical default domain; never adopt it into an
    // explicitly isolated state directory.
    if (!explicitStateDir && !stateDirMatches(stateDir, getDefaultStateDir())) continue;
    const ports = [...new Set(processInfo.listeningPorts)]
      .filter((port) => Number.isInteger(port) && port > 0 && port <= 65_535)
      .sort((a, b) => a - b);
    for (const port of ports) {
      const health = await safeProbe(probe, port);
      if (!health || health.service !== SERVICE_NAME || health.workspaceId !== workspaceId || health.status !== "ok") continue;
      candidates.push({ processInfo, port, health });
      seenPids.add(processInfo.pid);
      break;
    }
  }
  return candidates;
}

/**
 * A pre-fix packaged-parent bridge may have no --state-dir argv at all. Its
 * runtime pointer is the only reliable state-domain evidence, so detect it
 * before default-domain discovery can accidentally reuse that process.
 */
async function discoverLegacyPackagedBridge(
  stateDir: string,
  workspaceId: string,
  workspaceRoot: string,
  processes: readonly BridgeProcessIdentity[],
  probe: BridgeProbe
): Promise<RuntimeState | null> {
  // Packaged-parent runtime pointers are legacy evidence for the canonical
  // default domain only. An explicit override is intentionally isolated.
  if (!stateDirMatches(stateDir, getDefaultStateDir())) return null;
  for (const alternateStateDir of packagedStateDirCandidates(undefined, getDefaultStateDir())) {
    const runtime = readRuntimeStateAt(workspaceId, alternateStateDir);
    if (!runtime || !runtimeBelongsToWorkspace(runtime, workspaceId, workspaceRoot)) continue;
    const processInfo = processes.find((candidate) => candidate.pid === runtime.pid) ?? null;
    if (!processInfo || !isOwnedBridgeProcess(processInfo, workspaceId, workspaceRoot)) continue;
    // An explicit alternate override is intentionally isolated. Only the
    // legacy no-argv identity is treated as the old implicit default domain.
    if (bridgeProcessStateDir(processInfo)) continue;
    if (!processInfo.listeningPorts.includes(runtime.port)) continue;
    const health = await safeProbe(probe, runtime.port);
    if (!health || health.workspaceId !== workspaceId || health.status !== "ok") continue;
    return { ...runtime, stateDir: alternateStateDir };
  }
  return null;
}

function reconciledRuntime(
  previous: RuntimeState | null,
  workspaceId: string,
  workspaceRoot: string,
  candidate: ValidBridgeCandidate,
  stateDir: string
): RuntimeState {
  return {
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId,
    workspaceRoot,
    pid: candidate.processInfo.pid,
    port: candidate.port,
    // The admin secret is process-local and cannot be recovered from /health.
    // Mark it unavailable; discovery alone does not grant privileged control.
    adminToken: "",
    adminTokenKnown: false,
    publicUrl: previous?.workspaceId === workspaceId ? previous.publicUrl : null,
    startedAt: previous?.startedAt ?? new Date().toISOString(),
    stateDir,
  };
}

function runtimeBelongsToWorkspace(runtime: RuntimeState, workspaceId: string, workspaceRoot: string): boolean {
  return (
    runtime.workspaceId === workspaceId &&
    comparablePath(runtime.workspaceRoot) === comparablePath(workspaceRoot) &&
    stableWorkspaceId(workspaceRoot) === workspaceId
  );
}

function probeProcessLiveness(
  pid: number,
  options: Pick<BridgeObservationOptions, "signalProcess" | "isProcessAlive">
): ProcessLiveness {
  if (!Number.isInteger(pid) || pid <= 0) return "dead";
  if (typeof options.isProcessAlive === "function") {
    const result = options.isProcessAlive(pid);
    if (result === "dead" || result === false) return "dead";
    if (result === "alive" || result === true) return "alive";
    return "unknown";
  }
  const signal = options.signalProcess ?? ((targetPid: number, sig: number | string = 0) => {
    process.kill(targetPid, sig);
  });
  try {
    signal(pid, 0);
    return "alive";
  } catch (error: unknown) {
    const code =
      (isRecord(error) && typeof error.code === "string" ? error.code : undefined) ??
      (error instanceof Error && "code" in error && typeof (error as Record<string, unknown>).code === "string"
        ? String((error as Record<string, unknown>).code)
        : undefined);
    if (code === "ESRCH" || (error instanceof Error && error.message === "ESRCH")) {
      return "dead";
    }
    return "unknown";
  }
}

/**
 * Reconcile the persisted runtime pointer against a point-in-time process
 * inventory. A PID is usable only when executable, command line, listening
 * port, and bridge health all identify this exact workspace.
 */
export async function reconcileBridgeRuntime(
  workspaceId: string,
  workspaceRoot?: string,
  options: BridgeObservationOptions = {}
): Promise<BridgeObservation> {
  const stateDir = path.resolve(getStateDir(options.stateDir));
  const runtimePath = runtimeFile(workspaceId, stateDir);
  const runtime = readRuntimeState(workspaceId, stateDir);
  // Read/parse failure is not proof of absence or death. Discovery must never
  // unlink a credential that another process may be publishing or using.
  if (!runtime && fs.existsSync(runtimePath)) {
    return { state: "unknown", runtime: null, reason: "runtime_unreadable" };
  }
  const expectedRoot = resolvedWorkspaceRoot(workspaceRoot ?? options.workspaceRoot, runtime);
  if (!expectedRoot) {
    if (!runtime) {
      return { state: "stopped", runtime: null, reason: "runtime_missing" };
    }
    return { state: "unknown", runtime, reason: "workspace_mismatch" };
  }
  if (stableWorkspaceId(expectedRoot) !== workspaceId) {
    return { state: "unknown", runtime, reason: "workspace_mismatch" };
  }

  const probe = options.probe ?? probeBridge;
  const processInspector = options.processInspector ?? systemProcessInspector();
  const processes = processInspector.list();
  if (processes === null) {
    return { state: "unknown", runtime, reason: "ownership_unknown" };
  }
  const ownerStatus = readStateDomainOwnerStatus(stateDir, { list: () => processes });
  const owner = ownerStatus.state === "absent" ? null : ownerStatus.owner;
  if (ownerStatus.state === "unknown" && (!owner || owner.workspaceId === workspaceId)) {
    return { state: "unknown", runtime, reason: "ownership_unknown" };
  }

  const legacyPackagedRuntime = await discoverLegacyPackagedBridge(
    stateDir,
    workspaceId,
    expectedRoot,
    processes,
    probe,
  );
  if (legacyPackagedRuntime) {
    return { state: "healthy", runtime: legacyPackagedRuntime, reconciled: false };
  }

  const validBridges = await discoverValidBridges(processes, workspaceId, expectedRoot, probe, stateDir);
  const current = readRuntimeState(workspaceId, stateDir);
  if (runtime ? !sameRuntimePointer(current, runtime) : current !== null || fs.existsSync(runtimePath)) {
    return { state: "unknown", runtime: current, reason: "runtime_changed" };
  }
  if (validBridges.length > 1) {
    return { state: "unknown", runtime, reason: "duplicate_bridges" };
  }
  if (validBridges.length === 1) {
    const candidate = validBridges[0];
    if (owner?.workspaceId === workspaceId || runtime?.stateDomainGeneration) {
      const latest = readStateDomainOwnerStatus(stateDir, processInspector);
      if (!owner || ownerStatus.state !== "active" || latest.state !== "active" ||
          latest.owner.generation !== owner.generation || latest.owner.pid !== owner.pid ||
          latest.owner.processStartIdentity !== owner.processStartIdentity ||
          latest.owner.workspaceId !== workspaceId ||
          comparablePath(latest.owner.workspaceRoot) !== comparablePath(expectedRoot) ||
          owner.pid !== candidate.processInfo.pid || !owner.processStartIdentity ||
          owner.processStartIdentity !== candidate.processInfo.processStartIdentity ||
          !bridgeProcessStateDir(candidate.processInfo) ||
          !stateDirMatches(bridgeProcessStateDir(candidate.processInfo)!, stateDir)) {
        return { state: "unknown", runtime, reason: "ownership_unknown" };
      }
      if (!runtime) return { state: "unknown", runtime: null, reason: "admin_proof_unavailable" };
      if (runtime.stateDomainGeneration !== owner.generation || !runtime.stateDir ||
          !stateDirMatches(runtime.stateDir, stateDir)) {
        return { state: "unknown", runtime, reason: "stale_runtime" };
      }
    }
    // A freshly spawned bridge opens its listener before persisting the
    // admin-bearing runtime pointer. Never replace that missing pointer with
    // a recovered adminToken-less record during this small startup window;
    // doing so races the child and makes every later admin request return 404.
    if (!runtime && bridgeProcessStateDir(candidate.processInfo)) {
      return { state: "unknown", runtime: null, reason: "runtime_initializing" };
    }
    const pointerMatches =
      runtime !== null &&
      runtimeBelongsToWorkspace(runtime, workspaceId, expectedRoot) &&
      runtime.pid === candidate.processInfo.pid &&
      runtime.port === candidate.port;
    if (pointerMatches) return runtime.adminTokenKnown === false || !runtime.adminToken
      ? { state: "unknown", runtime, reason: "admin_proof_unavailable" }
      : { state: "healthy", runtime, reconciled: false };

    if (owner?.workspaceId === workspaceId) return { state: "unknown", runtime, reason: "stale_runtime" };
    const replacement = reconciledRuntime(runtime, workspaceId, expectedRoot, candidate, stateDir);
    // Legacy discovery is observational only; it cannot recover a credential.
    return { state: "healthy", runtime: replacement, reconciled: true };
  }

  if (!runtime) {
    if ((owner?.workspaceId === workspaceId && ownerStatus.state === "active") || processes.some(row =>
      isOwnedBridgeProcess(row, workspaceId, expectedRoot) && stateDirMatches(bridgeProcessStateDir(row) ?? undefined, stateDir) &&
      Boolean(bridgeProcessStateDir(row)))) {
      return { state: "unknown", runtime: null, reason: "runtime_initializing" };
    }
    return { state: "stopped", runtime: null, reason: "runtime_missing" };
  }

  const runtimeProcess = processes.find((processInfo) => processInfo.pid === runtime.pid) ?? null;
  if (!runtimeBelongsToWorkspace(runtime, workspaceId, expectedRoot)) {
    return { state: "unknown", runtime, reason: "workspace_mismatch" };
  }
  if (!runtimeProcess) {
    const liveness = probeProcessLiveness(runtime.pid, options);
    if (liveness === "alive" || liveness === "unknown") {
      return { state: "unknown", runtime, reason: "pid_unknown" };
    }

    const health = await safeProbe(probe, runtime.port);
    if (health && health.service === SERVICE_NAME && health.workspaceId === workspaceId && health.status === "ok") {
      return { state: "unknown", runtime, reason: "pid_unknown" };
    }

    if (!sameRuntimePointer(readRuntimeState(workspaceId, stateDir), runtime)) {
      return { state: "unknown", runtime: readRuntimeState(workspaceId, stateDir) ?? runtime, reason: "runtime_changed" };
    }
    // Conclusive death permits a new owner to publish its own pointer. Keep
    // the stale record until then: read/check/unlink is not an atomic CAS and
    // could delete a newly published generation between the check and unlink.
    return { state: "stopped", runtime, reason: "pid_missing" };
  }
  if (!isOwnedBridgeProcess(runtimeProcess, workspaceId, expectedRoot)) {
    const health = await safeProbe(probe, runtime.port);
    return health && health.workspaceId !== workspaceId
      ? { state: "unknown", runtime, reason: "workspace_mismatch" }
      : { state: "unknown", runtime, reason: "stale_runtime" };
  }
  if (!runtimeProcess.listeningPorts.includes(runtime.port)) {
    return { state: "unknown", runtime, reason: "stale_runtime" };
  }

  const health = await safeProbe(probe, runtime.port);
  if (health && health.workspaceId !== workspaceId) {
    return { state: "unknown", runtime, reason: "workspace_mismatch" };
  }
  return { state: "unknown", runtime, reason: "probe_failed" };
}

export async function findBridgeObservation(
  workspaceId: string,
  workspaceRoot?: string,
  options: BridgeObservationOptions = {}
): Promise<BridgeObservation> {
  return reconcileBridgeRuntime(workspaceId, workspaceRoot, options);
}

export async function findLiveBridge(
  workspaceId: string,
  workspaceRoot?: string,
  options: BridgeObservationOptions = {}
): Promise<RuntimeState | null> {
  const observation = await findBridgeObservation(workspaceId, workspaceRoot, options);
  return observation.state === "healthy" ? observation.runtime : null;
}

export { SERVICE_NAME, VERSION };
