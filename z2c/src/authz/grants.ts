import { join } from "node:path";
import { loadJson, saveJsonAtomic } from "../util/fsjson.js";
import { canonicalizeWorkspacePath, WorkspaceError } from "../core/workspaces/registry.js";

/**
 * Workspace authorization: a first-class allowlist of canonical workspace
 * paths with explicit read/write permissions.
 *
 * Invariants:
 *  - ChatGPT / paired clients can NEVER self-authorize a workspace; grants
 *    are local-user actions only (CLI / management API with the service secret).
 *  - Paths are canonicalized (realpath, case-folded) before storage and
 *    comparison — traversal ("..", relative, non-canonical spellings) is
 *    rejected because it can never match a stored canonical path.
 *  - A read-only grant cannot be used for write sessions.
 *  - Workspace authorization is independent of provider/model selection.
 */

export type WorkspaceAccess = "readonly" | "write";

export interface WorkspaceGrant {
  workspaceId: string;
  canonicalPath: string;
  displayName: string;
  permissions: { read: boolean; write: boolean };
  grantedAt: number;
  grantedBy: "local-user";
  revokedAt?: number;
}

interface GrantsState {
  version: 1;
  grants: WorkspaceGrant[];
}

export class GrantError extends Error {
  constructor(message: string, public readonly code: string, public readonly httpStatus = 403) {
    super(message);
    this.name = "GrantError";
  }
}

export interface WorkspaceGrants {
  /** Local-user action: authorize (or re-authorize / upgrade) a workspace. */
  authorize(rawPath: string, opts?: { displayName?: string; write?: boolean; workspaceId?: string }): WorkspaceGrant;
  revoke(workspaceId: string): WorkspaceGrant;
  list(): WorkspaceGrant[];
  getActive(workspaceId: string): WorkspaceGrant | undefined;
  /**
   * Authorization decision for a semantic call. `requestedPath` is optional;
   * when present it must canonicalize to the granted path (anti-traversal).
   */
  authorizeAccess(workspaceId: string, access: WorkspaceAccess, requestedPath?: string): WorkspaceGrant;
}

export function loadWorkspaceGrants(stateDir: string): WorkspaceGrants {
  const path = join(stateDir, "grants.json");
  const existing = loadJson<GrantsState>(path);
  const state: GrantsState = existing?.version === 1 && Array.isArray(existing.grants) ? existing : { version: 1, grants: [] };
  const save = () => saveJsonAtomic(path, state);

  const api: WorkspaceGrants = {
    authorize(rawPath, opts) {
      const canonicalPath = canonicalizeWorkspacePath(rawPath);
      const existingGrant = state.grants.find((g) => g.revokedAt === undefined && g.canonicalPath === canonicalPath);
      if (existingGrant) {
        existingGrant.permissions.write = opts?.write ?? existingGrant.permissions.write;
        existingGrant.displayName = opts?.displayName ?? existingGrant.displayName;
        save();
        return existingGrant;
      }
      const idSeed = canonicalPath.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "ws";
      let workspaceId = opts?.workspaceId ?? `ws_${idSeed}`;
      if (state.grants.some((g) => g.workspaceId === workspaceId && g.revokedAt === undefined)) {
        workspaceId = `${workspaceId}_${Math.random().toString(36).slice(2, 6)}`;
      }
      const grant: WorkspaceGrant = {
        workspaceId,
        canonicalPath,
        displayName: opts?.displayName ?? workspaceId,
        permissions: { read: true, write: opts?.write ?? true },
        grantedAt: Date.now(),
        grantedBy: "local-user",
      };
      state.grants.push(grant);
      save();
      return grant;
    },
    revoke(workspaceId) {
      const grant = api.getActive(workspaceId);
      if (!grant) throw new GrantError(`no active grant for workspace: ${workspaceId}`, "GRANT_NOT_FOUND", 404);
      grant.revokedAt = Date.now();
      save();
      return grant;
    },
    list() {
      return state.grants.filter((g) => g.revokedAt === undefined);
    },
    getActive(workspaceId) {
      return state.grants.find((g) => g.revokedAt === undefined && g.workspaceId === workspaceId);
    },
    authorizeAccess(workspaceId, access, requestedPath) {
      const grant = api.getActive(workspaceId);
      if (!grant) {
        throw new GrantError(`workspace is not authorized: ${workspaceId}`, "WORKSPACE_NOT_AUTHORIZED");
      }
      if (requestedPath !== undefined) {
        let canonical: string;
        try {
          canonical = canonicalizeWorkspacePath(requestedPath);
        } catch (err) {
          throw new GrantError(`workspace path invalid: ${(err as Error).message}`, "INVALID_PATH");
        }
        if (canonical !== grant.canonicalPath) {
          throw new GrantError("workspace path does not match the granted workspace", "WORKSPACE_PATH_MISMATCH");
        }
      }
      if (access === "write" && !grant.permissions.write) {
        throw new GrantError(`workspace ${workspaceId} is read-only; write access was not granted`, "WRITE_NOT_GRANTED");
      }
      return grant;
    },
  };
  return api;
}

// Re-exported so callers fail with the familiar workspace error taxonomy.
export { WorkspaceError };
