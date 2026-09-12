/**
 * Governed C2C → ZCode queue control plane.
 *
 * The MCP layer exposes exactly four tools over the fixed governed ZCode scheduled
 * queue (enqueue / get / list / cancel-request). This module owns every
 * filesystem interaction with that queue and enforces the governance contract:
 *
 * - The queue root is a compile-time constant; callers can never pass a path.
 * - Every truth file must be a regular file inside the real root: symlinks,
 *   junctions and reparse-point escapes fail closed.
 * - JSONL truth files are parsed strictly: one malformed line fails the whole
 *   read (never skip-and-continue).
 * - Appends are serialized per file (in-process mutex) so concurrent enqueues
 *   can never interleave partial JSON lines.
 * - Single-file reads are capped at 8 MiB for queue.jsonl / control.jsonl.
 *   receipts.jsonl scales with executed history: it is read with bounded
 *   streaming (per-record cap, total size never rejects the file) and the
 *   coordinator rotates it into deterministic receipts.NNNNNN.jsonl segments
 *   inside the same canonical root. History is never deleted or rewritten.
 * - Credential-shaped instructions are rejected at enqueue time.
 * - Cancellation only ever appends CANCEL_REQUESTED to control.jsonl. Terminal
 *   receipts (COMPLETED/FAILED/CANCELLED) are written exclusively by the ZCode
 *   queue coordinator; this control plane can never write them.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { sanitizeExecutionOutput } from "./sanitize.js";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";

/**
 * The only queue root this control plane may ever touch. Operator-configured
 * via C2C_ZCODE_QUEUE_ROOT; unset by default so the queue fails closed
 * instead of baking a machine-local path into the product.
 */
export const FIXED_ZCODE_QUEUE_ROOT = process.env.C2C_ZCODE_QUEUE_ROOT?.trim() ?? "";

const QUEUE_FILE = "queue.jsonl";
const RECEIPTS_FILE = "receipts.jsonl";
const CONTROL_FILE = "control.jsonl";
const STATE_FILE = "worker-state.json";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
// Lifecycle receipts scale with real executed history, so the receipts file is
// NOT subject to the whole-file read cap: it is read with bounded streaming
// and rotated into deterministic segments. Every single record is still
// strictly bounded and every malformed record fails closed.
const RECEIPTS_ROTATE_BYTES = 8 * 1024 * 1024;
const MAX_RECEIPT_LINE_BYTES = 1024 * 1024;
const RECEIPTS_SEGMENT_PATTERN = /^receipts\.(\d{6})\.jsonl$/;
const MAX_INSTRUCTION_CHARS = 100_000;
const MAX_LISTED_TASKS = 100;
const MAX_INSTRUCTION_EXCERPT = 600;
const MAX_STRINGS_PER_FIELD = 20;
const MAX_STRING_FIELD_CHARS = 160;
const MAX_RECEIPTS_PER_TASK = 50;
const PRIORITY_LIMIT = 1_000_000;

const TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/;
const ROLES = ["worker", "reviewer", "admin", "task"] as const;
const MODES = ["read", "write", "verify"] as const;
const TERMINAL_EVENTS = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

export type ZcodeRole = (typeof ROLES)[number];
export type ZcodeMode = (typeof MODES)[number];
export type ZcodeTaskStatus = "queued" | "cancel_requested" | "running" | "completed" | "failed" | "cancelled";

export class ZcodeControlError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ZcodeControlError";
  }
}

export interface ZcodeTaskInput {
  task_id?: string;
  role: ZcodeRole;
  priority: number;
  instruction: string;
  /** Runtime-typed so a network=true submission can be rejected (never stored). */
  network?: boolean;
  mode?: ZcodeMode;
  resources?: string[];
  exclusive_paths?: string[];
  depends_on?: string[];
}

export interface ZcodeTaskRecord {
  task_id: string;
  created_at: string;
  role: ZcodeRole;
  priority: number;
  instruction: string;
  network: false;
  mode?: ZcodeMode;
  resources?: string[];
  exclusive_paths?: string[];
  depends_on?: string[];
}

interface ReceiptRecord {
  task_id?: unknown;
  timestamp?: unknown;
  event?: unknown;
  [extra: string]: unknown;
}

interface ControlRecord {
  event?: unknown;
  task_id?: unknown;
  timestamp?: unknown;
}

export interface ZcodeTaskView {
  task_id: string;
  created_at: string;
  role: ZcodeRole;
  priority: number;
  status: ZcodeTaskStatus;
  mode: ZcodeMode | null;
  resources: string[];
  exclusive_paths: string[];
  depends_on: string[];
  instruction_excerpt: string;
  receipts: { event: string; timestamp: string; model: string | null }[];
  cancel_requested: boolean;
  error: string | null;
}

/**
 * Credential-shaped content is rejected outright. The listed terms fail on
 * any word-boundary occurrence; weaker generic markers fail in their
 * `key[:=]value` shape. The bridge must never become a credential transport.
 */
const CREDENTIAL_BARE = [
  /\bapi[_-]?key\b/i,
  /\bclient[_-]?secret\b/i,
  /\baccess[_-]?token\b/i,
  /\brefresh[_-]?token\b/i,
  /\bprivate[_-]?key\b/i,
  /\bprivate\s+key\b/i,
  /\bcredential[s]?\b/i,
] as const;

const CREDENTIAL_SHAPED = [
  /\b(?:password|passwd|pwd)\s*[:=]/i,
  /\btoken\s*[:=]/i,
  /\bcookie\s*[:=]/i,
  /\bsecret\s*[:=]/i,
  /\b(?:bearer|authorization)\s*[:=]/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
] as const;

export function rejectCredentialLikeInstruction(instruction: string): void {
  for (const pattern of CREDENTIAL_BARE) {
    if (pattern.test(instruction)) {
      throw new ZcodeControlError(
        "ZCODE_CREDENTIAL_INPUT",
        "instruction contains credential-like content (token/password/cookie/api_key/client_secret/private key); remove it and resubmit"
      );
    }
  }
  for (const pattern of CREDENTIAL_SHAPED) {
    if (pattern.test(instruction)) {
      throw new ZcodeControlError(
        "ZCODE_CREDENTIAL_INPUT",
        "instruction contains credential-like content (token/password/cookie/api_key/client_secret/private key); remove it and resubmit"
      );
    }
  }
  const sanitized = sanitizeExecutionOutput(instruction.replace(
    /\b((?:access[_-]?token|refresh[_-]?token|client[_-]?secret|token|cookie|password|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"';]+/gi,
    "$1[REDACTED]"
  ));
  if (!sanitized.allowed || sanitized.text.includes("[REDACTED]")) {
    throw new ZcodeControlError(
      "ZCODE_CREDENTIAL_INPUT",
      "instruction contains credential-like content; remove it and resubmit"
    );
  }
}

function redactLocalPaths(value: string): string {
  return value
    .replace(/(["'`])(?:[A-Za-z]:[\\/]|\\\\|\/)[^\r\n]*?\1/g, "$1[local-path]$1")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>]+/g, "[local-path]")
    .replace(/\/(?:Users|home|private|tmp|var|opt|srv|etc|mnt|media|workspace)\/[^\s"'`<>]+/g, "[local-path]");
}

function sanitizeText(value: string, maxChars: number): string {
  const sanitized = sanitizeExecutionOutput(value);
  const text = sanitized.allowed ? sanitized.text : "[withheld]";
  return redactLocalPaths(text).slice(0, maxChars);
}

function sanitizeStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => sanitizeText(item, MAX_STRING_FIELD_CHARS))
    .slice(0, MAX_STRINGS_PER_FIELD)
    .map((item) => (item === "" ? `${field}[i]:[withheld]` : item));
}

/**
 * Per-file async mutex: appends to the same JSONL file are serialized in
 * process order, so a complete line always lands as one atomic write and
 * concurrent enqueues can never interleave.
 */
const appendLocks = new Map<string, Promise<void>>();

function withFileLock<T>(file: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = appendLocks.get(file) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  appendLocks.set(file, next.then(() => undefined, () => undefined));
  return next;
}

export interface ZcodeQueueResolutionOptions {
  root?: string;
  workspaceRoot?: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  registry?: WorkspaceRegistry;
}

function resolveEngineeringAiWorkspaceRoot(
  options: ZcodeQueueResolutionOptions,
  env: NodeJS.ProcessEnv
): string | null {
  // No hardcoded workspace id in source: the stable Engineering AI workspace
  // id must come from the operator's environment (desktop-managed state).
  const targetId = env.C2C_ENGINEERING_AI_WORKSPACE_ID?.trim() || null;
  const targetName = env.C2C_ENGINEERING_AI_WORKSPACE_NAME?.trim().toLowerCase() || "engineering-ai";
  // An explicit workspace root anchors queue resolution only when it IS the
  // authorized Engineering AI workspace (stable id, registered name, or
  // logical name match). Any other absolute root (e.g. a bridge repository
  // workspace) must fall through to the registry chain instead of silently
  // hosting the queue.
  const matchesTarget = (candidate: string, id?: string | null, name?: string | null): boolean =>
    (targetId ? id === targetId : false) ||
    (name ? name.toLowerCase() === targetName : false) ||
    /engineering-ai/i.test(candidate);

  if (options.workspaceRoot && path.isAbsolute(options.workspaceRoot) && fs.existsSync(options.workspaceRoot)) {
    const normalized = path.normalize(options.workspaceRoot);
    if (matchesTarget(normalized)) {
      return normalized;
    }
  }

  const envWsRoot = env.C2C_ENGINEERING_AI_WORKSPACE_ROOT?.trim();
  if (envWsRoot && path.isAbsolute(envWsRoot) && fs.existsSync(envWsRoot)) {
    return path.normalize(envWsRoot);
  }

  if (options.registry) {
    try {
      if (targetId && options.registry.has(targetId)) {
        const canonical = options.registry.get(targetId).canonicalPath;
        if (path.isAbsolute(canonical) && fs.existsSync(canonical)) {
          return path.normalize(canonical);
        }
      }
      for (const id of options.registry.enabledIds()) {
        const entry = options.registry.get(id);
        if (matchesTarget(entry.canonicalPath, entry.id, entry.name)) {
          if (path.isAbsolute(entry.canonicalPath) && fs.existsSync(entry.canonicalPath)) {
            return path.normalize(entry.canonicalPath);
          }
        }
      }
    } catch {
      // Registry lookup fallback
    }
  }

  const stateDir =
    options.stateDir?.trim() ||
    env.C2C_STATE_DIR?.trim() ||
    (options.env !== undefined ? undefined : getStateDir(options.stateDir));

  if (stateDir) {
    const workspacesFile = path.join(stateDir, "workspaces.json");
    const persisted = readJsonIfExists<{
      workspaces?: Array<{ id?: string; name?: string; canonicalPath?: string; enabled?: boolean }>;
    }>(workspacesFile);
    if (persisted?.workspaces && Array.isArray(persisted.workspaces)) {
      for (const entry of persisted.workspaces) {
        if (
          entry.enabled !== false &&
          entry.canonicalPath &&
          path.isAbsolute(entry.canonicalPath) &&
          matchesTarget(entry.canonicalPath, entry.id, entry.name ?? null)
        ) {
          if (fs.existsSync(entry.canonicalPath)) {
            return path.normalize(entry.canonicalPath);
          }
        }
      }
    }

    const runtimeFile = targetId ? path.join(stateDir, "runtime", `${targetId}.json`) : null;
    const runtime = runtimeFile ? readJsonIfExists<{ workspaceRoot?: string }>(runtimeFile) : null;
    if (
      runtime?.workspaceRoot &&
      path.isAbsolute(runtime.workspaceRoot) &&
      fs.existsSync(runtime.workspaceRoot)
    ) {
      return path.normalize(runtime.workspaceRoot);
    }
  }

  return null;
}

export function resolveFixedZcodeQueueRoot(options: ZcodeQueueResolutionOptions = {}): string {
  if (options.root !== undefined && !options.root.trim()) {
    throw new ZcodeControlError(
      "ZCODE_ROOT_MISSING",
      "the ZCode queue root is not configured (set C2C_ZCODE_QUEUE_ROOT) or does not exist",
    );
  }

  const env = options.env ?? process.env;
  const configured = (options.root ?? env.C2C_ZCODE_QUEUE_ROOT)?.trim();

  if (configured) {
    if (configured.split(/[\\/]/).includes("..")) {
      throw new ZcodeControlError("ZCODE_PATH_UNSAFE", "the fixed ZCode queue root cannot contain path traversal");
    }
    if (path.isAbsolute(configured)) {
      const normalized = path.normalize(configured);
      if (normalized.split(path.sep).includes("..")) {
        throw new ZcodeControlError("ZCODE_PATH_UNSAFE", "the fixed ZCode queue root cannot contain path traversal");
      }
      return normalized;
    }

    const engWsRoot = resolveEngineeringAiWorkspaceRoot(options, env);
    if (engWsRoot) {
      const resolved = path.resolve(engWsRoot, configured);
      const rel = path.relative(engWsRoot, resolved);
      if (rel.startsWith("..") || path.isAbsolute(rel) || rel.split(path.sep).includes("..")) {
        throw new ZcodeControlError("ZCODE_PATH_UNSAFE", "configured ZCode queue root escapes the authorized workspace root");
      }
      return resolved;
    }

    throw new ZcodeControlError(
      "ZCODE_PATH_UNSAFE",
      "relative C2C_ZCODE_QUEUE_ROOT cannot be resolved without an authorized workspace root; refusing to use process cwd",
    );
  }

  const engWsRoot = resolveEngineeringAiWorkspaceRoot(options, env);
  if (engWsRoot) {
    const queueRoot = path.join(engWsRoot, "var", "c2c-zcode");
    return path.normalize(queueRoot);
  }

  throw new ZcodeControlError(
    "ZCODE_ROOT_MISSING",
    "the ZCode queue root is not configured (set C2C_ZCODE_QUEUE_ROOT) or does not exist",
  );
}

/** Resolved real root; fails closed when the configured root is missing. */
function realQueueRoot(rawRoot: string | undefined): string {
  if (!rawRoot || !rawRoot.trim()) {
    throw new ZcodeControlError(
      "ZCODE_ROOT_MISSING",
      "the ZCode queue root is not configured (set C2C_ZCODE_QUEUE_ROOT) or does not exist",
    );
  }
  if (!path.isAbsolute(rawRoot)) {
    throw new ZcodeControlError(
      "ZCODE_PATH_UNSAFE",
      "the fixed ZCode queue root must be an absolute path independent of process cwd",
    );
  }
  if (rawRoot.split(/[\\/]/).includes("..")) {
    throw new ZcodeControlError("ZCODE_PATH_UNSAFE", "the fixed ZCode queue root cannot contain path traversal");
  }
  const normalized = path.normalize(rawRoot);
  if (normalized.split(path.sep).includes("..")) {
    throw new ZcodeControlError("ZCODE_PATH_UNSAFE", "the fixed ZCode queue root cannot contain path traversal");
  }
  let real: string;
  try {
    real = fs.realpathSync(normalized);
  } catch {
    throw new ZcodeControlError(
      "ZCODE_ROOT_MISSING",
      "the ZCode queue root is not configured (set C2C_ZCODE_QUEUE_ROOT) or does not exist",
    );
  }
  let expected: string;
  try {
    expected = fs.realpathSync(path.dirname(normalized));
  } catch {
    throw new ZcodeControlError("ZCODE_PATH_UNSAFE", "the fixed ZCode queue root parent is unsafe");
  }
  expected = path.join(expected, path.basename(normalized));
  if (real.toLowerCase() !== expected.toLowerCase()) {
    throw new ZcodeControlError("ZCODE_PATH_UNSAFE", "the fixed ZCode queue root resolved outside its declared location");
  }
  return real;
}

/**
 * Validate one truth file: must live inside the real root, must be a plain
 * regular file (no symlink/junction/reparse point), and — unless opted out —
 * must be within the whole-file read cap. Returns its absolute path.
 */
function safeTruthFile(
  root: string,
  name: string,
  options: { mustExist: boolean; enforceSizeCap?: boolean }
): string {
  const file = path.join(root, name);
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ZcodeControlError("ZCODE_PATH_UNSAFE", `refusing to touch ${name} outside the fixed queue root`);
  }
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (options.mustExist) {
        throw new ZcodeControlError("ZCODE_FILE_MISSING", `${name} does not exist in the fixed queue root`);
      }
      return file;
    }
    throw new ZcodeControlError("ZCODE_PATH_UNSAFE", `${name} could not be inspected`);
  }
  if (stats.isSymbolicLink()) {
    throw new ZcodeControlError("ZCODE_PATH_UNSAFE", `${name} is a symlink/junction; the queue only allows regular files`);
  }
  if (!stats.isFile()) {
    throw new ZcodeControlError("ZCODE_PATH_UNSAFE", `${name} is not a regular file`);
  }
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch {
    throw new ZcodeControlError("ZCODE_PATH_UNSAFE", `${name} could not be resolved`);
  }
  const realRelative = path.relative(root, real);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new ZcodeControlError("ZCODE_PATH_UNSAFE", `${name} resolves outside the fixed queue root (reparse-point escape)`);
  }
  if ((options.enforceSizeCap ?? true) && stats.size > MAX_FILE_BYTES) {
    throw new ZcodeControlError("ZCODE_FILE_TOO_LARGE", `${name} exceeds the ${MAX_FILE_BYTES} byte read cap`);
  }
  return file;
}

/**
 * Bounded streaming scan of one JSONL truth file. The file is read in fixed
 * chunks and decoded incrementally, so total file size never bounds memory;
 * only one line is materialized at a time and a single line larger than
 * `maxLineBytes` fails closed instead of being silently truncated or skipped.
 */
function scanJsonlLines(
  file: string,
  name: string,
  options: { maxLineBytes: number },
  visit: (line: string, lineNumber: number) => void
): void {
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.alloc(64 * 1024);
    const decoder = new StringDecoder("utf8");
    let partial = "";
    let partialBytes = 0;
    let lineNumber = 0;
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      const text = decoder.write(read === chunk.length ? chunk : chunk.subarray(0, read));
      let start = 0;
      for (;;) {
        const nl = text.indexOf("\n", start);
        if (nl === -1) break;
        const segmentBytes = Buffer.byteLength(text.slice(start, nl), "utf8");
        if (partialBytes + segmentBytes > options.maxLineBytes) {
          throw new ZcodeControlError(
            "ZCODE_RECORD_TOO_LARGE",
            `${name} line ${lineNumber + 1} exceeds the ${options.maxLineBytes} byte record cap (fail closed)`
          );
        }
        const line = partial + text.slice(start, nl);
        lineNumber += 1;
        partial = "";
        partialBytes = 0;
        visit(line, lineNumber);
        start = nl + 1;
      }
      const rest = text.slice(start);
      if (rest.length > 0) {
        partial += rest;
        partialBytes += Buffer.byteLength(rest, "utf8");
      }
      if (partialBytes > options.maxLineBytes) {
        throw new ZcodeControlError(
          "ZCODE_RECORD_TOO_LARGE",
          `${name} line ${lineNumber + 1} exceeds the ${options.maxLineBytes} byte record cap (fail closed)`
        );
      }
    }
    const tail = partial + decoder.end();
    if (tail.length > 0) {
      lineNumber += 1;
      visit(tail, lineNumber);
    }
  } finally {
    fs.closeSync(fd);
  }
}

export class ZcodeControl {
  private readonly root?: string;
  private readonly resolutionOptions?: ZcodeQueueResolutionOptions;

  constructor(rootOrOptions?: string | ZcodeQueueResolutionOptions) {
    if (typeof rootOrOptions === "string") {
      this.root = rootOrOptions;
    } else if (rootOrOptions && typeof rootOrOptions === "object") {
      this.resolutionOptions = rootOrOptions;
      this.root = rootOrOptions.root;
    }
  }

  private realRoot(): string {
    const rawRoot = this.root !== undefined ? this.root : resolveFixedZcodeQueueRoot(this.resolutionOptions);
    return realQueueRoot(rawRoot);
  }

  private safeFile(name: string, options: { mustExist: boolean; enforceSizeCap?: boolean }): string {
    return safeTruthFile(this.realRoot(), name, options);
  }

  private readJsonl(name: string): Record<string, unknown>[] {
    const file = this.safeFile(name, { mustExist: false });
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf8");
    if (raw.length === 0) return [];
    const lines = raw.split("\n");
    // A trailing newline is expected; an empty line anywhere else is malformed.
    if (lines[lines.length - 1] === "") lines.pop();
    const records: Record<string, unknown>[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() === "") {
        throw new ZcodeControlError(
          "ZCODE_MALFORMED_FILE",
          `${name} line ${index + 1} is empty; the JSONL truth file is malformed (fail closed)`
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new ZcodeControlError(
          "ZCODE_MALFORMED_FILE",
          `${name} line ${index + 1} is not valid JSON; the JSONL truth file is malformed (fail closed)`
        );
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ZcodeControlError(
          "ZCODE_MALFORMED_FILE",
          `${name} line ${index + 1} is not a JSON object (fail closed)`
        );
      }
      records.push(parsed as Record<string, unknown>);
    }
    return records;
  }

  private appendJsonl(
    name: string,
    payload: Record<string, unknown>,
    options: { create?: boolean } = {}
  ): void {
    const file = this.safeFile(name, { mustExist: options.create === true });
    const serialized = JSON.stringify(payload);
    if (serialized.includes("\n")) {
      throw new ZcodeControlError("ZCODE_INVALID_TASK", "refusing to append a multi-line JSON record");
    }
    fs.appendFileSync(file, serialized + "\n", "utf8");
  }

  /** Serialized append: concurrent callers queue behind one in-process lock. */
  private appendSerialized<T>(
    name: string,
    fn: () => Record<string, unknown>,
    transform: (payload: Record<string, unknown>) => T
  ): Promise<T> {
    return withFileLock(path.join(this.realRoot(), name), () => {
      const payload = fn();
      this.appendJsonl(name, payload);
      return transform(payload);
    });
  }

  private queueRecords(): ZcodeTaskRecord[] {
    return this.readJsonl(QUEUE_FILE).map((record) => this.asTaskRecord(record, QUEUE_FILE));
  }

  private asTaskRecord(record: Record<string, unknown>, source: string): ZcodeTaskRecord {
    const task_id = record.task_id;
    if (typeof task_id !== "string" || !TASK_ID_PATTERN.test(task_id)) {
      throw new ZcodeControlError("ZCODE_MALFORMED_FILE", `${source} contains a record without a valid task_id (fail closed)`);
    }
    return record as unknown as ZcodeTaskRecord;
  }

  /**
   * Ordered lifecycle receipts history: rotated segments oldest → newest,
   * then the active receipts.jsonl segment. Every file is validated with the
   * same fail-closed guarantees as any truth file (regular file, inside the
   * real root, no reparse points) and scanned with bounded memory; only the
   * per-record cap bounds a single record, never cumulative history size.
   */
  private receiptsHistoryFiles(): string[] {
    const root = this.realRoot();
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const segments: Array<{ seq: number; name: string }> = [];
    for (const entry of entries) {
      const match = RECEIPTS_SEGMENT_PATTERN.exec(entry.name);
      if (!match) continue;
      segments.push({ seq: Number(match[1]), name: entry.name });
    }
    segments.sort((a, b) => a.seq - b.seq);
    const files: string[] = [];
    for (const segment of segments) {
      files.push(this.safeFile(segment.name, { mustExist: true, enforceSizeCap: false }));
    }
    const active = this.safeFile(RECEIPTS_FILE, { mustExist: false, enforceSizeCap: false });
    if (fs.existsSync(active)) files.push(active);
    return files;
  }

  private forEachReceiptRecord(visit: (record: Record<string, unknown>, source: string, line: number) => void): void {
    for (const file of this.receiptsHistoryFiles()) {
      const name = path.basename(file);
      scanJsonlLines(file, name, { maxLineBytes: MAX_RECEIPT_LINE_BYTES }, (line, lineNumber) => {
        if (line.trim() === "") {
          throw new ZcodeControlError(
            "ZCODE_MALFORMED_FILE",
            `${name} line ${lineNumber} is empty; the JSONL truth file is malformed (fail closed)`
          );
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new ZcodeControlError(
            "ZCODE_MALFORMED_FILE",
            `${name} line ${lineNumber} is not valid JSON; the JSONL truth file is malformed (fail closed)`
          );
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new ZcodeControlError(
            "ZCODE_MALFORMED_FILE",
            `${name} line ${lineNumber} is not a JSON object (fail closed)`
          );
        }
        visit(parsed as Record<string, unknown>, name, lineNumber);
      });
    }
  }

  private controlRecords(): ControlRecord[] {
    return this.readJsonl(CONTROL_FILE) as ControlRecord[];
  }

  /** Bounded-memory fold over the full receipts history: each task keeps its
   * latest MAX_RECEIPTS_PER_TASK records; older records are dropped as the
   * stream advances so a giant history never materializes in memory. */
  private receiptsByTask(): Map<string, ReceiptRecord[]> {
    const map = new Map<string, ReceiptRecord[]>();
    this.forEachReceiptRecord((record) => {
      const task_id = typeof record.task_id === "string" ? record.task_id : null;
      if (!task_id) return;
      const list = map.get(task_id) ?? [];
      list.push(record);
      if (list.length > MAX_RECEIPTS_PER_TASK) list.splice(0, list.length - MAX_RECEIPTS_PER_TASK);
      map.set(task_id, list);
    });
    return map;
  }

  /** Streaming existence check across the entire receipts history. */
  private receiptsContainTask(taskId: string): boolean {
    let found = false;
    this.forEachReceiptRecord((record) => {
      if (found) return;
      if (record.task_id === taskId) found = true;
    });
    return found;
  }

  private statusFor(taskId: string, receipts: ReceiptRecord[] | undefined, cancelRequested: boolean): ZcodeTaskStatus {
    const events = (receipts ?? []).map((record) => String(record.event ?? ""));
    if (events.some((event) => TERMINAL_EVENTS.has(event))) {
      const terminal = events.find((event) => TERMINAL_EVENTS.has(event)) as string;
      return terminal.toLowerCase() as ZcodeTaskStatus;
    }
    if (events.includes("START")) return "running";
    if (cancelRequested) return "cancel_requested";
    return "queued";
  }

  private taskView(
    task: ZcodeTaskRecord,
    receipts: ReceiptRecord[] | undefined,
    cancelRequested: boolean
  ): ZcodeTaskView {
    const events = (receipts ?? []).map((record) => String(record.event ?? ""));
    const terminalEvent = events.find((event) => TERMINAL_EVENTS.has(event));
    const errorRecord = [...(receipts ?? [])].reverse().find((record) => typeof record.error === "string" && record.error !== "");
    return {
      task_id: task.task_id,
      created_at: typeof task.created_at === "string" ? task.created_at : "",
      role: task.role,
      priority: typeof task.priority === "number" ? task.priority : 0,
      status: this.statusFor(task.task_id, receipts, cancelRequested),
      mode: typeof task.mode === "string" ? task.mode : null,
      resources: sanitizeStringArray(task.resources, "resources"),
      exclusive_paths: sanitizeStringArray(task.exclusive_paths, "exclusive_paths"),
      depends_on: sanitizeStringArray(task.depends_on, "depends_on"),
      instruction_excerpt: sanitizeText(String(task.instruction ?? ""), MAX_INSTRUCTION_EXCERPT),
      receipts: (receipts ?? []).slice(-MAX_RECEIPTS_PER_TASK).map((record) => ({
        event: String(record.event ?? ""),
        timestamp: typeof record.timestamp === "string" ? record.timestamp : "",
        model: typeof record.model === "string" ? sanitizeText(record.model, 80) : null,
      })),
      cancel_requested: cancelRequested,
      error: errorRecord ? sanitizeText(String(errorRecord.error), 500) : (terminalEvent === "FAILED" ? sanitizeText("task failed", 200) : null),
    };
  }

  /** Read the bounded, sanitized worker state cache (never lifecycle truth). */
  readWorkerState(): Record<string, unknown> | null {
    const file = this.safeFile(STATE_FILE, { mustExist: false });
    if (!fs.existsSync(file)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new ZcodeControlError("ZCODE_MALFORMED_FILE", "worker-state.json is not valid JSON (fail closed)");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ZcodeControlError("ZCODE_MALFORMED_FILE", "worker-state.json must be a JSON object (fail closed)");
    }
    const view = parsed as Record<string, unknown>;
    const active = sanitizeStringArray(
      Array.isArray(view.active) ? view.active.map((entry) => JSON.stringify(entry)) : [],
      "active"
    );
    return {
      status: typeof view.status === "string" ? sanitizeText(view.status, 40) : null,
      max_parallel: typeof view.max_parallel === "number" ? view.max_parallel : null,
      active: active.map((entry) => {
        try {
          return JSON.parse(entry) as unknown;
        } catch {
          return entry;
        }
      }),
    };
  }

  listTasks(limit: number = 50): { tasks: ZcodeTaskView[]; total: number; worker_state: Record<string, unknown> | null } {
    const bounded = Math.max(1, Math.min(Math.floor(limit) || 50, MAX_LISTED_TASKS));
    const receipts = this.receiptsByTask();
    const cancelSet = new Set(
      this.controlRecords()
        .filter((record) => record.event === "CANCEL_REQUESTED" && typeof record.task_id === "string")
        .map((record) => String(record.task_id))
    );
    const queue = this.queueRecords();
    const tasks = queue
      .map((task) => this.taskView(task, receipts.get(task.task_id), cancelSet.has(task.task_id)))
      .slice(0, bounded);
    return { tasks, total: queue.length, worker_state: this.readWorkerState() };
  }

  getTask(taskId: string): ZcodeTaskView | null {
    if (!TASK_ID_PATTERN.test(taskId)) {
      throw new ZcodeControlError("ZCODE_INVALID_TASK", "task_id is malformed");
    }
    const receipts = this.receiptsByTask();
    const cancelRequested = this.controlRecords().some(
      (record) => record.event === "CANCEL_REQUESTED" && record.task_id === taskId
    );
    const task = this.queueRecords().find((record) => record.task_id === taskId);
    if (!task) return null;
    return this.taskView(task, receipts.get(taskId), cancelRequested);
  }

  /**
   * Unsanitized instruction of one queued task, for coordinator dispatch
   * fidelity only. MCP views deliberately never expose this field; the
   * instruction already passed credential rejection at enqueue time and the
   * executor needs it verbatim (the view excerpt is redacted and truncated).
   */
  rawInstructionFor(taskId: string): string | null {
    if (!TASK_ID_PATTERN.test(taskId)) return null;
    const task = this.queueRecords().find((record) => record.task_id === taskId);
    return task && typeof task.instruction === "string" && task.instruction.length > 0 ? task.instruction : null;
  }

  /**
   * Append one governed task to queue.jsonl. Returns the stored record.
   * Duplicate ids are rejected against both queue.jsonl and receipts.jsonl.
   */
  async enqueue(input: ZcodeTaskInput): Promise<ZcodeTaskRecord> {
    return this.appendSerialized(
      QUEUE_FILE,
      () => this.buildEnqueuePayload(input),
      (payload) => payload as unknown as ZcodeTaskRecord
    );
  }

  private buildEnqueuePayload(input: ZcodeTaskInput): Record<string, unknown> {
    const task_id = input.task_id ?? `zcode_${randomBytes(12).toString("hex")}`;
    if (!TASK_ID_PATTERN.test(task_id)) {
      throw new ZcodeControlError("ZCODE_INVALID_TASK", "task_id must match [a-zA-Z0-9][a-zA-Z0-9._-]{2,63}");
    }
    if (!ROLES.includes(input.role as ZcodeRole)) {
      throw new ZcodeControlError("ZCODE_INVALID_TASK", `role must be one of ${ROLES.join("|")}`);
    }
    if (!Number.isInteger(input.priority) || Math.abs(input.priority) > PRIORITY_LIMIT) {
      throw new ZcodeControlError("ZCODE_INVALID_TASK", `priority must be an integer within ±${PRIORITY_LIMIT}`);
    }
    if (typeof input.instruction !== "string" || input.instruction.trim().length === 0) {
      throw new ZcodeControlError("ZCODE_INVALID_TASK", "instruction must be a non-empty string");
    }
    if (input.instruction.length > MAX_INSTRUCTION_CHARS) {
      throw new ZcodeControlError("ZCODE_INVALID_TASK", `instruction exceeds ${MAX_INSTRUCTION_CHARS} characters`);
    }
    if (input.network === true) {
      throw new ZcodeControlError("ZCODE_INVALID_TASK", "network must be false; the scheduled queue worker never runs networked tasks");
    }
    if (input.mode !== undefined && !MODES.includes(input.mode as ZcodeMode)) {
      throw new ZcodeControlError("ZCODE_INVALID_TASK", `mode must be one of ${MODES.join("|")}`);
    }
    rejectCredentialLikeInstruction(input.instruction);

    const existingQueue = this.queueRecords();
    if (existingQueue.some((task) => task.task_id === task_id)) {
      throw new ZcodeControlError("ZCODE_DUPLICATE_TASK_ID", `task_id ${task_id} already exists in queue.jsonl`);
    }
    if (this.receiptsContainTask(task_id)) {
      throw new ZcodeControlError("ZCODE_DUPLICATE_TASK_ID", `task_id ${task_id} already exists in receipts.jsonl`);
    }

    const payload: Record<string, unknown> = {
      task_id,
      created_at: new Date().toISOString(),
      role: input.role,
      priority: input.priority,
      instruction: input.instruction,
      network: false,
    };
    if (input.mode !== undefined) payload.mode = input.mode;
    if (input.resources !== undefined) {
      const resources = validateStringArray(input.resources, "resources");
      if (resources.length > 0) payload.resources = resources;
    }
    if (input.exclusive_paths !== undefined) {
      const exclusive = validateStringArray(input.exclusive_paths, "exclusive_paths");
      if (exclusive.length > 0) payload.exclusive_paths = exclusive;
    }
    if (input.depends_on !== undefined) {
      const depends = validateStringArray(input.depends_on, "depends_on");
      for (const id of depends) {
        if (!TASK_ID_PATTERN.test(id)) {
          throw new ZcodeControlError("ZCODE_INVALID_TASK", `depends_on contains a malformed task_id: ${id.slice(0, 64)}`);
        }
      }
      if (depends.length > 0) payload.depends_on = depends;
    }
    return payload;
  }

  /**
   * Request cancellation of a known non-terminal task. Only ever appends
   * CANCEL_REQUESTED to control.jsonl — terminal receipts belong to the
   * ZCode coordinator alone. Repeated requests are idempotent.
   */
  async requestCancel(taskId: string): Promise<{ task_id: string; status: ZcodeTaskStatus; cancel_requested: boolean; already_requested: boolean }> {
    if (!TASK_ID_PATTERN.test(taskId)) {
      throw new ZcodeControlError("ZCODE_INVALID_TASK", "task_id is malformed");
    }
    return this.appendSerialized(
      CONTROL_FILE,
      () => {
        const receipts = this.receiptsByTask();
        const queue = this.queueRecords();
        const task = queue.find((record) => record.task_id === taskId);
        if (!task) {
          throw new ZcodeControlError("ZCODE_TASK_UNKNOWN", `task_id ${taskId} is not a known queued task`);
        }
        const status = this.statusFor(taskId, receipts.get(taskId), false);
        if (TERMINAL_EVENTS.has(status.toUpperCase())) {
          throw new ZcodeControlError(
            "ZCODE_ALREADY_TERMINAL",
            `task_id ${taskId} already has a ${status.toUpperCase()} terminal receipt; cancellation is moot`
          );
        }
        const already = this.controlRecords().some(
          (record) => record.event === "CANCEL_REQUESTED" && record.task_id === taskId
        );
        if (already) {
          throw new AlreadyRequestedSignal();
        }
        return {
          event: "CANCEL_REQUESTED",
          task_id: taskId,
          timestamp: new Date().toISOString(),
        };
      },
      () => ({ task_id: taskId, status: "cancel_requested" as ZcodeTaskStatus, cancel_requested: true, already_requested: false })
    ).catch((error: unknown) => {
      if (error instanceof AlreadyRequestedSignal) {
        return { task_id: taskId, status: "cancel_requested" as ZcodeTaskStatus, cancel_requested: true, already_requested: true };
      }
      throw error;
    });
  }
}

class AlreadyRequestedSignal extends Error {}

/** Bounded, sanitized terminal-receipt record the coordinator may append. */
export interface ZcodeCoordinatorReceipt {
  task_id: string;
  event: "START" | "COMPLETED" | "FAILED" | "CANCELLED";
  model?: string | null;
  session?: string | null;
  workspace?: string | null;
  verification_summary?: string | null;
  error?: string | null;
}

/**
 * The ONE writer allowed to append lifecycle receipts and worker state: the
 * Governed ZCode queue coordinator owned by this bridge. The ChatGPT-facing
 * control plane (ZcodeControl) deliberately has no path to this class, so it
 * can never forge a terminal receipt.
 */
export class ZcodeCoordinatorStore {
  private readonly root: string;

  constructor(rootOrOptions?: string | ZcodeQueueResolutionOptions) {
    const rawRoot =
      typeof rootOrOptions === "string"
        ? rootOrOptions
        : resolveFixedZcodeQueueRoot(rootOrOptions ?? {});
    this.root = realQueueRoot(rawRoot);
  }

  /** Append one lifecycle receipt (serialized, sanitized, bounded). */
  async appendReceipt(receipt: ZcodeCoordinatorReceipt): Promise<void> {
    if (!TERMINAL_EVENTS.has(receipt.event) && receipt.event !== "START") {
      throw new ZcodeControlError("ZCODE_INVALID_TASK", `event ${receipt.event} is not a coordinator receipt`);
    }
    if (typeof receipt.task_id !== "string" || !TASK_ID_PATTERN.test(receipt.task_id)) {
      throw new ZcodeControlError("ZCODE_INVALID_TASK", "receipt task_id is malformed");
    }
    const payload: Record<string, unknown> = {
      task_id: receipt.task_id,
      timestamp: new Date().toISOString(),
      event: receipt.event,
    };
    payload.model = receipt.model ? sanitizeText(receipt.model, 80) : null;
    payload.session = receipt.session ? sanitizeText(receipt.session, 80) : null;
    payload.workspace = receipt.workspace ? sanitizeText(receipt.workspace, MAX_STRING_FIELD_CHARS) : null;
    payload.verification_summary = receipt.verification_summary
      ? sanitizeText(receipt.verification_summary, 2000)
      : null;
    payload.error = receipt.error ? sanitizeText(receipt.error, 500) : null;
    await withFileLock(path.join(this.root, RECEIPTS_FILE), () => {
      appendCoordinatorJsonl(this.root, RECEIPTS_FILE, payload);
    });
  }

  /** Persist the bounded worker-state cache (atomically, owner-only). */
  writeWorkerState(state: Record<string, unknown>): void {
    const file = safeTruthFile(this.root, STATE_FILE, { mustExist: false });
    writeSecureJson(file, state);
  }

  /** Raw worker-state JSON for the coordinator (not the sanitized view). */
  readRawWorkerState(): Record<string, unknown> | null {
    const file = safeTruthFile(this.root, STATE_FILE, { mustExist: false });
    if (!fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** Serialized claim of pending intent before dispatch (crash-recovery proof). */
  async withDispatchIntent<T>(task: { task_id: string; dispatch: () => Promise<T> }): Promise<T> {
    return withFileLock(path.join(this.root, STATE_FILE), async () => {
      const state = (this.readRawWorkerState() ?? {}) as Record<string, unknown>;
      const pending = Array.isArray(state.pending) ? [...(state.pending as Record<string, unknown>[])] : [];
      if (!pending.some((entry) => entry.task_id === task.task_id)) {
        pending.push({ task_id: task.task_id, submitted_at: new Date().toISOString() });
        this.writeWorkerState({ ...state, pending });
      }
      try {
        return await task.dispatch();
      } finally {
        const latest = (this.readRawWorkerState() ?? {}) as Record<string, unknown>;
        const remaining = Array.isArray(latest.pending)
          ? (latest.pending as Record<string, unknown>[]).filter((entry) => entry.task_id !== task.task_id)
          : [];
        if (remaining.length !== (latest.pending as unknown[] | undefined)?.length) {
          this.writeWorkerState({ ...latest, pending: remaining });
        }
      }
    });
  }
}

/** Serialized single-line append after full truth-file validation. */
function appendCoordinatorJsonl(root: string, name: string, payload: Record<string, unknown>): void {
  const serialized = JSON.stringify(payload);
  if (serialized.includes("\n")) {
    throw new ZcodeControlError("ZCODE_INVALID_TASK", "refusing to append a multi-line JSON record");
  }
  if (name === RECEIPTS_FILE) {
    rotateReceiptsIfNeeded(root, serialized.length + 1);
  }
  const file = safeTruthFile(root, name, { mustExist: false, enforceSizeCap: false });
  fs.appendFileSync(file, serialized + "\n", "utf8");
}

/**
 * Rotate the active receipts segment deterministically BEFORE it crosses the
 * rotation threshold: receipts.jsonl is renamed to the next unused
 * receipts.NNNNNN.jsonl sequence (atomic rename on the same volume, so no
 * record is lost or duplicated even across a crash mid-rotation) and the
 * active file starts empty. Rotation runs under the receipts file lock.
 * Only the exact segment filename pattern inside the canonical root is ever
 * considered; callers cannot influence archive names.
 */
function rotateReceiptsIfNeeded(root: string, incomingBytes: number): void {
  const active = safeTruthFile(root, RECEIPTS_FILE, { mustExist: false, enforceSizeCap: false });
  let stats: fs.Stats | null = null;
  try {
    stats = fs.statSync(active);
  } catch {
    stats = null; // no active segment yet — nothing to rotate
  }
  if (!stats || !stats.isFile() || stats.size + incomingBytes <= RECEIPTS_ROTATE_BYTES) return;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // treated as no segments; the rename below still targets a fresh name
  }
  let maxSeq = 0;
  for (const entry of entries) {
    const match = RECEIPTS_SEGMENT_PATTERN.exec(entry.name);
    if (match) maxSeq = Math.max(maxSeq, Number(match[1]));
  }
  const segmentName = `receipts.${String(maxSeq + 1).padStart(6, "0")}.jsonl`;
  const segmentPath = safeTruthFile(root, segmentName, { mustExist: false, enforceSizeCap: false });
  if (fs.existsSync(segmentPath)) {
    throw new ZcodeControlError("ZCODE_PATH_UNSAFE", `receipts segment ${segmentName} already exists (fail closed)`);
  }
  fs.renameSync(active, segmentPath);
}

// ── Control-plane status layers ─────────────────────────────────────────────

export type ZcodeControlPlaneLevel =
  | "QUEUE_ROOT_MISSING"
  | "QUEUE_ROOT_UNSAFE"
  | "WORKSPACE_BINDING_FAILED"
  | "COORDINATOR_NOT_RUNNING"
  | "OUTSIDE_CLAIM_WINDOW"
  | "ZCODE_DESKTOP_UNAVAILABLE"
  | "AUTH_NOT_ATTESTED"
  | "WRONG_PROVIDER"
  | "READY";

export interface ZcodeControlPlaneStatus {
  level: ZcodeControlPlaneLevel;
  queue_root: "OK" | "MISSING" | "UNSAFE";
  workspace_binding: "OK" | "UNRESOLVED" | "UNKNOWN" | "FAILED";
  coordinator: {
    running: boolean;
    status: string | null;
    owner_pid: number | null;
    within_window: boolean | null;
    window: string | null;
    active: number;
    last_error: string | null;
    heartbeat_age_ms: number | null;
  };
  native: {
    observed: boolean;
    available: boolean | null;
    provider: string | null;
    model: string | null;
    attested: boolean | null;
    observed_at: string | null;
  };
}

const COORDINATOR_STALE_HEARTBEAT_MS = 5 * 60_000;

/**
 * Bounded, operator-facing explanation of which control-plane layer is broken.
 * Derived from cheap local state (queue-root resolution + worker-state cache);
 * it never probes Z2C synchronously and never exposes secrets or raw output.
 */
export function describeControlPlane(options: ZcodeQueueResolutionOptions & { now?: Date }): ZcodeControlPlaneStatus {
  const now = options.now ?? new Date();
  let queueRoot: string | null = null;
  let queueRootState: "OK" | "MISSING" | "UNSAFE" = "MISSING";
  try {
    queueRoot = resolveFixedZcodeQueueRoot(options);
    queueRootState = queueRoot && fs.existsSync(queueRoot) ? "OK" : "MISSING";
  } catch (error) {
    queueRootState =
      error instanceof ZcodeControlError && error.code === "ZCODE_PATH_UNSAFE" ? "UNSAFE" : "MISSING";
  }

  const status: ZcodeControlPlaneStatus = {
    level: "READY",
    queue_root: queueRootState,
    workspace_binding: queueRootState === "OK" ? "UNKNOWN" : "UNRESOLVED",
    coordinator: {
      running: false,
      status: null,
      owner_pid: null,
      within_window: null,
      window: null,
      active: 0,
      last_error: null,
      heartbeat_age_ms: null,
    },
    native: {
      observed: false,
      available: null,
      provider: null,
      model: null,
      attested: null,
      observed_at: null,
    },
  };
  if (queueRootState !== "OK") {
    status.level = queueRootState === "UNSAFE" ? "QUEUE_ROOT_UNSAFE" : "QUEUE_ROOT_MISSING";
    return status;
  }

  let store: ZcodeCoordinatorStore;
  try {
    store = new ZcodeCoordinatorStore(queueRoot ?? undefined);
  } catch (error) {
    status.level =
      error instanceof ZcodeControlError && error.code === "ZCODE_ROOT_MISSING"
        ? "QUEUE_ROOT_MISSING"
        : "QUEUE_ROOT_UNSAFE";
    return status;
  }
  const raw = store.readRawWorkerState() ?? {};
  const coordinator = status.coordinator;
  coordinator.status = typeof raw.status === "string" ? sanitizeText(raw.status, 40) : null;
  const owner = (raw.owner ?? null) as { pid?: unknown; started_at?: unknown } | null;
  coordinator.owner_pid = owner && typeof owner.pid === "number" ? owner.pid : null;
  coordinator.window = typeof raw.window === "string" ? sanitizeText(raw.window, 120) : null;
  coordinator.within_window = typeof raw.within_window === "boolean" ? raw.within_window : null;
  coordinator.active = Array.isArray(raw.active)
    ? (raw.active as unknown[]).filter(
        (entry) => entry && typeof entry === "object" && typeof (entry as { task_id?: unknown }).task_id === "string",
      ).length
    : 0;
  coordinator.last_error = typeof raw.last_error === "string" && raw.last_error
    ? sanitizeText(raw.last_error, 300)
    : null;
  const updatedAt = typeof raw.updated_at === "string" ? Date.parse(raw.updated_at) : NaN;
  coordinator.heartbeat_age_ms = Number.isFinite(updatedAt) ? Math.max(0, now.getTime() - updatedAt) : null;
  const heartbeatFresh =
    coordinator.heartbeat_age_ms !== null && coordinator.heartbeat_age_ms < COORDINATOR_STALE_HEARTBEAT_MS;
  coordinator.running = heartbeatFresh && coordinator.status !== "stopped" && coordinator.owner_pid !== null;

  const native = status.native;
  const nativeState = (raw.native ?? null) as
    | { available?: unknown; provider?: unknown; model?: unknown; attested?: unknown; observed_at?: unknown; namespace_mismatch?: unknown }
    | null;
  if (nativeState && typeof nativeState === "object") {
    native.observed = true;
    native.available = typeof nativeState.available === "boolean" ? nativeState.available : null;
    native.provider = typeof nativeState.provider === "string" ? sanitizeText(nativeState.provider, 80) : null;
    native.model = typeof nativeState.model === "string" ? sanitizeText(nativeState.model, 80) : null;
    native.attested = typeof nativeState.attested === "boolean" ? nativeState.attested : null;
    native.observed_at =
      typeof nativeState.observed_at === "string" ? sanitizeText(nativeState.observed_at, 40) : null;
  }

  if (!coordinator.running) {
    status.level = "COORDINATOR_NOT_RUNNING";
    return status;
  }
  if (coordinator.within_window === false) {
    status.level = "OUTSIDE_CLAIM_WINDOW";
    return status;
  }
  if (nativeState?.namespace_mismatch === true) {
    status.level = "WORKSPACE_BINDING_FAILED";
    status.workspace_binding = "FAILED";
    return status;
  }
  if (!native.observed || native.available !== true) {
    status.level = "ZCODE_DESKTOP_UNAVAILABLE";
    return status;
  }
  if (native.attested !== true) {
    const providerOk = native.provider === ZCODE_NATIVE_EXPECTED_PROVIDER;
    status.level = providerOk ? "AUTH_NOT_ATTESTED" : "WRONG_PROVIDER";
    return status;
  }
  status.workspace_binding = "OK";
  return status;
}

/** The only desktop provider identity the coordinator may dispatch against. */
export const ZCODE_NATIVE_EXPECTED_PROVIDER = "zcode-desktop";

function validateStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new ZcodeControlError("ZCODE_INVALID_TASK", `${field} must be an array of strings`);
  }
  if (value.length > MAX_STRINGS_PER_FIELD) {
    throw new ZcodeControlError("ZCODE_INVALID_TASK", `${field} exceeds ${MAX_STRINGS_PER_FIELD} entries`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || item.trim().length === 0 || item.length > MAX_STRING_FIELD_CHARS) {
      throw new ZcodeControlError("ZCODE_INVALID_TASK", `${field} entries must be non-empty strings of at most ${MAX_STRING_FIELD_CHARS} characters`);
    }
    return item;
  });
}
