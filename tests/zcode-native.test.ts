/**
 * Focused integration tests for the governed C2C → Z2C native surface
 * (src/execution/zcode-native.ts + src/mcp/zcode-native-tools.ts).
 *
 * The fake upstream models Z2C's REAL workspace contract: tools only accept
 * NATIVE grant ids (ws_…) resolved from the grant registry — exactly like the
 * deployed z2c-service, which rejects foreign ids with "workspace is not
 * authorized". The authorized A2C workspace ids are projected onto those
 * native ids through the authoritative registry + grant path (the default
 * WorkspaceRegistry resolver against a fixture state dir, plus the semantic
 * lane's zcode_workspace_list / REST authorize surfaces), and every returned
 * namespace is validated back against the authorized A2C workspace.
 *
 * Tool-layer tests exercise principal authorization and the shared queue/
 * writer gate with stub deps.
 */
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  ZCODE_NATIVE_REQUIRED_IDENTITY,
  ZcodeNativeClient,
  ZcodeNativeError,
  loadZcodeNativeConfig,
  nativeAllowedWorkspaces,
  nativeRequestFingerprint,
} from "../src/execution/zcode-native.js";
import { registerZcodeNativeTools, resetZcodeNativeClientForTests } from "../src/mcp/zcode-native-tools.js";
import { resetZcodeSessionClientForTests, ZcodeSessionError } from "../src/execution/zcode-session-client.js";
import { canonicalizeWorkspaceRoot, stableWorkspaceId } from "../src/workspace/identity.js";
import { ZcodeControl } from "../src/execution/zcode-control.js";
import { nativeSelfTest } from "../src/execution/zcode-native-self-test.js";
import { makeTmpDir, cleanup } from "./helpers.js";

const TEST_TOKEN = "test-token-0123456789abcdef";
const SANCTIONED_BINDING = {
  provider_id: ZCODE_NATIVE_REQUIRED_IDENTITY.provider_id,
  model_id: ZCODE_NATIVE_REQUIRED_IDENTITY.model_id,
};

// Fixture geometry: A2C registry roots (must exist on disk for the canonical
// registry) and the native grant ids the fake upstream accepts for them.
const C2C_ROOT = mkdtempSync(join(tmpdir(), "zcode-native-ws-c2c-"));
const ENG_ROOT = mkdtempSync(join(tmpdir(), "zcode-native-ws-eng-"));
const C2C_CANONICAL = canonicalizeWorkspaceRoot(C2C_ROOT);
const ENG_CANONICAL = canonicalizeWorkspaceRoot(ENG_ROOT);
const C2C_WS = stableWorkspaceId(C2C_CANONICAL);
const ENGINEERING_AI_WS = stableWorkspaceId(ENG_CANONICAL);
const NATIVE_C2C = "ws_fixture-ai-startup";
const NATIVE_ENG = "ws_fixture-ai-startup-engineering";
const STATE_DIR = mkdtempSync(join(tmpdir(), "zcode-native-state-"));
/** Allowlisted upstream (via env stub in tests) but absent from the A2C registry. */
const UNREGISTERED_WS = "000000000000";

interface FakeGrant {
  workspace_id: string;
  canonical_path: string;
  permissions?: { read: boolean; write: boolean };
}

interface FakeState {
  durableIdempotency: boolean;
  submitInputs: Array<Record<string, unknown>>;
  serverName: string;
  providerName: string;
  providerStatus: string;
  capsOk: boolean;
  modelBinding: { provider_id: string; model_id: string } | null;
  /** Native grant id whose exact session binding is reported/attested. */
  bindingWorkspace: string;
  /** Binding Z2C observed for the exact session at admission (returned on task views). */
  submitBinding: { provider_id: string; model_id: string } | null;
  echoAuth: boolean;
  ignoreWorkspaceScope: boolean;
  spoofSubmitWorkspace: string | null;
  spoofStatusWorkspace: string | null;
  spoofObserveWorkspace: string | null;
  outputBody: Record<string, unknown> | null;
  submitCalls: number;
  statusCalls: number;
  listCalls: number;
  provisionCalls: number;
  keyCalls: number;
  dropSubmitResponse: boolean;
  authorizeEnabled: boolean;
  grants: FakeGrant[];
  discoveryOwner: string;
  /** Native grant ids created through the REST provisioning path. */
  provisionedIds: Set<string>;
  observeCalls: number;
  readZcodeSessionCalls: number;
  resumeCalls: number;
  cancelCalls: number;
  outputCalls: number;
  tasks: Map<string, { view: Record<string, unknown> }>;
}

let fake: FakeState;
let server: Server;
let baseUrl: string;

function taskKey(workspaceId: string, taskId: string): string {
  return `${workspaceId}|${taskId}`;
}

/** The fake upstream's grant resolution — foreign ids are rejected exactly like z2c. */
function grantFor(workspaceId: unknown): FakeGrant | null {
  return fake.grants.find((grant) => grant.workspace_id === workspaceId) ?? null;
}

function scopedView(workspaceId: string | undefined, taskId: string): Record<string, unknown> | null {
  if (fake.ignoreWorkspaceScope) {
    for (const entry of fake.tasks.values()) {
      if ((entry.view.task_id as string) === taskId) return entry.view;
    }
    return null;
  }
  if (workspaceId === undefined) {
    for (const entry of fake.tasks.values()) {
      if ((entry.view.task_id as string) === taskId) return entry.view;
    }
    return null;
  }
  return fake.tasks.get(taskKey(workspaceId, taskId))?.view ?? null;
}

function ws_is_attested(workspaceId: string): boolean {
  // Provisioned grants cover their canonical path exactly like pre-seeded
  // grants: attestation follows the grant, not the id's provenance.
  return (workspaceId === fake.bindingWorkspace || fake.provisionedIds.has(workspaceId)) && fake.submitBinding !== null;
}

function upstreamError(text: string) {
  return { isError: true, content: [{ type: "text", text }] };
}

/** The upstream's fingerprint over a RESUME admission (resume_session_id bound). */
function upstreamResumeFingerprint(args: { workspace_id: unknown; instruction: unknown; session_id: unknown }): string {
  return createHash("sha256").update(JSON.stringify({
    workspace_id: args.workspace_id, instruction: args.instruction,
    write_scope: "workspace", network: "default", mode: "build",
    resume_session_id: args.session_id, model_id: null, thought_level: null,
  })).digest("hex");
}

function notAuthorized(workspaceId: unknown) {
  return upstreamError(`WORKSPACE_NOT_AUTHORIZED: workspace is not authorized: ${String(workspaceId)}`);
}

async function startFakeZ2c(): Promise<void> {
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${TEST_TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      // REST grant provisioning — the authoritative local-user path the
      // semantic lane uses when a grant is missing.
      if (req.method === "POST" && req.url === "/api/workspaces/authorize") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { path?: string; write?: boolean };
        if (!fake.authorizeEnabled || typeof body.path !== "string") {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "grant provisioning unavailable" }));
          return;
        }
        fake.provisionCalls += 1;
        const existing = fake.grants.find((grant) => grant.canonical_path.replace(/[\\/]+$/, "").toLowerCase()
          === body.path!.replace(/[\\/]+$/, "").toLowerCase());
        if (existing) {
          existing.permissions = { read: true, write: body.write ?? true };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ workspaceId: existing.workspace_id, canonicalPath: existing.canonical_path, permissions: { read: true, write: body.write ?? true } }));
          return;
        }
        const id = `ws_${body.path.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 24)}`;
        const grant: FakeGrant = { workspace_id: id, canonical_path: body.path, permissions: { read: true, write: body.write ?? true } };
        fake.grants.push(grant);
        fake.provisionedIds.add(id);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ workspaceId: id, canonicalPath: body.path, permissions: { read: true, write: body.write ?? true } }));
        return;
      }
      const mcp = new McpServer({ name: fake.serverName, version: "0.1.0" });
      mcp.registerTool("zcode_workspace_list", { inputSchema: {} }, async () => {
        fake.listCalls += 1;
        return { content: [{ type: "text", text: JSON.stringify({ workspaces: fake.grants }) }] };
      });
      mcp.registerTool(
        "provider_status",
        { inputSchema: { workspace_id: z.string() } },
        async (args) => {
          fake.statusCalls += 1;
          const grant = grantFor(args.workspace_id);
          if (!grant) return notAuthorized(args.workspace_id);
          // The binding is reported only for the exact requested workspace.
          const binding = grant.workspace_id === fake.bindingWorkspace ? fake.modelBinding : null;
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                provider: fake.providerName,
                uses_desktop_managed_auth: fake.providerName === ZCODE_NATIVE_REQUIRED_IDENTITY.provider,
                status: fake.providerStatus,
                detail: null,
                zcode_version: null,
                capabilities: { ok: fake.capsOk, required: {} },
                workspace_id: fake.spoofStatusWorkspace ?? grant.workspace_id,
                ...(fake.durableIdempotency ? { durable_idempotency: "workspace-task-v1" } : {}),
                ...(binding ? { model_binding: binding } : {}),
              }),
            }],
          };
        },
      );
      mcp.registerTool(
        "submit_zcode_task",
        { inputSchema: { workspace_id: z.string(), instruction: z.string(), idempotency_key: z.string().optional(),
          write_scope: z.enum(["workspace", "readonly"]).optional(), mode: z.enum(["plan", "build", "edit"]).optional() } },
        async (args) => {
          fake.submitCalls += 1;
          fake.submitInputs.push(args);
          const grant = grantFor(args.workspace_id);
          if (!grant) return notAuthorized(args.workspace_id);
          const workspaceId =
            fake.spoofSubmitWorkspace ?? grant.workspace_id;
          // Z2C admission gate: the exact created session's observed binding
          // must verify for THIS workspace, or nothing is accepted.
          const binding = ws_is_attested(workspaceId) ? fake.submitBinding : null;
          if (!binding) return upstreamError("Z2C_BINDING_UNVERIFIED: session binding unverified for this workspace");
          if (args.idempotency_key) {
            for (const entry of fake.tasks.values()) {
              const proof = entry.view.idempotency as { key: string; request_fingerprint: string } | undefined;
              if (entry.view.workspace_id === workspaceId && proof?.key === args.idempotency_key) {
                if (proof.request_fingerprint !== nativeRequestFingerprint(args)) return upstreamError(`IDEMPOTENCY_CONFLICT: ${TEST_TOKEN}`);
                return { content: [{ type: "text", text: JSON.stringify({ ...entry.view, idempotency: { ...proof, replayed: true } }) }] };
              }
            }
          }
          const taskId = `z2c_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
          const view = {
            task_id: taskId,
            session_id: `sess_${randomUUID()}`,
            workspace_id: workspaceId,
            status: "queued",
            model_binding: { ...binding, source: "z2c-session-read" },
            ...(args.idempotency_key ? { idempotency: { protocol: "workspace-task-v1", key: args.idempotency_key,
              request_fingerprint: nativeRequestFingerprint(args), replayed: false } } : {}),
          };
          fake.tasks.set(taskKey(workspaceId, taskId), { view });
          if (fake.dropSubmitResponse) res.destroy();
          return { content: [{ type: "text", text: JSON.stringify(view) }] };
        },
      );
      mcp.registerTool("resolve_zcode_task_by_key", { inputSchema: { workspace_id: z.string(), idempotency_key: z.string() } }, async (args) => {
        fake.keyCalls += 1;
        const grant = grantFor(args.workspace_id);
        if (!grant) return notAuthorized(args.workspace_id);
        for (const entry of fake.tasks.values()) {
          const proof = entry.view.idempotency as { key: string } | undefined;
          if (entry.view.workspace_id === grant.workspace_id && proof?.key === args.idempotency_key) {
            return { content: [{ type: "text", text: JSON.stringify({ workspace_id: grant.workspace_id, idempotency_key: args.idempotency_key, key_state: "bound", task: entry.view }) }] };
          }
        }
        return { content: [{ type: "text", text: JSON.stringify({ workspace_id: grant.workspace_id, idempotency_key: args.idempotency_key, key_state: "unbound", task: null }) }] };
      });
      mcp.registerTool(
        "get_zcode_task",
        { inputSchema: { workspace_id: z.string().optional(), task_id: z.string() } },
        async (args) => {
          const grant = grantFor(args.workspace_id);
          if (!grant) return notAuthorized(args.workspace_id);
          const view = scopedView(grant.workspace_id, String(args.task_id));
          if (!view) return upstreamError("Z2C_TASK_UNKNOWN: no such task");
          const leaked: Record<string, unknown> = { ...view };
          if (fake.echoAuth) leaked.leaked_auth = auth;
          return { content: [{ type: "text", text: JSON.stringify(leaked) }] };
        },
      );
      mcp.registerTool(
        "cancel_zcode_task",
        { inputSchema: { workspace_id: z.string().optional(), task_id: z.string() } },
        async (args) => {
          fake.cancelCalls += 1;
          const grant = grantFor(args.workspace_id);
          if (!grant) return notAuthorized(args.workspace_id);
          const view = scopedView(grant.workspace_id, String(args.task_id));
          if (!view) return upstreamError("Z2C_TASK_UNKNOWN: no such task");
          view.status = "cancelled";
          return { content: [{ type: "text", text: JSON.stringify(view) }] };
        },
      );
      mcp.registerTool(
        "execution_output",
        { inputSchema: { workspace_id: z.string().optional(), task_id: z.string(), output_id: z.string() } },
        async (args) => {
          fake.outputCalls += 1;
          const grant = grantFor(args.workspace_id);
          if (!grant) return notAuthorized(args.workspace_id);
          if (!fake.outputBody) return upstreamError("Z2C_OUTPUT_UNKNOWN: no output");
          return { content: [{ type: "text", text: JSON.stringify(fake.outputBody) }] };
        },
      );
      mcp.registerTool("zcode_session_observe", { inputSchema: { workspace_id: z.string(), session_id: z.string() } }, async (args) => {
        fake.observeCalls += 1;
        const grant = grantFor(args.workspace_id);
        if (!grant) return notAuthorized(args.workspace_id);
        const view = [...fake.tasks.values()].map((t) => t.view).find((v) => v.workspace_id === grant.workspace_id && v.session_id === args.session_id);
        if (!view) return upstreamError("Z2C_BINDING_UNVERIFIED: session binding unverified for this workspace");
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              workspace_id: fake.spoofObserveWorkspace ?? grant.workspace_id,
              session_id: args.session_id,
              canonical_path: grant.canonical_path,
              workspace_path: grant.canonical_path,
              controlled_by_z2c: true,
              runtime_origin: "z2c",
              model_binding: { ...(view.model_binding as object), source: "desktop-session-read" },
            }),
          }],
        };
      });
      mcp.registerTool("zcode_session_discover", { inputSchema: { workspace_id: z.string() } }, async (args) => {
        const grant = grantFor(args.workspace_id);
        if (!grant) return notAuthorized(args.workspace_id);
        return { content: [{ type: "text", text: JSON.stringify({
          sessions: [...fake.tasks.values()]
            .map((t) => t.view)
            .filter((view) => view.workspace_id === grant.workspace_id && view.session_id)
            .map((view) => ({
              session_id: view.session_id,
              workspace_id: view.workspace_id,
              workspace_path: grant.canonical_path,
              controlled_by_z2c: true,
              owner_client_id: fake.discoveryOwner,
              runtime_origin: fake.discoveryOwner === "local" ? "z2c" : "external",
            })),
        }) }] };
      });
      mcp.registerTool("read_zcode_session", { inputSchema: { workspace_id: z.string(), session_id: z.string() } }, async () => {
        fake.readZcodeSessionCalls += 1;
        return upstreamError("OBSOLETE_TOOL: read_zcode_session is retired and must not be called");
      });
      mcp.registerTool(
        "resume_zcode_session",
        { inputSchema: { workspace_id: z.string(), session_id: z.string(), instruction: z.string(), idempotency_key: z.string().optional() } },
        async (args) => {
          fake.resumeCalls += 1;
          const grant = grantFor(args.workspace_id);
          if (!grant) return notAuthorized(args.workspace_id);
          const workspaceId = grant.workspace_id;
          const binding = ws_is_attested(workspaceId) ? fake.submitBinding : null;
          if (!binding) return upstreamError("Z2C_BINDING_UNVERIFIED: session binding unverified for this workspace");
          if (args.idempotency_key) {
            for (const entry of fake.tasks.values()) {
              const proof = entry.view.idempotency as { key: string; request_fingerprint: string } | undefined;
              if (entry.view.workspace_id === workspaceId && proof?.key === args.idempotency_key) {
                if (proof.request_fingerprint !== upstreamResumeFingerprint(args)) return upstreamError(`IDEMPOTENCY_CONFLICT: ${TEST_TOKEN}`);
                return { content: [{ type: "text", text: JSON.stringify({ ...entry.view, idempotency: { ...proof, replayed: true } }) }] };
              }
            }
          }
          const taskId = `z2c_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
          const view = {
            task_id: taskId,
            session_id: String(args.session_id),
            workspace_id: workspaceId,
            status: "queued",
            model_binding: { ...binding, source: "z2c-session-read" },
            ...(args.idempotency_key ? { idempotency: { protocol: "workspace-task-v1", key: args.idempotency_key,
              request_fingerprint: upstreamResumeFingerprint(args), replayed: false } } : {}),
          };
          fake.tasks.set(taskKey(workspaceId, taskId), { view });
          return { content: [{ type: "text", text: JSON.stringify(view) }] };
        },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      }
    });
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  server = httpServer;
  const addr = httpServer.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}/mcp`;
}

function healthyFake(): void {
  fake = {
    serverName: "z2c-service",
    providerName: ZCODE_NATIVE_REQUIRED_IDENTITY.provider,
    providerStatus: "healthy",
    capsOk: true,
    modelBinding: { ...SANCTIONED_BINDING },
    bindingWorkspace: NATIVE_C2C,
    submitBinding: { ...SANCTIONED_BINDING },
    echoAuth: false,
    ignoreWorkspaceScope: false,
    spoofSubmitWorkspace: null,
    spoofStatusWorkspace: null,
    spoofObserveWorkspace: null,
    outputBody: null,
    submitCalls: 0,
    statusCalls: 0,
    listCalls: 0,
    provisionCalls: 0,
    keyCalls: 0,
    dropSubmitResponse: false,
    authorizeEnabled: false,
    grants: [
      { workspace_id: NATIVE_C2C, canonical_path: C2C_CANONICAL, permissions: { read: true, write: true } },
      { workspace_id: NATIVE_ENG, canonical_path: ENG_CANONICAL, permissions: { read: true, write: true } },
    ],
    discoveryOwner: "local",
    provisionedIds: new Set<string>(),
    observeCalls: 0,
    readZcodeSessionCalls: 0,
    durableIdempotency: true,
    submitInputs: [],
    resumeCalls: 0,
    cancelCalls: 0,
    outputCalls: 0,
    tasks: new Map(),
  };
}

function client(): ZcodeNativeClient {
  // Production construction: the default resolver reads the A2C workspace
  // registry from the fixture state dir (C2C_STATE_DIR stubbed per test).
  return new ZcodeNativeClient({ url: baseUrl, token: TEST_TOKEN, requestTimeoutMs: 5000 });
}

function closeFakeServer(srv: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    srv.closeAllConnections();
    srv.close(() => resolve());
  });
}

beforeAll(() => {
  // Authoritative A2C registry fixture: the default root resolver reads this
  // registry (C2C_STATE_DIR), binding the public ids to the canonical roots.
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(STATE_DIR, "workspaces.json"), JSON.stringify({
    version: 1,
    workspaces: [
      { id: C2C_WS, name: "fixture-ai-startup", canonicalPath: C2C_CANONICAL, enabled: true, createdAt: new Date().toISOString() },
      { id: ENGINEERING_AI_WS, name: "fixture-ai-startup-engineering", canonicalPath: ENG_CANONICAL, enabled: true, createdAt: new Date().toISOString() },
    ],
  }));
});

afterAll(() => {
  rmSync(STATE_DIR, { recursive: true, force: true });
  rmSync(C2C_ROOT, { recursive: true, force: true });
  rmSync(ENG_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  // The fake Z2C server uses fixture workspace ids; never rely on an
  // operator's real forwarding allowlist being present on the test host.
  vi.stubEnv("ZCODE_NATIVE_ALLOWED_WORKSPACES", `${C2C_WS},${ENGINEERING_AI_WS}`);
  // The semantic lane (grant registry) is the authoritative mapping path —
  // point it at the fake upstream so ensureGrant resolves against it.
  vi.stubEnv("ZCODE_SESSION_URL", baseUrl);
  vi.stubEnv("ZCODE_SESSION_TOKEN", TEST_TOKEN);
  vi.stubEnv("C2C_STATE_DIR", STATE_DIR);
  resetZcodeSessionClientForTests();
  healthyFake();
  await startFakeZ2c();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetZcodeSessionClientForTests();
  resetZcodeNativeClientForTests();
  await closeFakeServer(server);
});

describe("zcode native client (observed identity, namespace, ownership)", () => {
  it("does not replay accepted submit when the response is lost", async () => {
    fake.dropSubmitResponse = true;
    await expect(client().submitTask({ workspace_id: C2C_WS, instruction: "x" }))
      .rejects.toMatchObject({ code: "ZCODE_NATIVE_OUTCOME_UNKNOWN" });
    expect(fake.submitCalls).toBe(1);
    expect(fake.tasks.size).toBe(1);
  });

  it("rejects foreign discovery before native resume", async () => {
    const submitted = await client().submitTask({ workspace_id: C2C_WS, instruction: "x" });
    fake.discoveryOwner = "other-client";
    await expect(client().resumeSession({ workspace_id: C2C_WS, session_id: submitted.session_id!, instruction: "continue" }))
      .rejects.toMatchObject({ code: "ZCODE_NATIVE_NOT_ATTESTED" });
    expect(fake.resumeCalls).toBe(0);
  });

  it("re-establishes the MCP session after an upstream restart with one transport retry", async () => {
    // Simulates Z2C restarting between calls: the first tools/call hits the
    // "Server not initialized" error a fresh upstream process returns for a
    // stale session id. The client must re-handshake and recover within the
    // same call instead of surfacing a transient failure.
    let rejectedOnce = false;
    const restarted = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const auth = req.headers.authorization ?? "";
        if (auth !== `Bearer ${TEST_TOKEN}`) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          method?: string; id?: number | null; params?: { arguments?: { workspace_id?: string } };
        };
        const reply = (payload: unknown, status = 200): void => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (body.method === "initialize") {
          reply({
            jsonrpc: "2.0", id: body.id ?? null,
            result: {
              protocolVersion: "2025-03-26", capabilities: { tools: {} },
              serverInfo: { name: "z2c-service", version: "0.1.0" },
            },
          });
          return;
        }
        if (body.method?.startsWith("notifications/")) { res.writeHead(202); res.end(); return; }
        if (body.method === "tools/call" && !rejectedOnce) {
          rejectedOnce = true;
          reply({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32000, message: "Bad Request: Server not initialized" } });
          return;
        }
        if (body.method === "tools/call" && body.params?.name === "zcode_workspace_list") {
          reply({
            jsonrpc: "2.0", id: body.id ?? null,
            result: { content: [{ type: "text", text: JSON.stringify({ workspaces: [{ workspace_id: NATIVE_C2C, canonical_path: C2C_CANONICAL }] }) }] },
          });
          return;
        }
        if (body.method === "tools/call") {
          reply({
            jsonrpc: "2.0", id: body.id ?? null,
            result: {
              content: [{
                type: "text",
                text: JSON.stringify({
                  provider: ZCODE_NATIVE_REQUIRED_IDENTITY.provider,
                  uses_desktop_managed_auth: true,
                  status: "healthy",
                  detail: null,
                  zcode_version: null,
                  capabilities: { ok: true, required: {} },
                  workspace_id: body.params?.arguments?.workspace_id ?? "",
                  durable_idempotency: "workspace-task-v1",
                  model_binding: { ...SANCTIONED_BINDING },
                }),
              }],
            },
          });
          return;
        }
        reply({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: "method not found" } });
      })().catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal" }));
        }
      });
    });
    await new Promise<void>((resolve) => restarted.listen(0, "127.0.0.1", () => resolve()));
    const addr = restarted.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    const restartUrl = `http://127.0.0.1:${addr.port}/mcp`;
    try {
      const status = await new ZcodeNativeClient({ url: restartUrl, token: TEST_TOKEN, requestTimeoutMs: 5000 }).status(C2C_WS);
      expect(status.available).toBe(true);
      expect(rejectedOnce).toBe(true);
    } finally {
      await closeFakeServer(restarted);
    }
  });
  it("server-owned probe verifies one task over the real native MCP client path without leaking server auth", async () => {
    fake.durableIdempotency = true;
    fake.echoAuth = true;
    const native = client();
    const result = await nativeSelfTest(C2C_WS, {
      providerStatus: id => native.providerStatus(id),
      projectWorkspace: id => native.projectWorkspace(id),
      submitNative: input => native.submitTask(input),
      snapshot: () => ({ queue: "a".repeat(64), writer: "b".repeat(64) }), cancel: input => native.cancelTask(input),
    });
    expect(result).toMatchObject({ overall: "PASS", replay_flags: [false, true], cleanup: "cancelled", conflict_code: "IDEMPOTENCY_CONFLICT" });
    expect(fake.tasks.size).toBe(1); expect(fake.submitCalls).toBe(3); expect(fake.cancelCalls).toBe(1);
    expect(JSON.stringify(result)).not.toContain(TEST_TOKEN);
  });
  it("transports a strictly validated key and verifies the keyed task proof over the projected payload", async () => {
    const input = { workspace_id: C2C_WS, instruction: "review exact source", write_scope: "readonly" as const, mode: "plan" as const, idempotency_key: "review_123-abc" };
    const nativePayload = { ...input, workspace_id: NATIVE_C2C };
    const view = await client().submitTask(input);
    expect(fake.submitInputs).toEqual([nativePayload]);
    expect(view.idempotency).toEqual({ protocol: "workspace-task-v1", key: input.idempotency_key, request_fingerprint: nativeRequestFingerprint(nativePayload), replayed: false });
  });
  it.each(["", "a/b", "a:b", "a\n", "-a", "é", "x".repeat(129)])("rejects unsafe key %j before dispatch", async key => {
    const c = client(), call = vi.spyOn(c, "callTool");
    await expect(c.submitTask({ workspace_id: C2C_WS, instruction: "review", idempotency_key: key })).rejects.toMatchObject({ code: "ZCODE_NATIVE_INSTRUCTION_REJECTED" });
    expect(call).not.toHaveBeenCalled(); expect(fake.submitCalls).toBe(0); expect(fake.listCalls).toBe(0);
  });
  it("blocks an old protocol before any upstream submit", async () => {
    fake.durableIdempotency = false;
    await expect(client().submitTask({ workspace_id: C2C_WS, instruction: "review", idempotency_key: "intent" })).rejects.toMatchObject({ upstreamCode: "IDEMPOTENCY_UPGRADE_REQUIRED" });
    expect(fake.submitCalls).toBe(0);
    await client().submitTask({ workspace_id: C2C_WS, instruction: "ordinary legacy caller" });
    expect(fake.submitCalls).toBe(1);
  });
  it.each(["missing", "key", "fingerprint", "protocol", "replayed", "workspace", "session", "model", "status"])("rejects invalid keyed response %s", async field => {
    const c = client(), input = { workspace_id: C2C_WS, instruction: "review", idempotency_key: "intent" };
    const invoke = c.callTool.bind(c);
    vi.spyOn(c, "callTool").mockImplementation(async (name, args) => {
      const raw = await invoke(name, args) as any;
      if (name === "submit_zcode_task") {
        if (field === "missing") delete raw.idempotency;
        else if (field === "workspace") raw.workspace_id = "wrong";
        else if (field === "session") raw.session_id = "bad";
        else if (field === "model") raw.model_binding.provider_id = "custom:foreign"; // route is the gated identity field
        else if (field === "status") raw.status = "garbage";
        else raw.idempotency[field === "fingerprint" ? "request_fingerprint" : field] = "wrong";
      }
      return raw;
    });
    await expect(c.submitTask(input)).rejects.toBeInstanceOf(ZcodeNativeError);
    expect(fake.submitCalls).toBe(1);
  });
  it("1. attests the sanctioned Desktop GLM binding only from a real reported binding", async () => {
    const status = await client().status(C2C_WS);
    expect(status.available).toBe(true);
    expect(status.desktop_managed_auth).toBe(true);
    expect(status.provider?.name).toBe("zcode-desktop");
    expect(status.capabilities_ok).toBe(true);
    expect(status.start_plan?.attested).toBe(true);
    expect(status.start_plan?.provider_id).toBe(ZCODE_NATIVE_REQUIRED_IDENTITY.provider_id);
    expect(status.start_plan?.model_id).toBe(ZCODE_NATIVE_REQUIRED_IDENTITY.model_id);
    expect(status.start_plan?.identity_source).toBe("control-plane-reported");
    expect(status.allowed_workspaces).toEqual([...nativeAllowedWorkspaces()]);
  });

  it("2. fails closed when the native control plane is unavailable", async () => {
    await closeFakeServer(server);
    const dead = new ZcodeNativeClient({ url: baseUrl, token: TEST_TOKEN, requestTimeoutMs: 2000 });
    const status = await dead.status(C2C_WS);
    expect(status.available).toBe(false);
    expect(status.reason).toBe("ZCODE_NATIVE_UNAVAILABLE");
    await expect(dead.submitTask({ workspace_id: C2C_WS, instruction: "hello" })).rejects.toMatchObject({
      code: "ZCODE_NATIVE_UNAVAILABLE",
    });
  });

  it("3. attests the OBSERVED binding on the admissible route (catalog policy 2026-09-28: any advertised model)", async () => {
    fake.modelBinding = { provider_id: ZCODE_NATIVE_REQUIRED_IDENTITY.provider_id, model_id: ZCODE_NATIVE_REQUIRED_IDENTITY.model_id };
    fake.submitBinding = { ...fake.modelBinding };
    const status = await client().status(C2C_WS);
    expect(status.start_plan?.attested).toBe(true);
    expect(status.start_plan?.provider_id).toBe("builtin:zai-coding-plan");
    expect(status.start_plan?.model_id).toBe(ZCODE_NATIVE_REQUIRED_IDENTITY.model_id);
    expect(status.start_plan?.mismatches).toEqual([]);
    const view = await client().submitTask({ workspace_id: C2C_WS, instruction: "x" });
    expect(view.model_binding).toMatchObject({ provider_id: "builtin:zai-coding-plan", model_id: ZCODE_NATIVE_REQUIRED_IDENTITY.model_id });
  });

  it("4. attests the main model on the admissible route (2026-09-28 catalog policy: no single-model gate)", async () => {
    fake.modelBinding = { provider_id: ZCODE_NATIVE_REQUIRED_IDENTITY.provider_id, model_id: "GLM-5.3" };
    fake.submitBinding = { ...fake.modelBinding };
    const status = await client().status(C2C_WS);
    expect(status.start_plan?.attested).toBe(true);
    expect(status.start_plan?.model_id).toBe("GLM-5.3");
    expect(status.start_plan?.mismatches).toEqual([]);
    const view = await client().submitTask({ workspace_id: C2C_WS, instruction: "x" });
    expect(view.model_binding).toMatchObject({ provider_id: "builtin:zai-coding-plan", model_id: "GLM-5.3" });
  });

  it("4a. rejects an unobserved/foreign-route binding even under the catalog policy", async () => {
    fake.modelBinding = { provider_id: "custom:foreign", model_id: "GLM-5.3" };
    fake.submitBinding = { ...fake.modelBinding };
    const status = await client().status(C2C_WS);
    expect(status.start_plan?.attested).toBe(false);
    expect(status.start_plan?.mismatches.join(";")).toContain("provider_id=custom:foreign");
    await expect(client().submitTask({ workspace_id: C2C_WS, instruction: "x" })).rejects.toMatchObject({
      code: "ZCODE_NATIVE_NOT_ATTESTED",
    });
  });

  it("4b. rejects the RETIRED start-plan identity builtin:zai-start-plan/GLM-5.3-Flash (unentitled route)", async () => {
    fake.modelBinding = { provider_id: "builtin:zai-start-plan", model_id: "GLM-5.3-Flash" };
    fake.submitBinding = { ...fake.modelBinding };
    const status = await client().status(C2C_WS);
    expect(status.start_plan?.attested).toBe(false);
    expect(status.start_plan?.mismatches.join(";")).toContain("provider_id=builtin:zai-start-plan");
    await expect(client().submitTask({ workspace_id: C2C_WS, instruction: "x" })).rejects.toMatchObject({
      code: "ZCODE_INCOMPATIBLE_PROVIDER_VERSION",
    });
  });

  it("5. reports desktop-managed auth from status; submit identity is the observed task binding", async () => {
    fake.providerName = "zcode"; // headless ZcodeProvider name
    const status = await client().status(C2C_WS);
    expect(status.desktop_managed_auth).toBe(false);
    expect(status.start_plan?.attested).toBe(false);
    expect(status.start_plan?.mismatches.join(";")).toContain("provider=zcode");
    // Status never gates creation: identity is proven per task by the binding
    // Z2C observed for the exact session at admission.
    const submitted = await client().submitTask({ workspace_id: C2C_WS, instruction: "x" });
    expect(submitted.model_binding?.provider_id).toBe(ZCODE_NATIVE_REQUIRED_IDENTITY.provider_id);
    expect(submitted.model_binding?.model_id).toBe(ZCODE_NATIVE_REQUIRED_IDENTITY.model_id);
  });

  it("6. idle status stays UNKNOWN and does not block; admission proves identity per task", async () => {
    fake.modelBinding = null; // no observable workspace session yet
    const status = await client().status(C2C_WS);
    expect(status.start_plan?.attested).toBe(false);
    expect(status.start_plan?.provider_id).toBe("UNKNOWN");
    expect(status.start_plan?.model_id).toBe("UNKNOWN");
    expect(status.start_plan?.identity_source).toBe("unobserved");
    expect(status.start_plan?.mismatches.join(";")).toContain("model_binding unobserved");
    // Submit still works: Z2C creates/resumes the exact session, observes its
    // binding via the exact-session read, and returns it with the task.
    const submitted = await client().submitTask({ workspace_id: C2C_WS, instruction: "x" });
    expect(submitted.task_id).toMatch(/^z2c_/);
    expect(submitted.session_id).toMatch(/^sess_[0-9a-f-]{36}$/i);
    expect(submitted.model_binding).toEqual({
      provider_id: ZCODE_NATIVE_REQUIRED_IDENTITY.provider_id,
      model_id: ZCODE_NATIVE_REQUIRED_IDENTITY.model_id,
      source: "z2c-session-read",
    });
    const resumed = await client().resumeSession({
      workspace_id: C2C_WS,
      session_id: submitted.session_id!,
      instruction: "continue",
    });
    expect(resumed.model_binding).toEqual(submitted.model_binding);
  });

  it("6b. attests per workspace: another workspace's binding never authorizes this one", async () => {
    // The fake reports the Start Plan binding only for the C2C fixture grant.
    const eng = await client().status(ENGINEERING_AI_WS);
    expect(eng.available).toBe(true);
    expect(eng.workspace_id).toBe(ENGINEERING_AI_WS);
    expect(eng.start_plan?.attested).toBe(false);
    expect(eng.start_plan?.provider_id).toBe("UNKNOWN");
    expect(eng.start_plan?.identity_source).toBe("unobserved");
    // Submit into the other workspace: Z2C's admission cannot verify this
    // workspace's exact-session binding and accepts nothing.
    await expect(
      client().submitTask({ workspace_id: ENGINEERING_AI_WS, instruction: "x" }),
    ).rejects.toMatchObject({ code: "ZCODE_NATIVE_UPSTREAM", upstreamCode: "Z2C_BINDING_UNVERIFIED" });
    // Resume into the other workspace is equally unauthorized.
    await expect(
      client().resumeSession({
        workspace_id: ENGINEERING_AI_WS,
        session_id: `sess_${randomUUID()}`,
        instruction: "x",
      }),
    ).rejects.toMatchObject({ code: "ZCODE_NATIVE_UPSTREAM", upstreamCode: "Z2C_BINDING_UNVERIFIED" });
    for (const entry of fake.tasks.values()) {
      expect(entry.view.workspace_id).not.toBe(ENGINEERING_AI_WS);
    }
    // The attested workspace itself still submits.
    const own = await client().status(C2C_WS);
    expect(own.workspace_id).toBe(C2C_WS);
    expect(own.start_plan?.attested).toBe(true);
    const submitted = await client().submitTask({ workspace_id: C2C_WS, instruction: "x" });
    expect(submitted.task_id).toMatch(/^z2c_/);
  });

  it("7. enforces the governed workspace allowlist before any network call", async () => {
    await expect(
      client().submitTask({ workspace_id: "attacker-ws", instruction: "x" }),
    ).rejects.toMatchObject({ code: "ZCODE_NATIVE_WORKSPACE_FORBIDDEN" });
    expect(fake.submitCalls).toBe(0);
    await expect(
      client().resumeSession({ workspace_id: "some-ws", session_id: `sess_${randomUUID()}`, instruction: "x" }),
    ).rejects.toMatchObject({ code: "ZCODE_NATIVE_WORKSPACE_FORBIDDEN" });
    expect(fake.resumeCalls).toBe(0);
  });

  it("8. submits and reads back native tasks with stable Z2C ids under the A2C namespace", async () => {
    const submitted = await client().submitTask({
      workspace_id: C2C_WS,
      instruction: "Read-only inspection task.",
      write_scope: "readonly",
      mode: "plan",
    });
    expect(submitted.task_id).toMatch(/^z2c_/);
    expect(submitted.session_id).toMatch(/^sess_[0-9a-f-]{36}$/i);
    expect(submitted.workspace_id).toBe(C2C_WS);
    expect(submitted.status).toBe("queued");
    expect(submitted.model_binding).toEqual({
      provider_id: ZCODE_NATIVE_REQUIRED_IDENTITY.provider_id,
      model_id: ZCODE_NATIVE_REQUIRED_IDENTITY.model_id,
      source: "z2c-session-read",
    });
    const fetched = await client().getTask({ workspace_id: C2C_WS, task_id: submitted.task_id });
    expect(fetched.task_id).toBe(submitted.task_id);
    expect(fetched.status).toBe("queued");
    expect(fetched.workspace_id).toBe(C2C_WS);
  });

  it("9. cancels a native task", async () => {
    fake.bindingWorkspace = NATIVE_ENG; // attestation is per dispatch target
    const submitted = await client().submitTask({ workspace_id: ENGINEERING_AI_WS, instruction: "slow task" });
    const cancelled = await client().cancelTask({ workspace_id: ENGINEERING_AI_WS, task_id: submitted.task_id });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.task_id).toBe(submitted.task_id);
    expect(cancelled.workspace_id).toBe(ENGINEERING_AI_WS);
  });

  it("exact-session read rejects workspace/model mismatch before any send", async () => {
    const first = await client().submitTask({ workspace_id: C2C_WS, instruction: "x" });
    const input = { workspace_id: C2C_WS, session_id: first.session_id!, instruction: "bounded canary" };
    const observed = await client().readSession(input);
    expect(observed.model_binding.model_id).toBe(ZCODE_NATIVE_REQUIRED_IDENTITY.model_id);
    expect(observed.workspace_id).toBe(C2C_WS);
    expect(fake.observeCalls).toBeGreaterThanOrEqual(1);
    expect(fake.readZcodeSessionCalls).toBe(0);
    await expect(client().resumeSession({ ...input, expected_workspace_path: tmpdir() })).rejects.toMatchObject({ code: "ZCODE_NATIVE_NAMESPACE_MISMATCH" });
    const view = fake.tasks.get(taskKey(NATIVE_C2C, first.task_id))!.view;
    view.model_binding = { provider_id: "other", model_id: "other" };
    await expect(client().resumeSession(input)).rejects.toMatchObject({ code: "ZCODE_NATIVE_NOT_ATTESTED" });
    expect(fake.resumeCalls).toBe(0);
    expect(fake.readZcodeSessionCalls).toBe(0);
  });

  it("regression: read_zcode_session is never called by the native client", async () => {
    const first = await client().submitTask({ workspace_id: C2C_WS, instruction: "read check" });
    const observed = await client().readSession({ workspace_id: C2C_WS, session_id: first.session_id! });
    expect(observed.session_id).toBe(first.session_id);
    expect(fake.observeCalls).toBeGreaterThan(0);
    expect(fake.readZcodeSessionCalls).toBe(0);
  });

  it("10. resumes an existing native session bound to the same sess_* id", async () => {
    const first = await client().submitTask({ workspace_id: C2C_WS, instruction: "first turn" });
    expect(first.session_id).not.toBeNull();
    const resumed = await client().resumeSession({
      workspace_id: C2C_WS,
      session_id: first.session_id!,
      instruction: "continue the work",
    });
    expect(resumed.task_id).toMatch(/^z2c_/);
    expect(resumed.task_id).not.toBe(first.task_id);
    expect(resumed.session_id).toBe(first.session_id);
    expect(resumed.workspace_id).toBe(C2C_WS);
  });

  it("11. never serializes the bearer/registration token into responses", async () => {
    fake.echoAuth = true;
    const submitted = await client().submitTask({ workspace_id: C2C_WS, instruction: "x" });
    const view = await client().getTask({ workspace_id: C2C_WS, task_id: submitted.task_id });
    expect(JSON.stringify(view)).not.toContain(TEST_TOKEN);
    expect(view.leaked_auth).toBeUndefined();
    const status = await client().status(C2C_WS);
    expect(JSON.stringify(status)).not.toContain(TEST_TOKEN);
  });

  it("12. keeps the old free-window queue fully independent", async () => {
    const root = makeTmpDir("zcode-native-legacy");
    try {
      const control = new ZcodeControl(root);
      const legacy = await control.enqueue({
        role: "worker",
        priority: 0,
        instruction: "Free-window legacy task.",
      });
      const queueBefore = readFileSync(join(root, "queue.jsonl"), "utf8");
      const native = await client().submitTask({ workspace_id: C2C_WS, instruction: "native task" });
      expect(native.task_id).toMatch(/^z2c_/);
      expect(legacy.task_id).toMatch(/^zcode_/);
      expect(readFileSync(join(root, "queue.jsonl"), "utf8")).toBe(queueBefore);
    } finally {
      cleanup(root);
    }
  });

  it("13. never falls back to the free-window queue when native is down", async () => {
    const root = makeTmpDir("zcode-native-nofallback");
    try {
      const control = new ZcodeControl(root);
      const legacy = await control.enqueue({ role: "worker", priority: 0, instruction: "legacy" });
      const queueBefore = readFileSync(join(root, "queue.jsonl"), "utf8");
      await closeFakeServer(server);
      const dead = new ZcodeNativeClient({ url: baseUrl, token: TEST_TOKEN, requestTimeoutMs: 2000 });
      await expect(dead.submitTask({ workspace_id: C2C_WS, instruction: "should not fall back" })).rejects.toMatchObject(
        { code: "ZCODE_NATIVE_UNAVAILABLE" },
      );
      expect(readFileSync(join(root, "queue.jsonl"), "utf8")).toBe(queueBefore);
      expect(legacy.task_id).toMatch(/^zcode_/);
    } finally {
      cleanup(root);
    }
  });

  it("14. rejects cross-workspace get", async () => {
    const submitted = await client().submitTask({ workspace_id: C2C_WS, instruction: "x" });
    await expect(
      client().getTask({ workspace_id: ENGINEERING_AI_WS, task_id: submitted.task_id }),
    ).rejects.toMatchObject({ code: "ZCODE_NATIVE_UPSTREAM", upstreamCode: "Z2C_TASK_UNKNOWN" });
  });

  it("15. rejects cross-workspace cancel before any upstream mutation", async () => {
    const submitted = await client().submitTask({ workspace_id: C2C_WS, instruction: "x" });
    await expect(
      client().cancelTask({ workspace_id: ENGINEERING_AI_WS, task_id: submitted.task_id }),
    ).rejects.toMatchObject({ code: "ZCODE_NATIVE_UPSTREAM", upstreamCode: "Z2C_TASK_UNKNOWN" });
    expect(fake.cancelCalls).toBe(0);
    const stored = fake.tasks.get(taskKey(NATIVE_C2C, submitted.task_id))!.view;
    expect(stored.status).toBe("queued");
  });

  it("16. rejects a returned task whose native workspace mismatches the projection", async () => {
    fake.spoofSubmitWorkspace = NATIVE_ENG;
    fake.bindingWorkspace = NATIVE_ENG; // upstream accepts, but the returned namespace is wrong
    await expect(
      client().submitTask({ workspace_id: C2C_WS, instruction: "namespace probe" }),
    ).rejects.toMatchObject({ code: "ZCODE_NATIVE_NAMESPACE_MISMATCH" });
    fake.spoofSubmitWorkspace = null;
    fake.bindingWorkspace = NATIVE_C2C;
    fake.ignoreWorkspaceScope = true;
    const submitted = await client().submitTask({ workspace_id: C2C_WS, instruction: "namespace probe 2" });
    await expect(
      client().getTask({ workspace_id: ENGINEERING_AI_WS, task_id: submitted.task_id }),
    ).rejects.toMatchObject({ code: "ZCODE_NATIVE_NAMESPACE_MISMATCH" });
  });

  it("16b. reports a provider_status bound to another native workspace as a namespace failure (fail closed)", async () => {
    fake.spoofStatusWorkspace = NATIVE_ENG;
    const status = await client().status(C2C_WS);
    expect(status.available).toBe(false);
    expect(status.reason).toBe("ZCODE_NATIVE_NAMESPACE_MISMATCH");
  });

  it("17. rejects a service that does not present the z2c-service handshake", async () => {
    fake.serverName = "quanta-local";
    const status = await client().status(C2C_WS);
    expect(status.available).toBe(false);
    expect(status.reason).toBe("ZCODE_NATIVE_SERVICE_MISMATCH");
    await expect(client().submitTask({ workspace_id: C2C_WS, instruction: "x" })).rejects.toMatchObject({
      code: "ZCODE_NATIVE_SERVICE_MISMATCH",
    });
    expect(fake.submitCalls).toBe(0);
  });

  it("18. enforces execution-output ownership and bounds released text", async () => {
    const submitted = await client().submitTask({ workspace_id: C2C_WS, instruction: "produce output" });
    const sessionId = submitted.session_id!;
    // Ownership probe first: the queued task references no output yet, so the
    // requested output_id cannot belong to it and no upstream call may happen.
    fake.outputBody = {
      output_id: "out_requested",
      task_id: submitted.task_id,
      session_id: sessionId,
      text: "should not be reachable",
    };
    await expect(
      client().executionOutput({
        workspace_id: C2C_WS,
        task_id: submitted.task_id,
        output_id: "out_requested",
      }),
    ).rejects.toMatchObject({ code: "ZCODE_NATIVE_NAMESPACE_MISMATCH" });
    expect(fake.outputCalls).toBe(0);
    fake.tasks.get(taskKey(NATIVE_C2C, submitted.task_id))!.view.output_id = "out_requested";

    const longText = "Z".repeat(20000);
    fake.outputBody = {
      output_id: "out_requested",
      task_id: submitted.task_id,
      session_id: sessionId,
      text: longText,
    };
    const out = await client().executionOutput({
      workspace_id: C2C_WS,
      task_id: submitted.task_id,
      output_id: "out_requested",
    });
    expect(out.text.length).toBeLessThanOrEqual(16000 + "…[truncated]".length);
    expect(out.text.endsWith("…[truncated]")).toBe(true);
    expect(out.task_id).toBe(submitted.task_id);
    expect(out.session_id).toBe(sessionId);
    expect(out.workspace_id).toBe(C2C_WS);
  });
});

describe("A2C → native workspace projection (authoritative mapping, fail closed)", () => {
  it("projects the authorized A2C id onto its native grant id upstream and restores it on release", async () => {
    const status = await client().status(C2C_WS);
    // Upstream saw the NATIVE grant id (the fake resolves it from its grant
    // registry — an A2C id would have been rejected with "not authorized").
    expect(fake.statusCalls).toBe(1);
    expect(status.available).toBe(true);
    expect(status.workspace_id).toBe(C2C_WS); // released namespace is the A2C id

    const submitted = await client().submitTask({ workspace_id: C2C_WS, instruction: "mapped submit" });
    expect(fake.submitInputs[0]!.workspace_id).toBe(NATIVE_C2C);
    expect(submitted.workspace_id).toBe(C2C_WS);
    expect([...fake.tasks.keys()].every((key) => key.startsWith(`${NATIVE_C2C}|`))).toBe(true);

    const fetched = await client().getTask({ workspace_id: C2C_WS, task_id: submitted.task_id });
    expect(fetched.workspace_id).toBe(C2C_WS);
    expect(fetched.task_id).toBe(submitted.task_id);
  });

  it("rejects an unregistered A2C workspace before any upstream call", async () => {
    vi.stubEnv("ZCODE_NATIVE_ALLOWED_WORKSPACES", `${C2C_WS},${ENGINEERING_AI_WS},${UNREGISTERED_WS}`);
    const submitted = client().submitTask({ workspace_id: UNREGISTERED_WS, instruction: "no registry entry" });
    await expect(submitted).rejects.toMatchObject({ code: "ZCODE_NATIVE_WORKSPACE_FORBIDDEN" });
    expect(fake.submitCalls).toBe(0);
    expect(fake.statusCalls).toBe(0);
    expect(fake.listCalls).toBe(0);
    await expect(client().status(UNREGISTERED_WS)).rejects.toMatchObject({ code: "ZCODE_NATIVE_WORKSPACE_FORBIDDEN" });
    expect(fake.statusCalls).toBe(0);
  });

  it("fails closed when the grant registry cannot be resolved (projection surface broken)", async () => {
    // The projection resolves through the SAME connection as the task lane
    // (one z2c service). Break the grant surface: the projection cannot be
    // established, so the native mutation must not leave.
    const c = client();
    const transport = (c as unknown as { transport: { callTool: (name: string, args: Record<string, unknown>, timeout?: number, before?: () => void) => Promise<unknown> } }).transport;
    const invoke = transport.callTool.bind(transport);
    vi.spyOn(transport, "callTool").mockImplementation(async (name, args, timeout, beforeDispatch) => {
      if (name === "zcode_workspace_list") {
        throw new ZcodeSessionError("ZCODE_SESSION_UPSTREAM", "grant registry unavailable", "GRANT_SURFACE_DOWN");
      }
      return invoke(name, args, timeout, beforeDispatch);
    });
    await expect(c.submitTask({ workspace_id: C2C_WS, instruction: "lane down" }))
      .rejects.toMatchObject({ code: "ZCODE_NATIVE_UPSTREAM" });
    expect(fake.submitCalls).toBe(0);
  });

  it("fails closed when the grant registry returns no usable workspace id", async () => {
    fake.grants = []; // no grant, provisioning disabled
    await expect(client().status(C2C_WS)).rejects.toMatchObject({ code: "ZCODE_NATIVE_UPSTREAM" });
    expect(fake.statusCalls).toBe(0);
    expect(fake.provisionCalls).toBe(0);
  });

  it("provisions the missing grant through the authoritative REST path, then reuses it", async () => {
    fake.grants = []; // nothing mirrored yet
    fake.authorizeEnabled = true;
    const submitted = await client().submitTask({ workspace_id: C2C_WS, instruction: "first contact" });
    expect(fake.provisionCalls).toBe(1);
    expect(submitted.workspace_id).toBe(C2C_WS);
    const provisionedId = fake.submitInputs[0]!.workspace_id;
    expect(String(provisionedId)).toMatch(/^ws_/);
    expect(fake.grants.map((grant) => grant.workspace_id)).toContain(provisionedId);
    // The mapping is now established: no further provisioning.
    await client().submitTask({ workspace_id: C2C_WS, instruction: "second contact" });
    expect(fake.provisionCalls).toBe(1);
  });

  it("upgrades a cached read projection for write and never downgrades it on observation", async () => {
    fake.grants[0]!.permissions = { read: true, write: false };
    fake.authorizeEnabled = true;
    const c = client();
    await c.projectWorkspace(C2C_WS, false);
    expect(fake.provisionCalls).toBe(0);
    await c.projectWorkspace(C2C_WS, true);
    expect(fake.provisionCalls).toBe(1);
    expect(fake.grants[0]!.permissions).toEqual({ read: true, write: true });
    c.invalidateWorkspaceProjection();
    await c.projectWorkspace(C2C_WS, false);
    await c.projectWorkspace(C2C_WS, true);
    expect(fake.provisionCalls).toBe(1);
  });

  it("keeps submit/get/cancel/output/key-resolution/resume consistent across both namespaces", async () => {
    const key = "roundtrip_key-1";
    const input = { workspace_id: C2C_WS, instruction: "full round trip", write_scope: "workspace" as const, idempotency_key: key };
    const submitted = await client().submitTask(input);
    expect(submitted.workspace_id).toBe(C2C_WS);

    // Keyed resolution: proof fingerprint is the projected (native) payload's.
    const resolved = await client().resolveKeyedTask({ workspace_id: C2C_WS, idempotency_key: key },
      nativeRequestFingerprint({ ...input, workspace_id: NATIVE_C2C }));
    expect(resolved?.task_id).toBe(submitted.task_id);
    expect(resolved?.workspace_id).toBe(C2C_WS);
    expect(resolved?.idempotency?.replayed).toBe(false);
    // A wrong expected fingerprint fails closed.
    await expect(client().resolveKeyedTask({ workspace_id: C2C_WS, idempotency_key: key }, "0".repeat(64)))
      .rejects.toMatchObject({ upstreamCode: "IDEMPOTENCY_INVALID" });
    expect(fake.keyCalls).toBe(2);

    // Replay proves idempotent admission under the same key.
    const replayed = await client().submitTask(input);
    expect(replayed.task_id).toBe(submitted.task_id);
    expect(replayed.idempotency?.replayed).toBe(true);

    const fetched = await client().getTask({ workspace_id: C2C_WS, task_id: submitted.task_id });
    expect(fetched.workspace_id).toBe(C2C_WS);

    fake.tasks.get(taskKey(NATIVE_C2C, submitted.task_id))!.view.output_id = "out_rt";
    fake.outputBody = { output_id: "out_rt", task_id: submitted.task_id, session_id: submitted.session_id, text: "round trip" };
    const out = await client().executionOutput({ workspace_id: C2C_WS, task_id: submitted.task_id, output_id: "out_rt" });
    expect(out.workspace_id).toBe(C2C_WS);
    expect(out.text).toBe("round trip");

    const resumed = await client().resumeSession({
      workspace_id: C2C_WS,
      session_id: submitted.session_id!,
      instruction: "continue",
      idempotency_key: "roundtrip_resume-1",
    });
    expect(resumed.workspace_id).toBe(C2C_WS);
    expect(resumed.session_id).toBe(submitted.session_id);

    const cancelled = await client().cancelTask({ workspace_id: C2C_WS, task_id: resumed.task_id });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.workspace_id).toBe(C2C_WS);
    // Every upstream payload carried the native id, never the A2C id.
    expect(fake.submitInputs.every((payload) => payload.workspace_id === NATIVE_C2C)).toBe(true);
  });

  it("readSession rejects an observe result bound to another native workspace", async () => {
    const submitted = await client().submitTask({ workspace_id: C2C_WS, instruction: "observe probe" });
    fake.spoofObserveWorkspace = NATIVE_ENG;
    await expect(client().readSession({ workspace_id: C2C_WS, session_id: submitted.session_id! }))
      .rejects.toMatchObject({ code: "ZCODE_NATIVE_NAMESPACE_MISMATCH" });
  });
});

describe("zcode native tool layer (principal authorization + shared gates)", () => {
  function buildHarness(gate: (ws: string, authInfo: unknown, write: boolean) => void, harnessStateDir?: string) {
    const server = new McpServer({ name: "stub-c2c", version: "0.0.0" });
    const effectiveStateDir = harnessStateDir ?? mkdtempSync(join(tmpdir(), "zcode-native-harness-state-"));
    registerZcodeNativeTools(server, {
      requireScope: () => null,
      resolveWorkspace: (requestedId: string) => {
        if (requestedId === "unauthorized-ws") {
          throw Object.assign(new Error("Workspace is not authorized for this identity"), {
            code: "WORKSPACE_NOT_AUTHORIZED",
          });
        }
        return { id: requestedId, root: requestedId === C2C_WS ? C2C_CANONICAL : requestedId === ENGINEERING_AI_WS ? ENG_CANONICAL : process.cwd() };
      },
      taskGate: gate,
      nativeAdmissionSnapshot: () => ({ queue: "a".repeat(64), writer: "b".repeat(64) }),
      writerManagerFor: () => ({
        submitNative: input => client().submitTask(input),
        resumeNative: input => client().resumeSession(input),
        getNative: input => client().getTask(input),
        cancelNative: input => client().cancelTask(input),
        outputNative: input => client().executionOutput(input),
      }),
      stateDir: effectiveStateDir,
      ok: (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] }),
      fail: (code: string, message: string) => ({
        content: [{ type: "text", text: `${code}: ${message}` }],
        isError: true,
      }),
      mapError: (error: unknown) => {
        const code = (error as { code?: string })?.code ?? "INTERNAL_ERROR";
        const message = (error as Error)?.message ?? String(error);
        return { content: [{ type: "text", text: `${code}: ${message}` }], isError: true };
      },
      untrustedNote: "note",
    });
    const invoke = async (
      name: string,
      args: Record<string, unknown>,
      authInfo: unknown = { clientId: "tester", scopes: [] },
    ) => {
      const tool = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>; inputSchema: { parse: (a: unknown) => unknown } }> })._registeredTools[name];
      const parsed = tool.inputSchema.parse(args);
      const result = await tool.handler(parsed, { authInfo });
      const text = result.content[0]!.text;
      if (result.isError) {
        // Error texts are "<CODE>: <message>" (see the fail/mapError stubs).
        const sep = text.indexOf(": ");
        const code = sep > 0 && /^[A-Z][A-Z0-9_]+$/.test(text.slice(0, sep)) ? text.slice(0, sep) : "UNKNOWN";
        return { error: code, message: sep > 0 ? text.slice(sep + 2) : text, isError: true };
      }
      return { ...JSON.parse(text), isError: false };
    };
    return { invoke, stateDir: effectiveStateDir };
  }

  it("MCP self-test uses the governed manager and daemon native client and returns bounded evidence", async () => {
    fake.durableIdempotency = true;
    fake.echoAuth = true;
    const gate = vi.fn();
    const result = await buildHarness(gate).invoke("zcode_native_self_test", { workspace_id: C2C_WS });
    expect(result).toMatchObject({ overall: "PASS", cleanup: "cancelled", identity: { workspace_id: C2C_WS }, isError: false });
    expect(fake.tasks.size).toBe(1); expect(fake.submitCalls).toBe(3);
    expect(gate).toHaveBeenCalledWith(C2C_WS, expect.anything(), false);
    expect(JSON.stringify(result)).not.toContain(TEST_TOKEN);
  });

  beforeEach(() => {
    vi.stubEnv("ZCODE_NATIVE_URL", baseUrl);
    vi.stubEnv("ZCODE_NATIVE_TOKEN", TEST_TOKEN);
    const localAppData = join(tmpdir(), "zcode-native-mcp-harness-empty");
    rmSync(join(localAppData, "z2c", "security.json"), { force: true });
    vi.stubEnv("LOCALAPPDATA", localAppData);
    resetZcodeNativeClientForTests();
  });

  it("19. rejects an unauthorized principal workspace before any upstream call", async () => {
    const { invoke } = buildHarness(() => {});
    const result = await invoke("zcode_native_submit_task", {
      workspace_id: "unauthorized-ws",
      instruction: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.error ?? result.code ?? "").toBe("WORKSPACE_NOT_AUTHORIZED");
    expect(fake.submitCalls).toBe(0);
    const resumed = await invoke("zcode_native_resume_session", {
      workspace_id: "unauthorized-ws",
      session_id: `sess_${randomUUID()}`,
      instruction: "x",
    });
    expect(resumed.isError).toBe(true);
    expect(fake.resumeCalls).toBe(0);
  });

  it("20. blocked (paused/frozen) queue blocks submit and resume", async () => {
    const { invoke } = buildHarness((_ws, _auth, write) => {
      if (write) throw Object.assign(new Error("Workspace queue is paused"), { code: "TASK_NOT_AUTHORIZED" });
    });
    const result = await invoke("zcode_native_submit_task", { workspace_id: C2C_WS, instruction: "x" });
    expect(result.isError).toBe(true);
    expect(result.error ?? "").toBe("TASK_NOT_AUTHORIZED");
    expect(fake.submitCalls).toBe(0);
    const resumed = await invoke("zcode_native_resume_session", {
      workspace_id: C2C_WS,
      session_id: `sess_${randomUUID()}`,
      instruction: "x",
    });
    expect(resumed.isError).toBe(true);
    expect(fake.resumeCalls).toBe(0);
  });

  it("21. cancel of an authorized task still works while submissions are frozen", async () => {
    const { invoke } = buildHarness((_ws, _auth, write) => {
      if (write) throw Object.assign(new Error("Workspace queue is paused"), { code: "TASK_NOT_AUTHORIZED" });
    });
    const submitted = await client().submitTask({ workspace_id: C2C_WS, instruction: "to cancel" });
    const cancelled = await invoke("zcode_native_cancel_task", {
      workspace_id: C2C_WS,
      task_id: submitted.task_id,
    });
    expect(cancelled.isError).toBe(false);
    expect(cancelled.status).toBe("cancelled");
    expect(fake.cancelCalls).toBe(1);
  });

  it("22. busy writer slot blocks write-scope submit but allows readonly", async () => {
    const { invoke } = buildHarness((_ws, _auth, write) => {
      if (write) throw Object.assign(new Error("Workspace writer slot is busy"), { code: "TASK_NOT_AUTHORIZED" });
    });
    const writeResult = await invoke("zcode_native_submit_task", {
      workspace_id: C2C_WS,
      instruction: "write task",
    });
    expect(writeResult.isError).toBe(true);
    expect(fake.submitCalls).toBe(0);
    const readonlyResult = await invoke("zcode_native_submit_task", {
      workspace_id: C2C_WS,
      instruction: "readonly task",
      write_scope: "readonly",
    });
    expect(readonlyResult.isError).toBe(false);
    expect(readonlyResult.task_id).toMatch(/^z2c_/);
  });

  it("23. execution_output projects sanitized bounded text only", async () => {
    const { invoke } = buildHarness(() => {});
    const submitted = await client().submitTask({ workspace_id: C2C_WS, instruction: "audit me" });
    const requestedOutputId = submitted.output_id ?? "out_1";
    fake.tasks.get(taskKey(NATIVE_C2C, submitted.task_id))!.view.output_id = requestedOutputId;
    fake.outputBody = {
      output_id: submitted.output_id ?? "out_1",
      task_id: submitted.task_id,
      session_id: submitted.session_id,
      text:
        "result line\n" +
        'api_key = sk-verysecretvalue123\n' +
        "see F:\\Users\\alice\\secret\\plan.md for details\n" +
        "G".repeat(20000),
    };
    const out = await invoke("zcode_native_execution_output", {
      workspace_id: C2C_WS,
      task_id: submitted.task_id,
      output_id: submitted.output_id ?? "out_1",
    });
    expect(out.isError).toBe(false);
    expect(out.text).not.toContain("sk-verysecretvalue123");
    expect(out.text).toContain("[REDACTED]");
    expect(out.text).not.toContain("F:\\Users\\alice\\secret\\plan.md");
    expect(out.text.length).toBeLessThanOrEqual(16000 + "…[truncated]".length);
    expect(out.task_id).toBe(submitted.task_id);
    expect(out.workspace_id).toBe(C2C_WS);
  });

  it("24. execution_output rejects an output not owned by the task", async () => {
    const { invoke } = buildHarness(() => {});
    const submitted = await client().submitTask({ workspace_id: C2C_WS, instruction: "no output yet" });
    fake.outputBody = {
      output_id: "some_other_output",
      task_id: submitted.task_id,
      session_id: submitted.session_id,
      text: "should not be reachable",
    };
    const result = await invoke("zcode_native_execution_output", {
      workspace_id: C2C_WS,
      task_id: submitted.task_id,
      output_id: "some_other_output",
    });
    expect(result.isError).toBe(true);
    expect(result.error ?? "").toBe("ZCODE_NATIVE_NAMESPACE_MISMATCH");
    expect(fake.outputCalls).toBe(0);
  });

  it("25. zcode_native_resume_session rejects unowned or foreign Desktop session before mutation", async () => {
    const { invoke } = buildHarness(() => {});
    const foreignSessionId = `sess_${randomUUID()}`;
    const result = await invoke("zcode_native_resume_session", {
      workspace_id: C2C_WS,
      session_id: foreignSessionId,
      instruction: "mutate foreign session",
    });
    expect(result.isError).toBe(true);
    expect(result.error).toBe("ZCODE_SESSION_NOT_OWNED");
    expect(fake.resumeCalls).toBe(0);
  });

  it("26. zcode_native_resume_session rejects resume from a different client identity", async () => {
    const { invoke } = buildHarness(() => {});
    const submitted = await invoke("zcode_native_submit_task", {
      workspace_id: C2C_WS,
      instruction: "client1 task",
    }, { clientId: "client-1", scopes: [] });
    expect(submitted.isError).toBe(false);

    const resumed = await invoke("zcode_native_resume_session", {
      workspace_id: C2C_WS,
      session_id: submitted.session_id,
      instruction: "hijack task",
    }, { clientId: "client-2", scopes: [] });
    expect(resumed.isError).toBe(true);
    expect(resumed.error).toBe("ZCODE_SESSION_NOT_OWNED");
    expect(fake.resumeCalls).toBe(0);
  });

  it("27. zcode_native_resume_session allows resuming an owned native session", async () => {
    const { invoke } = buildHarness(() => {});
    const submitted = await invoke("zcode_native_submit_task", {
      workspace_id: C2C_WS,
      instruction: "first task",
    }, { clientId: "owner-client", scopes: [] });
    expect(submitted.isError).toBe(false);
    expect(submitted.session_id).toMatch(/^sess_/);

    const resumed = await invoke("zcode_native_resume_session", {
      workspace_id: C2C_WS,
      session_id: submitted.session_id,
      instruction: "second task",
    }, { clientId: "owner-client", scopes: [] });
    expect(resumed.isError).toBe(false);
    expect(resumed.session_id).toBe(submitted.session_id);
    expect(fake.resumeCalls).toBe(1);
  });
});

describe("zcode native configuration guard", () => {
  let localAppData: string;
  let authDir: string;
  beforeEach(() => {
    localAppData = mkdtempSync(join(tmpdir(), "zcode-native-auth-"));
    authDir = join(localAppData, "z2c");
    mkdirSync(authDir);
  });
  afterEach(() => rmSync(localAppData, { recursive: true, force: true }));

  const securityToken = "synthetic-active-secret-0123456789";
  const legacyToken = "synthetic-legacy-token-0123456789";
  function writeSecurity(secrets: unknown) {
    writeFileSync(join(authDir, "security.json"), JSON.stringify({ secrets }));
  }
  function writeLegacy() {
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({ bearerToken: legacyToken }));
  }

  it("prioritizes explicit auth-file over default security and env token", () => {
    writeSecurity([{ secret: securityToken }]);
    writeLegacy();
    const explicitFile = join(localAppData, "explicit.json");
    const explicitToken = "synthetic-explicit-token-0123456789";
    writeFileSync(explicitFile, JSON.stringify({ bearerToken: explicitToken }));
    expect(
      loadZcodeNativeConfig({
        LOCALAPPDATA: localAppData,
        ZCODE_NATIVE_AUTH_FILE: explicitFile,
        ZCODE_NATIVE_TOKEN: TEST_TOKEN,
      }).token,
    ).toBe(explicitToken);
    expect(() =>
      loadZcodeNativeConfig({
        LOCALAPPDATA: localAppData,
        ZCODE_NATIVE_AUTH_FILE: join(authDir, "missing.json"),
        ZCODE_NATIVE_TOKEN: TEST_TOKEN,
      }),
    ).toThrow("Z2C auth token not found");
  });

  it("prioritizes active security.json over stale env token when no explicit auth file", () => {
    writeSecurity([{ secret: securityToken }]);
    writeLegacy();
    expect(
      loadZcodeNativeConfig({
        LOCALAPPDATA: localAppData,
        ZCODE_NATIVE_TOKEN: TEST_TOKEN,
      }).token,
    ).toBe(securityToken);
  });

  it("falls back to env token when security.json is absent", () => {
    writeLegacy();
    expect(
      loadZcodeNativeConfig({
        LOCALAPPDATA: localAppData,
        ZCODE_NATIVE_TOKEN: TEST_TOKEN,
      }).token,
    ).toBe(TEST_TOKEN);
  });

  it("uses only the exact explicit legacy auth file even when default security is valid", () => {
    writeSecurity([{ secret: securityToken }]);
    writeLegacy();
    const explicitFile = join(localAppData, "explicit.json");
    writeFileSync(explicitFile, JSON.stringify({ bearerToken: TEST_TOKEN }));
    const env = { LOCALAPPDATA: localAppData, ZCODE_NATIVE_AUTH_FILE: explicitFile };
    expect(loadZcodeNativeConfig(env).token).toBe(TEST_TOKEN);
    writeFileSync(explicitFile, JSON.stringify({ secrets: [{ secret: securityToken }] }));
    expect(() => loadZcodeNativeConfig(env)).toThrow("unrecognized Z2C auth file shape");
    rmSync(explicitFile);
    expect(() => loadZcodeNativeConfig(env)).toThrow("Z2C auth token not found");
  });

  it.each([undefined, null])("selects a valid active security secret with retiredAt=%s", (retiredAt) => {
    writeLegacy();
    writeSecurity([null, { secret: legacyToken, retiredAt: "2026-01-01" },
      { secret: "too-short" }, { secret: 123 }, { secret: securityToken, retiredAt }]);
    expect(loadZcodeNativeConfig({ LOCALAPPDATA: localAppData }).token).toBe(securityToken);
  });

  it("falls back to default legacy auth when security.json is missing", () => {
    writeLegacy();
    expect(loadZcodeNativeConfig({ LOCALAPPDATA: localAppData }).token).toBe(legacyToken);
  });

  it.each([
    ["malformed JSON", `{"secrets":${securityToken}`],
    ["null document", "null"],
    ["invalid secrets shape", JSON.stringify({ secrets: securityToken })],
    ["no active entry", JSON.stringify({ secrets: [{ secret: securityToken, retiredAt: "2026-01-01" }] })],
    ["invalid active entries", JSON.stringify({ secrets: [null, {}, { secret: 123 }, { secret: "short" }] })],
    ["empty secrets", JSON.stringify({ secrets: [] })],
  ])("falls back or reports a sanitized legacy error for %s", (_name, raw) => {
    writeFileSync(join(authDir, "security.json"), raw);
    const env = { LOCALAPPDATA: localAppData };
    const expectSanitizedError = (code: string) => {
      let caught: unknown;
      try { loadZcodeNativeConfig(env); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(ZcodeNativeError);
      expect(caught).toMatchObject({ code });
      expect(String(caught)).not.toContain(securityToken);
      expect(String(caught)).not.toContain(legacyToken);
    };
    expectSanitizedError("ZCODE_NATIVE_UNCONFIGURED");
    writeLegacy();
    expect(loadZcodeNativeConfig(env).token).toBe(legacyToken);
    writeFileSync(join(authDir, "auth.json"), `{"bearerToken":${legacyToken}`);
    expectSanitizedError("ZCODE_NATIVE_CONFIG");
  });

  it("does not include the resolved security secret in configuration errors", () => {
    writeSecurity([{ secret: securityToken }]);
    const load = () => loadZcodeNativeConfig({ LOCALAPPDATA: localAppData, ZCODE_NATIVE_TIMEOUT_MS: "0" });
    expect(load).toThrow("ZCODE_NATIVE_TIMEOUT_MS must be 1000..120000");
    try { load(); } catch (error) { expect(String(error)).not.toContain(securityToken); }
  });

  it("rejects non-loopback endpoints", () => {
    expect(() =>
      loadZcodeNativeConfig({ ZCODE_NATIVE_URL: "http://10.0.0.5:8765/mcp" } as NodeJS.ProcessEnv),
    ).toThrowError(ZcodeNativeError);
  });

  it("discovers the bearer token only from the governed auth file", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-native-cfg-"));
    try {
      const authFile = join(dir, "auth.json");
      writeFileSync(authFile, JSON.stringify({ bearerToken: `z2c_${"a".repeat(48)}` }));
      const cfg = loadZcodeNativeConfig({ ZCODE_NATIVE_AUTH_FILE: authFile } as NodeJS.ProcessEnv);
      expect(cfg.url).toBe("http://127.0.0.1:8766/mcp");
      expect(cfg.token).toBe(`z2c_${"a".repeat(48)}`);
      expect(cfg.requestTimeoutMs).toBe(20000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


it("rejects explicit billing plans locally before an older companion can strip them", async () => {
  const native = client();
  const dispatch = vi.fn();
  for (const entitlement_plan of ["START", "INDIVIDUAL"] as const) {
    await expect(native.submitTask({ workspace_id: C2C_WS, instruction: "OK", entitlement_plan }, dispatch)).rejects.toMatchObject({ code: "ENTITLEMENT_UNAVAILABLE" });
    await expect(native.resumeSession({ workspace_id: C2C_WS, session_id: "sess_00000000-0000-0000-0000-000000000001", instruction: "OK", entitlement_plan }, dispatch)).rejects.toMatchObject({ code: "ENTITLEMENT_UNAVAILABLE" });
  }
  expect(dispatch).not.toHaveBeenCalled();
});

describe("standalone account routes in the native route set (2026-10-01 regression)", () => {
  it("readSession attests a binding observed on the account start-plan route", async () => {
    const first = await client().submitTask({ workspace_id: C2C_WS, instruction: "x" });
    const view = fake.tasks.get(taskKey(NATIVE_C2C, first.task_id!))!.view;
    view.model_binding = { provider_id: "account:zai-start-plan", model_id: "GLM-5.3-Flash" };
    const observed = await client().readSession({ workspace_id: C2C_WS, session_id: first.session_id! });
    expect(observed.model_binding).toMatchObject({
      provider_id: "account:zai-start-plan",
      model_id: "GLM-5.3-Flash",
    });
  });

  it("readSession attests a binding observed on the account individual route", async () => {
    const first = await client().submitTask({ workspace_id: C2C_WS, instruction: "x" });
    const view = fake.tasks.get(taskKey(NATIVE_C2C, first.task_id!))!.view;
    view.model_binding = { provider_id: "account:zai-individual-coding-plan", model_id: "GLM-5.3-Flash" };
    const observed = await client().readSession({ workspace_id: C2C_WS, session_id: first.session_id! });
    expect(observed.model_binding.provider_id).toBe("account:zai-individual-coding-plan");
  });

  it("readSession reports an UNOBSERVED binding with the real reason (not a route verdict)", async () => {
    const first = await client().submitTask({ workspace_id: C2C_WS, instruction: "x" });
    const view = fake.tasks.get(taskKey(NATIVE_C2C, first.task_id!))!.view;
    delete (view as { model_binding?: unknown }).model_binding;
    await expect(client().readSession({ workspace_id: C2C_WS, session_id: first.session_id! }))
      .rejects.toMatchObject({ code: "ZCODE_NATIVE_NOT_ATTESTED", message: expect.stringContaining("unobserved") });
  });

  it("readSession reports a non-admissible ROUTE (team/off-peak) with the real reason", async () => {
    const first = await client().submitTask({ workspace_id: C2C_WS, instruction: "x" });
    const view = fake.tasks.get(taskKey(NATIVE_C2C, first.task_id!))!.view;
    view.model_binding = { provider_id: "account:zai-team-coding-plan", model_id: "GLM-5.3-Flash" };
    await expect(client().readSession({ workspace_id: C2C_WS, session_id: first.session_id! }))
      .rejects.toMatchObject({ code: "ZCODE_NATIVE_NOT_ATTESTED", message: expect.stringContaining("non-admissible route") });
  });
});
