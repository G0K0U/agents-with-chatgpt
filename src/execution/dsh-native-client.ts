import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Authenticated loopback transport into the installed DSH session-controller plugin. */
export class DshNativeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "DshNativeError";
  }
}

export interface DshNativeIdentity {
  adapter: string;
  version: string;
  generation: string;
  hostPid: number;
  dshVersion: string;
  harnessVersion: string;
  capabilities: Record<string, unknown>;
  selectionLease?: { sequence: number; phase: string; model: string; runtimeGeneration: string } | null;
}

export interface DshNativeModel {
  id: string;
  name: string;
  reasoning?: { efforts?: Array<{ id: string; name?: string }> } | null;
  backend?: "ninfer" | "kvmem";
  slot?: "a" | "b";
  mode?: "text" | "vision";
  preset?: "fast" | "long";
  profile?: string;
  contextWindow?: number;
  inputModalities?: string[];
  multimodalEvidence?: string | null;
}

export interface DshNativeCatalog {
  generation: string;
  default: { provider: string; model: string; reasoningEffort?: string };
  groups: Array<{ id: string; name: string; models: DshNativeModel[] }>;
}

export interface DshNativeMessage {
  seq: number;
  at: string;
  role: "user" | "assistant";
  text: string;
  requestId: string | null;
  model: string | null;
  provider: string | null;
}

export interface DshNativeSession {
  generation: string;
  sessionId: string;
  cwd: string;
  origin: string | null;
  createdAt: string;
  running: boolean;
  status: string;
  lastSeq: number;
  selection: { provider: string | null; model: string | null; reasoningEffort: string | null };
  messages: DshNativeMessage[];
}

export interface DshNativeSummary {
  sessionId: string;
  cwd: string;
  origin: string | null;
  updatedAt: string;
  running: boolean;
  blank: boolean;
}

export interface DshNativeTask {
  generation: string;
  sessionId: string;
  requestId: string;
  found: boolean;
  running: boolean;
  activeRequestId?: string | null;
  userSeq?: number;
  userAt?: string;
  promptSha256?: string;
  writerConflict?: boolean;
  served?: { provider: string | null; model: string | null; reasoningEffort: string | null } | null;
  terminal?: { seq: number; at: string; reason: string } | null;
  final?: { seq: number; at: string; text: string; model: string | null; provider: string | null } | null;
  toolCalls?: number;
  toolResults?: number;
  events?: DshNativeMessage[];
}

export interface DshNativeClientOptions {
  endpoint?: string;
  tokenFile?: string;
  fetchImpl?: typeof fetch;
  readToken?: () => string;
}

const DEFAULT_TOKEN_FILE = join(process.env.DSH_HOME || join(homedir(), ".dsh-beta"), "d2c-adapter.token");

export class DshNativeClient {
  readonly endpoint: string;
  private readonly tokenFile: string;
  private readonly fetchImpl: typeof fetch;
  private readonly readToken: () => string;

  constructor(options: DshNativeClientOptions = {}) {
    const endpoint = options.endpoint ?? process.env.D2C_ENDPOINT ?? "http://127.0.0.1:43190/rpc";
    const url = new URL(endpoint);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/rpc"
      || url.username || url.password || url.search || url.hash) {
      throw new DshNativeError("D2C_TRANSPORT_INVALID", "DSH adapter must use the local loopback RPC endpoint");
    }
    this.endpoint = url.toString();
    this.tokenFile = options.tokenFile ?? process.env.D2C_TOKEN_FILE ?? DEFAULT_TOKEN_FILE;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.readToken = options.readToken ?? (() => readFileSync(this.tokenFile, "utf8").trim());
  }

  private async rpc<T>(body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    let token: string;
    try { token = this.readToken(); }
    catch {
      throw new DshNativeError("D2C_UNAVAILABLE",
        "DSH adapter credential is unavailable: the local DSH host (DeepSeek Harness with the d2c session-controller adapter) has not provisioned it; start that host once, then retry");
    }
    if (!/^[0-9a-f]{64}$/.test(token)) {
      throw new DshNativeError("D2C_UNAVAILABLE",
        "DSH adapter credential is invalid: re-provision it from the local DSH host");
    }
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new DshNativeError("D2C_UNAVAILABLE",
        "DSH native adapter is unreachable on its loopback RPC endpoint: the external DSH host is not running (A2C cannot start it; start the DSH host and retry)");
    }
    let result: { ok?: boolean; data?: T; error?: { code?: string; message?: string } };
    try { result = await response.json() as typeof result; }
    catch { throw new DshNativeError("D2C_PROTOCOL_ERROR", "DSH adapter returned invalid JSON"); }
    if (!response.ok || result.ok !== true || result.data === undefined) {
      throw new DshNativeError(result.error?.code ?? "D2C_NATIVE_ERROR",
        (result.error?.message ?? "DSH native operation failed").slice(0, 200));
    }
    return result.data;
  }

  async health(): Promise<DshNativeIdentity> {
    const value = await this.rpc<DshNativeIdentity>({ op: "health" });
    if (value.adapter !== "dsh-a2c-native-session-adapter" || !value.generation
      || value.dshVersion !== "2.0.13-beta.1" || value.harnessVersion !== "0.1.6-alpha.2") {
      throw new DshNativeError("D2C_IDENTITY_MISMATCH", "Unexpected DSH native runtime identity");
    }
    return value;
  }

  async modelCatalog(): Promise<DshNativeCatalog> {
    return this.rpc({ op: "models" });
  }

  async list(workspaceRoot: string): Promise<{ generation: string; items: DshNativeSummary[] }> {
    return this.rpc({ op: "list", workspaceRoot: realpathSync.native(workspaceRoot) });
  }

  async read(workspaceRoot: string, sessionId: string, limit = 50): Promise<DshNativeSession> {
    return this.rpc({ op: "read", workspaceRoot: realpathSync.native(workspaceRoot), sessionId, limit });
  }

  async task(workspaceRoot: string, sessionId: string, requestId: string): Promise<DshNativeTask> {
    return this.rpc({ op: "task", workspaceRoot: realpathSync.native(workspaceRoot), sessionId, requestId });
  }

  async create(workspaceRoot: string, sessionId: string, requestId: string): Promise<{ generation: string; sessionId: string; cwd: string; createdAt: string }> {
    const generation = (await this.health()).generation;
    return this.rpc({ op: "create", workspaceRoot: realpathSync.native(workspaceRoot), sessionId, requestId, generation });
  }

  async send(workspaceRoot: string, sessionId: string, requestId: string, text: string, expectedGeneration?: string): Promise<{ generation: string; sessionId: string; requestId: string; accepted: boolean; duplicate: boolean }> {
    const generation = expectedGeneration ?? (await this.health()).generation;
    return this.rpc({ op: "send", workspaceRoot: realpathSync.native(workspaceRoot), sessionId, requestId, text, generation });
  }

  async execute(workspaceRoot: string, sessionId: string, requestId: string, text: string,
    model: string, effort: "low" | "medium" | "high", expectedGeneration?: string): Promise<{
      generation: string; sessionId: string; requestId: string; accepted: boolean; duplicate: boolean;
      sequence: number; model: string; effort: string; resolvedEffort?: string | null;
      profile?: string; backend?: string; contextWindow?: number; phase?: string;
    }> {
    const generation = expectedGeneration ?? (await this.health()).generation;
    return this.rpc({ op: "execute", workspaceRoot: realpathSync.native(workspaceRoot), sessionId,
      requestId, text, model, effort, generation }, 480_000);
  }

  async cancel(workspaceRoot: string, sessionId: string, requestId: string, expectedGeneration?: string): Promise<{ generation: string; sessionId: string; requestId: string; cancelled: boolean }> {
    const generation = expectedGeneration ?? (await this.health()).generation;
    return this.rpc({ op: "cancel", workspaceRoot: realpathSync.native(workspaceRoot), sessionId, requestId, generation });
  }
}
