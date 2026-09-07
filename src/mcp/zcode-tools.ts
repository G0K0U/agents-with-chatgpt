/**
 * ChatGPT-facing ZCode free-window queue tools.
 *
 * These tools give C2C governed access to the configured ZCode worker queue
 * (C2C_ZCODE_QUEUE_ROOT): enqueue governed tasks,
 * read merged queue/lifecycle status, and request cancellation. The queue
 * root is fixed in zcode-control.ts and can never be chosen by a caller.
 *
 * Governance: terminal receipts (COMPLETED/FAILED/CANCELLED) are written
 * exclusively by the ZCode free-window worker coordinator. This surface can
 * only append CANCEL_REQUESTED to control.jsonl.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  FIXED_ZCODE_QUEUE_ROOT,
  ZcodeControl,
  ZcodeControlError,
} from "../execution/zcode-control.js";
import { sanitizeExecutionOutput } from "../execution/sanitize.js";
import type { McpContext } from "./server.js";
import type { Workspace } from "../workspace/manager.js";
import { redact } from "../logger/index.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export interface ZcodeToolDeps {
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
    .replace(/(["'`])(?:[A-Za-z]:[\\/]|\\\\|\/)[^\r\n]*?\1/g, "$1[local-path]$1")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>]+/g, "[local-path]")
    .replace(/\/(?:Users|home|private|tmp|var|opt|srv|etc|mnt|media|workspace)\/[^\s"'`<>]+/g, "[local-path]");
}

export function safeOutput(value: unknown): unknown {
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

const resourcesField = z.array(z.string().min(1).max(160)).max(20).optional()
  .describe("Coarse resource locks this task touches, e.g. [\"frontend\", \"backend/api\"]");
const exclusivePathsField = z.array(z.string().min(1).max(160)).max(20).optional()
  .describe("Glob paths exclusively reserved for this task; write+write conflicts are decided on these");
const dependsOnField = z.array(z.string().min(3).max(64)).max(20).optional()
  .describe("Task ids that must reach COMPLETED before this task can be claimed");

export function registerZcodeTools(server: McpServer, deps: ZcodeToolDeps): void {
  const { ctx, resolveWorkspace, requireScope, fail, mapError, untrustedNote } = deps;
  const ok = (data: unknown): ToolResult => deps.ok(safeOutput(data));

  const control = (): ZcodeControl => new ZcodeControl();

  const mapErr = (error: unknown): ToolResult => {
    if (error instanceof ZcodeControlError) {
      return fail(error.code, error.message);
    }
    return mapError(error);
  };

  server.registerTool(
    "zcode_enqueue_task",
    {
      title: "Enqueue ZCode worker task",
      description:
        `Append one governed task to the fixed ZCode free-window queue ` +
        `(${redact(FIXED_ZCODE_QUEUE_ROOT)}). network must remain false. The task_id must be ` +
        `unique across the queue and its receipts. Credential-like instructions ` +
        `(token/password/cookie/api_key/client_secret/private key) are rejected. The ZCode ` +
        `free-window coordinator claims tasks during the discounted window; terminal ` +
        `receipts are written only by that coordinator. ${untrustedNote}`,
      inputSchema: {
        role: z.enum(["worker", "reviewer", "admin", "task"]).describe("Worker role requested for this task"),
        priority: z.number().int().min(-1_000_000).max(1_000_000).default(0)
          .describe("Higher value is claimed earlier; equal priority falls back to created_at order"),
        instruction: z.string().min(1).max(100_000)
          .describe("What the ZCode worker should do; credential-like content is rejected"),
        task_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/).optional()
          .describe("Unique idempotency key; generated when omitted"),
        mode: z.enum(["read", "write", "verify"]).optional()
          .describe("Task mode; undeclared write tasks are treated as globally exclusive"),
        resources: resourcesField,
        exclusive_paths: exclusivePathsField,
        depends_on: dependsOnField,
      },
      annotations: { readOnlyHint: false },
    },
    async (args, extra) => {
      const denied = requireScope(extra.authInfo, "execution.submit");
      if (denied) return denied;
      // Workspace authorization stays in C2C: the caller must hold access to
      // the default workspace even though the queue root itself is fixed.
      resolveWorkspace(undefined, extra.authInfo);
      try {
        const stored = await control().enqueue({
          task_id: args.task_id,
          role: args.role,
          priority: args.priority,
          instruction: args.instruction,
          network: false,
          mode: args.mode,
          resources: args.resources,
          exclusive_paths: args.exclusive_paths,
          depends_on: args.depends_on,
        });
        return ok({
          taskId: stored.task_id,
          createdAt: stored.created_at,
          role: stored.role,
          priority: stored.priority,
          network: false,
          status: "queued",
          queueRoot: "[fixed engineering-ai var/c2c-zcode root]",
          note: "Claimed only by the ZCode free-window coordinator; track with zcode_get_task.",
        });
      } catch (error) {
        return mapErr(error);
      }
    }
  );

  server.registerTool(
    "zcode_get_task",
    {
      title: "Get ZCode worker task",
      description:
        `Read one ZCode free-window task: merged status (queued → cancel_requested → running ` +
        `→ completed/failed/cancelled), its receipts and any recorded error. receipts.jsonl ` +
        `is the lifecycle truth. ${untrustedNote}`,
      inputSchema: {
        task_id: z.string().min(3).max(64).describe("Task id returned by zcode_enqueue_task"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args, extra) => {
      const denied = requireScope(extra.authInfo, "execution.read");
      if (denied) return denied;
      try {
        const view = control().getTask(args.task_id);
        if (!view) {
          return fail("ZCODE_TASK_UNKNOWN", `task_id ${args.task_id} is not a known queued task`);
        }
        return ok(view);
      } catch (error) {
        return mapErr(error);
      }
    }
  );

  server.registerTool(
    "zcode_list_tasks",
    {
      title: "List ZCode worker tasks",
      description:
        `List ZCode free-window tasks in queue order with merged lifecycle status and the ` +
        `bounded worker state cache. Use zcode_get_task for one task's receipts. ${untrustedNote}`,
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(50),
      },
      annotations: { readOnlyHint: true },
    },
    async (args, extra) => {
      const denied = requireScope(extra.authInfo, "execution.read");
      if (denied) return denied;
      try {
        return ok(control().listTasks(args.limit));
      } catch (error) {
        return mapErr(error);
      }
    }
  );

  server.registerTool(
    "zcode_cancel_task",
    {
      title: "Cancel ZCode worker task",
      description:
        `Request cancellation of a known non-terminal ZCode free-window task. This only ` +
        `appends CANCEL_REQUESTED to control.jsonl — it never writes terminal receipts; ` +
        `the ZCode coordinator owns COMPLETED/FAILED/CANCELLED. Repeated requests are ` +
        `idempotent. ${untrustedNote}`,
      inputSchema: {
        task_id: z.string().min(3).max(64).describe("Task id returned by zcode_enqueue_task"),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, extra) => {
      const denied = requireScope(extra.authInfo, "execution.cancel");
      if (denied) return denied;
      try {
        return ok(await control().requestCancel(args.task_id));
      } catch (error) {
        return mapErr(error);
      }
    }
  );
}
