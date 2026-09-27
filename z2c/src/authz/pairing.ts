import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { loadJson, saveJsonAtomic } from "../util/fsjson.js";

/**
 * Local pairing state machine — the future ChatGPT connector handshake,
 * implemented locally first (no cloud backend required).
 *
 *   UNPAIRED ──beginPairing()──▶ PAIRING_PENDING ──confirmPairing(code)──▶ PAIRED
 *                                    │ (expiry / single use)                  │
 *                                    ▼                                        ▼
 *                                UNPAIRED ◀──────────────────────────────revoke(clientId)
 *
 * Invariants (see docs/z2c-pairing-protocol.md):
 *  - pairing proves a DEVICE, never a workspace and never a provider credential;
 *  - pairing success grants NOTHING until the local user authorizes workspaces;
 *  - codes are single-use, high-entropy enough for their 5-minute window, and
 *    bounded attempts;
 *  - the client token is shown exactly once and stored only as a SHA-256 hash.
 */

export type PairingState = "UNPAIRED" | "PAIRING_PENDING" | "PAIRED" | "REVOKED";

export interface PendingPairing {
  pairingId: string;
  code: string;
  deviceName: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
}

export interface PairedClient {
  clientId: string;
  deviceName: string;
  /** SHA-256 of the client token — the token itself is never persisted. */
  tokenHash: string;
  pairedAt: number;
  revokedAt?: number;
}

interface PairingStateFile {
  version: 1;
  pending: PendingPairing[];
  clients: PairedClient[];
}

export interface Principal {
  /** "local" = holds the service secret (the user's own machine). */
  kind: "local" | "client";
  clientId: string | null;
  deviceName: string | null;
}

export const LOCAL_PRINCIPAL: Principal = { kind: "local", clientId: null, deviceName: null };

export const PAIRING_CODE_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS_PER_PAIRING = 5;
const MAX_PENDING = 3;

export class PairingError extends Error {
  constructor(message: string, public readonly code: string, public readonly httpStatus = 400) {
    super(message);
    this.name = "PairingError";
  }
}

export interface PairingManager {
  beginPairing(deviceName: string): { pairingId: string; code: string; expiresAt: number; state: PairingState };
  /** Single-use confirmation: burns the code and returns the client token ONCE. */
  confirmPairing(pairingId: string, code: string): { clientId: string; token: string; deviceName: string; state: PairingState };
  listClients(): Array<PairedClient & { state: PairingState }>;
  revoke(clientId: string): void;
  /** Bearer-token authentication for paired clients; null = not paired/revoked. */
  authenticate(token: string | undefined | null): Principal | null;
  pairingState(): PairingState;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function loadPairing(stateDir: string): PairingManager {
  const path = join(stateDir, "pairing.json");
  const existing = loadJson<PairingStateFile>(path);
  const state: PairingStateFile =
    existing?.version === 1 && Array.isArray(existing.clients) && Array.isArray(existing.pending)
      ? existing
      : { version: 1, pending: [], clients: [] };
  const save = () => saveJsonAtomic(path, state);

  const api: PairingManager = {
    beginPairing(deviceName) {
      const name = deviceName.trim().slice(0, 60) || "device";
      const now = Date.now();
      // Bound pending pairings; drop expired ones.
      state.pending = state.pending.filter((p) => p.expiresAt > now).slice(-MAX_PENDING + 1);
      const pairing: PendingPairing = {
        pairingId: `pair_${randomBytes(6).toString("hex")}`,
        code: String(100000 + (randomBytes(4).readUInt32BE(0) % 900000)),
        deviceName: name,
        createdAt: now,
        expiresAt: now + PAIRING_CODE_TTL_MS,
        attempts: 0,
      };
      state.pending.push(pairing);
      save();
      return { pairingId: pairing.pairingId, code: pairing.code, expiresAt: pairing.expiresAt, state: "PAIRING_PENDING" };
    },
    confirmPairing(pairingId, code) {
      const now = Date.now();
      const idx = state.pending.findIndex((p) => p.pairingId === pairingId);
      if (idx === -1) throw new PairingError("unknown or already-consumed pairing request", "PAIRING_NOT_FOUND", 404);
      const pairing = state.pending[idx]!;
      if (pairing.expiresAt <= now) {
        state.pending.splice(idx, 1);
        save();
        throw new PairingError("pairing code expired; start pairing again", "PAIRING_EXPIRED", 400);
      }
      if (pairing.attempts >= MAX_ATTEMPTS_PER_PAIRING) {
        state.pending.splice(idx, 1);
        save();
        throw new PairingError("too many attempts; pairing request burned", "PAIRING_BURNED", 429);
      }
      const provided = Buffer.from(code.trim());
      const expected = Buffer.from(pairing.code);
      const matches = provided.length === expected.length && timingSafeEqual(provided, expected);
      if (!matches) {
        pairing.attempts += 1;
        save();
        throw new PairingError("pairing code does not match", "PAIRING_CODE_MISMATCH", 403);
      }
      // Single use: burn the request regardless of outcome beyond this point.
      state.pending.splice(idx, 1);
      const clientId = `cli_${randomBytes(8).toString("hex")}`;
      const token = `z2cpair_${randomBytes(32).toString("hex")}`;
      state.clients.push({
        clientId,
        deviceName: pairing.deviceName,
        tokenHash: hashToken(token),
        pairedAt: now,
      });
      save();
      return { clientId, token, deviceName: pairing.deviceName, state: "PAIRED" };
    },
    listClients() {
      return state.clients.map((c) => ({ ...c, state: (c.revokedAt === undefined ? "PAIRED" : "REVOKED") as PairingState }));
    },
    revoke(clientId) {
      const client = state.clients.find((c) => c.clientId === clientId && c.revokedAt === undefined);
      if (!client) throw new PairingError(`no paired client: ${clientId}`, "CLIENT_NOT_FOUND", 404);
      client.revokedAt = Date.now();
      save();
    },
    authenticate(token) {
      if (!token) return null;
      const hash = hashToken(token);
      const client = state.clients.find((c) => c.tokenHash === hash && c.revokedAt === undefined);
      if (!client) return null;
      return { kind: "client", clientId: client.clientId, deviceName: client.deviceName };
    },
    pairingState() {
      if (state.clients.some((c) => c.revokedAt === undefined)) return "PAIRED";
      if (state.pending.some((p) => p.expiresAt > Date.now())) return "PAIRING_PENDING";
      return "UNPAIRED";
    },
  };
  return api;
}

export function randomToken(): string {
  return randomBytes(32).toString("hex");
}
