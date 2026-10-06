import { VERSION } from "../version.js";

export const ERROR_CODES = ["AUTH_REQUIRED", "FORBIDDEN", "HOST_NOT_REGISTERED", "HOST_NOT_READY", "ROUTE_UNAVAILABLE", "WORKSPACE_REGISTRY_UNAVAILABLE", "WORKSPACE_NOT_REGISTERED", "WORKSPACE_NOT_READY", "PROVIDER_NOT_READY", "PROVIDER_SESSION_STALE", "SESSION_STALE", "VERSION_MISMATCH", "PERMISSION_REVIEW_TIMEOUT", "ADMISSION_FAILED", "TURN_START_FAILED", "TIMEOUT", "INTERNAL_ERROR", "EFFORT_POLICY_VIOLATION", "HIGHEST_EFFORT_UNVERIFIED", "WORKER_EFFORT_POLICY_INVALID", "FILE_NOT_FOUND", "INVALID_MODEL", "INVALID_ARGUMENT"] as const;
export type ControlPlaneErrorCode = typeof ERROR_CODES[number];
export interface SafeCause {
  error_code: ControlPlaneErrorCode;
  failure_layer: string;
  safe_message: string;
  retryable: boolean;
  component: string;
  observed_version: string;
  expected_version?: string;
}
const messages: Record<ControlPlaneErrorCode, string> = {
  AUTH_REQUIRED: "Authentication is required.", FORBIDDEN: "The caller is not authorized for this operation.",
  HOST_NOT_REGISTERED: "The host has no live registration.", HOST_NOT_READY: "The host is not ready.",
  ROUTE_UNAVAILABLE: "The route has not been reconciled.", WORKSPACE_REGISTRY_UNAVAILABLE: "The workspace registry cannot be read.",
  WORKSPACE_NOT_REGISTERED: "The workspace is not registered.", WORKSPACE_NOT_READY: "The registered workspace is unavailable.",
  PROVIDER_NOT_READY: "The provider is unavailable or not ready.", PROVIDER_SESSION_STALE: "The provider session belongs to an obsolete runtime.",
  SESSION_STALE: "The native session requires live reconciliation.", VERSION_MISMATCH: "The connected protocol is incompatible.",
  PERMISSION_REVIEW_TIMEOUT: "Permission review did not complete before its deadline.",
  ADMISSION_FAILED: "Task admission failed; no automatic redispatch is allowed.",
  TURN_START_FAILED: "Turn start is failed or unknown; reconcile before retrying.",
  TIMEOUT: "The operation exceeded its deadline.", INTERNAL_ERROR: "An internal component failed. Consult the correlated diagnostic code.",
  EFFORT_POLICY_VIOLATION: "This worker requires the highest effort advertised by its live target model.",
  HIGHEST_EFFORT_UNVERIFIED: "The target model's highest effort could not be verified; no inference was launched.",
  WORKER_EFFORT_POLICY_INVALID: "The protected operator effort policy is invalid; no inference was launched.",
  FILE_NOT_FOUND: "The requested workspace file does not exist.",
  INVALID_MODEL: "The requested model is not admitted by this execution lane.",
  INVALID_ARGUMENT: "The request contains an invalid argument.",
};
export class ControlPlaneError extends Error {
  constructor(readonly code: ControlPlaneErrorCode, readonly layer: string, readonly component: string, readonly observedVersion = VERSION, readonly expectedVersion?: string) {
    super(messages[code]); this.name = "ControlPlaneError";
  }
}

/** Projection is an allowlist: never expose exception text, stack, headers or bodies. */
export function safeCause(error: unknown, component = "a2c", layer = "mcp"): SafeCause {
  const e = error as { code?: unknown; upstreamCode?: unknown; message?: unknown; status?: unknown; failureLayer?: unknown; observedVersion?: unknown; expectedVersion?: unknown } | null;
  const raw = typeof e?.upstreamCode === "string" ? e.upstreamCode : typeof e?.code === "string" ? e.code : "";
  let code: ControlPlaneErrorCode = "INTERNAL_ERROR";
  if (ERROR_CODES.includes(raw as ControlPlaneErrorCode)) code = raw as ControlPlaneErrorCode;
  else if (/UNAUTHORIZED|AUTH_REQUIRED/.test(raw) || e?.status === 401) code = "AUTH_REQUIRED";
  else if (/FORBIDDEN|DENIED|NOT_AUTHORIZED|INSUFFICIENT_SCOPE|NOT_OWNED/.test(raw) || e?.status === 403) code = "FORBIDDEN";
  else if (/SERVICE_MISMATCH|VERSION/.test(raw)) code = "VERSION_MISMATCH";
  else if (/REGISTRY_INVALID|REGISTRY_UNAVAILABLE/.test(raw)) code = "WORKSPACE_REGISTRY_UNAVAILABLE";
  else if (/WORKSPACE_NOT_FOUND|WORKSPACE_ROOT_INVALID/.test(raw)) code = "WORKSPACE_NOT_READY";
  else if (/WORKSPACE.*UNCONFIGURED|WORKSPACE_NOT_REGISTERED/.test(raw)) code = "WORKSPACE_NOT_REGISTERED";
  else if (/REVIEW.*TIMEOUT|APPROVAL.*TIMEOUT/.test(raw)) code = "PERMISSION_REVIEW_TIMEOUT";
  else if (/TIMEOUT/.test(raw)) code = "TIMEOUT";
  else if (/SESSION.*STALE|SESSION_NOT_ACTIVE|SESSION_NOT_FOUND|BRIDGE_RESTARTED/.test(raw)) code = "SESSION_STALE";
  else if (/OUTCOME_UNKNOWN|TURN.*FAILED/.test(raw)) code = "TURN_START_FAILED";
  else if (/UNAVAILABLE|UNCONFIGURED|PROVIDER_UNSUPPORTED/.test(raw)) code = "PROVIDER_NOT_READY";
  else if (/TASK_|ADMISSION|ENTITLEMENT/.test(raw)) code = "ADMISSION_FAILED";
  // Classify transport-only errors without ever returning their raw message.
  else if (typeof e?.message === "string") {
    if (/\b401\b/.test(e.message)) code = "AUTH_REQUIRED";
    else if (/\b403\b/.test(e.message)) code = "FORBIDDEN";
    else if (/automatic permission approval review.*deadline|permission review.*tim(e|ed).*out/i.test(e.message)) code = "PERMISSION_REVIEW_TIMEOUT";
    else if (/timed?\s?out|deadline/i.test(e.message)) code = "TIMEOUT";
  }
  if (error instanceof ControlPlaneError) { layer = error.layer; component = error.component; }
  else if (/^ZCODE_SESSION/.test(raw)) { layer = "z2c_transport"; component = "z2c"; }
  else if (/^WORKSPACE/.test(raw)) { layer = "workspace_registry"; }
  if (typeof e?.failureLayer === "string" && ["authorization", "provider_binding", "native_session", "z2c_rpc", "workspace_registry"].includes(e.failureLayer)) layer = e.failureLayer;
  if (code === "AUTH_REQUIRED" || code === "FORBIDDEN") layer = "authorization";
  else if (code === "FILE_NOT_FOUND") layer = "workspace_read";
  else if (code === "INVALID_MODEL") layer = "task_admission";
  else if (code === "INVALID_ARGUMENT") layer = "request_validation";
  const observed = error instanceof ControlPlaneError ? error.observedVersion : typeof e?.observedVersion === "string" ? e.observedVersion : VERSION;
  const expected = typeof e?.expectedVersion === "string" ? e.expectedVersion : component === "z2c" ? "1" : VERSION;
  return { error_code: code, failure_layer: layer, safe_message: messages[code], retryable: ["HOST_NOT_READY", "ROUTE_UNAVAILABLE", "PROVIDER_NOT_READY", "TIMEOUT"].includes(code), component,
    observed_version: /^\d{1,4}(\.\d{1,4}){0,3}(-[a-zA-Z0-9]{1,16})?$/.test(observed) ? observed : "UNKNOWN",
    ...(code === "VERSION_MISMATCH" ? { expected_version: /^\d{1,4}(\.(\d{1,4}|x)){0,3}$/.test(expected) ? expected : "UNKNOWN" } : {}) };
}

export function errorToolResult(error: unknown, component?: string, layer?: string) {
  const cause = safeCause(error, component, layer);
  const legacy = (error as { code?: unknown })?.code;
  // Keep published legacy codes for existing clients; canonical classification
  // is additive. Never retain an arbitrary upstream string or message.
  const errorCode = typeof legacy === "string" && /^[A-Z][A-Z0-9_]{0,95}$/.test(legacy) ? legacy : cause.error_code;
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: errorCode, message: cause.safe_message, ...cause }) }] };
}
