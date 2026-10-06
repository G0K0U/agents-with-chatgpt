import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

/** One pinned browser tool server, never the user's MCP registry or profile. */
export function antigravityBrowserTools(network: boolean, outputDir: string): Record<string, unknown> {
  if (!network) return {};
  const require = createRequire(import.meta.url);
  const cli = path.join(path.dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");
  if (!fs.existsSync(cli)) throw new Error("BROWSER_TOOLS_UNAVAILABLE: pinned browser tool entry is missing");
  const args = [cli, "--headless", "--isolated", "--no-webmcp", "--block-service-workers", "--file-paths", "absolute", "--save-session",
    "--output-dir", outputDir, "--allowed-origins", "http://localhost:*;http://127.0.0.1:*"];
  // Installed Edge is used with an isolated profile; no user tabs or cookies.
  if (process.platform === "win32") args.push("--browser", "msedge");
  return { browser: { command: process.execPath, args } };
}
