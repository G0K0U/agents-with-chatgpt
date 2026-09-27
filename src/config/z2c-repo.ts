import fs from "node:fs";
import path from "node:path";

/**
 * Resolve the Z2C companion repository root (the governed GLM lane's local
 * control plane). Distribution layouts, in preference order:
 *
 *   1. <repoRoot>/z2c                 — in-repo distribution (public release
 *                                       ships the Z2C source here; the
 *                                       installer builds it)
 *   2. <parent>/zcode-with-chatgpt    — legacy developer sibling layout
 *   3. Z2C_REPO_ROOT env override is honored by callers that accept one.
 *
 * A candidate counts only when its desktop-agent proxy script exists — the
 * one Z2C file the C2C runtime depends on by path.
 */
export function resolveZ2cRepoRoot(repoRoot: string): string {
  const candidates = [
    path.resolve(repoRoot, "z2c"),
    path.resolve(repoRoot, "..", "zcode-with-chatgpt"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "scripts", "desktop-agent-proxy.mjs"))) {
      return candidate;
    }
  }
  // Legacy default: keeps developer siblings working even when the proxy
  // script has not been built/checked out yet.
  return candidates[1];
}
