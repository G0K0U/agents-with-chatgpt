import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomBytes } from "node:crypto";

export interface StateDirContext {
  readonly stateDir: string;
}

let processStateDir: string | null = null;

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" || process.platform === "darwin"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/**
 * Resolve the user's real Windows Local AppData directory.
 *
 * A packaged Microsoft Store parent can expose a virtualized LOCALAPPDATA
 * ending in `Packages\\<package>\\LocalCache\\Local`. That directory is an
 * app sandbox, not the user's C2C installation state domain. Keep honoring a
 * genuinely custom LOCALAPPDATA, but collapse this one virtualization shape
 * back to the non-packaged user profile path.
 */
export function resolveWindowsLocalAppData(
  localAppData: string | undefined = process.env.LOCALAPPDATA,
  home = os.homedir(),
): string {
  const homeLocalAppData = path.win32.join(home, "AppData", "Local");
  const supplied = localAppData?.trim();
  if (!supplied) return homeLocalAppData;

  const candidate = path.win32.resolve(supplied);
  const relative = path.win32.relative(homeLocalAppData, candidate);
  const parts = relative.split(path.win32.sep).filter(Boolean);
  const isPackagedVirtualized =
    parts.length >= 4 &&
    parts[0]?.toLowerCase() === "packages" &&
    parts[2]?.toLowerCase() === "localcache" &&
    parts[3]?.toLowerCase() === "local";
  return isPackagedVirtualized ? homeLocalAppData : candidate;
}

/** Resolve the OS default without consulting C2C_STATE_DIR. */
export function getDefaultStateDir(): string {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "codex-with-chatgpt");
    case "win32":
      return path.join(resolveWindowsLocalAppData(process.env.LOCALAPPDATA, home), "codex-with-chatgpt");
    default: {
      const base = process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state");
      return path.join(base, "codex-with-chatgpt");
    }
  }
}

const PACKAGED_CODEX_DIRECTORY = /^OpenAI\.Codex_/i;

function regularDirectory(dir: string): boolean {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    return path.resolve(fs.realpathSync.native(dir)) === path.resolve(dir);
  } catch {
    return false;
  }
}

/** Locate the old Microsoft Store virtualized C2C state roots, if present. */
export function packagedStateDirCandidates(
  home = os.homedir(),
  canonicalStateDir = getDefaultStateDir()
): string[] {
  if (process.platform !== "win32") return [];
  const packagesRoot = path.join(home, "AppData", "Local", "Packages");
  if (!regularDirectory(packagesRoot)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(packagesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return [...new Set(entries
    .filter((entry) => entry.isDirectory() && PACKAGED_CODEX_DIRECTORY.test(entry.name))
    .map((entry) => path.join(packagesRoot, entry.name, "LocalCache", "Local", "codex-with-chatgpt"))
    .filter((candidate) => regularDirectory(candidate) && !samePath(candidate, canonicalStateDir))
    .map((candidate) => path.resolve(candidate)))].sort();
}

/** Resolve an explicit state directory, the process environment, or the OS default. */
export function resolveStateDir(explicit?: string): string {
  const supplied = explicit?.trim() || process.env.C2C_STATE_DIR?.trim();
  return path.resolve(supplied || getDefaultStateDir());
}

/**
 * Freeze the state domain for a long-lived bridge/CLI process.
 *
 * Tests and small standalone helpers may continue to use getStateDir()
 * without initializing a context. Production startup calls this once before
 * constructing any stateful subsystem; later environment changes cannot move
 * one live bridge to a second state tree.
 */
export function initializeStateDir(explicit?: string): StateDirContext {
  const resolved = resolveStateDir(explicit);
  if (processStateDir && !samePath(processStateDir, resolved)) {
    throw new Error(`C2C state directory is already fixed at ${processStateDir}; refusing to switch state domains`);
  }
  processStateDir ??= resolved;
  return Object.freeze({ stateDir: processStateDir });
}

export function getInitializedStateDir(): string | null {
  return processStateDir;
}

/** Override with C2C_STATE_DIR when no startup context has been fixed. */
export function getStateDir(explicit?: string): string {
  if (processStateDir) {
    if (explicit !== undefined && !samePath(processStateDir, explicit)) {
      throw new Error(`C2C state directory is already fixed at ${processStateDir}; refusing to switch state domains`);
    }
    return processStateDir;
  }
  return resolveStateDir(explicit);
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function stateSubdir(name: string): string {
  return ensureDir(path.join(getStateDir(), name));
}

/**
 * Write a JSON file with owner-only permissions.
 *
 * State files are read by a second bridge process after a restart.  Writing
 * directly to the destination can leave truncated JSON if the process exits
 * during the write, which in turn looks exactly like a stale/ghost runtime
 * state.  Write a uniquely named sibling and replace the destination only
 * after the complete payload is on disk.
 */
export function writeSecureJson(file: string, data: unknown, options: { durable?: boolean } = {}): void {
  ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
    if (options.durable) {
      const fd = fs.openSync(temporary, "r+");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    try {
      fs.chmodSync(temporary, 0o600);
    } catch {
      // best effort on platforms without chmod semantics
    }
    try {
      fs.renameSync(temporary, file);
    } catch (error) {
      if (options.durable) throw error; // Never delete the last durable intent.
      // Node replaces regular files atomically on POSIX and current Windows
      // runtimes.  Keep a narrow compatibility fallback for filesystems that
      // report an existing destination as EEXIST/EPERM; the temporary payload
      // is still complete before this branch is reached.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
      fs.rmSync(file, { force: true });
      fs.renameSync(temporary, file);
    }
    if (options.durable) {
      const fd = fs.openSync(file, "r+");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (process.platform !== "win32") {
        const dir = fs.openSync(path.dirname(file), "r");
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      }
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort on platforms without chmod semantics
  }
}

export function readJsonIfExists<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export const DEFAULT_PORT = 48765;
export const DEFAULT_HOST = "127.0.0.1";
