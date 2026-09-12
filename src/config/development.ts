/** Local deployment authority only; never derive this from task text or MCP input. */
export function fullAccessDevelopmentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.C2C_FULL_ACCESS_DEVELOPMENT === "true";
}
