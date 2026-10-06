/** D2C tools: A2C authorization and durable ownership around native DSH Sessions. */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { DshNativeClient, DshNativeError } from "../execution/dsh-native-client.js";
import { DshNativeService, canonicalDshRoot, sameDshRoot } from "../execution/dsh-native-service.js";
import { safeOutput } from "./zcode-tools.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export interface DshNativeToolDeps {
  requireScope: (authInfo: AuthInfo | undefined, scope: string) => ToolResult | null;
  resolveWorkspace: (requestedId: string, authInfo: AuthInfo | undefined, sessionId?: string) => unknown;
  visibleWorkspaces: (authInfo: AuthInfo | undefined) => Array<{ workspaceId: string; canonicalPath: string }>;
  stateDir?: string;
  ok: (data: unknown) => ToolResult;
  fail: (code: string, message: string) => ToolResult;
  mapError: (error: unknown) => ToolResult;
  untrustedNote: string;
}

let cachedService: DshNativeService | null = null;
let cachedStateDir: string | null = null;

function serviceFor(deps: DshNativeToolDeps): DshNativeService {
  const stateDir = deps.stateDir ?? "";
  if (!cachedService || cachedStateDir !== stateDir) {
    cachedStateDir = stateDir;
    cachedService = new DshNativeService(stateDir, new DshNativeClient());
  }
  return cachedService;
}

export function resetDshNativeToolsForTests(): void {
  cachedService = null;
  cachedStateDir = null;
}

const workspaceId = z.string().min(3).max(128);
const sessionId = z.string().min(8).max(100);
const requestId = z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/);
const taskId = z.string().regex(/^c2c_dsh_[0-9a-f]{24}$/);

export function registerDshNativeTools(server: McpServer, deps: DshNativeToolDeps): void {
  const safe = (value: unknown): ToolResult => deps.ok(safeOutput(value));
  const owner = (authInfo: AuthInfo | undefined): string =>
    authInfo?.clientId && typeof authInfo.clientId === "string" ? authInfo.clientId : "local";
  const mapErr = (error: unknown): ToolResult => error instanceof DshNativeError
    ? deps.fail(error.code, error.message) : deps.mapError(error);
  const workspace = (id: string, authInfo: AuthInfo | undefined): { id: string; root: string } => {
    const resolved = deps.resolveWorkspace(id, authInfo) as { id?: string; root?: string; canonicalPath?: string };
    const root = resolved?.canonicalPath ?? resolved?.root;
    const visible = deps.visibleWorkspaces(authInfo).find((item) => item.workspaceId === id);
    if (!root || !visible || !sameDshRoot(visible.canonicalPath, root)) {
      throw new DshNativeError("D2C_WORKSPACE_FORBIDDEN", "Workspace is not authorized for this client");
    }
    return { id, root: canonicalDshRoot(root) };
  };

  server.registerTool("dsh_runtime_capabilities", {
    title: "DSH native runtime identity and capabilities",
    description: "Authenticated loopback DSH Desktop identity, health, generation, and honest capability flags.",
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, async (_args, extra) => {
    const denied = deps.requireScope(extra.authInfo, "execution.read"); if (denied) return denied;
    try { return safe(await serviceFor(deps).runtime()); } catch (error) { return mapErr(error); }
  });

  server.registerTool("dsh_workspace_list", {
    title: "List DSH-authorized workspaces",
    description: "A2C workspaces authorized for this caller; DSH Session operations are bound to their canonical roots.",
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, async (_args, extra) => {
    const denied = deps.requireScope(extra.authInfo, "workspace.read"); if (denied) return denied;
    return safe({ workspaces: deps.visibleWorkspaces(extra.authInfo).map((item) => ({
      workspace_id: item.workspaceId, canonical_root: item.canonicalPath,
    })) });
  });

  server.registerTool("dsh_model_catalog", {
    title: "List native DSH models",
    description: "DSH session-controller model catalog and deployment default. Read-only.",
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, async (_args, extra) => {
    const denied = deps.requireScope(extra.authInfo, "execution.read"); if (denied) return denied;
    try { return safe(await serviceFor(deps).models()); } catch (error) { return mapErr(error); }
  });

  server.registerTool("dsh_session_list", {
    title: "List native DSH sessions",
    description: "Cold-safe DSH Desktop/native and D2C Session discovery in authorized workspaces. No Agent activation.",
    inputSchema: { workspace_id: workspaceId.optional(), limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => {
    const denied = deps.requireScope(extra.authInfo, "execution.read"); if (denied) return denied;
    try {
      const workspaces = args.workspace_id
        ? [workspace(args.workspace_id, extra.authInfo)]
        : deps.visibleWorkspaces(extra.authInfo).map((item) => workspace(item.workspaceId, extra.authInfo));
      const results = await Promise.all(workspaces.map(async (w) => ({ workspace_id: w.id,
        ...(await serviceFor(deps).list(w.root)) })));
      return safe({ sessions: results.flatMap((entry) => entry.items.map((item) => ({
        ...item, workspace_id: entry.workspace_id,
      }))).slice(0, args.limit ?? 50) });
    } catch (error) { return mapErr(error); }
  });

  server.registerTool("dsh_session_create", {
    title: "Create an owned native DSH session",
    description: "Create or idempotently resume a DSH Session in one authorized workspace, with durable A2C ownership. " + deps.untrustedNote,
    inputSchema: { workspace_id: workspaceId, request_id: requestId },
  }, async (args, extra) => {
    const denied = deps.requireScope(extra.authInfo, "execution.submit"); if (denied) return denied;
    try {
      const w = workspace(args.workspace_id, extra.authInfo);
      return safe(await serviceFor(deps).create(w.id, w.root, owner(extra.authInfo), args.request_id));
    } catch (error) { return mapErr(error); }
  });

  server.registerTool("dsh_session_attach", {
    title: "Attach to an owned DSH session",
    description: "Explicitly attach only to a D2C-owned idle Session. Desktop/native sessions without provable writer ownership are refused.",
    inputSchema: { workspace_id: workspaceId, session_id: sessionId },
  }, async (args, extra) => {
    const denied = deps.requireScope(extra.authInfo, "execution.submit"); if (denied) return denied;
    try {
      const w = workspace(args.workspace_id, extra.authInfo);
      return safe(await serviceFor(deps).attach(w.id, w.root, args.session_id, owner(extra.authInfo)));
    } catch (error) { return mapErr(error); }
  });

  server.registerTool("dsh_session_read", {
    title: "Read a DSH session",
    description: "Cold-safe native Session status and bounded visible user/assistant history. Hidden reasoning is excluded.",
    inputSchema: { workspace_id: workspaceId, session_id: sessionId,
      limit: z.number().int().min(1).max(50).optional() },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => {
    const denied = deps.requireScope(extra.authInfo, "execution.read"); if (denied) return denied;
    try {
      const w = workspace(args.workspace_id, extra.authInfo);
      return safe(await serviceFor(deps).read(w.root, args.session_id, args.limit ?? 30));
    } catch (error) { return mapErr(error); }
  });

  server.registerTool("dsh_session_send", {
    title: "Send an owned DSH Session turn",
    description: "Admit one idempotent prompt through the native DSH session-controller. Busy or foreign writers are refused. " + deps.untrustedNote,
    inputSchema: { workspace_id: workspaceId, session_id: sessionId, request_id: requestId,
      instruction: z.string().min(1).max(20_000), expected_model: z.string().min(1).max(200).optional() },
  }, async (args, extra) => {
    const denied = deps.requireScope(extra.authInfo, "execution.submit"); if (denied) return denied;
    try {
      const w = workspace(args.workspace_id, extra.authInfo);
      const task = await serviceFor(deps).send(w.id, w.root, args.session_id, owner(extra.authInfo),
        args.request_id, args.instruction, args.expected_model);
      return safe({ task_id: task.taskId, session_id: task.sessionId, status: task.status,
        model: task.providerModel, submitted_at: task.submittedAt });
    } catch (error) { return mapErr(error); }
  });

  server.registerTool("dsh_task_submit", {
    title: "Submit an exact-model DSH task",
    description: "Create an owned DSH session and submit one idempotent task with an exact model and effort. " +
      "The DSH runtime holds a transactional selection lease and restores its original default and local slot after the native turn. " + deps.untrustedNote,
    inputSchema: { provider: z.literal("dsh"), workspace_id: workspaceId, request_id: requestId,
      model: z.string().min(1).max(200), effort: z.enum(["low", "medium", "high"]),
      instruction: z.string().min(1).max(20_000) },
  }, async (args, extra) => {
    const denied = deps.requireScope(extra.authInfo, "execution.submit"); if (denied) return denied;
    try {
      const w = workspace(args.workspace_id, extra.authInfo);
      const task = await serviceFor(deps).submitSelected(w.id, w.root, owner(extra.authInfo),
        args.request_id, args.instruction, args.model, args.effort);
      return safe({ task_id: task.taskId, session_id: task.sessionId, status: task.status,
        provider: "dsh", model: task.providerModel, effort: task.effort,
        selection_scope: task.selectionScope, lease_sequence: task.leaseSequence,
        submitted_at: task.submittedAt });
    } catch (error) { return mapErr(error); }
  });

  server.registerTool("dsh_task_read", {
    title: "Read a DSH task",
    description: "Read native DSH turn status and visible output reference, verified against the same Session log.",
    inputSchema: { workspace_id: workspaceId, task_id: taskId },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => {
    const denied = deps.requireScope(extra.authInfo, "execution.read"); if (denied) return denied;
    try {
      const w = workspace(args.workspace_id, extra.authInfo);
      return safe(await serviceFor(deps).task(w.id, w.root, args.task_id));
    } catch (error) { return mapErr(error); }
  });

  server.registerTool("dsh_task_output", {
    title: "Read owned DSH task output",
    description: "Bounded sanitized final assistant output captured from the native DSH Session log.",
    inputSchema: { workspace_id: workspaceId, task_id: taskId },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => {
    const denied = deps.requireScope(extra.authInfo, "execution.read"); if (denied) return denied;
    try {
      const w = workspace(args.workspace_id, extra.authInfo);
      return safe(serviceFor(deps).output(w.id, args.task_id, owner(extra.authInfo)));
    } catch (error) { return mapErr(error); }
  });

  server.registerTool("dsh_task_events", {
    title: "Read visible DSH task events",
    description: "Read bounded user and assistant Session events for one native task; tool internals and hidden reasoning are excluded.",
    inputSchema: { workspace_id: workspaceId, task_id: taskId },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => {
    const denied = deps.requireScope(extra.authInfo, "execution.read"); if (denied) return denied;
    try {
      const w = workspace(args.workspace_id, extra.authInfo);
      return safe(await serviceFor(deps).taskEvents(w.id, w.root, args.task_id));
    } catch (error) { return mapErr(error); }
  });

  server.registerTool("dsh_task_cancel", {
    title: "Cancel an owned DSH task",
    description: "Request native cancellation only for the caller's active, disposable D2C turn.",
    inputSchema: { workspace_id: workspaceId, task_id: taskId },
  }, async (args, extra) => {
    const denied = deps.requireScope(extra.authInfo, "execution.cancel"); if (denied) return denied;
    try {
      const w = workspace(args.workspace_id, extra.authInfo);
      return safe(await serviceFor(deps).cancel(w.id, w.root, args.task_id, owner(extra.authInfo)));
    } catch (error) { return mapErr(error); }
  });

  server.registerTool("dsh_session_select_model", {
    title: "DSH Session model selection support",
    description: "Reports unsupported control: this installed native DSH API also saves the global default when selecting a Session model.",
    inputSchema: { workspace_id: workspaceId, session_id: sessionId, provider: z.string(),
      model: z.string(), reasoning_effort: z.string().optional() },
  }, async (_args, extra) => {
    const denied = deps.requireScope(extra.authInfo, "execution.submit"); if (denied) return denied;
    return deps.fail("D2C_UNSUPPORTED", "Installed DSH selectModel changes the global default; Session-local selection is unavailable");
  });
}
