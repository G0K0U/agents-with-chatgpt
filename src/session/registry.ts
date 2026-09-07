import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { getStateDir, writeSecureJson } from "../config/paths.js";
import { redact } from "../logger/index.js";

export type C2CSessionStatus = "active" | "completed" | "cancelled" | "archived";

export interface C2CSession {
  id: string;
  workspaceId: string;
  ownerId: string;
  title: string;
  goalSummary: string;
  status: C2CSessionStatus;
  provider?: string;
  providerModel?: string;
  providerSessionId?: string;
  lastTaskId?: string;
  /** Bridge-owned submission order used to ignore late updates from older tasks. */
  lastTaskSequence?: number;
  changedFiles: string[];
  verificationStatus: string | null;
  currentState: string;
  nextIntendedAction: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionTaskUpdate {
  sessionId: string;
  ownerId: string;
  workspaceId: string;
  taskId: string;
  status: string;
  provider?: string;
  providerModel?: string;
  providerSessionId?: string;
  changedFiles: string[];
  tests: string | null;
  verificationStatus: string | null;
  restartRequired?: boolean;
  taskSequence?: number;
  /** Set only by the bridge after the task registry has reached terminal truth. */
  authoritativeTerminal?: boolean;
}

export type SessionRegistryErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_AUTHORIZED"
  | "SESSION_WORKSPACE_MISMATCH"
  | "SESSION_REGISTRY_INVALID";

export class SessionRegistryError extends Error {
  constructor(public readonly code: SessionRegistryErrorCode, message: string) {
    super(message);
    this.name = "SessionRegistryError";
  }
}

interface PersistedSessionRegistry {
  version: 1;
  sessions: C2CSession[];
}

const SESSION_ID_PATTERN = /^c2cs_[0-9a-f]{16,32}$/;
const TASK_ID_PATTERN = /^c2c_[0-9a-f]{8,32}$/;
const MAX_TITLE = 120;
const MAX_GOAL = 500;
const MAX_FILES = 50;
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:ghp|github_pat|xox[baprs])-[A-Za-z0-9_-]{16,}\b/gi,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSessionFile(file: string): Partial<PersistedSessionRegistry> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PersistedSessionRegistry>;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new SessionRegistryError("SESSION_REGISTRY_INVALID", "Session registry cannot be read");
  }
}

function sanitizeText(value: string, max: number): string {
  let text = redact(value).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[REDACTED]");
  // Continuation metadata may be returned to ChatGPT. Replace local path
  // syntax rather than attempting to preserve any portion of the path.
  text = text
    .replace(/\\\\[^\s"'`<>]+/g, "[local-path]")
    .replace(/\b[A-Za-z]:[\\/][^\s"'`<>]+/g, "[local-path]")
    .replace(/(?:^|[\s(])\/(?:Users|home|private|tmp|var)\/[^\s"'`<>]+/g, "$1[local-path]");
  return text.slice(0, max);
}

function safeRelativeFile(value: string): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".." || part === "")) return null;
  return normalized.slice(0, 300);
}

function safeFiles(values: string[]): string[] {
  return [...new Set(values.map(safeRelativeFile).filter((value): value is string => value !== null))].slice(0, MAX_FILES);
}

function sessionStateForTask(status: string): string {
  // Keep the session state aligned with the task lifecycle vocabulary.  The
  // bridge currently publishes timeouts as either `failed` + exitStatus
  // `timeout` or the forward-compatible `timed_out` status; neither may be
  // mistaken for a successful continuation state.
  if (status === "timeout" || status === "timed_out") return "failed";
  return status;
}

const TERMINAL_SESSION_STATES = new Set(["completed", "failed", "cancelled", "interrupted"]);

function validateSession(value: unknown): C2CSession {
  if (!isRecord(value)) throw new SessionRegistryError("SESSION_REGISTRY_INVALID", "Invalid session record");
  if (
    typeof value.id !== "string" ||
    !SESSION_ID_PATTERN.test(value.id) ||
    typeof value.workspaceId !== "string" ||
    typeof value.ownerId !== "string" ||
    typeof value.title !== "string" ||
    typeof value.goalSummary !== "string" ||
    !["active", "completed", "cancelled", "archived"].includes(String(value.status)) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new SessionRegistryError("SESSION_REGISTRY_INVALID", "Invalid session record");
  }
  const changedFiles = Array.isArray(value.changedFiles)
    ? value.changedFiles.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    ownerId: value.ownerId,
    title: sanitizeText(value.title, MAX_TITLE),
    goalSummary: sanitizeText(value.goalSummary, MAX_GOAL),
    status: value.status as C2CSessionStatus,
    provider: typeof value.provider === "string" ? sanitizeText(value.provider, 40) : undefined,
    providerModel: typeof value.providerModel === "string" ? sanitizeText(value.providerModel, 80) : undefined,
    providerSessionId: typeof value.providerSessionId === "string" ? sanitizeText(value.providerSessionId, 120) : undefined,
    lastTaskId: typeof value.lastTaskId === "string" && TASK_ID_PATTERN.test(value.lastTaskId) ? value.lastTaskId : undefined,
    lastTaskSequence:
      typeof value.lastTaskSequence === "number" && Number.isSafeInteger(value.lastTaskSequence) && value.lastTaskSequence > 0
        ? value.lastTaskSequence
        : undefined,
    changedFiles: safeFiles(changedFiles),
    verificationStatus: typeof value.verificationStatus === "string" ? sanitizeText(value.verificationStatus, 80) : null,
    currentState: typeof value.currentState === "string" ? sanitizeText(value.currentState, 120) : "created",
    nextIntendedAction:
      typeof value.nextIntendedAction === "string" ? sanitizeText(value.nextIntendedAction, 240) : null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

/** Persistent continuation metadata. Raw conversations and chain-of-thought are never stored. */
export class C2CSessionRegistry {
  readonly file: string;
  private readonly sessions = new Map<string, C2CSession>();

  constructor(opts: { file?: string; stateDir?: string } = {}) {
    this.file = opts.file ?? path.join(getStateDir(opts.stateDir), "sessions", "registry.json");
    this.load();
  }

  private load(): void {
    const data = readSessionFile(this.file);
    if (!data) return;
    if (data.version !== undefined && data.version !== 1) {
      throw new SessionRegistryError("SESSION_REGISTRY_INVALID", "Unsupported session registry version");
    }
    if (!Array.isArray(data.sessions)) {
      throw new SessionRegistryError("SESSION_REGISTRY_INVALID", "Session registry must contain sessions");
    }
    for (const raw of data.sessions) {
      const session = validateSession(raw);
      if (this.sessions.has(session.id)) {
        throw new SessionRegistryError("SESSION_REGISTRY_INVALID", "Duplicate session id");
      }
      this.sessions.set(session.id, session);
    }
  }

  private save(): void {
    const data: PersistedSessionRegistry = { version: 1, sessions: [...this.sessions.values()] };
    writeSecureJson(this.file, data);
  }

  /** Allocate an id without writing a partially-created session to disk. */
  allocateId(): string {
    let id = "";
    do {
      id = `c2cs_${randomBytes(12).toString("hex")}`;
    } while (this.sessions.has(id));
    return id;
  }

  create(input: {
    ownerId: string;
    workspaceId: string;
    title: string;
    goalSummary: string;
    /** Local task submission may reserve the id before this record is saved. */
    id?: string;
    provider?: string;
    providerModel?: string;
    providerSessionId?: string;
    lastTaskId?: string;
    lastTaskSequence?: number;
  }): C2CSession {
    const now = new Date().toISOString();
    const id = input.id ?? this.allocateId();
    if (!SESSION_ID_PATTERN.test(id) || this.sessions.has(id)) {
      throw new SessionRegistryError("SESSION_REGISTRY_INVALID", "Session id is invalid or already exists");
    }
    if (input.lastTaskId !== undefined && !TASK_ID_PATTERN.test(input.lastTaskId)) {
      throw new SessionRegistryError("SESSION_REGISTRY_INVALID", "Session lastTaskId is invalid");
    }
    if (input.lastTaskSequence !== undefined &&
      (!Number.isSafeInteger(input.lastTaskSequence) || input.lastTaskSequence < 1)) {
      throw new SessionRegistryError("SESSION_REGISTRY_INVALID", "Session lastTaskSequence is invalid");
    }
    const session: C2CSession = {
      id,
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      title: sanitizeText(input.title, MAX_TITLE) || "C2C work session",
      goalSummary: sanitizeText(input.goalSummary, MAX_GOAL) || "Continue the selected workspace task",
      status: "active",
      provider: input.provider !== undefined ? sanitizeText(input.provider, 40) : undefined,
      providerModel: input.providerModel !== undefined ? sanitizeText(input.providerModel, 80) : undefined,
      providerSessionId: input.providerSessionId !== undefined ? sanitizeText(input.providerSessionId, 120) : undefined,
      lastTaskId: input.lastTaskId,
      lastTaskSequence: input.lastTaskSequence,
      changedFiles: [],
      verificationStatus: null,
      currentState: "created",
      nextIntendedAction: "Inspect the selected workspace and submit the next bounded task.",
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    this.save();
    return { ...session, changedFiles: [...session.changedFiles] };
  }

  getOwned(sessionId: string, ownerId: string, workspaceId?: string): C2CSession {
    const session = this.sessions.get(sessionId);
    if (!session || !SESSION_ID_PATTERN.test(sessionId)) {
      throw new SessionRegistryError("SESSION_NOT_FOUND", "Unknown session");
    }
    if (session.ownerId !== ownerId) {
      throw new SessionRegistryError("SESSION_NOT_AUTHORIZED", "Session is not owned by this authenticated identity");
    }
    if (workspaceId !== undefined && session.workspaceId !== workspaceId) {
      throw new SessionRegistryError("SESSION_WORKSPACE_MISMATCH", "Session is bound to another workspace");
    }
    return { ...session, changedFiles: [...session.changedFiles] };
  }

  /** Local-only snapshot used by the task submission transaction rollback. */
  snapshot(sessionId: string, ownerId: string, workspaceId?: string): C2CSession {
    return this.getOwned(sessionId, ownerId, workspaceId);
  }

  /**
   * Restore one session record after a failed multi-file task submission.
   * This method is intentionally not exposed through MCP; it is part of the
   * bridge's local persistence transaction only.
   */
  restoreSnapshot(session: C2CSession): void {
    this.sessions.set(session.id, { ...session, changedFiles: [...session.changedFiles] });
    this.save();
  }

  /** Remove a just-created session when its task could not be persisted. */
  remove(sessionId: string, ownerId: string, workspaceId?: string): void {
    const session = this.getOwned(sessionId, ownerId, workspaceId);
    this.sessions.delete(session.id);
    this.save();
  }

  listForOwner(ownerId: string, workspaceIds: Iterable<string>, limit = 20): C2CSession[] {
    const allowed = new Set(workspaceIds);
    return [...this.sessions.values()]
      .filter((session) => session.ownerId === ownerId && allowed.has(session.workspaceId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(1, Math.min(50, limit)))
      .map((session) => ({ ...session, changedFiles: [...session.changedFiles] }));
  }

  updateFromTask(update: SessionTaskUpdate): C2CSession {
    if (!TASK_ID_PATTERN.test(update.taskId)) {
      throw new SessionRegistryError("SESSION_REGISTRY_INVALID", "Task id is invalid");
    }
    const session = this.getOwned(update.sessionId, update.ownerId, update.workspaceId);
    if (session.lastTaskSequence !== undefined) {
      if (update.taskSequence === undefined && session.lastTaskId !== update.taskId) {
        // A legacy task without a durable sequence cannot supersede a newer
        // task whose submission order is known.
        return session;
      }
      if (update.taskSequence !== undefined && update.taskSequence < session.lastTaskSequence) {
        // An older task can finish after a newer task was submitted. Its late
        // lifecycle update must not move session.lastTaskId backwards.
        return session;
      }
      if (
        update.taskSequence !== undefined &&
        update.taskSequence === session.lastTaskSequence &&
        session.lastTaskId !== undefined &&
        session.lastTaskId !== update.taskId
      ) {
        // Equal sequence values are only valid for lifecycle updates of the
        // same task.  A different task must not win through a malformed or
        // migrated queue position.
        return session;
      }
    }
    const currentState = sessionStateForTask(session.currentState);
    const sameTask = session.lastTaskId === update.taskId && (
      update.taskSequence === undefined ||
      session.lastTaskSequence === undefined ||
      update.taskSequence === session.lastTaskSequence
    );
    if (
      sameTask &&
      TERMINAL_SESSION_STATES.has(currentState) &&
      !update.authoritativeTerminal
    ) {
      // App Server/JSONL evidence is not allowed to move a session backwards
      // after the bridge has published terminal task truth.  A subsequent
      // bridge reconciliation may replace stale terminal metadata, but that
      // path must explicitly identify itself as authoritative and is derived
      // from the task registry rather than from the historical event.
      return session;
    }
    session.lastTaskId = update.taskId;
    if (update.taskSequence !== undefined) session.lastTaskSequence = update.taskSequence;
    if (update.provider !== undefined) session.provider = sanitizeText(update.provider, 40);
    if (update.providerModel !== undefined) session.providerModel = sanitizeText(update.providerModel, 80);
    if (update.providerSessionId !== undefined) session.providerSessionId = sanitizeText(update.providerSessionId, 120);
    session.changedFiles = safeFiles([...session.changedFiles, ...update.changedFiles]);
    session.verificationStatus = update.verificationStatus ?? (update.tests ? sanitizeText(update.tests, 80) : null);
    const sessionState = sessionStateForTask(update.status);
    session.currentState = sanitizeText(sessionState, 120);
    const restart = update.restartRequired ? " Restart the bridge through its local supervisor before the new source is live." : "";
    session.nextIntendedAction = ["queued", "running", "cancelling"].includes(sessionState)
      ? `Wait for the queued task to reach a terminal state, then review its result.${restart}`
      : sessionState === "completed"
        ? `Review git diff and verification output, then submit the next bounded task.${restart}`
        : `Inspect the task result and continue with a new bounded task.${restart}`;
    session.updatedAt = new Date().toISOString();
    this.sessions.set(session.id, session);
    this.save();
    return { ...session, changedFiles: [...session.changedFiles] };
  }

  /** Local-only lifecycle operation; there is deliberately no MCP mutation tool for it. */
  setStatus(sessionId: string, ownerId: string, status: C2CSessionStatus): C2CSession {
    const session = this.getOwned(sessionId, ownerId);
    session.status = status;
    session.updatedAt = new Date().toISOString();
    this.sessions.set(session.id, session);
    this.save();
    return { ...session, changedFiles: [...session.changedFiles] };
  }
}
