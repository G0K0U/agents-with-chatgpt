import { readFileSync } from "node:fs";
function policyError(code: string, detail = code): Error { return Object.assign(new Error(detail), { code, failureLayer: "provider_binding" }); }

/** A2C operator is the sole policy writer. Unknown or malformed policy fails closed. */
export function requireHighestEffort(file?: string): boolean {
  if (!file) return false;
  let p;
  try { p = JSON.parse(readFileSync(file, "utf8")); } catch { throw policyError("WORKER_EFFORT_POLICY_INVALID"); }
  if (p?.schema !== 1 || p?.glmAndGemini !== "highest") throw policyError("WORKER_EFFORT_POLICY_INVALID");
  return true;
}
export function highestEffort(levels: readonly string[], explicit?: string | null): string {
  const rank = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  if (!levels.length || levels.some(level => !rank.includes(level))) throw policyError("HIGHEST_EFFORT_UNVERIFIED");
  const highest = levels.reduce((best, level) => rank.indexOf(level) > rank.indexOf(best) ? level : best);
  if (explicit && explicit !== highest) throw policyError("EFFORT_POLICY_VIOLATION", `EFFORT_POLICY_VIOLATION: requested ${explicit}; highest advertised effort is ${highest}`);
  return highest;
}
