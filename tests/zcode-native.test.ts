/**
 * Focused integration tests for the governed C2C → Z2C native surface
 * (src/execution/zcode-native.ts + src/mcp/zcode-native-tools.ts).
 *
 * The fake upstream is a real MCP Streamable HTTP server implementing Z2C's
 * tool contracts with faithful per-workspace scoping. Client-level governance
 * (observed Start Plan identity, namespace validation, ownership-checked
 * cancel/output, token scrubbing, no fallback) is exercised against it; the
 * tool layer is exercised with stub deps to prove principal authorization and
 * the shared queue/writer gate run before any upstream side effect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { ZcodeControl } from "../src/execution/zcode-control.js";
import { nativeSelfTest } from "../src/execution/zcode-native-self-test.js";
import { makeTmpDir, cleanup } from "./helpers.js";

const TEST_TOKEN = "test-token-0123456789abcdef";
const ENGINEERING_AI_WS = "1a2b3c4d5e6f";
const C2C_WS = "9f8e7d6c5b4a";
const START_PLAN_BINDING = {
  provider_id: ZCODE_NATIVE_REQUIRED_IDENTITY.provider_id,
  model_id: ZCODE_NATIVE_REQUIRED_IDENTITY.model_id,
};

interface FakeState {
  durableIdempotency: boolean;
  submitInputs: Array<Record<string, unknown>>;
  serverName: string;
  providerName: string;
  providerStatus: string;
  capsOk: boolean;
  modelBinding: { provider_id: string; model_id: string } | null;
  bindingWorkspace: string;
  /** Binding Z2C observed for the exact session at admission (returned on task views). */
  submitBinding: { provider_id: string; model_id: string } | null;
  echoAuth: boolean;
  ignoreWorkspaceScope: boolean;
  spoofSubmitWorkspace: string | null;
  outputBody: Record<string, unknown> | null;
  submitCalls: number;
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
  return workspaceId === fake.bindingWorkspace && fake.submitBinding !== null;
}

function upstreamError(text: string) {
  return { isError: true, content: [{ type: "text", text }] };
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
      const mcp = new McpServer({ name: fake.serverName, version: "0.1.0" });
      mcp.registerTool(
        "provider_status",
        { inputSchema: { workspace_id: z.string() } },
        async (args) => {
          // The binding is reported only for the exact requested workspace.
          const ws = typeof args.workspace_id === "string" ? args.workspace_id : "";
          const binding = ws === fake.bindingWorkspace ? fake.modelBinding : null;
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
                workspace_id: ws,
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
          const workspaceId =
            fake.spoofSubmitWorkspace ?? (typeof args.workspace_id === "string" ? args.workspace_id : "");
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
          return { content: [{ type: "text", text: JSON.stringify(view) }] };
        },
      );
      mcp.registerTool(
        "get_zcode_task",
        { inputSchema: { workspace_id: z.string().optional(), task_id: z.string() } },
        async (args) => {
          const view = scopedView(
            typeof args.workspace_id === "string" ? args.workspace_id : undefined,
            String(args.task_id),
          );
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
          const view = scopedView(
            typeof args.workspace_id === "string" ? args.workspace_id : undefined,
            String(args.task_id),
          );
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
          if (!fake.outputBody) return upstreamError("Z2C_OUTPUT_UNKNOWN: no output");
          return { content: [{ type: "text", text: JSON.stringify(fake.outputBody) }] };
        },
      );
      mcp.registerTool(
        "resume_zcode_session",
        { inputSchema: { workspace_id: z.string(), session_id: z.string(), instruction: z.string() } },
        async (args) => {
          fake.resumeCalls += 1;
          const workspaceId = String(args.workspace_id);
          const binding = ws_is_attested(workspaceId) ? fake.submitBinding : null;
          if (!binding) return upstreamError("Z2C_BINDING_UNVERIFIED: session binding unverified for this workspace");
          const taskId = `z2c_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
          const view = {
            task_id: taskId,
            session_id: String(args.session_id),
            workspace_id: workspaceId,
            status: "queued",
            model_binding: { ...binding, source: "z2c-session-read" },
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
    serverName: "z2c-bridge",
    providerName: ZCODE_NATIVE_REQUIRED_IDENTITY.provider,
    providerStatus: "healthy",
    capsOk: true,
    modelBinding: { ...START_PLAN_BINDING },
    bindingWorkspace: C2C_WS,
    submitBinding: { ...START_PLAN_BINDING },
    echoAuth: false,
    ignoreWorkspaceScope: false,
    spoofSubmitWorkspace: null,
    outputBody: null,
    submitCalls: 0,
    durableIdempotency: true,
    submitInputs: [],
    resumeCalls: 0,
    cancelCalls: 0,
    outputCalls: 0,
    tasks: new Map(),
  };
}

function client(): ZcodeNativeClient {
  return new ZcodeNativeClient({ url: baseUrl, token: TEST_TOKEN, requestTimeoutMs: 5000 });
}

function closeFakeServer(srv: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    srv.closeAllConnections();
    srv.close(() => resolve());
  });
}

beforeEach(async () => {
  healthyFake();
  await startFakeZ2c();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetZcodeNativeClientForTests();
  await closeFakeServer(server);
});

describe("zcode native client (observed identity, namespace, ownership)", () => {
  it("server-owned probe verifies one task over the real native MCP client path without leaking server auth", async () => {
    fake.durableIdempotency = true;
    fake.echoAuth = true;
    const native = client();
    const result = await nativeSelfTest(C2C_WS, {
      providerStatus: id => native.providerStatus(id), submitNative: input => native.submitTask(input),
      snapshot: () => ({ queue: "a".repeat(64), writer: "b".repeat(64) }), cancel: input => native.cancelTask(input),
    });
    expect(result).toMatchObject({ overall: "PASS", replay_flags: [false, true], cleanup: "cancelled", conflict_code: "IDEMPOTENCY_CONFLICT" });
    expect(fake.tasks.size).toBe(1); expect(fake.submitCalls).toBe(3); expect(fake.cancelCalls).toBe(1);
    expect(JSON.stringify(result)).not.toContain(TEST_TOKEN);
  });
  it("transports a strictly validated key and verifies the keyed task proof", async () => {
    const input = { workspace_id: C2C_WS, instruction: "review exact source", write_scope: "readonly" as const, mode: "plan" as const, idempotency_key: "review_123-abc" };
    const view = await client().submitTask(input);
    expect(fake.submitInputs).toEqual([input]);
    expect(view.idempotency).toEqual({ protocol: "workspace-task-v1", key: input.idempotency_key, request_fingerprint: nativeRequestFingerprint(input), replayed: false });
  });
  it.each(["", "a/b", "a:b", "a\n", "-a", "é", "x".repeat(129)])("rejects unsafe key %j before dispatch", async key => {
    const c = client(), call = vi.spyOn(c, "callTool");
    await expect(c.submitTask({ workspace_id: C2C_WS, instruction: "review", idempotency_key: key })).rejects.toMatchObject({ code: "ZCODE_NATIVE_INSTRUCTION_REJECTED" });
    expect(call).not.toHaveBeenCalled(); expect(fake.submitCalls).toBe(0);
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
        else if (field === "model") raw.model_binding.model_id = "wrong";
        else if (field === "status") raw.status = "garbage";
        else raw.idempotency[field === "fingerprint" ? "request_fingerprint" : field] = "wrong";
      }
      return raw;
    });
    await expect(c.submitTask(input)).rejects.toBeInstanceOf(ZcodeNativeError);
    expect(fake.submitCalls).toBe(1);
  });
  it("1. attests Start Plan only from a real reported binding", async () => {
    const status = await client().status(C2C_WS);
    expect(status.available).toBe(true);
    expect(status.desktop_managed_auth).toBe(true);
    expect(status.provider?.name).toBe("zcode-desktop");
    expect(status.capabilities_ok).toBe(true);
    expect(status.start_plan?.attested).toBe(true);
    expect(status.start_plan?.provider_id).toBe("builtin:zai-start-plan");
    expect(status.start_plan?.model_id).toBe("GLM-5.3-Flash");
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

  it("3. rejects a wrong reported provider binding", async () => {
    fake.modelBinding = { provider_id: "builtin:zai-coding-plan", model_id: "GLM-5.3-Flash" };
    fake.submitBinding = { ...fake.modelBinding };
    const status = await client().status(C2C_WS);
    expect(status.start_plan?.attested).toBe(false);
    expect(status.start_plan?.provider_id).toBe("builtin:zai-coding-plan");
    expect(status.start_plan?.mismatches.join(";")).toContain("provider_id=builtin:zai-coding-plan");
    await expect(client().submitTask({ workspace_id: C2C_WS, instruction: "x" })).rejects.toMatchObject({
      code: "ZCODE_NATIVE_NOT_ATTESTED",
    });
  });

  it("4. rejects a wrong reported model binding", async () => {
    fake.modelBinding = { provider_id: "builtin:zai-start-plan", model_id: "GLM-5.3" };
    fake.submitBinding = { ...fake.modelBinding };
    fake.bindingWorkspace = ENGINEERING_AI_WS; // admission passes; the returned binding is wrong
    const status = await client().status(ENGINEERING_AI_WS);
    expect(status.start_plan?.attested).toBe(false);
    expect(status.start_plan?.model_id).toBe("GLM-5.3");
    expect(status.start_plan?.mismatches.join(";")).toContain("model_id=GLM-5.3");
    await expect(client().submitTask({ workspace_id: ENGINEERING_AI_WS, instruction: "x" })).rejects.toMatchObject({
      code: "ZCODE_NATIVE_NOT_ATTESTED",
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
    expect(submitted.model_binding?.provider_id).toBe("builtin:zai-start-plan");
    expect(submitted.model_binding?.model_id).toBe("GLM-5.3-Flash");
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
      provider_id: "builtin:zai-start-plan",
      model_id: "GLM-5.3-Flash",
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
    // The fake reports the Start Plan binding only for C2C_WS.
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

  it("8. submits and reads back native tasks with stable Z2C ids", async () => {
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
      provider_id: "builtin:zai-start-plan",
      model_id: "GLM-5.3-Flash",
      source: "z2c-session-read",
    });
    const fetched = await client().getTask({ workspace_id: C2C_WS, task_id: submitted.task_id });
    expect(fetched.task_id).toBe(submitted.task_id);
    expect(fetched.status).toBe("queued");
  });

  it("9. cancels a native task", async () => {
    fake.bindingWorkspace = ENGINEERING_AI_WS; // attestation is per dispatch target
    const submitted = await client().submitTask({ workspace_id: ENGINEERING_AI_WS, instruction: "slow task" });
    const cancelled = await client().cancelTask({ workspace_id: ENGINEERING_AI_WS, task_id: submitted.task_id });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.task_id).toBe(submitted.task_id);
    expect(cancelled.workspace_id).toBe(ENGINEERING_AI_WS);
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
    const stored = fake.tasks.get(taskKey(C2C_WS, submitted.task_id))!.view;
    expect(stored.status).toBe("queued");
  });

  it("16. rejects a returned task whose workspace mismatches the authorized request", async () => {
    fake.spoofSubmitWorkspace = "spoof-ws";
    fake.bindingWorkspace = "spoof-ws"; // upstream accepts, but the returned namespace is wrong
    await expect(
      client().submitTask({ workspace_id: C2C_WS, instruction: "namespace probe" }),
    ).rejects.toMatchObject({ code: "ZCODE_NATIVE_NAMESPACE_MISMATCH" });
    fake.spoofSubmitWorkspace = null;
    fake.bindingWorkspace = C2C_WS;
    fake.ignoreWorkspaceScope = true;
    const submitted = await client().submitTask({ workspace_id: C2C_WS, instruction: "namespace probe 2" });
    await expect(
      client().getTask({ workspace_id: ENGINEERING_AI_WS, task_id: submitted.task_id }),
    ).rejects.toMatchObject({ code: "ZCODE_NATIVE_NAMESPACE_MISMATCH" });
  });

  it("17. rejects a service that does not present the z2c-bridge handshake", async () => {
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
    fake.tasks.get(taskKey(C2C_WS, submitted.task_id))!.view.output_id = "out_requested";

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
  });
});

describe("zcode native tool layer (principal authorization + shared gates)", () => {
  function buildHarness(gate: (ws: string, authInfo: unknown, write: boolean) => void) {
    const server = new McpServer({ name: "stub-c2c", version: "0.0.0" });
    registerZcodeNativeTools(server, {
      requireScope: () => null,
      resolveWorkspace: (requestedId: string) => {
        if (requestedId === "unauthorized-ws") {
          throw Object.assign(new Error("Workspace is not authorized for this identity"), {
            code: "WORKSPACE_NOT_AUTHORIZED",
          });
        }
        return { id: requestedId };
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
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const tool = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>; inputSchema: { parse: (a: unknown) => unknown } }> })._registeredTools[name];
      const parsed = tool.inputSchema.parse(args);
      const result = await tool.handler(parsed, { authInfo: { clientId: "tester", scopes: [] } });
      const text = result.content[0]!.text;
      if (result.isError) {
        // Error texts are "<CODE>: <message>" (see the fail/mapError stubs).
        const sep = text.indexOf(": ");
        const code = sep > 0 && /^[A-Z][A-Z0-9_]+$/.test(text.slice(0, sep)) ? text.slice(0, sep) : "UNKNOWN";
        return { error: code, message: sep > 0 ? text.slice(sep + 2) : text, isError: true };
      }
      return { ...JSON.parse(text), isError: false };
    };
    return { invoke };
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
    fake.tasks.get(taskKey(C2C_WS, submitted.task_id))!.view.output_id = requestedOutputId;
    fake.outputBody = {
      output_id: submitted.output_id ?? "out_1",
      task_id: submitted.task_id,
      session_id: submitted.session_id,
      text:
        "result line\n" +
        'api_key = sk-verysecretvalue123\n' +
        "see F:\\Users\\tester\\secret\\plan.md for details\n" +
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
    expect(out.text).not.toContain("F:\\Users\\tester\\secret\\plan.md");
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
});

describe("zcode native configuration guard", () => {
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
