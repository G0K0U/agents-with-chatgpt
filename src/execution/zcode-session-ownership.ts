import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

/**
 * A2C-side Z2C session ownership, v2: OBSERVE and CONTROL are separate
 * capabilities.
 *
 * Sessions created through the A2C semantic zcode_* surface are recorded per
 * authenticated OAuth client. Client ownership is preserved — the owning
 * client keeps both capabilities by default — but they are now split
 * semantically so they can be granted, delegated, and audited independently:
 *
 *   - capabilities.observe : live owner-scoped reads of the session state
 *   - capabilities.control : send / set_model / set_thought_level (mutating)
 *   - delegatedControllers : explicitly delegated controller principals
 *
 * The local operator principal ("local" — CLI / service secret) is trusted
 * and keeps observe+control over every recorded session. Cross-client
 * shared-plane OBSERVATION (seeing another client's session in the provider
 * neutral projection) is enforced by the agent plane, not here; this store
 * never loses its fail-closed no-existence-oracle property.
 *
 * Migration: version 1 files are migrated in memory on load (each v1 record
 * becomes a v2 record with observe+control granted to the original client and
 * no delegations) and every subsequent write persists the v2 envelope. No
 * history is destroyed.
 */

export interface SessionCapabilities {
  /** Live owner-scoped session reads (zcode_session_read). */
  observe: boolean;
  /** Mutating session operations (send / set_model / set_thought_level). */
  control: boolean;
}

export interface ZcodeOwnedSession {
  sessionId: string;
  workspaceId: string;
  clientId: string;
  access: "readonly" | "write";
  capabilities: SessionCapabilities;
  /** Additional principals allowed to CONTROL (never more than the owner grants). */
  delegatedControllers: string[];
  /** Where this session was created from. A2C-recorded sessions are "a2c". */
  origin: "a2c";
  createdAt: number;
  lastUsedAt: number;
}

/** v1 on-disk record (pre capability split); migrated on load. */
interface ZcodeOwnedSessionV1 {
  sessionId: string;
  workspaceId: string;
  clientId: string;
  access: "readonly" | "write";
  createdAt: number;
  lastUsedAt: number;
}

interface OwnershipStateV1 {
  version: 1;
  sessions: ZcodeOwnedSessionV1[];
}

interface OwnershipState {
  version: 2;
  sessions: ZcodeOwnedSession[];
}

export class ZcodeSessionOwnershipError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "ZCODE_SESSION_NOT_OWNED"
      | "ZCODE_SESSION_WORKSPACE_MISMATCH"
      | "ZCODE_SESSION_CONTROL_DENIED"
      | "ZCODE_SESSION_OBSERVE_DENIED",
  ) {
    super(message);
    this.name = "ZcodeSessionOwnershipError";
  }
}

/** Principal key for ownership: OAuth client id, or "local" for trusted callers. */
export function zcodeSessionClientId(authInfo: AuthInfo | undefined): string {
  if (!authInfo) return "local";
  const clientId = (authInfo as { clientId?: unknown }).clientId;
  return typeof clientId === "string" && clientId.length > 0 ? clientId : "local";
}

function migrateV1Session(s: ZcodeOwnedSessionV1): ZcodeOwnedSession {
  return {
    sessionId: s.sessionId,
    workspaceId: s.workspaceId,
    clientId: s.clientId,
    access: s.access,
    capabilities: { observe: true, control: true },
    delegatedControllers: [],
    origin: "a2c",
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
  };
}

function parseState(raw: unknown): OwnershipState {
  const parsed = raw as (Partial<OwnershipState> | Partial<OwnershipStateV1>) | null;
  if (!parsed || !Array.isArray(parsed.sessions)) return { version: 2, sessions: [] };
  if (parsed.version === 1) {
    return {
      version: 2,
      sessions: (parsed.sessions as ZcodeOwnedSessionV1[])
        .filter((s) => s && typeof s.sessionId === "string")
        .map(migrateV1Session),
    };
  }
  if (parsed.version === 2) {
    // Defensive: tolerate v1-shaped entries inside a v2 envelope.
    return {
      version: 2,
      sessions: (parsed.sessions as Array<ZcodeOwnedSession | ZcodeOwnedSessionV1>)
        .filter((s) => s && typeof s.sessionId === "string")
        .map((s) => ("capabilities" in s && s.capabilities ? (s as ZcodeOwnedSession) : migrateV1Session(s as ZcodeOwnedSessionV1))),
    };
  }
  return { version: 2, sessions: [] };
}

function loadState(path: string): OwnershipState {
  try {
    return parseState(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { version: 2, sessions: [] }; /* missing/corrupt → fresh */
  }
}

function saveStateAtomic(path: string, state: OwnershipState): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

export interface ZcodeSessionOwnership {
  record(session: { sessionId: string; workspaceId: string; clientId: string; access: "readonly" | "write" }): void;
  /** Fail-closed owner-scoped access check; never reveals whether a foreign session exists. */
  assertCanAccess(authInfo: AuthInfo | undefined, sessionId: string, workspaceId: string): ZcodeOwnedSession;
  /**
   * OBSERVE check: owner-scoped read of the live session state, gated by the
   * observe capability. Separate from assertCanControl — being able to read a
   * session never implies the ability to mutate it, and vice versa.
   */
  assertCanObserve(authInfo: AuthInfo | undefined, sessionId: string, workspaceId: string): ZcodeOwnedSession;
  /** CONTROL check: owner, local operator, or explicitly delegated controller. */
  assertCanControl(authInfo: AuthInfo | undefined, sessionId: string, workspaceId: string): ZcodeOwnedSession;
  /** Raw record (may be undefined); used by the shared observe plane. */
  sessionRecord(sessionId: string): ZcodeOwnedSession | undefined;
  /** Number of recorded sessions (shared-plane sync change detector). */
  count(): number;
  /** Owner-granted explicit control delegation. */
  delegateControl(sessionId: string, ownerClientId: string, delegateClientId: string): void;
  revokeDelegation(sessionId: string, ownerClientId: string, delegateClientId: string): void;
  touch(sessionId: string): void;
  forget(sessionId: string): void;
}

export function loadZcodeSessionOwnership(stateDir: string): ZcodeSessionOwnership {
  // Empty state dir = in-process memory store (enforcement unchanged; no
  // cross-restart durability). Used by embedded/test server contexts.
  const path = stateDir ? join(stateDir, "zcode-session-ownership.json") : null;
  let state: OwnershipState = path ? loadState(path) : { version: 2, sessions: [] };
  const save = () => {
    if (path) saveStateAtomic(path, state);
  };

  const api: ZcodeSessionOwnership = {
    record(session) {
      const now = Date.now();
      state = path ? loadState(path) : state; // re-read: multiple bridge workers may persist
      const existing0 = state.sessions.find((s) => s.sessionId === session.sessionId);
      if (existing0) {
        existing0.lastUsedAt = now;
        save();
        return;
      }
      state.sessions.push({
        ...session,
        capabilities: { observe: true, control: true },
        delegatedControllers: [],
        origin: "a2c",
        createdAt: now,
        lastUsedAt: now,
      });
      if (state.sessions.length > 5000) state.sessions.splice(0, state.sessions.length - 5000);
      save();
    },
    assertCanAccess(authInfo, sessionId, workspaceId) {
      if (path) state = loadState(path);
      const owned = state.sessions.find((s) => s.sessionId === sessionId);
      const principal = zcodeSessionClientId(authInfo);
      if (!owned || (principal !== "local" && owned.clientId !== principal)) {
        // Same error for unknown and foreign sessions: no existence oracle.
        throw new ZcodeSessionOwnershipError(
          "zcode session is not available for this client",
          "ZCODE_SESSION_NOT_OWNED",
        );
      }
      if (owned.workspaceId !== workspaceId) {
        throw new ZcodeSessionOwnershipError(
          "zcode session is not available for this client",
          "ZCODE_SESSION_WORKSPACE_MISMATCH",
        );
      }
      return owned;
    },
    assertCanObserve(authInfo, sessionId, workspaceId) {
      const owned = api.assertCanAccess(authInfo, sessionId, workspaceId);
      if (owned.capabilities.observe === false) {
        // Capability revocation binds every principal, including the owner and
        // the local operator: the session stays projected on the shared plane
        // (workspace visibility) but its live owner-scoped read fails closed.
        throw new ZcodeSessionOwnershipError(
          "zcode session is not observable by this client",
          "ZCODE_SESSION_OBSERVE_DENIED",
        );
      }
      return owned;
    },
    assertCanControl(authInfo, sessionId, workspaceId) {
      if (path) state = loadState(path);
      const owned = state.sessions.find((s) => s.sessionId === sessionId);
      const principal = zcodeSessionClientId(authInfo);
      if (!owned) {
        throw new ZcodeSessionOwnershipError(
          "zcode session is not available for this client",
          "ZCODE_SESSION_NOT_OWNED",
        );
      }
      if (owned.workspaceId !== workspaceId) {
        throw new ZcodeSessionOwnershipError(
          "zcode session is not available for this client",
          "ZCODE_SESSION_WORKSPACE_MISMATCH",
        );
      }
      const isOwner = principal === "local" || owned.clientId === principal;
      const isDelegated = owned.delegatedControllers.includes(principal);
      if (!isOwner && !isDelegated) {
        throw new ZcodeSessionOwnershipError(
          "zcode session is not available for this client",
          "ZCODE_SESSION_NOT_OWNED",
        );
      }
      if (owned.capabilities.control === false) {
        throw new ZcodeSessionOwnershipError(
          "zcode session is not controllable by this client",
          "ZCODE_SESSION_CONTROL_DENIED",
        );
      }
      return owned;
    },
    sessionRecord(sessionId) {
      if (path) state = loadState(path);
      return state.sessions.find((s) => s.sessionId === sessionId);
    },
    count() {
      if (path) state = loadState(path);
      return state.sessions.length;
    },
    delegateControl(sessionId, ownerClientId, delegateClientId) {
      state = path ? loadState(path) : state;
      const owned = state.sessions.find((s) => s.sessionId === sessionId);
      if (!owned || owned.clientId !== ownerClientId) {
        throw new ZcodeSessionOwnershipError("zcode session is not available for this client", "ZCODE_SESSION_NOT_OWNED");
      }
      if (!owned.delegatedControllers.includes(delegateClientId)) {
        owned.delegatedControllers.push(delegateClientId);
        save();
      }
    },
    revokeDelegation(sessionId, ownerClientId, delegateClientId) {
      state = path ? loadState(path) : state;
      const owned = state.sessions.find((s) => s.sessionId === sessionId);
      if (!owned || owned.clientId !== ownerClientId) {
        throw new ZcodeSessionOwnershipError("zcode session is not available for this client", "ZCODE_SESSION_NOT_OWNED");
      }
      owned.delegatedControllers = owned.delegatedControllers.filter((c) => c !== delegateClientId);
      save();
    },
    touch(sessionId) {
      if (path) state = loadState(path);
      const owned = state.sessions.find((s) => s.sessionId === sessionId);
      if (owned) {
        owned.lastUsedAt = Date.now();
        save();
      }
    },
    forget(sessionId) {
      if (path) state = loadState(path);
      if (state.sessions.some((s) => s.sessionId === sessionId)) {
        state.sessions = state.sessions.filter((s) => s.sessionId !== sessionId);
        save();
      }
    },
  };
  return api;
}
