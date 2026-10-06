import fs from "node:fs";
import path from "node:path";
import { getStateDir, writeSecureJson } from "./paths.js";

export const workerEffortPolicyFile = (stateDir?: string): string => path.join(getStateDir(stateDir), "worker-effort-policy.json");
export function highestWorkerEffortRequired(stateDir?: string): boolean {
  try {
    const p = JSON.parse(fs.readFileSync(workerEffortPolicyFile(stateDir), "utf8"));
    if (p?.schema !== 1 || p?.glmAndGemini !== "highest") throw new Error("WORKER_EFFORT_POLICY_INVALID");
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("WORKER_EFFORT_POLICY_INVALID");
  }
}
export function requireHighestWorkerEffort(stateDir?: string): void {
  if (highestWorkerEffortRequired(stateDir)) return;
  writeSecureJson(workerEffortPolicyFile(stateDir), { schema: 1, glmAndGemini: "highest", updatedAt: new Date().toISOString() }, { durable: true });
}
const RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
export function highestAdvertisedEffort(levels: readonly string[]): string {
  if (!levels.length || levels.some(level => !RANK.includes(level))) throw new Error("HIGHEST_EFFORT_UNVERIFIED");
  return levels.reduce((best, level) => RANK.indexOf(level) > RANK.indexOf(best) ? level : best);
}
export function assertHighestAntigravityModel(model: string, liveListing: string): void {
  const suffix = /-(low|medium|high|xhigh|max|ultra)$/;
  const family = model.replace(suffix, "");
  const offered = liveListing.split(/\r?\n/).map(line => line.split("\t")[0]?.trim())
    .filter((id): id is string => !!id && id.replace(suffix, "") === family);
  const highest = highestAdvertisedEffort(offered.map(id => suffix.exec(id)?.[1] ?? "unknown"));
  if (!offered.includes(model) || suffix.exec(model)?.[1] !== highest) throw new Error("EFFORT_POLICY_VIOLATION");
}
/** Existing callers keep the same live-family validation semantics. */
export const assertHighestGeminiModel = assertHighestAntigravityModel;
