/** Local deployment setting. It is deliberately not part of any MCP input. */
export type ExecutionOrchestrator = "legacy" | "omnigent";

export function executionOrchestrator(value: unknown = process.env.C2C_ORCHESTRATOR): ExecutionOrchestrator {
  if (value === undefined || value === "legacy") return "legacy";
  if (value === "omnigent") return "omnigent";
  // Do not echo configuration: it may contain a mistakenly pasted credential.
  throw new Error("C2C_ORCHESTRATOR must be legacy or omnigent");
}
