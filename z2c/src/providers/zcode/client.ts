import type { Z2cConfig } from "../../config.js";
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
import { execFileSync } from "node:child_process";
import { readZcodeRuntimeToken } from "../../config.js";
import { ZcodeProcess } from "./process.js";
import { ZcodeProtocol, ZcodeProtocolError } from "./protocol.js";

const REQUIRED_METHODS = ["session/create", "session/send", "session/list", "session/stop"] as const;
const PREFERRED_METHODS = [
  "session/resume",
  "session/messages",
  "workspace/updateProviderRegistry",
] as const;

interface StateUpdatedParams {
  type?: string;
  scope?: string;
  sessionId?: string;
  patch?: { status?: string };
  reason?: string;
}

/**
 * Bridge-owned adapter around `zcode app-server`.
 * The child process is local-only (stdio); nothing here is exposed over HTTP.
 */
export class ZcodeProvider implements AgentProvider {
  readonly name = "zcode";
  status: AgentProvider["status"] = "stopped";
  statusDetail?: string;
  providerVersion: string | null = null;
  capabilityResult: CapabilityProbeResult | null = null;
  readonly usesDesktopManagedAuth = false;

  private proc: ZcodeProcess;
  private protocol: ZcodeProtocol;
  private registryPushedWorkspaces = new Set<string>();
  private registryRevision = 1;
  private turnWaiters = new Map<
    string,
    (result: ProviderTurnResult) => void
  >();

  constructor(private readonly cfg: Z2cConfig) {
    // The model credential is passed only through the child's environment:
    // never in protocol messages, logs, or network traffic.
    const envToken = cfg.modelApiKey ?? readZcodeRuntimeToken(cfg);
    this.proc = new ZcodeProcess(process.execPath, cfg.zcodeCliPath, {
      [cfg.runtimeApiKeyEnv]: envToken,
    });
    this.protocol = new ZcodeProtocol(this.proc);
    this.protocol.on("notification", (rec: { method: string; params: unknown }) =>
      this.onNotification(rec.method, rec.params),
    );
    this.protocol.on("malformed", (line: string) => {
      this.statusDetail = `malformed protocol message observed (${line.slice(0, 80)})`;
    });
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== "state.updated") return;
    const p = params as StateUpdatedParams | undefined;
    if (!p || p.scope !== "session" || !p.sessionId) return;
    const waiter = this.turnWaiters.get(p.sessionId);
    if (!waiter) return;
    if (p.reason === "prompt_completed" || p.patch?.status === "idle") {
      this.turnWaiters.delete(p.sessionId);
      waiter({ status: "completed" });
    } else if (p.reason === "prompt_failed" || p.patch?.status === "error") {
      this.turnWaiters.delete(p.sessionId);
      waiter({ status: "failed", detail: `reason=${p.reason ?? "error"}` });
    }
  }

  detectVersion(): string | null {
    try {
      const out = execFileSync(process.execPath, [this.cfg.zcodeCliPath, "--version"], {
        timeout: 15000,
        encoding: "utf8",
      });
      const m = out.match(/(\d+\.\d+\.\d+)/);
      return m ? m[1]! : null;
    } catch {
      return null;
    }
  }

  async start(): Promise<void> {
    this.providerVersion = this.detectVersion();
    if (!this.providerVersion) {
      this.status = "unreachable";
      this.statusDetail = `cannot execute ZCode CLI at ${this.cfg.zcodeCliPath}`;
      throw new Error(this.statusDetail);
    }
    if (!this.providerVersion.startsWith(this.cfg.expectedZcodeVersionPrefix)) {
      this.status = "incompatible";
      this.statusDetail = `expected ZCode ${this.cfg.expectedZcodeVersionPrefix}x, detected ${this.providerVersion}`;
      throw new Error(this.statusDetail);
    }

    this.proc.start();
    this.proc.on("exit", () => {
      if (this.status === "healthy") {
        this.status = "unreachable";
        this.statusDetail = "app-server process exited unexpectedly";
      }
      for (const [sessionId, waiter] of [...this.turnWaiters.entries()]) {
        waiter({ status: "failed", detail: `app-server exited during session ${sessionId}` });
      }
    });

    // Wait briefly for a live protocol by probing a read-only method.
    const deadline = Date.now() + 20000;
    let live = false;
    while (Date.now() < deadline) {
      try {
        await this.protocol.request("session/list", {}, 5000);
        live = true;
        break;
      } catch (err) {
        if (err instanceof ZcodeProtocolError) {
          live = true; // server responded (params validation etc.)
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!live) {
      this.status = "unreachable";
      this.statusDetail = "app-server did not answer protocol requests";
      throw new Error(this.statusDetail);
    }

    this.capabilityResult = await this.probeCapabilities();
    if (!this.capabilityResult.ok) {
      this.status = "incompatible";
      this.statusDetail = `capability probe failed: ${JSON.stringify(this.capabilityResult.required)}`;
      throw new Error(this.statusDetail);
    }
    this.status = "healthy";
    this.statusDetail = undefined;
  }

  private async probeCapabilities(): Promise<CapabilityProbeResult> {
    const required: CapabilityProbeResult["required"] = {};
    const preferred: CapabilityProbeResult["preferred"] = {};
    // Empty params yield -32602 (invalid params) for a present method and
    // -32601 (method not found) for a missing one — no session is created.
    for (const m of REQUIRED_METHODS) {
      required[m] = (await this.protocol.methodExists(m, {}, 10000))
        ? "present"
        : "missing";
    }
    for (const m of PREFERRED_METHODS) {
      preferred[m] = (await this.protocol.methodExists(m, {}, 10000))
        ? "present"
        : "missing";
    }
    const ok = Object.values(required).every((v) => v === "present");
    return {
      ok,
      expectedVersion: this.cfg.expectedZcodeVersionPrefix + "x",
      detectedVersion: this.providerVersion,
      required,
      preferred,
      checkedAt: new Date().toISOString(),
    };
  }

  async stop(): Promise<void> {
    this.proc.kill();
    this.status = "stopped";
    this.registryPushedWorkspaces.clear();
  }

  private ensureProcess(): void {
    if (!this.proc.running) {
      this.proc.start();
      this.registryPushedWorkspaces.clear();
    }
  }

  private async ensureWorkspaceReady(workspace: ProviderWorkspaceRef): Promise<void> {
    this.ensureProcess();
    if (this.registryPushedWorkspaces.has(workspace.workspaceKey)) return;
    // Auth strategy:
    //  - Preferred (fully headless): a user-owned API key passed via Z2C's own env
    //    (Z2C_MODEL_API_KEY) and referenced by the provider entry as {source:"env"};
    //    the token exists only in the child process environment.
    //  - Fallback: the ZCode start-plan provider. Plan OAuth tokens are minted and
    //    refreshed by the ZCode Desktop host and cannot be relayed by third parties,
    //    so plan-backed turns only work while the Desktop can vouch for the session.
    const providers: Array<Record<string, unknown>> = [];
    if (this.cfg.modelApiKey) {
      providers.push({
        providerId: "custom:z2c",
        kind: "anthropic",
        apiFormat: "anthropic-messages",
        label: "Z2C direct",
        source: "custom",
        baseURL: this.cfg.modelBaseUrl,
        apiKey: { source: "env", name: this.cfg.runtimeApiKeyEnv },
        models: [{ modelId: this.cfg.modelId, label: this.cfg.modelId }],
      });
    } else {
      // UNSUPPORTED FOR GOVERNED EXECUTION: this headless plan route cannot
      // produce Desktop-managed binding evidence (source !==
      // "desktop-session-read"), so TaskEngine admission fails closed for it.
      // The advertised identity is intentionally NOT updated to the current
      // required identity — advertising it would pretend a path works that
      // cannot be attested. Only the explicit API-key path above is a
      // supported headless configuration, and only for non-governed use.
      providers.push({
        providerId: "builtin:zai-start-plan",
        kind: "anthropic",
        apiFormat: "anthropic-messages",
        label: "Z.AI",
        source: "builtin",
        baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
        apiKey: { source: "env", name: this.cfg.runtimeApiKeyEnv },
        models: [{ modelId: "GLM-5.3-Flash", label: "GLM-5.3-Flash" }],
      });
    }
    await this.protocol.request(
      "workspace/updateProviderRegistry",
      {
        workspace,
        registry: {
          revision: String(this.registryRevision++),
          generatedAt: Date.now(),
          providers,
        },
        includeWorkspaceState: true,
      },
      20000,
    );
    this.registryPushedWorkspaces.add(workspace.workspaceKey);
  }

  async listSessions(workspace: ProviderWorkspaceRef): Promise<ProviderSessionSummary[]> {
    await this.ensureWorkspaceReady(workspace);
    const res = (await this.protocol.request("session/list", { workspace }, 20000)) as {
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

  async createSession(workspace: ProviderWorkspaceRef, _options?: { readonly?: boolean }): Promise<string> {
    await this.ensureWorkspaceReady(workspace);
    const model = this.cfg.modelApiKey
      ? { model: { providerId: "custom:z2c", modelId: this.cfg.modelId } }
      : {};
    const res = (await this.protocol.request(
      "session/create",
      { workspace, mode: "build", persistence: "immediate", ...model },
      60000,
    )) as { session?: { sessionId?: string } };
    const sessionId = res.session?.sessionId;
    if (!sessionId || !sessionId.startsWith("sess_")) {
      throw new Error(`session/create returned no valid session id: ${JSON.stringify(res).slice(0, 200)}`);
    }
    return sessionId;
  }

  async resumeSession(workspace: ProviderWorkspaceRef, sessionId: string): Promise<void> {
    await this.ensureWorkspaceReady(workspace);
    if (!/^sess_[0-9a-f-]{36}$/i.test(sessionId)) {
      throw new Error(`invalid ZCode session id format: ${sessionId.slice(0, 12)}…`);
    }
    await this.protocol.request("session/resume", { sessionId, workspace }, 60000);
  }

  async send(options: ProviderSendOptions): Promise<ProviderRunHandle> {
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
      await this.protocol.request(
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
    await this.protocol.request("session/stop", { sessionId }, 20000);
  }

  /** Count assistant messages currently persisted for the session. */
  async snapshotAssistantMarker(sessionId: string): Promise<number> {
    this.ensureProcess();
    const res = (await this.protocol.request("session/messages", { sessionId }, 20000)) as {
      messages?: Array<Record<string, unknown>>;
    };
    return ((res.messages ?? []).filter((m) => (m.info as Record<string, unknown> | undefined)?.role === "assistant")).length;
  }

  async readAssistantOutput(sessionId: string, maxChars: number, opts?: ReadAssistantOutputOptions): Promise<string> {
    // Persistence lags slightly behind turn completion, and a fresh session can
    // persist an empty bootstrap assistant message before the real reply, so
    // poll until an assistant message carries non-empty text or a model error
    // (model errors are recorded on the assistant message).
    //
    // Turn scoping: minAssistantCount is the assistant-message count observed
    // BEFORE the turn was sent. Prior history never satisfies the poll and
    // never contributes output text (resumed sessions).
    const minAssistantCount = Math.max(0, opts?.minAssistantCount ?? 0);
    let messages: Array<Record<string, unknown>> = [];
    for (let attempt = 0; attempt < 15; attempt++) {
      const res = (await this.protocol.request("session/messages", { sessionId }, 20000)) as {
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
      // prompt_completed is NOT proof of success — check model-level errors.
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

  get malformedMessageCount(): number {
    return this.proc.malformedMessageCount;
  }

  /**
   * Effective provider/model of the EXACT session via the native
   * exact-session read surface (session/read, whose installed strict
   * contract takes the sessionId alone). Missing model fields or a session
   * workspace that does not match the authorized workspace reports null.
   */
  async readSessionBinding(sessionId: string, workspace: ProviderWorkspaceRef): Promise<ProviderBinding | null> {
    const snap = (await this.protocol.request("session/read", { sessionId }, 20000)) as {
      session?: Record<string, unknown>;
    };
    const session = snap.session;
    if (!session) return null;
    const model = session.model as Record<string, unknown> | undefined;
    if (!model || typeof model.providerId !== "string" || typeof model.modelId !== "string") return null;
    const ws = session.workspace as Record<string, unknown> | undefined;
    if (!ws || ws.workspaceKey !== workspace.workspaceKey) return null;
    return { provider_id: model.providerId, model_id: model.modelId, source: "session-read" };
  }
}
