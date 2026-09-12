import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Workspace } from "../workspace/manager.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import { type ExecutionBackend, type BackendExecutionResult } from "./backend.js";
import { AntigravityBackend, DEFAULT_GEMINI_MODEL } from "./antigravity.js";
import type { PersistedTaskRecord } from "./tasks.js";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import {
  writeEngineeringAiAuditMirror,
  ENGINEERING_AI_AUDIT_STATUS_FILENAME,
  ENGINEERING_AI_AUDIT_TIMELINE_FILENAME,
  ENGINEERING_AI_AUDIT_MIRROR_RELATIVE_PATH,
  ENGINEERING_AI_AUDIT_TIMELINE_RELATIVE_PATH,
  ENGINEERING_AI_AUDIT_STATUS_LEDGER_RELATIVE_PATH,
  ENGINEERING_AI_AUDIT_TIMELINE_LEDGER_RELATIVE_PATH,
  ENGINEERING_AI_WORKSPACE_ID,
  type AuditMirrorEvidence,
  type WriteEngineeringAiAuditMirrorOptions,
} from "./audit-mirror.js";
import { Logger, nullLogger } from "../logger/index.js";

export const AUDIT_MAINTENANCE_TASK_PREFIX = "c2c_audit_maint_";
export const DEFAULT_AUDIT_DEBOUNCE_MS = 1000;

export type TaskLifecycleEventType =
  | "submit"
  | "start"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "timed_out"
  | "restart"
  | "queue_paused"
  | "queue_resumed";

export interface TaskLifecycleEvent {
  type: TaskLifecycleEventType;
  workspaceId: string;
  taskId?: string;
  record?: PersistedTaskRecord;
  paused?: boolean;
  timestamp: string;
  isAuditMaintenance?: boolean;
}

export type MirrorWriterFn = (
  options: WriteEngineeringAiAuditMirrorOptions
) => Promise<AuditMirrorEvidence>;

export interface AuditMaintenanceOptions {
  /** Root directory of state domain (defaults to getStateDir()). */
  stateDir?: string;
  /** Logger instance */
  logger?: Logger;
  /** Workspace registry to resolve Engineering AI workspace */
  registry?: WorkspaceRegistry;
  /** Explicitly supplied Engineering AI workspace id */
  workspaceId?: string;
  /** Direct reference to Engineering AI workspace */
  engineeringAiWorkspace?: Workspace;
  /** Execution backend for Gemini (strictly provider="gemini") */
  geminiBackend?: ExecutionBackend;
  /** Canonical status file path override */
  canonicalStatusPath?: string;
  /** Canonical timeline file path override */
  canonicalTimelinePath?: string;
  /** OneDrive mirror root override */
  oneDriveRoot?: string;
  /** Debounce / coalesce interval in milliseconds (default: 1000ms, test can use 0 or short) */
  debounceMs?: number;
  /** Disable maintenance (for testing or opt-out) */
  disabled?: boolean;
  /** Dependency injection seam for audit mirror writer */
  mirrorWriter?: MirrorWriterFn;
  /** Dependency injection seam for time */
  now?: () => string;
  /** Explicit execution authorization to spawn Gemini with network=true/fullAccess (default: false, fails closed). */
  fullAccess?: boolean;
}

export interface PersistedAuditMaintenanceState {
  version: 1;
  status: "HEALTHY" | "DEGRADED" | "PENDING";
  provider: "gemini";
  model: string;
  lastAttemptAtUtc: string;
  lastSuccessAtUtc: string | null;
  error?: {
    code: string;
    message: string;
  };
  pendingEventsCount: number;
  reconciledEventKeys: string[];
  pendingMirrorRetry?: boolean;
}

export class AuditMaintenanceProviderPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditMaintenanceProviderPolicyError";
  }
}

/**
 * Coordinate permanent Engineering AI audit text maintenance.
 * Provider policy is strictly GEMINI ONLY.
 */
export class EngineeringAiAuditMaintainer {
  readonly stateDir: string;
  private readonly logger: Logger;
  private readonly geminiBackend: ExecutionBackend;
  private readonly engineeringAiWorkspace: Workspace | null;
  private readonly canonicalStatusPath: string | null;
  private readonly canonicalTimelinePath: string | null;
  private readonly oneDriveRoot?: string;
  private readonly debounceMs: number;
  private readonly disabled: boolean;
  private readonly authorized: boolean;
  private readonly mirrorWriter: MirrorWriterFn;
  private readonly now: () => string;

  private pendingEvents: TaskLifecycleEvent[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private refreshChain: Promise<void> = Promise.resolve();
  private closingPromise: Promise<void> | null = null;
  private closed = false;
  private lastSuccessAtUtc: string | null = null;
  private reconciledEventKeys = new Set<string>();
  private pendingMirrorRetry = false;

  constructor(options: AuditMaintenanceOptions = {}) {
    this.stateDir = getStateDir(options.stateDir);
    this.logger = options.logger ?? nullLogger;
    this.debounceMs = options.debounceMs ?? DEFAULT_AUDIT_DEBOUNCE_MS;
    this.mirrorWriter = options.mirrorWriter ?? writeEngineeringAiAuditMirror;
    this.now = options.now ?? (() => new Date().toISOString());

    // 1. Enforce GEMINI ONLY provider policy
    if (options.geminiBackend) {
      if (options.geminiBackend.provider !== "gemini") {
        throw new AuditMaintenanceProviderPolicyError(
          `Provider policy violation: ONLY 'gemini' is permitted for audit maintenance. Received: '${options.geminiBackend.provider}'.`
        );
      }
      this.geminiBackend = options.geminiBackend;
    } else {
      this.geminiBackend = new AntigravityBackend({
        stateDir: this.stateDir,
        defaultModel: DEFAULT_GEMINI_MODEL,
      });
    }

    // 2. Authorization enforcement: Default must fail closed
    this.authorized = options.fullAccess === true;

    // 3. Resolve Engineering AI workspace from supplied workspace, registry, or env.
    // Fail closed / disabled if unavailable or unauthorized (NO hard-coded machine paths/IDs).
    this.engineeringAiWorkspace = this.resolveWorkspace(options);
    const userDisabled = options.disabled === true || process.env.C2C_DISABLE_AUDIT_MAINTENANCE === "true";
    this.disabled = userDisabled || !this.engineeringAiWorkspace || !this.authorized;

    if (!this.authorized) {
      this.logger.warn("Engineering AI audit maintenance execution unauthorized (fullAccess not granted); disabled fail-closed.");
    } else if (!this.engineeringAiWorkspace && !userDisabled) {
      this.logger.warn("Engineering AI workspace unavailable; audit maintenance is disabled fail-closed.");
    }

    // 4. Resolve canonical file paths from workspace or overrides
    if (this.engineeringAiWorkspace) {
      this.canonicalStatusPath = options.canonicalStatusPath ??
        path.join(this.engineeringAiWorkspace.root, ENGINEERING_AI_AUDIT_STATUS_LEDGER_RELATIVE_PATH);
      this.canonicalTimelinePath = options.canonicalTimelinePath ??
        path.join(this.engineeringAiWorkspace.root, ENGINEERING_AI_AUDIT_TIMELINE_LEDGER_RELATIVE_PATH);
    } else {
      this.canonicalStatusPath = options.canonicalStatusPath ?? null;
      this.canonicalTimelinePath = options.canonicalTimelinePath ?? null;
    }

    // 5. Resolve mirror root (without mutating process.env)
    this.oneDriveRoot = options.oneDriveRoot ??
      process.env.C2C_ONEDRIVE_ROOT ??
      process.env.C2C_ONEDRIVE_AUDIT_ROOT ??
      process.env.ENGINEERING_AI_AUDIT_MIRROR_ROOT;

    this.loadState();
  }

  get isAuthorized(): boolean {
    return this.authorized;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isDegraded(): boolean {
    const state = this.readPersistedState();
    return state?.status === "DEGRADED";
  }

  get lastSuccess(): string | null {
    return this.lastSuccessAtUtc;
  }

  get isEnabled(): boolean {
    return this.authorized && !this.disabled && !this.closed && Boolean(this.engineeringAiWorkspace);
  }

  get hasPendingMirror(): boolean {
    return this.pendingMirrorRetry;
  }

  private resolveWorkspace(options: AuditMaintenanceOptions): Workspace | null {
    if (options.engineeringAiWorkspace) {
      return options.engineeringAiWorkspace;
    }

    const targetId = options.workspaceId ??
      process.env.C2C_ENGINEERING_AI_WORKSPACE_ID?.trim() ??
      ENGINEERING_AI_WORKSPACE_ID;

    if (options.registry) {
      try {
        if (targetId && options.registry.has(targetId)) {
          return options.registry.getWorkspace(targetId);
        }
        for (const id of options.registry.enabledIds()) {
          const entry = options.registry.get(id);
          if (entry.name === "engineering-ai" || /engineering-ai/i.test(entry.canonicalPath)) {
            return options.registry.getWorkspace(id);
          }
        }
      } catch {
        // Registry lookup failed
      }
    }

    const configuredRoot = process.env.C2C_ENGINEERING_AI_WORKSPACE_ROOT?.trim();
    if (configuredRoot && fs.existsSync(configuredRoot)) {
      try {
        return new Workspace(configuredRoot);
      } catch {
        return null;
      }
    }

    return null;
  }

  private stateFilePath(): string {
    const dir = ensureDir(path.join(this.stateDir, "audit-maintenance"));
    return path.join(dir, "state.json");
  }

  private loadState(): void {
    const state = this.readPersistedState();
    if (state) {
      this.lastSuccessAtUtc = state.lastSuccessAtUtc ?? null;
      this.pendingMirrorRetry = Boolean(state.pendingMirrorRetry);
      if (Array.isArray(state.reconciledEventKeys)) {
        for (const key of state.reconciledEventKeys) {
          this.reconciledEventKeys.add(key);
        }
      }
    }
  }

  readPersistedState(): PersistedAuditMaintenanceState | null {
    const file = this.stateFilePath();
    return readJsonIfExists<PersistedAuditMaintenanceState>(file);
  }

  private persistState(
    status: "HEALTHY" | "DEGRADED" | "PENDING",
    error?: { code: string; message: string },
    extra: { pendingMirrorRetry?: boolean } = {}
  ): void {
    if (extra.pendingMirrorRetry !== undefined) {
      this.pendingMirrorRetry = extra.pendingMirrorRetry;
    }
    const state: PersistedAuditMaintenanceState = {
      version: 1,
      status,
      provider: "gemini",
      model: DEFAULT_GEMINI_MODEL,
      lastAttemptAtUtc: this.now(),
      lastSuccessAtUtc: this.lastSuccessAtUtc,
      error,
      pendingEventsCount: this.pendingEvents.length,
      reconciledEventKeys: [...this.reconciledEventKeys],
      pendingMirrorRetry: this.pendingMirrorRetry,
    };
    try {
      writeSecureJson(this.stateFilePath(), state);
    } catch (err) {
      this.logger.warn(`Failed to persist audit maintenance state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Check if event was emitted by an audit maintenance task itself.
   * Recursion prevention: audit maintenance tasks must never enqueue further audit tasks.
   */
  private isSelfEvent(event: TaskLifecycleEvent): boolean {
    if (event.isAuditMaintenance) return true;
    if (event.taskId && event.taskId.startsWith(AUDIT_MAINTENANCE_TASK_PREFIX)) return true;
    if (event.record?.taskId && event.record.taskId.startsWith(AUDIT_MAINTENANCE_TASK_PREFIX)) return true;
    return false;
  }

  /**
   * Generate a unique stable key for a lifecycle event to prevent duplicate entries.
   * A "start" event has a different key than a "completed" event for the same task,
   * so start will NOT suppress terminal events.
   */
  private eventKey(event: TaskLifecycleEvent): string {
    if (event.taskId) {
      return `${event.taskId}:${event.type}:${event.timestamp}`;
    }
    return `${event.workspaceId}:${event.type}:${event.timestamp}`;
  }

  /**
   * Schedule or coalesce an audit refresh whenever governed C2C task lifecycle
   * or queue events change.
   */
  notifyEvent(event: TaskLifecycleEvent): void {
    if (!this.isEnabled || this.closingPromise) return;
    if (this.isSelfEvent(event)) return;

    const normalizedEvent: TaskLifecycleEvent = {
      ...event,
      timestamp: event.timestamp?.trim() || this.now(),
    };
    this.pendingEvents.push(normalizedEvent);

    if (this.debounceMs <= 0) {
      void this.triggerRefresh();
      return;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.triggerRefresh();
    }, this.debounceMs);
  }

  /**
   * Determine whether a terminal task record has already been reconciled into the timeline.
   * - If the exact terminal event key is in reconciledEventKeys or timeline, it is reconciled.
   * - If event-key entries exist for this task in the timeline, only the exact terminal event key reconciles it.
   * - If the timeline mentions the taskId but has no event-key entries for it, count as legacy reconciliation.
   */
  private isTerminalTaskReconciled(record: PersistedTaskRecord, timelineContent: string): boolean {
    const key = `${record.taskId}:${record.status}:${record.completedAt ?? record.submittedAt}`;
    if (this.reconciledEventKeys.has(key)) {
      return true;
    }

    const keyTag = `<!-- event-key:${key} -->`;
    if (timelineContent.includes(keyTag)) {
      return true;
    }

    const hasAnyEventKeyForTask = timelineContent.includes(`<!-- event-key:${record.taskId}:`);
    if (hasAnyEventKeyForTask) {
      // Event-key entries exist for this task, so ONLY the exact terminal event key suppresses catch-up
      return false;
    }

    // Legacy compatibility: an old timeline entry mentions the taskId without any event-key comments
    if (timelineContent.includes(record.taskId)) {
      return true;
    }

    return false;
  }

  /**
   * Perform catch-up on bridge startup/restart from persisted task records
   * so missed terminal events are reconciled, and retry any pending mirror writes.
   */
  async catchUp(): Promise<void> {
    if (!this.isEnabled || this.closingPromise) return;

    // Retry any pending mirror if canonical files are already intact
    if (this.pendingMirrorRetry) {
      await this.retryPendingMirror();
    }

    const tasksRoot = path.join(this.stateDir, "tasks");
    if (!fs.existsSync(tasksRoot)) return;

    const timelineContent = this.canonicalTimelinePath && fs.existsSync(this.canonicalTimelinePath)
      ? fs.readFileSync(this.canonicalTimelinePath, "utf8")
      : "";
    const missedTerminalTasks: PersistedTaskRecord[] = [];

    try {
      const workspaceDirs = fs.readdirSync(tasksRoot, { withFileTypes: true });
      for (const wsDir of workspaceDirs) {
        if (!wsDir.isDirectory()) continue;
        const dirPath = path.join(tasksRoot, wsDir.name);
        const taskFiles = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const file of taskFiles) {
          if (!file.isFile() || !file.name.endsWith(".json")) continue;
          const taskId = file.name.slice(0, -5);
          if (taskId.startsWith(AUDIT_MAINTENANCE_TASK_PREFIX)) continue;
          const record = readJsonIfExists<PersistedTaskRecord>(path.join(dirPath, file.name));
          if (!record || record.taskId !== taskId) continue;

          const isTerminal = ["completed", "failed", "cancelled", "interrupted", "timed_out"].includes(record.status);
          if (isTerminal && !this.isTerminalTaskReconciled(record, timelineContent)) {
            missedTerminalTasks.push(record);
          }
        }
      }
    } catch (err) {
      this.logger.warn(`Startup catch-up directory scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Sort chronologically
    missedTerminalTasks.sort((a, b) => {
      const timeA = a.completedAt ?? a.submittedAt;
      const timeB = b.completedAt ?? b.submittedAt;
      return timeA.localeCompare(timeB);
    });

    for (const record of missedTerminalTasks) {
      this.pendingEvents.push({
        type: record.status as TaskLifecycleEventType,
        workspaceId: record.workspaceId,
        taskId: record.taskId,
        record,
        timestamp: record.completedAt ?? record.submittedAt ?? this.now(),
      });
    }

    if (this.pendingEvents.length > 0) {
      await this.triggerRefresh();
    }
  }

  /**
   * Coalesced single-writer trigger.
   */
  async triggerRefresh(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (!this.isEnabled || this.closed || this.closingPromise) return this.refreshChain;

    this.refreshChain = this.refreshChain
      .catch(() => {})
      .then(async () => {
        if (this.closed) return;
        await this.executeRefresh();
      });

    return this.refreshChain;
  }

  private async executeRefresh(): Promise<void> {
    if (this.pendingEvents.length === 0) return;
    if (!this.authorized || this.disabled || !this.engineeringAiWorkspace || !this.canonicalStatusPath || !this.canonicalTimelinePath) return;

    // Drain accumulated events
    const batch = this.pendingEvents.splice(0);

    // Filter out self events (defense in depth) and already reconciled event keys
    const validEvents = batch.filter((e) => !this.isSelfEvent(e) && !this.reconciledEventKeys.has(this.eventKey(e)));
    if (validEvents.length === 0) return;

    const timestampUtc = this.now();

    // 1. Build prompt for Gemini
    const prompt = this.buildGeminiPrompt(validEvents, timestampUtc);

    // 2. Execute via GEMINI ONLY — no silent fallback to Codex, GLM, Omnigent, etc.
    let executionResult: BackendExecutionResult;
    try {
      executionResult = await this.geminiBackend.execute({
        taskId: `${AUDIT_MAINTENANCE_TASK_PREFIX}${Date.now()}_${randomBytes(4).toString("hex")}`,
        workspaceId: this.engineeringAiWorkspace.id,
        workspaceRoot: this.engineeringAiWorkspace.root,
        instruction: prompt,
        writeScope: [this.engineeringAiWorkspace.root],
        writableRoots: [this.engineeringAiWorkspace.root],
        networkRequested: true,
        networkEffective: true,
        fullAccess: true,
        runTests: false,
        model: DEFAULT_GEMINI_MODEL,
        timeoutMs: 60_000,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Gemini audit maintenance execution failed: ${message}`);
      // Re-queue events for next retry
      this.pendingEvents.unshift(...validEvents);
      this.persistState("DEGRADED", {
        code: "GEMINI_UNAVAILABLE",
        message: `Gemini audit text generation failed: ${message}`,
      });
      return;
    }

    if (executionResult.status !== "completed") {
      const errCode = executionResult.error?.code ?? "GEMINI_EXECUTION_FAILED";
      const errMessage = executionResult.error?.message ?? "Gemini did not complete audit maintenance successfully";
      this.logger.warn(`Gemini audit maintenance status=${executionResult.status}, error=${errMessage}`);
      // Re-queue events for next retry
      this.pendingEvents.unshift(...validEvents);
      this.persistState("DEGRADED", {
        code: errCode,
        message: errMessage,
      });
      return;
    }

    const generatedText = executionResult.output?.trim();
    if (!generatedText) {
      this.logger.warn("Gemini produced empty audit text output");
      this.pendingEvents.unshift(...validEvents);
      this.persistState("DEGRADED", {
        code: "EMPTY_OUTPUT",
        message: "Gemini produced empty audit maintenance output",
      });
      return;
    }

    // 3. Write Canonical Files FIRST (Status + Timeline)
    try {
      this.writeCanonicalFiles(generatedText, validEvents, timestampUtc);
    } catch (err) {
      this.logger.error(`Canonical audit file write failed: ${err instanceof Error ? err.message : String(err)}`);
      this.pendingEvents.unshift(...validEvents);
      this.persistState("DEGRADED", {
        code: "CANONICAL_WRITE_FAILED",
        message: `Failed writing canonical audit files: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    // Mark event keys as reconciled
    for (const ev of validEvents) {
      this.reconciledEventKeys.add(this.eventKey(ev));
    }
    this.lastSuccessAtUtc = timestampUtc;

    // 4. Mirror Writes (AFTER CANONICAL SUCCEEDS)
    // Mirror failure leaves canonical files intact AND persists degraded/pending mirror state instead of HEALTHY
    const mirrorOk = await this.mirrorWrites();
    if (mirrorOk) {
      this.pendingMirrorRetry = false;
      this.persistState("HEALTHY");
    } else {
      this.pendingMirrorRetry = true;
      this.persistState("DEGRADED", {
        code: "MIRROR_WRITE_FAILED",
        message: "Canonical files updated successfully, but OneDrive mirror failed. Pending retry.",
      }, { pendingMirrorRetry: true });
    }
  }

  private buildGeminiPrompt(events: TaskLifecycleEvent[], timestampUtc: string): string {
    const eventSummaries = events.map((e) => {
      const task = e.record;
      const provider = task?.provider ?? task?.requestedProvider ?? "not supplied";
      const model = task?.providerModel ?? task?.actualModel ?? task?.requestedModel ?? "not supplied";
      const net = task
        ? `net(req=${task.networkRequested ?? "not supplied"}, eff=${task.networkEffective ?? task.network ?? "not supplied"}, rep=${task.networkReported ?? "not supplied"})`
        : "net(not supplied)";
      const files = task?.changedFiles?.length ? `files=[${task.changedFiles.join(", ")}]` : "files=none";
      const tests = task?.tests ? `tests=${task.tests}` : "tests=not supplied";
      const restart = task?.restartRequired !== undefined ? `restartRequired=${task.restartRequired}` : "";
      const paused = typeof e.paused === "boolean" ? `paused=${e.paused}` : "";
      return `- Event [${e.type}] task=${e.taskId ?? "none"} workspace=${e.workspaceId} provider=${provider} model=${model} ${net} ${files} ${tests} ${restart} ${paused}`.trim();
    });

    let currentSectionSnippet = "";
    if (this.canonicalStatusPath) {
      try {
        if (fs.existsSync(this.canonicalStatusPath)) {
          const full = fs.readFileSync(this.canonicalStatusPath, "utf8");
          const idx = full.indexOf("## Retained historical snapshots");
          currentSectionSnippet = idx >= 0 ? full.slice(0, idx).trim() : full.slice(0, 1000).trim();
        }
      } catch {
        // best effort snippet
      }
    }

    return [
      "You are the authoritative C2C audit maintenance generator for Engineering AI.",
      "Provider policy is GEMINI ONLY for generating/updating the audit text. Network=true and full-access development are authorized.",
      `Current UTC Timestamp: ${timestampUtc}`,
      "",
      "Recent Governed C2C Lifecycle Events:",
      ...eventSummaries,
      "",
      "Previous CURRENT Section (for continuity):",
      currentSectionSnippet || "None available.",
      "",
      "Instructions:",
      "1. Generate the markdown body for the new authoritative CURRENT section in docs/audit-loop-state.md.",
      `2. Start with exact heading: # CURRENT - C2C Audit Maintenance (${timestampUtc})`,
      "3. Summarize the latest lifecycle events, queue progression, provider and model allocation (Gemini sole audit maintainer), network enforcement, and outcome.",
      "4. Do NOT invent missing values. If a field was not supplied, state it truthfully.",
      "5. Output ONLY the markdown text for this CURRENT section without surrounding backticks or preamble.",
    ].join("\n");
  }

  private writeCanonicalFiles(
    generatedStatusContent: string,
    events: TaskLifecycleEvent[],
    timestampUtc: string
  ): void {
    if (!this.canonicalStatusPath || !this.canonicalTimelinePath) return;

    // A. Maintain docs/audit-loop-state.md (One authoritative CURRENT section + retained history)
    this.updateCanonicalStatusFile(generatedStatusContent, timestampUtc);

    // B. Maintain docs/audit-execution-timeline.md (Append-Only Real-Time Material Events)
    this.updateCanonicalTimelineFile(events, timestampUtc);
  }

  private updateCanonicalStatusFile(generatedContent: string, timestampUtc: string): void {
    if (!this.canonicalStatusPath) return;
    ensureDir(path.dirname(this.canonicalStatusPath));

    let existing = "";
    if (fs.existsSync(this.canonicalStatusPath)) {
      existing = fs.readFileSync(this.canonicalStatusPath, "utf8");
    }

    const marker = "## Retained historical snapshots and prior CURRENT sections";

    // Strip markdown code fences if present
    let newCurrent = generatedContent.replace(/^```(?:markdown)?\s*\n/i, "").replace(/\n```\s*$/i, "").trim();
    const modelMarkerIdx = newCurrent.indexOf(marker);
    if (modelMarkerIdx >= 0) {
      newCurrent = newCurrent.slice(0, modelMarkerIdx).trim();
    }
    if (!newCurrent.startsWith("# CURRENT")) {
      newCurrent = `# CURRENT - C2C Audit Maintenance (${timestampUtc})\n\n${newCurrent}`;
    }

    const markerIndex = existing.indexOf(marker);

    let updatedFullText = "";
    if (markerIndex >= 0) {
      // Retain the existing historical snapshots block byte-for-byte unchanged.
      // Do NOT append or demote the previous automated CURRENT each refresh.
      const retainedBlock = existing.slice(markerIndex);
      updatedFullText = `${newCurrent}\n\n${retainedBlock}`;
    } else {
      // Legacy or initial setup: preserve any prior content under the marker.
      const priorHistory = existing.trim();
      if (priorHistory) {
        updatedFullText = `${newCurrent}\n\n${marker}\n\n${priorHistory}\n`;
      } else {
        updatedFullText = `${newCurrent}\n\n${marker}\n`;
      }
    }

    // Atomic write
    this.atomicWriteFile(this.canonicalStatusPath, updatedFullText);
  }

  private updateCanonicalTimelineFile(events: TaskLifecycleEvent[], timestampUtc: string): void {
    if (!this.canonicalTimelinePath) return;
    ensureDir(path.dirname(this.canonicalTimelinePath));

    let existingTimeline = "";
    if (fs.existsSync(this.canonicalTimelinePath)) {
      existingTimeline = fs.readFileSync(this.canonicalTimelinePath, "utf8");
    }

    const newEntries: string[] = [];

    for (const ev of events) {
      const record = ev.record;
      const key = this.eventKey(ev);
      const keyTag = `<!-- event-key:${key} -->`;
      if (existingTimeline.includes(keyTag)) continue;

      const provider = record?.provider ?? record?.requestedProvider ?? "not supplied";
      const model = record?.providerModel ?? record?.actualModel ?? record?.requestedModel ?? "not supplied";
      const providerModel = provider !== "not supplied" && model !== "not supplied"
        ? `${provider} / ${model}`
        : provider !== "not supplied"
        ? provider
        : model !== "not supplied"
        ? model
        : "not supplied";

      const startedAt = record?.startedAt ?? (ev.type === "start" ? ev.timestamp : "not supplied");
      const completedAt = record?.completedAt ?? (["completed", "failed", "cancelled", "interrupted", "timed_out"].includes(ev.type) ? ev.timestamp : "not supplied");

      const netReq = record
        ? (typeof record.networkRequested === "boolean" ? String(record.networkRequested) : "not supplied")
        : "not supplied";
      const netEff = record
        ? (typeof record.networkEffective === "boolean"
          ? String(record.networkEffective)
          : typeof record.network === "boolean"
          ? String(record.network)
          : "not supplied")
        : "not supplied";
      const netRep = record
        ? (typeof record.networkReported === "boolean" ? String(record.networkReported) : "not supplied")
        : "not supplied";
      const network = `req=${netReq}, eff=${netEff}, rep=${netRep}`;

      const status = record?.status ?? ev.type;
      const outcome = record?.exitStatus ? `${status} (${record.exitStatus})` : status;

      const changedFiles = record?.changedFiles && record.changedFiles.length > 0
        ? record.changedFiles.join(", ")
        : "none";
      const tests = record?.tests ?? "not supplied";
      const restartRequired = record
        ? (typeof record.restartRequired === "boolean" ? (record.restartRequired ? "true" : "false") : "not supplied")
        : "not supplied";
      const queuePaused = typeof ev.paused === "boolean" ? String(ev.paused) : "not supplied";

      const section = [
        `## Event [${ev.type}] - ${ev.taskId ?? ev.workspaceId} (${ev.timestamp}) ${keyTag}`,
        "",
        "| field | value |",
        "|---|---|",
        `| event_type | \`${ev.type}\` |`,
        `| workspace_id | \`${ev.workspaceId}\` |`,
        `| task_id | ${ev.taskId ? `\`${ev.taskId}\`` : "not supplied"} |`,
        `| provider_model | ${providerModel} |`,
        `| started_at_utc | ${startedAt} |`,
        `| completed_at_utc | ${completedAt} |`,
        `| network | ${network} |`,
        `| status_outcome | ${outcome} |`,
        `| changed_files | ${changedFiles} |`,
        `| tests | ${tests} |`,
        `| restart_required | ${restartRequired} |`,
        `| queue_paused | ${queuePaused} |`,
        "",
      ].join("\n");

      newEntries.push(section);
      existingTimeline += `\n${keyTag}\n`;
    }

    if (newEntries.length > 0) {
      let baseContent = fs.existsSync(this.canonicalTimelinePath)
        ? fs.readFileSync(this.canonicalTimelinePath, "utf8")
        : "# Audit execution timeline\n\nThis append-only file is the canonical timeline for C2C execution metadata.\n\n";

      if (!baseContent.endsWith("\n")) baseContent += "\n";
      const appendedContent = baseContent + newEntries.join("\n");
      this.atomicWriteFile(this.canonicalTimelinePath, appendedContent);
    }
  }

  private atomicWriteFile(targetPath: string, content: string): void {
    const parent = path.dirname(targetPath);
    ensureDir(parent);
    const tempPath = path.join(
      parent,
      `.${path.basename(targetPath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
    );

    let fd: number | undefined;
    try {
      fd = fs.openSync(tempPath, "wx", 0o600);
      fs.writeSync(fd, Buffer.from(content, "utf8"));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tempPath, targetPath);
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // ignore
      }
    }
  }

  private async mirrorWrites(): Promise<boolean> {
    if (!this.engineeringAiWorkspace || !this.canonicalStatusPath || !this.canonicalTimelinePath) {
      return true; // No workspace to mirror from
    }

    let statusOk = false;
    let timelineOk = false;

    // 1. Status Mirror
    try {
      const statusEvidence = await this.mirrorWriter({
        oneDriveRoot: this.oneDriveRoot,
        requestedPath: ENGINEERING_AI_AUDIT_MIRROR_RELATIVE_PATH,
        source: "engineering_ai_ledger",
        ledgerWorkspace: this.engineeringAiWorkspace,
        stateDir: this.stateDir,
        recordWorkspaceId: this.engineeringAiWorkspace.id,
      });
      statusOk = statusEvidence.success;
      if (!statusOk) {
        this.logger.warn(`Status mirror write reported failure: ${statusEvidence.message ?? statusEvidence.code}`);
      }
    } catch (err) {
      this.logger.warn(`Status mirror write threw error: ${err instanceof Error ? err.message : String(err)}`);
      // Mirror failure must NEVER corrupt or revert canonical files.
      statusOk = false;
    }

    // 2. Timeline Mirror
    try {
      const timelineEvidence = await this.mirrorWriter({
        oneDriveRoot: this.oneDriveRoot,
        requestedPath: ENGINEERING_AI_AUDIT_TIMELINE_RELATIVE_PATH,
        source: "engineering_ai_ledger",
        ledgerWorkspace: this.engineeringAiWorkspace,
        stateDir: this.stateDir,
        recordWorkspaceId: this.engineeringAiWorkspace.id,
      });
      timelineOk = timelineEvidence.success;
      if (!timelineOk) {
        this.logger.warn(`Timeline mirror write reported failure: ${timelineEvidence.message ?? timelineEvidence.code}`);
      }
    } catch (err) {
      this.logger.warn(`Timeline mirror write threw error: ${err instanceof Error ? err.message : String(err)}`);
      // Mirror failure must NEVER corrupt or revert canonical files.
      timelineOk = false;
    }

    return statusOk && timelineOk;
  }

  private async retryPendingMirror(): Promise<void> {
    this.logger.info("Retrying pending audit mirror writes...");
    const ok = await this.mirrorWrites();
    if (ok) {
      this.pendingMirrorRetry = false;
      this.persistState("HEALTHY");
    } else {
      this.pendingMirrorRetry = true;
      this.persistState(
        "DEGRADED",
        {
          code: "MIRROR_WRITE_FAILED",
          message: "Canonical files updated successfully, but OneDrive mirror retry failed.",
        },
        { pendingMirrorRetry: true }
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closingPromise) return this.closingPromise;

    this.closingPromise = (async () => {
      // 1. Cancel active debounce timer
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }

      // 2. Flush and await already pending events before marking closed, so final events are not silently lost
      if (this.authorized && !this.disabled && Boolean(this.engineeringAiWorkspace)) {
        this.refreshChain = this.refreshChain
          .catch(() => {})
          .then(async () => {
            while (this.pendingEvents.length > 0) {
              const countBefore = this.pendingEvents.length;
              await this.executeRefresh();
              if (this.pendingEvents.length >= countBefore) {
                // executeRefresh did not consume events (e.g. backend failed and re-queued);
                // break to prevent infinite loop
                break;
              }
            }
          });
      }

      // 3. Await completion of all pending refreshes
      await this.refreshChain.catch(() => {});

      // 4. Mark closed
      this.closed = true;
    })();

    return this.closingPromise;
  }
}
