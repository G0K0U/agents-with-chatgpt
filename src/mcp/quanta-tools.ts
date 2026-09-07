/**
 * Quanta Usage Telemetry & Policy Routing Tools
 *
 * Exposes read-only MCP tools:
 * - agent_usage_status: Polls local Quanta telemetry, normalizing quotas and redacting secrets.
 * - agent_route: Provides policy-grounded provider and model recommendations based on current quotas.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpContext } from "./server.js";
import { QuantaClient } from "../telemetry/quanta.js";
import { evaluateRoute } from "../telemetry/routing.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export interface QuantaToolDeps {
  ctx: McpContext;
  quantaClient?: QuantaClient;
  ok: (data: unknown) => ToolResult;
  fail: (code: string, message: string) => ToolResult;
  mapError: (error: unknown) => ToolResult;
  requireScope: (authInfo: AuthInfo | undefined, scope: string) => ToolResult | null;
  untrustedNote: string;
}

export function registerQuantaTools(server: McpServer, deps: QuantaToolDeps): void {
  const client = deps.quantaClient ?? new QuantaClient();

  server.registerTool(
    "agent_usage_status",
    {
      title: "Agent usage status",
      description:
        "Read local Quanta telemetry for available AI agents and quota pools (Codex, Antigravity Gemini, Antigravity Claude/GPT shared pool, GLM, DeepSeek, Muse). " +
        "All secrets, emails, and credentials are strictly redacted. " + deps.untrustedNote,
      inputSchema: {
        force_refresh: z.boolean().default(false).describe("Bypass telemetry cache and query Quanta immediately"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args, extra) => {
      const denied = deps.requireScope(extra.authInfo, "execution.read");
      if (denied) return denied;
      try {
        const report = await client.getTelemetry({ forceRefresh: args.force_refresh });
        return deps.ok(report);
      } catch (error) {
        return deps.mapError(error);
      }
    }
  );

  server.registerTool(
    "agent_route",
    {
      title: "Agent router recommendation",
      description:
        "Get a policy-grounded recommendation on which provider and model to use based on current Quanta quota telemetry, task type, and risk level. " +
        "Returns decision=route with a primary recommendation plus a fallback chain, or decision=blocked when every quota pool is exhausted/unavailable " +
        "(no forced recommendation is made). GLM and DeepSeek are telemetry-only: they are surfaced in usage data but are not auto-scheduled targets. " + deps.untrustedNote,
      inputSchema: {
        task_type: z.enum(["coding", "review", "architecture", "fast_edit", "audit"]).describe("Type of task to execute"),
        risk_level: z.enum(["low", "medium", "high"]).default("low").describe("Risk / complexity level of the task"),
        preferred_provider: z.enum(["codex", "gemini"]).optional().describe("Optional caller preference"),
        force_refresh: z.boolean().default(false).describe("Bypass telemetry cache before evaluating route"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args, extra) => {
      const denied = deps.requireScope(extra.authInfo, "execution.read");
      if (denied) return denied;
      try {
        const report = await client.getTelemetry({ forceRefresh: args.force_refresh });
        const decision = evaluateRoute(report, {
          task_type: args.task_type,
          risk_level: args.risk_level,
          preferred_provider: args.preferred_provider,
        });
        return deps.ok(decision);
      } catch (error) {
        return deps.mapError(error);
      }
    }
  );
}
