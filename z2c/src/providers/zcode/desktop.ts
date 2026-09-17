import { Socket, createConnection } from "node:net";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { Z2cConfig } from "../../config.js";
import { canonicalizeWorkspacePath } from "../../core/workspaces/registry.js";
import type {
  AgentProvider,
  CapabilityProbeResult,
  ProviderBinding,
  ProviderRunHandle,
  ProviderSendOptions,
  ProviderSessionSummary,
  ProviderTurnResult,
  ProviderWorkspaceRef,
  ReadAssistantOutputOptions,
} from "../types.js";
import type { SameSessionModelUpdate, SameSessionModelUpdateResult } from "../types.js";
import { ZcodeProcess } from "./process.js";
import { ZcodeProtocol, ZcodeProtocolError } from "./protocol.js";

const REQUIRED_METHODS = ["session/create", "session/send", "session/list", "session/stop"] as const;

interface DesktopAgentRegistration {
  port: number;
  token: string;
  pid: number;
  workspace: string;
  startedAt: number;
}

/**
 * Controls a REAL Desktop-owned ZCode agent: the agent child is spawned by the
 * running ZCode Desktop via the ZCODE_AGENT_SERVER_COMMAND override, so the
 * Desktop host performs all model authentication (Coding Plan) itself.
 * Z2C attaches as an additional protocol client through the proxy's
 * localhost-only, token-authenticated control channel and never sees,
 * mints, or persists provider credentials.
 */
export class DesktopZCodeProvider implements AgentProvider {
  readonly name = "zcode-desktop";
  status: AgentProvider["status"] = "stopped";
  statusDetail?: string;
  providerVersion: string | null = null;
  capabilityResult: CapabilityProbeResult | null = null;

  private registration: DesktopAgentRegistration | null = null;
  private socket: Socket | null = null;
  private protocol: ZcodeProtocol | null = null;
  private turnWaiters = new Map<string, (result: ProviderTurnResult) => void>();
  private desktopAliveCheck = false;

  constructor(private readonly cfg: Z2cConfig) {}

  // ── detection ─────────────────────────────────────────────────────────────
  private registrationPath(workspaceKey: string): string {
    const hash = createHash("sha1").update(workspaceKey.toLowerCase()).digest("hex").slice(0, 16);
    return join(this.cfg.stateDir, "desktop-agents", `agent-${hash}.json`);
  }

  findRegistration(workspaceKey: string): DesktopAgentRegistration | null {
    const path = this.registrationPath(workspaceKey);
    if (!existsSync(path)) return null;
    try {
      const reg = JSON.parse(readFileSync(path, "utf8")) as DesktopAgentRegistration;
      if (!reg.port || !reg.token || !reg.pid) return null;
      // Liveness: signal 0 throws if the pid is gone.
      try { process.kill(reg.pid, 0); } catch { return null; }
      return reg;
    } catch {
      return null;
    }
  }

  isDesktopAgentAvailable(workspaceKey: string): boolean {
    return this.findRegistration(workspaceKey) !== null;
  }

  /** Filesystem identity is canonicalized; Desktop's registry key is opaque
   * and case-sensitive. Reuse the Desktop-published spelling only after
   * proving that both requested fields identify that registered workspace.
   */
  private desktopWorkspace(workspace: ProviderWorkspaceRef): ProviderWorkspaceRef {
    const reg = this.findRegistration(workspace.workspaceKey);
    if (!reg || typeof reg.workspace !== "string" ||
        canonicalizeWorkspacePath(reg.workspace) !== canonicalizeWorkspacePath(workspace.workspaceKey) ||
        canonicalizeWorkspacePath(reg.workspace) !== canonicalizeWorkspacePath(workspace.workspacePath)) {
      throw new Error("Desktop registration does not match the authorized workspace");
    }
    return { workspaceKey: reg.workspace, workspacePath: reg.workspace };
  }

  // ── connection ────────────────────────────────────────────────────────────
  private splitterBuffer = "";

  private async connect(reg: DesktopAgentRegistration): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: reg.port }, () => {
        socket.write(reg.token + "\n");
        resolve();
      });
      socket.once("error", reject);
      this.socket = socket;
    });
    const emitter = new EventEmitter();
    const socket = this.socket!;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.splitterBuffer += chunk;
      let idx: number;
      while ((idx = this.splitterBuffer.indexOf("\n")) >= 0) {
        const line = this.splitterBuffer.slice(0, idx).trim();
        this.splitterBuffer = this.splitterBuffer.slice(idx + 1);
        if (!line) continue;
        try {
          emitter.emit("message", JSON.parse(line));
        } catch {
          emitter.emit("malformed", line.slice(0, 200));
        }
      }
    });
    socket.on("close", () => {
      emitter.emit("exit", null);
      this.socket = null;
      // Drop the cached protocol/registration so a later ensureConnected() can
      // re-attach to a freshly registered agent instead of writing into the
      // dead socket forever. A live registration always supersedes a dead one.
      this.protocol = null;
      this.registration = null;
      if (this.status === "healthy") {
        this.status = "unreachable";
        this.statusDetail = "desktop agent connection closed";
      }
      for (const [, waiter] of [...this.turnWaiters.entries()]) {
        waiter({ status: "failed", detail: "desktop agent connection closed mid-turn" });
      }
      this.turnWaiters.clear();
    });
    socket.on("error", () => { /* handled by close */ });

    this.protocol = new ZcodeProtocol({
      write: (msg: unknown) => {
        if (!socket.writable) throw new Error("desktop agent connection not writable");
        socket.write(JSON.stringify(msg) + "\n");
      },
      on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
    } as unknown as ZcodeProcess);
    this.protocol.on("notification", (rec: { method: string; params: unknown }) =>
      this.onNotification(rec.method, rec.params),
    );
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== "state.updated") return;
    const p = params as { scope?: string; sessionId?: string; reason?: string; patch?: { status?: string } };
    if (!p || p.scope !== "session" || !p.sessionId) return;
    const waiter = this.turnWaiters.get(p.sessionId);
    if (!waiter) return;
    if (p.reason === "prompt_completed" || p.patch?.status === "idle") {
      // The runtime reports idle as soon as an assistant message completes,
      // even while its tool calls are still executing. Resolving here reads a
      // transcript with no final text and abandons in-flight tools, so wait
      // (bounded by the send timeout) until the tool parts settle.
      void this.resolveTurnWhenSettled(p.sessionId, waiter);
    } else if (p.reason === "prompt_failed" || p.patch?.status === "error") {
      this.turnWaiters.delete(p.sessionId);
      waiter({ status: "failed", detail: `reason=${p.reason ?? "error"}` });
    }
  }

  /**
   * Poll the session transcript until the last assistant message has no
   * in-flight tool parts, then resolve the turn. Explicitly non-terminal
   * tool statuses ("running"/"pending"/"queued") keep the turn open; any
   * other/absent status counts as settled so unknown tool shapes can never
   * hang the turn past the send timeout.
   */
  private async resolveTurnWhenSettled(sessionId: string, waiter: (result: ProviderTurnResult) => void): Promise<void> {
    const deadline = Date.now() + this.cfg.sendTimeoutMs;
    let settledChecks = 0;
    while (Date.now() < deadline) {
      const running = await this.hasRunningToolParts(sessionId).catch(() => false);
      if (!running) {
        // Require two consecutive settled checks one second apart: the tool
        // part itself may not be persisted yet when the idle signal arrives.
        settledChecks += 1;
        if (settledChecks >= 2) {
          if (this.turnWaiters.get(sessionId) === waiter) this.turnWaiters.delete(sessionId);
          waiter({ status: "completed" });
          return;
        }
      } else {
        settledChecks = 0;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (this.turnWaiters.get(sessionId) === waiter) this.turnWaiters.delete(sessionId);
    waiter({ status: "failed", detail: "turn timeout" });
  }

  private async hasRunningToolParts(sessionId: string): Promise<boolean> {
    const proto = this.requireConnection();
    const res = (await proto.request("session/messages", { sessionId }, 20000)) as {
      messages?: Array<Record<string, unknown>>;
    };
    const messages = res.messages ?? [];
    const assistant = messages.filter((m) => (m.info as Record<string, unknown> | undefined)?.role === "assistant");
    const last = assistant[assistant.length - 1];
    if (!last) return false;
    const parts = (last.parts as Array<Record<string, unknown>> | undefined) ?? [];
    return parts.some((p) => {
      if (p.type !== "tool") return false;
      const status = (p.state as { status?: string } | undefined)?.status;
      return status === "running" || status === "pending" || status === "queued";
    });
  }

  private requireConnection(): ZcodeProtocol {
    if (!this.protocol) throw new Error("desktop agent not connected");
    return this.protocol;
  }

  // ── AgentProvider ─────────────────────────────────────────────────────────
  async start(): Promise<void> {
    // Health is per-workspace; startup performs a generic check over the first
    // registered workspace found (the engine resolves per-workspace lazily too).
    this.desktopAliveCheck = this.anyRegistrationExists();
    if (!this.desktopAliveCheck) {
      this.status = "unreachable";
      this.statusDetail =
        "no Desktop-spawned agent found. Launch ZCode Desktop with Z2C's desktop-agent-proxy " +
        "(ZCODE_AGENT_SERVER_COMMAND/ARGS_JSON) and open the target workspace once.";
      throw new Error(this.statusDetail);
    }
    this.status = "healthy";
    this.statusDetail = "desktop-spawned agent detected (auth stays Desktop-managed)";
  }

  private anyRegistrationExists(): boolean {
    const dir = join(this.cfg.stateDir, "desktop-agents");
    if (!existsSync(dir)) return false;
    try {
      for (const f of listRegistrationFiles(dir)) {
        try {
          const reg = JSON.parse(f.content) as DesktopAgentRegistration;
          try { process.kill(reg.pid, 0); } catch { continue; }
          return true;
        } catch { continue; }
      }
    } catch { return false; }
    return false;
  }

  async stop(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
    this.protocol = null;
    this.status = "stopped";
  }

  private async ensureConnected(workspace: ProviderWorkspaceRef): Promise<ZcodeProtocol> {
    const desktop = this.desktopWorkspace(workspace);
    if (this.protocol) {
      if (this.registration?.workspace !== desktop.workspaceKey) {
        throw new Error("Desktop connection belongs to another workspace");
      }
      return this.protocol;
    }
    const reg = this.findRegistration(workspace.workspaceKey);
    if (!reg) {
      this.status = "unreachable";
      this.statusDetail = `no Desktop-spawned agent for workspace ${workspace.workspaceKey}`;
      throw new Error(this.statusDetail);
    }
    this.registration = reg;
    await this.connect(reg);
    await this.probeCapabilities();
    this.status = "healthy";
    this.statusDetail = undefined;
    return this.protocol!;
  }

  private async probeCapabilities(): Promise<void> {
    const required: CapabilityProbeResult["required"] = {};
    const preferred: CapabilityProbeResult["preferred"] = {};
    for (const m of REQUIRED_METHODS) {
      required[m] = (await this.protocol!.methodExists(m, {}, 10000)) ? "present" : "missing";
    }
    preferred["session/resume"] = (await this.protocol!.methodExists("session/resume", {}, 10000))
      ? "present"
      : "missing";
    const ok = Object.values(required).every((v) => v === "present");
    this.capabilityResult = {
      ok,
      expectedVersion: "desktop-managed",
      detectedVersion: null,
      required,
      preferred,
      checkedAt: new Date().toISOString(),
    };
    if (!ok) {
      this.status = "incompatible";
      this.statusDetail = `capability probe failed: ${JSON.stringify(required)}`;
      throw new Error(this.statusDetail);
    }
  }

  async listSessions(workspace: ProviderWorkspaceRef): Promise<ProviderSessionSummary[]> {
    const proto = await this.ensureConnected(workspace);
    const res = (await proto.request("session/list", { workspace: this.desktopWorkspace(workspace) }, 20000)) as {
      sessions?: Array<Record<string, unknown>>;
    };
    return (res.sessions ?? []).map((s) => ({
      sessionId: String(s.sessionId),
      workspacePath: String((s.workspace as Record<string, unknown> | undefined)?.workspacePath ?? ""),
      status: String(s.status ?? "unknown"),
      title: typeof s.title === "string" ? s.title : undefined,
      updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : undefined,
    }));
  }

  async createSession(workspace: ProviderWorkspaceRef, options?: { readonly?: boolean }): Promise<string> {
    const proto = await this.ensureConnected(workspace);
    // Desktop-managed auth: no provider registry is pushed by Z2C. The Desktop
    // host owns the provider registry and mints all model credentials.
    // Governed session modes (this lane has no interactive approver, so an
    // unattended approval ask would stall the turn silently):
    //  - readonly submissions run in plan mode — the agent layer itself
    //    rejects mutating tools;
    //  - workspace-write sessions run in edit mode — file edits inside the
    //    authorized workspace are auto-approved, arbitrary commands still ask.
    const sessionParams = options?.readonly
      ? { workspace: this.desktopWorkspace(workspace), mode: "plan", persistence: "immediate" }
      : { workspace: this.desktopWorkspace(workspace), mode: "edit", persistence: "immediate" };
    const res = (await proto.request(
      "session/create",
      sessionParams,
      60000,
    )) as { session?: { sessionId?: string } };
    const sessionId = res.session?.sessionId;
    if (!sessionId || !sessionId.startsWith("sess_")) {
      throw new Error(`session/create returned no valid session id: ${JSON.stringify(res).slice(0, 200)}`);
    }
    return sessionId;
  }

  async resumeSession(workspace: ProviderWorkspaceRef, sessionId: string): Promise<void> {
    const proto = await this.ensureConnected(workspace);
    if (!/^sess_[0-9a-f-]{36}$/i.test(sessionId)) {
      throw new Error(`invalid ZCode session id format: ${sessionId.slice(0, 12)}…`);
    }
    await proto.request("session/resume", { sessionId, workspace: this.desktopWorkspace(workspace) }, 60000);
  }

  async send(options: ProviderSendOptions): Promise<ProviderRunHandle> {
    const proto = this.requireConnection();
    const completion = new Promise<ProviderTurnResult>((resolve) => {
      this.turnWaiters.set(options.sessionId, resolve);
      setTimeout(() => {
        if (this.turnWaiters.get(options.sessionId) === resolve) {
          this.turnWaiters.delete(options.sessionId);
          resolve({ status: "failed", detail: "turn timeout" });
        }
      }, options.timeoutMs);
    });
    try {
      await proto.request(
        "session/send",
        { sessionId: options.sessionId, content: options.instruction, inputId: options.inputId },
        this.cfg.sendTimeoutMs,
      );
    } catch (err) {
      this.turnWaiters.delete(options.sessionId);
      throw err;
    }
    return { sessionId: options.sessionId, completion };
  }

  async stopSession(sessionId: string): Promise<void> {
    const proto = this.requireConnection();
    await proto.request("session/stop", { sessionId }, 20000);
  }

  /** Count assistant messages currently persisted for the session. */
  async snapshotAssistantMarker(sessionId: string): Promise<number> {
    const proto = await this.ensureConnected(await this.markerWorkspace(sessionId));
    const res = (await proto.request("session/messages", { sessionId }, 20000)) as {
      messages?: Array<Record<string, unknown>>;
    };
    return ((res.messages ?? []).filter((m) => (m.info as Record<string, unknown> | undefined)?.role === "assistant")).length;
  }

  /**
   * Locate the authorized workspace for a session-scoped read. The session
   * belongs to the one workspace this provider is attached to; reuse its
   * registration so the read goes through the live connection.
   */
  private async markerWorkspace(sessionId: string): Promise<ProviderWorkspaceRef> {
    if (!this.registration) {
      throw new Error(`desktop agent not connected; cannot read session ${sessionId.slice(0, 12)}…`);
    }
    return { workspaceKey: this.registration.workspace, workspacePath: this.registration.workspace };
  }

  async readAssistantOutput(sessionId: string, maxChars: number, opts?: ReadAssistantOutputOptions): Promise<string> {
    const proto = this.requireConnection();
    // Persistence lags slightly behind turn completion, and a fresh session can
    // persist an empty bootstrap assistant message before the real reply, so
    // poll until an assistant message carries non-empty text or a model error
    // (model errors are recorded on the assistant message). Mirrors the fix in
    // ZcodeProvider.readAssistantOutput.
    //
    // Turn scoping: minAssistantCount is the assistant-message count observed
    // BEFORE the turn was sent. Messages at or below that index are prior
    // history — on a resumed session they must never satisfy the poll and never
    // contribute output text, otherwise the previous turn's reply is returned
    // instead of this turn's.
    const minAssistantCount = Math.max(0, opts?.minAssistantCount ?? 0);
    let messages: Array<Record<string, unknown>> = [];
    // Multi-step tool turns legitimately take minutes; the poll breaks as
    // soon as the final text lands, and the engine's send timeout is the
    // real ceiling. 300s absorbs tool execution plus persistence lag.
    for (let attempt = 0; attempt < 300; attempt++) {
      const res = (await proto.request("session/messages", { sessionId }, 20000)) as {
        messages?: Array<Record<string, unknown>>;
      };
      messages = res.messages ?? [];
      const assistant = messages.filter((m) => (m.info as Record<string, unknown> | undefined)?.role === "assistant");
      const fresh = assistant.slice(minAssistantCount);
      const settled =
        assistant.length >= minAssistantCount &&
        fresh.some((m) => {
          const info = m.info as Record<string, unknown> | undefined;
          if (info?.error != null) return true;
          return ((m.parts as Array<Record<string, unknown>> | undefined) ?? []).some(
            (p) => p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0,
          );
        });
      if (settled) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (messages.length === 0) {
      throw new Error("no persisted messages found for session after turn completion");
    }
    const assistant = messages.filter((m) => (m.info as Record<string, unknown> | undefined)?.role === "assistant");
    const fresh = assistant.slice(minAssistantCount);
    const texts: string[] = [];
    for (const m of fresh) {
      const info = m.info as Record<string, unknown> | undefined;
      const modelError = info?.error as { data?: { message?: string; code?: string } } | undefined;
      if (modelError) {
        throw new Error(
          `model error during turn: ${modelError.data?.code ?? "unknown"} ${modelError.data?.message ?? ""}`.trim(),
        );
      }
      for (const part of (m.parts as Array<Record<string, unknown>> | undefined) ?? []) {
        if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
      }
    }
    const joined = texts.join("\n").trim();
    if (!joined) throw new Error("turn completed but assistant produced no text output");
    return joined.length > maxChars ? joined.slice(0, maxChars) + "…[truncated]" : joined;
  }

  /** True when the provider never touches API-key based configuration. */
  get usesDesktopManagedAuth(): boolean {
    return true;
  }

  /**
   * The effective provider/model of the EXACT session, read through the
   * native exact-session read surface (session/read, whose installed strict
   * contract takes the sessionId alone). The returned snapshot's
   * session.model supplies the binding and session.workspace carries the
   * session's own workspace association; a missing model or a workspace that
   * does not match the authorized workspace reports null (unknown).
   * Registration and list summaries are never used as binding evidence.
   */
  /**
   * Switch the model and/or thought level (reasoning depth) of an EXISTING
   * native session via session/setModel + session/setThoughtLevel — the same
   * sessionId is preserved and the workspace binding must survive the switch.
   * The resulting binding is re-observed with session/read; a switch that is
   * not confirmed on re-read fails closed. Model switches stay WITHIN the
   * session's current provider (never a provider substitution).
   */
  async updateSessionModel(
    workspace: ProviderWorkspaceRef,
    sessionId: string,
    change: SameSessionModelUpdate,
  ): Promise<SameSessionModelUpdateResult> {
    if (!change.modelId && !change.thoughtLevel) {
      throw new Error("updateSessionModel requires modelId or thoughtLevel");
    }
    if (!/^sess_[0-9a-f-]{36}$/i.test(sessionId)) {
      throw new Error("invalid ZCode session id format");
    }
    const desktop = this.desktopWorkspace(workspace);
    const proto = await this.ensureConnected(workspace);
    if (change.modelId) {
      const before = (await proto.request("session/read", { sessionId }, 20000)) as {
        session?: { model?: { providerId?: unknown } };
      };
      const providerId = typeof before.session?.model?.providerId === "string" ? before.session.model.providerId : null;
      if (!providerId) throw new Error("current session provider is unobserved; refusing model switch");
      await proto.request(
        "session/setModel",
        { sessionId, model: { providerId, modelId: change.modelId } },
        30000,
      );
    }
    if (change.thoughtLevel) {
      await proto.request(
        "session/setThoughtLevel",
        { sessionId, thoughtLevel: change.thoughtLevel },
        30000,
      );
    }
    const snap = (await proto.request("session/read", { sessionId }, 20000)) as {
      session?: Record<string, unknown>;
    };
    const s = snap.session;
    if (!s || s.sessionId !== sessionId) throw new Error("session vanished during model update");
    const ws = s.workspace as { workspaceKey?: unknown; workspacePath?: unknown } | undefined;
    if (ws?.workspaceKey !== desktop.workspaceKey || ws?.workspacePath !== desktop.workspacePath) {
      throw new Error("session workspace changed during model update");
    }
    const model = s.model as { providerId?: unknown; modelId?: unknown } | undefined;
    if (change.modelId && (!model || typeof model.modelId !== "string" || model.modelId !== change.modelId)) {
      throw new Error(`model switch was not observed on the session (requested ${change.modelId})`);
    }
    return {
      provider_id: String(model?.providerId ?? ""),
      model_id: String(model?.modelId ?? ""),
      thoughtLevel: typeof s.thoughtLevel === "string" ? s.thoughtLevel : null,
    };
  }

  async readSessionBinding(sessionId: string, workspace: ProviderWorkspaceRef): Promise<ProviderBinding | null> {
    let desktop: ProviderWorkspaceRef;
    try { desktop = this.desktopWorkspace(workspace); } catch { return null; }
    const proto = await this.ensureConnected(workspace);
    const snap = (await proto.request("session/read", { sessionId }, 20000)) as {
      session?: Record<string, unknown>;
    };
    const session = snap.session;
    if (!session || session.sessionId !== sessionId) return null;
    const model = session.model as Record<string, unknown> | undefined;
    if (!model || typeof model.providerId !== "string" || typeof model.modelId !== "string") return null;
    const ws = session.workspace as Record<string, unknown> | undefined;
    if (!ws || ws.workspaceKey !== desktop.workspaceKey || ws.workspacePath !== desktop.workspacePath) return null;
    return { provider_id: model.providerId, model_id: model.modelId, source: "desktop-session-read" };
  }
}

function listRegistrationFiles(dir: string): Array<{ content: string }> {
  const out: Array<{ content: string }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("agent-") || !name.endsWith(".json")) continue;
    const p = join(dir, name);
    try {
      if (!statSync(p).isFile()) continue;
      out.push({ content: readFileSync(p, "utf8") });
    } catch { continue; }
  }
  return out;
}

export { ZcodeProtocolError };
