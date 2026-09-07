import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export const READ_ONLY_SCOPES = [
  "workspace.read",
  "workspace.search",
  "git.read",
  "execution.read",
  "offline_access",
] as const;

/** Explicitly requested write/cancellation capabilities; never granted by default. */
export const EXECUTION_SCOPES = ["execution.submit", "execution.cancel", "execution.queue", "audit_mirror.write"] as const;

export const SUPPORTED_SCOPES = [...READ_ONLY_SCOPES, ...EXECUTION_SCOPES] as const;

export type Scope = (typeof SUPPORTED_SCOPES)[number];

export interface ClientRegistration {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: string;
}

export interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  workspaceIds: string[];
  /** Legacy single-workspace field retained only for state migration. */
  workspaceId?: string;
  pairingSessionId: string;
  resource?: string;
  expiresAt: number;
}

export interface TokenRecord {
  hash: string;
  kind: "access" | "refresh";
  clientId: string;
  workspaceIds: string[];
  /** Legacy single-workspace field retained only for state migration. */
  workspaceId?: string;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
}

interface PersistedAuthState {
  clients?: unknown;
  tokens?: unknown;
}

interface AuthStateRead {
  exists: boolean;
  data: PersistedAuthState | null;
}

export type VerifyTokenResult =
  | { ok: true; record: TokenRecord }
  | { ok: false; reason: "unknown" | "expired" | "revoked" | "wrong_kind" };

/** Bridge-owned generation fence for shared OAuth state mutations. */
export interface AuthStateGenerationFence {
  assertCurrent(): void;
}

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const AUTH_STATE_LOCK_TIMEOUT_MS = 10_000;
const AUTH_STATE_LOCK_STALE_MS = 60_000;
const AUTH_STATE_LOCK_RETRY_MS = 15;
const AUTH_STATE_LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function persistedRows(data: PersistedAuthState | null, key: "clients" | "tokens"): unknown[] {
  if (!data || !Array.isArray(data[key])) return [];
  return data[key] as unknown[];
}

function isPersistedAuthState(value: unknown): value is PersistedAuthState {
  return isRecord(value) &&
    (value.clients === undefined || Array.isArray(value.clients)) &&
    (value.tokens === undefined || Array.isArray(value.tokens));
}

function isAllowedRedirectUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "https:" ||
      (parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"));
  } catch {
    return false;
  }
}

function isClientRegistration(value: unknown): value is ClientRegistration {
  if (!isRecord(value)) return false;
  return (
    typeof value.clientId === "string" &&
    value.clientId.length > 0 &&
    value.clientId.length <= 256 &&
    Array.isArray(value.redirectUris) &&
    value.redirectUris.length > 0 &&
    value.redirectUris.every((uri): uri is string => typeof uri === "string" && isAllowedRedirectUri(uri)) &&
    typeof value.createdAt === "string" &&
    (value.clientName === undefined || typeof value.clientName === "string")
  );
}

function readAuthState(file: string): AuthStateRead {
  if (!fs.existsSync(file)) return { exists: false, data: null };
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return { exists: true, data: isPersistedAuthState(data) ? data : null };
  } catch {
    return { exists: true, data: null };
  }
}

function readPersistedAuthState(file: string): PersistedAuthState | null {
  return readAuthState(file).data;
}

function sleepForLock(): void {
  Atomics.wait(AUTH_STATE_LOCK_WAIT_BUFFER, 0, 0, AUTH_STATE_LOCK_RETRY_MS);
}

function processIsAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function staleLockCanBeRemoved(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs < AUTH_STATE_LOCK_STALE_MS) return false;
    let owner: { pid?: unknown } = {};
    try {
      owner = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown };
    } catch {
      // An interrupted lock-file write has no trustworthy owner. Its age is
      // the only available signal, so allow bounded stale cleanup.
    }
    return !processIsAlive(owner.pid);
  } catch {
    return false;
  }
}

function withAuthStateLock<T>(file: string, action: () => T): T {
  const lockFile = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const ownerToken = randomBytes(16).toString("hex");
  const deadline = Date.now() + AUTH_STATE_LOCK_TIMEOUT_MS;
  let lockFd: number | undefined;
  while (lockFd === undefined) {
    try {
      lockFd = fs.openSync(lockFile, "wx", 0o600);
      try {
        fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, ownerToken, createdAt: new Date().toISOString() }));
        fs.closeSync(lockFd);
      } catch (error) {
        try { fs.closeSync(lockFd); } catch { /* best effort */ }
        lockFd = undefined;
        try { fs.rmSync(lockFile, { force: true }); } catch { /* best effort */ }
        throw error;
      }
      lockFd = undefined;
      break;
    } catch (error) {
      if (lockFd !== undefined) {
        try { fs.closeSync(lockFd); } catch { /* best effort */ }
        lockFd = undefined;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error("OAuth auth state is busy; refusing to overwrite it");
      }
      if (staleLockCanBeRemoved(lockFile)) {
        try { fs.rmSync(lockFile, { force: true }); } catch { /* another writer may own it now */ }
      } else {
        sleepForLock();
      }
    }
  }

  try {
    return action();
  } finally {
    try {
      const owner = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { ownerToken?: unknown };
      if (owner.ownerToken === ownerToken) fs.rmSync(lockFile, { force: true });
    } catch {
      // Never remove a lock whose ownership cannot be verified.
    }
  }
}

export interface AuthStateReconciliation {
  targetFile: string;
  sourceFiles: number;
  clients: number;
  tokens: number;
  clientsAdded: number;
  tokensAdded: number;
  conflicts: number;
  malformedSourceRows: number;
  blocked: boolean;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Merge valid OAuth state from an old state domain into one bridge-owned
 * snapshot.  The target is locked using the same create-once lock as normal
 * AuthStore mutations.  Invalid target state blocks the write; invalid
 * source rows are ignored and counted, never guessed into credentials.
 */
export function reconcileAuthState(
  targetFile: string,
  sourceFiles: readonly string[],
  authorizedWorkspaceIds: readonly string[] = []
): AuthStateReconciliation {
  const target = path.resolve(targetFile);
  const sources = [...new Set(sourceFiles.map((file) => path.resolve(file)))].filter((file) => file !== target);
  return withAuthStateLock(target, () => {
    const targetRead = readAuthState(target);
    const report: AuthStateReconciliation = {
      targetFile: target,
      sourceFiles: sources.length,
      clients: 0,
      tokens: 0,
      clientsAdded: 0,
      tokensAdded: 0,
      conflicts: 0,
      malformedSourceRows: 0,
      blocked: false,
    };
    if (targetRead.exists && targetRead.data === null) {
      report.blocked = true;
      return report;
    }

    const targetData = targetRead.data;
    const sourceData = sources
      .map((file) => readAuthState(file))
      .filter((entry): entry is AuthStateRead & { data: PersistedAuthState } => entry.data !== null);
    const clientMap = new Map<string, ClientRegistration>();
    const targetClients = persistedRows(targetData, "clients");
    const sourceClients = sourceData.flatMap((entry) => persistedRows(entry.data, "clients"));
    for (const candidate of [...targetClients, ...sourceClients]) {
      if (!isClientRegistration(candidate)) {
        if (sourceClients.includes(candidate)) report.malformedSourceRows += 1;
        continue;
      }
      const client = normalizedClient(candidate);
      const existing = clientMap.get(client.clientId);
      if (!existing) {
        clientMap.set(client.clientId, client);
        continue;
      }
      if (sameJson(existing, client)) continue;
      const existingCreated = Date.parse(existing.createdAt);
      const candidateCreated = Date.parse(client.createdAt);
      if (Number.isFinite(candidateCreated) && (!Number.isFinite(existingCreated) || candidateCreated > existingCreated)) {
        clientMap.set(client.clientId, client);
      }
      report.conflicts += 1;
    }

    const revokedHashes = new Set<string>();
    const tokenMap = new Map<string, TokenRecord>();
    const tokenRows = [
      ...persistedRows(targetData, "tokens").map((candidate) => ({ candidate, source: false })),
      ...sourceData.flatMap((entry) => persistedRows(entry.data, "tokens").map((candidate) => ({ candidate, source: true }))),
    ];
    for (const { candidate, source } of tokenRows) {
      if (isRecord(candidate) && candidate.revoked === true && typeof candidate.hash === "string") {
        revokedHashes.add(candidate.hash);
      }
      const token = persistedToken(candidate, Date.now(), authorizedWorkspaceIds, true);
      if (!token) {
        if (source) report.malformedSourceRows += 1;
        continue;
      }
      const existing = tokenMap.get(token.hash);
      if (!existing || token.issuedAt > existing.issuedAt) {
        tokenMap.set(token.hash, token);
      } else if (!sameJson(existing, token)) {
        report.conflicts += 1;
      }
    }
    for (const hash of revokedHashes) tokenMap.delete(hash);
    for (const [hash, token] of [...tokenMap]) {
      if (!clientMap.has(token.clientId)) tokenMap.delete(hash);
    }

    const clients = [...clientMap.values()].map(normalizedClient);
    const tokens = [...tokenMap.values()].filter((token) => !token.revoked && token.expiresAt > Date.now());
    const currentClients = persistedClients(targetData);
    const currentTokens = persistedTokens(targetData, Date.now(), authorizedWorkspaceIds, true);
    report.clients = clients.length;
    report.tokens = tokens.length;
    report.clientsAdded = Math.max(0, clients.length - currentClients.length);
    report.tokensAdded = Math.max(0, tokens.length - currentTokens.size);

    const next = { clients, tokens };
    const current = {
      clients: currentClients,
      tokens: [...currentTokens.values()].filter((token) => !token.revoked && token.expiresAt > Date.now()),
    };
    if (!sameJson(current, next)) writeSecureJson(target, next);
    return report;
  });
}

function normalizedClient(value: ClientRegistration): ClientRegistration {
  return {
    clientId: value.clientId,
    ...(value.clientName === undefined ? {} : { clientName: value.clientName }),
    redirectUris: [...value.redirectUris],
    createdAt: value.createdAt,
  };
}

function persistedClients(data: PersistedAuthState | null): ClientRegistration[] {
  return persistedRows(data, "clients")
    .filter((candidate): candidate is ClientRegistration => isClientRegistration(candidate))
    .map(normalizedClient);
}

function mergeClients(...sources: readonly ClientRegistration[][]): Map<string, ClientRegistration> {
  const clients = new Map<string, ClientRegistration>();
  for (const source of sources) {
    for (const client of source) {
      if (!clients.has(client.clientId)) clients.set(client.clientId, client);
    }
  }
  return clients;
}

function persistedToken(
  candidate: unknown,
  now: number,
  authorizedWorkspaceIds: readonly string[],
  migrateLegacyWorkspaceBindings: boolean
): TokenRecord | null {
  if (!isRecord(candidate)) return null;
  const token = candidate as Partial<TokenRecord> & { workspaceIds?: unknown; workspaceId?: unknown };
  if (
    typeof token.hash !== "string" ||
    token.hash.length === 0 ||
    token.hash.length > 128 ||
    (token.kind !== "access" && token.kind !== "refresh") ||
    typeof token.clientId !== "string" ||
    !Array.isArray(token.scopes) ||
    !token.scopes.every((scope): scope is string => typeof scope === "string") ||
    !Number.isFinite(token.issuedAt) ||
    !Number.isFinite(token.expiresAt) ||
    typeof token.revoked !== "boolean"
  ) return null;
  const issuedAt = token.issuedAt;
  const expiresAt = token.expiresAt;
  if (typeof issuedAt !== "number" || typeof expiresAt !== "number" ||
      !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return null;
  if (token.revoked || expiresAt <= now) return null;
  const storedWorkspaceIds = Array.isArray(token.workspaceIds)
    ? token.workspaceIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const isLegacy = storedWorkspaceIds.length === 0;
  const legacyIds = typeof token.workspaceId === "string" ? [token.workspaceId] : [];
  const workspaceIds = isLegacy
    ? migrateLegacyWorkspaceBindings && legacyIds.some((id) => authorizedWorkspaceIds.includes(id))
      ? [
          ...legacyIds.filter((id) => authorizedWorkspaceIds.includes(id)),
          ...authorizedWorkspaceIds.filter((id) => !legacyIds.includes(id)),
        ]
      : legacyIds
    : storedWorkspaceIds;
  if (workspaceIds.length === 0) return null;
  return {
    hash: token.hash,
    kind: token.kind,
    clientId: token.clientId,
    workspaceIds,
    workspaceId: workspaceIds[0],
    scopes: token.scopes,
    issuedAt,
    expiresAt,
    revoked: token.revoked,
  };
}

function persistedTokens(
  data: PersistedAuthState | null,
  now: number,
  authorizedWorkspaceIds: readonly string[],
  migrateLegacyWorkspaceBindings: boolean
): Map<string, TokenRecord> {
  const tokens = new Map<string, TokenRecord>();
  for (const candidate of persistedRows(data, "tokens")) {
    const token = persistedToken(candidate, now, authorizedWorkspaceIds, migrateLegacyWorkspaceBindings);
    if (token) tokens.set(token.hash, token);
  }
  return tokens;
}

export function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Constant-time string comparison for equal-length inputs. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class AuthStore {
  private clients = new Map<string, ClientRegistration>();
  private tokens = new Map<string, TokenRecord>();
  private authCodes = new Map<string, AuthorizationCodeRecord>();
  private readonly file: string;
  private legacyFiles: readonly string[];
  readonly authorizedWorkspaceIds: readonly string[];
  private readonly migrateLegacyWorkspaceBindings: boolean;
  private readonly legacyFilesReadOnly: boolean;
  private readonly generationFence?: AuthStateGenerationFence;

  constructor(
    readonly workspaceId: string,
    opts: {
      file?: string;
      /** Immutable state domain for the default auth file. */
      stateDir?: string;
      /** Older workspace-scoped stores to import into the bridge store once. */
      legacyFiles?: readonly string[];
      authorizedWorkspaceIds?: readonly string[];
      migrateLegacyWorkspaceBindings?: boolean;
      generationFence?: AuthStateGenerationFence;
      /** Use migration sources only during construction, never on later reads. */
      legacyFilesReadOnly?: boolean;
    } = {}
  ) {
    this.authorizedWorkspaceIds = [...new Set(opts.authorizedWorkspaceIds ?? [workspaceId])].filter(Boolean);
    if (this.authorizedWorkspaceIds.length === 0) this.authorizedWorkspaceIds = [workspaceId];
    this.migrateLegacyWorkspaceBindings = opts.migrateLegacyWorkspaceBindings ?? false;
    this.generationFence = opts.generationFence;
    this.legacyFilesReadOnly = opts.legacyFilesReadOnly ?? false;
    const authDir = ensureDir(path.join(getStateDir(opts.stateDir), "auth"));
    this.file = path.resolve(opts.file ?? path.join(authDir, "bridge.json"));
    const defaultLegacyFiles = opts.file ? [] : [path.join(authDir, `${workspaceId}.json`)];
    this.legacyFiles = [...new Set((opts.legacyFiles ?? defaultLegacyFiles).map((file) => path.resolve(file)))].filter(
      (file) => file !== this.file
    );
    this.load();
  }

  private load(): void {
    const primaryRead = readAuthState(this.file);
    const primaryExists = primaryRead.exists;
    const primary = primaryRead.data;
    const legacy = this.legacyFiles
      .map((file) => readPersistedAuthState(file))
      .filter((data): data is PersistedAuthState => data !== null);

    // Client registration belongs to the bridge, not to one selected
    // workspace. Import it from old workspace-scoped stores even when the
    // canonical bridge store already exists; this repairs registrations that
    // were created before the bridge root changed.
    let migrated = false;
    for (const [data, fromLegacy] of [
      ...(primary ? [[primary, false] as const] : []),
      ...legacy.map((data) => [data, true] as const),
    ]) {
      for (const candidate of persistedRows(data, "clients")) {
        if (!isClientRegistration(candidate)) continue;
        if (this.clients.has(candidate.clientId)) continue;
        this.clients.set(candidate.clientId, candidate);
        migrated ||= fromLegacy;
      }
    }

    // Tokens are imported from legacy files only when the canonical store has
    // not been created yet. This keeps revoke-all/revocation durable instead
    // of resurrecting old tokens on every restart.
    const tokenSources = primary ? [primary] : legacy;
    for (const data of tokenSources) {
      const loaded = persistedTokens(
        data,
        Date.now(),
        this.authorizedWorkspaceIds,
        this.migrateLegacyWorkspaceBindings
      );
      for (const token of loaded.values()) {
        this.tokens.set(token.hash, token);
        const original = persistedRows(data, "tokens").find((candidate) =>
          isRecord(candidate) && candidate.hash === token.hash
        );
        const originalWorkspaceIds = isRecord(original) ? original.workspaceIds : undefined;
        migrated ||= (!Array.isArray(originalWorkspaceIds) || originalWorkspaceIds.length === 0) &&
          token.workspaceIds.length > 1;
      }
    }
    const primaryWellFormed = primary !== null && Array.isArray(primary.clients) && Array.isArray(primary.tokens);
    if ((migrated && primaryWellFormed) || (!primaryExists && legacy.length > 0)) this.save();
    if (this.legacyFilesReadOnly) this.legacyFiles = [];
  }

  private latestStateForWrite(): { clients: Map<string, ClientRegistration>; tokens: Map<string, TokenRecord> } {
    const primaryRead = readAuthState(this.file);
    if (primaryRead.exists && primaryRead.data === null) {
      throw new Error("OAuth auth state is invalid; refusing to overwrite it");
    }
    const primary = primaryRead.data;
    const legacy = this.legacyFiles
      .map((file) => readPersistedAuthState(file))
      .filter((data): data is PersistedAuthState => data !== null);
    const clients = mergeClients(
      persistedClients(primary),
      ...legacy.map((data) => persistedClients(data)),
      [...this.clients.values()].map(normalizedClient)
    );
    const tokenSources = primary ? [primary] : legacy;
    const tokens = new Map<string, TokenRecord>();
    for (const data of tokenSources) {
      for (const [hash, token] of persistedTokens(
        data,
        Date.now(),
        this.authorizedWorkspaceIds,
        this.migrateLegacyWorkspaceBindings
      )) {
        tokens.set(hash, token);
      }
    }
    return { clients, tokens };
  }

  private updatePersistedState(
    mutate: (state: { clients: Map<string, ClientRegistration>; tokens: Map<string, TokenRecord> }) => boolean
  ): boolean {
    this.generationFence?.assertCurrent();
    return withAuthStateLock(this.file, () => {
      this.generationFence?.assertCurrent();
      const state = this.latestStateForWrite();
      const changed = mutate(state);
      if (changed) {
        // A shutdown/restart can transfer authority while this process is
        // waiting on the auth snapshot lock. Check again immediately before
        // the atomic replacement so an older generation cannot commit.
        this.generationFence?.assertCurrent();
        writeSecureJson(this.file, {
          clients: [...state.clients.values()].map(normalizedClient),
          tokens: [...state.tokens.values()].filter((token) => !token.revoked && token.expiresAt > Date.now()),
        });
      }
      this.clients = state.clients;
      this.tokens = state.tokens;
      return changed;
    });
  }

  private save(): void {
    this.updatePersistedState(() => true);
  }

  private reloadTokens(): void {
    const primaryRead = readAuthState(this.file);
    if (primaryRead.exists && primaryRead.data === null) {
      this.tokens.clear();
      return;
    }
    const sources = primaryRead.data
      ? [primaryRead.data]
      : this.legacyFiles
          .map((file) => readPersistedAuthState(file))
          .filter((data): data is PersistedAuthState => data !== null);
    const tokens = new Map<string, TokenRecord>();
    for (const data of sources) {
      for (const [hash, token] of persistedTokens(
        data,
        Date.now(),
        this.authorizedWorkspaceIds,
        this.migrateLegacyWorkspaceBindings
      )) {
        tokens.set(hash, token);
      }
    }
    this.tokens = tokens;
  }

  /** Read existing unrevoked grants for a bounded local continuation lease; never issues credentials. */
  hasOwnerAuthorization(clientId: string, workspaceId: string, scope: string): boolean {
    this.reloadTokens();
    return [...this.tokens.values()].some(token => token.clientId === clientId && !token.revoked && token.expiresAt > Date.now() && token.workspaceIds.includes(workspaceId) && token.scopes.includes(scope));
  }

  // ---- Dynamic Client Registration -------------------------------------

  registerClient(input: { clientName?: string; redirectUris: string[] }): ClientRegistration {
    const client: ClientRegistration = {
      clientId: `c2c_client_${randomBytes(12).toString("base64url")}`,
      clientName: input.clientName,
      redirectUris: input.redirectUris,
      createdAt: new Date().toISOString(),
    };
    this.updatePersistedState(({ clients }) => {
      clients.set(client.clientId, normalizedClient(client));
      return true;
    });
    return client;
  }

  getClient(clientId: string): ClientRegistration | undefined {
    const existing = this.clients.get(clientId);
    if (existing) return existing;

    // Another bridge process may have completed dynamic registration after
    // this process loaded its in-memory map. Refresh only the client registry
    // on a miss; token state is deliberately not reloaded here so revocation
    // cannot be undone by a stale legacy file.
    const sources = [
      readPersistedAuthState(this.file),
      ...this.legacyFiles.map((file) => readPersistedAuthState(file)),
    ];
    for (const data of sources) {
      for (const candidate of persistedRows(data, "clients")) {
        if (!isClientRegistration(candidate) || candidate.clientId !== clientId) continue;
        this.clients.set(candidate.clientId, candidate);
        return candidate;
      }
    }
    return undefined;
  }

  // ---- Authorization codes ----------------------------------------------

  createAuthorizationCode(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
    workspaceIds?: readonly string[];
    pairingSessionId: string;
    resource?: string;
  }): string {
    this.generationFence?.assertCurrent();
    const code = newToken("c2c_ac");
    this.authCodes.set(code, {
      code,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scopes: input.scopes,
      workspaceIds: [...new Set(input.workspaceIds ?? this.authorizedWorkspaceIds)],
      workspaceId: this.workspaceId,
      pairingSessionId: input.pairingSessionId,
      resource: input.resource,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });
    return code;
  }

  /** One-time consumption of an authorization code. */
  consumeAuthorizationCode(code: string): AuthorizationCodeRecord | null {
    const record = this.authCodes.get(code);
    if (!record) return null;
    this.authCodes.delete(code);
    if (Date.now() > record.expiresAt) return null;
    return record;
  }

  // ---- Tokens -------------------------------------------------------------

  private createTokenBundle(input: {
    clientId: string;
    scopes: string[];
    workspaceId?: string;
    workspaceIds?: readonly string[];
    accessTtlMs?: number;
  }): {
    records: TokenRecord[];
    response: { accessToken: string; refreshToken: string | null; expiresIn: number; scopes: string[] };
  } {
    const now = Date.now();
    const workspaceIds = input.workspaceId
      ? [input.workspaceId]
      : [...new Set(input.workspaceIds ?? this.authorizedWorkspaceIds)];
    if (workspaceIds.length === 0) throw new Error("At least one authorized workspace is required");
    const workspaceId = workspaceIds[0];
    const accessTtl = input.accessTtlMs ?? ACCESS_TOKEN_TTL_MS;
    const scopes = [...input.scopes];
    const accessToken = newToken("c2c_at");
    const accessHash = sha256hex(accessToken);
    const records: TokenRecord[] = [{
      hash: accessHash,
      kind: "access",
      clientId: input.clientId,
      workspaceIds,
      workspaceId,
      scopes,
      issuedAt: now,
      expiresAt: now + accessTtl,
      revoked: false,
    }];

    let refreshToken: string | null = null;
    if (scopes.includes("offline_access")) {
      refreshToken = newToken("c2c_rt");
      records.push({
        hash: sha256hex(refreshToken),
        kind: "refresh",
        clientId: input.clientId,
        workspaceIds,
        workspaceId,
        scopes,
        issuedAt: now,
        expiresAt: now + REFRESH_TOKEN_TTL_MS,
        revoked: false,
      });
    }
    return {
      records,
      response: {
        accessToken,
        refreshToken,
        expiresIn: Math.floor(accessTtl / 1000),
        scopes,
      },
    };
  }

  issueTokens(input: {
    clientId: string;
    scopes: string[];
    workspaceId?: string;
    workspaceIds?: readonly string[];
    accessTtlMs?: number;
  }): { accessToken: string; refreshToken: string | null; expiresIn: number; scopes: string[] } {
    const bundle = this.createTokenBundle(input);
    this.updatePersistedState(({ tokens }) => {
      for (const token of bundle.records) tokens.set(token.hash, token);
      return true;
    });
    return bundle.response;
  }

  verifyAccessToken(token: string): VerifyTokenResult {
    this.reloadTokens();
    const record = this.tokens.get(sha256hex(token));
    if (!record) return { ok: false, reason: "unknown" };
    if (record.kind !== "access") return { ok: false, reason: "wrong_kind" };
    if (record.revoked) return { ok: false, reason: "revoked" };
    if (Date.now() > record.expiresAt) return { ok: false, reason: "expired" };
    return { ok: true, record };
  }

  /** Refresh-token rotation: old refresh token is revoked, a new pair is issued. */
  refresh(
    refreshToken: string,
    clientId: string
  ): { ok: true; tokens: ReturnType<AuthStore["issueTokens"]> } | { ok: false; reason: string } {
    let result: { ok: true; tokens: ReturnType<AuthStore["issueTokens"]> } | { ok: false; reason: string } = {
      ok: false,
      reason: "invalid_grant",
    };
    this.updatePersistedState(({ tokens }) => {
      const record = tokens.get(sha256hex(refreshToken));
      if (!record || record.kind !== "refresh") return false;
      if (record.revoked || Date.now() > record.expiresAt) return false;
      if (record.clientId !== clientId) {
        result = { ok: false, reason: "invalid_client" };
        return false;
      }
      const bundle = this.createTokenBundle({
        clientId,
        scopes: record.scopes,
        workspaceIds: record.workspaceIds ?? (record.workspaceId ? [record.workspaceId] : undefined),
      });
      tokens.delete(record.hash);
      for (const token of bundle.records) tokens.set(token.hash, token);
      result = { ok: true, tokens: bundle.response };
      return true;
    });
    return result;
  }

  revokeToken(token: string): boolean {
    let revoked = false;
    this.updatePersistedState(({ tokens }) => {
      const hash = sha256hex(token);
      if (!tokens.has(hash)) return false;
      tokens.delete(hash);
      revoked = true;
      return true;
    });
    return revoked;
  }

  /** Used by `c2c unpair`: revoke everything for this workspace. */
  revokeAll(): number {
    let count = 0;
    this.updatePersistedState(({ tokens }) => {
      count = tokens.size;
      if (count === 0) return false;
      tokens.clear();
      return true;
    });
    this.authCodes.clear();
    return count;
  }

  tokenCount(): number {
    this.reloadTokens();
    return this.tokens.size;
  }

  static deleteStateFile(workspaceId: string, stateDir?: string): void {
    const file = path.join(getStateDir(stateDir), "auth", `${workspaceId}.json`);
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
}

export function filterScopes(requested: string | undefined): string[] {
  // Legacy clients that do not send a scope request keep the original
  // read-only behavior. Execution authority must be explicit and visible in
  // the pairing approval page.
  if (!requested || requested.trim() === "") return [...READ_ONLY_SCOPES];
  const asked = requested.split(/[\s+]+/).filter(Boolean);
  const granted = asked.filter((scope) => (SUPPORTED_SCOPES as readonly string[]).includes(scope));
  return granted.length > 0 ? granted : [...READ_ONLY_SCOPES];
}
