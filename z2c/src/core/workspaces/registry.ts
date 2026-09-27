import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

export interface WorkspaceEntry {
  workspaceId: string;
  canonicalPath: string;
  displayName: string;
  allowed: boolean;
}

export class WorkspaceRegistry {
  constructor(private workspaces: Map<string, WorkspaceEntry>) {}

  static fromList(entries: WorkspaceEntry[]): WorkspaceRegistry {
    return new WorkspaceRegistry(new Map(entries.map((e) => [e.workspaceId, e])));
  }

  toList(): WorkspaceEntry[] {
    return [...this.workspaces.values()];
  }

  register(workspaceId: string, rawPath: string, displayName?: string): WorkspaceEntry {
    const canonicalPath = canonicalizeWorkspacePath(rawPath);
    const entry: WorkspaceEntry = {
      workspaceId,
      canonicalPath,
      displayName: displayName ?? workspaceId,
      allowed: true,
    };
    this.workspaces.set(workspaceId, entry);
    return entry;
  }

  setAllowed(workspaceId: string, allowed: boolean): void {
    const e = this.get(workspaceId);
    e.allowed = allowed;
  }

  get(workspaceId: string): WorkspaceEntry {
    const entry = this.workspaces.get(workspaceId);
    if (!entry) throw new WorkspaceError(`unknown workspace: ${workspaceId}`, "UNKNOWN_WORKSPACE");
    return entry;
  }

  /** Resolve a workspaceId to an allowed, existing, canonical workspace. Fail closed. */
  resolveAuthorized(workspaceId: string): WorkspaceEntry {
    const entry = this.get(workspaceId);
    if (!entry.allowed) throw new WorkspaceError(`workspace not authorized: ${workspaceId}`, "UNAUTHORIZED_WORKSPACE");
    if (!existsSync(entry.canonicalPath)) {
      throw new WorkspaceError(`workspace path missing: ${workspaceId}`, "WORKSPACE_MISSING");
    }
    return entry;
  }

  /** Verify a claimed path really maps to the workspace (anti-traversal / mismatch). */
  assertPathMatches(workspaceId: string, rawPath: string): void {
    const entry = this.get(workspaceId);
    const canonical = canonicalizeWorkspacePath(rawPath);
    if (canonical !== entry.canonicalPath) {
      throw new WorkspaceError(
        `workspace path mismatch for ${workspaceId}`,
        "WORKSPACE_MISMATCH",
      );
    }
  }
}

export function canonicalizeWorkspacePath(rawPath: string): string {
  if (!rawPath || typeof rawPath !== "string") {
    throw new WorkspaceError("workspace path required", "INVALID_PATH");
  }
  if (/\0/u.test(rawPath) || /[<>|]/u.test(rawPath)) {
    throw new WorkspaceError("invalid workspace path", "INVALID_PATH");
  }
  if (!isAbsolute(rawPath)) throw new WorkspaceError("workspace path must be absolute", "INVALID_PATH");
  const resolved = resolve(rawPath);
  if (/[<>|]/u.test(resolved)) throw new WorkspaceError("invalid workspace path", "INVALID_PATH");
  try {
    return realpathSync(resolved).toLowerCase();
  } catch {
    // Path may not exist yet (test workspace creation is caller's job); fall back to normalized form.
    return resolved.toLowerCase().replace(/[\\/]+$/, "");
  }
}

export function isSubPath(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.toLowerCase() + sep.toLowerCase());
}

export class WorkspaceError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}
