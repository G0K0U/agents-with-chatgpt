/**
 * Evidence-based failure classification for terminal task records.
 *
 * Classification runs ONLY on the verbatim runtime/engine error message that
 * is already persisted as the task's exitStatus — it never invents a cause
 * from silence (an unclassified failure stays "error", never "quota" or
 * "auth"). Used for machine-readable audit events so monitoring can
 * distinguish timeout vs quota vs auth vs generic failures without
 * re-parsing free text.
 */
export type TaskFailureClass =
  | "timeout"
  | "quota_exhausted"
  | "auth"
  | "connection"
  | "model_error"
  | "error";

const PATTERNS: ReadonlyArray<readonly [TaskFailureClass, RegExp]> = [
  // Engine phrase for the bounded 15-min turn budget, and the runtime's own
  // cancellation code recorded after a stop request (model_request_cancelled).
  ["timeout", /turn timeout after \d+ms|model_request_cancelled/i],
  // Explicit quota/usage evidence only. A bare "429" is NOT sufficient:
  // the code alone cannot distinguish billing exhaustion from burst limits.
  ["quota_exhausted", /quota|额度|usage.?limit|insufficient.*(balance|credit)/i],
  // Credential/authentication evidence from the runtime.
  ["auth", /unauthorized|authentication|invalid.*(token|api.?key)|api.?key.*(invalid|expired)/i],
  // Transport-level loss.
  ["connection", /connection (lost|closed|refused|reset)|econn(re)set|socket hang up/i],
  // Any other surfaced model error keeps a distinct class from engine bugs.
  ["model_error", /model error during turn/i],
];

export function classifyTaskFailure(message: string | null | undefined): TaskFailureClass {
  const raw = message ?? "";
  for (const [cls, pattern] of PATTERNS) {
    if (pattern.test(raw)) return cls;
  }
  return "error";
}
