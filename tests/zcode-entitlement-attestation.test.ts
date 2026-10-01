import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ZcodeNativeClient, nativeRequestFingerprint } from "../src/execution/zcode-native.js";
import { isAttestedEntitlement } from "../src/execution/zcode-entitlement.js";

/**
 * Regression: the per-session entitlement attestation path. The A2C client
 * must (1) keep non-DEFAULT plans fail-closed without an explicit runtime
 * capability, (2) accept a non-DEFAULT task only with an exact-session
 * registry readback attesting that EXACT plan (mismatch or unproven evidence
 * is rejected regardless of provider route — no silent cross-plan fallback),
 * and (3) admit the retired start-plan route only under an attested START
 * entitlement. DEFAULT flows stay byte-identical.
 */

const TEST_TOKEN = "test-token-0123456789";
const A2C_WORKSPACE = "entitlementws1";
const CANONICAL_ROOT = "/tmp/entitlement-ws";
const NATIVE_WORKSPACE = "ws_entitlement_ws";
const SESSION_ID = "sess_11111111-2222-3333-4444-555555555555";

interface FakeState {
  server: ReturnType<typeof createServer>;
  port: number;
  entitlementCapability: unknown;
  submitBinding: { provider_id: string; model_id: string; source: string } | null;
  submitEntitlement: unknown;
  submitCalls: number;
  /** Durable keyed admissions (key → fingerprint + admitted view), Z2C store stand-in. */
  admissions: Map<string, { fingerprint: string; view: Record<string, unknown> }>;
}

let state: FakeState;

async function startFakeZ2c(): Promise<void> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const auth = req.headers.authorization ?? "";
      if (req.method === "POST" && req.url === "/api/workspaces/authorize") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ workspaceId: NATIVE_WORKSPACE, canonicalPath: CANONICAL_ROOT, permissions: { read: true, write: true } }));
        return;
      }
      if (auth !== `Bearer ${TEST_TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const mcp = new McpServer({ name: "z2c-service", version: "0.1.0" });
      mcp.registerTool("zcode_workspace_list", { inputSchema: {} }, async () => ({
        content: [{ type: "text", text: JSON.stringify({ workspaces: [{ workspace_id: NATIVE_WORKSPACE, canonical_path: CANONICAL_ROOT }] }) }],
      }));
      mcp.registerTool("provider_status", { inputSchema: { workspace_id: z.string() } }, async (args) => ({
        content: [{
          type: "text",
          text: JSON.stringify({
            provider: "zcode-official",
            status: "healthy",
            detail: null,
            zcode_version: null,
            capabilities: { ok: true },
            workspace_id: args.workspace_id,
            durable_idempotency: "workspace-task-v1",
            model_binding: { provider_id: "zai-api", model_id: "GLM-5.3-Flash", source: "official-session-read" },
            ...(state.entitlementCapability !== undefined ? { entitlement_capability: state.entitlementCapability } : {}),
          }),
        }],
      }));
      mcp.registerTool("submit_zcode_task", { inputSchema: { workspace_id: z.string(), instruction: z.string(), entitlement_plan: z.enum(["DEFAULT", "START", "INDIVIDUAL"]).optional(), idempotency_key: z.string().optional() } }, async (args) => {
        state.submitCalls += 1;
        if (!state.submitBinding) {
          return { isError: true, content: [{ type: "text", text: "Z2C_BINDING_UNVERIFIED: no binding" }] };
        }
        // Z2C durable admission contract (z2c/src/core/tasks/engine.ts): a key
        // already bound to a DIFFERENT request fingerprint is a conflict that
        // admits nothing; an exact-fingerprint match replays the SAME task.
        const fingerprint = nativeRequestFingerprint(args);
        if (args.idempotency_key) {
          const prior = state.admissions.get(args.idempotency_key);
          if (prior) {
            if (prior.fingerprint !== fingerprint) {
              return { isError: true, content: [{ type: "text", text: "IDEMPOTENCY_CONFLICT: key is already bound to a different request" }] };
            }
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  ...prior.view,
                  idempotency: { ...(prior.view.idempotency as Record<string, unknown>), replayed: true },
                }),
              }],
            };
          }
        }
        const view: Record<string, unknown> = {
          task_id: `z2c_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
          workspace_id: args.workspace_id,
          session_id: SESSION_ID,
          status: "queued",
          model_binding: state.submitBinding,
          entitlement: state.submitEntitlement,
          ...(args.idempotency_key ? {
            idempotency: { protocol: "workspace-task-v1", key: args.idempotency_key, request_fingerprint: fingerprint, replayed: false },
          } : {}),
        };
        if (args.idempotency_key) state.admissions.set(args.idempotency_key, { fingerprint, view });
        return {
          content: [{ type: "text", text: JSON.stringify(view) }],
        };
      });
      // Stateless per-request transport (repo-wide fake-Z2C pattern, matches
      // tests/zcode-native.test.ts): the client never holds a session id, so
      // every POST is served by a fresh transport.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  state = { server, port, entitlementCapability: null, submitBinding: null, submitEntitlement: null, submitCalls: 0, admissions: new Map() };
}

function client(): ZcodeNativeClient {
  return new ZcodeNativeClient(
    { url: `http://127.0.0.1:${state.port}/mcp`, token: TEST_TOKEN, requestTimeoutMs: 20000 },
    { resolveWorkspaceRoot: () => CANONICAL_ROOT },
  );
}

const START_ATTESTED = {
  requested: "START",
  observed: "START",
  access_mode: "start-plan",
  source: "provider-registry",
};

const INDIVIDUAL_ATTESTED = {
  requested: "INDIVIDUAL",
  observed: "INDIVIDUAL",
  access_mode: "individual-coding-plan",
  source: "provider-registry",
};

describe("per-session START entitlement (A2C native lane)", () => {
  beforeAll(async () => {
    process.env.ZCODE_NATIVE_ALLOWED_WORKSPACES = A2C_WORKSPACE;
    await startFakeZ2c();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => state.server.close(() => resolve()));
    delete process.env.ZCODE_NATIVE_ALLOWED_WORKSPACES;
  });

  it("keeps START fail-closed when the runtime does not advertise entitlement selection", async () => {
    state.entitlementCapability = null;
    state.submitCalls = 0;
    const c = client();
    try {
      await expect(
        c.submitTask({ workspace_id: A2C_WORKSPACE, instruction: "canary", entitlement_plan: "START", model_id: "GLM-5.3-Flash", thought_level: "max" }),
      ).rejects.toMatchObject({ code: "ENTITLEMENT_UNAVAILABLE" });
      expect(state.submitCalls).toBe(0);
    } finally {
      c.close();
    }
  });

  it("accepts a START task only on an exact-session attested START readback", async () => {
    state.entitlementCapability = { entitlementSelection: true };
    // The fake must echo the requested effort on the observed binding — the
    // client independently rejects a requested thought_level that is not
    // observed on the admitted task.
    state.submitBinding = { provider_id: "account:zai-start-plan", model_id: "GLM-5.3-Flash", thought_level: "max", source: "official-session-read" };
    state.submitEntitlement = START_ATTESTED;
    const c = client();
    try {
      const view = await c.submitTask({ workspace_id: A2C_WORKSPACE, instruction: "canary", entitlement_plan: "START", model_id: "GLM-5.3-Flash", thought_level: "max" });
      expect(view.entitlement).toEqual(START_ATTESTED);
      expect(isAttestedEntitlement(view.entitlement, "START")).toBe(true);
      expect(view.workspace_id).toBe(A2C_WORKSPACE);
    } finally {
      c.close();
    }
  });

  it("rejects an unproven entitlement readback even when the capability is present", async () => {
    state.entitlementCapability = { entitlementSelection: true };
    state.submitBinding = { provider_id: "account:zai-start-plan", model_id: "GLM-5.3-Flash", source: "official-session-read" };
    state.submitEntitlement = { requested: "START", observed: null, access_mode: null, source: "unavailable" };
    const c = client();
    try {
      await expect(
        c.submitTask({ workspace_id: A2C_WORKSPACE, instruction: "canary", entitlement_plan: "START", model_id: "GLM-5.3-Flash" }),
      ).rejects.toMatchObject({ code: "ZCODE_NATIVE_NOT_ATTESTED" });
    } finally {
      c.close();
    }
  });

  it("rejects a START claim attested on the wrong access mode", async () => {
    state.entitlementCapability = { entitlementSelection: true };
    state.submitBinding = { provider_id: "zai-api", model_id: "GLM-5.3-Flash", source: "official-session-read" };
    state.submitEntitlement = { requested: "START", observed: "INDIVIDUAL", access_mode: "individual-coding-plan", source: "provider-registry" };
    const c = client();
    try {
      await expect(
        c.submitTask({ workspace_id: A2C_WORKSPACE, instruction: "canary", entitlement_plan: "START", model_id: "GLM-5.3-Flash" }),
      ).rejects.toMatchObject({ code: "ZCODE_NATIVE_NOT_ATTESTED" });
    } finally {
      c.close();
    }
  });

  it("rejects a requested START on an ADMISSIBLE route when the readback is unproven (no cross-plan fallback)", async () => {
    state.entitlementCapability = { entitlementSelection: true };
    state.submitBinding = { provider_id: "zai-api", model_id: "GLM-5.3-Flash", source: "official-session-read" };
    state.submitEntitlement = { requested: "START", observed: null, access_mode: null, source: "unavailable" };
    state.submitCalls = 0;
    const c = client();
    try {
      await expect(
        c.submitTask({ workspace_id: A2C_WORKSPACE, instruction: "canary", entitlement_plan: "START" }),
      ).rejects.toMatchObject({ code: "ZCODE_NATIVE_NOT_ATTESTED" });
      // The rejection fired at the binding gate AFTER dispatch, not at the
      // capability gate: route admissibility alone never attests the plan.
      expect(state.submitCalls).toBe(1);
    } finally {
      c.close();
    }
  });

  it("accepts INDIVIDUAL on an exact-session attested INDIVIDUAL readback over an admissible route", async () => {
    state.entitlementCapability = { entitlementSelection: true };
    state.submitBinding = { provider_id: "zai-api", model_id: "GLM-5.3-Flash", source: "official-session-read" };
    state.submitEntitlement = INDIVIDUAL_ATTESTED;
    const c = client();
    try {
      const view = await c.submitTask({ workspace_id: A2C_WORKSPACE, instruction: "canary", entitlement_plan: "INDIVIDUAL" });
      expect(isAttestedEntitlement(view.entitlement, "INDIVIDUAL")).toBe(true);
      expect(view.workspace_id).toBe(A2C_WORKSPACE);
    } finally {
      c.close();
    }
  });

  it("rejects a requested INDIVIDUAL when the readback attests a different plan (START observed)", async () => {
    state.entitlementCapability = { entitlementSelection: true };
    state.submitBinding = { provider_id: "zai-api", model_id: "GLM-5.3-Flash", source: "official-session-read" };
    state.submitEntitlement = START_ATTESTED;
    const c = client();
    try {
      await expect(
        c.submitTask({ workspace_id: A2C_WORKSPACE, instruction: "canary", entitlement_plan: "INDIVIDUAL" }),
      ).rejects.toMatchObject({ code: "ZCODE_NATIVE_NOT_ATTESTED" });
    } finally {
      c.close();
    }
  });

  it("rejects a requested INDIVIDUAL when the readback is unproven even on an admissible route", async () => {
    state.entitlementCapability = { entitlementSelection: true };
    state.submitBinding = { provider_id: "zai-api", model_id: "GLM-5.3-Flash", source: "official-session-read" };
    state.submitEntitlement = { requested: "INDIVIDUAL", observed: null, access_mode: null, source: "unavailable" };
    const c = client();
    try {
      await expect(
        c.submitTask({ workspace_id: A2C_WORKSPACE, instruction: "canary", entitlement_plan: "INDIVIDUAL" }),
      ).rejects.toMatchObject({ code: "ZCODE_NATIVE_NOT_ATTESTED" });
    } finally {
      c.close();
    }
  });

  it("keeps DEFAULT exempt from the exact-plan gate even with unproven evidence on an admissible route", async () => {
    state.entitlementCapability = { entitlementSelection: true };
    state.submitBinding = { provider_id: "zai-api", model_id: "GLM-5.3-Flash", source: "official-session-read" };
    state.submitEntitlement = { requested: "DEFAULT", observed: null, access_mode: null, source: "unavailable" };
    const c = client();
    try {
      const view = await c.submitTask({ workspace_id: A2C_WORKSPACE, instruction: "canary", entitlement_plan: "DEFAULT" });
      expect(view.status).toBe("queued");
    } finally {
      c.close();
    }
  });

  it("admits the retired start-plan route only under an attested START entitlement", async () => {
    state.entitlementCapability = { entitlementSelection: true };
    state.submitBinding = { provider_id: "builtin:zai-start-plan", model_id: "GLM-5.3-Flash", source: "official-session-read" };
    state.submitEntitlement = START_ATTESTED;
    const c = client();
    try {
      const view = await c.submitTask({ workspace_id: A2C_WORKSPACE, instruction: "canary", entitlement_plan: "START", model_id: "GLM-5.3-Flash" });
      expect(view.model_binding?.provider_id).toBe("builtin:zai-start-plan");
    } finally {
      c.close();
    }

    // Same retired route WITHOUT attestation → still revoked (fail closed).
    state.submitEntitlement = { requested: "DEFAULT", observed: null, access_mode: null, source: "unavailable" };
    const c2 = client();
    try {
      await expect(
        c2.submitTask({ workspace_id: A2C_WORKSPACE, instruction: "canary" }),
      ).rejects.toMatchObject({ code: "ZCODE_INCOMPATIBLE_PROVIDER_VERSION" });
    } finally {
      c2.close();
    }
  });

  it("rejects the same idempotency key with a different plan instead of admitting twice", async () => {
    // Conflicting-request contract: the key is bound to the request
    // fingerprint, and entitlement_plan is part of that fingerprint for
    // non-DEFAULT plans. A re-submit with a different plan must be REJECTED
    // (IDEMPOTENCY_CONFLICT, no second admission), never produce a separate
    // execution; only the byte-identical request replays.
    state.entitlementCapability = { entitlementSelection: true };
    state.submitBinding = { provider_id: "zai-api", model_id: "GLM-5.3-Flash", source: "official-session-read" };
    state.submitEntitlement = START_ATTESTED;
    const key = "plan-conflict-key-1";
    const c = client();
    try {
      const first = await c.submitTask({ workspace_id: A2C_WORKSPACE, instruction: "canary", entitlement_plan: "START", idempotency_key: key });
      expect(first.idempotency?.replayed).toBe(false);
      expect(state.admissions.size).toBe(1);

      state.submitEntitlement = INDIVIDUAL_ATTESTED;
      await expect(
        c.submitTask({ workspace_id: A2C_WORKSPACE, instruction: "canary", entitlement_plan: "INDIVIDUAL", idempotency_key: key }),
      ).rejects.toMatchObject({ code: "ZCODE_NATIVE_UPSTREAM", upstreamCode: "IDEMPOTENCY_CONFLICT" });
      expect(state.admissions.size).toBe(1);

      // Downgrade to DEFAULT with the same key is also a changed request.
      state.submitEntitlement = { requested: "DEFAULT", observed: null, access_mode: null, source: "unavailable" };
      await expect(
        c.submitTask({ workspace_id: A2C_WORKSPACE, instruction: "canary", entitlement_plan: "DEFAULT", idempotency_key: key }),
      ).rejects.toMatchObject({ upstreamCode: "IDEMPOTENCY_CONFLICT" });
      expect(state.admissions.size).toBe(1);

      state.submitEntitlement = START_ATTESTED;
      const replay = await c.submitTask({ workspace_id: A2C_WORKSPACE, instruction: "canary", entitlement_plan: "START", idempotency_key: key });
      expect(replay.task_id).toBe(first.task_id);
      expect(replay.idempotency?.replayed).toBe(true);
      expect(state.admissions.size).toBe(1);
    } finally {
      c.close();
    }
  });

  it("keeps DEFAULT submissions working with no capability field at all", async () => {
    state.entitlementCapability = undefined;
    state.submitBinding = { provider_id: "zai-api", model_id: "GLM-5.3-Flash", source: "official-session-read" };
    state.submitEntitlement = { requested: "DEFAULT", observed: null, access_mode: null, source: "unavailable" };
    const c = client();
    try {
      const view = await c.submitTask({ workspace_id: A2C_WORKSPACE, instruction: "plain default task" });
      expect(view.status).toBe("queued");
      expect(view.entitlement?.observed ?? null).toBeNull();
    } finally {
      c.close();
    }
  });

  it("classifies attestation evidence strictly (source and access mode must agree)", () => {
    expect(isAttestedEntitlement(START_ATTESTED as never, "START")).toBe(true);
    expect(isAttestedEntitlement({ ...START_ATTESTED, source: "control-plane-reported" } as never, "START")).toBe(false);
    expect(isAttestedEntitlement({ ...START_ATTESTED, access_mode: "individual-coding-plan" } as never, "START")).toBe(false);
    expect(isAttestedEntitlement(null, "START")).toBe(false);
  });
});
