export const VERSION = "0.4.0";
/**
 * A2C (Agents-to-ChatGPT) is the shared platform name. C2C (Codex-to-ChatGPT)
 * refers ONLY to the Codex provider lane. The bridge service name moved to
 * "a2c-bridge"; the historical "c2c-bridge" remains accepted during rollout
 * (legacy compatibility identifier — see docs/architecture.md).
 */
export const SERVICE_NAME = "a2c-bridge";
export const LEGACY_SERVICE_NAME = "c2c-bridge";
export const PRODUCT_NAME = "Agents with ChatGPT";

/** Accept both the canonical and the legacy bridge service name. */
export function isBridgeServiceName(value: unknown): boolean {
  return value === SERVICE_NAME || value === LEGACY_SERVICE_NAME;
}
