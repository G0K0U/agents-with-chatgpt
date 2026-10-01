import { type EntitlementAttestation, type EntitlementPlan, type EntitlementSelectionSupport, entitlementFingerprintFields, isAttestedEntitlement, requireSupportedEntitlement } from "./zcode-entitlement.js";
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
 *    "z2c-service" server. Anything else answering on the port (e.g. another
 *    local service) is rejected.
 *  - Only workspace ids enabled via ZCODE_NATIVE_ALLOWED_WORKSPACES (a
 *    comma-separated operator-owned environment variable) may be forwarded.
 *    This allowlist — and every principal authorization above it — speaks the
 *    PUBLIC A2C workspace id namespace only. Before any upstream call the
 *    authorized A2C id is projected onto its native Z2C grant id through the
 *    semantic lane's authoritative mapping (zcode-workspace-projection);
 *    upstream tools only ever see native ids.
 *  - Desktop-managed auth only: the execution identity of an accepted
 *    task is the model binding Z2C OBSERVED for that exact session at
 *    admission (native session/read). Z2C admits only observed
 *    the REQUIRED GLM identity (see ZCODE_NATIVE_REQUIRED_IDENTITY) at admission, and this client re-verifies
 *    the returned task binding before binding the task/session identity
 *    anywhere. Unobserved identity fails closed; the required identity
 *    constants are comparison targets, never evidence.
 *  - Response namespace: every returned task view must carry the projected
 *    native workspace id of the requested (authorized) A2C workspace — and
 *    every canonical root upstream attests must match the authorized A2C
 *    registry root. Views are released with the A2C workspace id restored, or
 *    the result is discarded with an upstream error.
 *  - Bearer/registration tokens are never echoed: upstream payloads are
 *    scrubbed of the configured token before parsing, and only projected
 *    fields are released.
 *  - No fallback: failures never route into the governed scheduled queue.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalizeWorkspaceRoot } from "../workspace/identity.js";
import { WorkspaceRegistry, WorkspaceRegistryError } from "../workspace/registry.js";
import { getStateDir } from "../config/paths.js";
import { createHash } from "node:crypto";
import { rejectCredentialLikeInstruction } from "./zcode-control.js";
import { ZcodeSessionClient, ZcodeSessionError } from "./zcode-session-client.js";
import {
  ZcodeWorkspaceProjectionError,
  assertProjectedNamespace,
  projectNativeWorkspace,
} from "./zcode-workspace-projection.js";

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

// 2026-09-28 (UPDATED PRODUCT POLICY): governed ChatGPT-controlled GLM work
// supports ALL models and effort levels advertised by the live ZCode runtime.
// The PREFERRED identity is GLM-5.3 + max on the coding-plan route. GLM-5.3-Flash
// remains fully supported when explicitly requested or when the runtime advertises
// it. The attestation contract itself is unchanged: the identity must still be
// OBSERVED from the exact session's own state (native session/read), never
// self-reported and never substituted.
//
// Historical note (2026-09-17): governed work was Flash-only; that restriction
// is removed. Any model advertised by the runtime on an admissible route is
// admissible; admission evidence is the exact-session observation.
export const ZCODE_NATIVE_PREFERRED_IDENTITY = {
  provider: "zcode-desktop", // DesktopZcodeProvider.name — legacy default
  provider_id: "builtin:zai-coding-plan",
  model_id: "GLM-5.3",
} as const;

/**
 * @deprecated Use ZCODE_NATIVE_PREFERRED_IDENTITY. Kept for backward compatibility.
 */
export const ZCODE_NATIVE_REQUIRED_IDENTITY = ZCODE_NATIVE_PREFERRED_IDENTITY;

/**
 * Admissible observed provider ids (ROUTE set, not a security property by
 * itself): the legacy Desktop coding-plan route, the official standalone
 * app-server route (observes `zai-api`, ZCode 0.16.9), and the ACCOUNT-BASED
 * coding-plan routes admitted by the standalone account runtime
 * (`account:<family>-<plan>` from the bundled provider catalog — zai/bigmodel
 * × start/individual). Team and off-peak account routes stay inadmissible:
 * Z2C has no billing semantic for them and must fail closed with a real
 * reason instead of silently admitting them. Admission ALWAYS additionally
 * requires the binding to be OBSERVED from the exact session's authoritative
 * read, and a requested START/INDIVIDUAL plan to be attested by that exact
 * session's registry readback.
 */
export const ZCODE_NATIVE_ADMISSIBLE_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "builtin:zai-coding-plan",
  "zai-api",
  "account:zai-start-plan",
  "account:zai-individual-coding-plan",
  "account:bigmodel-start-plan",
  "account:bigmodel-individual-coding-plan",
]);

/** Legacy desktop-managed provider identity. */
export const ZCODE_NATIVE_EXPECTED_PROVIDER = "zcode-desktop";
/** Official standalone app-server provider identity (ZCode 0.16.9+ bundled Agent). */
export const ZCODE_OFFICIAL_EXPECTED_PROVIDER = "zcode-official";
/** Admissible Z2C provider identities for the native/coordinator execution chain. */
export const ZCODE_ADMISSIBLE_PROVIDERS: ReadonlySet<string> = new Set([
  ZCODE_NATIVE_EXPECTED_PROVIDER,
  ZCODE_OFFICIAL_EXPECTED_PROVIDER,
]);

export function isAdmissibleZcodeProvider(provider: string | null | undefined): boolean {
  return typeof provider === "string" && ZCODE_ADMISSIBLE_PROVIDERS.has(provider);
}

/** Expected MCP server identity of the real Z2C control plane. */
export const ZCODE_NATIVE_EXPECTED_SERVICE = "z2c-service";

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
      | "ZCODE_NATIVE_OUTCOME_UNKNOWN"
      | "ZCODE_NATIVE_UNAUTHORIZED"
      | "ZCODE_NATIVE_TIMEOUT"
      | "ZCODE_NATIVE_SERVICE_MISMATCH"
      | "ZCODE_NATIVE_NOT_ATTESTED"
      | "ZCODE_INCOMPATIBLE_PROVIDER_VERSION"
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

function readActiveSecurityToken(path: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { secrets?: unknown } | null;
    if (!Array.isArray(parsed?.secrets)) return undefined;
    const active = parsed.secrets.find((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return false;
      const candidate = entry as { secret?: unknown; retiredAt?: unknown };
      return (candidate.retiredAt === undefined || candidate.retiredAt === null) &&
        typeof candidate.secret === "string" && candidate.secret.length >= 16;
    }) as { secret: string } | undefined;
    return active?.secret;
  } catch {
    // Missing or malformed security files defer to legacy auth without exposing contents.
    return undefined;
  }
}

export function loadZcodeNativeConfig(env: NodeJS.ProcessEnv = process.env): ZcodeNativeConfig {
  const url = assertLoopbackHttpUrl(env.ZCODE_NATIVE_URL ?? "http://127.0.0.1:8766/mcp").toString();
  const authDir = join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "z2c");
  const token =
    env.ZCODE_NATIVE_AUTH_FILE !== undefined
      ? readAuthTokenFile(env.ZCODE_NATIVE_AUTH_FILE)
      : (readActiveSecurityToken(join(authDir, "security.json")) ??
        (env.ZCODE_NATIVE_TOKEN
          ? env.ZCODE_NATIVE_TOKEN
          : readAuthTokenFile(join(authDir, "auth.json"))));
  const timeoutRaw = env.ZCODE_NATIVE_TIMEOUT_MS ? Number(env.ZCODE_NATIVE_TIMEOUT_MS) : 20000;
  if (!Number.isInteger(timeoutRaw) || timeoutRaw < 1000 || timeoutRaw > 120000) {
    throw new ZcodeNativeError("ZCODE_NATIVE_CONFIG", "ZCODE_NATIVE_TIMEOUT_MS must be 1000..120000");
  }
  return { url, token, requestTimeoutMs: timeoutRaw };
}

export interface ZcodeNativeTaskView {
  /**
   * Exact-session entitlement evidence. `observed` is filled ONLY from the
   * runtime's registry-backed readback relayed by Z2C; null/`unavailable`
   * means the entitlement is not proven for that session.
   */
  entitlement?: EntitlementAttestation;
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
  model_binding?: { provider_id: string; model_id: string; thought_level?: string | null; source?: string } | null;
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
  /** Entitlement selection capability as observed from the runtime; null = unsupported. */
  entitlement_capability?: EntitlementSelectionSupport | null;
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
  entitlement_capability?: unknown;
}

export interface SubmitNativeInput {
  entitlement_plan?: EntitlementPlan;
  idempotency_key?: string;
  workspace_id: string;
  instruction: string;
  write_scope?: "workspace" | "readonly";
  mode?: "plan" | "build" | "edit";
  /** Explicit native model request; validated against the live per-session catalog upstream (fail closed). */
  model_id?: string;
  /** Explicit native reasoning/effort request for the TARGET model (fail closed when unsupported). */
  thought_level?: string;
}

export interface ResumeNativeInput {
  entitlement_plan?: EntitlementPlan;
  expected_workspace_path?: string;
  workspace_id: string;
  session_id: string;
  instruction: string;
  idempotency_key?: string;
}

const SESSION_ID_RE = /^sess_[0-9a-f-]{36}$/i;

/** Platform-consistent root equality for the projection/attestation checks. */
function sameWorkspaceRoot(left: string, right: string): boolean {
  const normalize = (p: string) =>
    process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
  try {
    return normalize(canonicalizeWorkspaceRoot(left)) === normalize(canonicalizeWorkspaceRoot(right));
  } catch {
    return false;
  }
}
export const ZCODE_IDEMPOTENCY_PROTOCOL = "workspace-task-v1";
export const ZCODE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?![\s\S])/;
export function nativeRequestFingerprint(input: SubmitNativeInput): string {
  return createHash("sha256").update(JSON.stringify({ workspace_id: input.workspace_id, instruction: input.instruction,
    write_scope: input.write_scope ?? "workspace", network: "default", mode: input.mode ?? "build",
    resume_session_id: null, model_id: input.model_id ?? null, thought_level: input.thought_level ?? null, ...entitlementFingerprintFields(input.entitlement_plan) })).digest("hex");
}
export function nativeResumeFingerprint(input: ResumeNativeInput): string {
  return createHash("sha256").update(JSON.stringify({ workspace_id: input.workspace_id, instruction: input.instruction,
    write_scope: "workspace", network: "default", mode: "build",
    resume_session_id: input.session_id, model_id: null, thought_level: null, ...entitlementFingerprintFields(input.entitlement_plan) })).digest("hex");
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

export interface ZcodeNativeClientOptions {
  /**
   * Resolve the registered canonical root of an authorized A2C workspace id.
   * Production default: the bridge-owned A2C workspace registry. Tests and
   * embedded callers may bind a fixed authoritative resolver instead.
   */
  resolveWorkspaceRoot?: (workspaceId: string) => string | Promise<string>;
}

/**
 * Production root resolver: the A2C workspace registry is authoritative for
 * the public id → canonical root binding. Cached per client after first
 * resolution; unknown or disabled workspaces fail closed.
 */
function defaultWorkspaceRootResolver(): (workspaceId: string) => string {
  const cache = new Map<string, string>();
  return (workspaceId) => {
    const cached = cache.get(workspaceId);
    if (cached !== undefined) return cached;
    try {
      const entry = new WorkspaceRegistry({ stateDir: getStateDir() }).get(workspaceId);
      if (!entry.enabled) {
        throw new WorkspaceRegistryError("WORKSPACE_NOT_AUTHORIZED", `workspace ${workspaceId} is disabled`);
      }
      cache.set(workspaceId, entry.canonicalPath);
      return entry.canonicalPath;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ZcodeNativeError(
        "ZCODE_NATIVE_WORKSPACE_FORBIDDEN",
        `workspace ${workspaceId} is not a registered A2C workspace (${message})`,
      );
    }
  };
}

/** Map a semantic-lane error onto the native error taxonomy. */
function toNativeError(err: ZcodeSessionError): ZcodeNativeError {
  const code = ({
    ZCODE_SESSION_CONFIG: "ZCODE_NATIVE_CONFIG",
    ZCODE_SESSION_UNCONFIGURED: "ZCODE_NATIVE_UNCONFIGURED",
    ZCODE_SESSION_UNAVAILABLE: "ZCODE_NATIVE_UNAVAILABLE",
    ZCODE_SESSION_OUTCOME_UNKNOWN: "ZCODE_NATIVE_OUTCOME_UNKNOWN",
    ZCODE_SESSION_UNAUTHORIZED: "ZCODE_NATIVE_UNAUTHORIZED",
    ZCODE_SESSION_TIMEOUT: "ZCODE_NATIVE_TIMEOUT",
    ZCODE_SESSION_SERVICE_MISMATCH: "ZCODE_NATIVE_SERVICE_MISMATCH",
    ZCODE_SESSION_WORKSPACE_FORBIDDEN: "ZCODE_NATIVE_WORKSPACE_FORBIDDEN",
    ZCODE_SESSION_UPSTREAM: "ZCODE_NATIVE_UPSTREAM",
  } as const)[err.code];
  return new ZcodeNativeError(code, err.message, err.upstreamCode);
}

/** Namespace check against the projection, surfaced in the native taxonomy. */
function assertNativeNamespace(
  projection: { nativeWorkspaceId: string },
  returnedWorkspaceId: unknown,
  context: string,
): void {
  try {
    assertProjectedNamespace({ nativeWorkspaceId: projection.nativeWorkspaceId, returnedWorkspaceId, context });
  } catch (err) {
    if (err instanceof ZcodeWorkspaceProjectionError) {
      throw new ZcodeNativeError("ZCODE_NATIVE_NAMESPACE_MISMATCH", err.message);
    }
    throw err;
  }
}

export class ZcodeNativeClient {
  private readonly transport: ZcodeSessionClient;
  private readonly resolveWorkspaceRoot: (workspaceId: string) => string | Promise<string>;
  private readonly rootCache = new Map<string, string>();
  private readonly projectionCache = new Map<string, { projection: { nativeWorkspaceId: string; canonicalPath: string }; at: number; write: boolean }>();
  private readonly projectionCacheTtlMs = 30_000;

  /** Drop the cached projection (e.g. after an upstream authorization drift). */
  invalidateWorkspaceProjection(workspaceId?: string): void {
    if (workspaceId === undefined) this.projectionCache.clear();
    else this.projectionCache.delete(workspaceId);
  }

  constructor(private readonly config: ZcodeNativeConfig, options: ZcodeNativeClientOptions = {}) {
    assertLoopbackHttpUrl(config.url);
    if (typeof config.token !== "string" || config.token.length < 8) {
      throw new ZcodeNativeError("ZCODE_NATIVE_UNCONFIGURED", "Z2C bearer token missing or too short");
    }
    this.transport = new ZcodeSessionClient({
      url: config.url,
      apiBase: new URL(config.url).origin,
      token: config.token,
      requestTimeoutMs: config.requestTimeoutMs,
    });
    this.resolveWorkspaceRoot = options.resolveWorkspaceRoot ?? defaultWorkspaceRootResolver();
  }

  /**
   * A2C → native workspace projection for this client's upstream: the
   * authorized A2C id plus its registered canonical root, resolved through
   * the semantic lane's authoritative grant registry. Fail-closed: an A2C id
   * that is not allowlisted, not registered, or not mapped upstream never
   * reaches any native tool.
   */
  async projectWorkspace(workspaceId: string, write = false): Promise<{ nativeWorkspaceId: string; canonicalPath: string }> {
    this.assertWorkspaceAllowed(workspaceId);
    // Bounded projection cache: the grant registry is authoritative but stable
    // within the TTL; every native call would otherwise pay a workspace_list
    // round-trip and restart-recovery retries would depend on the grant
    // surface during exactly the window they must survive.
    const cached = this.projectionCache.get(workspaceId);
    if (cached && (!write || cached.write) && Date.now() - cached.at < this.projectionCacheTtlMs) return cached.projection;
    let canonicalPath = this.rootCache.get(workspaceId);
    if (canonicalPath === undefined) {
      try {
        canonicalPath = await this.resolveWorkspaceRoot(workspaceId);
      } catch (err) {
        throw new ZcodeNativeError(
          "ZCODE_NATIVE_WORKSPACE_FORBIDDEN",
          `native workspace projection unavailable for ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (typeof canonicalPath !== "string" || !canonicalPath) {
        throw new ZcodeNativeError(
          "ZCODE_NATIVE_WORKSPACE_FORBIDDEN",
          `native workspace projection unavailable for ${workspaceId}: no registered canonical root`,
        );
      }
      this.rootCache.set(workspaceId, canonicalPath);
    }
    try {
      const projection = await projectNativeWorkspace(this.transport, { workspaceId, canonicalPath, write });
      this.projectionCache.set(workspaceId, { projection, at: Date.now(), write });
      return projection;
    } catch (err) {
      if (err instanceof ZcodeSessionError) throw toNativeError(err);
      if (err instanceof ZcodeWorkspaceProjectionError) {
        throw new ZcodeNativeError(
          err.code === "ZCODE_WORKSPACE_PROJECTION_MISMATCH" ? "ZCODE_NATIVE_NAMESPACE_MISMATCH" : "ZCODE_NATIVE_WORKSPACE_FORBIDDEN",
          err.message,
        );
      }
      throw err;
    }
  }

  /**
   * Forward one tool call to Z2C. The bearer token is scrubbed from the
   * payload before parsing so it can never leak into released results or
   * errors.
   *
   * Shares the semantic client's single-flight, generation-fenced transport.
   * Only declared reads can reconnect once. Mutations are never replayed
   * after dispatch, including when their response is lost.
   */
  async callTool(name: string, args: Record<string, unknown>, beforeDispatch?: () => void): Promise<unknown> {
    try {
      return await this.transport.callTool(name, args, undefined, beforeDispatch);
    } catch (err) {
      if (!(err instanceof ZcodeSessionError)) throw err;
      throw toNativeError(err);
    }
  }

  /**
   * Workspace-scoped provider status: the binding reported by Z2C is resolved
   * for exactly this workspace's registered context — never another's. The
   * authorized A2C id is projected upstream; the returned binding namespace
   * is validated against that projection before release.
   */
  async providerStatus(workspaceId: string): Promise<ProviderStatusBody> {
    const projection = await this.projectWorkspace(workspaceId);
    const body = (await this.callTool("provider_status", { workspace_id: projection.nativeWorkspaceId })) as ProviderStatusBody;
    assertNativeNamespace(projection, body?.workspace_id, "provider_status");
    return body;
  }

  async status(workspaceId: string): Promise<ZcodeNativeStatus> {
    const generated_at = new Date().toISOString();
    let body: ProviderStatusBody;
    try {
      body = await this.providerStatus(workspaceId);
    } catch (err) {
      const code = err instanceof ZcodeNativeError ? err.code : "ZCODE_NATIVE_UNAVAILABLE";
      // Only genuine unavailability degrades to the informational
      // available:false shape. Authorization/projection failures
      // (unregistered workspace, unmapped grant) are HARD failures and are
      // rethrown — never dressed up as "control plane unavailable".
      const degradable: ReadonlySet<string> = new Set([
        "ZCODE_NATIVE_UNAVAILABLE", "ZCODE_NATIVE_TIMEOUT", "ZCODE_NATIVE_UNCONFIGURED", "ZCODE_NATIVE_CONFIG",
        "ZCODE_NATIVE_SERVICE_MISMATCH", "ZCODE_NATIVE_NAMESPACE_MISMATCH",
      ]);
      if (err instanceof ZcodeNativeError && !degradable.has(code)) throw err;
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
    const desktop_managed_auth = isAdmissibleZcodeProvider(providerName);
    // Entitlement capability: relayed verbatim from the runtime's own
    // advertisement; null/absent means non-DEFAULT plans must fail closed.
    const rawCapability = (body as { entitlement_capability?: unknown }).entitlement_capability;
    const entitlement_capability: EntitlementSelectionSupport | null =
      rawCapability === true
        ? { entitlementSelection: true }
        : rawCapability && typeof rawCapability === "object" &&
            (rawCapability as { entitlementSelection?: unknown }).entitlementSelection === true
          ? { entitlementSelection: true }
          : null;

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
    if (observedProvider !== null && !ZCODE_NATIVE_ADMISSIBLE_PROVIDER_IDS.has(observedProvider)) {
      mismatches.push(`provider_id=${observedProvider}`);
    }
    // Model check: no longer restricted to a single model; any model on an
    // admissible provider is accepted. Model mismatch is only reported for
    // monitoring, not for admission gating.
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
      entitlement_capability,
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
    // Capability gate: non-DEFAULT plans are admitted only when the runtime's
    // own advertisement (relayed by Z2C) proves entitlement selection support.
    await this.requireRuntimeEntitlementSupport(input.entitlement_plan, input.workspace_id);
    if (input.idempotency_key !== undefined) {
      if (typeof input.idempotency_key !== "string" || !ZCODE_IDEMPOTENCY_KEY.test(input.idempotency_key)) {
        throw new ZcodeNativeError("ZCODE_NATIVE_INSTRUCTION_REJECTED", "idempotency_key must be 1..128 safe ASCII characters, starting alphanumeric");
      }
    }
    // Project the authorized A2C workspace onto its native grant id before
    // any upstream interaction; the upstream payload and the durable
    // idempotency fingerprint are both computed over the projected payload
    // (this is what Z2C hashes at admission).
    const projection = await this.projectWorkspace(input.workspace_id, input.write_scope !== "readonly");
    const nativeInput: SubmitNativeInput = { ...input, workspace_id: projection.nativeWorkspaceId };
    if (input.idempotency_key !== undefined) {
      // Older MCP builds may silently strip unknown arguments. Prove support
      // before submission, then independently validate the returned key proof.
      const protocol = await this.providerStatus(input.workspace_id);
      if (protocol?.workspace_id !== projection.nativeWorkspaceId || protocol.durable_idempotency !== ZCODE_IDEMPOTENCY_PROTOCOL) {
        throw new ZcodeNativeError("ZCODE_NATIVE_UPSTREAM", "Z2C upgrade required: durable idempotency protocol unavailable", "IDEMPOTENCY_UPGRADE_REQUIRED");
      }
    }
    const raw = await this.callTool("submit_zcode_task", {
      workspace_id: nativeInput.workspace_id,
      instruction: nativeInput.instruction,
      ...(nativeInput.entitlement_plan !== undefined ? { entitlement_plan: nativeInput.entitlement_plan } : {}),
      ...(nativeInput.write_scope ? { write_scope: nativeInput.write_scope } : {}),
      ...(nativeInput.mode ? { mode: nativeInput.mode } : {}),
      ...(nativeInput.model_id ? { model_id: nativeInput.model_id } : {}),
      ...(nativeInput.thought_level ? { thought_level: nativeInput.thought_level } : {}),
      ...(nativeInput.idempotency_key !== undefined ? { idempotency_key: nativeInput.idempotency_key } : {}),
    }, beforeDispatch);
    // Namespace: the created task must belong to the projected native
    // workspace of the authorized A2C workspace and carry a mapped native
    // session id. Execution identity comes from the task/session binding Z2C
    // observed at admission (exact session/read) — never from a pre-submit
    // idle status probe. An explicitly requested model/effort must match the
    // observation EXACTLY: no silent substitution.
    const view = projectTaskView(raw, {
      workspace_id: projection.nativeWorkspaceId,
      require_session_id: true,
    });
    assertTaskBinding(view, nativeInput.entitlement_plan);
    if (nativeInput.model_id && view.model_binding?.model_id !== nativeInput.model_id) {
      throw new ZcodeNativeError(
        "ZCODE_NATIVE_NOT_ATTESTED",
        `requested model ${nativeInput.model_id} was not observed on the admitted task (observed ${view.model_binding?.model_id ?? "unknown"})`,
      );
    }
    if (nativeInput.thought_level && (view.model_binding as { thought_level?: string | null } | undefined)?.thought_level !== nativeInput.thought_level) {
      throw new ZcodeNativeError(
        "ZCODE_NATIVE_NOT_ATTESTED",
        `requested thought level ${nativeInput.thought_level} was not observed on the admitted task`,
      );
    }
    if (nativeInput.idempotency_key !== undefined) assertNativeIdempotency(view, nativeInput);
    // Release with the authorized A2C workspace id restored: callers (tools,
    // writer slots, orchestrator, coordinator) only ever see the public
    // namespace; the native binding was proven above.
    return { ...view, workspace_id: input.workspace_id };
  }

  async getTask(input: { workspace_id: string; task_id: string }): Promise<ZcodeNativeTaskView> {
    this.assertWorkspaceAllowed(input.workspace_id);
    const projection = await this.projectWorkspace(input.workspace_id);
    const raw = await this.callTool("get_zcode_task", { workspace_id: projection.nativeWorkspaceId, task_id: input.task_id });
    return this.releaseTaskView(raw, projection, input.workspace_id, { task_id: input.task_id });
  }

  /**
   * Read-only durable-idempotency resolution on the Z2C store. Returns the
   * task admitted under the key, or null when the key was never bound — the
   * definitive upstream outcome for a lost submit response. Never submits.
   * `expectedFingerprint` is the fingerprint over the projected native
   * payload (the same payload Z2C hashed at admission).
   */
  async resolveKeyedTask(input: { workspace_id: string; idempotency_key: string }, expectedFingerprint?: string): Promise<ZcodeNativeTaskView | null> {
    this.assertWorkspaceAllowed(input.workspace_id);
    if (!ZCODE_IDEMPOTENCY_KEY.test(input.idempotency_key)) {
      throw new ZcodeNativeError("ZCODE_NATIVE_INSTRUCTION_REJECTED", "Invalid idempotency key");
    }
    const projection = await this.projectWorkspace(input.workspace_id);
    const raw = (await this.callTool("resolve_zcode_task_by_key", {
      workspace_id: projection.nativeWorkspaceId,
      idempotency_key: input.idempotency_key,
    })) as Record<string, unknown>;
    if (raw.workspace_id !== projection.nativeWorkspaceId || raw.idempotency_key !== input.idempotency_key) {
      throw new ZcodeNativeError("ZCODE_NATIVE_NAMESPACE_MISMATCH", "Keyed resolution namespace mismatch");
    }
    if (raw.key_state === "unbound" && raw.task == null) return null;
    const view = projectTaskView(raw.task, { workspace_id: projection.nativeWorkspaceId });
    const proof = view.idempotency;
    if (!proof || proof.key !== input.idempotency_key ||
        (expectedFingerprint !== undefined && proof.request_fingerprint !== expectedFingerprint)) {
      throw new ZcodeNativeError("ZCODE_NATIVE_UPSTREAM", "Keyed resolution returned an unproven task binding", "IDEMPOTENCY_INVALID");
    }
    return { ...view, workspace_id: input.workspace_id };
  }

  /**
   * Authoritative writer-slot reconciliation evidence: the provider's health
   * and the workspace queue state (active + queued). An empty queue from a
   * healthy provider proves no orphan native work is executing.
   */
  async taskLaneStatus(workspaceId: string): Promise<{ provider_healthy: boolean; provider_status: string; active_task: string | null; queued_task_count: number; paused: boolean }> {
    const body = await this.providerStatus(workspaceId);
    const queue = (body as { queue?: { paused?: unknown; active_task?: unknown; queued_task_count?: unknown } }).queue;
    const providerName = typeof body.provider === "string" ? body.provider : "";
    const providerStatus = typeof body.status === "string" ? body.status : "";
    return {
      provider_healthy: isAdmissibleZcodeProvider(providerName) && providerStatus === "healthy",
      provider_status: providerStatus,
      active_task: typeof queue?.active_task === "string" ? queue.active_task : null,
      queued_task_count: typeof queue?.queued_task_count === "number" ? queue.queued_task_count : Number.NaN,
      paused: queue?.paused === true,
    };
  }

  /** Verify the authorized workspace/task before forwarding cancellation. */
  async cancelTask(input: { workspace_id: string; task_id: string }): Promise<ZcodeNativeTaskView> {
    const task = await this.getTask(input);
    const projection = await this.projectWorkspace(input.workspace_id);
    const raw = await this.callTool("cancel_zcode_task", { workspace_id: projection.nativeWorkspaceId, task_id: input.task_id });
    return this.releaseTaskView(raw, projection, input.workspace_id, { task_id: input.task_id, ...(task.session_id ? { session_id: task.session_id } : {}) });
  }

  async readSession(input: { workspace_id: string; session_id: string; expected_workspace_path?: string }) {
    this.assertWorkspaceAllowed(input.workspace_id);
    if (!SESSION_ID_RE.test(input.session_id)) throw new ZcodeNativeError("ZCODE_NATIVE_INSTRUCTION_REJECTED", "Invalid native session id");
    const projection = await this.projectWorkspace(input.workspace_id);
    // The caller-attested authorized root and the projected registry root
    // must agree before any upstream interaction (fail closed).
    if (input.expected_workspace_path && !sameWorkspaceRoot(input.expected_workspace_path, projection.canonicalPath)) {
      throw new ZcodeNativeError("ZCODE_NATIVE_NAMESPACE_MISMATCH", "Native workspace projection differs from the attested C2C registry root");
    }
    const raw = (await this.callTool("zcode_session_observe", {
      workspace_id: projection.nativeWorkspaceId,
      session_id: input.session_id,
    })) as Record<string, unknown>;
    if (raw.workspace_id !== projection.nativeWorkspaceId || raw.session_id !== input.session_id) {
      throw new ZcodeNativeError("ZCODE_NATIVE_NAMESPACE_MISMATCH", "Exact session namespace mismatch");
    }
    // Observation is deliberately available for foreign/manual sessions.
    // The separate discovery record carries Z2C ownership; absence or a
    // mismatched owner can never be repaired by a workspace grant fallback.
    const discovered = (await this.callTool("zcode_session_discover", { workspace_id: projection.nativeWorkspaceId })) as {
      sessions?: Array<{ session_id?: unknown; workspace_id?: unknown; workspace_path?: unknown; controlled_by_z2c?: unknown; owner_client_id?: unknown; runtime_origin?: unknown }>;
    };
    const match = discovered?.sessions?.find((s) => s?.session_id === input.session_id && s?.workspace_id === projection.nativeWorkspaceId);
    if (!match || match.controlled_by_z2c !== true || match.runtime_origin !== "z2c" || match.owner_client_id !== "local") {
      throw new ZcodeNativeError("ZCODE_NATIVE_NOT_ATTESTED", "Exact session is not locally owned by Z2C");
    }
    const canonicalPath = match.workspace_path;
    if (typeof canonicalPath !== "string") {
      throw new ZcodeNativeError("ZCODE_NATIVE_NAMESPACE_MISMATCH", "Exact session workspace path is unavailable");
    }
    // Canonical-path attestation: the session's binding root must OVERLAP the
    // authorized A2C root — equal, inside it, or (Z1 full-access lanes) the
    // authorized root itself living inside the session's approved parent
    // binding. Disjoint paths never attest (fail closed). This mirrors the
    // semantic lane's own workspace matching, so both lanes attest a session
    // identically regardless of which lane created it.
    if (input.expected_workspace_path) {
      const normalize = (p: string) => process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
      const observed = normalize(canonicalizeWorkspaceRoot(canonicalPath));
      const authorized = normalize(canonicalizeWorkspaceRoot(input.expected_workspace_path));
      const overlaps = observed === authorized
        || observed.startsWith(authorized + "\\") || observed.startsWith(authorized + "/")
        || authorized.startsWith(observed + "\\") || authorized.startsWith(observed + "/");
      if (!overlaps) {
        throw new ZcodeNativeError("ZCODE_NATIVE_NAMESPACE_MISMATCH", "Native workspace path differs from C2C registry");
      }
    }
    const binding = projectBinding(raw.model_binding) ?? (
      typeof raw.provider_id === "string" && typeof raw.model_id === "string"
        ? {
            provider_id: raw.provider_id,
            model_id: raw.model_id,
            ...(typeof raw.binding_source === "string" ? { source: raw.binding_source } : {}),
          }
        : null
    );
    if (!binding) {
      // Real reason: the authoritative observation carried NO binding. This is
      // a historical-evidence gap (unobserved model binding), not a route or
      // ownership verdict — the session may be closed or its record incomplete.
      throw new ZcodeNativeError(
        "ZCODE_NATIVE_NOT_ATTESTED",
        "Exact native session binding is unobserved: the authoritative session read returned no provider/model evidence (the session may be closed or its binding record incomplete)",
      );
    }
    if (!ZCODE_NATIVE_ADMISSIBLE_PROVIDER_IDS.has(binding.provider_id)) {
      // Real reason: a binding EXISTS but its route is not one Z2C can admit
      // (e.g. team/off-peak account routes). The session itself may be alive;
      // reporting "binding unavailable" here would misrepresent the state.
      throw new ZcodeNativeError(
        "ZCODE_NATIVE_NOT_ATTESTED",
        `Exact native session binding observed on a non-admissible route: ${binding.provider_id}/${binding.model_id} ` +
          `(admissible: ${[...ZCODE_NATIVE_ADMISSIBLE_PROVIDER_IDS].join(", ")})`,
      );
    }
    return { workspace_id: input.workspace_id, session_id: input.session_id, canonical_path: canonicalPath, model_binding: binding };
  }

  /**
   * Exact-session runtime status observation for timeout recovery.
   *
   * A task snapshot freezes once the provider waiter times out, so the only
   * reliable release evidence is the runtime's own per-session status. z2c's
   * `zcode_session_discover` relays that status (its observe sanitizer drops
   * it), so this probe goes through discovery and reports the entry for the
   * EXACT session, attested as locally owned by Z2C. Absence from discovery,
   * a mismatched namespace, a foreign owner, or any transport failure throws
   * — an unknown state can never be reported as idle (fail closed).
   */
  async sessionRuntimeStatus(input: { workspace_id: string; session_id: string }): Promise<{
    session_id: string;
    workspace_id: string;
    runtime_status: string | null;
    locally_owned: boolean;
  }> {
    this.assertWorkspaceAllowed(input.workspace_id);
    if (!SESSION_ID_RE.test(input.session_id)) throw new ZcodeNativeError("ZCODE_NATIVE_INSTRUCTION_REJECTED", "Invalid native session id");
    const projection = await this.projectWorkspace(input.workspace_id);
    const discovered = (await this.callTool("zcode_session_discover", { workspace_id: projection.nativeWorkspaceId })) as {
      sessions?: Array<{ session_id?: unknown; workspace_id?: unknown; controlled_by_z2c?: unknown; runtime_origin?: unknown; owner_client_id?: unknown; status?: unknown }>;
    };
    const match = discovered?.sessions?.find((s) => s?.session_id === input.session_id && s?.workspace_id === projection.nativeWorkspaceId);
    if (!match) {
      throw new ZcodeNativeError("ZCODE_NATIVE_UPSTREAM", "session not present in native discovery");
    }
    if (match.controlled_by_z2c !== true || match.runtime_origin !== "z2c" || match.owner_client_id !== "local") {
      throw new ZcodeNativeError("ZCODE_NATIVE_NOT_ATTESTED", "Exact session is not locally owned by Z2C");
    }
    return {
      session_id: input.session_id,
      workspace_id: input.workspace_id,
      runtime_status: typeof match.status === "string" && match.status !== "" ? match.status : null,
      locally_owned: true,
    };
  }

  async resumeSession(input: ResumeNativeInput, beforeDispatch?: () => void): Promise<ZcodeNativeTaskView> {
    this.assertWorkspaceAllowed(input.workspace_id);
    this.assertInstruction(input.instruction);
    await this.requireRuntimeEntitlementSupport(input.entitlement_plan, input.workspace_id);
    if (!SESSION_ID_RE.test(input.session_id)) {
      throw new ZcodeNativeError("ZCODE_NATIVE_INSTRUCTION_REJECTED", "session_id must match sess_<uuid>");
    }
    await this.readSession(input);
    const projection = await this.projectWorkspace(input.workspace_id, true);
    // The resumed-task fingerprint is computed over the projected native
    // payload — the same payload Z2C hashed when the resume was admitted.
    const nativeInput: ResumeNativeInput = { ...input, workspace_id: projection.nativeWorkspaceId };
    const raw = await this.callTool("resume_zcode_session", {
      workspace_id: nativeInput.workspace_id,
      session_id: nativeInput.session_id,
      instruction: nativeInput.instruction,
      ...(nativeInput.entitlement_plan !== undefined ? { entitlement_plan: nativeInput.entitlement_plan } : {}),
      ...(nativeInput.idempotency_key !== undefined ? { idempotency_key: nativeInput.idempotency_key } : {}),
    }, beforeDispatch);
    // The resumed task must stay bound to the mapped native session; its
    // execution identity is the binding Z2C observed for that exact session.
    const view = this.releaseTaskView(raw, projection, input.workspace_id, {
      session_id: input.session_id,
    });
    assertTaskBinding(view, input.entitlement_plan);
    if (input.idempotency_key !== undefined) {
      const proof = view.idempotency;
      if (!proof || proof.key !== input.idempotency_key || proof.request_fingerprint !== nativeResumeFingerprint(nativeInput)) {
        throw new ZcodeNativeError("ZCODE_NATIVE_UPSTREAM", "Resume idempotency proof invalid or missing", "IDEMPOTENCY_INVALID");
      }
    }
    return view;
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
    const projection = await this.projectWorkspace(input.workspace_id);
    const raw = (await this.callTool("execution_output", {
      workspace_id: projection.nativeWorkspaceId,
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
    this.transport.close();
  }

  // ── governance gates ───────────────────────────────────────────────────────

  /**
   * Runtime capability gate for non-DEFAULT entitlement requests, resolved
   * from the control plane's OWN advertisement at submission time. Anything
   * other than an explicit `entitlementSelection: true` (old runtime, absent
   * field, control plane unreachable) throws ENTITLEMENT_UNAVAILABLE — the
   * pre-capability fail-closed behavior, now backed by evidence instead of a
   * blanket version gate.
   */
  private async requireRuntimeEntitlementSupport(
    plan: EntitlementPlan | undefined,
    workspaceId: string,
  ): Promise<void> {
    if (plan === undefined || plan === "DEFAULT") return;
    const body = await this.providerStatus(workspaceId);
    const raw = (body as { entitlement_capability?: unknown }).entitlement_capability;
    const supported =
      raw === true ||
      (raw as { entitlementSelection?: unknown } | null)?.entitlementSelection === true;
    requireSupportedEntitlement(plan, supported ? { entitlementSelection: true } : null);
  }

  /**
   * Validate an upstream task view against the native projection (wire
   * namespace) and release it with the authorized A2C workspace id restored.
   */
  private releaseTaskView(
    raw: unknown,
    projection: { nativeWorkspaceId: string },
    a2cWorkspaceId: string,
    expected: { task_id?: string; session_id?: string; require_session_id?: boolean } = {},
  ): ZcodeNativeTaskView {
    const view = projectTaskView(raw, { workspace_id: projection.nativeWorkspaceId, ...expected });
    return { ...view, workspace_id: a2cWorkspaceId };
  }

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

}

/**
 * Execution identity of an accepted task comes from the binding Z2C observed
 * for that exact session at admission (one observation source: Z2C's native
 * session/read). A returned task without an admissible observed identity is
 * discarded before the task/session identity is bound anywhere.
 */
/**
 * Versioned provider compatibility manifest (Phase: dynamic routing).
 * Any model on an admissible coding-plan provider is accepted. The
 * `retired` list preserves backward-compat error codes for known-bad
 * identities. The retired start-plan route stays revoked EXCEPT for sessions
 * whose exact-session registry readback attests START (the 2026-09-29
 * entitlement attestation path) — the proof is the runtime's own
 * access-mode fact, never the provider id spelling.
 */
const ZCODE_NATIVE_COMPATIBILITY_MANIFEST = {
  preferred: { ...ZCODE_NATIVE_PREFERRED_IDENTITY },
  /** Provider ids whose observed bindings are admissible for governed execution. */
  admissibleProviderIds: ZCODE_NATIVE_ADMISSIBLE_PROVIDER_IDS,
  retired: [
    // Start-plan route: revoked by the 2026-09-16 entitlement change;
    // re-admitted only under an exact-session attested START entitlement.
    { provider_id: "builtin:zai-start-plan", model_id: "GLM-5.3-Flash" },
    { provider_id: "builtin:zai-start-plan", model_id: "GLM-5.3" },
  ] as ReadonlyArray<{ provider_id: string; model_id: string }>,
} as const;

function isRetiredIdentity(providerId: string, modelId: string): boolean {
  return ZCODE_NATIVE_COMPATIBILITY_MANIFEST.retired.some(
    (entry) => entry.provider_id === providerId && entry.model_id === modelId,
  );
}

/**
 * Dynamic task binding assertion. Two independent fail-closed gates:
 *  - Route admission: the observed provider_id must be in the admissible set,
 *    EXCEPT that an exactly attested START session may still use the retired
 *    start-plan route (the binding source must not be a legacy desktop read).
 *    The model_id is NOT restricted — any model the runtime advertises on an
 *    admissible provider is accepted. Unobserved/missing bindings fail closed.
 *  - Exact-plan attestation (2026-09-29): a requested START or INDIVIDUAL
 *    plan must be attested by the exact session's own registry readback
 *    (isAttestedEntitlement). Provider admissibility proves the ROUTE, never
 *    the billing plan, so an admissible route with unproven or mismatched
 *    evidence is a silent cross-plan fallback and fails closed regardless of
 *    provider. DEFAULT keeps historical route-only admission unchanged.
 */
function assertTaskBinding(view: ZcodeNativeTaskView, requestedPlan?: EntitlementPlan): ZcodeNativeTaskView {
  const binding = view.model_binding;
  const attestedStart =
    requestedPlan === "START" &&
    isAttestedEntitlement(view.entitlement, "START") &&
    binding?.source !== "desktop-session-read";
  const providerAdmissible =
    !!binding && ZCODE_NATIVE_ADMISSIBLE_PROVIDER_IDS.has(binding.provider_id);
  if (
    !binding ||
    (!providerAdmissible && !attestedStart)
  ) {
    const observed = binding ? `${binding.provider_id}/${binding.model_id}` : "unknown";
    const detail =
      `task ${view.task_id} carries unverified execution binding (observed ` +
      `${observed}; admissible providers: ${[...ZCODE_NATIVE_ADMISSIBLE_PROVIDER_IDS].join(", ")}${attestedStart ? " or any route under an attested START entitlement" : ""})`;
    if (
      binding &&
      isRetiredIdentity(binding.provider_id, binding.model_id) &&
      !attestedStart
    ) {
      throw new ZcodeNativeError(
        "ZCODE_INCOMPATIBLE_PROVIDER_VERSION",
        `${detail}; the observed identity is retired by the C2C provider compatibility manifest`,
      );
    }
    throw new ZcodeNativeError("ZCODE_NATIVE_NOT_ATTESTED", detail);
  }
  const attestedRequestedPlan =
    requestedPlan === "START" || requestedPlan === "INDIVIDUAL"
      ? isAttestedEntitlement(view.entitlement, requestedPlan)
      : true;
  if (!attestedRequestedPlan) {
    const evidence = view.entitlement
      ? `${view.entitlement.observed ?? "unproven"} (source: ${view.entitlement.source})`
      : "no entitlement evidence";
    throw new ZcodeNativeError(
      "ZCODE_NATIVE_NOT_ATTESTED",
      `task ${view.task_id} requested the ${requestedPlan} plan but the exact-session entitlement ` +
        `readback does not attest it (observed ${evidence}); cross-plan fallback is rejected regardless of provider route`,
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
    entitlement: projectEntitlement(v.entitlement),
    ...(v.idempotency && typeof v.idempotency === "object" ? { idempotency: {
      protocol: (v.idempotency as ZcodeNativeTaskView["idempotency"])!.protocol,
      key: (v.idempotency as ZcodeNativeTaskView["idempotency"])!.key,
      request_fingerprint: (v.idempotency as ZcodeNativeTaskView["idempotency"])!.request_fingerprint,
      replayed: (v.idempotency as ZcodeNativeTaskView["idempotency"])!.replayed,
    } } : {}),
  };
}

/** Project the observed session binding exactly as Z2C reported it, or null. */
function projectBinding(raw: unknown): { provider_id: string; model_id: string; thought_level?: string | null; source?: string } | null {
  const b = (raw ?? null) as Record<string, unknown> | null;
  if (!b || typeof b.provider_id !== "string" || typeof b.model_id !== "string") return null;
  return {
    provider_id: b.provider_id,
    model_id: b.model_id,
    ...(typeof b.thought_level === "string" ? { thought_level: b.thought_level } : {}),
    ...(typeof b.source === "string" ? { source: b.source } : {}),
  };
}

/**
 * Project the exact-session entitlement evidence relayed by Z2C. Unknown plan
 * spellings and non-string sources collapse to the unproven shape — evidence
 * is never invented here.
 */
function projectEntitlement(raw: unknown): EntitlementAttestation {
  const e = (raw ?? {}) as Record<string, unknown>;
  const plan = (value: unknown): EntitlementPlan | null =>
    value === "DEFAULT" || value === "START" || value === "INDIVIDUAL" ? value : null;
  return {
    requested: plan(e.requested),
    observed: plan(e.observed),
    access_mode: typeof e.access_mode === "string" ? e.access_mode : null,
    source: typeof e.source === "string" ? e.source : "unavailable",
  };
}
