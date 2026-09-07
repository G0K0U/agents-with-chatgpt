import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  ensureDir,
  getDefaultStateDir,
  getStateDir,
  packagedStateDirCandidates,
  writeSecureJson,
} from "../config/paths.js";
import {
  canonicalizeWorkspaceRoot,
  stableWorkspaceId,
} from "../workspace/identity.js";
import {
  bridgeProcessStateDir,
  getSystemProcessInspector,
  isBridgeServeProcess,
  type BridgeProcessIdentity,
  type BridgeProcessInspector,
} from "./runtime.js";

/**
 * The state-domain owner is deliberately separate from the per-workspace
 * runtime pointer.  One bridge process owns the shared OAuth/auth domain for
 * its whole lifetime; every generation gets a private auth snapshot so a
 * pre-fencing process cannot keep writing the file used by the new owner.
 */
export const STATE_DOMAIN_OWNER_SCHEMA = 1 as const;
export const AUTH_STATE_POINTER_SCHEMA = 1 as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTH_GENERATION_FILE_PATTERN = /^bridge\.([0-9a-f-]{36})\.json$/i;
const STATE_OWNER_STALE_LOCK_MS = 60_000;
const STATE_OWNER_WAIT_MS = 15;
const STATE_OWNER_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export interface StateDomainOwnerRecord {
  schema: typeof STATE_DOMAIN_OWNER_SCHEMA;
  stateDir: string;
  generation: string;
  workspaceId: string;
  workspaceRoot: string;
  pid: number;
  /** OS process-creation identity; never use a PID by itself for recovery. */
  processStartIdentity: string | null;
  acquiredAt: string;
  authFile: string;
}

export interface AuthStatePointer {
  schema: typeof AUTH_STATE_POINTER_SCHEMA;
  generation: string;
  authFile: string;
  updatedAt: string;
}

interface StateDomainLockRecord {
  schema: typeof STATE_DOMAIN_OWNER_SCHEMA;
  ownerToken: string;
  generation: string;
  stateDir: string;
  workspaceId: string;
  pid: number;
  processStartIdentity: string | null;
  createdAt: string;
}

export interface StateDomainOwnerOptions {
  workspaceId: string;
  workspaceRoot: string;
  stateDir?: string;
  processInspector?: BridgeProcessInspector;
}

export interface OwnedAuthStorage {
  file: string;
  /** Only trusted prior-generation/migration sources are returned. */
  legacyFiles: string[];
}

export type StateDomainOwnerStatus =
  | { state: "absent" }
  | { state: "active"; owner: StateDomainOwnerRecord }
  | { state: "stale"; owner: StateDomainOwnerRecord }
  | { state: "unknown"; owner: StateDomainOwnerRecord | null; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" || process.platform === "darwin"
    ? resolved.toLowerCase()
    : resolved;
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function within(candidate: string, root: string): boolean {
  const relative = path.relative(pathKey(root), pathKey(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function processIsAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function sleepForOwnerCheck(): void {
  Atomics.wait(STATE_OWNER_WAIT_BUFFER, 0, 0, STATE_OWNER_WAIT_MS);
}

function ownerFile(stateDir: string): string {
  return path.join(path.resolve(stateDir), "runtime", "state-domain-owner.json");
}

function ownerLockFile(stateDir: string): string {
  return path.join(path.resolve(stateDir), "runtime", "state-domain-owner.lock");
}

export function stateDomainOwnerFile(stateDir = getStateDir()): string {
  return ownerFile(stateDir);
}

export function stateDomainOwnerLockFile(stateDir = getStateDir()): string {
  return ownerLockFile(stateDir);
}

export function authStatePointerFile(stateDir = getStateDir()): string {
  return path.join(path.resolve(stateDir), "auth", "bridge-active.json");
}

function readJson(file: string): { exists: boolean; value: unknown | null } {
  if (!fs.existsSync(file)) return { exists: false, value: null };
  try {
    return { exists: true, value: JSON.parse(fs.readFileSync(file, "utf8")) as unknown };
  } catch {
    return { exists: true, value: null };
  }
}

function validOwnerRecord(value: unknown, expectedStateDir?: string): value is StateDomainOwnerRecord {
  if (!isRecord(value)) return false;
  const generation = value.generation;
  const authFile = typeof value.authFile === "string" ? path.resolve(value.authFile) : "";
  const authMatch = path.basename(authFile).match(AUTH_GENERATION_FILE_PATTERN);
  const ownerStateDir = typeof value.stateDir === "string" ? path.resolve(value.stateDir) : "";
  const authDir = ownerStateDir ? path.join(ownerStateDir, "auth") : "";
  return value.schema === STATE_DOMAIN_OWNER_SCHEMA &&
    typeof value.stateDir === "string" &&
    (!expectedStateDir || samePath(value.stateDir, expectedStateDir)) &&
    typeof generation === "string" && UUID_PATTERN.test(generation) &&
    typeof value.workspaceId === "string" && /^[0-9a-f]{12}$/.test(value.workspaceId) &&
    typeof value.workspaceRoot === "string" && path.isAbsolute(value.workspaceRoot) &&
    Number.isInteger(value.pid) && Number(value.pid) > 0 &&
    (value.processStartIdentity === null || typeof value.processStartIdentity === "string") &&
    typeof value.acquiredAt === "string" && value.acquiredAt.length > 0 &&
    typeof value.authFile === "string" && path.isAbsolute(value.authFile) &&
    Boolean(authMatch && authMatch[1]?.toLowerCase() === generation.toLowerCase()) &&
    samePath(path.dirname(authFile), authDir) &&
    within(authFile, authDir);
}

function validLockRecord(value: unknown, expectedStateDir?: string): value is StateDomainLockRecord {
  if (!isRecord(value)) return false;
  return value.schema === STATE_DOMAIN_OWNER_SCHEMA &&
    typeof value.ownerToken === "string" && value.ownerToken.length > 0 &&
    typeof value.generation === "string" && UUID_PATTERN.test(value.generation) &&
    typeof value.stateDir === "string" &&
    (!expectedStateDir || samePath(value.stateDir, expectedStateDir)) &&
    typeof value.workspaceId === "string" && /^[0-9a-f]{12}$/.test(value.workspaceId) &&
    Number.isInteger(value.pid) && Number(value.pid) > 0 &&
    (value.processStartIdentity === null || typeof value.processStartIdentity === "string") &&
    typeof value.createdAt === "string" && value.createdAt.length > 0;
}

function validAuthPointer(value: unknown, stateDir: string): value is AuthStatePointer {
  if (!isRecord(value)) return false;
  if (
    value.schema !== AUTH_STATE_POINTER_SCHEMA ||
    typeof value.generation !== "string" ||
    !UUID_PATTERN.test(value.generation) ||
    typeof value.authFile !== "string" ||
    !path.isAbsolute(value.authFile) ||
    typeof value.updatedAt !== "string" ||
    value.updatedAt.length === 0
  ) return false;

  const authDir = path.join(path.resolve(stateDir), "auth");
  const resolved = path.resolve(value.authFile);
  const match = path.basename(resolved).match(AUTH_GENERATION_FILE_PATTERN);
  return Boolean(
    match &&
    match[1] &&
    match[1].toLowerCase() === value.generation.toLowerCase() &&
    samePath(path.dirname(resolved), authDir) &&
    within(resolved, authDir)
  );
}

/** Read the last bridge-owned auth generation without exposing token data. */
export function readAuthStatePointer(stateDir = getStateDir()): AuthStatePointer | null {
  const resolvedStateDir = path.resolve(stateDir);
  const pointer = readJson(authStatePointerFile(resolvedStateDir));
  if (pointer.exists && !validAuthPointer(pointer.value, resolvedStateDir)) {
    throw new Error("OAuth generation pointer is invalid; refusing to use persisted auth state");
  }
  const value = pointer.value as AuthStatePointer | null;
  ensureAuthPointerSource(resolvedStateDir, value);
  return value;
}

export function stateDirectories(stateDir: string, workspaceRoot: string): string {
  const requested = path.resolve(stateDir);
  const workspace = canonicalizeWorkspaceRoot(workspaceRoot);
  ensureDir(requested);
  let canonical: string;
  try {
    const stat = fs.lstatSync(requested);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("C2C state directory must be a regular directory");
    }
    canonical = fs.realpathSync.native(requested);
  } catch (error) {
    if (error instanceof Error && error.message === "C2C state directory must be a regular directory") throw error;
    throw new Error("C2C state directory cannot be resolved");
  }
  if (!samePath(canonical, requested)) {
    throw new Error("C2C state directory must not be a reparse-point alias");
  }
  if (within(canonical, workspace)) {
    throw new Error("C2C state directory must remain outside the connected workspace");
  }
  for (const name of ["runtime", "auth"]) {
    const child = path.join(canonical, name);
    ensureDir(child);
    const stat = fs.lstatSync(child);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("C2C state subdirectory must be a regular directory");
    }
    const real = fs.realpathSync.native(child);
    if (!samePath(real, child) || !within(real, canonical)) {
      throw new Error("C2C state subdirectory escaped the state directory");
    }
  }
  return canonical;
}

function readOwnerRecord(stateDir: string): { exists: boolean; owner: StateDomainOwnerRecord | null } {
  const result = readJson(ownerFile(stateDir));
  return {
    exists: result.exists,
    owner: validOwnerRecord(result.value, stateDir) ? result.value : null,
  };
}

function readLockRecord(stateDir: string): { exists: boolean; lock: StateDomainLockRecord | null } {
  const result = readJson(ownerLockFile(stateDir));
  return {
    exists: result.exists,
    lock: validLockRecord(result.value, stateDir) ? result.value : null,
  };
}

function processIdentityStatus(
  pid: number,
  processStartIdentity: string | null,
  processes: readonly BridgeProcessIdentity[] | null,
): "active" | "stale" | "unknown" {
  if (processes === null) return "unknown";
  const actual = processes.find((candidate) => candidate.pid === pid);
  if (!actual) return processIsAlive(pid) ? "unknown" : "stale";
  if (!processStartIdentity || !actual.processStartIdentity) return "unknown";
  return actual.processStartIdentity === processStartIdentity ? "active" : "stale";
}

function conflictMessage(owner: StateDomainOwnerRecord | StateDomainLockRecord | null): string {
  const workspace = owner?.workspaceId ? `workspace ${owner.workspaceId}` : "another bridge";
  return `C2C state domain is already owned by ${workspace}; refusing to share OAuth/runtime state. Set an explicit isolated C2C_STATE_DIR for an independent bridge.`;
}

function inspectOwnerState(
  stateDir: string,
  processInspector: BridgeProcessInspector,
): StateDomainOwnerStatus {
  const record = readOwnerRecord(stateDir);
  if (!record.exists) return { state: "absent" };
  if (!record.owner) return {
    state: "unknown",
    owner: null,
    reason: "owner_record_invalid",
  };
  const processes = processInspector.list();
  const status = processIdentityStatus(record.owner.pid, record.owner.processStartIdentity, processes);
  if (status === "active") return { state: "active", owner: record.owner };
  if (status === "stale") return { state: "stale", owner: record.owner };
  return {
    state: "unknown",
    owner: record.owner,
    reason: "owner_process_identity_unavailable",
  };
}

/** Read-only status used by the daemon before it spawns a child bridge. */
export function readStateDomainOwnerStatus(
  stateDir = getStateDir(),
  processInspector: BridgeProcessInspector = getSystemProcessInspector(),
): StateDomainOwnerStatus {
  return inspectOwnerState(path.resolve(stateDir), processInspector);
}

function rejectLiveRuntimePointers(
  stateDir: string,
  workspaceRoot: string,
  processes: readonly BridgeProcessIdentity[] | null,
): void {
  const defaultStateDir = getDefaultStateDir();
  const candidateStateDirs = [stateDir, ...packagedStateDirCandidates(undefined, defaultStateDir)];
  for (const candidateStateDir of candidateStateDirs) {
    // A packaged-parent pointer belongs to the legacy default domain. An
    // explicitly isolated caller must not treat it as its own live bridge.
    if (!samePath(candidateStateDir, stateDir) && !samePath(stateDir, defaultStateDir)) continue;
    const runtimeDir = path.join(candidateStateDir, "runtime");
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(runtimeDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const runtimes = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "state-domain-owner.json")
      .map((entry) => readJson(path.join(runtimeDir, entry.name)).value)
      .filter((value): value is Record<string, unknown> => isRecord(value));
    for (const runtime of runtimes) {
      const pid = runtime.pid;
      const runtimeRoot = runtime.workspaceRoot;
      if (!Number.isInteger(pid) || Number(pid) <= 0 || typeof runtimeRoot !== "string" || !path.isAbsolute(runtimeRoot)) continue;
      if (pid === process.pid) continue;
      const processInfo = processes?.find((candidate) => candidate.pid === pid) ?? null;
      if (!processInfo) {
        if (processes === null && processIsAlive(pid)) {
          throw new Error("Cannot establish C2C state-domain ownership because process identity inspection is unavailable");
        }
        continue;
      }
      if (!isBridgeServeProcess(processInfo)) continue;
      // A process with an explicit non-canonical override is an intentional
      // isolated domain. Legacy packaged-parent processes have no explicit
      // argv identity, so their packaged runtime pointer is evidence that
      // must block a new default-domain owner.
      const explicitStateDir = bridgeProcessStateDir(processInfo);
      if (explicitStateDir && !samePath(explicitStateDir, stateDir)) continue;
      const sameWorkspace = samePath(runtimeRoot, workspaceRoot);
      throw new Error(
        `${sameWorkspace ? "A duplicate bridge was detected" : "A legacy per-workspace bridge was detected"}: ${conflictMessage({ workspaceId: typeof runtime.workspaceId === "string" ? runtime.workspaceId : "unknown" } as StateDomainOwnerRecord)}`
      );
    }
  }

  // A process can be in its startup window before it has written a runtime
  // pointer. A new daemon includes its explicit state directory in the
  // command line so independent domains remain distinguishable. An
  // unannotated second bridge is otherwise an unprovable shared-state case,
  // and must fail closed.
  for (const processInfo of processes ?? []) {
    if (processInfo.pid === process.pid || !isBridgeServeProcess(processInfo)) continue;
    const explicitStateDir = bridgeProcessStateDir(processInfo);
    if (explicitStateDir && !samePath(explicitStateDir, stateDir)) continue;
    if (!explicitStateDir) {
      // Legacy serve processes predate the explicit state-dir argv. Their
      // only safely inferable domain is the OS default; an explicitly
      // isolated caller is allowed to coexist with that legacy process.
      if (!samePath(stateDir, getDefaultStateDir())) continue;
      throw new Error("A second bridge process has no explicit C2C_STATE_DIR identity; refusing to share OAuth/runtime state");
    }
    throw new Error("A second bridge is starting in this C2C state domain; refusing to share OAuth/runtime state");
  }
}

function removeIfUnchanged(file: string, expected: string | null): void {
  if (!fs.existsSync(file)) return;
  if (expected !== null) {
    const current = fs.readFileSync(file, "utf8");
    if (current !== expected) return;
  }
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // The next acquisition attempt will fail closed if the file remains.
  }
}

function recoverStaleOwner(stateDir: string, owner: StateDomainOwnerRecord): void {
  const file = ownerFile(stateDir);
  const current = readOwnerRecord(stateDir).owner;
  if (!current || current.generation !== owner.generation) return;
  // Compare the generation and PID after the read rather than trusting a
  // previously captured file snapshot; another owner may have won a race.
  const latest = readOwnerRecord(stateDir).owner;
  if (!latest || latest.generation !== owner.generation || latest.pid !== owner.pid) return;
  try { fs.rmSync(file, { force: true }); } catch { /* next acquire fails closed */ }
}

function recoverStaleLock(stateDir: string, lock: StateDomainLockRecord | null): void {
  const file = ownerLockFile(stateDir);
  const expected = lock ? JSON.stringify(lock) : null;
  removeIfUnchanged(file, expected);
}

function lockAgeMs(stateDir: string): number {
  try {
    return Date.now() - fs.statSync(ownerLockFile(stateDir)).mtimeMs;
  } catch {
    return 0;
  }
}

function authGenerationFile(stateDir: string, generation: string): string {
  return path.join(stateDir, "auth", `bridge.${generation}.json`);
}

function ensureAuthPointerSource(stateDir: string, pointer: AuthStatePointer | null): void {
  if (!pointer) return;
  if (!fs.existsSync(pointer.authFile)) {
    throw new Error("OAuth generation state is missing; refusing to fall back to shared auth state");
  }
  const stat = fs.lstatSync(pointer.authFile);
  if (!stat.isFile() || stat.isSymbolicLink() || !within(pointer.authFile, path.join(stateDir, "auth"))) {
    throw new Error("OAuth generation state is not a bridge-owned regular file");
  }
}

export class StateDomainOwner {
  private released = false;

  constructor(
    readonly record: StateDomainOwnerRecord,
    private readonly lockFd: number,
    private readonly ownerToken: string,
  ) {}

  get generation(): string { return this.record.generation; }
  get stateDir(): string { return this.record.stateDir; }
  get authFile(): string { return this.record.authFile; }

  assertCurrent(): void {
    if (this.released) throw new Error("Bridge state generation is no longer authoritative");
    const current = readOwnerRecord(this.record.stateDir).owner;
    if (!current || current.generation !== this.record.generation || current.pid !== process.pid) {
      throw new Error("Bridge state generation is no longer authoritative; refusing to mutate OAuth state");
    }
    const lock = readLockRecord(this.record.stateDir).lock;
    if (!lock || lock.ownerToken !== this.ownerToken || lock.generation !== this.record.generation) {
      throw new Error("Bridge state ownership lock is no longer authoritative; refusing to mutate OAuth state");
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    const current = readOwnerRecord(this.record.stateDir).owner;
    if (current && current.generation === this.record.generation && current.pid === process.pid) {
      try { fs.rmSync(ownerFile(this.record.stateDir), { force: true }); } catch { /* best effort */ }
    }
    try { fs.closeSync(this.lockFd); } catch { /* best effort */ }
    const lock = readLockRecord(this.record.stateDir).lock;
    if (lock?.ownerToken === this.ownerToken && lock.generation === this.record.generation) {
      try { fs.rmSync(ownerLockFile(this.record.stateDir), { force: true }); } catch { /* best effort */ }
    }
  }
}

/**
 * Acquire one authoritative bridge generation for a state directory.  This
 * function is synchronous by design: startup must not initialize a writable
 * AuthStore until the OS-level create-once lock and owner record are durable.
 */
export function acquireStateDomainOwner(options: StateDomainOwnerOptions): StateDomainOwner {
  const stateDir = stateDirectories(options.stateDir ?? getStateDir(), options.workspaceRoot);
  if (stableWorkspaceId(canonicalizeWorkspaceRoot(options.workspaceRoot)) !== options.workspaceId) {
    throw new Error("C2C state owner workspace identity is invalid");
  }
  const processInspector = options.processInspector ?? getSystemProcessInspector();
  const processes = processInspector.list();
  if (processes === null) {
    throw new Error("Cannot establish C2C state-domain ownership because process identity inspection is unavailable");
  }
  rejectLiveRuntimePointers(stateDir, options.workspaceRoot, processes);

  const existingOwner = readOwnerRecord(stateDir);
  if (existingOwner.exists && !existingOwner.owner) {
    throw new Error("C2C state-domain owner record is invalid; refusing to share OAuth/runtime state");
  }
  if (existingOwner.owner) {
    const status = processIdentityStatus(existingOwner.owner.pid, existingOwner.owner.processStartIdentity, processes);
    if (status === "active") throw new Error(conflictMessage(existingOwner.owner));
    if (status === "unknown") {
      throw new Error("C2C state-domain owner identity is uncertain; refusing to recover or share OAuth/runtime state");
    }
    recoverStaleOwner(stateDir, existingOwner.owner);
  }

  const previousPointer = readAuthStatePointer(stateDir);

  const generation = randomUUID();
  const ownerToken = randomBytes(24).toString("base64url");
  const lockPath = ownerLockFile(stateDir);
  let lockFd: number | undefined;
  for (;;) {
    try {
      lockFd = fs.openSync(lockPath, "wx", 0o600);
      const lock: StateDomainLockRecord = {
        schema: STATE_DOMAIN_OWNER_SCHEMA,
        ownerToken,
        generation,
        stateDir,
        workspaceId: options.workspaceId,
        pid: process.pid,
        processStartIdentity: processes.find((candidate) => candidate.pid === process.pid)?.processStartIdentity ?? null,
        createdAt: new Date().toISOString(),
      };
      try {
        fs.writeFileSync(lockFd, JSON.stringify(lock), { encoding: "utf8" });
        try { fs.fsyncSync(lockFd); } catch { /* best effort */ }
      } catch (error) {
        try { fs.closeSync(lockFd); } catch { /* best effort */ }
        lockFd = undefined;
        try { fs.rmSync(lockPath, { force: true }); } catch { /* best effort */ }
        throw error;
      }
      const record: StateDomainOwnerRecord = {
        schema: STATE_DOMAIN_OWNER_SCHEMA,
        stateDir,
        generation,
        workspaceId: options.workspaceId,
        workspaceRoot: canonicalizeWorkspaceRoot(options.workspaceRoot),
        pid: process.pid,
        processStartIdentity: lock.processStartIdentity,
        acquiredAt: lock.createdAt,
        authFile: authGenerationFile(stateDir, generation),
      };
      try {
        writeSecureJson(ownerFile(stateDir), record);
      } catch (error) {
        try { fs.closeSync(lockFd); } catch { /* best effort */ }
        lockFd = undefined;
        try { fs.rmSync(lockPath, { force: true }); } catch { /* best effort */ }
        throw error;
      }
      return new StateDomainOwner(record, lockFd, ownerToken);
    } catch (error) {
      if (lockFd !== undefined) {
        try { fs.closeSync(lockFd); } catch { /* best effort */ }
        lockFd = undefined;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      const existingLock = readLockRecord(stateDir);
      const lockStatus = existingLock.lock
        ? processIdentityStatus(existingLock.lock.pid, existingLock.lock.processStartIdentity, processes)
        : "unknown";
      if (lockStatus === "active") throw new Error(conflictMessage(existingLock.lock));
      if (lockStatus === "unknown" && lockAgeMs(stateDir) < STATE_OWNER_STALE_LOCK_MS) {
        throw new Error("C2C state-domain lock identity is uncertain; refusing to share OAuth/runtime state");
      }
      if (lockStatus === "unknown" && lockAgeMs(stateDir) >= STATE_OWNER_STALE_LOCK_MS && !existingLock.lock) {
        // A lock that never reached durable metadata may be recovered only
        // after its bounded age; no live PID was ever trusted.
        recoverStaleLock(stateDir, null);
      } else if (lockStatus === "stale") {
        recoverStaleLock(stateDir, existingLock.lock);
      } else if (lockStatus === "unknown") {
        throw new Error("C2C state-domain lock identity is uncertain; refusing to recover or share OAuth/runtime state");
      } else {
        sleepForOwnerCheck();
      }
    }
  }
}

export function writeAuthStatePointer(owner: StateDomainOwner): void {
  owner.assertCurrent();
  writeSecureJson(authStatePointerFile(owner.stateDir), {
    schema: AUTH_STATE_POINTER_SCHEMA,
    generation: owner.generation,
    authFile: owner.authFile,
    updatedAt: new Date().toISOString(),
  } satisfies AuthStatePointer);
}

/** Resolve migration sources once, then fence all future writes to the new generation file. */
export function resolveOwnedAuthStorage(
  owner: StateDomainOwner,
  options: { canonicalFile?: string; legacyFiles?: readonly string[] } = {},
): OwnedAuthStorage {
  owner.assertCurrent();
  const authDir = path.join(owner.stateDir, "auth");
  const canonicalFile = path.resolve(options.canonicalFile ?? path.join(authDir, "bridge.json"));
  const configuredLegacy = [...new Set((options.legacyFiles ?? []).map((file) => path.resolve(file)))];
  const previous = readAuthStatePointer(owner.stateDir);
  const sources = previous
    ? [previous.authFile]
    : [canonicalFile, ...configuredLegacy];
  return {
    file: owner.authFile,
    legacyFiles: [...new Set(sources)].filter((file) => file !== owner.authFile),
  };
}
