import fs from "node:fs";
import path from "node:path";
import { getStateDir, writeSecureJson } from "./paths.js";

export interface DispatchPolicyStatus {
  effectivePaused: boolean;
  stateFile: { state: "MISSING" | "VALID" | "INVALID"; productTaskDispatchPaused: boolean | null; updatedAt: string | null };
  envOverride: { active: boolean; source: "PROCESS_ENVIRONMENT" | null };
}

/** Operator policy is independent of workspace authorization and queue state. */
export function dispatchPolicyStatus(stateDir?: string): DispatchPolicyStatus {
  const active = /^(true|1)$/i.test(process.env.PRODUCT_TASK_DISPATCH_PAUSED ?? "");
  let stateFile: DispatchPolicyStatus["stateFile"];
  try {
    const value = JSON.parse(fs.readFileSync(path.join(getStateDir(stateDir), "dispatch-policy.json"), "utf8"));
    if (!value || value.schema !== 1 || typeof value.productTaskDispatchPaused !== "boolean") throw new Error("Invalid policy");
    stateFile = { state: "VALID", productTaskDispatchPaused: value.productTaskDispatchPaused, updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null };
  } catch (error) {
    stateFile = { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "MISSING" : "INVALID", productTaskDispatchPaused: null, updatedAt: null };
  }
  return { effectivePaused: active || stateFile.state === "INVALID" || stateFile.productTaskDispatchPaused === true,
    stateFile, envOverride: { active, source: active ? "PROCESS_ENVIRONMENT" : null } };
}

export function productDispatchPaused(stateDir?: string): boolean {
  return dispatchPolicyStatus(stateDir).effectivePaused;
}

function setProductDispatchPaused(paused: boolean, stateDir?: string): void {
  const current = dispatchPolicyStatus(stateDir).stateFile;
  if (current.state === "VALID" && current.productTaskDispatchPaused === paused) return;
  writeSecureJson(path.join(getStateDir(stateDir), "dispatch-policy.json"), {
    schema: 1, productTaskDispatchPaused: paused, updatedAt: new Date().toISOString(),
  }, { durable: true });
}

/** Atomic, durable and idempotent. An explicit environment pause still wins. */
export function pauseProductDispatch(stateDir?: string): void { setProductDispatchPaused(true, stateDir); }
export function resumeProductDispatch(stateDir?: string): void { setProductDispatchPaused(false, stateDir); }
