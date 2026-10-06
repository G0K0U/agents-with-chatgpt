/**
 * Provider-neutral shared session/activity plane tools (A2C public MCP).
 *
 * These tools make Codex, Gemini/Antigravity, ZCode/GLM, and DSH work mutually
 * observable through ONE projection while keeping CONTROL owner-bound in each
 * provider's own enforcement path:
 *
 *   agent_session_list      — shared session projection (all providers/origins)
 *   agent_session_read      — one session's projection (live-enriched for zcode)
 *   agent_session_messages  — visible user instructions + assistant responses
 *   agent_activity_list     — bounded activity feed with seq cursor
 *   agent_task_read         — bounded task view incl. actionEvidence/verification
 *   agent_output_read       — sanitized captured output body
 *
 * Security: workspace-authorized callers observe every session in their
 * workspaces (A2C- or native/Desktop-originated); the local operator observes
 * all authorized workspaces. Nothing here mutates a session. Hidden
 * reasoning is structurally excluded (visible roles/text parts only), and all
 * content passes token/credential redaction plus local-path masking.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  loadZcodeSessionOwnership,
  type ZcodeSessionOwnership,
} from "../execution/zcode-session-ownership.js";
import { ZcodeSessionError } from "../execution/zcode-session-client.js";
import { DshNativeClient, DshNativeError } from "../execution/dsh-native-client.js";
import { AgentPlane, AgentPlaneError } from "../session-plane/plane.js";
import type {
  AgentProviderName,
  AgentSessionOrigin,
  AgentSessionRecord,
  AgentActivityEvent,
  AgentTaskView,
} from "../session-plane/types.js";
import { zcodeSessionClient, resetZcodeSessionClientForTests } from "./zcode-session-tools.js";
import { safeOutput } from "./zcode-tools.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export interface AgentPlaneToolDeps {
  requireScope: (authInfo: AuthInfo | undefined, scope: string) => ToolResult | null;
  /** Registered A2C workspaces visible to this principal (id + canonical root). */
  visibleWorkspaces: (authInfo: AuthInfo | undefined) => Array<{ workspaceId: string; canonicalPath: string }>;
  stateDir?: string;
  ok: (data: unknown) => ToolResult;
  fail: (code: string, message: string) => ToolResult;
  mapError: (error: unknown) => ToolResult;
  untrustedNote: string;
}

let cachedPlane: AgentPlane | null = null;
let cachedPlaneDir: string | null = null;
let cachedOwnership: ZcodeSessionOwnership | null = null;
let cachedOwnershipDir: string | null = null;

function ownershipFor(stateDir: string | undefined): ZcodeSessionOwnership {
  if (!stateDir) {
    memoryOwnership ??= loadZcodeSessionOwnership("");
    return memoryOwnership;
  }
  if (!cachedOwnership || cachedOwnershipDir !== stateDir) {
    cachedOwnershipDir = stateDir;
    cachedOwnership = loadZcodeSessionOwnership(stateDir);
  }
  return cachedOwnership;
}
let memoryOwnership: ZcodeSessionOwnership | null = null;

function planeFor(deps: AgentPlaneToolDeps): AgentPlane {
  const stateDir = deps.stateDir ?? "";
  if (!cachedPlane || cachedPlaneDir !== stateDir) {
    cachedPlaneDir = stateDir;
    cachedOwnership = ownershipFor(stateDir);
    let client: ReturnType<typeof zcodeSessionClient> | null = null;
    try {
      client = zcodeSessionClient();
    } catch {
      client = null; // Z2C lane unconfigured: plane still serves codex/gemini
    }
    cachedPlane = new AgentPlane({
      stateDir,
      workspaces: () => deps.visibleWorkspaces(undefined),
      zcodeClient: client,
      dshClient: new DshNativeClient(),
      ownership: cachedOwnership,
    });
  }
  return cachedPlane;
}

/** Test seam. */
export function resetAgentPlaneForTests(): void {
  cachedPlane = null;
  cachedPlaneDir = null;
  cachedOwnership = null;
  cachedOwnershipDir = null;
  memoryOwnership = null;
  resetZcodeSessionClientForTests();
}

function formatSessionForMcp(record: AgentSessionRecord) {
  return {
    ...record,
    session_id: record.sessionId,
    workspace_id: record.workspaceId,
    canonical_root: record.canonicalRoot,
    native_session_id: record.nativeSessionId,
    provider_session_id: record.providerSessionId,
    owner_client_id: record.ownerClientId,
    thought_level: record.thoughtLevel,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    task_ids: record.taskIds,
    last_user_instruction: record.lastUserInstruction,
    last_assistant_output: record.lastAssistantOutput,
    changed_files_count: record.changedFilesCount,
    verification_status: record.verificationStatus,
    observed_at: record.observedAt,
  };
}

function formatActivityForMcp(event: AgentActivityEvent) {
  return {
    ...event,
    workspace_id: event.workspaceId,
    session_id: event.sessionId,
    task_id: event.taskId,
    output_ref: event.outputRef ?? null,
  };
}

function formatTaskForMcp(task: AgentTaskView) {
  return {
    ...task,
    task_id: task.taskId,
    workspace_id: task.workspaceId,
    session_id: task.sessionId,
    provider_session_id: task.providerSessionId,
    exit_status: task.exitStatus,
    submitted_at: task.submittedAt,
    started_at: task.startedAt,
    completed_at: task.completedAt,
    owner_id: task.ownerId,
    instruction_preview: task.instructionPreview,
    changed_files_count: task.changedFilesCount,
    changed_files: task.changedFiles,
    network_requested: task.networkRequested,
    network_effective: task.networkEffective,
    output_ids: task.outputIds,
    output_available: task.outputAvailable,
    action_evidence: task.actionEvidence,
  };
}

const sessionIdField = z.string().min(8).max(80).describe("Shared-plane session id (c2cs_… or native sess_…)");
const workspaceIdField = z.string().min(3).max(128).describe("A2C authorized workspace id");

export function registerAgentPlaneTools(server: McpServer, deps: AgentPlaneToolDeps): void {
  const { requireScope, ok, fail, mapError } = deps;
  const safe = (data: unknown): ToolResult => deps.ok(safeOutput(data));

  const mapErr = (error: unknown): ToolResult => {
    if (error instanceof AgentPlaneError) return fail(error.code, error.message);
    if (error instanceof ZcodeSessionError) {
      return fail(error.code, error.upstreamCode ? `[${error.upstreamCode}] ${error.message}` : error.message);
    }
    if (error instanceof DshNativeError) return fail(error.code, error.message);
    return mapError(error);
  };

  server.registerTool("agent_session_list", {
    title: "List shared agent sessions",
    description:
      "Provider-neutral session projection across Codex, Gemini/Antigravity, ZCode/GLM, and DSH — including native/" +
      "Desktop-originated ZCode sessions discovered from runtime state. Observe-only; control stays owner-bound. " + deps.untrustedNote,
    inputSchema: {
      provider: z.enum(["codex", "gemini", "zcode", "dsh"]).optional(),
      origin: z.enum(["a2c", "native", "desktop"]).optional(),
      workspace_id: workspaceIdField.optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().max(512).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => {
    const denied = requireScope(extra.authInfo, "execution.read");
    if (denied) return denied;
    try {
      const result = await planeFor(deps).listSessions(extra.authInfo, {
        provider: args.provider,
        origin: args.origin,
        workspaceId: args.workspace_id,
        limit: args.limit,
        cursor: args.cursor,
      });
      return safe({
        ...result,
        sessions: result.sessions.map(formatSessionForMcp),
      });
    } catch (err) { return mapErr(err); }
  });

  server.registerTool("agent_session_read", {
    title: "Read shared agent session",
    description:
      "Sanitized projection of one shared session (provider, origin, workspace binding, owner/controller projection, " +
      "model, effort/thought, status, tasks, verification metadata). ZCode and DSH sessions are live-enriched. Observe-only.",
    inputSchema: { session_id: sessionIdField },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => {
    const denied = requireScope(extra.authInfo, "execution.read");
    if (denied) return denied;
    try {
      const record = await planeFor(deps).readSession(extra.authInfo, args.session_id);
      return safe({
        ...formatSessionForMcp(record),
        caller_can_control: planeFor(deps).callerCanControl(extra.authInfo, record),
      });
    } catch (err) { return mapErr(err); }
  });

  server.registerTool("agent_session_messages", {
    title: "Read shared agent session messages",
    description:
      "Visible message history of a shared session: user instructions and assistant final responses only — never " +
      "hidden reasoning or tool internals. Bounded and redacted. Observe-only.",
    inputSchema: { session_id: sessionIdField, limit: z.number().int().min(1).max(50).optional() },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => {
    const denied = requireScope(extra.authInfo, "execution.read");
    if (denied) return denied;
    try {
      const res = await planeFor(deps).sessionMessages(extra.authInfo, args.session_id, args.limit ?? 20);
      return safe({
        ...res,
        session_id: res.sessionId,
      });
    } catch (err) { return mapErr(err); }
  });

  server.registerTool("agent_activity_list", {
    title: "List shared agent activity",
    description:
      "Bounded activity feed (session created/updated/discovered, task lifecycle) across providers with a " +
      "seq-cursor for pagination. Observe-only.",
    inputSchema: {
      provider: z.enum(["codex", "gemini", "zcode", "dsh"]).optional(),
      session_id: sessionIdField.optional(),
      workspace_id: workspaceIdField.optional(),
      after_seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => {
    const denied = requireScope(extra.authInfo, "execution.read");
    if (denied) return denied;
    try {
      const res = await planeFor(deps).listActivity(extra.authInfo, {
        provider: args.provider,
        sessionId: args.session_id,
        workspaceId: args.workspace_id,
        afterSeq: args.after_seq,
        limit: args.limit,
      });
      return safe({
        ...res,
        last_seq: res.lastSeq,
        events: res.events.map(formatActivityForMcp),
      });
    } catch (err) { return mapErr(err); }
  });

  server.registerTool("agent_task_read", {
    title: "Read shared agent task",
    description:
      "Bounded, sanitized task view across providers: status, model, changed-file summary, output references, " +
      "actionEvidence (turn completed vs. verified) and verification metadata. Observe-only.",
    inputSchema: { workspace_id: workspaceIdField, task_id: z.string().min(6).max(64) },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => {
    const denied = requireScope(extra.authInfo, "execution.read");
    if (denied) return denied;
    try {
      const task = planeFor(deps).readTask(extra.authInfo, args.workspace_id, args.task_id);
      return safe(formatTaskForMcp(task));
    } catch (err) { return mapErr(err); }
  });

  server.registerTool("agent_output_read", {
    title: "Read shared agent output",
    description:
      "Read one sanitized captured output body (assistant final message, command output, verification output) by " +
      "workspace-scoped numeric id. Restricted outputs never return bodies. Observe-only.",
    inputSchema: {
      workspace_id: workspaceIdField,
      output_id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => {
    const denied = requireScope(extra.authInfo, "execution.read");
    if (denied) return denied;
    try {
      return safe(await Promise.resolve(planeFor(deps).readOutput(extra.authInfo, args.workspace_id, args.output_id)));
    } catch (err) { return mapErr(err); }
  });
}

export type { AgentProviderName, AgentSessionOrigin };
