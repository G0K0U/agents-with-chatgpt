import { entitlementFingerprintFields } from "../../providers/entitlement.js";
import { createHash } from "node:crypto";
import type { SubmitTaskInput } from "./engine.js";

export const IDEMPOTENCY_PROTOCOL = "workspace-task-v1";
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?![\s\S])/;

/** Fixed field order and explicit defaults are part of the wire contract. */
export function requestFingerprint(input: SubmitTaskInput): string {
  return createHash("sha256").update(JSON.stringify({
    workspace_id: input.workspace_id, instruction: input.instruction,
    write_scope: input.write_scope ?? "workspace", network: input.network ?? "default",
    mode: input.mode ?? "build", resume_session_id: input.resume_session_id ?? null,
    model_id: input.model_id ?? null, thought_level: input.thought_level ?? null,
    ...entitlementFingerprintFields(input.entitlement_plan),
  })).digest("hex");
}
