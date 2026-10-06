import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentSessionRecord, AgentProviderName, AgentTaskView } from "../types.js";
import type { AppendableActivityEvent } from "../store.js";
import { visibleText } from "../redact.js";

/**
 * Codex/Gemini adapter: projects the A2C bridge's own durable task records
 * (`<stateDir>/tasks/<workspaceId>/<taskId>.json`) into shared plane session
 * records, one per C2C session id, grouped by provider. These are always
 * origin "a2c". Read-only: task files remain the source of truth.
 *
 * Visible content only: the bounded instruction preview and assistant output
 * references are redacted/bounded; chain-of-thought is never present in task
 * records, and output BODIES are only served through the sanitized execution
 * output reader.
 */

const SESSION_ID_PATTERN = /^c2cs_[0-9a-zA-Z_-]{8,64}$/;
const DSH_SESSION_ID_PATTERN = /^session-d2c-[0-9a-f]{32}$/;
const MAX_TASKS_PER_WORKSPACE = 200;

interface TaskFileLike {
  taskId?: unknown;
  workspaceId?: unknown;
  ownerId?: unknown;
  sessionId?: unknown;
  instruction?: unknown;
  instructionHash?: unknown;
  provider?: unknown;
  providerModel?: unknown;
  effort?: unknown;
  selectionScope?: unknown;
  providerSessionId?: unknown;
  threadId?: unknown;
  status?: unknown;
  exitStatus?: unknown;
  submittedAt?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
  queuePosition?: unknown;
  changedFiles?: unknown;
  outputIds?: unknown;
  outputAvailable?: unknown;
  networkRequested?: unknown;
  networkEffective?: unknown;
  continuation?: { effort?: unknown };
  actionEvidence?: { turnCompleted?: unknown; changedFiles?: unknown; finalOutputCaptured?: unknown };
  nativeEvidence?: { terminalSeq?: unknown; terminalReason?: unknown; toolCalls?: unknown; toolResults?: unknown;
    servedModel?: unknown; servedEffort?: unknown; servedProvider?: unknown };
  verification?: { status?: unknown; exitCode?: unknown; completedAt?: unknown; outputId?: unknown };
  error?: { code?: unknown; message?: unknown };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readTaskFile(file: string): TaskFileLike | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as TaskFileLike;
  } catch {
    return null;
  }
}

function providerOf(record: TaskFileLike): AgentProviderName | null {
  const provider = str(record.provider);
  if (provider === "codex" || provider === "gemini" || provider === "dsh") return provider;
  return null;
}

function taskTimestamp(record: TaskFileLike): number {
  const submitted = Date.parse(str(record.submittedAt) ?? "");
  if (Number.isFinite(submitted)) return submitted;
  return 0;
}

/** Read task records for the given workspaces, newest first, bounded. */
export function readWorkspaceTasks(stateDir: string, workspaceIds: string[]): Array<{ workspaceId: string; record: TaskFileLike }> {
  const out: Array<{ workspaceId: string; record: TaskFileLike }> = [];
  for (const workspaceId of workspaceIds) {
    const dir = join(stateDir, "tasks", workspaceId);
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    const withMtime = files
      .map((f) => {
        try {
          return { f, m: statSync(join(dir, f)).mtimeMs };
        } catch {
          return { f, m: 0 };
        }
      })
      .sort((a, b) => b.m - a.m)
      .slice(0, MAX_TASKS_PER_WORKSPACE);
    for (const { f } of withMtime) {
      const record = readTaskFile(join(dir, f));
      if (record && str(record.taskId)) out.push({ workspaceId, record });
    }
  }
  return out;
}

export function projectProviderTasks(input: {
  stateDir: string;
  workspaces: Array<{ workspaceId: string; canonicalPath: string }>;
  observedAt: string;
}): { records: AgentSessionRecord[]; events: AppendableActivityEvent[] } {
  const { stateDir, workspaces, observedAt } = input;
  const tasks = readWorkspaceTasks(stateDir, workspaces.map((w) => w.workspaceId));

  interface Aggregate {
    provider: AgentProviderName;
    workspaceId: string;
    canonicalRoot: string;
    providerSessionId: string | null;
    nativeSessionId: string | null;
    model: string | null;
    thoughtLevel: string | null;
    ownerClientId: string | null;
    status: string;
    taskIds: string[];
    instruction: string | null;
    submittedAt: string | null;
    completedAt: string | null;
    changedFilesCount: number;
    verificationStatus: string | null;
    outputRef: { workspaceId: string; outputId: number } | null;
  }
  const sessions = new Map<string, Aggregate>();
  const records: AgentSessionRecord[] = [];
  const events: AppendableActivityEvent[] = [];

  // Newest task first so "latest" aggregation below sees the newest first.
  tasks.sort((a, b) => taskTimestamp(b.record) - taskTimestamp(a.record));

  for (const { workspaceId, record } of tasks) {
    const provider = providerOf(record);
    const taskId = str(record.taskId);
    if (!provider || !taskId) continue;
    const workspace = workspaces.find((w) => w.workspaceId === workspaceId);
    if (!workspace) continue;

    const status = str(record.status) ?? "unknown";
    const terminal = status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted" || status === "timed_out";
    const outputIds = Array.isArray(record.outputIds) ? record.outputIds.map(num).filter((n): n is number => n !== null) : [];
    const outputRef = outputIds.length > 0 ? { workspaceId, outputId: outputIds[0] } : null;
    events.push({
      key: `${provider}:task:${taskId}:${status}`,
      at: str(record.completedAt) ?? str(record.startedAt) ?? str(record.submittedAt) ?? observedAt,
      type: status === "completed" ? "task.completed" : terminal ? "task.failed" : "task.updated",
      provider,
      workspaceId,
      sessionId: str(record.sessionId),
      taskId,
      summary: `${provider} task ${status}`,
      outputRef,
    });

    const sessionId = str(record.sessionId);
    if (!sessionId || !(SESSION_ID_PATTERN.test(sessionId) || DSH_SESSION_ID_PATTERN.test(sessionId))) continue;
    const existing = sessions.get(sessionId);
    if (existing) {
      if (existing.taskIds.length < 50 && !existing.taskIds.includes(taskId)) existing.taskIds.push(taskId);
      continue;
    }
    const changedFiles = Array.isArray(record.changedFiles) ? record.changedFiles.map((f) => str(f)).filter((f): f is string => f !== null) : [];
    sessions.set(sessionId, {
      provider,
      workspaceId,
      canonicalRoot: workspace.canonicalPath,
      providerSessionId: str(record.providerSessionId) ?? str(record.threadId),
      nativeSessionId: str(record.threadId) ?? str(record.providerSessionId),
      model: str(record.providerModel),
      thoughtLevel: str(record.effort) ?? str(record.continuation?.effort),
      ownerClientId: str(record.ownerId),
      status,
      taskIds: [taskId],
      instruction: visibleText(str(record.instruction), 2000),
      submittedAt: str(record.submittedAt),
      completedAt: str(record.completedAt),
      changedFilesCount: num(record.actionEvidence?.changedFiles) ?? changedFiles.length,
      verificationStatus: str(record.verification?.status),
      outputRef: outputIds.length > 0 ? { workspaceId, outputId: outputIds[0] } : null,
    });
  }

  for (const [sessionId, agg] of sessions) {
    records.push({
      sessionId,
      provider: agg.provider,
      origin: "a2c",
      workspaceId: agg.workspaceId,
      canonicalRoot: agg.canonicalRoot,
      nativeSessionId: agg.nativeSessionId,
      providerSessionId: agg.providerSessionId,
      ownerClientId: agg.ownerClientId,
      controllers: [...new Set([agg.ownerClientId ?? "local", "local"])],
      model: agg.model,
      thoughtLevel: agg.thoughtLevel,
      status: agg.status,
      title: agg.instruction ? agg.instruction.slice(0, 120) : null,
      createdAt: agg.submittedAt ?? observedAt,
      updatedAt: agg.completedAt ?? agg.submittedAt ?? observedAt,
      taskIds: agg.taskIds,
      lastUserInstruction: agg.instruction,
      lastAssistantOutput: agg.outputRef,
      changedFilesCount: agg.changedFilesCount,
      verificationStatus: agg.verificationStatus,
      observedAt,
    });
  }

  return { records, events };
}

/** Bounded, redacted task view for agent_task_read (observe-authorized callers). */
export function taskView(workspaceId: string, record: TaskFileLike): AgentTaskView {
  const changedFiles = Array.isArray(record.changedFiles)
    ? record.changedFiles.map((f) => str(f)).filter((f): f is string => f !== null).slice(0, 100)
    : [];
  const outputIds = Array.isArray(record.outputIds) ? record.outputIds.map(num).filter((n): n is number => n !== null) : [];
  return {
    taskId: str(record.taskId) ?? "",
    workspaceId,
    sessionId: str(record.sessionId),
    provider: providerOf(record),
    providerSessionId: str(record.providerSessionId) ?? str(record.threadId),
    model: str(record.providerModel),
    effort: str(record.effort),
    selectionScope: str(record.selectionScope),
    status: str(record.status) ?? "unknown",
    exitStatus: str(record.exitStatus),
    submittedAt: str(record.submittedAt),
    startedAt: str(record.startedAt),
    completedAt: str(record.completedAt),
    ownerId: str(record.ownerId),
    instructionPreview: visibleText(str(record.instruction), 500),
    changedFilesCount: num(record.actionEvidence?.changedFiles) ?? changedFiles.length,
    changedFiles,
    networkRequested: bool(record.networkRequested),
    networkEffective: bool(record.networkEffective),
    outputIds,
    outputAvailable: record.outputAvailable === true,
    actionEvidence: record.actionEvidence
      ? {
          turnCompleted: record.actionEvidence.turnCompleted === true,
          changedFiles: num(record.actionEvidence.changedFiles) ?? 0,
          finalOutputCaptured: record.actionEvidence.finalOutputCaptured === true,
        }
      : null,
    nativeEvidence: record.nativeEvidence
      ? { terminalSeq: num(record.nativeEvidence.terminalSeq),
          terminalReason: str(record.nativeEvidence.terminalReason),
          toolCalls: num(record.nativeEvidence.toolCalls) ?? 0,
          toolResults: num(record.nativeEvidence.toolResults) ?? 0,
          servedModel: str(record.nativeEvidence.servedModel),
          servedEffort: str(record.nativeEvidence.servedEffort),
          servedProvider: str(record.nativeEvidence.servedProvider) }
      : null,
    verification: record.verification
      ? {
          status: str(record.verification.status),
          exitCode: num(record.verification.exitCode),
          completedAt: str(record.verification.completedAt),
          outputId: num(record.verification.outputId),
        }
      : null,
    error: record.error
      ? {
          code: str(record.error.code) ?? undefined,
          message: visibleText(str(record.error.message), 500) ?? undefined,
        }
      : null,
  };
}

export { readTaskFile };
