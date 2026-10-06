/** Billing entitlement is independent of provider route, model and effort. */
export type EntitlementPlan = "DEFAULT" | "START" | "INDIVIDUAL";

/**
 * Capability advertised by the execution runtime (ZCode app-server) through
 * `runtime/capabilities.entitlementSelection` and relayed by the official
 * provider. Only a runtime that can SELECT and ATTEST semantic entitlements
 * may accept non-DEFAULT plans; nothing else unlocks them.
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
 * Fail-closed gate. DEFAULT always passes (historical behavior). START and
 * INDIVIDUAL pass ONLY when the connected runtime advertised the entitlement
 * selection capability. `support === undefined` keeps the pre-capability
 * behavior for callers that have not been migrated (and for old runtimes).
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

/** EntitlementPlan → semantic zhipu account access mode (protocol value). */
export function entitlementAccessMode(plan: EntitlementPlan): "start-plan" | "individual-coding-plan" | null {
  switch (plan) {
    case "START":
      return "start-plan";
    case "INDIVIDUAL":
      return "individual-coding-plan";
    default:
      return null;
  }
}

/** Semantic zhipu account access mode → EntitlementPlan; unknown modes never map. */
export function entitlementFromAccessMode(mode: string | null | undefined): EntitlementPlan | null {
  switch (mode) {
    case "start-plan":
      return "START";
    case "individual-coding-plan":
      return "INDIVIDUAL";
    default:
      return null;
  }
}

/**
 * Exact-session entitlement evidence, observed from the runtime's own
 * registry-backed readback (session/read settings.entitlement). No
 * credential material ever appears here. `observed === null` /
 * `source !== "provider-registry"` means the entitlement is NOT proven.
 */
export interface EntitlementAttestation {
  requested: EntitlementPlan | null;
  observed: EntitlementPlan | null;
  /** Raw semantic access mode behind `observed` (e.g. "start-plan"); null = unobserved. */
  access_mode: string | null;
  source: string;
}

/** The readback proves the entitlement only via the runtime's own registry fact. */
export function isAttestedEntitlement(
  attestation: EntitlementAttestation | null | undefined,
  plan: EntitlementPlan,
): boolean {
  return (
    !!attestation &&
    attestation.source === "provider-registry" &&
    attestation.observed === plan &&
    attestation.access_mode === entitlementAccessMode(plan)
  );
}

/** Legacy shape helper: readback with no runtime evidence. */
export function unobservedEntitlement(value?: unknown): EntitlementAttestation {
  return {
    // No explicit request evidence → requested stays unproven (null). Only a
    // concrete plan value attests a request; an absent readback must never
    // fabricate "DEFAULT" (or any plan) as a request fact.
    requested: value === undefined ? null : entitlementPlan(value),
    observed: null,
    access_mode: null,
    source: "unavailable",
  };
}

/** Preserve historical DEFAULT fingerprints, including durable replay keys. */
export function entitlementFingerprintFields(value: unknown): { entitlement_plan?: EntitlementPlan } {
  const plan = entitlementPlan(value);
  return plan === "DEFAULT" ? {} : { entitlement_plan: plan };
}
