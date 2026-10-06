import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ZcodeModelCatalogToolResult } from "./model-catalog.js";

/**
 * A2C → Z2C semantic session forwarding client.
 *
 * Forwards the public semantic surface (zcode_runtime_capabilities,
 * zcode_workspace_list, zcode_session_*) to the Z2C local service — the
 * completed Phase-3 implementation running loopback-only in the Z2C companion
 * tree (server name "z2c-service"). A2C adds ONLY principal workspace
 * authorization and session-ownership enforcement before forwarding; the Z2C
 * service remains the sole session engine (no reimplementation, no second
 * public MCP server — this endpoint is loopback and machine-local).
 *
 * Mirrors ZcodeNativeClient's transport discipline: loopback-only URL, bearer
 * token scrubbed from every payload, MCP handshake identity check, one
 * re-handshake retry for service restarts, upstream tool errors never retried.
 */

export const ZCODE_SESSION_EXPECTED_SERVICE = "z2c-service";
export const ZCODE_SESSION_PROTOCOL = "1";

export class ZcodeSessionError extends Error {
  constructor(
    public readonly code:
      | "ZCODE_SESSION_CONFIG"
      | "ZCODE_SESSION_UNCONFIGURED"
      | "ZCODE_SESSION_UNAVAILABLE"
      | "ZCODE_SESSION_UNAUTHORIZED"
      | "ZCODE_SESSION_TIMEOUT"
      | "ZCODE_SESSION_SERVICE_MISMATCH"
      | "ZCODE_SESSION_WORKSPACE_FORBIDDEN"
      | "ZCODE_SESSION_UPSTREAM"
      | "ZCODE_SESSION_OUTCOME_UNKNOWN",
    message: string,
    public readonly upstreamCode?: string,
    public readonly failureLayer?: string,
    public readonly nativeSessionState?: "NOT_PERSISTED" | "INACTIVE",
  ) {
    super(message);
    this.name = "ZcodeSessionError";
  }
}

export interface ZcodeSessionConfig {
  url: string;
  apiBase: string;
  token: string;
  requestTimeoutMs: number;
}

function assertLoopbackHttpUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ZcodeSessionError("ZCODE_SESSION_CONFIG", `invalid Z2C endpoint URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
    throw new ZcodeSessionError("ZCODE_SESSION_CONFIG", "Z2C endpoint must be a loopback http:// URL (no 0.0.0.0, no remote hosts)");
  }
  return parsed;
}

function readServiceSecret(path: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new ZcodeSessionError(
      "ZCODE_SESSION_UNCONFIGURED",
      `Z2C service secret not found at ${path} (start the Z2C service once to generate it, or set ZCODE_SESSION_TOKEN)`,
    );
  }
  try {
    const parsed = JSON.parse(raw) as { secrets?: Array<{ secret?: unknown; retiredAt?: unknown }> };
    const active = (parsed.secrets ?? []).find((s) => typeof s.secret === "string" && s.retiredAt === undefined);
    if (!active || (active.secret as string).length < 16) throw new Error("no active secret");
    return active.secret as string;
  } catch (err) {
    if (err instanceof ZcodeSessionError) throw err;
    throw new ZcodeSessionError("ZCODE_SESSION_CONFIG", `unrecognized Z2C security file shape at ${path}`);
  }
}

export function loadZcodeSessionConfig(env: NodeJS.ProcessEnv = process.env): ZcodeSessionConfig {
  const url = assertLoopbackHttpUrl(env.ZCODE_SESSION_URL ?? "http://127.0.0.1:8766/mcp").toString();
  const apiBase = new URL(url).origin;
  const token = env.ZCODE_SESSION_TOKEN
    ? env.ZCODE_SESSION_TOKEN
    : readServiceSecret(
        env.ZCODE_SESSION_SECURITY_FILE ??
          join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "z2c", "security.json"),
      );
  const timeoutRaw = env.ZCODE_SESSION_TIMEOUT_MS ? Number(env.ZCODE_SESSION_TIMEOUT_MS) : 20000;
  if (!Number.isInteger(timeoutRaw) || timeoutRaw < 1000 || timeoutRaw > 120000) {
    throw new ZcodeSessionError("ZCODE_SESSION_CONFIG", "ZCODE_SESSION_TIMEOUT_MS must be 1000..120000");
  }
  return { url, apiBase, token, requestTimeoutMs: timeoutRaw };
}

export interface ZcodeSessionState {
  session_id: string;
  workspace_id: string;
  provider_id: string | null;
  model_id: string | null;
  thought_level: string | null;
  collaboration_mode: string | null;
  plan_enabled: boolean | null;
  runtime_version: string | null;
  binding_source: string;
}

export interface ZcodeWorkspaceGrant {
  workspace_id: string;
  display_name?: string;
  permissions?: { read?: boolean; write?: boolean };
  canonical_path?: string;
  granted_at?: string;
}

interface McpToolResult {
  content?: Array<{ type?: unknown; text?: unknown }>;
  isError?: boolean;
}

export const READ_ONLY_TOOLS = new Set<string>([
  "zcode_runtime_capabilities",
  "runtime_capabilities",
  "capabilities",
  "zcode_workspace_list",
  "workspace_list",
  "zcode_session_list",
  "session_list",
  "zcode_session_read",
  "session_read",
  "read",
  "zcode_session_discover",
  "session_discover",
  "discover",
  "zcode_session_observe",
  "session_observe",
  "observe",
  "zcode_session_observe_messages",
  "session_observe_messages",
  "observe_messages",
  "zcode_session_events",
  "zcode_session_messages",
  "provider_status",
  "get_zcode_task",
  "execution_output",
]);

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name);
}

export class ZcodeSessionClient {
  private session: Client | null = null;
  private sessionGeneration = 0;
  private handshakePromise: Promise<Client> | null = null;

  constructor(private readonly config: ZcodeSessionConfig) {
    assertLoopbackHttpUrl(config.url);
    if (typeof config.token !== "string" || config.token.length < 8) {
      throw new ZcodeSessionError("ZCODE_SESSION_UNCONFIGURED", "Z2C service token missing or too short");
    }
  }

  get activeSession(): Client | null {
    return this.session;
  }

  get activeGeneration(): number {
    return this.sessionGeneration;
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number, beforeDispatch?: () => void): Promise<unknown> {
    const isReadOnly = isReadOnlyTool(name);
    try {
      return await this.callToolAttempt(name, args, timeoutMs, beforeDispatch);
    } catch (err) {
      // A local dispatch guard can reject after the handshake. Preserve its
      // exact pause/ownership error and never turn it into a transport retry.
      if (!(err instanceof ZcodeSessionError)) throw err;
      const mapped = err;
      if (isReadOnly && mapped.code === "ZCODE_SESSION_UNAVAILABLE") {
        // Transport-disconnected read retry once only; auth/ownership/upstream error never retried.
        return await this.callToolAttempt(name, args, timeoutMs, beforeDispatch);
      }
      throw mapped;
    }
  }

  private async callToolAttempt(name: string, args: Record<string, unknown>, timeoutMs?: number, beforeDispatch?: () => void): Promise<unknown> {
    const isReadOnly = isReadOnlyTool(name);
    const client = await this.ensureSession();
    beforeDispatch?.();
    let result: unknown;
    let dispatched = false;
    try {
      dispatched = true;
      result = (await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: timeoutMs ?? this.config.requestTimeoutMs },
      )) as McpToolResult;
    } catch (err) {
      this.resetSession(client);
      const mapped = err instanceof ZcodeSessionError ? err : this.mapTransportError(err);
      if (!isReadOnly && dispatched && (mapped.code === "ZCODE_SESSION_UNAVAILABLE" || mapped.code === "ZCODE_SESSION_TIMEOUT")) {
        throw new ZcodeSessionError(
          "ZCODE_SESSION_OUTCOME_UNKNOWN",
          `Mutation dispatch outcome unknown for '${name}' due to transport error: ${this.scrub(mapped.message)}. Observe session state before retrying.`,
        );
      }
      throw mapped;
    }
    const typed = result as McpToolResult;
    const text = (typed.content ?? []).map((part) => (typeof part.text === "string" ? part.text : "")).join("\n");
    if (typed.isError) {
      const cleaned = this.scrub(text);
      try {
        const cause = JSON.parse(cleaned) as { error_code?: unknown; safe_message?: unknown; failure_layer?: unknown; native_session_state?: unknown };
        if (typeof cause.error_code === "string" && /^[A-Z_]{3,64}$/.test(cause.error_code)) {
          throw new ZcodeSessionError("ZCODE_SESSION_UPSTREAM", typeof cause.safe_message === "string" ? cause.safe_message : "Z2C rejected the operation", cause.error_code, typeof cause.failure_layer === "string" ? cause.failure_layer : undefined,
            cause.native_session_state === "NOT_PERSISTED" || cause.native_session_state === "INACTIVE" ? cause.native_session_state : undefined);
        }
      } catch (error) { if (error instanceof ZcodeSessionError) throw error; }
      const sep = cleaned.indexOf(": ");
      const looksCoded = sep > 0 && /^[A-Z][A-Z0-9_]+$/.test(cleaned.slice(0, sep));
      throw new ZcodeSessionError(
        "ZCODE_SESSION_UPSTREAM",
        looksCoded ? cleaned.slice(sep + 2) : cleaned || "Z2C tool error",
        looksCoded ? cleaned.slice(0, sep) : undefined,
      );
    }
    const scrubbed = this.scrub(text);
    try {
      return JSON.parse(scrubbed) as unknown;
    } catch {
      return { text: scrubbed };
    }
  }

  private async ensureSession(): Promise<Client> {
    if (this.session) return this.session;
    if (this.handshakePromise) {
      return await this.handshakePromise;
    }

    const generation = ++this.sessionGeneration;
    const currentHandshake = (async (): Promise<Client> => {
      const client = new Client({ name: "a2c-zcode-session", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
        requestInit: {
          headers: { Authorization: `Bearer ${this.config.token}` },
          redirect: "manual",
        },
      });

      const handshakeTimeoutMs = Math.min(this.config.requestTimeoutMs, 15_000);
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new ZcodeSessionError(
              "ZCODE_SESSION_TIMEOUT",
              `Z2C handshake timed out after ${handshakeTimeoutMs}ms`,
            ),
          );
        }, handshakeTimeoutMs);
      });

      try {
        await Promise.race([client.connect(transport), timeoutPromise]);
        const version = client.getServerVersion();
        if (!version || version.name !== ZCODE_SESSION_EXPECTED_SERVICE) {
          throw new ZcodeSessionError(
            "ZCODE_SESSION_SERVICE_MISMATCH",
            `expected ${ZCODE_SESSION_EXPECTED_SERVICE} MCP handshake, got ${version?.name ?? "unknown"}`,
          );
        }

        // Check generation fence: if generation changed during connect, this client is unassigned
        if (version.version !== ZCODE_SESSION_PROTOCOL) {
          throw Object.assign(new ZcodeSessionError("ZCODE_SESSION_SERVICE_MISMATCH", "Z2C protocol version mismatch"), { observedVersion: version.version });
        }

        // Check generation fence: if generation changed during connect, this client is unassigned
        if (generation !== this.sessionGeneration) {
          void client.close().catch(() => {});
          throw new ZcodeSessionError(
            "ZCODE_SESSION_UNAVAILABLE",
            "Handshake abandoned: session generation superseded",
          );
        }

        this.session = client;
        return client;
      } catch (err) {
        // Failed or timed-out or superseded client must be closed
        void client.close().catch(() => {});
        if (generation === this.sessionGeneration) {
          this.session = null;
        }
        throw err instanceof ZcodeSessionError ? err : this.mapTransportError(err);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();

    this.handshakePromise = currentHandshake;
    try {
      return await currentHandshake;
    } finally {
      if (this.handshakePromise === currentHandshake) {
        this.handshakePromise = null;
      }
    }
  }

  resetSession(clientToReset?: Client | null): void {
    if (clientToReset && this.session !== clientToReset) {
      // A replacement may still be handshaking, leaving this.session null.
      // A late failure from the old client must not invalidate that handshake.
      void clientToReset.close().catch(() => {});
      return;
    }
    const current = this.session;
    this.session = null;
    this.sessionGeneration++;
    this.handshakePromise = null;
    if (current) void current.close().catch(() => {});
    if (clientToReset && clientToReset !== current) {
      void clientToReset.close().catch(() => {});
    }
  }

  close(): void {
    this.resetSession();
  }

  private scrub(text: string): string {
    if (!text || typeof text !== "string") return "";
    return text.replaceAll(this.config.token, "[REDACTED]");
  }

  private mapTransportError(err: unknown): ZcodeSessionError {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const message = this.scrub(rawMessage);
    if (/401|unauthorized/i.test(message)) {
      return new ZcodeSessionError("ZCODE_SESSION_UNAUTHORIZED", "Z2C rejected the configured service token");
    }
    if (/timed?\s?out/i.test(message)) {
      return new ZcodeSessionError("ZCODE_SESSION_TIMEOUT", `Z2C request timed out: ${message}`);
    }
    return new ZcodeSessionError("ZCODE_SESSION_UNAVAILABLE", `Z2C semantic service unreachable: ${message}`);
  }

  // ── semantic surface ──────────────────────────────────────────────────────
  async runtimeCapabilities(): Promise<Record<string, unknown>> {
    return (await this.callTool("zcode_runtime_capabilities", {})) as Record<string, unknown>;
  }

  /**
   * Read-only provider/model/thought catalog from the z2c-service (no sessions
   * are created). Forwards the tool result as-is — the wire contract is
   * defined and validated on the A2C side by the model-catalog mapper; this
   * client adds no shape assumptions of its own.
   */
  async modelCatalog(): Promise<ZcodeModelCatalogToolResult> {
    const result = (await this.callTool("zcode_model_catalog", {})) as Partial<ZcodeModelCatalogToolResult>;
    return result ?? {};
  }

  async workspaceList(): Promise<{ workspaces: ZcodeWorkspaceGrant[] }> {
    const res = (await this.callTool("zcode_workspace_list", {})) as { workspaces?: ZcodeWorkspaceGrant[] };
    if (!res || !Array.isArray(res.workspaces) || res.workspaces.some((grant) =>
      !grant || typeof grant.workspace_id !== "string" || !grant.workspace_id
      || typeof grant.canonical_path !== "string" || !grant.canonical_path)) {
      throw new ZcodeSessionError("ZCODE_SESSION_UPSTREAM", "Z2C workspace list response is malformed");
    }
    return { workspaces: res.workspaces };
  }

  /** Find the Z2C grant matching a canonical A2C workspace root, or null. */
  async findGrantByPath(canonicalPath: string): Promise<ZcodeWorkspaceGrant | null> {
    const list = await this.workspaceList();
    const wanted = canonicalPath.replace(/[\\/]+$/, "").toLowerCase();
    return (
      list.workspaces.find(
        (g) => typeof g.canonical_path === "string" && g.canonical_path.replace(/[\\/]+$/, "").toLowerCase() === wanted,
      ) ?? null
    );
  }

  /**
   * Mirror an A2C-authorized workspace into the Z2C companion's grant registry
   * when missing. This is a LOCAL-user-authorized propagation (A2C's registry
   * is authoritative; the Z2C service is machine-local and secret-gated) —
   * never a ChatGPT self-authorization.
   */
  async ensureGrant(canonicalPath: string, write: boolean): Promise<ZcodeWorkspaceGrant> {
    const existing = await this.findGrantByPath(canonicalPath);
    if (process.env.A2C_ZCODE_DEBUG) console.error(`[zcode-session] findGrantByPath(${canonicalPath}) →`, JSON.stringify(existing));
    // A read projection must not prevent a later authorized write upgrade.
    // Never downgrade an existing write grant for an observational call.
    if (existing && (!write || existing.permissions?.write === true)) return existing;
    let res: Response;
    try {
      res = await fetch(`${this.config.apiBase}/api/workspaces/authorize`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.config.token}` },
        body: JSON.stringify({ path: canonicalPath, write, displayName: "a2c-shared" }),
      });
    } catch (err) {
      throw this.mapTransportError(err);
    }
    if (!res.ok) {
      throw new ZcodeSessionError("ZCODE_SESSION_UPSTREAM", `Z2C grant provisioning failed: HTTP ${res.status}`);
    }
    const raw = (await res.json()) as ZcodeWorkspaceGrant & { workspaceId?: string };
    // The REST surface returns camelCase (WorkspaceGrant); the MCP surface
    // returns snake_case. Normalize so callers always see workspace_id.
    const grant: ZcodeWorkspaceGrant = {
      ...raw,
      workspace_id: raw.workspace_id ?? raw.workspaceId,
    };
    if (process.env.A2C_ZCODE_DEBUG) console.error(`[zcode-session] provisioned →`, JSON.stringify(grant));
    return grant;
  }

  async createSession(input: {
    operation_id?: string;
    workspace_id: string;
    access: "readonly" | "write";
    model?: string;
    thought_level?: string;
    provider?: string;
    entitlement_plan?: "DEFAULT" | "START" | "INDIVIDUAL";
  }, timeoutMs?: number): Promise<ZcodeSessionState> {
    return (await this.callTool("zcode_session_create", input as Record<string, unknown>, timeoutMs)) as ZcodeSessionState;
  }

  async readSession(input: { workspace_id: string; session_id: string }): Promise<ZcodeSessionState> {
    return (await this.callTool("zcode_session_read", input)) as ZcodeSessionState;
  }

  async sendSession(input: { workspace_id: string; session_id: string; instruction: string; timeout_ms?: number }): Promise<{ state: ZcodeSessionState; output: string; turn: string }> {
    const timeoutMs = Math.min(Math.max(input.timeout_ms ?? 5 * 60_000, 10_000), 900_000);
    return (await this.callTool(
      "zcode_session_send",
      {
        workspace_id: input.workspace_id,
        session_id: input.session_id,
        instruction: input.instruction,
        timeout_ms: timeoutMs,
      },
      timeoutMs + 30_000,
    )) as { state: ZcodeSessionState; output: string; turn: string };
  }

  async setModel(input: { workspace_id: string; session_id: string; model: string }): Promise<ZcodeSessionState> {
    return (await this.callTool("zcode_session_set_model", input)) as ZcodeSessionState;
  }

  async setThoughtLevel(input: { workspace_id: string; session_id: string; thought_level: string }): Promise<ZcodeSessionState> {
    return (await this.callTool("zcode_session_set_thought_level", input)) as ZcodeSessionState;
  }

  // ── shared plane observation surface (Z2C local-operator capabilities) ────
  async discoverSessions(input?: { workspace_id?: string }): Promise<{ sessions: ZcodeDiscoveredSession[] }> {
    return (await this.callTool("zcode_session_discover", input ?? {})) as { sessions: ZcodeDiscoveredSession[] };
  }

  async observeSession(input: { workspace_id: string; session_id: string }): Promise<ZcodeSessionState> {
    return (await this.callTool("zcode_session_observe", input)) as ZcodeSessionState;
  }

  async observeSessionMessages(input: { workspace_id: string; session_id: string; limit?: number }): Promise<{ messages: Array<Record<string, unknown>> }> {
    return (await this.callTool("zcode_session_observe_messages", input)) as { messages: Array<Record<string, unknown>> };
  }
}

/**
 * Native session discovery entry projected by the Z2C service's local-only
 * observation surface. runtime_origin "z2c" = created through the Z2C lane
 * (controlled_by_z2c true); "external" = Desktop/manual origin.
 */
export interface ZcodeDiscoveredSession {
  session_id: string;
  workspace_id: string;
  workspace_path: string;
  status: string;
  title: string | null;
  updated_at: string | null;
  controlled_by_z2c: boolean;
  owner_client_id: string | null;
  access_mode: "readonly" | "write" | null;
  runtime_origin: "z2c" | "external";
}

let cachedClient: ZcodeSessionClient | null = null;

export function zcodeSessionClient(): ZcodeSessionClient {
  cachedClient ??= new ZcodeSessionClient(loadZcodeSessionConfig());
  return cachedClient;
}

export function resetZcodeSessionClientForTests(): void {
  if (cachedClient) {
    cachedClient.close();
  }
  cachedClient = null;
}
