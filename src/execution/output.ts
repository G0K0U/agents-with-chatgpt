import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { sanitizeExecutionCommand, sanitizeExecutionOutput } from "./sanitize.js";

export const MAX_OUTPUT_RECORDS = 40;

export interface ExecutionOutputMeta {
  id: number;
  command: string;
  exitCode: number | null;
  timestamp: string;
  taskId?: string;
  ownerId?: string;
  sessionId?: string;
  iteration?: number;
  allowed: boolean;
  restrictedReason?: string;
  truncated: boolean;
  sizeBytes: number;
}

interface OutputIndex {
  nextId: number;
  items: ExecutionOutputMeta[];
}

function outputDir(workspaceId: string, stateDir?: string): string {
  return ensureDir(path.join(getStateDir(stateDir), "execution-outputs", workspaceId));
}

function indexFile(workspaceId: string, stateDir?: string): string {
  return path.join(outputDir(workspaceId, stateDir), "index.json");
}

function bodyFile(workspaceId: string, id: number, stateDir?: string): string {
  return path.join(outputDir(workspaceId, stateDir), "bodies", `${id}.txt`);
}

function readIndex(workspaceId: string, stateDir?: string): OutputIndex {
  return (
    readJsonIfExists<OutputIndex>(indexFile(workspaceId, stateDir)) ?? {
      nextId: 1,
      items: [],
    }
  );
}

function writeIndex(workspaceId: string, index: OutputIndex, stateDir?: string): void {
  writeSecureJson(indexFile(workspaceId, stateDir), index);
}

export interface SaveOutputInput {
  command: string;
  raw: string;
  exitCode?: number | null;
  taskId?: string;
  ownerId?: string;
  sessionId?: string;
  iteration?: number;
}

export function saveExecutionOutput(workspaceId: string, input: SaveOutputInput, stateDir?: string): ExecutionOutputMeta {
  const sanitized = sanitizeExecutionOutput(input.raw);
  const index = readIndex(workspaceId, stateDir);
  const id = index.nextId;
  const timestamp = new Date().toISOString();
  const allowed = sanitized.allowed;
  const text = allowed ? sanitized.text : "";
  const truncated = allowed ? sanitized.truncated : false;
  const meta: ExecutionOutputMeta = {
    id,
    command: sanitizeExecutionCommand(input.command),
    exitCode: input.exitCode ?? null,
    timestamp,
    taskId: input.taskId,
    ownerId: input.ownerId,
    sessionId: input.sessionId,
    iteration: input.iteration,
    allowed,
    restrictedReason: allowed ? undefined : sanitized.reason,
    truncated,
    sizeBytes: Buffer.byteLength(text, "utf8"),
  };
  if (allowed && text) {
    const file = bodyFile(workspaceId, id, stateDir);
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, text, { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* ignore */
    }
  }
  index.nextId = id + 1;
  index.items.push(meta);
  while (index.items.length > MAX_OUTPUT_RECORDS) {
    const dropped = index.items.shift();
    if (dropped) {
      fs.rmSync(bodyFile(workspaceId, dropped.id, stateDir), { force: true });
    }
  }
  writeIndex(workspaceId, index, stateDir);
  return meta;
}

export function listExecutionOutputs(workspaceId: string, limit = 20, stateDir?: string): ExecutionOutputMeta[] {
  const items = readIndex(workspaceId, stateDir).items;
  return items.slice(-Math.max(1, Math.min(50, limit)));
}

export function readExecutionOutput(
  workspaceId: string,
  id: number,
  stateDir?: string
):
  | { ok: true; meta: ExecutionOutputMeta; text: string }
  | { ok: false; error: "NOT_FOUND" | "OUTPUT_RESTRICTED" } {
  const meta = readIndex(workspaceId, stateDir).items.find((item) => item.id === id);
  if (!meta) return { ok: false, error: "NOT_FOUND" };
  if (!meta.allowed) return { ok: false, error: "OUTPUT_RESTRICTED" };
  const file = bodyFile(workspaceId, id, stateDir);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  return { ok: true, meta, text };
}
