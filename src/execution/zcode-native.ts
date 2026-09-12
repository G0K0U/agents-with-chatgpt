/**
 * Governed client for the EXISTING Z2C control plane (an independent local
 * Z2C service installed and run by the operator).
 *
 * Z2C is NOT merged into C2C: this module is a thin, fail-closed forwarding
 * client over Z2C's own bearer-authenticated Streamable HTTP MCP surface
 * (default http://127.0.0.1:8766/mcp — the Z2C-owned port, distinct from
 * Quanta's 8765; token in %LOCALAPPDATA%\z2c\auth.json).
 *
 * Governance invariants (all fail closed):
 *  - The endpoint and token come ONLY from this fixed local configuration —
 *    never from MCP callers. The host must be loopback and redirects are not
 *    followed (redirect: "manual").
 *  - Service identity is proven from the MCP handshake: the peer must be the
 *    "z2c-bridge" server. Anything else answering on the port (e.g. another
 *    local service) is rejected.
 *  - Only workspace ids enabled via ZCODE_NATIVE_ALLOWED_WORKSPACES (a
 *    comma-separated operator-owned environment variable) may be forwarded.
 *    This allowlist is defense in depth; principal ownership is enforced
 *    separately via C2C's resolveWorkspace (see the MCP tool layer).
 *  - Desktop-managed auth only: the execution identity of an accepted
 *    task is the model binding Z2C OBSERVED for that exact session at
 *    admission (native session/read). Z2C admits only observed
 *    builtin:zai-start-plan/GLM-5.3-Flash sessions, and this client re-verifies
 *    the returned task binding before binding the task/session identity
 *    anywhere. Unobserved identity fails closed; the required identity
 *    constants are comparison targets, never evidence.
 *  - Response namespace: every returned task view must match the requested
 *    workspace_id (and task_id/session_id where applicable) or the result is
 *    discarded with an upstream error.
 *  - Bearer/registration tokens are never echoed: upstream payloads are
 *    scrubbed of the configured token before parsing, and only projected
 *    fields are released.
 *  - No fallback: failures never route into the governed scheduled queue.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalizeWorkspaceRoot } from "../workspace/identity.js";
import { createHash } from "node:crypto";
import { rejectCredentialLikeInstruction } from "./zcode-control.js";

/**
 * Operator-owned native forwarding allowlist. Empty by default: no workspace
 * is forwardable until the operator explicitly enables it, keeping the native
 * lane fail closed on unconfigured machines without baking in machine-local
 * workspace identities.
 */
export function nativeAllowedWorkspaces(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const raw = env.ZCODE_NATIVE_ALLOWED_WORKSPACES?.trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry)),
  );
}

// 2026-09-12: a fresh live Desktop session observed through the
// desktop-agent chain reports builtin:zai-start-plan / GLM-5.3-Flash, which
// replaces the previously required builtin:zai-coding-plan / GLM-5.3
// comparison target. Comparison target only — never evidence; the accepted
// binding must be OBSERVED from the exact session's own state.
export const ZCODE_NATIVE_REQUIRED_IDENTITY = {
  provider: "zcode-desktop", // DesktopZcodeProvider.name — the only desktop-managed provider
  provider_id: "builtin:zai-start-plan",
  model_id: "GLM-5.3-Flash",
} as const;

/** Expected MCP server identity of the real Z2C control plane. */
export const ZCODE_NATIVE_EXPECTED_SERVICE = "z2c-bridge";

/** Upper bound for released native execution output text. */
export const ZCODE_NATIVE_MAX_OUTPUT_CHARS = 16000;

export interface ZcodeNativeConfig {
  url: string;
  token: string;
  requestTimeoutMs: number;
}

export class ZcodeNativeError extends Error {
  constructor(
    public readonly code:
      | "ZCODE_NATIVE_CONFIG"
      | "ZCODE_NATIVE_UNCONFIGURED"
      | "ZCODE_NATIVE_UNAVAILABLE"
      | "ZCODE_NATIVE_UNAUTHORIZED"
      | "ZCODE_NATIVE_TIMEOUT"
      | "ZCODE_NATIVE_SERVICE_MISMATCH"
      | "ZCODE_NATIVE_NOT_ATTESTED"
      | "ZCODE_NATIVE_WORKSPACE_FORBIDDEN"
      | "ZCODE_NATIVE_INSTRUCTION_REJECTED"
      | "ZCODE_NATIVE_NAMESPACE_MISMATCH"
      | "ZCODE_NATIVE_UPSTREAM",
    message: string,
    public readonly upstreamCode?: string,
  ) {
    super(message);
    this.name = "ZcodeNativeError";
  }
}

function assertLoopbackHttpUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ZcodeNativeError("ZCODE_NATIVE_CONFIG", `invalid Z2C endpoint URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
    throw new ZcodeNativeError(
      "ZCODE_NATIVE_CONFIG",
      "Z2C endpoint must be a loopback http:// URL (no 0.0.0.0, no remote hosts)",
    );
  }
  return parsed;
}

function readAuthTokenFile(path: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new ZcodeNativeError(
      "ZCODE_NATIVE_UNCONFIGURED",
      `Z2C auth token not found at ${path} (start the Z2C bridge once to generate it, or set ZCODE_NATIVE_TOKEN)`,
    );
  }
  try {
    const parsed = JSON.parse(raw) as { bearerToken?: unknown };
    if (typeof parsed.bearerToken !== "string" || parsed.bearerToken.length < 16) {
      throw new Error("missing bearerToken");
    }
    return parsed.bearerToken;
  } catch (err) {
    if (err instanceof ZcodeNativeError) throw err;
    throw new ZcodeNativeError("ZCODE_NATIVE_CONFIG", `unrecognized Z2C auth file shape at ${path}`);
  }
}

export function loadZcodeNativeConfig(env: NodeJS.ProcessEnv = process.env): ZcodeNativeConfig {
  const url = assertLoopbackHttpUrl(env.ZCODE_NATIVE_URL ?? "http://127.0.0.1:8766/mcp").toString();
  const token = env.ZCODE_NATIVE_TOKEN
    ? env.ZCODE_NATIVE_TOKEN
    : readAuthTokenFile(
        env.ZCODE_NATIVE_AUTH_FILE ??
          join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "z2c", "auth.json"),
      );
  const timeoutRaw = env.ZCODE_NATIVE_TIMEOUT_MS ? Number(env.ZCODE_NATIVE_TIMEOUT_MS) : 20000;
  if (!Number.isInteger(timeoutRaw) || timeoutRaw < 1000 || timeoutRaw > 120000) {
    throw new ZcodeNativeError("ZCODE_NATIVE_CONFIG", "ZCODE_NATIVE_TIMEOUT_MS must be 1000..120000");
  }
  return { url, token, requestTimeoutMs: timeoutRaw };
}

export interface ZcodeNativeTaskView {
  idempotency?: { protocol: "workspace-task-v1"; key: string; request_fingerprint: string; replayed: boolean };
  task_id: string;
  session_id: string | null;
  workspace_id: string;
  status: string;
  created_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
  exit_status?: string | null;
  output_id?: string | null;
  /** Binding OBSERVED by Z2C from the exact session's own state at admission. */
  model_binding?: { provider_id: string; model_id: string; source?: string } | null;
}

export interface ZcodeNativeOutput {
  output_id: string;
  task_id: string;
  workspace_id: string;
  session_id: string | null;
  text: string;
}

export interface ZcodeNativeStatus {
  available: boolean;
  reason?: string;
  runtime?: string;
  workspace_id?: string;
  desktop_managed_auth?: boolean;
  provider?: { name: string; status: string; detail: string | null; zcode_version: string | null };
  capabilities_ok?: boolean;
  start_plan?: {
    attested: boolean;
    provider_id: string;
    model_id: string;
    identity_source: "control-plane-reported" | "unobserved";
    mismatches: string[];
  };
  allowed_workspaces: string[];
  generated_at: string;
}

interface ProviderStatusBody {
  workspace_id?: unknown;
  durable_idempotency?: unknown;
  provider?: unknown;
  status?: unknown;
  detail?: unknown;
  zcode_version?: unknown;
  capabilities?: unknown;
  model_binding?: unknown;
}

interface McpToolResult {
  content?: Array<{ type?: unknown; text?: unknown }>;
  isError?: boolean;
}

export interface SubmitNativeInput {
  idempotency_key?: string;
  workspace_id: string;
  instruction: string;
  write_scope?: "workspace" | "readonly";
  mode?: "plan" | "build" | "edit";
}

export interface ResumeNativeInput {
  expected_workspace_path?: string;
  workspace_id: string;
  session_id: string;
  instruction: string;
}

const SESSION_ID_RE = /^sess_[0-9a-f-]{36}$/i;
export const ZCODE_IDEMPOTENCY_PROTOCOL = "workspace-task-v1";
export const ZCODE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?![\s\S])/;
export function nativeRequestFingerprint(input: SubmitNativeInput): string {
  return createHash("sha256").update(JSON.stringify({ workspace_id: input.workspace_id, instruction: input.instruction,
    write_scope: input.write_scope ?? "workspace", network: "default", mode: input.mode ?? "build", resume_session_id: null })).digest("hex");
}
export function assertNativeIdempotency(view: ZcodeNativeTaskView, input: SubmitNativeInput): void {
  const proof = view?.idempotency;
  if (!input.idempotency_key || !ZCODE_IDEMPOTENCY_KEY.test(input.idempotency_key) || !proof ||
      proof.protocol !== ZCODE_IDEMPOTENCY_PROTOCOL || proof.key !== input.idempotency_key ||
      proof.request_fingerprint !== nativeRequestFingerprint(input) || typeof proof.replayed !== "boolean" ||
      !["queued", "running", "completed", "failed", "cancelled", "interrupted"].includes(view.status)) {
    throw new ZcodeNativeError("ZCODE_NATIVE_UPSTREAM", "Z2C durable idempotency proof invalid or missing", "IDEMPOTENCY_INVALID");
  }
}

export class ZcodeNativeClient {
  private session: Client | null = null;

  constructor(private readonly config: ZcodeNativeConfig) {
    assertLoopbackHttpUrl(config.url);
    if (typeof config.token !== "string" || config.token.length < 8) {
      throw new ZcodeNativeError("ZCODE_NATIVE_UNCONFIGURED", "Z2C bearer token missing or too short");
    }
  }

  /**
   * Forward one tool call to Z2C. The bearer token is scrubbed from the
   * payload before parsing so it can never leak into released results or
   * errors.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.ensureSession();
    let result: unknown;
    try {
      result = (await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: this.config.requestTimeoutMs },
      )) as McpToolResult;
    } catch (err) {
      this.resetSession();
      throw err instanceof ZcodeNativeError ? err : this.mapTransportError(err);
    }
    const typed = result as McpToolResult;
    const text = (typed.content ?? [])
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("\n");
    if (typed.isError) {
      const cleaned = text.replaceAll(this.config.token, "[REDACTED]");
      const sep = cleaned.indexOf(": ");
      const looksCoded = sep > 0 && /^[A-Z][A-Z0-9_]+$/.test(cleaned.slice(0, sep));
      throw new ZcodeNativeError(
        "ZCODE_NATIVE_UPSTREAM",
        looksCoded ? cleaned.slice(sep + 2) : cleaned || "Z2C tool error",
        looksCoded ? cleaned.slice(0, sep) : undefined,
      );
    }
    const scrubbed = text.replaceAll(this.config.token, "[REDACTED]");
    try {
      return JSON.parse(scrubbed) as unknown;
    } catch {
      return { text: scrubbed };
    }
  }

  /**
   * Workspace-scoped provider status: the binding reported by Z2C is resolved
   * for exactly this workspace's registered context — never another's.
   */
  async providerStatus(workspaceId: string): Promise<ProviderStatusBody> {
    return (await this.callTool("provider_status", { workspace_id: workspaceId })) as ProviderStatusBody;
  }

  async status(workspaceId: string): Promise<ZcodeNativeStatus> {
    const generated_at = new Date().toISOString();
    let body: ProviderStatusBody;
    try {
      body = await this.providerStatus(workspaceId);
    } catch (err) {
      const code = err instanceof ZcodeNativeError ? err.code : "ZCODE_NATIVE_UNAVAILABLE";
      return {
        available: false,
        reason: code,
        allowed_workspaces: [...nativeAllowedWorkspaces()],
        generated_at,
      };
    }
    const providerName = typeof body.provider === "string" ? body.provider : String(body.provider ?? "");
    const providerStatus = typeof body.status === "string" ? body.status : String(body.status ?? "");
    const caps = body.capabilities as { ok?: unknown } | undefined;
    const capabilities_ok = caps?.ok === true;
    const desktop_managed_auth = providerName === ZCODE_NATIVE_REQUIRED_IDENTITY.provider;

    // Execution identity truth: the effective provider/model binding must be
    // OBSERVED from the control plane. Absence is UNKNOWN and never attested;
    // the required constants are never substituted for missing evidence.
    const binding = (body.model_binding ?? null) as
      | { provider_id?: unknown; model_id?: unknown }
      | null;
    const observedProvider = typeof binding?.provider_id === "string" ? binding.provider_id : null;
    const observedModel = typeof binding?.model_id === "string" ? binding.model_id : null;
    const mismatches: string[] = [];
    if (observedProvider === null || observedModel === null) {
      mismatches.push("model_binding unobserved");
    }
    if (observedProvider !== null && observedProvider !== ZCODE_NATIVE_REQUIRED_IDENTITY.provider_id) {
      mismatches.push(`provider_id=${observedProvider}`);
    }
    if (observedModel !== null && observedModel !== ZCODE_NATIVE_REQUIRED_IDENTITY.model_id) {
      mismatches.push(`model_id=${observedModel}`);
    }
    if (!desktop_managed_auth) mismatches.push(`provider=${providerName || "unknown"}`);
    if (providerStatus !== "healthy") mismatches.push(`provider_status=${providerStatus || "unknown"}`);
    if (!capabilities_ok) mismatches.push("capabilities");

    const attested = mismatches.length === 0;
    return {
      available: true,
      runtime: "z2c-desktop",
      workspace_id: workspaceId,
      desktop_managed_auth,
      provider: {
        name: providerName,
        status: providerStatus,
        detail: typeof body.detail === "string" ? body.detail : null,
        zcode_version: typeof body.zcode_version === "string" ? body.zcode_version : null,
      },
      capabilities_ok,
      start_plan: {
        attested,
        provider_id: observedProvider ?? "UNKNOWN",
        model_id: observedModel ?? "UNKNOWN",
        identity_source: observedProvider !== null && observedModel !== null
          ? "control-plane-reported"
          : "unobserved",
        mismatches,
      },
      allowed_workspaces: [...nativeAllowedWorkspaces()],
      generated_at,
    };
  }

  async submitTask(input: SubmitNativeInput, beforeDispatch?: () => void): Promise<ZcodeNativeTaskView> {
    this.assertWorkspaceAllowed(input.workspace_id);
    this.assertInstruction(input.instruction);
    if (input.idempotency_key !== undefined) {
      if (typeof input.idempotency_key !== "string" || !ZCODE_IDEMPOTENCY_KEY.test(input.idempotency_key)) {
        throw new ZcodeNativeError("ZCODE_NATIVE_INSTRUCTION_REJECTED", "idempotency_key must be 1..128 safe ASCII characters, starting alphanumeric");
      }
      // Older MCP builds may silently strip unknown arguments. Prove support
      // before submission, then independently validate the returned key proof.
      const protocol = await this.providerStatus(input.workspace_id);
      if (protocol?.workspace_id !== input.workspace_id || protocol.durable_idempotency !== ZCODE_IDEMPOTENCY_PROTOCOL) {
        throw new ZcodeNativeError("ZCODE_NATIVE_UPSTREAM", "Z2C upgrade required: durable idempotency protocol unavailable", "IDEMPOTENCY_UPGRADE_REQUIRED");
      }
    }
    beforeDispatch?.();
    const raw = await this.callTool("submit_zcode_task", {
      workspace_id: input.workspace_id,
      instruction: input.instruction,
      ...(input.write_scope ? { write_scope: input.write_scope } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.idempotency_key !== undefined ? { idempotency_key: input.idempotency_key } : {}),
    });
    // Namespace: the created task must belong to the authorized workspace and
    // carry a mapped native session id. Execution identity comes from the
    // task/session binding Z2C observed at admission (exact session/read) —
    // never from a pre-submit idle status probe.
    const view = projectTaskView(raw, {
      workspace_id: input.workspace_id,
      require_session_id: true,
    });
    assertTaskBinding(view);
    if (input.idempotency_key !== undefined) assertNativeIdempotency(view, input);
    return view;
  }

  async getTask(input: { workspace_id: string; task_id: string }): Promise<ZcodeNativeTaskView> {
    this.assertWorkspaceAllowed(input.workspace_id);
    const raw = await this.callTool("get_zcode_task", input);
    return projectTaskView(raw, input);
  }

  /** Verify the authorized workspace/task before forwarding cancellation. */
  async cancelTask(input: { workspace_id: string; task_id: string }): Promise<ZcodeNativeTaskView> {
    const task = await this.getTask(input);
    const raw = await this.callTool("cancel_zcode_task", input);
    return projectTaskView(raw, { ...input, session_id: task.session_id ?? undefined });
  }

  async readSession(input: { workspace_id: string; session_id: string; expected_workspace_path?: string }) {
    this.assertWorkspaceAllowed(input.workspace_id);
    if (!SESSION_ID_RE.test(input.session_id)) throw new ZcodeNativeError("ZCODE_NATIVE_INSTRUCTION_REJECTED", "Invalid native session id");
    const raw = await this.callTool("read_zcode_session", { workspace_id: input.workspace_id, session_id: input.session_id }) as Record<string, unknown>;
    if (raw.workspace_id !== input.workspace_id || raw.session_id !== input.session_id || typeof raw.canonical_path !== "string") {
      throw new ZcodeNativeError("ZCODE_NATIVE_NAMESPACE_MISMATCH", "Exact session namespace mismatch");
    }
    if (input.expected_workspace_path) {
      const normalize = (p: string) => process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
      if (normalize(canonicalizeWorkspaceRoot(raw.canonical_path)) !== normalize(canonicalizeWorkspaceRoot(input.expected_workspace_path))) {
        throw new ZcodeNativeError("ZCODE_NATIVE_NAMESPACE_MISMATCH", "Native workspace path differs from C2C registry");
      }
    }
    const binding = projectBinding(raw.model_binding);
    if (binding?.provider_id !== ZCODE_NATIVE_REQUIRED_IDENTITY.provider_id || binding?.model_id !== ZCODE_NATIVE_REQUIRED_IDENTITY.model_id || binding.source !== "desktop-session-read" || raw.immediate_resume !== "native-session-v1") {
      throw new ZcodeNativeError("ZCODE_NATIVE_NOT_ATTESTED", "Exact native session binding or immediate continuation contract unavailable");
    }
    return { workspace_id: input.workspace_id, session_id: input.session_id, canonical_path: raw.canonical_path, model_binding: binding };
  }

  async resumeSession(input: ResumeNativeInput, beforeDispatch?: () => void): Promise<ZcodeNativeTaskView> {
    this.assertWorkspaceAllowed(input.workspace_id);
    this.assertInstruction(input.instruction);
    if (!SESSION_ID_RE.test(input.session_id)) {
      throw new ZcodeNativeError("ZCODE_NATIVE_INSTRUCTION_REJECTED", "session_id must match sess_<uuid>");
    }
    await this.readSession(input);
    beforeDispatch?.();
    const raw = await this.callTool("resume_zcode_session", {
      workspace_id: input.workspace_id,
      session_id: input.session_id,
      instruction: input.instruction,
    });
    // The resumed task must stay bound to the mapped native session; its
    // execution identity is the binding Z2C observed for that exact session.
    const view = projectTaskView(raw, {
      workspace_id: input.workspace_id,
      session_id: input.session_id,
    });
    return assertTaskBinding(view);
  }

  /**
   * Bounded execution output for audit. Ownership is proven first: the task
   * must live in the authorized workspace and reference the requested output.
   */
  async executionOutput(input: {
    workspace_id: string;
    task_id: string;
    output_id: string;
  }, observeTask?: (task: ZcodeNativeTaskView) => void): Promise<ZcodeNativeOutput> {
    const task = await this.getTask({ workspace_id: input.workspace_id, task_id: input.task_id });
    observeTask?.(task);
    if (task.output_id == null || task.output_id !== input.output_id) {
      throw new ZcodeNativeError(
        "ZCODE_NATIVE_NAMESPACE_MISMATCH",
        "output_id is not owned by the requested task",
      );
    }
    const raw = (await this.callTool("execution_output", {
      workspace_id: input.workspace_id,
      task_id: input.task_id,
      output_id: input.output_id,
    })) as Record<string, unknown>;
    const outId = typeof raw.output_id === "string" ? raw.output_id : null;
    const outTask = typeof raw.task_id === "string" ? raw.task_id : null;
    if (outId !== input.output_id || outTask !== input.task_id) {
      throw new ZcodeNativeError("ZCODE_NATIVE_NAMESPACE_MISMATCH", "output identity mismatch from Z2C");
    }
    const sessionId = typeof raw.session_id === "string" ? raw.session_id : null;
    if (sessionId !== null && task.session_id !== null && sessionId !== task.session_id) {
      throw new ZcodeNativeError("ZCODE_NATIVE_NAMESPACE_MISMATCH", "output session mismatch from Z2C");
    }
    const text = typeof raw.text === "string" ? raw.text : "";
    const bounded =
      text.length > ZCODE_NATIVE_MAX_OUTPUT_CHARS
        ? text.slice(0, ZCODE_NATIVE_MAX_OUTPUT_CHARS) + "…[truncated]"
        : text;
    return { output_id: outId, task_id: outTask, workspace_id: input.workspace_id, session_id: sessionId, text: bounded };
  }

  close(): void {
    this.resetSession();
  }

  // ── governance gates ───────────────────────────────────────────────────────

  private assertWorkspaceAllowed(workspaceId: string): void {
    if (!nativeAllowedWorkspaces().has(workspaceId)) {
      throw new ZcodeNativeError(
        "ZCODE_NATIVE_WORKSPACE_FORBIDDEN",
        `workspace ${workspaceId} is not enabled for native forwarding (set ZCODE_NATIVE_ALLOWED_WORKSPACES)`,
      );
    }
  }

  private assertInstruction(instruction: string): void {
    if (typeof instruction !== "string" || instruction.length < 1 || instruction.length > 20000) {
      throw new ZcodeNativeError("ZCODE_NATIVE_INSTRUCTION_REJECTED", "instruction must be 1..20000 chars");
    }
    try {
      rejectCredentialLikeInstruction(instruction);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ZcodeNativeError("ZCODE_NATIVE_INSTRUCTION_REJECTED", message);
    }
  }

  // ── session plumbing ───────────────────────────────────────────────────────

  private async ensureSession(): Promise<Client> {
    if (this.session) return this.session;
    const client = new Client({ name: "c2c-zcode-native", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
      requestInit: {
        headers: { Authorization: `Bearer ${this.config.token}` },
        // Never follow a redirect away from the configured loopback endpoint.
        redirect: "manual",
      },
    });
    try {
      await client.connect(transport);
      // Prove the peer is really the Z2C control plane via the MCP handshake
      // (ports are shared by other local services; identity is not inferred
      // from the port).
      const version = client.getServerVersion();
      if (!version || version.name !== ZCODE_NATIVE_EXPECTED_SERVICE) {
        throw new ZcodeNativeError(
          "ZCODE_NATIVE_SERVICE_MISMATCH",
          `expected ${ZCODE_NATIVE_EXPECTED_SERVICE} MCP handshake, got ${version?.name ?? "unknown"}`,
        );
      }
    } catch (err) {
      this.resetSession();
      throw err instanceof ZcodeNativeError ? err : this.mapTransportError(err);
    }
    this.session = client;
    return client;
  }

  private resetSession(): void {
    const client = this.session;
    this.session = null;
    if (client) void client.close().catch(() => {});
  }

  private mapTransportError(err: unknown): ZcodeNativeError {
    const message = err instanceof Error ? err.message : String(err);
    if (/401|unauthorized/i.test(message)) {
      return new ZcodeNativeError("ZCODE_NATIVE_UNAUTHORIZED", "Z2C rejected the configured bearer token");
    }
    if (/timed?\s?out/i.test(message)) {
      return new ZcodeNativeError("ZCODE_NATIVE_TIMEOUT", `Z2C request timed out: ${message}`);
    }
    return new ZcodeNativeError("ZCODE_NATIVE_UNAVAILABLE", `native ZCode control plane unreachable: ${message}`);
  }
}

/**
 * Execution identity of an accepted task comes from the binding Z2C observed
 * for that exact session at admission (one observation source: Z2C's native
 * session/read). A returned task without the required observed identity is
 * discarded before the task/session identity is bound anywhere.
 */
function assertTaskBinding(view: ZcodeNativeTaskView): ZcodeNativeTaskView {
  const binding = view.model_binding;
  if (
    !binding ||
    binding.provider_id !== ZCODE_NATIVE_REQUIRED_IDENTITY.provider_id ||
    binding.model_id !== ZCODE_NATIVE_REQUIRED_IDENTITY.model_id
  ) {
    throw new ZcodeNativeError(
      "ZCODE_NATIVE_NOT_ATTESTED",
      `task ${view.task_id} carries unverified execution binding (observed ` +
        `${binding ? `${binding.provider_id}/${binding.model_id}` : "unknown"}; ` +
        `requires ${ZCODE_NATIVE_REQUIRED_IDENTITY.provider_id}/${ZCODE_NATIVE_REQUIRED_IDENTITY.model_id})`,
    );
  }
  return view;
}

/**
 * Project only safe bounded fields from an upstream task view and enforce the
 * response namespace (workspace/task/session must match the authorized
 * request). Unknown extra fields are dropped.
 */
function projectTaskView(
  raw: unknown,
  expected: { workspace_id?: string; task_id?: string; session_id?: string; require_session_id?: boolean },
): ZcodeNativeTaskView {
  const v = (raw ?? {}) as Record<string, unknown>;
  const task_id = typeof v.task_id === "string" ? v.task_id : null;
  const workspace_id = typeof v.workspace_id === "string" ? v.workspace_id : null;
  const session_id = typeof v.session_id === "string" ? v.session_id : null;
  if (task_id === null || !/^z2c_[A-Za-z0-9_-]{1,100}$/.test(task_id) || workspace_id === null) {
    throw new ZcodeNativeError("ZCODE_NATIVE_UPSTREAM", "malformed task view from Z2C");
  }
  if (expected.workspace_id !== undefined && workspace_id !== expected.workspace_id) {
    throw new ZcodeNativeError(
      "ZCODE_NATIVE_NAMESPACE_MISMATCH",
      `task workspace mismatch: ${workspace_id} != ${expected.workspace_id}`,
    );
  }
  if (expected.task_id !== undefined && task_id !== expected.task_id) {
    throw new ZcodeNativeError(
      "ZCODE_NATIVE_NAMESPACE_MISMATCH",
      `task id mismatch: ${task_id} != ${expected.task_id}`,
    );
  }
  if (expected.session_id !== undefined && session_id !== expected.session_id) {
    throw new ZcodeNativeError(
      "ZCODE_NATIVE_NAMESPACE_MISMATCH",
      "task session mismatch: returned session does not belong to the mapped native session",
    );
  }
  if (expected.require_session_id === true && (session_id === null || !SESSION_ID_RE.test(session_id))) {
    throw new ZcodeNativeError("ZCODE_NATIVE_UPSTREAM", "created task returned no valid native session id");
  }
  return {
    task_id,
    workspace_id,
    session_id,
    status: typeof v.status === "string" ? v.status : "unknown",
    created_at: typeof v.created_at === "string" ? v.created_at : undefined,
    started_at: typeof v.started_at === "string" ? v.started_at : undefined,
    completed_at: typeof v.completed_at === "string" ? v.completed_at : undefined,
    exit_status: typeof v.exit_status === "string" ? v.exit_status : undefined,
    output_id: typeof v.output_id === "string" ? v.output_id : undefined,
    model_binding: projectBinding(v.model_binding),
    ...(v.idempotency && typeof v.idempotency === "object" ? { idempotency: {
      protocol: (v.idempotency as ZcodeNativeTaskView["idempotency"])!.protocol,
      key: (v.idempotency as ZcodeNativeTaskView["idempotency"])!.key,
      request_fingerprint: (v.idempotency as ZcodeNativeTaskView["idempotency"])!.request_fingerprint,
      replayed: (v.idempotency as ZcodeNativeTaskView["idempotency"])!.replayed,
    } } : {}),
  };
}

/** Project the observed session binding exactly as Z2C reported it, or null. */
function projectBinding(raw: unknown): { provider_id: string; model_id: string; source?: string } | null {
  const b = (raw ?? null) as Record<string, unknown> | null;
  if (!b || typeof b.provider_id !== "string" || typeof b.model_id !== "string") return null;
  return {
    provider_id: b.provider_id,
    model_id: b.model_id,
    ...(typeof b.source === "string" ? { source: b.source } : {}),
  };
}
