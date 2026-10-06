/** Billing entitlement is independent of provider route, model and effort. */
export type EntitlementPlan = "DEFAULT" | "START" | "INDIVIDUAL";

/**
 * Capability advertised by the Z2C control plane for its connected runtime
 * (provider_status `entitlement_capability`, ultimately the ZCode runtime's
 * own `runtime/capabilities.entitlementSelection`). Only a runtime that can
 * SELECT and ATTEST semantic entitlements unlocks non-DEFAULT plans.
 */
export interface EntitlementSelectionSupport {
  entitlementSelection: boolean;
}

export function entitlementPlan(value: unknown): EntitlementPlan {
  if (value === undefined) return "DEFAULT";
  if (value === "DEFAULT" || value === "START" || value === "INDIVIDUAL") return value;
  throw Object.assign(new Error("entitlement_plan must be DEFAULT, START or INDIVIDUAL"), { code: "INVALID_ENTITLEMENT_PLAN" });
}

/**
 * Fail-closed gate, capability-aware. DEFAULT always passes (historical
 * behavior, unchanged fingerprints). START and INDIVIDUAL pass ONLY when the
 * caller supplies a runtime capability that explicitly advertises entitlement
 * selection. No capability = old runtime = ENTITLEMENT_UNAVAILABLE (the
 * pre-capability behavior is preserved verbatim for that case).
 * Provider/model identity is NEVER billing evidence.
 */
export function requireSupportedEntitlement(
  value: unknown,
  support?: EntitlementSelectionSupport | null,
): EntitlementPlan {
  const plan = entitlementPlan(value);
  if (plan !== "DEFAULT" && support?.entitlementSelection !== true) {
    throw Object.assign(
      new Error(
        "Requested entitlement cannot be selected and attested by the connected ZCode runtime; no task was dispatched",
      ),
      { code: "ENTITLEMENT_UNAVAILABLE" },
    );
  }
  return plan;
}

/**
 * Exact-session entitlement evidence released by Z2C: requested plan,
 * runtime-observed plan, the semantic access mode behind it, and the evidence
 * source. Only `source: "provider-registry"` is authoritative; observed null
 * or any other source means the entitlement is NOT proven for that session.
 * No credential material ever appears in this shape.
 */
export interface EntitlementAttestation {
  requested: EntitlementPlan | null;
  observed: EntitlementPlan | null;
  access_mode: string | null;
  source: string;
}

/** Legacy helper: readback with no runtime evidence. */
export function unobservedEntitlement(value?: unknown): EntitlementAttestation {
  return { requested: entitlementPlan(value), observed: null, access_mode: null, source: "unavailable" };
}

/** True only when the readback itself proves the plan for the exact session. */
export function isAttestedEntitlement(
  attestation: EntitlementAttestation | null | undefined,
  plan: EntitlementPlan,
): boolean {
  const accessMode = plan === "START" ? "start-plan" : plan === "INDIVIDUAL" ? "individual-coding-plan" : null;
  return (
    !!attestation &&
    attestation.source === "provider-registry" &&
    attestation.observed === plan &&
    attestation.access_mode === accessMode
  );
}

/** Preserve historical DEFAULT fingerprints, including durable replay keys. */
export function entitlementFingerprintFields(value: unknown): { entitlement_plan?: EntitlementPlan } {
  const plan = entitlementPlan(value);
  return plan === "DEFAULT" ? {} : { entitlement_plan: plan };
}
