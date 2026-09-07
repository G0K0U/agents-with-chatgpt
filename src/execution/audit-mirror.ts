import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { Workspace } from "../workspace/manager.js";
import { appendExecutionRecord } from "./records.js";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

/**
 * The only OneDrive account folder accepted by the Engineering AI mirror,
 * operator-configured via C2C_ONEDRIVE_FOLDER_NAME. Empty by default so no
 * personal institution/account name ships in the product and the mirror
 * resolves no target until configured.
 */
export const ENGINEERING_AI_ONEDRIVE_FOLDER = process.env.C2C_ONEDRIVE_FOLDER_NAME?.trim() ?? "";
export const ENGINEERING_AI_AUDIT_STATUS_FILENAME = "engineering-ai-audit-status.md";
export const ENGINEERING_AI_AUDIT_TIMELINE_FILENAME = "engineering-ai-audit-timeline.md";
/** Legacy single-target alias retained for existing callers. */
export const ENGINEERING_AI_AUDIT_MIRROR_FILENAME = ENGINEERING_AI_AUDIT_STATUS_FILENAME;
export const ENGINEERING_AI_AUDIT_MIRROR_FILENAMES = [
  ENGINEERING_AI_AUDIT_STATUS_FILENAME,
  ENGINEERING_AI_AUDIT_TIMELINE_FILENAME,
] as const;
/** Relative to the canonical machine-local OneDrive account root. */
export const ENGINEERING_AI_AUDIT_MIRROR_RELATIVE_PATH =
  `Desktop/Startup/${ENGINEERING_AI_AUDIT_MIRROR_FILENAME}`;
export const ENGINEERING_AI_AUDIT_TIMELINE_RELATIVE_PATH =
  `Desktop/Startup/${ENGINEERING_AI_AUDIT_TIMELINE_FILENAME}`;
/** The stable logical path shown in audit evidence, independent of machine root. */
export const ENGINEERING_AI_AUDIT_MIRROR_LOGICAL_PATH =
  `${ENGINEERING_AI_ONEDRIVE_FOLDER}/${ENGINEERING_AI_AUDIT_MIRROR_RELATIVE_PATH}`;
export const ENGINEERING_AI_AUDIT_TIMELINE_LOGICAL_PATH =
  `${ENGINEERING_AI_ONEDRIVE_FOLDER}/${ENGINEERING_AI_AUDIT_TIMELINE_RELATIVE_PATH}`;
/** Canonical Engineering AI source ledger for the status mirror. */
export const ENGINEERING_AI_AUDIT_STATUS_LEDGER_RELATIVE_PATH = "docs/audit-loop-state.md";
/** Canonical Engineering AI source ledger for the timeline mirror. */
export const ENGINEERING_AI_AUDIT_TIMELINE_LEDGER_RELATIVE_PATH = "docs/audit-execution-timeline.md";
/** Legacy status-ledger export retained for existing callers. */
export const ENGINEERING_AI_AUDIT_LEDGER_RELATIVE_PATH = ENGINEERING_AI_AUDIT_STATUS_LEDGER_RELATIVE_PATH;
/**
 * Engineering AI workspace id, operator-configured via
 * C2C_ENGINEERING_AI_WORKSPACE_ID. Empty by default: the Engineering AI
 * ledger/mirror integrations fail closed (disabled) on machines that have
 * not opted in, and no machine-local identity ships in the product.
 */
export const ENGINEERING_AI_WORKSPACE_ID = process.env.C2C_ENGINEERING_AI_WORKSPACE_ID?.trim() ?? "";
export const AUDIT_MIRROR_SCOPE = "audit_mirror.write";
export const MAX_AUDIT_MIRROR_BYTES = 256 * 1024;
const MAX_AUDIT_MIRROR_LINES = 2_000;

const STANDARD_ONEDRIVE_ENVIRONMENT_KEYS = ["OneDriveCommercial", "OneDriveConsumer", "OneDrive"] as const;
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{12}$/;

export type AuditMirrorSource = "payload" | "engineering_ai_ledger";

export type AuditMirrorCode =
  | "OK"
  | "SOURCE_REQUIRED"
  | "SOURCE_CONFLICT"
  | "SOURCE_INVALID"
  | "SOURCE_TOO_LARGE"
  | "ENGINEERING_AI_WORKSPACE_NOT_AUTHORIZED"
  | "ENGINEERING_AI_LEDGER_UNAVAILABLE"
  | "ONEDRIVE_ROOT_NOT_CONFIGURED"
  | "ONEDRIVE_ROOT_INVALID"
  | "MIRROR_TARGET_DENIED"
  | "MIRROR_PARENT_NOT_FOUND"
  | "MIRROR_PARENT_INVALID"
  | "MIRROR_REPARSE_POINT"
  | "MIRROR_TARGET_INVALID"
  | "MIRROR_WRITE_FAILED";

export type AuditMirrorFreshness = "fresh" | "stale" | "unknown";

export interface AuditMirrorEvidence {
  success: boolean;
  code: AuditMirrorCode;
  logicalTarget: string;
  resolvedTarget: string | null;
  timestampUtc: string;
  byteCount: number | null;
  sha256: string | null;
  source: AuditMirrorSource;
  targetFilename: typeof ENGINEERING_AI_AUDIT_MIRROR_FILENAMES[number] | null;
  targetSha256: string | null;
  freshness: AuditMirrorFreshness;
  lastSuccessAtUtc: string | null;
  lastSuccessSha256: string | null;
  message?: string;
}

export interface ResolvedAuditMirrorTarget {
  oneDriveRoot: string;
  parent: string;
  target: string;
  filename: typeof ENGINEERING_AI_AUDIT_MIRROR_FILENAMES[number];
  relativePath: string;
  logicalPath: string;
}

export interface ResolveAuditMirrorTargetOptions {
  /** Explicit configured account root. It must already be the named OneDrive folder. */
  oneDriveRoot?: string;
  /** Optional untrusted logical/relative spelling; omitted uses the fixed target. */
  requestedPath?: string;
  /** Test/local seam; production uses process.env. */
  environment?: Readonly<Record<string, string | undefined>>;
  /** Test seam for bounded discovery; production derives local drive roots. */
  discoveryRoots?: readonly string[];
}

export interface WriteEngineeringAiAuditMirrorOptions extends ResolveAuditMirrorTargetOptions {
  /** Immutable C2C state domain for local diagnostics and audit evidence. */
  stateDir?: string;
  source?: AuditMirrorSource;
  content?: string;
  /** Already-authorized Engineering AI workspace used only for the fixed ledger read. */
  ledgerWorkspace?: Workspace;
  /** Workspace namespace in which the local C2C audit record is appended. */
  recordWorkspaceId?: string;
  /** Alias for local callers that use the existing execution-record naming. */
  workspaceId?: string;
  ownerId?: string;
  sessionId?: string;
  taskId?: string;
  iteration?: number;
}

export class AuditMirrorError extends Error {
  constructor(public readonly code: Exclude<AuditMirrorCode, "OK">, message: string) {
    super(message);
    this.name = "AuditMirrorError";
  }
}

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";
interface PersistedMirrorDiagnostic {
  version: 1;
  logicalTarget: string;
  lastSuccessAtUtc: string;
  lastSuccessSha256: string;
  lastSuccessByteCount: number;
}

function diagnosticFile(logicalTarget: string, stateDir?: string): string {
  const key = createHash("sha256").update(logicalTarget).digest("hex");
  return path.join(ensureDir(path.join(getStateDir(stateDir), "audit-mirror")), `${key}.json`);
}

function readDiagnostic(logicalTarget: string, stateDir?: string): PersistedMirrorDiagnostic | null {
  const value = readJsonIfExists<PersistedMirrorDiagnostic>(diagnosticFile(logicalTarget, stateDir));
  if (!value || value.version !== 1 || value.logicalTarget !== logicalTarget) return null;
  if (
    typeof value.lastSuccessAtUtc !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.lastSuccessSha256) ||
    !Number.isSafeInteger(value.lastSuccessByteCount) ||
    value.lastSuccessByteCount < 0
  ) return null;
  return value;
}

function rememberSuccessfulMirror(
  target: ResolvedAuditMirrorTarget,
  bytes: Buffer,
  timestampUtc: string,
  stateDir?: string
): PersistedMirrorDiagnostic {
  const diagnostic: PersistedMirrorDiagnostic = {
    version: 1,
    logicalTarget: target.logicalPath,
    lastSuccessAtUtc: timestampUtc,
    lastSuccessSha256: createHash("sha256").update(bytes).digest("hex"),
    lastSuccessByteCount: bytes.length,
  };
  try {
    writeSecureJson(diagnosticFile(target.logicalPath, stateDir), diagnostic);
  } catch {
    // The target write is already committed. Diagnostics are best effort and
    // must never turn a truthful mirror success into a false write failure.
  }
  return diagnostic;
}

function targetState(
  target: ResolvedAuditMirrorTarget,
  lastSuccess: PersistedMirrorDiagnostic | null
): { freshness: AuditMirrorFreshness; sha256: string | null } {
  try {
    const stat = fs.lstatSync(target.target);
    if (stat.isSymbolicLink() || !stat.isFile()) return { freshness: "unknown", sha256: null };
    const bytes = fs.readFileSync(target.target);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (!lastSuccess) return { freshness: "unknown", sha256 };
    return {
      freshness: sha256 === lastSuccess.lastSuccessSha256 ? "fresh" : "stale",
      sha256,
    };
  } catch {
    return { freshness: "unknown", sha256: null };
  }
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return CASE_INSENSITIVE ? resolved.toLowerCase() : resolved;
}

function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

function within(candidate: string, root: string): boolean {
  const c = pathKey(candidate);
  const r = pathKey(root);
  return c === r || c.startsWith(r + path.sep);
}

function basenameIsOneDriveFolder(candidate: string): boolean {
  return pathKey(path.basename(candidate)) === pathKey(ENGINEERING_AI_ONEDRIVE_FOLDER);
}

function ensureNoReparseComponents(candidate: string): void {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const segments = absolute.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      throw new AuditMirrorError("ONEDRIVE_ROOT_INVALID", "The configured OneDrive root is unavailable");
    }
    if (stat.isSymbolicLink()) {
      throw new AuditMirrorError("ONEDRIVE_ROOT_INVALID", "The configured OneDrive root contains a symlink or reparse point");
    }
    try {
      const canonical = fs.realpathSync.native(current);
      if (!samePath(canonical, current)) {
        throw new AuditMirrorError("ONEDRIVE_ROOT_INVALID", "The configured OneDrive root contains a reparse-point escape");
      }
    } catch (error) {
      if (error instanceof AuditMirrorError) throw error;
      throw new AuditMirrorError("ONEDRIVE_ROOT_INVALID", "The configured OneDrive root cannot be canonicalized");
    }
  }
}

function canonicalExistingDirectory(candidate: string): string {
  if (typeof candidate !== "string" || candidate.trim() === "" || candidate.includes("\0")) {
    throw new AuditMirrorError("ONEDRIVE_ROOT_INVALID", "The configured OneDrive root is invalid");
  }
  if (!path.isAbsolute(candidate)) {
    throw new AuditMirrorError("ONEDRIVE_ROOT_INVALID", "The configured OneDrive root must be absolute");
  }
  ensureNoReparseComponents(candidate);
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(path.resolve(candidate));
  } catch {
    throw new AuditMirrorError("ONEDRIVE_ROOT_INVALID", "The configured OneDrive root is unavailable");
  }
  try {
    if (!fs.statSync(canonical).isDirectory()) {
      throw new AuditMirrorError("ONEDRIVE_ROOT_INVALID", "The configured OneDrive root is not a directory");
    }
  } catch (error) {
    if (error instanceof AuditMirrorError) throw error;
    throw new AuditMirrorError("ONEDRIVE_ROOT_INVALID", "The configured OneDrive root is unavailable");
  }
  if (!basenameIsOneDriveFolder(canonical)) {
    throw new AuditMirrorError("ONEDRIVE_ROOT_INVALID", "The configured root is not the named Engineering AI OneDrive folder");
  }
  return canonical;
}

function directoryChildren(candidate: string): string[] {
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
    return fs.readdirSync(candidate, { withFileTypes: true })
      .map((entry) => path.join(candidate, entry.name))
      // OneDrive account roots can expose a reparse-point flag on Dirent even
      // when lstat/realpath prove that the directory itself does not escape.
      // Re-check the child rather than treating the Dirent hint as authoritative.
      .filter((child) => {
        try {
          const childStat = fs.lstatSync(child);
          return childStat.isDirectory() && !childStat.isSymbolicLink();
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function looksLikeOneDriveContainer(candidate: string): boolean {
  return /onedrive/i.test(path.basename(candidate));
}

function discoveryBases(
  environment: Readonly<Record<string, string | undefined>>,
  configuredRoots?: readonly string[]
): string[] {
  const candidates = [...(configuredRoots ?? [])];
  if (configuredRoots === undefined) {
    candidates.push(path.parse(path.resolve(process.cwd())).root);
    candidates.push(path.parse(path.resolve(os.homedir())).root);
    for (const key of STANDARD_ONEDRIVE_ENVIRONMENT_KEYS) {
      const value = environment[key]?.trim();
      if (!value) continue;
      candidates.push(value, path.parse(path.resolve(value)).root);
    }
    const systemDrive = environment.SystemDrive?.trim();
    if (systemDrive) candidates.push(systemDrive, path.parse(path.resolve(systemDrive)).root);
    if (process.platform === "win32") {
      for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") candidates.push(`${letter}:\\`);
    }
  }

  const seen = new Set<string>();
  return candidates
    .filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== "")
    .map((candidate) => path.resolve(candidate))
    .filter((candidate) => {
      const key = pathKey(candidate);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function discoverNamedOneDriveRoot(
  environment: Readonly<Record<string, string | undefined>>,
  configuredRoots?: readonly string[]
): string | null {
  const seen = new Set<string>();
  const accept = (candidate: string): string | null => {
    if (!basenameIsOneDriveFolder(candidate)) return null;
    try {
      const root = canonicalExistingDirectory(candidate);
      const desktop = checkedDirectory(root, "Desktop");
      checkedDirectory(desktop, "Startup");
      const key = pathKey(root);
      if (seen.has(key)) return null;
      seen.add(key);
      return root;
    } catch {
      return null;
    }
  };

  for (const base of discoveryBases(environment, configuredRoots)) {
    const direct = accept(base);
    if (direct) return direct;
    for (const firstLevel of directoryChildren(base)) {
      const firstMatch = accept(firstLevel);
      if (firstMatch) return firstMatch;
      if (!looksLikeOneDriveContainer(firstLevel)) continue;
      for (const secondLevel of directoryChildren(firstLevel)) {
        const secondMatch = accept(secondLevel);
        if (secondMatch) return secondMatch;
      }
    }
  }
  return null;
}

/**
 * Resolve the named account root using an explicit setting, standard
 * OneDrive variables, or bounded discovery of the exact account folder.
 * There is deliberately no home-directory writable fallback.
 */
export function resolveOneDriveRoot(
  configuredRoot?: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  configuredDiscoveryRoots?: readonly string[]
): string {
  const explicit = [
    configuredRoot,
    environment.ENGINEERING_AI_AUDIT_MIRROR_ROOT,
    environment.C2C_ENGINEERING_AI_AUDIT_MIRROR_ROOT,
    environment.C2C_ONEDRIVE_ROOT,
  ].find((candidate) => candidate?.trim());
  if (explicit) return canonicalExistingDirectory(explicit);

  let sawCandidate = false;
  for (const key of STANDARD_ONEDRIVE_ENVIRONMENT_KEYS) {
    const candidate = environment[key]?.trim();
    if (!candidate) continue;
    sawCandidate = true;
    try {
      return canonicalExistingDirectory(candidate);
    } catch (error) {
      if (!(error instanceof AuditMirrorError)) throw error;
      // A personal or unrelated OneDrive variable may be present beside the
      // named university account. Continue to the next standard variable.
    }
  }
  const discovered = discoverNamedOneDriveRoot(environment, configuredDiscoveryRoots);
  if (discovered) return discovered;
  throw new AuditMirrorError(
    sawCandidate ? "ONEDRIVE_ROOT_INVALID" : "ONEDRIVE_ROOT_NOT_CONFIGURED",
    sawCandidate
      ? "No standard OneDrive environment variable points to the named Engineering AI account"
      : "No explicit or standard OneDrive root is configured"
  );
}

function targetForFilename(filename: typeof ENGINEERING_AI_AUDIT_MIRROR_FILENAMES[number]): {
  filename: typeof ENGINEERING_AI_AUDIT_MIRROR_FILENAMES[number];
  relativePath: string;
  logicalPath: string;
} {
  const relativePath = `Desktop/Startup/${filename}`;
  return {
    filename,
    relativePath,
    logicalPath: `${ENGINEERING_AI_ONEDRIVE_FOLDER}/${relativePath}`,
  };
}

function normalizeRequestedPath(
  requestedPath: string | undefined
): typeof ENGINEERING_AI_AUDIT_MIRROR_FILENAMES[number] {
  const requested = requestedPath ?? ENGINEERING_AI_AUDIT_MIRROR_RELATIVE_PATH;
  if (typeof requested !== "string" || requested.trim() === "" || requested.includes("\0")) {
    throw new AuditMirrorError("MIRROR_TARGET_DENIED", "The audit mirror target spelling is not permitted");
  }
  const normalized = requested.replace(/\\/g, "/");
  if (
    path.isAbsolute(requested) ||
    normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  ) {
    throw new AuditMirrorError("MIRROR_TARGET_DENIED", "The audit mirror target must be the exact fixed logical target");
  }
  for (const filename of ENGINEERING_AI_AUDIT_MIRROR_FILENAMES) {
    const target = targetForFilename(filename);
    if (normalized === target.relativePath || normalized === target.logicalPath) return filename;
  }
  throw new AuditMirrorError("MIRROR_TARGET_DENIED", "The audit mirror target must be one of the two fixed audit files");
}

function checkedDirectory(root: string, segment: string): string {
  const candidate = path.join(root, segment);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(candidate);
  } catch {
    throw new AuditMirrorError("MIRROR_PARENT_NOT_FOUND", "The fixed audit mirror parent directory is unavailable");
  }
  if (stat.isSymbolicLink()) {
    throw new AuditMirrorError("MIRROR_REPARSE_POINT", "The fixed audit mirror parent contains a symlink or reparse point");
  }
  if (!stat.isDirectory()) {
    throw new AuditMirrorError("MIRROR_PARENT_INVALID", "The fixed audit mirror parent is not a directory");
  }
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(candidate);
  } catch {
    throw new AuditMirrorError("MIRROR_REPARSE_POINT", "The fixed audit mirror parent cannot be canonicalized");
  }
  if (!within(canonical, root) || !samePath(canonical, candidate)) {
    throw new AuditMirrorError("MIRROR_REPARSE_POINT", "The fixed audit mirror parent escapes the resolved OneDrive root");
  }
  return canonical;
}

function validateExistingTarget(target: string, root: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new AuditMirrorError("MIRROR_TARGET_INVALID", "The audit mirror target cannot be inspected");
  }
  if (stat.isSymbolicLink()) {
    throw new AuditMirrorError("MIRROR_REPARSE_POINT", "The audit mirror target is a symlink or reparse point");
  }
  if (!stat.isFile()) {
    throw new AuditMirrorError("MIRROR_TARGET_INVALID", "The audit mirror target is not a regular file");
  }
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(target);
  } catch {
    throw new AuditMirrorError("MIRROR_REPARSE_POINT", "The audit mirror target cannot be canonicalized");
  }
  if (!within(canonical, root) || !samePath(canonical, target)) {
    throw new AuditMirrorError("MIRROR_REPARSE_POINT", "The audit mirror target escapes the resolved OneDrive root");
  }
}

/** Resolve and validate the one permitted logical mirror target. */
export function resolveEngineeringAiAuditMirrorTarget(
  options: ResolveAuditMirrorTargetOptions = {}
): ResolvedAuditMirrorTarget {
  const filename = normalizeRequestedPath(options.requestedPath);
  const oneDriveRoot = resolveOneDriveRoot(options.oneDriveRoot, options.environment, options.discoveryRoots);
  const desktop = checkedDirectory(oneDriveRoot, "Desktop");
  const parent = checkedDirectory(desktop, "Startup");
  const target = path.join(parent, filename);
  validateExistingTarget(target, oneDriveRoot);
  if (!within(parent, oneDriveRoot) || path.basename(target) !== filename) {
    throw new AuditMirrorError("MIRROR_TARGET_DENIED", "The audit mirror target is outside the fixed mirror root");
  }
  const logical = targetForFilename(filename);
  return {
    oneDriveRoot,
    parent,
    target,
    filename: logical.filename,
    relativePath: logical.relativePath,
    logicalPath: logical.logicalPath,
  };
}

function requestedTargetMetadata(requestedPath: string | undefined): {
  filename: typeof ENGINEERING_AI_AUDIT_MIRROR_FILENAMES[number] | null;
  logicalPath: string;
} {
  try {
    const filename = normalizeRequestedPath(requestedPath);
    return { filename, logicalPath: targetForFilename(filename).logicalPath };
  } catch {
    return { filename: null, logicalPath: "[unresolved-audit-mirror-target]" };
  }
}

function payloadBytes(content: unknown): Buffer {
  if (typeof content !== "string") {
    throw new AuditMirrorError("SOURCE_REQUIRED", "A bounded text payload is required");
  }
  if (content.includes("\0")) {
    throw new AuditMirrorError("SOURCE_INVALID", "The audit mirror source must be text without null bytes");
  }
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > MAX_AUDIT_MIRROR_BYTES) {
    throw new AuditMirrorError("SOURCE_TOO_LARGE", `The audit mirror source exceeds ${MAX_AUDIT_MIRROR_BYTES} bytes`);
  }
  return bytes;
}

async function resolveSource(
  input: WriteEngineeringAiAuditMirrorOptions,
  target: ResolvedAuditMirrorTarget
): Promise<Buffer> {
  const source = input.source ?? "payload";
  if (source === "payload") {
    if (input.content === undefined) throw new AuditMirrorError("SOURCE_REQUIRED", "A bounded text payload is required");
    return payloadBytes(input.content);
  }
  if (source !== "engineering_ai_ledger") {
    throw new AuditMirrorError("SOURCE_INVALID", "Unsupported audit mirror source");
  }
  if (input.content !== undefined) {
    throw new AuditMirrorError("SOURCE_CONFLICT", "A ledger source cannot be combined with a text payload");
  }
  const ledgerWorkspace = input.ledgerWorkspace;
  if (!ledgerWorkspace || ledgerWorkspace.id !== ENGINEERING_AI_WORKSPACE_ID) {
    throw new AuditMirrorError(
      "ENGINEERING_AI_WORKSPACE_NOT_AUTHORIZED",
      "The canonical ledger requires the authorized Engineering AI workspace"
    );
  }
  let ledger: Awaited<ReturnType<Workspace["readFile"]>>;
  try {
    const ledgerPath = target.filename === ENGINEERING_AI_AUDIT_TIMELINE_FILENAME
      ? ENGINEERING_AI_AUDIT_TIMELINE_LEDGER_RELATIVE_PATH
      : ENGINEERING_AI_AUDIT_LEDGER_RELATIVE_PATH;
    // A real Workspace exposes the same canonical path resolver used by the
    // read tool. Use it to preserve the ledger's original line endings and
    // final newline, so the OneDrive file is an exact bounded mirror. The
    // readFile fallback keeps this module's narrow test seam compatible with
    // lightweight authorized workspace doubles.
    const workspaceWithResolver = ledgerWorkspace as Workspace & {
      resolve?: (requested: string) => { abs: string; rel: string };
    };
    if (typeof workspaceWithResolver.resolve === "function") {
      const resolved = workspaceWithResolver.resolve(ledgerPath);
      const stat = fs.statSync(resolved.abs);
      if (!stat.isFile()) throw new AuditMirrorError("ENGINEERING_AI_LEDGER_UNAVAILABLE", "The canonical Engineering AI audit ledger is unavailable");
      if (stat.size > MAX_AUDIT_MIRROR_BYTES) {
        throw new AuditMirrorError("SOURCE_TOO_LARGE", `The canonical audit ledger exceeds ${MAX_AUDIT_MIRROR_BYTES} bytes`);
      }
      const bytes = fs.readFileSync(resolved.abs);
      if (bytes.length > MAX_AUDIT_MIRROR_BYTES) {
        throw new AuditMirrorError("SOURCE_TOO_LARGE", `The canonical audit ledger exceeds ${MAX_AUDIT_MIRROR_BYTES} bytes`);
      }
      const lineCount = bytes.length === 0
        ? 0
        : bytes.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0) + (bytes.at(-1) === 0x0a ? 0 : 1);
      if (lineCount > MAX_AUDIT_MIRROR_LINES) {
        throw new AuditMirrorError("SOURCE_TOO_LARGE", `The canonical audit ledger exceeds ${MAX_AUDIT_MIRROR_LINES} lines`);
      }
      return payloadBytes(bytes.toString("utf8"));
    }
    ledger = await ledgerWorkspace.readFile(ledgerPath, {
      maxLines: MAX_AUDIT_MIRROR_LINES,
      maxBytes: MAX_AUDIT_MIRROR_BYTES,
    });
  } catch (error) {
    if (error instanceof AuditMirrorError) throw error;
    throw new AuditMirrorError("ENGINEERING_AI_LEDGER_UNAVAILABLE", "The canonical Engineering AI audit ledger is unavailable");
  }
  if (ledger.truncated) {
    throw new AuditMirrorError("SOURCE_TOO_LARGE", `The canonical audit ledger exceeds ${MAX_AUDIT_MIRROR_BYTES} bytes`);
  }
  return payloadBytes(ledger.content);
}

function writeAtomically(target: ResolvedAuditMirrorTarget, bytes: Buffer): void {
  const temporary = path.join(
    target.parent,
    `.${target.filename}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeSync(fd, bytes, 0, bytes.length, 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    const temporaryStat = fs.lstatSync(temporary);
    if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink()) {
      throw new AuditMirrorError("MIRROR_REPARSE_POINT", "The temporary audit mirror file is not a regular file");
    }
    const temporaryCanonical = fs.realpathSync.native(temporary);
    if (!within(temporaryCanonical, target.parent) || !samePath(path.dirname(temporaryCanonical), target.parent)) {
      throw new AuditMirrorError("MIRROR_REPARSE_POINT", "The temporary audit mirror file escaped its parent");
    }
    // Re-check the destination immediately before the commit point so a
    // target changed into a symlink/reparse point during source resolution is
    // never replaced.
    validateExistingTarget(target.target, target.oneDriveRoot);
    // Rename is the commit point. Do not remove/replace the destination first.
    fs.renameSync(temporary, target.target);
    try {
      fs.chmodSync(target.target, 0o600);
    } catch {
      // File modes are best effort on platforms without POSIX permissions.
    }
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort cleanup after a failed write
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The successful rename already removed the temporary name.
    }
  }
}

function appendMirrorRecord(
  input: WriteEngineeringAiAuditMirrorOptions,
  evidence: AuditMirrorEvidence
): void {
  // Keep the record path inside the existing state namespace even for local
  // callers of this module; MCP callers already receive a registry-validated id.
  const workspaceId = input.recordWorkspaceId ?? input.workspaceId;
  if (!workspaceId || !WORKSPACE_ID_PATTERN.test(workspaceId)) return;
  appendExecutionRecord(workspaceId, {
    taskId: input.taskId ?? `c2c_audit_mirror_${randomBytes(8).toString("hex")}`,
    workspaceId,
    ownerId: input.ownerId,
    sessionId: input.sessionId,
    network: false,
    iteration: Math.max(1, Math.floor(input.iteration ?? 1)),
    changedFiles: [evidence.logicalTarget],
    tests: null,
    exitStatus: evidence.success ? "ok" : "failed",
    timestamp: evidence.timestampUtc,
    notes: `audit_mirror source=${evidence.source}; code=${evidence.code}; bytes=${evidence.byteCount ?? 0}`,
    restartRequired: false,
    auditMirror: {
      logicalTarget: evidence.logicalTarget,
      resolvedTarget: evidence.resolvedTarget,
      timestampUtc: evidence.timestampUtc,
      byteCount: evidence.byteCount,
      sha256: evidence.sha256,
      success: evidence.success,
      code: evidence.code,
      source: evidence.source,
      targetFilename: evidence.targetFilename ?? undefined,
      targetSha256: evidence.targetSha256,
      freshness: evidence.freshness,
      lastSuccessAtUtc: evidence.lastSuccessAtUtc,
      lastSuccessSha256: evidence.lastSuccessSha256,
    },
  }, input.stateDir);
}

/**
 * Write only the fixed Engineering AI audit mirror. Every attempted write
 * yields evidence and, when a workspace namespace is supplied, an execution
 * record. Policy failures are returned as evidence rather than retried.
 */
export async function writeEngineeringAiAuditMirror(
  input: WriteEngineeringAiAuditMirrorOptions
): Promise<AuditMirrorEvidence> {
  const timestampUtc = new Date().toISOString();
  const source: AuditMirrorSource = input.source === "engineering_ai_ledger" ? "engineering_ai_ledger" : "payload";
  const requestedTarget = requestedTargetMetadata(input.requestedPath);
  let resolvedTarget: ResolvedAuditMirrorTarget | null = null;
  let lastSuccess: PersistedMirrorDiagnostic | null = null;
  let evidence: AuditMirrorEvidence;
  try {
    resolvedTarget = resolveEngineeringAiAuditMirrorTarget(input);
    lastSuccess = readDiagnostic(resolvedTarget.logicalPath, input.stateDir);
    const bytes = await resolveSource(input, resolvedTarget);
    writeAtomically(resolvedTarget, bytes);
    lastSuccess = rememberSuccessfulMirror(resolvedTarget, bytes, timestampUtc, input.stateDir);
    evidence = {
      success: true,
      code: "OK",
      logicalTarget: resolvedTarget.logicalPath,
      resolvedTarget: resolvedTarget.target,
      timestampUtc,
      byteCount: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      source,
      targetFilename: resolvedTarget.filename,
      targetSha256: createHash("sha256").update(bytes).digest("hex"),
      freshness: "fresh",
      lastSuccessAtUtc: lastSuccess.lastSuccessAtUtc,
      lastSuccessSha256: lastSuccess.lastSuccessSha256,
    };
  } catch (error) {
    const code: AuditMirrorCode = error instanceof AuditMirrorError ? error.code : "MIRROR_WRITE_FAILED";
    if (resolvedTarget) {
      lastSuccess ??= readDiagnostic(resolvedTarget.logicalPath, input.stateDir);
    }
    const state = resolvedTarget ? targetState(resolvedTarget, lastSuccess) : { freshness: "unknown" as const, sha256: null };
    evidence = {
      success: false,
      code,
      logicalTarget: resolvedTarget?.logicalPath ?? requestedTarget.logicalPath,
      resolvedTarget: resolvedTarget?.target ?? null,
      timestampUtc,
      byteCount: null,
      sha256: null,
      source,
      targetFilename: resolvedTarget?.filename ?? requestedTarget.filename,
      targetSha256: state.sha256,
      freshness: state.freshness,
      lastSuccessAtUtc: lastSuccess?.lastSuccessAtUtc ?? null,
      lastSuccessSha256: lastSuccess?.lastSuccessSha256 ?? null,
      message: error instanceof AuditMirrorError ? error.message : "The audit mirror write failed",
    };
  }

  try {
    appendMirrorRecord(input, evidence);
  } catch {
    // The mirror result remains truthful if the local audit store is
    // temporarily unavailable; the write itself is never repeated.
  }
  return evidence;
}

// Short aliases keep the narrow mechanism convenient for local callers while
// retaining one policy implementation and one public MCP tool.
export const resolveAuditMirrorTarget = resolveEngineeringAiAuditMirrorTarget;
export const writeAuditMirror = writeEngineeringAiAuditMirror;
