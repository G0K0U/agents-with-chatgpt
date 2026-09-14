import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Deterministic runtime identity.
 *
 * The production bridge must never look healthy while it is actually serving
 * stale output. A build writes a manifest into dist (see
 * scripts/write-build-manifest.mjs) recording which source tree and which
 * dist tree it was produced from. At runtime the same trees are re-hashed so
 * the following drift classes become detectable instead of silent:
 *
 *   SOURCE_BUILD_MISMATCH  source changed after the build
 *   BUILD_RUNTIME_MISMATCH the dist/release tree changed after the build
 *                          (or the process is running a different tree than
 *                          the one on disk)
 *
 * Hashes are content-addressed over sorted relative paths, so identical
 * content always produces identical hashes regardless of timestamp noise.
 */

export interface BuildManifest {
  schema: 1;
  version: string;
  sourceCommit: string | null;
  sourceDirty: boolean;
  sourceRoot: string;
  sourceHash: string;
  buildHash: string;
  builtAt: string;
  nodeVersion: string;
}

export type ParityState = "ok" | "mismatch" | "unknown";

export interface RuntimeIdentity {
  manifest: BuildManifest | null;
  /** Directory the manifest was read from (dist/ or a release dir). */
  runtimeDir: string | null;
  releaseId: string | null;
  sourceParity: ParityState;
  buildParity: ParityState;
  sourceParityDetail?: string;
  buildParityDetail?: string;
}

const MANIFEST_NAME = "build-manifest.json";

/** Files whose content defines the build identity, per tree. */
function collectFiles(root: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else if (entry.isFile() && entry.name !== MANIFEST_NAME && !entry.name.endsWith(".map")) {
      out.push(full);
    }
  }
}

/**
 * Content hash over every file below root (excluding source maps and the
 * manifest itself). Empty/missing trees hash to the empty-string sentinel so
 * "missing" stays distinguishable from any real content.
 */
export function computeTreeHash(root: string): string | null {
  if (!fs.existsSync(root)) return null;
  const files: string[] = [];
  collectFiles(root, files);
  const hashed: Array<{ rel: string; digest: string }> = [];
  for (const file of files.sort()) {
    const digest = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    hashed.push({ rel: path.relative(root, file).replaceAll("\\", "/"), digest });
  }
  if (hashed.length === 0) return null;
  const hasher = createHash("sha256");
  for (const { rel, digest } of hashed) hasher.update(`${rel}:${digest}\n`);
  return hasher.digest("hex");
}

export function readBuildManifest(runtimeDir: string): BuildManifest | null {
  const file = path.join(runtimeDir, MANIFEST_NAME);
  if (!fs.existsSync(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as BuildManifest;
    if (value?.schema !== 1 || typeof value.buildHash !== "string" || typeof value.sourceHash !== "string") {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export interface RuntimeIdentityOptions {
  /** Directory the running process was launched from (dist/ or a release dir). */
  runtimeDir: string;
  /** Override the source tree; defaults to manifest.sourceRoot when present. */
  sourceRoot?: string;
}

/**
 * Resolve the identity of the tree the process is actually executing and
 * verify it against the source tree the manifest claims.
 */
export function resolveRuntimeIdentity(opts: RuntimeIdentityOptions): RuntimeIdentity {
  const runtimeDir = path.resolve(opts.runtimeDir);
  const manifest = readBuildManifest(runtimeDir);
  const base: RuntimeIdentity = {
    manifest,
    runtimeDir,
    releaseId: manifest ? releaseIdFor(manifest) : null,
    sourceParity: "unknown",
    buildParity: "unknown",
  };
  if (!manifest) return base;

  const buildHashNow = computeTreeHash(runtimeDir);
  base.buildParity = buildHashNow === null
    ? "unknown"
    : buildHashNow === manifest.buildHash ? "ok" : "mismatch";
  if (base.buildParity === "mismatch") {
    base.buildParityDetail = "runtime tree changed after the build (or a different tree is on disk)";
  }

  const sourceRoot = path.resolve(opts.sourceRoot ?? manifest.sourceRoot);
  const sourceHashNow = computeTreeHash(sourceRoot);
  base.sourceParity = sourceHashNow === null
    ? "unknown"
    : sourceHashNow === manifest.sourceHash ? "ok" : "mismatch";
  if (base.sourceParity === "mismatch") {
    base.sourceParityDetail = "source changed after this build; rebuild and activate to publish it";
  }
  return base;
}

/** Stable, human-comparable release id: version + short content hash. */
export function releaseIdFor(manifest: BuildManifest): string {
  return `${manifest.version}-${manifest.buildHash.slice(0, 8)}`;
}

/** The tree directory the currently executing module was loaded from. */
export function currentRuntimeDir(): string {
  // dist/bridge/runtime-identity.js -> dist/ ; release layouts are the same shape.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export interface ReleasePointer {
  schema: 1;
  releaseId: string;
  /** Repository-relative entry path, e.g. releases/<id>/cli/index.js. */
  entry: string;
  version: string;
  sourceCommit: string | null;
  buildHash: string;
  activatedAt: string;
}

export function readReleasePointer(repoRoot: string): ReleasePointer | null {
  const file = path.join(repoRoot, "releases", "LKG.json");
  if (!fs.existsSync(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as ReleasePointer;
    if (value?.schema !== 1 || typeof value.entry !== "string" || typeof value.buildHash !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

export function writeReleasePointer(repoRoot: string, pointer: ReleasePointer): void {
  const dir = path.join(repoRoot, "releases");
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `LKG.json.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(pointer, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, "LKG.json"));
}
