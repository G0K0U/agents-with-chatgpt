/**
 * Dynamic model catalog + no-inference model resolution (A2C public MCP).
 *
 *   agent_model_catalog  — live, account-scoped model directory per backend
 *   agent_model_resolve  — deterministic resolution of a user's model request
 *
 * Discovery is read-only: no inference, no session create/send/resume, no
 * default-model mutation. "Listed in the catalog" is not "inference-verified";
 * every section carries its own evidence level and a failure in one agent
 * never masks another.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  CATALOG_AGENTS,
  resolveModelSelection,
  type CatalogAgent,
  type ModelCatalogService,
  type ResolveRequest,
} from "../execution/model-catalog.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export interface ModelCatalogToolDeps {
  requireScope: (authInfo: AuthInfo | undefined, scope: string) => ToolResult | null;
  ok: (data: unknown) => ToolResult;
  fail: (code: string, message: string) => ToolResult;
  mapError: (error: unknown) => ToolResult;
  untrustedNote: string;
  /** Optional so test contexts without a catalog keep constructing. */
  catalogService?: ModelCatalogService;
}

const AGENT_FIELD = z.enum(["all", "codex", "antigravity", "zcode", "dsh"]).optional()
  .describe("Restrict to one backend; omitted or 'all' returns every backend section");

export function registerModelCatalogTools(server: McpServer, deps: ModelCatalogToolDeps): void {
  const { requireScope, ok, fail, mapError } = deps;
  const catalogService = () => deps.catalogService;

  server.registerTool("agent_model_catalog", {
    title: "Agent model catalog",
    description:
      "Live, account-scoped model directory for the local execution backends (Codex, Antigravity/Gemini, ZCode/GLM, DSH). " +
      "Read-only discovery: never starts inference or sessions, never changes default models. Each backend reports its " +
      "own source, runtime version, auth mode, completeness, and sanitized errors — one failed backend never hides " +
      "another. Catalog listing is NOT inference-verified availability. " + deps.untrustedNote,
    inputSchema: {
      agent: AGENT_FIELD,
      provider_id: z.string().max(64).optional().describe("Filter models to one upstream provider route (e.g. builtin:zai-start-plan)"),
      force_refresh: z.boolean().default(false).describe("Bypass the cache and re-read the live surfaces; a failed forced refresh may return an explicitly stale cache"),
      limit: z.number().int().min(1).max(200).optional().describe("Page size for the flattened model list"),
      cursor: z.string().max(512).optional().describe("Opaque pagination cursor"),
    },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => {
    const denied = requireScope(extra.authInfo, "execution.read");
    if (denied) return denied;
    const service = catalogService();
    if (!service) return fail("MODEL_CATALOG_UNAVAILABLE", "No model catalog service is wired into this bridge context");
    try {
      const agents: CatalogAgent[] = !args.agent || args.agent === "all"
        ? [...CATALOG_AGENTS]
        : [args.agent];
      const catalog = await service.get(agents, { forceRefresh: args.force_refresh === true });
      const allModels = catalog.agents.flatMap((section) => section.models.filter((entry) =>
        !args.provider_id || entry.provider_id === args.provider_id));
      const limit = args.limit ?? 100;
      let startIndex = 0;
      if (args.cursor) {
        const parsed = Number.parseInt(args.cursor, 10);
        if (Number.isFinite(parsed) && parsed > 0) startIndex = parsed;
      }
      const models = allModels.slice(startIndex, startIndex + limit);
      const nextCursor = startIndex + limit < allModels.length ? String(startIndex + limit) : null;
      return ok({
        ...catalog,
        pagination: { total_models: allModels.length, next_cursor: nextCursor },
        models,
        evidence_note: "catalog-listed is not inference-verified; use submit tools with an explicit resolved selection",
      });
    } catch (error) {
      return mapError(error);
    }
  });

  server.registerTool("agent_model_resolve", {
    title: "Resolve model selection",
    description:
      "Deterministic, no-inference resolution of a user's model request (e.g. 'GPT-6 Astra Max') against the live " +
      "catalog. Exact protocol ids win, then display names, then separator-normalized matches; ambiguous queries " +
      "return candidates instead of guessing. max and ultra are distinct efforts and never auto-upgraded. The result " +
      "is a selection, not an authorization: submitting still validates the caller, workspace, and current catalog. " +
      deps.untrustedNote,
    inputSchema: {
      agent: AGENT_FIELD,
      provider_id: z.string().max(64).optional().describe("Disambiguate between same-named models on different upstream provider routes"),
      model: z.string().min(1).max(200).optional().describe("Protocol model_id, display name, or bounded free query (e.g. 'GPT-6 Astra')"),
      effort: z.string().max(20).optional().describe("Reasoning effort/thought level; must be one the matched model advertises"),
      service_tier: z.string().max(32).optional().describe("Optional service tier check (e.g. fast); informational only"),
    },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => {
    const denied = requireScope(extra.authInfo, "execution.read");
    if (denied) return denied;
    const service = catalogService();
    if (!service) return fail("MODEL_CATALOG_UNAVAILABLE", "No model catalog service is wired into this bridge context");
    try {
      const agents: CatalogAgent[] = !args.agent || args.agent === "all"
        ? [...CATALOG_AGENTS]
        : [args.agent];
      const catalog = await service.get(agents, { forceRefresh: false });
      const request: ResolveRequest = {
        agent: args.agent && args.agent !== "all" ? args.agent : undefined,
        provider_id: args.provider_id,
        model: args.model,
        effort: args.effort,
        service_tier: args.service_tier,
      };
      const result = resolveModelSelection(catalog, request);
      return ok(result);
    } catch (error) {
      return mapError(error);
    }
  });
}
