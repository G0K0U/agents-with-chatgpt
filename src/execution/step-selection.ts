import { resolveModelSelection, type CatalogAgent, type ModelCatalog, type ModelCatalogService } from "./model-catalog.js";
import { StepSelectionError, type ResolvedStepSelection, type StepSelectionResolver } from "./orchestrator-core.js";

/**
 * The Orchestrator's live-catalog selection seam.
 *
 * Resolution is provider-neutral and workspace-agnostic: the SAME function
 * resolves any agent (codex | antigravity | zcode | dsh) in any workspace,
 * purely from that agent's authoritative live catalog section. There are no
 * per-workspace overrides, no encoded model lists, and no fallback: a request
 * that the live catalog cannot satisfy EXACTLY fails with a typed error and
 * candidates for the caller to disambiguate.
 *
 * Freshness: every resolution forces a refresh and forbids stale evidence
 * (allowStale: false) — the zcode/dsh sections are re-observed from their
 * runtimes on every call and a failed refresh fails closed with
 * MODEL_CATALOG_UNAVAILABLE, never authorized against stale data.
 */
export function createStepSelectionResolver(
  service: ModelCatalogService | null,
  agents: readonly CatalogAgent[] = ["codex", "antigravity", "zcode", "dsh"],
): StepSelectionResolver {
  return async (request) => {
    if (!service) {
      throw new StepSelectionError("MODEL_CATALOG_UNAVAILABLE", "No model catalog service is wired into this orchestrator");
    }
    if (!agents.includes(request.agent)) {
      throw new StepSelectionError("AGENT_UNKNOWN", `Unknown execution agent: ${request.agent}`);
    }
    let catalog: ModelCatalog;
    try {
      catalog = await service.get([request.agent], { forceRefresh: true, allowStale: false });
    } catch (error) {
      throw new StepSelectionError("MODEL_CATALOG_UNAVAILABLE",
        `Live model catalog for ${request.agent} is unavailable: ${String((error as Error)?.message ?? error)}`);
    }
    if (catalog.freshness !== "fresh") {
      throw new StepSelectionError("MODEL_CATALOG_UNAVAILABLE", `${request.agent} model catalog is not fresh`);
    }
    const result = resolveModelSelection(catalog, {
      agent: request.agent,
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.effort !== undefined ? { effort: request.effort } : {}),
      ...(request.provider_route !== undefined ? { provider_id: request.provider_route } : {}),
    });
    switch (result.status) {
      case "matched": {
        const selection = result.selection!;
        if (request.provider_route && selection.provider_id !== request.provider_route) {
          throw new StepSelectionError("PROVIDER_ROUTE_MISMATCH",
            `Model "${selection.model_id}" is not offered by provider route "${request.provider_route}"`,
            result.candidates);
        }
        if (request.effort !== undefined && selection.effort === null) {
          throw new StepSelectionError("UNSUPPORTED_EFFORT",
            `Model "${selection.model_id}" does not advertise reasoning efforts; the requested effort cannot be confirmed`);
        }
        const resolved: ResolvedStepSelection = {
          agent: selection.agent,
          provider_id: selection.provider_id,
          model_id: selection.model_id,
          effort: selection.effort,
          catalog_revision: result.catalog_revision,
          resolved_at: new Date().toISOString(),
        };
        return resolved;
      }
      case "ambiguous":
        throw new StepSelectionError("AMBIGUOUS_MODEL", result.reason, result.candidates);
      case "not_found":
        throw new StepSelectionError(
          result.reason.includes("effort") ? "UNSUPPORTED_EFFORT" : "MODEL_NOT_FOUND",
          result.reason,
          result.candidates,
        );
      case "unverified":
      case "unavailable":
        // Partial/stale evidence is never proof that a requested identity is
        // absent: fail closed as a retryable catalog unavailability.
        throw new StepSelectionError("MODEL_CATALOG_UNAVAILABLE",
          `${request.agent} catalog evidence is not authoritatively fresh: ${result.reason}`);
    }
  };
}
