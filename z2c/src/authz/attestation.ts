import {
  REQUIRED_BINDING_SOURCES,
  REQUIRED_START_PLAN_MODEL_ID,
  type SessionStateAttestation,
} from "../providers/types.js";

/**
 * Shared governed-execution policy for BOTH admission paths (task engine and
 * the semantic SessionService): observed native state only — requested or
 * configured values are never proof.
 *
 *  - the model identity is the governed constraint (Flash-only policy);
 *  - provider identity is OBSERVED and recorded, never gated on a constant
 *    (ZCode resolves provider/entitlement natively);
 *  - binding evidence must come from an authoritative exact-session read;
 *  - readonly lanes additionally require OBSERVED plan mode (v4 planEnabled).
 */
export interface GovernedBindingLike {
  provider_id: string;
  model_id: string;
  source: string;
  planEnabled?: boolean | null;
}

export class AttestationError extends Error {
  constructor(message: string, public readonly code = "BINDING_UNVERIFIED") {
    super(message);
    this.name = "AttestationError";
  }
}

export function assertGovernedAttestation(
  attestation: SessionStateAttestation | null,
  opts: { readonly: boolean },
): void {
  if (!attestation) throw new AttestationError("execution binding is unobserved");
  if (attestation.sessionId && attestation.workspaceKey === null && attestation.workspacePath === null) {
    throw new AttestationError("session workspace association is unobserved");
  }
  if (attestation.modelId !== REQUIRED_START_PLAN_MODEL_ID) {
    throw new AttestationError(
      `unverified execution binding (observed ${attestation.providerId ?? "?"}/${attestation.modelId ?? "?"}; ` +
        `requires authoritative session read bound to ${REQUIRED_START_PLAN_MODEL_ID})`,
    );
  }
  if (!REQUIRED_BINDING_SOURCES.has(attestation.bindingSource)) {
    throw new AttestationError(`binding evidence source is not authoritative: ${attestation.bindingSource}`);
  }
  if (opts.readonly && attestation.planEnabled !== true) {
    throw new AttestationError(
      `readonly lane lacks authoritative plan evidence (planEnabled: ${String(attestation.planEnabled)})`,
    );
  }
}
