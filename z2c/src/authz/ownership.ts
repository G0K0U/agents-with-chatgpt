import { join } from "node:path";
import { loadJson, saveJsonAtomic } from "../util/fsjson.js";
import type { WorkspaceAccess } from "./grants.js";
import type { Principal } from "./pairing.js";

/**
 * Session ownership: an explicit Z2C-side record of who created/owns each
 * controlled session. A paired client must not automatically control every
 * local ZCode session, and a bare session id is NOT authorization — every
 * access re-checks ownership + workspace binding + attestation.
 */

export interface OwnedSession {
  sessionId: string;
  workspaceId: string;
  /** "local" for service-secret callers, else the paired clientId. */
  clientId: string;
  accessMode: WorkspaceAccess;
  createdAt: number;
  lastUsedAt: number;
}

interface OwnershipState {
  version: 1;
  sessions: OwnedSession[];
}

export class OwnershipError extends Error {
  constructor(message: string, public readonly code: string, public readonly httpStatus = 403) {
    super(message);
    this.name = "OwnershipError";
  }
}

export interface SessionOwnership {
  record(session: Omit<OwnedSession, "createdAt" | "lastUsedAt">): OwnedSession;
  get(sessionId: string): OwnedSession | undefined;
  /** Ownership + access check. Local principal may see all Z2C-owned sessions;
   *  a paired client only its own (sharing is a future explicit action). */
  assertCanAccess(principal: Principal, sessionId: string, access: WorkspaceAccess): OwnedSession;
  touch(sessionId: string): void;
  forget(sessionId: string): void;
  listFor(principal: Principal): OwnedSession[];
}

export function loadSessionOwnership(stateDir: string): SessionOwnership {
  const path = join(stateDir, "ownership.json");
  const existing = loadJson<OwnershipState>(path);
  const state: OwnershipState = existing?.version === 1 && Array.isArray(existing.sessions) ? existing : { version: 1, sessions: [] };
  const save = () => saveJsonAtomic(path, state);

  const api: SessionOwnership = {
    record(session) {
      const now = Date.now();
      const existing0 = state.sessions.find((s) => s.sessionId === session.sessionId);
      if (existing0) {
        existing0.lastUsedAt = now;
        existing0.accessMode = session.accessMode;
        save();
        return existing0;
      }
      const record: OwnedSession = { ...session, createdAt: now, lastUsedAt: now };
      state.sessions.push(record);
      if (state.sessions.length > 2000) state.sessions.splice(0, state.sessions.length - 2000);
      save();
      return record;
    },
    get(sessionId) {
      return state.sessions.find((s) => s.sessionId === sessionId);
    },
    assertCanAccess(principal, sessionId, access) {
      const owned = state.sessions.find((s) => s.sessionId === sessionId);
      // Unknown-to-Z2C native sessions never appear remotely and cannot be
      // adopted by guessing a session id.
      if (!owned) throw new OwnershipError(`session is not owned by Z2C: ${sessionId.slice(0, 12)}…`, "SESSION_NOT_OWNED", 404);
      if (principal.kind === "client" && owned.clientId !== principal.clientId) {
        throw new OwnershipError("session belongs to another client", "OWNERSHIP_DENIED");
      }
      if (access === "write" && owned.accessMode === "readonly") {
        throw new OwnershipError("session is readonly; write operation rejected", "SESSION_READONLY");
      }
      return owned;
    },
    touch(sessionId) {
      const owned = state.sessions.find((s) => s.sessionId === sessionId);
      if (owned) {
        owned.lastUsedAt = Date.now();
        save();
      }
    },
    forget(sessionId) {
      state.sessions = state.sessions.filter((s) => s.sessionId !== sessionId);
      save();
    },
    listFor(principal) {
      return principal.kind === "local"
        ? state.sessions.slice()
        : state.sessions.filter((s) => s.clientId === principal.clientId);
    },
  };
  return api;
}
