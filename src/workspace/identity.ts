import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

function normalizeForIdentity(value: string): string {
  const resolved = path.resolve(value);
  return CASE_INSENSITIVE ? resolved.toLowerCase() : resolved;
}

/** Return the stable workspace id for an already-canonical directory path. */
export function stableWorkspaceId(canonicalPath: string): string {
  return createHash("sha256").update(normalizeForIdentity(canonicalPath)).digest("hex").slice(0, 12);
}

/** Resolve and canonicalize a workspace root, including Windows reparse points. */
export function canonicalizeWorkspaceRoot(input: string): string {
  if (typeof input !== "string" || input.trim() === "" || input.includes("\0")) {
    throw new Error("Workspace root must be a non-empty path");
  }
  const resolved = path.resolve(input);
  const canonical = fs.realpathSync.native(resolved);
  if (!fs.statSync(canonical).isDirectory()) throw new Error("Workspace root must be a directory");
  return canonical;
}

