import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { saveExecutionOutput, readExecutionOutput } from "./output.js";
import { DshNativeClient, DshNativeError, type DshNativeSession, type DshNativeTask } from "./dsh-native-client.js";
import { visibleText } from "../session-plane/redact.js";

export interface DshBinding {
  sessionId: string;
  workspaceId: string;
  canonicalRoot: string;
  ownerId: string;
  createdAt: string;
  generation: string;
}

export interface DshTaskRecord {
  taskId: string;
  workspaceId: string;
  sessionId: string;
  ownerId: string;
  requestId: string;
  nativeRequestId: string;
  instructionHash: string;
  promptSha256: string;
  instruction: string;
  provider: "dsh";
  providerModel: string | null;
  effort?: "low" | "medium" | "high" | null;
  resolvedEffort?: string | null;
  selectionScope?: "transactional-global-lease" | null;
  leaseSequence?: number | null;
  status: "admitting" | "outcome_unknown" | "accepted" | "running" | "completed" | "cancel_requested" | "cancelled" | "interrupted" | "failed";
  submittedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  outputIds: number[];
  outputAvailable: boolean;
  changedFiles: string[];
  actionEvidence: { turnCompleted: boolean; changedFiles: number; finalOutputCaptured: boolean };
  nativeEvidence: { terminalSeq: number | null; terminalReason: string | null; toolCalls: number; toolResults: number;
    servedModel?: string | null; servedEffort?: string | null; servedProvider?: string | null };
  error: { code: string; message: string } | null;
  verification: null;
}

interface BindingsFile { version: 1; bindings: DshBinding[] }
const requestIdPattern = /^[a-zA-Z0-9_-]{8,128}$/;
const sessionIdPattern = /^session-d2c-[0-9a-f]{32}$/;
const taskIdPattern = /^c2c_dsh_[0-9a-f]{24}$/;

function digest(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalDshRoot(path: string): string {
  try { return realpathSync.native(path); }
  catch { throw new DshNativeError("D2C_WORKSPACE_FORBIDDEN", "Workspace root is unavailable"); }
}

export function sameDshRoot(left: string, right: string): boolean {
  const a = resolve(canonicalDshRoot(left)).replace(/[\\/]+$/, "");
  const b = resolve(canonicalDshRoot(right)).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function requireRequestId(requestId: string): void {
  if (!requestIdPattern.test(requestId)) throw new DshNativeError("D2C_BAD_REQUEST_ID", "Request ID invalid");
}

function boundedMessages(native: DshNativeSession): DshNativeSession {
  return { ...native, messages: native.messages.slice(-50).map((message) => ({
    ...message, text: visibleText(message.text, 16_000) ?? "",
  })).filter((message) => message.text.length > 0) };
}

export class DshNativeService {
  constructor(readonly stateDir: string, readonly client: DshNativeClient = new DshNativeClient()) {}

  private bindingsFile(): string { return join(this.stateDir, "d2c", "bindings.json"); }
  private taskFile(workspaceId: string, taskId: string): string {
    return join(this.stateDir, "tasks", workspaceId, `${taskId}.json`);
  }
  private loadBindings(): DshBinding[] {
    const data = readJsonIfExists<BindingsFile>(this.bindingsFile());
    if (!data) return [];
    if (data.version !== 1 || !Array.isArray(data.bindings)) {
      throw new DshNativeError("D2C_STORE_INVALID", "D2C ownership store is invalid");
    }
    return data.bindings;
  }
  private saveBindings(bindings: DshBinding[]): void {
    ensureDir(join(this.stateDir, "d2c"));
    writeSecureJson(this.bindingsFile(), { version: 1, bindings } satisfies BindingsFile);
  }
  bindings(): DshBinding[] { return this.loadBindings(); }
  binding(sessionId: string): DshBinding | null {
    return this.loadBindings().find((item) => item.sessionId === sessionId) ?? null;
  }
  private owned(workspaceId: string, root: string, sessionId: string, ownerId: string): DshBinding {
    const binding = this.binding(sessionId);
    if (!binding || binding.workspaceId !== workspaceId || binding.ownerId !== ownerId
      || !sameDshRoot(binding.canonicalRoot, root)) {
      throw new DshNativeError("D2C_NOT_OWNER", "Session is not owned by this client and workspace");
    }
    return binding;
  }
  private updateGeneration(binding: DshBinding, generation: string): void {
    if (binding.generation === generation) return;
    const bindings = this.loadBindings();
    const match = bindings.find((item) => item.sessionId === binding.sessionId);
    if (match) { match.generation = generation; this.saveBindings(bindings); }
  }
  private attest(native: DshNativeSession, root: string, sessionId: string): void {
    if (native.sessionId !== sessionId || !sameDshRoot(native.cwd, root)) {
      throw new DshNativeError("D2C_IDENTITY_MISMATCH", "Native DSH session identity changed");
    }
  }

  async runtime() { return this.client.health(); }
  async models() { return this.client.modelCatalog(); }
  async list(root: string) { return this.client.list(canonicalDshRoot(root)); }
  async read(root: string, sessionId: string, limit = 50): Promise<DshNativeSession> {
    const canonicalRoot = canonicalDshRoot(root);
    const native = await this.client.read(canonicalRoot, sessionId, limit);
    this.attest(native, canonicalRoot, sessionId);
    return boundedMessages(native);
  }

  async create(workspaceId: string, root: string, ownerId: string, requestId: string) {
    requireRequestId(requestId);
    const canonicalRoot = canonicalDshRoot(root);
    const sessionId = `session-d2c-${digest(ownerId, workspaceId, requestId).slice(0, 32)}`;
    const existing = this.binding(sessionId);
    if (existing) {
      this.owned(workspaceId, canonicalRoot, sessionId, ownerId);
      await this.read(canonicalRoot, sessionId, 1);
      return { sessionId, workspaceId, ownerId, duplicate: true };
    }
    const created = await this.client.create(canonicalRoot, sessionId,
      `d2c-${digest(ownerId, workspaceId, requestId).slice(0, 32)}`);
    if (created.sessionId !== sessionId || !sameDshRoot(created.cwd, canonicalRoot)) {
      throw new DshNativeError("D2C_IDENTITY_MISMATCH", "Native DSH create returned another workspace or session");
    }
    const bindings = this.loadBindings();
    bindings.push({ sessionId, workspaceId, canonicalRoot, ownerId,
      createdAt: created.createdAt, generation: created.generation });
    this.saveBindings(bindings);
    return { sessionId, workspaceId, ownerId, duplicate: false };
  }

  async attach(workspaceId: string, root: string, sessionId: string, ownerId: string) {
    if (!sessionIdPattern.test(sessionId) || !this.binding(sessionId)) {
      throw new DshNativeError("D2C_ATTACH_UNSUPPORTED", "Desktop/native session control has no provable writer ownership");
    }
    const binding = this.owned(workspaceId, root, sessionId, ownerId);
    const native = await this.read(root, sessionId);
    if (native.running) throw new DshNativeError("D2C_BUSY", "Session has an active writer");
    this.updateGeneration(binding, native.generation);
    return { sessionId, workspaceId, attached: true, generation: native.generation };
  }

  private loadTask(workspaceId: string, taskId: string): DshTaskRecord | null {
    if (!taskIdPattern.test(taskId)) return null;
    try { return JSON.parse(readFileSync(this.taskFile(workspaceId, taskId), "utf8")) as DshTaskRecord; }
    catch { return null; }
  }
  private saveTask(task: DshTaskRecord): void {
    ensureDir(join(this.stateDir, "tasks", task.workspaceId));
    writeSecureJson(this.taskFile(task.workspaceId, task.taskId), task);
  }

  async send(workspaceId: string, root: string, sessionId: string, ownerId: string,
    requestId: string, instruction: string, expectedModel?: string) {
    requireRequestId(requestId);
    if (!sessionIdPattern.test(sessionId) || !instruction.trim() || instruction.length > 20_000) {
      throw new DshNativeError("D2C_BAD_PROMPT", "Owned DSH session and bounded instruction required");
    }
    const binding = this.owned(workspaceId, root, sessionId, ownerId);
    const key = digest(ownerId, workspaceId, sessionId, requestId);
    const taskId = `c2c_dsh_${key.slice(0, 24)}`;
    const nativeRequestId = `d2c-${key.slice(0, 32)}`;
    const instructionHash = digest(instruction);
    const promptSha256 = sha256(instruction);
    const prior = this.loadTask(workspaceId, taskId);
    if (prior) {
      if (prior.instructionHash !== instructionHash || (expectedModel && prior.providerModel !== expectedModel)) {
        throw new DshNativeError("D2C_DUPLICATE_CONFLICT", "Request ID belongs to different content");
      }
      return this.refreshTask(workspaceId, root, taskId);
    }
    const native = await this.read(root, sessionId, 100);
    this.updateGeneration(binding, native.generation);
    const nativePrior = await this.client.task(root, sessionId, nativeRequestId);
    if (nativePrior.sessionId !== sessionId || nativePrior.requestId !== nativeRequestId) {
      throw new DshNativeError("D2C_IDENTITY_MISMATCH", "Native DSH task identity changed");
    }
    if (nativePrior.found && nativePrior.promptSha256 !== promptSha256) {
      throw new DshNativeError("D2C_DUPLICATE_CONFLICT", "Native request ID belongs to different content");
    }
    const latestUser = [...native.messages].reverse().find((message) => message.role === "user");
    if (!nativePrior.found && latestUser && !latestUser.requestId?.startsWith("d2c-")) {
      throw new DshNativeError("D2C_WRITER_CONFLICT", "Another writer used this session");
    }
    const model = nativePrior.final?.model ?? native.selection.model ?? (await this.models()).default.model;
    if (expectedModel && expectedModel !== model) {
      throw new DshNativeError("D2C_MODEL_MISMATCH", "Requested model differs from the native DSH session");
    }
    if (!nativePrior.found) {
      if (native.running) throw new DshNativeError("D2C_BUSY", "Session has an active writer");
      const result = await this.client.send(root, sessionId, nativeRequestId, instruction, native.generation);
      if (!result.accepted || result.sessionId !== sessionId || result.generation !== native.generation) {
        throw new DshNativeError("D2C_IDENTITY_MISMATCH", "Native DSH did not accept the owned turn");
      }
    }
    const task: DshTaskRecord = { taskId, workspaceId, sessionId, ownerId,
      requestId, nativeRequestId, instructionHash, promptSha256,
      instruction: visibleText(instruction, 2000) ?? "", provider: "dsh", providerModel: model,
      status: "accepted", submittedAt: nativePrior.userAt ?? new Date().toISOString(), startedAt: null,
      completedAt: null, outputIds: [], outputAvailable: false, changedFiles: [],
      actionEvidence: { turnCompleted: false, changedFiles: 0, finalOutputCaptured: false },
      nativeEvidence: { terminalSeq: null, terminalReason: null, toolCalls: 0, toolResults: 0 },
      error: null, verification: null };
    this.saveTask(task);
    return nativePrior.found ? this.refreshTask(workspaceId, root, taskId) : task;
  }

  /** Admit an exact-model task with a native runtime lease. The task record is
   * written before transport so an ambiguous outcome is never replayed. */
  async submitSelected(workspaceId: string, root: string, ownerId: string, requestId: string,
    instruction: string, model: string, effort: "low" | "medium" | "high"): Promise<DshTaskRecord> {
    requireRequestId(requestId);
    if (!instruction.trim() || instruction.length > 20_000) {
      throw new DshNativeError("D2C_BAD_PROMPT", "Bounded nonempty instruction required");
    }
    if (!model || !["low", "medium", "high"].includes(effort)) {
      throw new DshNativeError("D2C_BAD_SELECTION", "Exact model and supported effort are required");
    }
    const canonicalRoot = canonicalDshRoot(root);
    const catalog = await this.models();
    const entry = catalog.groups.flatMap((group) => group.models).find((item) => item.id === model);
    if (!entry || !entry.slot || !entry.backend || !entry.profile) {
      throw new DshNativeError("D2C_UNSUPPORTED_MODEL", "Exact DSH model has no configured local slot");
    }
    if (!entry.reasoning?.efforts?.some((item) => item.id === effort)) {
      throw new DshNativeError("D2C_UNSUPPORTED_EFFORT", "Effort is not advertised by this DSH model");
    }
    const { sessionId } = await this.create(workspaceId, canonicalRoot, ownerId, requestId);
    const key = digest(ownerId, workspaceId, sessionId, requestId);
    const taskId = `c2c_dsh_${key.slice(0, 24)}`;
    const nativeRequestId = `d2c-${key.slice(0, 32)}`;
    const instructionHash = digest(instruction);
    const prior = this.loadTask(workspaceId, taskId);
    if (prior) {
      if (prior.ownerId !== ownerId || prior.instructionHash !== instructionHash
        || prior.providerModel !== model || prior.effort !== effort) {
        throw new DshNativeError("D2C_DUPLICATE_CONFLICT", "Request ID belongs to different DSH content");
      }
      return this.refreshTask(workspaceId, canonicalRoot, taskId);
    }
    const native = await this.read(canonicalRoot, sessionId, 100);
    if (native.running) throw new DshNativeError("D2C_BUSY", "Session has an active writer");
    const latestUser = [...native.messages].reverse().find((message) => message.role === "user");
    if (latestUser && !latestUser.requestId?.startsWith("d2c-")) {
      throw new DshNativeError("D2C_WRITER_CONFLICT", "Another writer used this session");
    }
    const task: DshTaskRecord = { taskId, workspaceId, sessionId, ownerId, requestId, nativeRequestId,
      instructionHash, promptSha256: sha256(instruction), instruction: visibleText(instruction, 2000) ?? "",
      provider: "dsh", providerModel: model, effort, selectionScope: "transactional-global-lease",
      leaseSequence: null, status: "admitting", submittedAt: new Date().toISOString(), startedAt: null,
      completedAt: null, outputIds: [], outputAvailable: false, changedFiles: [],
      actionEvidence: { turnCompleted: false, changedFiles: 0, finalOutputCaptured: false },
      nativeEvidence: { terminalSeq: null, terminalReason: null, toolCalls: 0, toolResults: 0 },
      error: null, verification: null };
    this.saveTask(task);
    try {
      const result = await this.client.execute(canonicalRoot, sessionId, nativeRequestId,
        instruction, model, effort, native.generation);
      if (!result.accepted || result.sessionId !== sessionId || result.requestId !== nativeRequestId
        || result.model !== model || result.effort !== effort || result.generation !== native.generation) {
        throw new DshNativeError("D2C_OUTCOME_UNKNOWN", "Selected DSH dispatch outcome is ambiguous");
      }
      task.status = "accepted";
      task.leaseSequence = result.sequence;
      task.resolvedEffort = result.resolvedEffort ?? effort;
      this.saveTask(task);
      return task;
    } catch (error) {
      const code = error instanceof DshNativeError ? error.code : "D2C_OUTCOME_UNKNOWN";
      const refused = new Set(["D2C_UNSUPPORTED_MODEL", "D2C_UNSUPPORTED_EFFORT", "D2C_WRITER_CONFLICT",
        "D2C_LEASE_BUSY", "D2C_LOCAL_RUNTIME_BUSY", "D2C_BAD_SELECTION", "D2C_BAD_PROMPT"]);
      task.status = refused.has(code) ? "failed" : "outcome_unknown";
      task.error = { code: task.status === "failed" ? code : "D2C_OUTCOME_UNKNOWN",
        message: task.status === "failed" ? "Native DSH refused selection before dispatch" : "Native dispatch outcome requires observation; request will not be replayed" };
      this.saveTask(task);
      if (task.status === "failed") throw error;
      throw new DshNativeError("D2C_OUTCOME_UNKNOWN", "Selected DSH dispatch outcome is ambiguous; inspect the owned task");
    }
  }

  async refreshTask(workspaceId: string, root: string, taskId: string): Promise<DshTaskRecord> {
    const task = this.loadTask(workspaceId, taskId);
    if (!task) throw new DshNativeError("D2C_TASK_NOT_FOUND", "Task is not visible");
    const native = await this.client.task(canonicalDshRoot(root), task.sessionId, task.nativeRequestId);
    if (native.sessionId !== task.sessionId || native.requestId !== task.nativeRequestId) {
      throw new DshNativeError("D2C_IDENTITY_MISMATCH", "Native DSH task identity changed");
    }
    if (!native.found) return task; // admitted or ambiguous but not yet durable; never replay
    if (native.promptSha256 !== task.promptSha256) {
      throw new DshNativeError("D2C_IDENTITY_MISMATCH", "Native DSH prompt changed");
    }
    task.startedAt = native.userAt ?? task.startedAt;
    task.nativeEvidence = { terminalSeq: native.terminal?.seq ?? null,
      terminalReason: native.terminal?.reason ?? null,
      toolCalls: native.toolCalls ?? 0, toolResults: native.toolResults ?? 0,
      servedModel: native.served?.model ?? null, servedEffort: native.served?.reasoningEffort ?? null,
      servedProvider: native.served?.provider ?? null };
    const modelMismatch = task.selectionScope === "transactional-global-lease"
      && (native.served?.model !== task.providerModel || native.final?.model !== task.providerModel);
    const effortMismatch = task.selectionScope === "transactional-global-lease"
      && native.served?.reasoningEffort !== (task.resolvedEffort ?? task.effort);
    if (native.terminal && native.final && !native.writerConflict && !modelMismatch && !effortMismatch && task.outputIds.length === 0) {
      const output = saveExecutionOutput(workspaceId, {
        command: "dsh native session final output", raw: native.final.text,
        taskId, ownerId: task.ownerId, sessionId: task.sessionId,
      }, this.stateDir);
      task.outputIds = [output.id];
      task.outputAvailable = output.allowed;
      task.providerModel = native.final.model ?? task.providerModel;
    }
    if (native.terminal) {
      const reason = native.terminal.reason;
      task.status = modelMismatch || effortMismatch ? "failed" : native.writerConflict ? "interrupted"
        : reason === "completed" ? "completed"
        : reason === "aborted" && task.status === "cancel_requested" ? "cancelled"
        : reason === "aborted" ? "interrupted" : "failed";
      task.completedAt = native.terminal.at;
      task.error = modelMismatch
        ? { code: "D2C_MODEL_MISMATCH", message: "Native DSH served a different or unverified model" }
        : effortMismatch
        ? { code: "D2C_EFFORT_MISMATCH", message: "Native DSH served a different or unverified effort" }
        : native.writerConflict
        ? { code: "D2C_WRITER_CONFLICT", message: "Another writer entered the native DSH turn" }
        : task.status === "failed" || task.status === "interrupted"
          ? { code: `D2C_TURN_${reason.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`,
            message: `Native DSH turn ended: ${reason}` } : null;
      task.actionEvidence = { turnCompleted: task.status === "completed", changedFiles: 0,
        finalOutputCaptured: task.outputAvailable };
    } else if (native.writerConflict) {
      task.status = "interrupted";
      task.error = { code: "D2C_WRITER_CONFLICT", message: "Another writer entered the native DSH turn" };
    } else if (task.status !== "cancel_requested") {
      task.status = native.running ? "running" : "accepted";
    }
    this.saveTask(task);
    return task;
  }

  async taskEvents(workspaceId: string, root: string, taskId: string) {
    const task = await this.refreshTask(workspaceId, root, taskId);
    const native = await this.client.task(canonicalDshRoot(root), task.sessionId, task.nativeRequestId);
    return { taskId, terminal: native.terminal ?? null,
      toolCalls: native.toolCalls ?? 0, toolResults: native.toolResults ?? 0,
      events: (native.events ?? []).slice(-20).map((event) => ({
        ...event, text: visibleText(event.text, 16_000) ?? "",
      })).filter((event) => event.text.length > 0) };
  }

  async task(workspaceId: string, root: string, taskId: string): Promise<DshTaskRecord> {
    return this.refreshTask(workspaceId, root, taskId);
  }

  output(workspaceId: string, taskId: string, ownerId: string) {
    const task = this.loadTask(workspaceId, taskId);
    if (!task || task.ownerId !== ownerId || task.outputIds.length === 0) {
      throw new DshNativeError("D2C_OUTPUT_NOT_FOUND", "Owned task output is unavailable");
    }
    const read = readExecutionOutput(workspaceId, task.outputIds[0]!, this.stateDir);
    if (!read.ok) throw new DshNativeError("D2C_OUTPUT_NOT_FOUND", "Owned task output is unavailable");
    return { taskId, outputId: read.meta.id, text: read.text, truncated: read.meta.truncated };
  }

  async cancel(workspaceId: string, root: string, taskId: string, ownerId: string) {
    const task = this.loadTask(workspaceId, taskId);
    if (!task || task.ownerId !== ownerId) throw new DshNativeError("D2C_NOT_OWNER", "Task is not owned by this client");
    this.owned(workspaceId, root, task.sessionId, ownerId);
    const native: DshNativeTask = await this.client.task(canonicalDshRoot(root), task.sessionId, task.nativeRequestId);
    if (!native.found || !native.running || native.terminal || native.writerConflict
      || native.activeRequestId !== task.nativeRequestId) {
      throw new DshNativeError("D2C_NOT_RUNNING", "Owned task is not the active native turn");
    }
    const result = await this.client.cancel(root, task.sessionId, task.nativeRequestId, native.generation);
    if (!result.cancelled) throw new DshNativeError("D2C_NATIVE_ERROR", "Native DSH did not acknowledge cancel");
    task.status = "cancel_requested";
    this.saveTask(task);
    return { taskId, cancelRequested: true };
  }

  static taskExists(stateDir: string, workspaceId: string, taskId: string): boolean {
    return taskIdPattern.test(taskId) && existsSync(join(stateDir, "tasks", workspaceId, `${taskId}.json`));
  }
}
