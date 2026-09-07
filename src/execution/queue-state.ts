import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, writeSecureJson } from "../config/paths.js";

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type QueueStateReason = "default" | "manual" | "invalid_state";

export interface WorkspaceQueuePauseState {
  workspaceId: string;
  paused: boolean;
  updatedAt: string | null;
  reason: QueueStateReason;
}

interface PersistedWorkspaceQueuePauseState {
  version: 1;
  workspaceId: string;
  paused: boolean;
  updatedAt: string;
}

export interface WorkspaceQueueStateView extends WorkspaceQueuePauseState {
  state: "running" | "paused";
  queuedTaskCount: number;
  nextQueuedTaskId: string | null;
  activeTask: { taskId: string; status: "running" | "cancelling" } | null;
  activeWriter: { provider: "codex" | "gemini" | "z2c"; taskId: string; sessionId: string | null; status: string } | null;
}

function assertWorkspaceId(workspaceId: string): void {
  if (typeof workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new Error("Invalid workspace id for queue state");
  }
}

export function workspaceQueueStateFile(workspaceId: string, stateDir?: string): string {
  assertWorkspaceId(workspaceId);
  return path.join(ensureDir(path.join(getStateDir(stateDir), "queues")), `${workspaceId}.json`);
}

function validPersistedState(value: unknown, workspaceId: string): value is PersistedWorkspaceQueuePauseState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 &&
    candidate.workspaceId === workspaceId &&
    typeof candidate.paused === "boolean" &&
    typeof candidate.updatedAt === "string" &&
    candidate.updatedAt.length > 0;
}

/**
 * Read bridge-owned queue state. A missing state means FIFO scheduling is
 * enabled. Any present-but-invalid state fails closed as paused so a corrupt
 * or partially tampered state can never release queued work automatically.
 */
export function readWorkspaceQueuePauseState(workspaceId: string, stateDir?: string): WorkspaceQueuePauseState {
  const file = workspaceQueueStateFile(workspaceId, stateDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { workspaceId, paused: false, updatedAt: null, reason: "default" };
    }
    return { workspaceId, paused: true, updatedAt: null, reason: "invalid_state" };
  }
  if (!validPersistedState(parsed, workspaceId)) {
    return { workspaceId, paused: true, updatedAt: null, reason: "invalid_state" };
  }
  return {
    workspaceId,
    paused: parsed.paused,
    updatedAt: parsed.updatedAt,
    reason: "manual",
  };
}

/** Persist one explicit bridge-owned pause/resume decision atomically. */
export function writeWorkspaceQueuePauseState(
  workspaceId: string,
  paused: boolean,
  stateDir?: string,
): WorkspaceQueuePauseState {
  const updatedAt = new Date().toISOString();
  writeSecureJson(workspaceQueueStateFile(workspaceId, stateDir), {
    version: 1,
    workspaceId,
    paused,
    updatedAt,
  } satisfies PersistedWorkspaceQueuePauseState);
  return { workspaceId, paused, updatedAt, reason: "manual" };
}

