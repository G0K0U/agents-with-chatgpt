/**
 * ChatGPT-facing Omnigent control tools.
 *
 * Full-access surface elected by the local operator: ChatGPT can dispatch
 * coding tasks to its registered providers (codex | glm), steer,
 * inspect bounded output and cancel. Workspace authorization, instruction
 * sanitization and output redaction stay in C2C; execution isolation stays
 * in Omnigent (session worktrees + its own policy engine).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  OmnigentControl,
  OMNIGENT_EFFORTS,
  OMNIGENT_PROVIDERS,
  OMNIGENT_SPEED_PROFILES,
  sanitizeOmnigentInstruction,
} from "../execution/omnigent-control.js";
import { OmnigentError } from "../execution/omnigent-client.js";
import type { McpContext } from "./server.js";
import type { Workspace } from "../workspace/manager.js";
import { sanitizeExecutionOutput } from "../execution/sanitize.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export interface OmnigentToolDeps {
  ctx: McpContext;
  resolveWorkspace: (
    requestedId: string | undefined,
    authInfo: AuthInfo | undefined,
    sessionId?: string
  ) => Workspace;
  requireScope: (authInfo: AuthInfo | undefined, scope: string) => ToolResult | null;
  ok: (data: unknown) => ToolResult;
  fail: (code: string, message: string) => ToolResult;
  mapError: (error: unknown) => ToolResult;
  untrustedNote: string;
}

function redactLocalPaths(value: string): string {
  return value
    // Quoted paths can contain spaces; redact the entire quoted path first.
    .replace(/(["'`])(?:[A-Za-z]:[\\/]|\\\\|\/)[^\r\n]*?\1/g, "$1[local-path]$1")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>]+/g, "[local-path]")
    .replace(/\/(?:Users|home|private|tmp|var|opt|srv|etc|mnt|media|workspace)\/[^\s"'`<>]+/g, "[local-path]");
}

function redactPath(value: string | null): string | null {
  return value ? "[local-path]" : null;
}

function safeOutput(value: unknown): unknown {
  if (typeof value === "string") {
    const sanitized = sanitizeExecutionOutput(value.replace(
      /\b((?:access[_-]?token|refresh[_-]?token|client[_-]?secret|token|cookie|password|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"';]+/gi,
      "$1[REDACTED]"
    ));
    return sanitized.allowed ? redactLocalPaths(sanitized.text) : "[withheld]";
  }
  if (Array.isArray(value)) return value.map(safeOutput);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [String(safeOutput(key)), safeOutput(item)])
  );
  return value;
}

/** Branch names are pre-filtered here; Omnigent enforces full git ref rules. */
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;

export function registerOmnigentTools(server: McpServer, deps: OmnigentToolDeps): void {
  const { ctx, resolveWorkspace, requireScope, fail, mapError, untrustedNote } = deps;
  const ok = (data: unknown): ToolResult => deps.ok(safeOutput(data));

  let control: OmnigentControl | undefined;
  const omnigent = (): OmnigentControl => {
    control ??= new OmnigentControl({ stateDir: ctx.stateDir });
    return control;
  };

  const mapErr = (error: unknown): ToolResult =>
    safeOutput(error instanceof OmnigentError ? fail(error.code, error.message) : mapError(error)) as ToolResult;

  const instruction = (raw: string): string => {
    try {
      return sanitizeOmnigentInstruction(raw);
    } catch (error) {
      if (error instanceof OmnigentError && error.code === "SENSITIVE_TASK_INPUT") {
        throw error;
      }
      throw new OmnigentError("SENSITIVE_TASK_INPUT", "The instruction could not be sanitized safely");
    }
  };

  server.registerTool(
    "omnigent_status",
    {
      title: "Omnigent status",
      description:
        `Check the local Omnigent orchestration backend: server health, execution host, ` +
        `harness readiness (codex, glm/oh-my-pi) and registered provider agents. Note: gemini ` +
        `is not an Omnigent provider on this deployment — submit Gemini tasks via ` +
        `submit_codex_task(provider=gemini), which drives the local agy CLI with Google OAuth. ` +
        `Call this before submitting Omnigent tasks. ${untrustedNote}`,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (_args, extra) => {
      const denied = requireScope(extra.authInfo, "workspace.read");
      if (denied) return denied;
      try {
        return ok(await omnigent().status());
      } catch (error) {
        return mapErr(error);
      }
    }
  );

  server.registerTool(
    "omnigent_submit_task",
    {
      title: "Submit Omnigent task",
      description:
        `Dispatch a coding task to the local Omnigent meta-harness. provider selects the ` +
        `execution stack: codex (OpenAI Codex) or glm (oh-my-pi on Z.AI GLM). The provider is ` +
        `pinned — an unavailable provider fails the task and is never silently substituted. ` +
        `never silently substituted. Optionally creates a dedicated git worktree branch; the ` +
        `task never writes outside it when one is created. Pass session_id of a previous ` +
        `result to continue that session instead of creating a new one. ${untrustedNote}`,
      inputSchema: {
        provider: z.enum(OMNIGENT_PROVIDERS).optional().describe("Pinned provider; defaults to codex for new sessions, existing binding for continuations"),
        instruction: z.string().min(1).max(100_000).describe("What the agent should do"),
        workspace_id: z.string().min(1).optional().describe("Stable authorized workspace id"),
        branch_name: z.string().regex(BRANCH_PATTERN).optional()
          .describe("Create the task in a fresh git worktree on this branch instead of the checkout"),
        title: z.string().min(1).max(200).optional().describe("Short session title"),
        model: z.string().min(1).max(256).optional()
          .describe("Provider model id, pinned immutably for the C2C session"),
        effort: z.enum(OMNIGENT_EFFORTS).optional()
          .describe("Reasoning effort; provider support is validated and unsupported values fail closed"),
        speed_profile: z.enum(OMNIGENT_SPEED_PROFILES).optional()
          .describe("Reserved unified control; the installed Omnigent API has no mapping, so every value fails explicitly"),
        session_id: z.string().min(8).max(64).optional()
          .describe("Continue an existing Omnigent session instead of creating a new one"),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, extra) => {
      const denied = requireScope(extra.authInfo, "execution.submit");
      if (denied) return denied;
      try {
        const text = instruction(args.instruction);
        const selected = resolveWorkspace(args.workspace_id, extra.authInfo);
        if (args.session_id) {
          const view = await omnigent().followUp(args.session_id, text, args.provider, {
            model: args.model,
            effort: args.effort,
            speedProfile: args.speed_profile,
          });
          return ok({
            taskId: view.taskId,
            provider: view.provider,
            harness: view.harness,
            status: "submitted",
            continued: true,
            taskStatus: view.status,
            branch: view.branch,
            workspacePath: redactPath(view.workspacePath),
            modelRequested: view.modelRequested,
            modelEffective: view.modelEffective,
            effortRequested: view.effortRequested,
            effortEffective: view.effortEffective,
          });
        }
        const result = await omnigent().submitTask({
          provider: args.provider ?? "codex",
          workspacePath: selected.root,
          instruction: text,
          branchName: args.branch_name,
          title: args.title,
          model: args.model,
          effort: args.effort,
          speedProfile: args.speed_profile,
        });
        return ok({
          taskId: result.taskId,
          provider: result.provider,
          harness: result.harness,
          status: result.status,
          branch: result.branch,
          workspacePath: redactPath(result.workspacePath),
          modelRequested: result.modelRequested,
          modelEffective: result.modelEffective,
          effortRequested: result.effortRequested,
          effortEffective: result.effortEffective,
          note: "Poll with omnigent_get_task; cancel with omnigent_cancel_task.",
        });
      } catch (error) {
        return mapErr(error);
      }
    }
  );

  server.registerTool(
    "omnigent_get_task",
    {
      title: "Get Omnigent task",
      description:
        `Read an Omnigent task's status and, once the turn has settled, its bounded ` +
        `assistant output. Includes the harness, worktree branch, model identity, token ` +
        `usage and any task error. ${untrustedNote}`,
      inputSchema: {
        task_id: z.string().min(8).max(64).describe("Task id returned by omnigent_submit_task"),
        include_output: z.boolean().default(true).describe("Include the final assistant output when the task has settled"),
        max_chars: z.number().int().min(200).max(20_000).default(4_000)
          .describe("Output length cap in characters"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args, extra) => {
      const denied = requireScope(extra.authInfo, "execution.read");
      if (denied) return denied;
      try {
        const view = await omnigent().taskStatus(args.task_id, args.include_output);
        return ok({
          taskId: view.taskId,
          provider: view.provider,
          title: view.title,
          status: view.status,
          underlyingStatus: view.underlyingStatus ?? null,
          harness: view.harness,
          branch: view.branch,
          workspacePath: redactPath(view.workspacePath),
          runnerOnline: view.runnerOnline,
          reportedModel: view.reportedModel,
          modelRequested: view.modelRequested,
          modelEffective: view.modelEffective,
          effortRequested: view.effortRequested,
          effortEffective: view.effortEffective,
          inputTokens: view.inputTokens,
          outputTokens: view.outputTokens,
          reasoningTokens: view.reasoningTokens,
          cachedTokens: view.cachedTokens,
          totalTokens: view.totalTokens,
          costUsd: view.costUsd,
          latencyMs: view.latencyMs,
          timeToFirstTokenMs: view.timeToFirstTokenMs,
          attemptCount: view.attemptCount,
          startedAt: view.startedAt,
          completedAt: view.completedAt,
          totalCostUsd: view.totalCostUsd,
          usageByModel: view.usageByModel,
          error: view.error,
          output: view.output === undefined ? null : redactLocalPaths(view.output).slice(0, args.max_chars),
        });
      } catch (error) {
        return mapErr(error);
      }
    }
  );

  server.registerTool(
    "omnigent_followup_task",
    {
      title: "Send follow-up to Omnigent task",
      description:
        `Send an additional instruction to a running or completed Omnigent task. The ` +
        `message is delivered to the same session, agent and provider — the provider ` +
        `can never change mid-task. ${untrustedNote}`,
      inputSchema: {
        task_id: z.string().min(8).max(64).describe("Task id returned by omnigent_submit_task"),
        instruction: z.string().min(1).max(100_000).describe("Follow-up instruction"),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, extra) => {
      const denied = requireScope(extra.authInfo, "execution.submit");
      if (denied) return denied;
      try {
        const text = instruction(args.instruction);
        const view = await omnigent().followUp(args.task_id, text);
        return ok({ taskId: args.task_id, provider: view.provider, harness: view.harness, status: "submitted", continued: true });
      } catch (error) {
        return mapErr(error);
      }
    }
  );

  server.registerTool(
    "omnigent_cancel_task",
    {
      title: "Cancel Omnigent task",
      description:
        `Cancel an Omnigent task. Default is a graceful interrupt of the current turn; ` +
        `hard=true additionally stops the session's runner process. The provider is not ` +
        `affected beyond this task. ${untrustedNote}`,
      inputSchema: {
        task_id: z.string().min(8).max(64).describe("Task id returned by omnigent_submit_task"),
        hard: z.boolean().default(false).describe("Also stop the session runner (stop_session)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args, extra) => {
      const denied = requireScope(extra.authInfo, "execution.cancel");
      if (denied) return denied;
      try {
        await omnigent().cancel(args.task_id, args.hard);
        const view = await omnigent().taskStatus(args.task_id, false);
        return ok({ taskId: view.taskId, status: view.status, cancelled: true, hard: args.hard });
      } catch (error) {
        return mapErr(error);
      }
    }
  );

  server.registerTool(
    "omnigent_list_tasks",
    {
      title: "List Omnigent tasks",
      description:
        `List recent Omnigent sessions (tasks) with id, title, status and harness, most ` +
        `recent first. Use omnigent_get_task for details of one task. ${untrustedNote}`,
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    async (args, extra) => {
      const denied = requireScope(extra.authInfo, "execution.read");
      if (denied) return denied;
      try {
        return ok({ tasks: await omnigent().listSessions(args.limit) });
      } catch (error) {
        return mapErr(error);
      }
    }
  );
}
