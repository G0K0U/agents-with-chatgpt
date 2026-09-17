import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IDEMPOTENCY_KEY, IDEMPOTENCY_PROTOCOL } from "../core/tasks/idempotency.js";
import { timingSafeEqual, randomUUID } from "node:crypto";
import type { TaskEngine, TaskEngineError } from "../core/tasks/engine.js";
import { WorkspaceRegistry, WorkspaceError } from "../core/workspaces/registry.js";
import { Persistence } from "../core/tasks/persistence.js";
import { REQUIRED_START_PLAN_PROVIDER_ID, REQUIRED_START_PLAN_MODEL_ID, type AgentProvider } from "../providers/types.js";
import type { FileAuditLog } from "../util/log.js";

/**
 * Local-only, bearer-authenticated MCP server exposing ONLY typed bounded
 * operations. No shell, no exec, no filesystem tools, no generic RPC passthrough.
 */
export interface McpDeps {
  engine: TaskEngine;
  workspaces: WorkspaceRegistry;
  store: Persistence;
  provider: AgentProvider;
  audit: FileAuditLog;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function errorToToolResult(err: unknown) {
  const code = (err as { code?: string })?.code ?? "INTERNAL";
  const message = (err as Error)?.message ?? String(err);
  return { isError: true as const, content: [{ type: "text" as const, text: `${code}: ${message}` }] };
}

function workspaceInfo(deps: McpDeps, workspaceId: string) {
  const entry = deps.workspaces.get(workspaceId);
  return {
    workspace_id: entry.workspaceId,
    canonical_path: entry.canonicalPath,
    display_name: entry.displayName,
    allowed: entry.allowed,
    queue: deps.engine.getQueue(workspaceId),
  };
}

export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: "z2c-bridge", version: "0.1.0" },
    { instructions: "Bounded control plane for the local ZCode Desktop agent. Tasks execute in real ZCode sessions." },
  );

  server.registerTool(
    "workspace_info",
    {
      title: "Workspace info",
      description: "Return allowlist info and queue state for a registered workspace.",
      inputSchema: { workspace_id: z.string() },
    },
    async ({ workspace_id }) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(workspaceInfo(deps, workspace_id), null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.registerTool(
    "submit_zcode_task",
    {
      title: "Submit ZCode task",
      description:
        "Queue an instruction for the real ZCode Desktop agent in an allowlisted workspace. " +
        "Returns { task_id, session_id, status, workspace_id }.",
      inputSchema: {
        workspace_id: z.string(),
        instruction: z.string().min(1).max(20000),
        idempotency_key: z.string().regex(IDEMPOTENCY_KEY).optional(),
        write_scope: z.enum(["workspace", "readonly"]).optional(),
        network: z.enum(["default"]).optional(),
        mode: z.enum(["plan", "build", "edit"]).optional(),
        resume_session_id: z.string().regex(/^sess_[0-9a-f-]{36}$/i).optional(),
      },
    },
    async (args) => {
      try {
        const view = await deps.engine.submitTask({
          workspace_id: args.workspace_id,
          instruction: args.instruction,
          idempotency_key: args.idempotency_key,
          write_scope: args.write_scope,
          network: args.network,
          mode: args.mode,
          resume_session_id: args.resume_session_id,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              view,
              null, 2,
            ),
          }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.registerTool(
    "get_zcode_task",
    {
      title: "Get ZCode task",
      description: "Return bounded task metadata (status, ids, timestamps). Not conversation history.",
      inputSchema: { workspace_id: z.string().optional(), task_id: z.string() },
    },
    async ({ workspace_id, task_id }) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(deps.engine.getTask(workspace_id, task_id), null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.registerTool(
    "cancel_zcode_task",
    {
      title: "Cancel ZCode task",
      description: "Cancel a queued or running task (interrupts the real ZCode session).",
      inputSchema: { workspace_id: z.string().optional(), task_id: z.string() },
    },
    async ({ workspace_id, task_id }) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(deps.engine.cancelTask(workspace_id, task_id), null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.registerTool(
    "execution_output",
    {
      title: "Execution output",
      description: "Retrieve the bounded final assistant output for a completed task.",
      inputSchema: { workspace_id: z.string().optional(), task_id: z.string(), output_id: z.string() },
    },
    async ({ workspace_id, task_id, output_id }) => {
      try {
        const out = deps.engine.getOutput(workspace_id, task_id, output_id);
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.registerTool(
    "execution_queue",
    {
      title: "Execution queue",
      description: "Return queue state for a workspace; supports pause/resume.",
      inputSchema: {
        workspace_id: z.string(),
        action: z.enum(["status", "pause", "resume"]).optional(),
      },
    },
    async ({ workspace_id, action }) => {
      try {
        const a = action ?? "status";
        if (a === "pause") deps.engine.pauseQueue(workspace_id);
        else if (a === "resume") deps.engine.resumeQueue(workspace_id);
        return { content: [{ type: "text", text: JSON.stringify(deps.engine.getQueue(workspace_id), null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.registerTool("read_zcode_session", {
    title: "Read exact native ZCode session",
    description: "Observe exact native session workspace/provider/model. No session creation or model substitution.",
    inputSchema: { workspace_id: z.string(), session_id: z.string().regex(/^sess_[0-9a-f-]{36}$/i) },
    annotations: { readOnlyHint: true },
  }, async ({ workspace_id, session_id }) => {
    try {
      const ws = deps.workspaces.resolveAuthorized(workspace_id);
      if (deps.provider.name !== "zcode-desktop" || !deps.provider.usesDesktopManagedAuth) throw new Error("Native Desktop provider required");
      const binding = await deps.provider.readSessionBinding(session_id, { workspacePath: ws.canonicalPath, workspaceKey: ws.canonicalPath });
      if (binding?.provider_id !== REQUIRED_START_PLAN_PROVIDER_ID || binding?.model_id !== REQUIRED_START_PLAN_MODEL_ID || binding.source !== "desktop-session-read") {
        throw new Error("Exact native session workspace/model binding is unverified");
      }
      return { content: [{ type: "text", text: JSON.stringify({ workspace_id: ws.workspaceId, canonical_path: ws.canonicalPath, session_id, model_binding: binding, immediate_resume: "native-session-v1" }) }] };
    } catch (err) { return errorToToolResult(err); }
  });

  server.registerTool("update_zcode_session", {
    title: "Update native ZCode session model/reasoning",
    description:
      "Same-session model and/or thought-level (reasoning depth) change on an existing native " +
      "ZCode session. The native session id is preserved (no new session), the switch stays within " +
      "the session's current provider, and the resulting binding is re-observed from the session " +
      "itself; an unconfirmed switch fails closed. Governed task admission keeps enforcing the " +
      "required identity, so a session left on a non-required model is rejected at submit time.",
    inputSchema: {
      workspace_id: z.string(),
      session_id: z.string().regex(/^sess_[0-9a-f-]{36}$/i),
      model_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
      thought_level: z.string().regex(/^[a-z0-9_-]{1,20}$/).optional(),
    },
    annotations: { readOnlyHint: false },
  }, async ({ workspace_id, session_id, model_id, thought_level }) => {
    try {
      if (!model_id && !thought_level) throw new Error("model_id or thought_level is required");
      const ws = deps.workspaces.resolveAuthorized(workspace_id);
      if (deps.provider.name !== "zcode-desktop" || !deps.provider.usesDesktopManagedAuth) throw new Error("Native Desktop provider required");
      if (typeof (deps.provider as { updateSessionModel?: unknown }).updateSessionModel !== "function") {
        throw new Error("The connected provider does not support same-session model updates");
      }
      const change: { modelId?: string; thoughtLevel?: string } = {};
      if (model_id) change.modelId = model_id;
      if (thought_level) change.thoughtLevel = thought_level;
      const result = await deps.provider.updateSessionModel!(
        { workspacePath: ws.canonicalPath, workspaceKey: ws.canonicalPath },
        session_id,
        change,
      );
      return { content: [{ type: "text", text: JSON.stringify({ workspace_id: ws.workspaceId, canonical_path: ws.canonicalPath, session_id, binding: result, session_preserved: true }) }] };
    } catch (err) { return errorToToolResult(err); }
  });

  server.registerTool(
    "resume_zcode_session",
    {
      title: "Resume ZCode session",
      description:
        "Submit a new instruction into an existing real ZCode session (sess_…), preserving its context.",
      inputSchema: {
        workspace_id: z.string(),
        session_id: z.string().regex(/^sess_[0-9a-f-]{36}$/i),
        instruction: z.string().min(1).max(20000),
      },
    },
    async ({ workspace_id, session_id, instruction }) => {
      try {
        const view = await deps.engine.submitTask({
          workspace_id,
          instruction,
          resume_session_id: session_id,
          immediate: true,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              view,
              null, 2,
            ),
          }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.registerTool(
    "provider_status",
    {
      title: "Provider status",
      description:
        "Z2C provider health, detected ZCode version, capability probe result, and the effective " +
        "provider/model binding OBSERVED via the native exact-session read for the requested " +
        "workspace's exact active session (workspace_id required). An unobserved binding is " +
        "reported as null; binding is never fabricated.",
      inputSchema: { workspace_id: z.string() },
    },
    async ({ workspace_id }) => {
      try {
        // Binding truth comes from the agent's own state for THIS workspace's
        // exact active session. No active session (or unobservable model
        // fields) reports null — registration alone proves transport, never
        // provider/model identity, and another workspace's state is never read.
        const workspace = deps.workspaces.resolveAuthorized(workspace_id);
        const q = deps.store.getOrCreateQueue(workspace.workspaceId);
        const active = q.activeTask ? deps.store.findTask(q.activeTask) : undefined;
        const modelBinding =
          active?.zcodeSessionId != null
            ? await deps.provider.readSessionBinding(active.zcodeSessionId, {
                workspacePath: workspace.canonicalPath,
                workspaceKey: workspace.canonicalPath,
              })
            : null;
        const body = {
          provider: deps.provider.name,
          uses_desktop_managed_auth: deps.provider.usesDesktopManagedAuth,
          status: deps.provider.status,
          detail: deps.provider.statusDetail ?? null,
          zcode_version: deps.provider.providerVersion,
          capabilities: deps.provider.capabilityResult,
          workspace_id: workspace.workspaceId,
          durable_idempotency: IDEMPOTENCY_PROTOCOL,
          session_id: active?.zcodeSessionId ?? null,
          model_binding: modelBinding,
        };
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  return server;
}

export async function startMcpHttpServer(
  deps: McpDeps,
  host: string,
  port: number,
  bearerToken: string,
): Promise<{ close: () => Promise<void> }> {
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();
  const httpServer = createServer((req, res) => {
    void handleHttp(req, res, bearerToken, deps, sessions);
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });
  return {
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        for (const s of sessions.values()) {
          void s.transport.close();
          void s.server.close();
        }
        sessions.clear();
      }),
  };
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  bearerToken: string,
  deps: McpDeps,
  sessions: Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>,
): Promise<void> {
  if (req.method === "GET" && req.url === "/health") {
    // Unauthenticated liveness probe: reveals only uptime status, no data.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", provider: deps.provider.status }));
    return;
  }
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ") || !constantTimeEquals(auth.slice(7), bearerToken)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    deps.audit.record("warn", "http.auth_rejected", { path: req.url ?? "" });
    return;
  }
  if (req.url !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  try {
    // Reuse the session's transport so MCP session state survives across requests.
    const sessionIdHeader = req.headers["mcp-session-id"];
    const existing = typeof sessionIdHeader === "string" ? sessions.get(sessionIdHeader) : undefined;
    if (existing) {
      await existing.transport.handleRequest(req, res);
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sid: string) => {
        sessions.set(sid, { transport, server });
      },
      onsessionclosed: (sid: string) => {
        sessions.delete(sid);
      },
    });
    const server = buildMcpServer(deps);
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    deps.audit.record("error", "http.mcp_error", { error: String((err as Error)?.message ?? err).slice(0, 300) });
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal" }));
    }
  }
}
