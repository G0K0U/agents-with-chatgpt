/** No exception text or response body is released across a transport boundary. */
export function serviceCause(error: unknown) {
  const e = error as { code?: string; message?: string; error?: { code?: number; message?: string } };
  const raw = e?.code ?? "";
  const message = e?.message ?? "";
  const known = ["AUTH_REQUIRED", "FORBIDDEN", "HOST_NOT_REGISTERED", "HOST_NOT_READY", "ROUTE_UNAVAILABLE", "WORKSPACE_REGISTRY_UNAVAILABLE", "WORKSPACE_NOT_REGISTERED", "WORKSPACE_NOT_READY", "PROVIDER_NOT_READY", "PROVIDER_SESSION_STALE", "SESSION_STALE", "VERSION_MISMATCH", "PERMISSION_REVIEW_TIMEOUT", "ADMISSION_FAILED", "TURN_START_FAILED", "TIMEOUT", "INTERNAL_ERROR"];
  const effortCodes = ["EFFORT_POLICY_VIOLATION", "HIGHEST_EFFORT_UNVERIFIED", "WORKER_EFFORT_POLICY_INVALID"];
  const code = known.includes(raw) || effortCodes.includes(raw) ? raw : /REVIEW.*TIMEOUT|APPROVAL.*TIMEOUT/.test(raw) || /automatic permission approval review.*deadline|permission review.*tim(e|ed).*out/i.test(message) ? "PERMISSION_REVIEW_TIMEOUT"
    : /UNAUTHORIZED/.test(raw) ? "AUTH_REQUIRED"
    : /DENIED|FORBIDDEN|NOT_AUTHORIZED|NOT_OWNED|READONLY/.test(raw) ? "FORBIDDEN"
    : /SESSION_NOT_ACTIVE|SESSION_NOT_FOUND/.test(raw) || e?.error?.code === -32004 ? "SESSION_STALE"
    : /BINDING|ENTITLEMENT/.test(raw) || /provider switch|entitlement.*observed|execution binding/i.test(message) ? "PROVIDER_SESSION_STALE"
    : /version|incompatible|method not found/i.test(message) ? "VERSION_MISMATCH"
    : /timeout|timed out|deadline/i.test(message) ? "TIMEOUT"
    : "INTERNAL_ERROR";
  const layer = code === "FORBIDDEN" || code === "AUTH_REQUIRED" ? "authorization"
    : code === "PROVIDER_SESSION_STALE" || effortCodes.includes(code) ? "provider_binding"
    : code === "SESSION_STALE" ? "native_session" : "z2c_rpc";
  const nativeSessionState = e?.error?.code === -32004
    ? /Session not found:/i.test(e.error.message ?? message) ? "NOT_PERSISTED" : "INACTIVE" : null;
  return { error_code: code, failure_layer: layer, safe_message: `${code}: ${layer} failed; no automatic mutation replay.`, retryable: code === "TIMEOUT", component: "z2c", observed_version: "1", native_rpc_code: Number.isInteger(e?.error?.code) ? e.error!.code : null, native_session_state: nativeSessionState };
}
