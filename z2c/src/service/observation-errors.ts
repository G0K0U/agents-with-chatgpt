/**
 * Shared classifier for upstream ZCode runtime observation errors.
 *
 * Lives in its own module so both the HTTP/MCP server and the transport-neutral
 * SessionService can classify failures without an import cycle. The classes
 * are stable wire contract: "session-not-active"/"session-not-found" identify
 * a specific session the runtime does not consider live; every other class is
 * a LANE-level failure (transport, timeout, permission, protocol) where no
 * per-session claim can be made.
 */
export function classifyObservationError(message: string): string {
  const lower = message.toLowerCase();
  // Numeric protocol codes first: "-32601 method not found" is a protocol
  // mismatch, not a missing session.
  if (message.includes("-32004") || lower.includes("not active")) return "session-not-active";
  if (message.includes("-32601") || message.includes("-32602") || lower.includes("protocol error")) return "protocol";
  if (lower.includes("not associated") || lower.includes("not found")) return "session-not-found";
  if (lower.includes("timed out") || lower.includes("timeout")) return "timeout";
  if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("forbidden") || lower.includes("permission")) return "permission";
  if (lower.includes("econnrefused") || lower.includes("econnreset") || lower.includes("epipe") || lower.includes("transport")) return "transport";
  return "error";
}

/**
 * Lane-level classes: the read failed for a reason that is provably NOT about
 * the session itself (lane down, timeout, protocol mismatch, auth). The
 * catch-all "error" class is deliberately NOT lane-level: an unclassifiable
 * provider failure keeps the historical session-level denial (fail closed to
 * the established behavior — a workspace mismatch throws an unclassified
 * message and must stay a session-level answer).
 */
export function isLaneLevelObservationError(message: string): boolean {
  return ["protocol", "timeout", "permission", "transport"].includes(classifyObservationError(message));
}
