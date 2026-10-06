import { join } from "node:path";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  ZcodeSessionClient,
  type ZcodeDiscoveredSession,
} from "../execution/zcode-session-client.js";
import type { ZcodeSessionOwnership } from "../execution/zcode-session-ownership.js";
import { DshNativeClient, type DshNativeSummary } from "../execution/dsh-native-client.js";
import { DshNativeService } from "../execution/dsh-native-service.js";
import { listExecutionOutputs, readExecutionOutput } from "../execution/output.js";
import { ZcodeSessionError } from "../execution/zcode-session-client.js";
import { AgentPlaneStore } from "./store.js";
import { projectZcodeDiscovery } from "./adapters/zcode.js";
import { projectDshDiscovery } from "./adapters/dsh.js";
import { projectProviderTasks, taskView, readTaskFile } from "./adapters/tasks.js";
import { visibleText } from "./redact.js";
import type { AgentSessionRecord, AgentActivityEvent, AgentPlaneMessage, AgentProviderName, AgentSessionOrigin, AgentTaskView } from "./types.js";

/** Bounded, credential-free reason for honest live-read failure reporting. */
function sanitizeLiveError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * Honest classification of a failed zcode live enrichment.
 *
 * SESSION_NOT_FOUND from the Z2C observation surface means the runtime does
 * not consider this session live-readable in the current app-server
 * generation (legacy/pre-restart session, closed session, or a binding
 * mismatch). For a discovery-projected record that is an EXPECTED legacy
 * condition, not a lane defect: it is reported as "stale-runtime" so the
 * projection stays coherent and non-breaking. The session is never implicitly
 * resumed (resume is a control action); a later successful read overwrites
 * the status. Lane failures (transport/timeout/service errors) stay "error".
 */
function zcodeLiveReadFailure(error: unknown): { live_read_status: "stale-runtime" | "error"; last_live_error: string } {
  const upstreamCode = error instanceof ZcodeSessionError ? error.upstreamCode : undefined;
  if (upstreamCode === "SESSION_NOT_FOUND") {
    return {
      live_read_status: "stale-runtime",
      last_live_error: "not live-readable in the current ZCode runtime generation (legacy, closed, or foreign-bound session); resume it explicitly to make it live",
    };
  }
  return { live_read_status: "error", last_live_error: sanitizeLiveError(error) };
}

/**
 * The provider-neutral shared session/activity plane.
 *
 * One projection over four provider lanes, including native DSH sessions:
 *   zcode  ← Z2C local-operator discovery (native session/list) + A2C ownership
 *   codex  ← A2C durable task records (origin a2c)
 *   gemini ← A2C durable task records (origin a2c, providerSessionId)
 *
 * Authorization model:
 *   OBSERVE — any caller workspace-authorized for the record's workspace sees
 *   the record, its visible messages, tasks, and outputs. The local operator
 *   ("local") observes every authorized workspace.
 *   CONTROL — never granted here. Control stays owner-bound in each provider's
 *   own enforcement path (zcode-session-ownership v2 / task access checks);
 *   records only project WHO controls (controllers[]).
 *
 * Fail-closed: foreign workspaces get the same "not visible" denial as
 * unknown ids (no existence oracle across the boundary).
 */

export class AgentPlaneError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "AGENT_PLANE_SESSION_NOT_VISIBLE"
      | "AGENT_PLANE_WORKSPACE_FORBIDDEN"
      | "AGENT_PLANE_TASK_NOT_FOUND"
      | "AGENT_PLANE_OUTPUT_NOT_FOUND"
      | "AGENT_PLANE_OUTPUT_RESTRICTED",
  ) {
    super(message);
    this.name = "AgentPlaneError";
  }
}

export interface AgentPlaneDeps {
  stateDir: string;
  /** A2C-authorized workspaces (id + canonical root). */
  workspaces: () => Array<{ workspaceId: string; canonicalPath: string }>;
  /** Z2C semantic client; null disables the zcode lane (plane stays usable). */
  zcodeClient: ZcodeSessionClient | null;
  dshClient?: DshNativeClient | null;
  ownership: ZcodeSessionOwnership;
}

export interface SessionQuery {
  provider?: AgentProviderName;
  origin?: AgentSessionOrigin;
  workspaceId?: string;
  limit?: number;
  cursor?: string;
}

export class AgentPlane {
  readonly store: AgentPlaneStore;
  private lastZcodeSync = 0;
  private discoveredZcode: ZcodeDiscoveredSession[] = [];
  private lastOwnershipCount = -1;
  private lastDshSync = 0;
  private discoveredDsh: Array<{ workspaceId: string; canonicalPath: string; item: DshNativeSummary }> = [];
  private staleDshWorkspaces = new Set<string>();

  constructor(private readonly deps: AgentPlaneDeps) {
    this.store = new AgentPlaneStore(deps.stateDir);
  }

  // ── authorization ─────────────────────────────────────────────────────────
  visibleWorkspaces(authInfo: AuthInfo | undefined): Array<{ workspaceId: string; canonicalPath: string }> {
    const all = this.deps.workspaces();
    if (!authInfo) return all; // local operator
    const raw = (authInfo as { extra?: { authorizedWorkspaceIds?: unknown } }).extra?.authorizedWorkspaceIds;
    const authorized = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
    if (authorized.length === 0) return [];
    const allowed = new Set(authorized);
    return all.filter((w) => allowed.has(w.workspaceId));
  }

  private canObserve(authInfo: AuthInfo | undefined, record: AgentSessionRecord): boolean {
    return this.visibleWorkspaces(authInfo).some((w) => w.workspaceId === record.workspaceId);
  }

  /** Informational CONTROL projection (enforcement lives in provider paths). */
  callerCanControl(authInfo: AuthInfo | undefined, record: AgentSessionRecord): boolean {
    const principal = !authInfo ? "local" : ((authInfo as { clientId?: unknown }).clientId as string | undefined) ?? "local";
    return record.controllers.includes(principal);
  }

  private visibleOrThrow(authInfo: AuthInfo | undefined, sessionId: string): AgentSessionRecord {
    const record = this.store.loadSessions().find((s) => s.sessionId === sessionId);
    if (!record || !this.canObserve(authInfo, record)) {
      // Unknown and unauthorized lookups are indistinguishable by design.
      throw new AgentPlaneError(`agent session is not visible: ${sessionId.slice(0, 16)}…`, "AGENT_PLANE_SESSION_NOT_VISIBLE");
    }
    return record;
  }

  // ── sync / projection ─────────────────────────────────────────────────────
  /** Refresh the projection: Z2C discovery (TTL-cached) + provider task records. */
  async sync(force = false): Promise<{ zcode: number; codex: number; gemini: number; dsh: number }> {
    const observedAt = new Date().toISOString();
    const workspaces = this.deps.workspaces();
    const previous = new Map(this.store.loadSessions().map((s) => [s.sessionId, s]));

    let zcodeRecords: AgentSessionRecord[] = [];
    let zcodeEvents: ReturnType<typeof projectZcodeDiscovery>["events"] = [];
    // Discovery refreshes on its TTL, but a changed ownership count (a newly
    // A2C-created session) always forces an immediate refresh.
    const ownedCount = this.deps.ownership.count();
    const ownershipChanged = ownedCount !== this.lastOwnershipCount;
    this.lastOwnershipCount = ownedCount;
    if (this.deps.zcodeClient && (force || ownershipChanged || Date.now() - this.lastZcodeSync > 3_000)) {
      try {
        const { sessions } = await this.deps.zcodeClient.discoverSessions();
        this.discoveredZcode = sessions;
        this.lastZcodeSync = Date.now();
      } catch {
        this.discoveredZcode = []; // lane down: keep last projection, mark stale
      }
    }
    if (this.deps.zcodeClient) {
      const projected = projectZcodeDiscovery({
        discovered: this.discoveredZcode,
        workspaces,
        ownershipRecord: (sessionId) => {
          const owned = this.deps.ownership.sessionRecord(sessionId);
          return owned ? { clientId: owned.clientId, delegatedControllers: owned.delegatedControllers } : undefined;
        },
        previous,
        observedAt,
      });
      zcodeRecords = projected.records;
      zcodeEvents = projected.events;
    }

    const tasks = projectProviderTasks({ stateDir: this.deps.stateDir, workspaces, observedAt });

    const dshFresh = new Set<string>();
    if (this.deps.dshClient && (force || Date.now() - this.lastDshSync > 3_000)) {
      const results = await Promise.all(workspaces.map(async (workspace) => {
        try { return { workspace, result: await this.deps.dshClient!.list(workspace.canonicalPath) }; }
        catch { return { workspace, result: null }; }
      }));
      for (const { workspace, result } of results) {
        if (!result) {
          this.staleDshWorkspaces.add(workspace.workspaceId);
          continue;
        }
        dshFresh.add(workspace.workspaceId);
        this.staleDshWorkspaces.delete(workspace.workspaceId);
        this.discoveredDsh = this.discoveredDsh.filter((entry) => entry.workspaceId !== workspace.workspaceId);
        this.discoveredDsh.push(...result.items.map((item) => ({
          workspaceId: workspace.workspaceId, canonicalPath: workspace.canonicalPath, item,
        })));
      }
      this.lastDshSync = Date.now();
    }
    let dshBindings: ReturnType<DshNativeService["bindings"]> = [];
    if (this.deps.dshClient) {
      try { dshBindings = new DshNativeService(this.deps.stateDir, this.deps.dshClient).bindings(); }
      catch { /* invalid ownership store grants no projected controller */ }
    }
    const dsh = projectDshDiscovery({ discovered: this.discoveredDsh, bindings: dshBindings,
      taskRecords: tasks.records, observedAt });
    for (const record of dsh.records) {
      if (this.staleDshWorkspaces.has(record.workspaceId)) record.live_read_status = "stale-cache";
    }

    // A successful native list replaces that workspace's previous DSH snapshot.
    const merged = new Map(previous);
    for (const record of previous.values()) {
      if (record.provider === "dsh" && dshFresh.has(record.workspaceId)) merged.delete(record.sessionId);
      else if (record.provider === "dsh" && this.staleDshWorkspaces.has(record.workspaceId)) {
        merged.set(record.sessionId, { ...record, controllers: [],
          live_read_status: "stale-cache" });
      }
    }
    for (const record of [...zcodeRecords, ...tasks.records]) merged.set(record.sessionId, record);
    for (const record of dsh.records) merged.set(record.sessionId, record);
    const discoveredDshIds = new Set(dsh.records.map((record) => record.sessionId));
    for (const record of tasks.records) {
      if (record.provider === "dsh" && !discoveredDshIds.has(record.sessionId)) {
        merged.set(record.sessionId, { ...record, controllers: [], ownerClientId: null,
          live_read_status: "stale-cache",
          last_live_error: "native session absent from DSH discovery" });
      }
    }
    const sessions = [...merged.values()];

    const before = JSON.stringify([...previous.values()].map(sortKey));
    const after = JSON.stringify(sessions.map(sortKey));
    if (before !== after) this.store.saveSessions(sessions);
    this.store.appendActivity([...zcodeEvents, ...tasks.events, ...dsh.events]);

    return {
      zcode: zcodeRecords.length,
      codex: tasks.records.filter((r) => r.provider === "codex").length,
      gemini: tasks.records.filter((r) => r.provider === "gemini").length,
      dsh: dsh.records.length,
    };
  }

  // ── queries ───────────────────────────────────────────────────────────────
  async listSessions(
    authInfo: AuthInfo | undefined,
    query: SessionQuery = {},
  ): Promise<{ sessions: AgentSessionRecord[]; nextCursor: string | null }> {
    await this.sync().catch(() => undefined);
    const visible = new Set(this.visibleWorkspaces(authInfo).map((w) => w.workspaceId));
    const limit = Math.max(1, Math.min(query.limit ?? 50, 100));
    let offset = 0;
    if (query.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")) as { o?: unknown };
        offset = typeof decoded.o === "number" && decoded.o >= 0 ? decoded.o : 0;
      } catch {
        offset = 0;
      }
    }
    const filtered = this.store
      .loadSessions()
      .filter((s) => visible.has(s.workspaceId))
      .filter((s) => (query.provider ? s.provider === query.provider : true))
      .filter((s) => (query.origin ? s.origin === query.origin : true))
      .filter((s) => (query.workspaceId ? s.workspaceId === query.workspaceId : true))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const page = filtered.slice(offset, offset + limit);
    const nextCursor = offset + limit < filtered.length
      ? Buffer.from(JSON.stringify({ o: offset + limit }), "utf8").toString("base64url")
      : null;
    return { sessions: page, nextCursor };
  }

  async readSession(authInfo: AuthInfo | undefined, sessionId: string): Promise<AgentSessionRecord> {
    await this.sync().catch(() => undefined);
    let record = this.visibleOrThrow(authInfo, sessionId);
    if (record.provider === "zcode") {
      // A failed live refresh is surfaced on the record instead of silently
      // returning a stale projection as if it were live. Legacy/pre-restart
      // sessions (runtime no longer considers them live) are reported as
      // "stale-runtime" — explicit, non-breaking, never auto-resumed.
      try {
        record = await this.enrichZcode(record);
      } catch (error) {
        record = { ...record, ...zcodeLiveReadFailure(error) };
      }
    } else if (record.provider === "dsh") {
      try { record = await this.enrichDsh(record); }
      catch (error) { record = { ...record, live_read_status: "error", last_live_error: sanitizeLiveError(error) }; }
    }
    return record;
  }

  /** Live attestation enrichment for zcode sessions (best-effort, persisted, honestly labelled). */
  private async enrichZcode(record: AgentSessionRecord): Promise<AgentSessionRecord> {
    if (!this.deps.zcodeClient || !record.zcodeWorkspaceId) {
      return { ...record, live_read_status: "skipped", messages_readable: null, last_live_error: "no Z2C discovery client bound" };
    }
    const state = await this.deps.zcodeClient.observeSession({
      workspace_id: record.zcodeWorkspaceId,
      session_id: record.sessionId,
    });
    const enriched: AgentSessionRecord = {
      ...record,
      model: state.model_id ?? record.model,
      thoughtLevel: state.thought_level ?? record.thoughtLevel,
      observedAt: new Date().toISOString(),
      live_read_status: "ok",
      messages_readable: null,
      last_live_error: null,
    };
    this.mergeRecord(enriched);
    return enriched;
  }

  private async enrichDsh(record: AgentSessionRecord): Promise<AgentSessionRecord> {
    if (!this.deps.dshClient) {
      return { ...record, live_read_status: "skipped", messages_readable: null,
        last_live_error: "no DSH native adapter bound" };
    }
    const native = await this.deps.dshClient.read(record.canonicalRoot, record.sessionId, 50);
    const lastUser = [...native.messages].reverse().find((message) => message.role === "user");
    const enriched: AgentSessionRecord = { ...record,
      model: native.selection.model ?? record.model,
      thoughtLevel: native.selection.reasoningEffort ?? record.thoughtLevel,
      status: native.running ? "running" : record.status === "running" ? native.status : record.status,
      lastUserInstruction: visibleText(lastUser?.text, 2000) ?? record.lastUserInstruction,
      observedAt: new Date().toISOString(), live_read_status: "ok",
      messages_readable: true, last_live_error: null };
    this.mergeRecord(enriched);
    return enriched;
  }

  private mergeRecord(record: AgentSessionRecord): void {
    const sessions = this.store.loadSessions();
    const idx = sessions.findIndex((s) => s.sessionId === record.sessionId);
    if (idx === -1) sessions.push(record);
    else sessions[idx] = record;
    this.store.saveSessions(sessions);
  }

  /**
   * Visible messages only: user instructions and assistant final responses.
   * zcode sessions are read live through the Z2C local-operator observation
   * surface; codex/gemini sessions project the stored instruction plus the
   * captured final assistant output through the sanitized output reader.
   */
  async sessionMessages(
    authInfo: AuthInfo | undefined,
    sessionId: string,
    limit = 20,
  ): Promise<{ sessionId: string; provider: AgentProviderName; origin: AgentSessionOrigin; messages: AgentPlaneMessage[]; messages_readable?: boolean; live_read_status?: string; failure?: string }> {
    await this.sync().catch(() => undefined);
    let record = this.visibleOrThrow(authInfo, sessionId);
    const boundedLimit = Math.max(1, Math.min(limit, 50));
    if (record.provider === "zcode") {
      try {
        record = await this.enrichZcode(record);
      } catch (error) {
        record = { ...record, ...zcodeLiveReadFailure(error) };
      }
      try {
        const messages = await this.zcodeMessages(record, boundedLimit);
        return { sessionId, provider: "zcode", origin: record.origin, messages, messages_readable: true, live_read_status: record.live_read_status ?? "ok" };
      } catch (error) {
        // Message-read failures are returned honestly (with a bounded,
        // sanitized reason) instead of an empty list pretending success.
        return {
          sessionId,
          provider: "zcode",
          origin: record.origin,
          messages: [],
          messages_readable: false,
          live_read_status: record.live_read_status ?? "error",
          failure: sanitizeLiveError(error),
        };
      }
    }
    if (record.provider === "dsh") {
      try {
        record = await this.enrichDsh(record);
        if (!this.deps.dshClient) throw new Error("DSH native adapter is unavailable");
        const native = await this.deps.dshClient.read(record.canonicalRoot, sessionId, boundedLimit);
        const messages: AgentPlaneMessage[] = native.messages.slice(-boundedLimit)
          .map((message) => ({ role: message.role,
            text: visibleText(message.text, 16_000) ?? "", at: message.at }))
          .filter((message) => message.text.length > 0);
        return { sessionId, provider: "dsh", origin: record.origin, messages,
          messages_readable: true, live_read_status: "ok" };
      } catch (error) {
        return { sessionId, provider: "dsh", origin: record.origin, messages: [],
          messages_readable: false, live_read_status: "error", failure: sanitizeLiveError(error) };
      }
    }
    return { sessionId, provider: record.provider, origin: record.origin, messages: await this.taskMessages(record, boundedLimit) };
  }

  private async zcodeMessages(record: AgentSessionRecord, limit: number): Promise<AgentPlaneMessage[]> {
    if (!this.deps.zcodeClient || !record.zcodeWorkspaceId) return [];
    const { messages } = await this.deps.zcodeClient.observeSessionMessages({
      workspace_id: record.zcodeWorkspaceId,
      session_id: record.sessionId,
      limit,
    });
    const projected: AgentPlaneMessage[] = [];
    for (const raw of messages) {
      const info = (raw as { info?: { role?: unknown } }).info;
      const role = typeof info?.role === "string" ? info.role : null;
      if (role !== "user" && role !== "assistant") continue; // visible roles only
      const parts = Array.isArray((raw as { parts?: unknown }).parts) ? ((raw as { parts: Array<Record<string, unknown>> }).parts) : [];
      const text = parts
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n");
      const visible = visibleText(text, 16_000);
      if (!visible) continue;
      projected.push({
        role,
        text: visible,
        truncated: visible.length > 15_900 ? true : undefined,
        at: null,
      });
      if (projected.length >= limit) break;
    }
    // Remember the latest visible instruction in the projection.
    const lastUser = [...projected].reverse().find((m) => m.role === "user");
    if (lastUser && lastUser.text !== record.lastUserInstruction) {
      this.mergeRecord({ ...record, lastUserInstruction: lastUser.text.slice(0, 2000) });
    }
    return projected;
  }

  private async taskMessages(record: AgentSessionRecord, limit: number): Promise<AgentPlaneMessage[]> {
    const messages: AgentPlaneMessage[] = [];
    if (record.lastUserInstruction) {
      messages.push({ role: "user", text: record.lastUserInstruction, at: record.createdAt, outputRef: null });
    }
    const ref = record.lastAssistantOutput;
    if (ref) {
      const read = readExecutionOutput(ref.workspaceId, ref.outputId, this.deps.stateDir || undefined);
      if (read.ok) {
        messages.push({
          role: "assistant",
          text: visibleText(read.text, 16_000) ?? "",
          at: read.meta.timestamp,
          outputRef: ref,
        });
      } else {
        messages.push({ role: "assistant", text: "", restricted: true, at: null, outputRef: ref });
      }
    }
    return messages.slice(0, limit);
  }

  async listActivity(
    authInfo: AuthInfo | undefined,
    query: { provider?: AgentProviderName; sessionId?: string; workspaceId?: string; afterSeq?: number; limit?: number } = {},
  ): Promise<{ events: AgentActivityEvent[]; lastSeq: number }> {
    await this.sync().catch(() => undefined);
    const visible = new Set(this.visibleWorkspaces(authInfo).map((w) => w.workspaceId));
    const { events, lastSeq } = this.store.readActivity({
      afterSeq: query.afterSeq,
      limit: query.limit,
      provider: query.provider,
      sessionId: query.sessionId,
      workspaceId: query.workspaceId,
    });
    const isLocal = !authInfo;
    return {
      events: events.filter((e) => (e.workspaceId !== null ? visible.has(e.workspaceId) : isLocal)),
      lastSeq,
    };
  }

  /** Cross-client observable task view (observe-authorized callers). */
  readTask(authInfo: AuthInfo | undefined, workspaceId: string, taskId: string): AgentTaskView {
    if (!this.visibleWorkspaces(authInfo).some((w) => w.workspaceId === workspaceId)) {
      throw new AgentPlaneError("workspace is not authorized for this caller", "AGENT_PLANE_WORKSPACE_FORBIDDEN");
    }
    if (!/^c2c_[0-9a-zA-Z_-]{6,64}$/.test(taskId)) {
      throw new AgentPlaneError("task id is invalid", "AGENT_PLANE_TASK_NOT_FOUND");
    }
    const record = readTaskFile(join(this.deps.stateDir, "tasks", workspaceId, `${taskId}.json`));
    if (!record) throw new AgentPlaneError("task is not visible", "AGENT_PLANE_TASK_NOT_FOUND");
    return taskView(workspaceId, record);
  }

  /** Sanitized captured output body (already redacted at capture time). */
  readOutput(
    authInfo: AuthInfo | undefined,
    workspaceId: string,
    outputId: number,
  ): { meta: { id: number; command: string | null; taskId: string | null; timestamp: string; truncated: boolean; sizeBytes: number }; text: string } {
    if (!this.visibleWorkspaces(authInfo).some((w) => w.workspaceId === workspaceId)) {
      throw new AgentPlaneError("workspace is not authorized for this caller", "AGENT_PLANE_WORKSPACE_FORBIDDEN");
    }
    if (!Number.isInteger(outputId) || outputId < 1) {
      throw new AgentPlaneError("output id is invalid", "AGENT_PLANE_OUTPUT_NOT_FOUND");
    }
    const read = readExecutionOutput(workspaceId, outputId, this.deps.stateDir || undefined);
    if (!read.ok) {
      throw new AgentPlaneError(
        read.error === "OUTPUT_RESTRICTED" ? "output is restricted" : "output is not visible",
        read.error === "OUTPUT_RESTRICTED" ? "AGENT_PLANE_OUTPUT_RESTRICTED" : "AGENT_PLANE_OUTPUT_NOT_FOUND",
      );
    }
    return {
      meta: {
        id: read.meta.id,
        command: visibleText(read.meta.command, 200),
        taskId: read.meta.taskId ?? null,
        timestamp: read.meta.timestamp,
        truncated: read.meta.truncated,
        sizeBytes: read.meta.sizeBytes,
      },
      text: read.text,
    };
  }

  /** Output catalog for a workspace (bounded), for output_ref discovery. */
  listOutputs(authInfo: AuthInfo | undefined, workspaceId: string, limit = 20) {
    if (!this.visibleWorkspaces(authInfo).some((w) => w.workspaceId === workspaceId)) {
      throw new AgentPlaneError("workspace is not authorized for this caller", "AGENT_PLANE_WORKSPACE_FORBIDDEN");
    }
    return listExecutionOutputs(workspaceId, Math.min(Math.max(1, limit), 40), this.deps.stateDir || undefined).map((m) => ({
      id: m.id,
      command: visibleText(m.command, 200),
      taskId: m.taskId ?? null,
      sessionId: m.sessionId ?? null,
      timestamp: m.timestamp,
      allowed: m.allowed,
      truncated: m.truncated,
      sizeBytes: m.sizeBytes,
    }));
  }
}

function sortKey(record: AgentSessionRecord): string {
  return JSON.stringify([
    record.sessionId,
    record.provider,
    record.origin,
    record.status,
    record.model,
    record.thoughtLevel,
    record.updatedAt,
    record.taskIds,
    record.ownerClientId,
  ]);
}
