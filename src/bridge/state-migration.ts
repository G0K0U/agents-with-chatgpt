import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  getDefaultStateDir,
  packagedStateDirCandidates,
  readJsonIfExists,
  writeSecureJson,
} from "../config/paths.js";
import {
  reconcileAuthState,
  type AuthStateReconciliation,
} from "../auth/store.js";
import { readAuthStatePointer } from "./state-owner.js";

const TASK_ID_PATTERN = /^c2c_[0-9a-f]{8,32}$/i;
const SESSION_ID_PATTERN = /^c2cs_[0-9a-f]{16,32}$/i;
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{12}$/i;
const AUTH_GENERATION_PATTERN = /^bridge\.([0-9a-f-]{36})\.json$/i;
const STATE_SPLIT_MARKER = "state-domain-split.json";

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" || process.platform === "darwin"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function within(candidate: string, root: string): boolean {
  const c = path.resolve(candidate);
  const r = path.resolve(root);
  const relative = path.relative(r, c);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function regularDirectory(dir: string): boolean {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    return samePath(fs.realpathSync.native(dir), dir);
  } catch {
    return false;
  }
}

function sameDirectoryIdentity(left: string, right: string): boolean {
  if (!regularDirectoryEntry(left) || !regularDirectoryEntry(right)) return false;
  try {
    const a = fs.statSync(left);
    const b = fs.statSync(right);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

function regularDirectoryEntry(dir: string): boolean {
  try {
    const stat = fs.lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function treeContentFingerprint(root: string): string {
  const hash = createHash("sha256");
  for (const item of walkRegularFiles(root)) {
    hash.update(item.relative.replace(/\\/g, "/"));
    hash.update(String.fromCharCode(0));
    try {
      const content = fs.readFileSync(item.file);
      hash.update(String(content.byteLength));
      hash.update(String.fromCharCode(0));
      hash.update(content);
    } catch {
      hash.update("unreadable");
    }
    hash.update(String.fromCharCode(10));
  }
  return hash.digest("hex");
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function safeRelativeFile(root: string, candidate: string): string | null {
  const resolved = path.resolve(candidate);
  if (!within(resolved, root)) return null;
  const relative = path.relative(path.resolve(root), resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative;
}

function walkRegularFiles(root: string): Array<{ file: string; relative: string; stat: fs.Stats }> {
  if (!regularDirectoryEntry(root)) return [];
  const result: Array<{ file: string; relative: string; stat: fs.Stats }> = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(file);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (regularDirectoryEntry(file)) visit(file);
        continue;
      }
      if (!stat.isFile()) continue;
      const relative = safeRelativeFile(root, file);
      if (relative) result.push({ file, relative, stat });
    }
  };
  visit(root);
  return result.sort((left, right) => left.relative.localeCompare(right.relative));
}

function fileFingerprint(files: ReturnType<typeof walkRegularFiles>): string {
  const hash = createHash("sha256");
  for (const item of files) {
    hash.update(item.relative.replace(/\\/g, "/"));
    hash.update("\0");
    hash.update(String(item.stat.size));
    hash.update("\0");
    hash.update(String(Math.trunc(item.stat.mtimeMs)));
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 12).toUpperCase();
}

function jsonObject(file: string): Record<string, unknown> | null {
  const value = readJsonIfExists<unknown>(file);
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function authFiles(stateDir: string): string[] {
  const dir = path.join(stateDir, "auth");
  if (!regularDirectoryEntry(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "bridge-active.json")
    .map((entry) => path.join(dir, entry.name))
    .filter((file) => {
      const stat = (() => { try { return fs.lstatSync(file); } catch { return null; } })();
      return Boolean(stat?.isFile() && !stat.isSymbolicLink());
    })
    .sort();
}

export interface StateTreeInventory {
  stateDir: string;
  exists: boolean;
  topLevelEntries: number;
  fingerprint: string | null;
  auth: {
    files: number;
    clients: number;
    tokens: number;
    generationFiles: number;
    activePointer: boolean;
    generationPrefixes: string[];
  };
  runtime: {
    files: number;
    ownerPid: number | null;
    ownerGenerationPrefix: string | null;
    ownerStateDir: string | null;
    activePointer: boolean;
    workspaceIds: string[];
  };
  tasks: {
    files: number;
    byStatus: Record<string, number>;
    workspaceIds: string[];
  };
  sessions: number;
  executionFiles: number;
  executionLines: number;
  queueFiles: number;
  outputFiles: number;
  tunnelFiles: number;
}

function generationPrefix(value: unknown): string | null {
  return typeof value === "string" && value.length >= 8 ? value.slice(0, 8) : null;
}

/** Return counts, timestamps-derived fingerprint, and identities only. */
export function inspectStateTree(stateDir: string): StateTreeInventory {
  const resolved = path.resolve(stateDir);
  const files = walkRegularFiles(resolved);
  const exists = regularDirectoryEntry(resolved);
  let topLevelEntries = 0;
  try { topLevelEntries = fs.readdirSync(resolved).length; } catch { /* absent */ }

  const clientIds = new Set<string>();
  const tokenHashes = new Set<string>();
  let generationFiles = 0;
  const generationPrefixes: string[] = [];
  for (const file of authFiles(resolved)) {
    const match = path.basename(file).match(AUTH_GENERATION_PATTERN);
    if (match) {
      generationFiles += 1;
      generationPrefixes.push(match[1].slice(0, 8));
    }
    const value = jsonObject(file);
    for (const client of jsonArray(value?.clients)) {
      if (client && typeof client === "object" && !Array.isArray(client) && typeof (client as Record<string, unknown>).clientId === "string") {
        clientIds.add((client as Record<string, unknown>).clientId as string);
      }
    }
    for (const token of jsonArray(value?.tokens)) {
      if (token && typeof token === "object" && !Array.isArray(token) && typeof (token as Record<string, unknown>).hash === "string") {
        tokenHashes.add((token as Record<string, unknown>).hash as string);
      }
    }
  }

  const runtimeDir = path.join(resolved, "runtime");
  let ownerPid: number | null = null;
  let ownerGenerationPrefix: string | null = null;
  let ownerStateDir: string | null = null;
  const runtimeWorkspaceIds = new Set<string>();
  let runtimeFiles = 0;
  for (const item of walkRegularFiles(runtimeDir)) {
    if (!item.relative.endsWith(".json")) continue;
    runtimeFiles += 1;
    const value = jsonObject(item.file);
    if (item.relative === "state-domain-owner.json") {
      ownerPid = typeof value?.pid === "number" && Number.isInteger(value.pid) ? value.pid : null;
      ownerGenerationPrefix = generationPrefix(value?.generation);
      ownerStateDir = typeof value?.stateDir === "string" ? value.stateDir : null;
    } else if (value?.workspaceId && typeof value.workspaceId === "string") {
      runtimeWorkspaceIds.add(value.workspaceId);
    }
  }

  const taskStatus = new Map<string, number>();
  const taskWorkspaceIds = new Set<string>();
  let taskFiles = 0;
  for (const item of walkRegularFiles(path.join(resolved, "tasks"))) {
    if (!item.relative.endsWith(".json")) continue;
    const taskId = path.basename(item.relative, ".json");
    if (!TASK_ID_PATTERN.test(taskId)) continue;
    const value = jsonObject(item.file);
    if (!value || typeof value.workspaceId !== "string" || typeof value.status !== "string") continue;
    taskFiles += 1;
    taskWorkspaceIds.add(value.workspaceId);
    taskStatus.set(value.status, (taskStatus.get(value.status) ?? 0) + 1);
  }

  const sessionValue = jsonObject(path.join(resolved, "sessions", "registry.json"));
  const sessions = jsonArray(sessionValue?.sessions).filter((value) => Boolean(value && typeof value === "object" && !Array.isArray(value))).length;
  const executionFiles = files.filter((item) => item.relative.replace(/\\/g, "/").startsWith("executions/") && item.relative.endsWith(".jsonl"));
  let executionLines = 0;
  for (const item of executionFiles) {
    try { executionLines += fs.readFileSync(item.file, "utf8").split(/\r?\n/).filter(Boolean).length; } catch { /* best effort */ }
  }
  const outputFiles = files.filter((item) => item.relative.replace(/\\/g, "/").startsWith("execution-outputs/")).length;
  const queueFiles = files.filter((item) => item.relative.replace(/\\/g, "/").startsWith("queues/") && item.relative.endsWith(".json")).length;
  const tunnelFiles = files.filter((item) => item.relative.replace(/\\/g, "/").startsWith("tunnels/") && item.relative.endsWith(".json")).length;

  return {
    stateDir: resolved,
    exists,
    topLevelEntries,
    fingerprint: exists ? fileFingerprint(files) : null,
    auth: {
      files: authFiles(resolved).length,
      clients: clientIds.size,
      tokens: tokenHashes.size,
      generationFiles,
      activePointer: fs.existsSync(path.join(resolved, "auth", "bridge-active.json")),
      generationPrefixes: [...new Set(generationPrefixes)].sort(),
    },
    runtime: {
      files: runtimeFiles,
      ownerPid,
      ownerGenerationPrefix,
      ownerStateDir,
      activePointer: fs.existsSync(path.join(resolved, "auth", "bridge-active.json")),
      workspaceIds: [...runtimeWorkspaceIds].sort(),
    },
    tasks: {
      files: taskFiles,
      byStatus: Object.fromEntries([...taskStatus.entries()].sort(([a], [b]) => a.localeCompare(b))),
      workspaceIds: [...taskWorkspaceIds].sort(),
    },
    sessions,
    executionFiles: executionFiles.length,
    executionLines,
    queueFiles,
    outputFiles,
    tunnelFiles,
  };
}

export interface StateDomainMigrationReport {
  canonical: StateTreeInventory;
  sources: StateTreeInventory[];
  auth: AuthStateReconciliation | null;
  stateDomainSplit: {
    performed: boolean;
    sourceBackup: string | null;
  };
  copiedFiles: number;
  copiedBytes: number;
  mergedExecutionLines: number;
  mergedSessions: number;
  taskConflicts: number;
  fileConflicts: number;
  skippedUnsafe: number;
  sourceTreesPreserved: boolean;
}

interface StateDomainSplitResult {
  sources: string[];
  sourceBackup: string | null;
  sourceBackupContentFingerprint: string | null;
  performed: boolean;
}

function hasCompletedStateSplit(canonical: string): boolean {
  const marker = jsonObject(path.join(canonical, STATE_SPLIT_MARKER));
  return marker?.schema === 1 &&
    typeof marker.canonicalStateDir === "string" &&
    samePath(marker.canonicalStateDir, canonical) &&
    typeof marker.sourceBackup === "string" &&
    regularDirectoryEntry(marker.sourceBackup) &&
    !sameDirectoryIdentity(canonical, marker.sourceBackup);
}

function stateSplitBackups(canonical: string): string[] {
  const parent = path.dirname(canonical);
  const prefix = `${path.basename(canonical)}.state-split-source-`;
  try {
    return fs.readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => path.join(parent, entry.name))
      .filter(regularDirectoryEntry)
      .sort((left, right) => {
        try { return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs; } catch { return 0; }
      });
  } catch {
    return [];
  }
}

/**
 * Break the Windows package/unpackaged directory alias before merging state.
 *
 * On affected Windows installations the two path spellings can resolve to
 * one directory identity even though they have different logical names.  A
 * rename exposes the normal Local\codex-with-chatgpt overlay; the original
 * tree is retained under a unique sibling backup and copied back to each
 * packaged source path.  Nothing is deleted and the source is fingerprinted
 * before and after the operation.
 */
function splitAliasedStateDomain(
  canonical: string,
  sources: readonly string[],
): StateDomainSplitResult {
  const sharedSources = sources.filter((source) => sameDirectoryIdentity(canonical, source));
  if (sharedSources.length === 0) {
    return { sources: [...sources], sourceBackup: null, sourceBackupContentFingerprint: null, performed: false };
  }
  if (!samePath(canonical, getDefaultStateDir())) {
    throw new Error("Explicit C2C state directory aliases the packaged state domain; refusing to move it");
  }

  for (const dir of [canonical, ...sharedSources]) {
    const owner = inspectStateTree(dir).runtime.ownerPid;
    if (owner !== null && owner !== process.pid && processIsAlive(owner)) {
      throw new Error("Cannot split the C2C state domain while a bridge owner is alive");
    }
  }

  const sourceBackup = `${canonical}.state-split-source-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  if (fs.existsSync(sourceBackup)) {
    throw new Error("Refusing to overwrite an existing C2C state split backup");
  }
  const sourceContent = treeContentFingerprint(sharedSources[0]!);
  fs.renameSync(canonical, sourceBackup);

  // A Windows package virtualization layer may reveal an existing normal
  // LocalAppData overlay after the alias is moved. If it does not, create the
  // new canonical root. In either case the old source remains in sourceBackup.
  if (!fs.existsSync(canonical)) fs.mkdirSync(canonical, { recursive: true, mode: 0o700 });
  if (!regularDirectory(canonical) || sameDirectoryIdentity(canonical, sourceBackup)) {
    throw new Error("C2C state-domain split did not produce an independent canonical root");
  }

  // The packaged LocalCache path is owned by the packaged process. A normal
  // unelevated Node process can map a newly-created entry at that spelling
  // back to the canonical overlay, so do not recreate it here. The complete
  // original source tree remains at sourceBackup and is the migration source.
  const independentSources = sharedSources.filter((source) =>
    regularDirectory(source) &&
    !sameDirectoryIdentity(canonical, source) &&
    !sameDirectoryIdentity(source, sourceBackup) &&
    treeContentFingerprint(source) === sourceContent
  );
  writeSecureJson(path.join(canonical, STATE_SPLIT_MARKER), {
    schema: 1,
    canonicalStateDir: canonical,
    sourceBackup,
    createdAt: new Date().toISOString(),
  });
  return {
    sources: [...new Set([...sources.filter((source) => !sharedSources.includes(source)), ...independentSources, sourceBackup])],
    sourceBackup,
    sourceBackupContentFingerprint: sourceContent,
    performed: true,
  };
}

function ensureChildDirectory(root: string, relative: string): string | null {
  const target = path.resolve(root, relative);
  if (!within(target, root)) return null;
  try {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  return regularDirectory(target) ? target : null;
}

function copyIfMissing(
  source: string,
  target: string,
  sourceRoot: string,
  targetRoot: string,
  report: { copiedFiles: number; copiedBytes: number; fileConflicts: number; skippedUnsafe: number }
): void {
  const sourceRelative = safeRelativeFile(sourceRoot, source);
  if (!sourceRelative) { report.skippedUnsafe += 1; return; }
  let sourceStat: fs.Stats;
  try {
    sourceStat = fs.lstatSync(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) { report.skippedUnsafe += 1; return; }
  } catch { report.skippedUnsafe += 1; return; }
  try {
    const targetStat = fs.lstatSync(target);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) { report.fileConflicts += 1; return; }
    report.fileConflicts += 1;
    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
      report.skippedUnsafe += 1;
      return;
    }
  }
  const parent = path.dirname(target);
  if (!ensureChildDirectory(targetRoot, path.relative(targetRoot, parent))) { report.skippedUnsafe += 1; return; }
  try {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    try { fs.chmodSync(target, 0o600); } catch { /* best effort */ }
    report.copiedFiles += 1;
    report.copiedBytes += sourceStat.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") report.fileConflicts += 1;
    else report.skippedUnsafe += 1;
  }
}

function mergeSessions(
  targetFile: string,
  sourceFiles: readonly string[],
  report: { mergedSessions: number; fileConflicts: number }
): void {
  const target = jsonObject(targetFile);
  if (fs.existsSync(targetFile) && (!target || (target.version !== undefined && target.version !== 1) || !Array.isArray(target.sessions))) {
    report.fileConflicts += 1;
    return;
  }
  const map = new Map<string, Record<string, unknown>>();
  for (const value of jsonArray(target?.sessions)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const row = value as Record<string, unknown>;
      if (typeof row.id === "string" && SESSION_ID_PATTERN.test(row.id)) map.set(row.id, row);
    }
  }
  for (const file of sourceFiles) {
    const data = jsonObject(file);
    for (const value of jsonArray(data?.sessions)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      if (typeof row.id !== "string" || !SESSION_ID_PATTERN.test(row.id)) continue;
      const existing = map.get(row.id);
      if (!existing) {
        map.set(row.id, row);
        report.mergedSessions += 1;
        continue;
      }
      const currentAt = typeof existing.updatedAt === "string" ? Date.parse(existing.updatedAt) : NaN;
      const sourceAt = typeof row.updatedAt === "string" ? Date.parse(row.updatedAt) : NaN;
      if (Number.isFinite(sourceAt) && (!Number.isFinite(currentAt) || sourceAt > currentAt)) map.set(row.id, row);
      if (JSON.stringify(existing) !== JSON.stringify(row)) report.fileConflicts += 1;
    }
  }
  const next = { version: 1, sessions: [...map.values()] };
  if (JSON.stringify(target ?? { version: 1, sessions: [] }) !== JSON.stringify(next)) writeSecureJson(targetFile, next);
}

function mergeTaskFiles(
  canonical: string,
  sources: readonly string[],
  report: { copiedFiles: number; copiedBytes: number; taskConflicts: number; fileConflicts: number; skippedUnsafe: number }
): void {
  for (const sourceRoot of sources) {
    for (const item of walkRegularFiles(path.join(sourceRoot, "tasks"))) {
      const normalized = item.relative.replace(/\\/g, "/");
      const parts = normalized.split("/");
      if (parts.length !== 2 || !TASK_ID_PATTERN.test(parts[1]?.replace(/\.json$/i, "") ?? "") || !WORKSPACE_ID_PATTERN.test(parts[0] ?? "")) continue;
      const target = path.join(canonical, "tasks", ...parts);
      if (fs.existsSync(target)) {
        report.taskConflicts += 1;
        continue;
      }
      copyIfMissing(item.file, target, sourceRoot, canonical, report);
    }
  }
}

function mergeExecutionFiles(
  canonical: string,
  sources: readonly string[],
  report: { mergedExecutionLines: number; skippedUnsafe: number }
): void {
  for (const sourceRoot of sources) {
    for (const item of walkRegularFiles(path.join(sourceRoot, "executions"))) {
      if (!item.relative.endsWith(".jsonl") || !WORKSPACE_ID_PATTERN.test(path.basename(item.relative, ".jsonl"))) continue;
      const target = path.join(canonical, "executions", item.relative);
      const targetParent = ensureChildDirectory(canonical, path.relative(canonical, path.dirname(target)));
      if (!targetParent) { report.skippedUnsafe += 1; continue; }
      let sourceLines: string[];
      try { sourceLines = fs.readFileSync(item.file, "utf8").split(/\r?\n/).filter(Boolean); } catch { report.skippedUnsafe += 1; continue; }
      let existing = new Set<string>();
      try {
        existing = new Set(fs.readFileSync(target, "utf8").split(/\r?\n/).filter(Boolean).map((line) => createHash("sha256").update(line).digest("hex")));
      } catch (error) {
        if (!((error as NodeJS.ErrnoException).code === "ENOENT")) { report.skippedUnsafe += 1; continue; }
      }
      const additions = sourceLines.filter((line) => {
        const hash = createHash("sha256").update(line).digest("hex");
        if (existing.has(hash)) return false;
        existing.add(hash);
        return true;
      });
      if (additions.length === 0) continue;
      try {
        const fd = fs.openSync(target, "a", 0o600);
        try {
          fs.writeSync(fd, additions.join("\n") + "\n", null, "utf8");
          try { fs.fsyncSync(fd); } catch { /* best effort */ }
        } finally { fs.closeSync(fd); }
        report.mergedExecutionLines += additions.length;
      } catch { report.skippedUnsafe += 1; }
    }
  }
}

function copyKnownStateFiles(
  canonical: string,
  sources: readonly string[],
  report: { copiedFiles: number; copiedBytes: number; fileConflicts: number; skippedUnsafe: number }
): void {
  const roots = ["workspaces.json", "prefs.json"];
  const directories = ["endpoints", "queues", "tunnels", "audit-mirror"];
  for (const sourceRoot of sources) {
    for (const relative of roots) {
      const source = path.join(sourceRoot, relative);
      if (fs.existsSync(source)) copyIfMissing(source, path.join(canonical, relative), sourceRoot, canonical, report);
    }
    for (const directory of directories) {
      for (const item of walkRegularFiles(path.join(sourceRoot, directory))) {
        if (directory === "tunnels" && path.basename(item.relative).toLowerCase() === "runtime.json") continue;
        copyIfMissing(item.file, path.join(canonical, directory, item.relative), sourceRoot, canonical, report);
      }
    }
    // Output bodies/indexes are evidence. Copy only files absent in the
    // canonical namespace; an existing canonical item is never overwritten.
    for (const item of walkRegularFiles(path.join(sourceRoot, "execution-outputs"))) {
      copyIfMissing(item.file, path.join(canonical, "execution-outputs", item.relative), sourceRoot, canonical, report);
    }
  }
}

/**
 * Reconcile packaged state into the canonical state domain without deleting
 * or continuously consulting the source trees. Runtime ownership, active
 * pointers, slot locks, and tunnel process runtime files are intentionally
 * excluded from copying.
 */
export function reconcileStateDomains(options: {
  canonicalStateDir?: string;
  sourceStateDirs?: readonly string[];
  authorizedWorkspaceIds?: readonly string[];
} = {}): StateDomainMigrationReport {
  const canonical = path.resolve(options.canonicalStateDir ?? getDefaultStateDir());
  if (!regularDirectory(canonical)) fs.mkdirSync(canonical, { recursive: true, mode: 0o700 });
  if (!regularDirectory(canonical)) throw new Error("Canonical C2C state directory is not a regular directory");
  const discoveredSources = [...new Set((options.sourceStateDirs ?? packagedStateDirCandidates()).map((dir) => path.resolve(dir)))]
    .filter((dir) => !samePath(dir, canonical) && regularDirectory(dir));
  const backupSources = stateSplitBackups(canonical);
  const splitComplete = hasCompletedStateSplit(canonical);
  const sources = [...new Set([
    ...discoveredSources.filter((dir) => !splitComplete || !sameDirectoryIdentity(canonical, dir)),
    ...(backupSources[0] ? [backupSources[0]] : []),
  ])];
  const sourceContentFingerprints = new Map(sources.map((dir) => [dir, treeContentFingerprint(dir)] as const));
  const split = splitAliasedStateDomain(canonical, sources);
  const effectiveSources = split.sources;
  const sourceInventories = effectiveSources.map(inspectStateTree);
  const counters = {
    copiedFiles: 0,
    copiedBytes: 0,
    mergedExecutionLines: 0,
    mergedSessions: 0,
    taskConflicts: 0,
    fileConflicts: 0,
    skippedUnsafe: 0,
  };
  const authSourceFiles = [
    ...authFiles(canonical),
    ...effectiveSources.flatMap((dir) => authFiles(dir)),
  ];
  let auth: AuthStateReconciliation | null = null;
  const canonicalAuth = path.join(canonical, "auth", "bridge.json");
  if (authSourceFiles.length > 0 || fs.existsSync(canonicalAuth)) {
    auth = reconcileAuthState(canonicalAuth, authSourceFiles, options.authorizedWorkspaceIds ?? []);
    try {
      const pointer = readAuthStatePointer(canonical);
      if (pointer && within(pointer.authFile, path.join(canonical, "auth"))) {
        reconcileAuthState(pointer.authFile, [canonicalAuth, ...authSourceFiles], options.authorizedWorkspaceIds ?? []);
      }
    } catch {
      // An invalid pointer is never rewritten during migration. The owner
      // acquisition path will fail closed and report the exact blocker.
      counters.skippedUnsafe += 1;
    }
  }

  const sessionSources = effectiveSources
    .map((dir) => path.join(dir, "sessions", "registry.json"))
    .filter((file) => fs.existsSync(file));
  const canonicalSession = path.join(canonical, "sessions", "registry.json");
  if (sessionSources.length > 0 || fs.existsSync(canonicalSession)) {
    mergeSessions(canonicalSession, sessionSources, counters);
  }
  mergeTaskFiles(canonical, effectiveSources, counters);
  mergeExecutionFiles(canonical, effectiveSources, counters);
  copyKnownStateFiles(canonical, effectiveSources, counters);

  const sourceTreesPreserved = effectiveSources.every((dir) => {
    const before = sourceContentFingerprints.get(dir) ?? (
      dir === split.sourceBackup ? split.sourceBackupContentFingerprint : undefined
    );
    return before !== undefined && treeContentFingerprint(dir) === before;
  });
  if (!sourceTreesPreserved) {
    throw new Error("C2C state migration changed a packaged source tree; refusing to claim preservation");
  }

  return {
    canonical: inspectStateTree(canonical),
    sources: sourceInventories,
    auth,
    stateDomainSplit: {
      performed: split.performed,
      sourceBackup: split.sourceBackup,
    },
    ...counters,
    sourceTreesPreserved,
  };
}
