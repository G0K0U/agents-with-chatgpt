/** Local deployment authority only; never derive this from task text or MCP input. */
export function fullAccessDevelopmentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return sharedEnv("FULL_ACCESS_DEVELOPMENT", env) === "true";
}

import { sharedEnv } from "./env.js";