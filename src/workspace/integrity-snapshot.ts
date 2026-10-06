import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { stableWorkspaceId } from "./identity.js";

/**
 * Read-only workspace integrity snapshot.
 *
 * Enumerates every normal file under a registry-verified canonical workspace
 * root (hidden, system and zero-byte files included) and produces a
 * deterministic, sorted manifest with size, last-write time and SHA-256 per
 * entry plus a manifest digest covering ALL entries.
 *
 * Fail-closed contract: any symlink/junction/reparse point, any path escaping
 * the canonical root, any unreadable/mutated/racing entry, any enumeration or
 * canonicalization failure, or any work-limit overrun aborts the snapshot with
 * a sanitized workspace-relative reason. A partial run never yields a digest.
 * The module only reads bytes to hash them; it never parses, writes, or
 * mutates the target workspace in any way.
 */

export type IntegritySnapshotErrorCode =
  | "ROOT_UNAVAILABLE"
  | "ROOT_IDENTITY_CHANGED"
  | "ENUMERATION_FAILED"
  | "LINK_REJECTED"
  | "NOT_A_REGULAR_FILE"
  | "ENTRY_OUTSIDE_ROOT"
  | "READ_FAILED"
  | "CHANGED_DURING_READ"
  | "ENTRY_LIMIT_EXCEEDED"
  | "SIZE_LIMIT_EXCEEDED";

export class IntegritySnapshotError extends Error {
  /**
   * @param code stable machine-readable failure class
   * @param relPath sanitized workspace-relative path (forward slashes) or
   *   null when the failure is at the root stage; never an absolute path
   * @param rootVerified true only when the root identity check already passed
   */
  constructor(
    public readonly code: IntegritySnapshotErrorCode,
    public readonly relPath: string | null,
    public readonly rootVerified: boolean,
    message: string
  ) {
    super(message);
    this.name = "IntegritySnapshotError";
  }
}

export interface IntegrityFileEntry {
  /** Normalized workspace-relative path (forward slashes, deterministic). */
  path: string;
  sizeBytes: number;
  /** ISO 8601 UTC timestamp of the file's last write. */
  lastWriteTimeUtc: string;
  sha256: string;
}

export interface IntegritySnapshot {
  /** true only when the full enumeration and hashing succeeded. */
  complete: true;
  rootIdentityVerified: true;
  entries: IntegrityFileEntry[];
  totalFiles: number;
  totalBytes: number;
  /** SHA-256 over the deterministic serialization of ALL entries. */
  manifestSha256: string;
  manifestVersion: 1;
}

export interface IntegritySnapshotOptions {
  root: string;
  /** Registry-stable workspace id the canonical root must hash to. */
  expectedId: string;
  /** Fail-closed work bounds; a run that exceeds them never returns partial data. */
  maxEntries?: number;
  maxDirectories?: number;
  maxTotalBytes?: number;
  /** Test seam only; production always opens files through fs.promises. */
  hooks?: {
    openFile?: (abs: string) => Promise<FileHandle>;
  };
}

const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_MAX_DIRECTORIES = 100_000;
const DEFAULT_MAX_TOTAL_BYTES = 4 * 1024 ** 3;
const READ_CHUNK_BYTES = 1024 * 1024;
const MANIFEST_VERSION = 1;

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

function pathKey(value: string): string {
  return CASE_INSENSITIVE ? value.toLowerCase() : value;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const key = pathKey(root);
  const value = pathKey(candidate);
  return value === key || value.startsWith(key + path.sep);
}

function relOf(dirRel: string, name: string): string {
  const normalized = name.replace(/\\/g, "/");
  return dirRel ? `${dirRel}/${normalized}` : normalized;
}

/**
 * Compute the complete integrity snapshot of a workspace root.
 * Throws IntegritySnapshotError on any fail-closed condition; on success the
 * manifest is provably complete and deterministic.
 */
export async function computeIntegritySnapshot(opts: IntegritySnapshotOptions): Promise<IntegritySnapshot> {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxDirectories = opts.maxDirectories ?? DEFAULT_MAX_DIRECTORIES;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  // --- Root identity verification (must be proven before any walk). ---
  let root: string;
  try {
    const lstat = fs.lstatSync(opts.root, { throwIfNoEntry: false });
    if (!lstat) throw new Error("root is missing");
    // A root that has itself become a symlink/junction/reparse point since
    // registration is an identity change; never follow it.
    if (lstat.isSymbolicLink()) {
      throw new IntegritySnapshotError(
        "ROOT_IDENTITY_CHANGED", null, false,
        "Workspace root is a symbolic link or reparse point"
      );
    }
    if (!lstat.isDirectory()) throw new Error("root is not a directory");
    root = fs.realpathSync.native(opts.root);
    if (!isInsideRoot(root, root) || pathKey(root) !== pathKey(opts.root)) {
      throw new IntegritySnapshotError(
        "ROOT_IDENTITY_CHANGED", null, false,
        "Workspace root no longer canonicalizes to the registered path"
      );
    }
  } catch (error) {
    if (error instanceof IntegritySnapshotError) throw error;
    throw new IntegritySnapshotError(
      "ROOT_UNAVAILABLE", null, false,
      "Workspace root is unavailable or cannot be canonicalized"
    );
  }
  if (stableWorkspaceId(root) !== opts.expectedId) {
    throw new IntegritySnapshotError(
      "ROOT_IDENTITY_CHANGED", null, false,
      "Workspace root identity does not match the registered workspace id"
    );
  }
  const rootVerified = true;

  // Internal manifest records carry full-precision mtime so any mtime change,
  // even below the ISO millisecond precision, alters the manifest digest.
  type ManifestRecord = { path: string; sizeBytes: bigint; mtimeNs: bigint; sha256: string };
  const files: ManifestRecord[] = [];
  let directories = 0;
  let totalBytes = 0;
  const manifestHash = createHash("sha256");

  const hashFile = async (abs: string, rel: string, pre: fs.BigIntStats): Promise<{ sizeBytes: bigint; mtimeNs: bigint; sha256: string }> => {
    const open = opts.hooks?.openFile ?? ((target: string) => fs.promises.open(target, "r"));
    let handle: FileHandle;
    try {
      handle = await open(abs);
    } catch {
      throw new IntegritySnapshotError("READ_FAILED", rel, rootVerified, `Cannot open file for hashing: ${rel}`);
    }
    try {
      // FileHandle.stat() has fstat semantics: it describes the open file.
      const openStat = await handle.stat({ bigint: true });
      if (!openStat.isFile()) {
        throw new IntegritySnapshotError("NOT_A_REGULAR_FILE", rel, rootVerified, `Not a regular file: ${rel}`);
      }
      if (openStat.size !== pre.size || openStat.mtimeNs !== pre.mtimeNs) {
        throw new IntegritySnapshotError(
          "CHANGED_DURING_READ", rel, rootVerified, `File changed between listing and open: ${rel}`
        );
      }
      const hash = createHash("sha256");
      let bytesReadTotal = 0;
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        hash.update(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
        bytesReadTotal += bytesRead;
        if (BigInt(bytesReadTotal) > openStat.size) break;
      }
      if (BigInt(bytesReadTotal) !== openStat.size) {
        throw new IntegritySnapshotError(
          "CHANGED_DURING_READ", rel, rootVerified, `File size changed while hashing: ${rel}`
        );
      }
      const postStat = await handle.stat({ bigint: true });
      if (postStat.size !== openStat.size || postStat.mtimeNs !== openStat.mtimeNs) {
        throw new IntegritySnapshotError(
          "CHANGED_DURING_READ", rel, rootVerified, `File changed while being hashed: ${rel}`
        );
      }
      return { sizeBytes: openStat.size, mtimeNs: openStat.mtimeNs, sha256: hash.digest("hex") };
    } finally {
      await handle.close().catch(() => undefined);
    }
  };

  // Explicit stack instead of recursion: deep trees cannot overflow the JS stack.
  const stack: Array<{ abs: string; rel: string }> = [{ abs: root, rel: "" }];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(dir.abs, { withFileTypes: true });
    } catch (error) {
      throw new IntegritySnapshotError(
        "ENUMERATION_FAILED", dir.rel || null, rootVerified,
        `Cannot enumerate directory: ${dir.rel || "."}${error instanceof Error ? ` (${error.name})` : ""}`
      );
    }
    for (const dirent of dirents) {
      const rel = relOf(dir.rel, dirent.name);
      const abs = path.join(dir.abs, dirent.name);
      // lstat never follows the entry: link/reparse rejection happens here,
      // before anything is followed.
      let st: fs.BigIntStats | undefined;
      try {
        st = await fs.promises.lstat(abs, { bigint: true });
      } catch {
        st = undefined;
      }
      if (!st) {
        throw new IntegritySnapshotError(
          "ENUMERATION_FAILED", rel, rootVerified, `Entry disappeared during snapshot: ${rel}`
        );
      }
      if (st.isSymbolicLink()) {
        // Covers symbolic links and (on Windows) junctions/mount points.
        throw new IntegritySnapshotError(
          "LINK_REJECTED", rel, rootVerified, `Symbolic link or junction is not allowed: ${rel}`
        );
      }
      if (st.isDirectory()) {
        if (directories >= maxDirectories) {
          throw new IntegritySnapshotError(
            "ENTRY_LIMIT_EXCEEDED", rel, rootVerified, `Directory limit (${maxDirectories}) exceeded: ${rel}`
          );
        }
        let real: string;
        try {
          real = fs.realpathSync.native(abs);
        } catch {
          throw new IntegritySnapshotError(
            "ENUMERATION_FAILED", rel, rootVerified, `Cannot canonicalize directory: ${rel}`
          );
        }
        if (!isInsideRoot(root, real)) {
          throw new IntegritySnapshotError(
            "ENTRY_OUTSIDE_ROOT", rel, rootVerified, `Directory resolves outside the workspace root: ${rel}`
          );
        }
        if (pathKey(real) !== pathKey(abs)) {
          // The directory was swapped for a link mid-walk; never descend.
          throw new IntegritySnapshotError(
            "LINK_REJECTED", rel, rootVerified, `Directory canonicalized through a link: ${rel}`
          );
        }
        directories++;
        stack.push({ abs: real, rel });
        continue;
      }
      if (!st.isFile()) {
        throw new IntegritySnapshotError(
          "NOT_A_REGULAR_FILE", rel, rootVerified, `Unsupported entry type cannot be hashed: ${rel}`
        );
      }
      if (files.length >= maxEntries) {
        throw new IntegritySnapshotError(
          "ENTRY_LIMIT_EXCEEDED", rel, rootVerified, `File entry limit (${maxEntries}) exceeded: ${rel}`
        );
      }
      let real: string;
      try {
        real = fs.realpathSync.native(abs);
      } catch {
        throw new IntegritySnapshotError(
          "ENUMERATION_FAILED", rel, rootVerified, `Cannot canonicalize file: ${rel}`
        );
      }
      if (!isInsideRoot(root, real)) {
        throw new IntegritySnapshotError(
          "ENTRY_OUTSIDE_ROOT", rel, rootVerified, `File resolves outside the workspace root: ${rel}`
        );
      }
      if (pathKey(real) !== pathKey(abs)) {
        throw new IntegritySnapshotError(
          "LINK_REJECTED", rel, rootVerified, `File canonicalized through a link: ${rel}`
        );
      }
      if (totalBytes + Number(st.size) > maxTotalBytes) {
        throw new IntegritySnapshotError(
          "SIZE_LIMIT_EXCEEDED", rel, rootVerified, `Total byte limit (${maxTotalBytes}) exceeded: ${rel}`
        );
      }
      const hashed = await hashFile(real, rel, st);
      totalBytes += Number(hashed.sizeBytes);
      files.push({
        path: rel,
        sizeBytes: hashed.sizeBytes,
        mtimeNs: hashed.mtimeNs,
        sha256: hashed.sha256,
      });
    }
  }

  // Deterministic manifest: byte-wise sort over normalized relative paths.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // The digest covers ALL entries regardless of output pagination and is
  // sensitive to path, content (via sha256), size and mtime of every entry.
  manifestHash.update(
    JSON.stringify({
      version: MANIFEST_VERSION,
      entries: files.map((entry) => [
        entry.path,
        entry.sizeBytes.toString(),
        entry.mtimeNs.toString(),
        entry.sha256,
      ]),
    })
  );

  const entries: IntegrityFileEntry[] = files.map((entry) => ({
    path: entry.path,
    sizeBytes: Number(entry.sizeBytes),
    lastWriteTimeUtc: new Date(Number(entry.mtimeNs / 1_000_000n)).toISOString(),
    sha256: entry.sha256,
  }));

  return {
    complete: true,
    rootIdentityVerified: true,
    entries,
    totalFiles: entries.length,
    totalBytes,
    manifestSha256: manifestHash.digest("hex"),
    manifestVersion: MANIFEST_VERSION,
  };
}
