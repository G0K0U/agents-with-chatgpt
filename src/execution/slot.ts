import fs from "node:fs";
import path from "node:path";
import { readWorkspaceQueuePauseState } from "./queue-state.js";
import { ensureDir, getStateDir } from "../config/paths.js";

/** One bridge-owned writer lease per workspace, shared by every provider. */
export interface WorkspaceSlotLock {
  version: 1;
  workspaceId: string;
  provider: "codex" | "gemini" | "z2c";
  taskId: string;
  sessionId?: string;
  pid: number;
  acquiredAt: string;
}

export interface WorkspaceSlotTaskState {
  workspaceId: string;
  status: string;
}

export interface WorkspaceSlotReconciliation {
  lock: WorkspaceSlotLock | null;
  cleared: boolean;
  reason?: "missing_task" | "terminal_task" | "inactive_task" | "invalid_lock" | "unresolved";
}

export interface WorkspaceSlotSweepResult {
  scanned: number;
  cleared: number;
}

export class WorkspaceSlotError extends Error {
  readonly code = "WORKSPACE_SLOT_BUSY";

  constructor(readonly lock: WorkspaceSlotLock | null) {
    super("The workspace already has an active task slot");
    this.name = "WorkspaceSlotError";
  }
}

const TASK_ID_PATTERN = /^c2c_[0-9a-f]{8,32}$/;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted", "timed_out"]);
const ACTIVE_STATUSES = new Set(["queued", "running", "cancelling"]);

const NATIVE_TASK_ID_PATTERN = /^z2c_[A-Za-z0-9_-]{1,100}$/;
const SESSION_ID_PATTERN = /^sess_[0-9a-f-]{36}$/i;
const RESERVATION_ID_PATTERN = /^[0-9a-f-]{36}$/i;

function assertSafeId(value: string, kind: "workspace" | "task"): void {
  const valid = kind === "workspace" ? WORKSPACE_ID_PATTERN.test(value) :
    TASK_ID_PATTERN.test(value) || NATIVE_TASK_ID_PATTERN.test(value) || RESERVATION_ID_PATTERN.test(value);
  if (!valid) throw new Error(`Invalid ${kind} id for workspace slot`);
}

export function workspaceSlotFile(workspaceId: string, stateDir?: string): string {
  assertSafeId(workspaceId, "workspace");
  return path.join(ensureDir(path.join(getStateDir(stateDir), "locks")), `${workspaceId}.json`);
}

interface RawLockRead {
  present: boolean;
  lock: WorkspaceSlotLock | null;
}

function validateLock(value: unknown): WorkspaceSlotLock | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.workspaceId !== "string" ||
    !WORKSPACE_ID_PATTERN.test(candidate.workspaceId) ||
    typeof candidate.taskId !== "string" ||
    !(TASK_ID_PATTERN.test(candidate.taskId) || NATIVE_TASK_ID_PATTERN.test(candidate.taskId) || RESERVATION_ID_PATTERN.test(candidate.taskId)) ||
    !(candidate.provider === undefined || ["codex", "gemini", "z2c"].includes(candidate.provider as string)) ||
    !(candidate.sessionId === undefined || typeof candidate.sessionId === "string" && SESSION_ID_PATTERN.test(candidate.sessionId)) ||
    typeof candidate.pid !== "number" ||
    !Number.isInteger(candidate.pid) ||
    candidate.pid <= 0 ||
    typeof candidate.acquiredAt !== "string"
  ) {
    return null;
  }
  return {
    version: 1,
    workspaceId: candidate.workspaceId,
    taskId: candidate.taskId,
    provider: (candidate.provider ?? "codex") as WorkspaceSlotLock["provider"],
    ...(typeof candidate.sessionId === "string" ? { sessionId: candidate.sessionId } : {}),
    pid: candidate.pid,
    acquiredAt: candidate.acquiredAt,
  };
}

function readRaw(workspaceId: string, stateDir?: string): RawLockRead {
  const file = workspaceSlotFile(workspaceId, stateDir);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return { present: true, lock: validateLock(parsed) };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { present: false, lock: null };
    }
    // An unreadable lease remains occupied until its writer can be identified.
    return { present: true, lock: null };
  }
}

export function readWorkspaceSlot(workspaceId: string, stateDir?: string): WorkspaceSlotLock | null {
  return readRaw(workspaceId, stateDir).lock;
}

function removeWorkspaceSlot(workspaceId: string, stateDir?: string): boolean {
  try {
    fs.unlinkSync(workspaceSlotFile(workspaceId, stateDir));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    // Best effort; a later reconciliation can retry the cleanup.
    return false;
  }
}

/** Remove the pre-bootstrap writer lease left by the abandoned queue code. */
function removeLegacyWriterLock(workspaceId: string, stateDir?: string): boolean {
  try {
    fs.unlinkSync(path.join(taskStateDir(workspaceId, stateDir), ".writer-lock.json"));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    return false;
  }
}

function taskStateDir(workspaceId: string, stateDir?: string): string {
  assertSafeId(workspaceId, "workspace");
  return ensureDir(path.join(getStateDir(stateDir), "tasks", workspaceId));
}

/**
 * Atomically claim the single writer slot.  A repeated claim by the same task
 * is idempotent so cancellation/terminal races cannot create a second lease.
 */
export function acquireWorkspaceSlot(
  workspaceId: string, taskId: string, stateDir?: string, provider: WorkspaceSlotLock["provider"] = "codex",
): WorkspaceSlotLock {
  assertSafeId(workspaceId, "workspace");
  assertSafeId(taskId, "task");
  if (readWorkspaceQueuePauseState(workspaceId, stateDir).paused) throw new Error("Workspace queue is paused");
  const file = workspaceSlotFile(workspaceId, stateDir);
  const existing = readRaw(workspaceId, stateDir);
  if (existing.lock) {
    if (existing.lock.taskId === taskId && existing.lock.provider === provider) return existing.lock;
    throw new WorkspaceSlotError(existing.lock);
  }
  if (existing.present) throw new WorkspaceSlotError(null);

  const lock: WorkspaceSlotLock = {
    version: 1,
    workspaceId,
    provider,
    taskId,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(lock, null, 2));
    fs.fsyncSync(fd);
    return lock;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST") {
      const raced = readWorkspaceSlot(workspaceId, stateDir);
      if (raced?.taskId === taskId && raced.provider === provider) return raced;
      throw new WorkspaceSlotError(raced);
    }
    throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Release only the lease owned by taskId.  The return value is true exactly
 * for the call that removed the current lock; repeated calls are harmless.
 */
export function releaseWorkspaceSlot(workspaceId: string, taskId: string, stateDir?: string): boolean {
  assertSafeId(workspaceId, "workspace");
  assertSafeId(taskId, "task");
  const current = readRaw(workspaceId, stateDir);
  if (!current.present) return false;
  if (!current.lock) return false;
  if (current.lock.taskId !== taskId) return false;
  return removeWorkspaceSlot(workspaceId, stateDir);
}

/**
 * Remove a ghost/inactive lock without trusting any path or task data from a
 * remote caller.  The task state is supplied by the local task registry.
 */
export function reconcileWorkspaceSlot(
  workspaceId: string,
  taskLookup: (taskId: string) => WorkspaceSlotTaskState | null,
  stateDir?: string
): WorkspaceSlotReconciliation {
  assertSafeId(workspaceId, "workspace");
  const legacyCleared = removeLegacyWriterLock(workspaceId, stateDir);
  const current = readRaw(workspaceId, stateDir);
  if (!current.present) return legacyCleared
    ? { lock: null, cleared: true, reason: "invalid_lock" }
    : { lock: null, cleared: false };
  if (!current.lock || current.lock.workspaceId !== workspaceId) {
    throw new WorkspaceSlotError(null);
  }
  if (current.lock.provider === "z2c") return { lock: current.lock, cleared: false, reason: "unresolved" };

  const task = taskLookup(current.lock.taskId);
  if (!task || task.workspaceId !== workspaceId) {
    removeWorkspaceSlot(workspaceId, stateDir);
    return { lock: null, cleared: true, reason: "missing_task" };
  }
  if (TERMINAL_STATUSES.has(task.status)) {
    removeWorkspaceSlot(workspaceId, stateDir);
    return { lock: null, cleared: true, reason: "terminal_task" };
  }
  if (!ACTIVE_STATUSES.has(task.status)) {
    removeWorkspaceSlot(workspaceId, stateDir);
    return { lock: null, cleared: true, reason: "inactive_task" };
  }
  return { lock: current.lock, cleared: false };
}

/**
 * Reconcile locks for workspace ids that are not part of this bridge's
 * authorized registry. Their task registries are intentionally not loaded,
 * so a per-manager reconciliation cannot see them. Codex/Gemini leases
 * follow task-registry cleanup; Z2C leases retain their upstream identity.
 */
export function reconcileUnknownWorkspaceSlots(
  authorizedWorkspaceIds: Iterable<string>,
  stateDir?: string
): WorkspaceSlotSweepResult {
  const authorized = new Set(authorizedWorkspaceIds);
  const locksDir = ensureDir(path.join(getStateDir(stateDir), "locks"));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(locksDir, { withFileTypes: true });
  } catch {
    return { scanned: 0, cleared: 0 };
  }
  let scanned = 0;
  let cleared = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const workspaceId = entry.name.slice(0, -5);
    if (!WORKSPACE_ID_PATTERN.test(workspaceId) || authorized.has(workspaceId)) continue;
    scanned += 1;
    const result = reconcileWorkspaceSlot(workspaceId, () => null, stateDir);
    if (result.cleared) cleared += 1;
  }
  return { scanned, cleared };
}

/** Bind the reserved slot to the upstream task and session returned by Z2C. */
export function bindWorkspaceSlot(
  workspaceId: string, reservationId: string, taskId: string, sessionId: string, stateDir?: string,
): WorkspaceSlotLock {
  const slot = readWorkspaceSlot(workspaceId, stateDir);
  if (!slot || slot.provider !== "z2c" || slot.taskId !== reservationId || slot.sessionId) {
    throw new Error("Workspace slot reservation mismatch");
  }
  if (!NATIVE_TASK_ID_PATTERN.test(taskId) || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("Invalid native task/session namespace");
  }
  const bound = { ...slot, taskId, sessionId };
  const file = workspaceSlotFile(workspaceId, stateDir);
  const temporary = file + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(bound, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
  return bound;
}
