import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { loadJson, saveJsonAtomic } from "../util/fsjson.js";

/**
 * Local service security: installation identity + high-entropy service
 * secret(s). Threat model addressed here:
 *  - "knowing the port" must NOT grant control  → bearer secret required
 *  - stale/compromised secret                   → rotation with grace window
 *  - cross-user access                          → state dir lives under the
 *    per-user LOCALAPPDATA profile (Windows ACLs isolate per-user)
 * The secret is never printed or logged — only a short fingerprint.
 */

export interface ServiceSecretRecord {
  id: string;
  secret: string;
  createdAt: number;
  /** Set when rotated: the secret stays valid until retiredAt, then is dead. */
  retiredAt?: number;
}

export interface ServiceSecurityState {
  version: 1;
  /** Random installation identity — stable across restarts, never secret. */
  installId: string;
  secrets: ServiceSecretRecord[];
  /** Grace window a rotated (retired) secret remains valid, ms. */
  rotationGraceMs: number;
}

const ROTATION_GRACE_MS = 24 * 60 * 60_000;
const MAX_KEPT_RETIRED = 5;

export function fingerprintSecret(secret: string): string {
  // Short, non-reversible identifier safe for logs/status output.
  let h = 0;
  for (let i = 0; i < secret.length; i++) h = (h * 31 + secret.charCodeAt(i)) >>> 0;
  return `fp:${h.toString(16)}`;
}

export function generateServiceSecret(): string {
  return `z2cs_${randomBytes(32).toString("hex")}`;
}

export interface ServiceSecurity {
  state: ServiceSecurityState;
  /** Principal id presented by holders of a current secret ("local"). */
  authenticate(secret: string | undefined | null): boolean;
  /** Rotate: mint a new active secret; the previous one stays valid for the grace window. */
  rotate(): ServiceSecretRecord;
  /** Current active secret (for CLI reads over a local channel). */
  currentSecret(): ServiceSecretRecord;
  /** Save (only the rotation flow needs to persist). */
  save(): void;
}

export function loadOrCreateSecurity(stateDir: string): ServiceSecurity {
  const path = join(stateDir, "security.json");
  const existing = loadJson<ServiceSecurityState>(path);
  const state: ServiceSecurityState =
    existing?.version === 1 && Array.isArray(existing.secrets) && existing.secrets.length > 0
      ? existing
      : {
          version: 1,
          installId: `inst_${randomBytes(8).toString("hex")}`,
          secrets: [{ id: `sec_${randomBytes(4).toString("hex")}`, secret: generateServiceSecret(), createdAt: Date.now() }],
          rotationGraceMs: ROTATION_GRACE_MS,
        };
  const api: ServiceSecurity = {
    state,
    authenticate(secret) {
      if (!secret) return false;
      const now = Date.now();
      for (const rec of state.secrets) {
        const expired = rec.retiredAt !== undefined && now - rec.retiredAt > state.rotationGraceMs;
        if (expired) continue;
        if (constantTimeEquals(secret, rec.secret)) return true;
      }
      return false;
    },
    rotate() {
      const retired = state.secrets.map((s) => (s.retiredAt === undefined ? { ...s, retiredAt: Date.now() } : s));
      const fresh: ServiceSecretRecord = { id: `sec_${randomBytes(4).toString("hex")}`, secret: generateServiceSecret(), createdAt: Date.now() };
      state.secrets = [fresh, ...retired.filter((s) => Date.now() - (s.retiredAt ?? 0) <= state.rotationGraceMs)].slice(0, 1 + MAX_KEPT_RETIRED);
      saveJsonAtomic(path, state);
      return fresh;
    },
    currentSecret() {
      return state.secrets.find((s) => s.retiredAt === undefined) ?? state.secrets[0]!;
    },
    save() {
      saveJsonAtomic(path, state);
    },
  };
  api.save();
  return api;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
