import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir } from "../config/paths.js";

/**
 * Lightweight execution records written by the Codex harness after each
 * iteration (via `c2c record`). ChatGPT reads them through the
 * `execution_summary` and `test_status` MCP tools.
 */
export interface ExecutionRecord {
  taskId: string;
  /** Present on new bridge records; optional for legacy harness records. */
  workspaceId?: string;
  /** Present on bridge-dispatched records; absent only on legacy records. */
  ownerId?: string;
  sessionId?: string;
  provider?: string;
  orchestrator?: "legacy" | "omnigent";
  providerRuntime?: string;
  providerModel?: string;
  providerSessionId?: string;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    thinkingTokens?: number;
    cacheReadTokens?: number;
    totalTokens?: number;
  };
  /** Bridge-owned terminal task state; absent on legacy `c2c record` entries. */
  taskStatus?: string;
  /** Effective per-task network policy after local deployment validation. */
  network?: boolean;
  networkRequested?: boolean;
  networkEffective?: boolean;
  networkReported?: boolean | null;
  networkPolicy?: {
    requested: boolean;
    effective: boolean;
    reported: boolean | null;
  };
  iteration: number;
  changedFiles: string[] | number;
  tests: string | null;
  exitStatus: "ok" | "failed" | "blocked" | string;
  timestamp: string;
  notes?: string;
  /** Present when Codex recorded a sanitized command output for this iteration. */
  outputId?: number;
  outputAvailable?: boolean;
  restartRequired?: boolean;
  /** Present for the dedicated Engineering AI audit-mirror write capability. */
  auditMirror?: {
    logicalTarget: string;
    resolvedTarget: string | null;
    timestampUtc: string;
    byteCount: number | null;
    sha256: string | null;
    success: boolean;
    code: string;
    source: "payload" | "engineering_ai_ledger";
    targetFilename?: string;
    targetSha256?: string | null;
    freshness?: "fresh" | "stale" | "unknown";
    lastSuccessAtUtc?: string | null;
    lastSuccessSha256?: string | null;
  };
  /** Present for bridge-dispatched, typed verification profiles. */
  verification?: {
    profileId: string;
    workspaceId: string;
    executable: string;
    argvHash: string;
    cwd: "workspace:/" | "c2c-runtime:/verification";
    startedAt: string;
    completedAt?: string;
    exitCode: number | null;
    network: false;
    sandbox: "readOnly" | "workspaceWrite";
    status: "running" | "passed" | "failed" | "timed_out" | "cancelled";
    outputId?: number;
  };
}

function recordsFile(workspaceId: string, stateDir?: string): string {
  const dir = ensureDir(path.join(getStateDir(stateDir), "executions"));
  return path.join(dir, `${workspaceId}.jsonl`);
}

export function appendExecutionRecord(workspaceId: string, record: ExecutionRecord, stateDir?: string): void {
  const file = recordsFile(workspaceId, stateDir);
  // New records always carry an explicit effective policy. Legacy callers
  // that do not know about network remain safely represented as offline.
  const effective = record.networkEffective ?? (record.network === true);
  const requested = record.networkRequested ?? effective;
  const reported = record.networkReported ?? null;
  const persisted: ExecutionRecord = {
    ...record,
    network: effective,
    networkRequested: requested,
    networkEffective: effective,
    networkReported: reported,
    networkPolicy: { requested, effective, reported },
  };
  const line = JSON.stringify(persisted) + "\n";
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "a", 0o600);
    fs.writeSync(fd, line, null, "utf8");
    // Flush the execution line so a crash cannot leave a durable terminal
    // task record and an uncommitted execution record out of sync.
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export function readExecutionRecords(workspaceId: string, limit = 10, stateDir?: string): ExecutionRecord[] {
  const file = recordsFile(workspaceId, stateDir);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const records: ExecutionRecord[] = [];
  const boundedLimit = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(limit)));
  for (const line of boundedLimit === 0 ? [] : lines.slice(-boundedLimit)) {
    try {
      records.push(JSON.parse(line) as ExecutionRecord);
    } catch {
      // skip corrupt lines
    }
  }
  return records;
}

/**
 * Find a task's newest execution record without relying on the recent-summary
 * window. Startup recovery uses this for older tasks that are no longer in
 * the last few records.
 */
export function latestExecutionRecordForTask(workspaceId: string, taskId: string, stateDir?: string): ExecutionRecord | null {
  const file = recordsFile(workspaceId, stateDir);
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      const record = JSON.parse(line) as ExecutionRecord;
      if (
        record.taskId === taskId &&
        (record.workspaceId === undefined || record.workspaceId === workspaceId)
      ) {
        return record;
      }
    } catch {
      // Continue past a corrupt line to find an older valid task record.
    }
  }
  return null;
}

export function latestExecutionRecord(workspaceId: string, stateDir?: string): ExecutionRecord | null {
  const records = readExecutionRecords(workspaceId, 1, stateDir);
  return records[records.length - 1] ?? null;
}
