import {
  ADMISSIBLE_PROVIDER_ROUTES,
  REQUIRED_BINDING_SOURCES,
  RETIRED_PROVIDER_IDS,
  type SessionStateAttestation,
} from "../providers/types.js";

/**
 * Shared governed-execution policy for BOTH admission paths (task engine and
 * the semantic SessionService). Single capability truth: the OBSERVED native
 * state of the EXACT session — requested or configured values are never proof.
 *
 * 2026-09-28 policy: governed GLM work admits EVERY model × reasoning level
 * the runtime itself advertises for that exact session
 * (settings.model.available[].reasoning.levels), on any admissible
 * non-retired provider route. No single-model constant (Flash-only and
 * GLM-5.3-only are both wrong); no effort restrictions beyond the target
 * model's own advertisement.
 *
 * 2026-09-29 policy (entitlement attestation): a route that exists ONLY for
 * the Start plan becomes admissible when the EXACT session carries a
 * registry-backed entitlement readback observing start-plan. The proof is the
 * runtime's own access-mode fact (settings.entitlement, source
 * "provider-registry") — never the provider id string, which is why the
 * retired-route revocation is lifted only for attested sessions.
 *
 *  - provider identity is OBSERVED and recorded; admission requires an
 *    admissible non-retired ROUTE (never a hardcoded model);
 *  - the observed model must be advertised by the runtime in the SAME
 *    authoritative snapshot (availability evidence; fail closed when absent
 *    on surfaces that provide it);
 *  - binding evidence must come from an authoritative exact-session read;
 *  - readonly lanes additionally require OBSERVED plan mode (v4 planEnabled).
 */
export interface GovernedBindingLike {
  provider_id: string;
  model_id: string;
  source: string;
  planEnabled?: boolean | null;
  /** Availability evidence from the same authoritative snapshot (optional). */
  availableModels?: SessionStateAttestation["availableModels"];
  /**
   * Registry-backed entitlement readback for the exact session. `observed` is
   * the semantic access mode ("start-plan" | "individual-coding-plan"); any
   * source other than "provider-registry" is not evidence.
   */
  entitlement?: { observed: string | null; source: string } | null;
}

export class AttestationError extends Error {
  constructor(message: string, public readonly code = "BINDING_UNVERIFIED") {
    super(message);
    this.name = "AttestationError";
  }
}

/** True when the observed identity is admissible: right route, not retired, advertised. */
export function isAdmissibleObservedBinding(binding?: GovernedBindingLike | null): boolean {
  if (!binding) return false;
  if (!REQUIRED_BINDING_SOURCES.has(binding.source)) return false;
  // Entitlement-attested Start usage: the runtime itself proved (registry
  // readback) that this exact session runs on the start-plan access mode.
  const attestedStart =
    binding.entitlement?.source === "provider-registry" && binding.entitlement.observed === "start-plan";
  if (RETIRED_PROVIDER_IDS.has(binding.provider_id) && !attestedStart) return false;
  if (!attestedStart && binding.provider_id !== null && !ADMISSIBLE_PROVIDER_ROUTES.has(binding.provider_id)) return false;
  if (binding.provider_id === null || binding.model_id === null) return false;
  // The desktop-legacy lane has no availability surface; on that lane the
  // admissible coding-plan ROUTE plus the authoritative read is the evidence.
  // (Explicit opt-in legacy lane; the official lane always carries catalog
  // evidence and is held to it by assertGovernedAttestation below.)
  if (binding.source === "desktop-session-read") return true;
  if (binding.availableModels === undefined || binding.availableModels === null) return false;
  return binding.availableModels.some(
    (m) => m.modelId === binding.model_id && (m.providerId === null || m.providerId === binding.provider_id),
  );
}

export function assertGovernedAttestation(
  attestation: SessionStateAttestation | null,
  opts: { readonly: boolean },
): void {
  if (!attestation) throw new AttestationError("execution binding is unobserved");
  if (attestation.sessionId && attestation.workspaceKey === null && attestation.workspacePath === null) {
    throw new AttestationError("session workspace association is unobserved");
  }
  if (!isAdmissibleObservedBinding({
    provider_id: attestation.providerId ?? "",
    model_id: attestation.modelId ?? "",
    source: attestation.bindingSource,
    availableModels: attestation.availableModels,
  })) {
    const advertised = (attestation.availableModels ?? []).map((m) => m.modelId).slice(0, 8).join(", ") || "none observed";
    throw new AttestationError(
      `unverified execution binding (observed ${attestation.providerId ?? "?"}/${attestation.modelId ?? "?"}; ` +
        `requires an authoritative session read on an admissible route advertising the model; ` +
        `advertised by this session: ${advertised})`,
    );
  }
  if (opts.readonly && attestation.planEnabled !== true) {
    throw new AttestationError(
      `readonly lane lacks authoritative plan evidence (planEnabled: ${String(attestation.planEnabled)})`,
    );
  }
}
