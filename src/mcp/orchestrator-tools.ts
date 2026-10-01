import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { orchestratorPlanSchema, StepSelectionError, type OrchestratorCore } from "../execution/orchestrator-core.js";
import { safeOutput } from "./zcode-tools.js";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
export function registerOrchestratorTools(server: McpServer, deps: {
  resolve(workspaceId: string, auth: AuthInfo | undefined): OrchestratorCore;
  requireScope(auth: AuthInfo | undefined, scope: string): Result | null;
  ok(data: unknown): Result;
  mapError(error: unknown): Result;
}): void {
  const identity = { workspace_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    run_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) };
  const audit = { ...identity, audit_id: z.string().max(100) };
  const owner = (auth?: AuthInfo) => auth?.clientId ?? "local";
  const register = <S extends z.ZodRawShape>(name: string, schema: S, scope: string,
    apply: (core: OrchestratorCore, args: z.infer<z.ZodObject<S>>, principal: string) => unknown | Promise<unknown>) => {
    server.registerTool(name, { inputSchema: z.object(schema).strict(),
      description: "Workspace-agnostic durable multi-agent plan. Every step's agent/model/effort is resolved against that agent's live catalog at admission and dispatch; exact selections only — ambiguity returns candidates and nothing ever falls back to another provider. Pause prevents future dispatch; it does not cancel admitted work.",
      annotations: { readOnlyHint: scope === "execution.read" } }, async (args, extra) => {
      const denied = deps.requireScope(extra.authInfo, scope);
      if (denied) return denied;
      try {
        const parsed = z.object(schema).strict().parse(args);
        const workspaceId = (parsed as { workspace_id: string }).workspace_id;
        return deps.ok(safeOutput(await apply(deps.resolve(workspaceId, extra.authInfo), parsed, owner(extra.authInfo))));
      } catch (error) {
        if (error instanceof StepSelectionError && error.candidates.length) {
          const result = deps.mapError(error);
          return { ...result, isError: true, content: [...result.content, {
            type: "text" as const, text: `candidates: ${JSON.stringify(error.candidates)}` }] };
        }
        return deps.mapError(error);
      }
    });
  };
  register("orchestrator_run_create", { ...identity, steps: orchestratorPlanSchema }, "execution.submit",
    (core, a, p) => core.create(a.run_id, p, a.steps));
  register("orchestrator_run_read", identity, "execution.read", (core, a, p) => core.read(a.run_id, p));
  register("orchestrator_run_pause", identity, "execution.submit", (core, a, p) => core.pause(a.run_id, p, true));
  register("orchestrator_run_resume", identity, "execution.submit", (core, a, p) => core.pause(a.run_id, p, false));
  register("orchestrator_audit_claim", audit, "execution.submit", (core, a, p) => core.claim(a.run_id, p, a.audit_id, p));
  register("orchestrator_audit_submit", { ...audit, verdict: z.enum(["PASS", "REWORK", "BLOCKED"]),
    note: z.string().max(1000).optional() }, "execution.submit",
    (core, a, p) => core.submitAudit(a.run_id, p, a.audit_id, p, a.verdict, a.note));
}
