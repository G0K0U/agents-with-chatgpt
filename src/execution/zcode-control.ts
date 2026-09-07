/**
 * Governed C2C → ZCode queue control plane.
 *
 * The MCP layer exposes exactly four tools over the fixed ZCode free-window
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
 * - Single-file reads are capped at 8 MiB.
 * - Credential-shaped instructions are rejected at enqueue time.
 * - Cancellation only ever appends CANCEL_REQUESTED to control.jsonl. Terminal
 *   receipts (COMPLETED/FAILED/CANCELLED) are written exclusively by the ZCode
 *   free-window worker coordinator; this control plane can never write them.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { sanitizeExecutionOutput } from "./sanitize.js";

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

export class ZcodeControl {
  constructor(private readonly root: string = FIXED_ZCODE_QUEUE_ROOT) {}

  /** Resolved real root; fails closed when the configured root is missing. */
  private realRoot(): string {
    let real: string;
    try {
      real = fs.realpathSync(this.root);
    } catch {
      throw new ZcodeControlError(
        "ZCODE_ROOT_MISSING",
        "the ZCode queue root is not configured (set C2C_ZCODE_QUEUE_ROOT) or does not exist",
      );
    }
    let expected: string;
    try {
      expected = fs.realpathSync(path.dirname(this.root));
    } catch {
      throw new ZcodeControlError("ZCODE_PATH_UNSAFE", "the fixed ZCode queue root parent is unsafe");
    }
    expected = path.join(expected, path.basename(this.root));
    if (real.toLowerCase() !== expected.toLowerCase()) {
      throw new ZcodeControlError("ZCODE_PATH_UNSAFE", "the fixed ZCode queue root resolved outside its declared location");
    }
    return real;
  }

  /**
   * Validate one truth file: must live inside the real root, must be a plain
   * regular file (no symlink/junction/reparse point), and must be within the
   * read cap. Returns its absolute path.
   */
  private safeFile(name: string, options: { mustExist: boolean }): string {
    const root = this.realRoot();
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
    if (stats.size > MAX_FILE_BYTES) {
      throw new ZcodeControlError("ZCODE_FILE_TOO_LARGE", `${name} exceeds the ${MAX_FILE_BYTES} byte read cap`);
    }
    return file;
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

  private receiptRecords(): ReceiptRecord[] {
    return this.readJsonl(RECEIPTS_FILE) as ReceiptRecord[];
  }

  private controlRecords(): ControlRecord[] {
    return this.readJsonl(CONTROL_FILE) as ControlRecord[];
  }

  private receiptsByTask(): Map<string, ReceiptRecord[]> {
    const map = new Map<string, ReceiptRecord[]>();
    for (const record of this.receiptRecords()) {
      const task_id = typeof record.task_id === "string" ? record.task_id : null;
      if (!task_id) continue;
      const list = map.get(task_id) ?? [];
      list.push(record);
      map.set(task_id, list);
    }
    for (const list of map.values()) {
      if (list.length > MAX_RECEIPTS_PER_TASK) list.splice(0, list.length - MAX_RECEIPTS_PER_TASK);
    }
    return map;
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
      throw new ZcodeControlError("ZCODE_INVALID_TASK", "network must be false; the free-window worker never runs networked tasks");
    }
    if (input.mode !== undefined && !MODES.includes(input.mode as ZcodeMode)) {
      throw new ZcodeControlError("ZCODE_INVALID_TASK", `mode must be one of ${MODES.join("|")}`);
    }
    rejectCredentialLikeInstruction(input.instruction);

    const existingQueue = this.queueRecords();
    if (existingQueue.some((task) => task.task_id === task_id)) {
      throw new ZcodeControlError("ZCODE_DUPLICATE_TASK_ID", `task_id ${task_id} already exists in queue.jsonl`);
    }
    if (this.receiptRecords().some((record) => record.task_id === task_id)) {
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
