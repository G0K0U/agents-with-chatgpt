import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { TaskEngine } from "../core/tasks/engine.js";
import type { AgentProvider } from "../providers/types.js";
import type { AuditSink } from "../util/log.js";
import { Z2C_PROTOCOL_VERSION } from "../version.js";
import { serviceCause } from "./errors.js";
import { randomUUID as newGeneration } from "node:crypto";
import { IDEMPOTENCY_KEY, IDEMPOTENCY_PROTOCOL } from "../core/tasks/idempotency.js";
import type { SessionService, SessionServiceError } from "./sessions.js";
import { classifyObservationError } from "./observation-errors.js";
import type { ServiceSecurity } from "./security.js";
import { LOCAL_PRINCIPAL, type PairingManager, type Principal } from "../authz/pairing.js";
import type { WorkspaceGrants } from "../authz/grants.js";
import type { SessionOwnership } from "../authz/ownership.js";

/**
 * The Z2C local service: ONE loopback HTTP server with three surfaces,
 * all passing through the same authorization layer:
 *
 *   GET  /health   — unauthenticated liveness (no data beyond uptime/protocol)
 *   POST /mcp      — MCP: service secret (local principal) or paired-client token
 *   /api/*         — local management (service secret ONLY): pairing, grants,
 *                    sessions, status, shutdown
 *
 * No transport bypasses authorization; a future remote relay reuses the exact
 * same SessionService/principal layer (docs/z2c-remote-pairing-design.md).
 */

export interface Z2cServiceDeps {
  cfg: { port: number; host: string };
  provider: AgentProvider;
  engine: TaskEngine;
  sessions: SessionService;
  security: ServiceSecurity;
  pairing: PairingManager;
  grants: WorkspaceGrants;
  ownership: SessionOwnership;
  audit: AuditSink;
  /**
   * Cold-start linkage: register an engine workspace from the authoritative
   * grant registry on miss (legacy task lane forwards projected native ids).
   * Must throw when no active grant exists (fail closed).
   */
  ensureWorkspaceRegistered?: (workspaceId: string) => void;
  onShutdownRequest?: () => void;
}

const als = new AsyncLocalStorage<Principal>();

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function errorBody(err: unknown) {
  const cause = serviceCause(err);
  return { error: cause.safe_message, code: cause.error_code, ...cause };
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function buildZ2cService(deps: Z2cServiceDeps): { httpServer: ReturnType<typeof createServer>; close: () => Promise<void> } {
  const generation = newGeneration();
  const mcpSessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

  const httpServer = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      const cause = serviceCause(err);
      deps.audit.record("error", "service.request_error", cause);
      if (!res.headersSent) json(res, 500, { error: cause.error_code, ...cause });
    });
  });

  function authorize(req: IncomingMessage): { principal: Principal; local: boolean } | null {
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ")) return null;
    const token = auth.slice(7);
    if (deps.security.authenticate(token)) return { principal: LOCAL_PRINCIPAL, local: true };
    const client = deps.pairing.authenticate(token);
    if (client) return { principal: client, local: false };
    return null;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Liveness only: no data beyond status + protocol version.
    if (req.method === "GET" && req.url === "/health") {
      json(res, 200, { status: "ok", ready: deps.provider.status === "healthy", generation, protocol_version: Z2C_PROTOCOL_VERSION, provider: deps.provider.status });
      return;
    }

    const authz = authorize(req);
    if (!authz) {
      deps.audit.record("warn", "service.auth_rejected", { path: (req.url ?? "").slice(0, 80) });
      json(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.url === "/mcp" && req.method === "POST") {
      await handleMcp(req, res, authz.principal);
      return;
    }

    // Management API: LOCAL USER ONLY (service secret). Paired clients can
    // never manage pairing, grants, or other clients' sessions.
    if (req.url?.startsWith("/api/")) {
      if (!authz.local) {
        json(res, 403, { error: "management API is local-user only" });
        return;
      }
      await handleApi(req, res);
      return;
    }

    json(res, 404, { error: "not found" });
  }

  // ── MCP ───────────────────────────────────────────────────────────────────
  async function handleMcp(req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<void> {
    const sidHeader = req.headers["mcp-session-id"];
    const existing = typeof sidHeader === "string" ? mcpSessions.get(sidHeader) : undefined;
    if (existing) {
      // The principal is bound at session creation; later requests on the same
      // MCP session must present the SAME identity.
      const bound = typeof existing.transport.sessionId === "string" ? principalForSession.get(existing.transport.sessionId) : undefined;
      if (bound !== undefined && (principal.clientId ?? null) !== bound) {
        json(res, 401, { error: "identity mismatch for this MCP session" });
        return;
      }
      await als.run(principal, () => existing.transport.handleRequest(req, res));
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sid) => {
        mcpSessions.set(sid, { transport, server });
        principalForSession.set(sid, principal.clientId);
      },
      onsessionclosed: (sid) => {
        mcpSessions.delete(sid);
        principalForSession.delete(sid);
      },
    });
    const server = buildMcpServer(deps);
    await server.connect(transport);
    await als.run(principal, () => transport.handleRequest(req, res));
  }
  const principalForSession = new Map<string, string | null>();

  function currentPrincipal(): Principal {
    return als.getStore() ?? LOCAL_PRINCIPAL;
  }

  // ── Management API ────────────────────────────────────────────────────────
  async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "";
    const body = req.method === "POST" ? (JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>) : {};
    const route = `${req.method} ${url.split("?")[0]}`;
    try {
      switch (route) {
        case "GET /api/status": {
          json(res, 200, {
            protocol_version: Z2C_PROTOCOL_VERSION,
            install_id: deps.security.state.installId,
            provider: { name: deps.provider.name, status: deps.provider.status, detail: deps.provider.statusDetail ?? null, zcode_version: deps.provider.providerVersion, child_pid: deps.provider.childPid ?? null },
            pairing_state: deps.pairing.pairingState(),
            clients: deps.pairing.listClients().map((c) => ({ client_id: c.clientId, device_name: c.deviceName, state: c.state, paired_at: new Date(c.pairedAt).toISOString() })),
            workspaces: deps.grants.list().map((g) => ({ workspace_id: g.workspaceId, display_name: g.displayName, permissions: g.permissions, granted_at: new Date(g.grantedAt).toISOString() })),
            sessions: deps.sessions.list(LOCAL_PRINCIPAL),
            queues: deps.engine ? "present" : "absent",
          });
          return;
        }
        case "POST /api/pairing/begin": {
          const result = deps.pairing.beginPairing(String(body.deviceName ?? "device"));
          json(res, 200, result);
          return;
        }
        case "POST /api/pairing/confirm": {
          const result = deps.pairing.confirmPairing(String(body.pairingId), String(body.code));
          deps.audit.record("info", "pairing.confirmed", { clientId: result.clientId, deviceName: result.deviceName });
          json(res, 200, result);
          return;
        }
        case "GET /api/pairing/clients": {
          json(res, 200, { clients: deps.pairing.listClients() });
          return;
        }
        case "POST /api/pairing/revoke": {
          deps.pairing.revoke(String(body.clientId));
          deps.audit.record("info", "pairing.revoked", { clientId: String(body.clientId) });
          json(res, 200, { revoked: true });
          return;
        }
        case "GET /api/workspaces": {
          json(res, 200, { workspaces: deps.grants.list() });
          return;
        }
        case "POST /api/workspaces/authorize": {
          const grant = deps.grants.authorize(String(body.path), {
            displayName: body.displayName ? String(body.displayName) : undefined,
            write: body.write === undefined ? true : Boolean(body.write),
          });
          deps.audit.record("info", "workspace.authorized", { workspaceId: grant.workspaceId, write: grant.permissions.write });
          json(res, 200, grant);
          return;
        }
        case "POST /api/workspaces/revoke": {
          const grant = deps.grants.revoke(String(body.workspaceId));
          deps.audit.record("info", "workspace.revoked", { workspaceId: grant.workspaceId });
          json(res, 200, { revoked: true, workspace_id: grant.workspaceId });
          return;
        }
        case "GET /api/sessions": {
          json(res, 200, { sessions: deps.sessions.list(LOCAL_PRINCIPAL) });
          return;
        }
        case "POST /api/sessions/stop": {
          const result = await deps.sessions.stop(LOCAL_PRINCIPAL, { workspace_id: String(body.workspace_id), session_id: String(body.session_id) });
          json(res, 200, result);
          return;
        }
        case "POST /api/admin/shutdown": {
          if (body.confirm !== "shutdown") {
            json(res, 400, { error: "confirm must be 'shutdown'" });
            return;
          }
          json(res, 200, { stopping: true });
          deps.onShutdownRequest?.();
          return;
        }
        default:
          json(res, 404, { error: `unknown management route: ${route}` });
      }
    } catch (err) {
      const e = errorBody(err);
      json(res, (err as { httpStatus?: number })?.httpStatus ?? 400, e);
    }
  }

  httpServer.on("close", () => {
    for (const s of mcpSessions.values()) {
      void s.transport.close();
      void s.server.close();
    }
    mcpSessions.clear();
  });

  return { httpServer, close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())) };
}

// ── model-catalog observation (exported for offline fake-clock tests) ───────

export interface ZcodeCatalogAttempt {
  session_id: string;
  outcome: string;
  error?: string;
}

export interface ZcodeCatalogObservation {
  evidenceSource: string;
  observedSessionId: string | null;
  attempts: ZcodeCatalogAttempt[];
  candidatesConsidered: number;
  candidatesAttempted: number;
  candidatesObserved: number;
  runtimeSettings: unknown;
}

export interface ZcodeCatalogObservationOptions {
  budgetMs?: number;
  maxCandidates?: number;
  /** Injectable clock for offline budget tests; defaults to Date.now. */
  now?: () => number;
  /**
   * Observability hook invoked with the FULL session id and classified
   * outcome for every attempted candidate (before masking). Used to demote
   * ownership records the runtime reports as no longer active (cold-start
   * reconciliation) without exposing session ids in the public tool output.
   */
  onCandidateOutcome?: (sessionId: string, outcome: string) => void;
}

/**
 * The observation port the catalog loop consumes. It is ADAPTED from the
 * real provider signatures — `listSessions(workspace?, opts?)` and
 * `observeSessionSettings(sessionId, opts?)` — so the timeout always lands
 * in the actual opts parameter and the workspace parameter stays undefined.
 */
export interface ZcodeCatalogObservationPort {
  listSessions: (opts: { timeoutMs?: number }) => Promise<Array<{ sessionId: string; updatedAt?: number }>>;
  observeSessionSettings: (sessionId: string, opts: { timeoutMs?: number }) => Promise<unknown>;
}

/**
 * Explicit adapter: observation opts → the real provider's SECOND parameter,
 * with `this` preserved via closures. No cross-type assertion pretends the
 * provider signature is something it is not. Returns null when the provider
 * does not expose the observation surface (configured-only evidence).
 */
export function adaptZcodeProviderToCatalogPort(provider: {
  listSessions?: (workspace?: unknown, opts?: { timeoutMs?: number }) => Promise<Array<{ sessionId: string; updatedAt?: number }>>;
  observeSessionSettings?: (sessionId: string, opts?: { timeoutMs?: number }) => Promise<unknown>;
}): ZcodeCatalogObservationPort | null {
  if (typeof provider.listSessions !== "function" || typeof provider.observeSessionSettings !== "function") return null;
  return {
    listSessions: (opts) => provider.listSessions!.call(provider, undefined, opts),
    observeSessionSettings: (sessionId, opts) => provider.observeSessionSettings!.call(provider, sessionId, opts),
  };
}

// Shared classifier lives in its own module so the SessionService can use it
// without an import cycle; re-exported here for the established import path.
export { classifyObservationError };

/**
 * Bounded, sanitized rendering of an upstream observation error: structured
 * classification first; the human-readable remainder is stripped of bearer
 * tokens, token/key URL parameters, key material, and local paths, then
 * capped. Never a raw passthrough of the upstream message.
 */
export function sanitizeObservationText(message: string, max = 160): string {
  return message
    .replace(/(?:authorization\s*:\s*)?bearer\s+[A-Za-z0-9._~+/=-]+/gi, "bearer [REDACTED]")
    .replace(/(?:authorization\s*:\s*)?basic\s+[A-Za-z0-9._~+/=-]+/gi, "basic [REDACTED]")
    .replace(/((?:x-)?api[-_]?key\s*[:=]?\s*)[^\s,;"'&{}]+/gi, "$1[REDACTED]")
    .replace(/(cookie\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(/(["']?[A-Za-z0-9_.-]*(?:secret|token|key|credential|password|code)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)[^\s,;"'&{}]+/gi, "$1[REDACTED]")
    .replace(/(["']?sid["']?\s*[:=]\s*["']?)[^\s,;"'&{}]+/gi, "$1[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED_KEY]")
    .replace(/[A-Za-z]:\\[^\s"']*/g, "[LOCAL_PATH]")
    .replace(/\/(?:home|Users)\/[^\s"']*/g, "[LOCAL_PATH]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Bounded catalog observation over the provider's native session surface.
 * ONE wall-clock budget is shared by session/list and every session/read:
 * each call receives the REMAINING budget as its per-call timeout (other
 * business callers keep their own default timeouts), the loop stops at the
 * deadline, a late success after the deadline is never published, and no
 * session lifecycle operation is ever issued. Timeout/not-active/not-found
 * candidates are skippable; permission problems stop the scan honestly.
 */
export async function observeZcodeCatalog(
  port: ZcodeCatalogObservationPort,
  options: ZcodeCatalogObservationOptions = {}
): Promise<ZcodeCatalogObservation> {
  const budgetMs = options.budgetMs ?? 8000;
  const maxCandidates = options.maxCandidates ?? 5;
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  const deadline = startedAtMs + budgetMs;
  const remainingMs = () => deadline - now();
  let deadlineExhausted = false;
  const attempts: ZcodeCatalogAttempt[] = [];
  const maskSession = (sessionId: string): string => (sessionId.length > 14 ? `${sessionId.slice(0, 14)}…` : sessionId);
  const result: ZcodeCatalogObservation = {
    evidenceSource: "configured",
    observedSessionId: null,
    attempts,
    candidatesConsidered: 0,
    candidatesAttempted: 0,
    candidatesObserved: 0,
    runtimeSettings: null,
  };

  let candidates: Array<{ sessionId: string; updatedAt?: number }> = [];
  const listBudget = Math.max(0, Math.min(remainingMs(), 20000));
  if (listBudget <= 0) {
    deadlineExhausted = true;
    attempts.push({ session_id: "", outcome: "observation-budget-exhausted" });
    result.evidenceSource = "observation-budget-exhausted";
    return result;
  }
  try {
    const sessions = await port.listSessions({ timeoutMs: listBudget });
    candidates = [...sessions]
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, maxCandidates);
    result.candidatesConsidered = candidates.length;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (remainingMs() <= 0) {
      deadlineExhausted = true;
      attempts.push({ session_id: "", outcome: "observation-budget-exhausted" });
      result.evidenceSource = "observation-budget-exhausted";
      return result;
    }
    attempts.push({
      session_id: "",
      outcome: classifyObservationError(message) === "timeout" ? "timeout" : "list-sessions-failed",
      error: sanitizeObservationText(message),
    });
    result.evidenceSource = "session-list-unavailable";
    return result;
  }
  // The list await may itself have consumed the rest of the budget:
  // re-check immediately instead of relying on the next iteration.
  if (remainingMs() <= 0) {
    deadlineExhausted = true;
    attempts.push({ session_id: "", outcome: "observation-budget-exhausted" });
    result.evidenceSource = "observation-budget-exhausted";
    return result;
  }
  if (candidates.length === 0) {
    result.evidenceSource = "no-candidates";
    return result;
  }
  result.evidenceSource = "all-candidates-unreadable";
  for (const candidate of candidates) {
    if (result.runtimeSettings !== null) break;
    if (remainingMs() <= 0) {
      attempts.push({ session_id: maskSession(candidate.sessionId), outcome: "observation-budget-exhausted" });
      deadlineExhausted = true;
      break;
    }
    result.candidatesAttempted += 1;
    try {
      // The per-call timeout is the SHARED remaining budget: a hung read
      // rejects at the deadline via the protocol's own pending cleanup —
      // no shared connection is closed and no agent is killed.
      const settings = await port.observeSessionSettings(candidate.sessionId, { timeoutMs: Math.max(0, remainingMs()) });
      // Post-await deadline re-check: a result that lands after the shared
      // deadline (clock consumed inside the read) is DROPPED — it never
      // enters runtimeSettings, never sets observedSessionId, never counts
      // as a success. The terminal budget state is recorded right here.
      if (remainingMs() <= 0) {
        deadlineExhausted = true;
        attempts.push({ session_id: maskSession(candidate.sessionId), outcome: "observation-budget-exhausted" });
        result.evidenceSource = "observation-budget-exhausted";
        break;
      }
      if (settings) {
        result.runtimeSettings = settings;
        result.observedSessionId = candidate.sessionId;
        result.candidatesObserved += 1;
        result.evidenceSource = "session-settings-observed";
        options.onCandidateOutcome?.(candidate.sessionId, "observed");
        attempts.push({ session_id: maskSession(candidate.sessionId), outcome: "observed" });
      } else {
        options.onCandidateOutcome?.(candidate.sessionId, "session-settings-empty");
        attempts.push({ session_id: maskSession(candidate.sessionId), outcome: "session-settings-empty" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = classifyObservationError(message);
      if (remainingMs() <= 0) {
        deadlineExhausted = true;
        attempts.push({ session_id: maskSession(candidate.sessionId), outcome: "observation-budget-exhausted" });
        result.evidenceSource = "observation-budget-exhausted";
        break;
      }
      options.onCandidateOutcome?.(candidate.sessionId, kind);
      attempts.push({ session_id: maskSession(candidate.sessionId), outcome: kind, error: sanitizeObservationText(message) });
      if (kind === "permission") break; // repeats for every candidate; report honestly instead of hammering
    }
  }
  if (result.runtimeSettings === null && deadlineExhausted) {
    result.evidenceSource = "observation-budget-exhausted";
  }
  return result;
}

// ── MCP tool surface (canonical, semantic only) ─────────────────────────────
export function buildMcpServer(deps: Z2cServiceDeps): McpServer {
  const server = new McpServer(
    { name: "z2c-service", version: String(Z2C_PROTOCOL_VERSION) },
    { instructions: "Semantic ZCode session control. Sessions run in the user's locally-authorized workspaces; identity is attested from native ZCode state." },
  );

  const sess = deps.sessions;
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: any, handler: (...args: any[]) => any) =>
    register(name, config, async (...args: any[]) => {
      try { return await handler(...args); }
      catch (error) { const cause = serviceCause(error); return { isError: true, content: [{ type: "text", text: JSON.stringify({ ...cause, error: cause.error_code, code: cause.error_code }) }] }; }
    })) as typeof server.registerTool;
  const wsRefShape = { workspace_id: z.string().min(1), session_id: z.string().regex(/^sess_[0-9a-f-]{36}$/i) };

  server.registerTool("zcode_runtime_capabilities", {
    title: "ZCode runtime capabilities",
    description: "Z2C protocol version, provider health, detected ZCode runtime version, and capability probe. Read-only.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const p = deps.provider;
    return text({
      z2c_protocol_version: Z2C_PROTOCOL_VERSION,
      provider: p.name,
      provider_status: p.status,
      detail: p.status === "healthy" ? null : "Provider is not ready; inspect safe diagnostic code",
        zcode_runtime_version: p.providerVersion,
        expected_zcode_version: p.expectedRuntimeVersion ?? p.capabilityResult?.expectedVersion ?? null,
      capabilities: p.capabilityResult,
      entitlement_capability: p.entitlementSelection ?? null,
    });
  });

  server.registerTool("zcode_model_catalog", {
    title: "ZCode model catalog",
    description:
      "Read-only model/thought availability evidence for the detected ZCode runtime. The local operator gets the " +
      "runtime's own advertised availability observed through existing native sessions (bounded candidate list and " +
      "shared time budget, skipping sessions the runtime reports as not readable); no session is ever created or " +
      "mutated for discovery. Paired clients receive provider health and configured identity only.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const principal = currentPrincipal();
    const official = deps.provider as AgentProvider & {
      listSessions?: (workspace?: unknown, opts?: { timeoutMs?: number }) => Promise<Array<{ sessionId: string; updatedAt?: number }>>;
      observeSessionSettings?: (sessionId: string, opts?: { timeoutMs?: number }) => Promise<unknown>;
      requestedIdentity?: () => { modelId: string | null; thoughtLevel: string | null; providerId: string | null };
      childPid?: number | null;
    };
    // Principal isolation stays at the tool layer: paired clients never
    // trigger session observation at all (configured-only evidence).
    const isLocal = principal.kind === "local"
      && typeof official.observeSessionSettings === "function"
      && typeof official.listSessions === "function";
    const port = isLocal ? adaptZcodeProviderToCatalogPort(official) : null;
    // Cold-start reconciliation: the runtime itself tells us which sessions it
    // no longer considers active (e.g. after an app-server restart). Demote
    // owned records so stale pre-restart sessions stop projecting as current
    // truth; any successful live use clears the demotion.
    const onCandidateOutcome = (sessionId: string, outcome: string): void => {
      if (outcome === "session-not-active" || outcome === "session-not-found") {
        try { deps.ownership.markStale(sessionId); } catch { /* demotion is best-effort */ }
      }
    };
    const observation = port
      ? await observeZcodeCatalog(port, { budgetMs: 8000, maxCandidates: 5, onCandidateOutcome })
      : {
          evidenceSource: "configured",
          observedSessionId: null,
          attempts: [],
          candidatesConsidered: 0,
          candidatesAttempted: 0,
          candidatesObserved: 0,
          runtimeSettings: null,
        };
    return text({
      z2c_protocol_version: Z2C_PROTOCOL_VERSION,
      provider: deps.provider.name,
      provider_status: deps.provider.status,
      detail: deps.provider.statusDetail ?? null,
      zcode_runtime_version: deps.provider.providerVersion,
      provider_child_pid: deps.provider.childPid ?? null,
      evidence_source: observation.evidenceSource,
      observed_session_id: observation.observedSessionId,
      attempts: observation.attempts,
      candidates_considered: observation.candidatesConsidered,
      candidates_attempted: observation.candidatesAttempted,
      candidates_observed: observation.candidatesObserved,
      configured_identity: official.requestedIdentity?.() ?? null,
      runtime_settings: observation.runtimeSettings,
      note: observation.runtimeSettings
        ? "availability is the runtime's own advertisement observed via the referenced session; a single-session view is not an account-wide catalog and catalog-listed is not inference-verified"
        : "no readable native session was available to observe; model availability is not evidenced and no discovery session will be created",
      observed_at: new Date().toISOString(),
    });
  });

  server.registerTool("zcode_workspace_list", {
    title: "List authorized workspaces",
    description: "Workspaces the LOCAL USER authorized for this client. Paths are only shown to the local principal.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const principal = currentPrincipal();
    const isLocal = principal.kind === "local";
    return text({
      workspaces: deps.grants.list().map((g) => ({
        workspace_id: g.workspaceId,
        display_name: g.displayName,
        permissions: g.permissions,
        granted_at: new Date(g.grantedAt).toISOString(),
        ...(isLocal ? { canonical_path: g.canonicalPath } : {}),
      })),
    });
  });

  server.registerTool("zcode_session_list", {
    title: "List Z2C sessions",
    description: "Sessions owned by this client in authorized workspaces. Native sessions not created through Z2C never appear.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => text({ sessions: sess.list(currentPrincipal()) }));

  server.registerTool("zcode_session_create", {
    title: "Create ZCode session",
    description:
      "Create a native ZCode session in an authorized workspace. access=readonly establishes plan mode via the v4 CAS path. Identity (provider/model/thought) is resolved by ZCode and attested from the exact session.",
    inputSchema: {
      workspace_id: z.string().min(1),
      access: z.enum(["readonly", "write"]),
      model: z.string().max(64).optional(),
      thought_level: z.string().max(20).optional(),
      entitlement_plan: z.enum(["DEFAULT", "START", "INDIVIDUAL"]).optional(),
      provider: z.string().max(64).optional(),
      operation_id: z.string().uuid().optional(),
    },
  }, async (args) => text(await sess.createSession(currentPrincipal(), {
    workspace_id: args.workspace_id,
    access: args.access,
    model: args.model,
    thought_level: args.thought_level,
    entitlement_plan: args.entitlement_plan,
    provider: args.provider,
    operation_id: args.operation_id,
  })));

  server.registerTool("zcode_session_create_operation", {
    title: "Read session creation operation", description: "Read a caller-owned creation outcome without retrying or launching a turn.",
    inputSchema: { operation_id: z.string().uuid() }, annotations: { readOnlyHint: true },
  }, async (args) => text(sess.creationOperation(currentPrincipal(), args.operation_id)));

  server.registerTool("zcode_session_resume", {
    title: "Resume ZCode session",
    description: "Resume an owned session (re-establishes plan for readonly sessions after cold resume) and return attested state.",
    inputSchema: { ...wsRefShape, access: z.enum(["readonly", "write"]), entitlement_plan: z.enum(["DEFAULT", "START", "INDIVIDUAL"]).optional() },
  }, async (args) => text(await sess.resumeSession(currentPrincipal(), { workspace_id: args.workspace_id, session_id: args.session_id, access: args.access, entitlement_plan: args.entitlement_plan })));

  server.registerTool("zcode_session_read", {
    title: "Read ZCode session",
    description: "Sanitized authoritative state of an owned session (workspace/provider/model/thought/mode/runtime).",
    inputSchema: wsRefShape,
    annotations: { readOnlyHint: true },
  }, async (args) => text(await sess.read(currentPrincipal(), { workspace_id: args.workspace_id, session_id: args.session_id })));

  server.registerTool("zcode_session_send", {
    title: "Send instruction to ZCode session",
    description: "Send one instruction to an owned session and wait for the bounded final assistant output plus re-attested state.",
    inputSchema: {
      ...wsRefShape,
      instruction: z.string().min(1).max(20000),
      entitlement_plan: z.enum(["DEFAULT", "START", "INDIVIDUAL"]).optional(),
      timeout_ms: z.number().int().min(10000).max(900000).optional(),
    },
  }, async (args) => text(await sess.send(currentPrincipal(), {
    workspace_id: args.workspace_id,
    session_id: args.session_id,
    instruction: args.instruction,
    entitlement_plan: args.entitlement_plan,
    timeout_ms: args.timeout_ms,
  })));

  server.registerTool("zcode_session_events", {
    title: "Read ZCode session events",
    description: "Bounded, seq-cursor event read for an owned session.",
    inputSchema: { ...wsRefShape, after_seq: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(200).optional() },
    annotations: { readOnlyHint: true },
  }, async (args) => text({ events: await sess.events(currentPrincipal(), { workspace_id: args.workspace_id, session_id: args.session_id, after_seq: args.after_seq, limit: args.limit }) }));

  server.registerTool("zcode_session_messages", {
    title: "Read ZCode session messages",
    description: "Bounded message read for an owned session.",
    inputSchema: { ...wsRefShape, limit: z.number().int().min(1).max(200).optional() },
    annotations: { readOnlyHint: true },
  }, async (args) => text({ messages: await sess.messages(currentPrincipal(), { workspace_id: args.workspace_id, session_id: args.session_id, limit: args.limit }) }));

  server.registerTool("zcode_session_stop", {
    title: "Stop ZCode session turn",
    description: "Interrupt the running turn of an owned session (the session stays alive).",
    inputSchema: wsRefShape,
  }, async (args) => text(await sess.stop(currentPrincipal(), { workspace_id: args.workspace_id, session_id: args.session_id })));

  server.registerTool("zcode_session_close", {
    title: "Close ZCode session",
    description: "Tear down an owned session runtime cleanly and drop Z2C ownership.",
    inputSchema: wsRefShape,
  }, async (args) => text(await sess.close(currentPrincipal(), { workspace_id: args.workspace_id, session_id: args.session_id })));

  server.registerTool("zcode_session_set_model", {
    title: "Set session model",
    description: "Switch the model of an owned session (same session id preserved); the switch is re-attested from native state and fails closed if unconfirmed.",
    inputSchema: { ...wsRefShape, model: z.string().min(1).max(64) },
  }, async (args) => text(await sess.setModel(currentPrincipal(), { workspace_id: args.workspace_id, session_id: args.session_id, model: args.model })));

  server.registerTool("zcode_session_set_thought_level", {
    title: "Set session thought level",
    description: "Switch the reasoning depth of an owned session; attested, fail-closed.",
    inputSchema: { ...wsRefShape, thought_level: z.string().min(1).max(20) },
  }, async (args) => text(await sess.setThoughtLevel(currentPrincipal(), { workspace_id: args.workspace_id, session_id: args.session_id, thought_level: args.thought_level })));

  server.registerTool("zcode_session_set_mode", {
    title: "Set session collaboration mode",
    description: "Switch an owned session between plan/build/edit/yolo via the authoritative v4 CAS path; the transition is observed and attested.",
    inputSchema: { ...wsRefShape, mode: z.enum(["plan", "build", "edit", "yolo"]) },
  }, async (args) => text(await sess.setMode(currentPrincipal(), { workspace_id: args.workspace_id, session_id: args.session_id, mode: args.mode })));

  // ── Shared agent-plane observation surface (local operator only) ──────────
  // Provider-neutral visibility for the unified session plane: native sessions
  // that were NOT created through Z2C (Desktop/manual) become observable.
  // Observation never grants control; the SessionService enforces the local
  // principal and canonical-root boundaries for every call.

  server.registerTool("zcode_session_discover", {
    title: "Discover native ZCode sessions",
    description:
      "LOCAL OPERATOR ONLY. List ALL native sessions in authorized workspaces via native session/list, including " +
      "sessions not created through Z2C (Desktop/manual origin), canonical-root filtered. Observe-only: no control is granted.",
    inputSchema: { workspace_id: z.string().min(1).optional() },
    annotations: { readOnlyHint: true },
  }, async (args) => text({ sessions: await sess.discover(currentPrincipal(), { workspace_id: args.workspace_id }) }));

  server.registerTool("zcode_session_observe", {
    title: "Observe native ZCode session",
    description:
      "LOCAL OPERATOR ONLY. Sanitized authoritative state (workspace/provider/model/thought/mode/runtime) of any " +
      "discovered native session in an authorized workspace. Observe-only.",
    inputSchema: wsRefShape,
    annotations: { readOnlyHint: true },
  }, async (args) => text(await sess.observe(currentPrincipal(), { workspace_id: args.workspace_id, session_id: args.session_id })));

  server.registerTool("zcode_session_observe_messages", {
    title: "Observe native ZCode session messages",
    description:
      "LOCAL OPERATOR ONLY. Bounded visible message history of any discovered native session in an authorized " +
      "workspace (workspace-bound via the exact-session state read). Observe-only.",
    inputSchema: { ...wsRefShape, limit: z.number().int().min(1).max(200).optional() },
    annotations: { readOnlyHint: true },
  }, async (args) => text({ messages: await sess.observeMessages(currentPrincipal(), { workspace_id: args.workspace_id, session_id: args.session_id, limit: args.limit }) }));

  // ── Legacy Phase-1/2 tools (deprecated, kept for existing integrations) ──
  server.registerTool("submit_zcode_task", {
    title: "Submit ZCode task (deprecated name)",
    description: "DEPRECATED compatibility name for the governed task queue; prefer zcode_session_* tools.",
    inputSchema: {
      workspace_id: z.string(),
      instruction: z.string().min(1).max(20000),
      entitlement_plan: z.enum(["DEFAULT", "START", "INDIVIDUAL"]).optional(),
      idempotency_key: z.string().optional(),
      write_scope: z.enum(["workspace", "readonly"]).optional(),
      mode: z.enum(["plan", "build", "edit"]).optional(),
      resume_session_id: z.string().regex(/^sess_[0-9a-f-]{36}$/i).optional(),
      model_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
      thought_level: z.string().regex(/^[a-z0-9_-]{1,20}$/).optional(),
    },
  }, async (args) => {
    try {
      if (currentPrincipal().kind !== "local") throw new Error("legacy task lane requires the local service principal");
      ensureEngineWorkspace(args.workspace_id);
      const view = await deps.engine.submitTask({
        workspace_id: args.workspace_id,
        instruction: args.instruction,
    entitlement_plan: args.entitlement_plan,
        ...(args.idempotency_key ? { idempotency_key: args.idempotency_key } : {}),
        write_scope: args.write_scope,
        mode: args.mode,
        ...(args.resume_session_id ? { resume_session_id: args.resume_session_id } : {}),
        ...(args.model_id ? { model_id: args.model_id } : {}),
        ...(args.thought_level ? { thought_level: args.thought_level } : {}),
      });
      if (view.session_id && !deps.ownership.get(view.session_id)) {
        deps.ownership.record({
          sessionId: view.session_id,
          workspaceId: args.workspace_id,
          clientId: "local",
          accessMode: args.write_scope === "readonly" ? "readonly" : "write",
        });
      }
      return text(view);
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "INTERNAL";
      return { isError: true as const, content: [{ type: "text" as const, text: `${code}: ${(err as Error).message}` }] };
    }
  });

  // The governed A2C task lane uses Z2C's durable task engine. Keep its
  // complete protocol on this same authenticated semantic service; exposing
  // submit alone would admit work that A2C cannot observe or cancel. These
  // compatibility tools are restricted to the machine-local service secret.
  const localTaskLane = (): void => {
    if (currentPrincipal().kind !== "local") {
      throw new Error("legacy task lane requires the local service principal");
    }
  };
  /**
   * Register-on-miss for the legacy task lane: the A2C native lane forwards
   * the PROJECTED native workspace id; when the engine registry does not know
   * it yet (grant created after service start), sync from the authoritative
   * grant registry once. No grant → the engine's own resolve fails closed.
   */
  const ensureEngineWorkspace = (workspaceId: string): void => {
    try { deps.engine.getQueue(workspaceId); return; } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code !== "UNKNOWN_WORKSPACE") throw error;
    }
    if (typeof deps.ensureWorkspaceRegistered === "function") {
      deps.ensureWorkspaceRegistered(workspaceId);
    }
  };
  const legacyError = (err: unknown) => ({
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(errorBody(err)) }],
  });

  server.registerTool("provider_status", {
    title: "Governed task provider status",
    description: "Local-only provider and durable task protocol status for the A2C adapter, including the workspace queue state used by writer-slot reconciliation.",
    inputSchema: { workspace_id: z.string().min(1) },
    annotations: { readOnlyHint: true },
  }, async ({ workspace_id }) => {
    try {
      localTaskLane(); ensureEngineWorkspace(workspace_id);
      const queue = deps.engine.getQueue(workspace_id);
      const active = queue.activeTask ? deps.engine.getTask(workspace_id, queue.activeTask) : null;
      return text({
        provider: deps.provider.name,
        status: deps.provider.status,
        capabilities: deps.provider.capabilityResult,
        // Entitlement selection capability as OBSERVED from the connected
        // runtime (runtime/capabilities). Absent provider support = null;
        // consumers must treat null as "START/INDIVIDUAL fail closed".
        entitlement_capability: deps.provider.entitlementSelection ?? null,
        workspace_id,
        durable_idempotency: IDEMPOTENCY_PROTOCOL,
        session_id: active?.session_id ?? null,
        model_binding: active?.model_binding ?? null,
        queue: {
          paused: queue.paused,
          active_task: queue.activeTask,
          queued_task_count: queue.queuedTaskCount,
        },
      });
    } catch (err) { return legacyError(err); }
  });

  server.registerTool("resolve_zcode_task_by_key", {
    title: "Resolve governed task by idempotency key",
    description:
      "Local-only read-only resolution of the durable task admitted under an idempotency key in this workspace. " +
      "Returns { task: <view> } when the key is bound, { task: null, key_state: \"unbound\" } when no task was ever " +
      "admitted under the key. Never submits or mutates; used to resolve a lost submit response without re-dispatching.",
    inputSchema: { workspace_id: z.string().min(1), idempotency_key: z.string().regex(IDEMPOTENCY_KEY) },
    annotations: { readOnlyHint: true },
  }, async ({ workspace_id, idempotency_key }) => {
    try {
      localTaskLane();
      ensureEngineWorkspace(workspace_id);
      deps.engine.getQueue(workspace_id); // resolveAuthorized: fail closed on unknown workspace
      const task = deps.engine.resolveKeyedTask(workspace_id, idempotency_key);
      return text({ workspace_id, idempotency_key, key_state: task ? "bound" : "unbound", task });
    } catch (err) { return legacyError(err); }
  });

  server.registerTool("get_zcode_task", {
    title: "Get governed ZCode task",
    description: "Local-only bounded durable task status.",
    inputSchema: { workspace_id: z.string().min(1), task_id: z.string().min(1) },
    annotations: { readOnlyHint: true },
  }, async ({ workspace_id, task_id }) => {
    try { localTaskLane(); ensureEngineWorkspace(workspace_id); return text(deps.engine.getTask(workspace_id, task_id)); }
    catch (err) { return legacyError(err); }
  });

  server.registerTool("cancel_zcode_task", {
    title: "Cancel governed ZCode task",
    description: "Local-only task cancellation with exact workspace and task binding.",
    inputSchema: { workspace_id: z.string().min(1), task_id: z.string().min(1) },
  }, async ({ workspace_id, task_id }) => {
    try { localTaskLane(); ensureEngineWorkspace(workspace_id); return text(deps.engine.cancelTask(workspace_id, task_id)); }
    catch (err) { return legacyError(err); }
  });

  server.registerTool("execution_output", {
    title: "Read governed task output",
    description: "Local-only bounded final output of an authorized task.",
    inputSchema: { workspace_id: z.string().min(1), task_id: z.string().min(1), output_id: z.string().min(1) },
    annotations: { readOnlyHint: true },
  }, async ({ workspace_id, task_id, output_id }) => {
    try { localTaskLane(); ensureEngineWorkspace(workspace_id); return text(deps.engine.getOutput(workspace_id, task_id, output_id)); }
    catch (err) { return legacyError(err); }
  });

  server.registerTool("resume_zcode_session", {
    title: "Resume governed ZCode session",
    description: "Local-only immediate continuation of an owned Z2C session. The session identity is preserved and re-attested.",
    inputSchema: {
      workspace_id: z.string().min(1),
      session_id: z.string().regex(/^sess_[0-9a-f-]{36}$/i),
      instruction: z.string().min(1).max(20000),
      entitlement_plan: z.enum(["DEFAULT", "START", "INDIVIDUAL"]).optional(),
      idempotency_key: z.string().regex(IDEMPOTENCY_KEY).optional(),
    },
  }, async ({ workspace_id, session_id, instruction, idempotency_key, entitlement_plan }) => {
    try {
      localTaskLane();
      ensureEngineWorkspace(workspace_id);
      const owned = deps.ownership.assertCanAccess(currentPrincipal(), session_id, "write");
      if (owned.workspaceId !== workspace_id) throw new Error("session workspace mismatch");
      return text(await deps.engine.submitTask({ workspace_id, instruction, entitlement_plan, resume_session_id: session_id, immediate: true, ...(idempotency_key ? { idempotency_key } : {}) }));
    } catch (err) { return legacyError(err); }
  });

  return server;
}

function text(body: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
}

function currentPrincipal(): Principal {
  return als.getStore() ?? LOCAL_PRINCIPAL;
}

/** Run a handler under an explicit principal (tests; future relay transport). */
export function runAsPrincipal<T>(principal: Principal, fn: () => Promise<T>): Promise<T> {
  return als.run(principal, fn);
}
