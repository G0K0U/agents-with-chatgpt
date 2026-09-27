import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeTreeHash,
  computeSourceTreeHash,
  installationRoot,
  readBuildManifest,
  readReleasePointer,
  releaseIdFor,
  resolveRuntimeIdentity,
  writeReleasePointer,
  type BuildManifest,
} from "../bridge/runtime-identity.js";

/**
 * Deterministic release lifecycle:
 *
 *   source -> typecheck -> build -> verified release -> atomic activation
 *
 * `c2c release build` produces dist/ plus its build manifest, then promotes
 * an immutable copy into releases/<id>/. `c2c release activate` runs the
 * release gate and only then repoints LKG.json. A failed gate leaves the
 * previous last-known-good release untouched, so activation can never destroy
 * a working runtime. The daemon prefers the LKG release when launching a
 * bridge, which keeps mutable development output out of production.
 */

export const __releaseFilename = fileURLToPath(import.meta.url);

export function releaseRepoRoot(): string {
  // dist/process/release.js -> repo root; src/process/release.ts -> repo root.
  return installationRoot();
}

export interface GateStep {
  name: string;
  ok: boolean;
  durationMs: number;
  detail?: string;
}

export interface GateResult {
  ok: boolean;
  steps: GateStep[];
}

function runStep(repoRoot: string, name: string, cmd: string, args: string[], timeoutMs: number): GateStep {
  const started = Date.now();
  const result = spawnSync(process.execPath, [cmd, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ok = result.status === 0;
  const tail = (text: string | undefined): string | undefined => {
    if (!text) return undefined;
    const lines = text.trimEnd().split(/\r?\n/);
    return lines.slice(-8).join("\n").slice(0, 2000);
  };
  return {
    name,
    ok,
    durationMs: Date.now() - started,
    detail: ok ? undefined : (tail(result.stdout) ?? tail(result.stderr) ?? `exit ${result.status}`),
  };
}

/** Focused regression suites run before the full suite in the quick gate. */
const FOCUSED_TESTS = [
  "tests/runtime-identity.test.ts",
  "tests/release-lifecycle.test.ts",
  "tests/state-domain-ownership.test.ts",
  "tests/zcode-native.test.ts",
];

export function runReleaseGate(repoRoot: string, opts: { quick?: boolean } = {}): GateResult {
  const tsc = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const manifestScript = path.join(repoRoot, "scripts", "write-build-manifest.mjs");
  const vitest = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
  const steps: GateStep[] = [];
  const push = (step: GateStep): boolean => {
    steps.push(step);
    return step.ok;
  };
  let ok = true;
  ok = push(runStep(repoRoot, "typecheck", tsc, ["--noEmit"], 240_000)) && ok;
  if (ok) ok = push(runStep(repoRoot, "build", tsc, ["-p", "tsconfig.json"], 240_000)) && ok;
  if (ok) ok = push(runStep(repoRoot, "manifest", manifestScript, [], 60_000)) && ok;
  if (ok) {
    // Bounded worker count, matching the documented release-readiness gate:
    // several suites spawn real child processes, and unbounded default
    // parallelism on many-core machines produces pure resource-contention
    // flakes (one full gate runs at a time).
    const testArgs = opts.quick ? ["run", ...FOCUSED_TESTS] : ["run", "--maxWorkers=2"];
    ok = push(runStep(repoRoot, "tests", vitest, testArgs, 1_800_000)) && ok;
  }
  return { ok, steps };
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // mkdir is the collision fence. Never remove or overwrite a prior release,
  // including a partially copied one whose provenance needs investigation.
  fs.mkdirSync(dest);
  for (const entry of fs.readdirSync(src)) {
    fs.cpSync(path.join(src, entry), path.join(dest, entry), { recursive: true, verbatimSymlinks: false });
  }
}

export interface ReleaseBuildResult {
  ok: boolean;
  releaseId: string | null;
  manifest: BuildManifest | null;
  error?: string;
}

/** Build (gate's build step already ran) and promote an immutable release copy. */
export function promoteCurrentBuild(repoRoot: string): ReleaseBuildResult {
  const distDir = path.join(repoRoot, "dist");
  const manifest = readBuildManifest(distDir);
  if (!manifest) return { ok: false, releaseId: null, manifest: null, error: "dist/build-manifest.json missing; build first" };
  const identity = resolveRuntimeIdentity({ runtimeDir: distDir });
  if (identity.buildParity !== "ok" || identity.sourceParity !== "ok") {
    return { ok: false, releaseId: null, manifest, error: "source or dist tree changed after the build; rebuild before promoting" };
  }
  const releaseId = releaseIdFor(manifest);
  const target = path.join(repoRoot, "releases", releaseId);
  if (fs.existsSync(target)) {
    const existing = readBuildManifest(target);
    if (!existing || !fs.existsSync(path.join(target, "cli", "index.js")) ||
        computeTreeHash(target) !== manifest.buildHash ||
        existing.version !== manifest.version || existing.buildHash !== manifest.buildHash ||
        existing.sourceHash !== manifest.sourceHash || existing.sourceCommit !== manifest.sourceCommit ||
        existing.sourceDirty !== manifest.sourceDirty) {
      return { ok: false, releaseId: null, manifest, error: `release ${releaseId} already exists with different or incomplete content` };
    }
    return { ok: true, releaseId, manifest: existing };
  }
  try {
    copyDir(distDir, target);
  } catch (error) {
    return { ok: false, releaseId: null, manifest, error: `could not create immutable release ${releaseId}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (computeTreeHash(target) !== manifest.buildHash || !fs.existsSync(path.join(target, "cli", "index.js"))) {
    return { ok: false, releaseId: null, manifest, error: `release ${releaseId} copy is incomplete` };
  }
  return { ok: true, releaseId, manifest };
}

export interface ActivateResult {
  ok: boolean;
  gate: GateResult;
  pointer: ReturnType<typeof readReleasePointer>;
  error?: string;
}

/**
 * Run the release gate, promote the build, and atomically repoint the
 * last-known-good release. The previous pointer is preserved on any failure.
 * The previously activated pointer is retained as releases/LKG.previous.json
 * so `c2c release rollback` can restore it without a rebuild.
 */
export function activateRelease(repoRoot: string, opts: { quick?: boolean } = {}): ActivateResult {
  const previous = readReleasePointer(repoRoot);
  const gate = runReleaseGate(repoRoot, opts);
  if (!gate.ok) {
    return { ok: false, gate, pointer: previous, error: "release gate failed; last-known-good release preserved" };
  }
  const promoted = promoteCurrentBuild(repoRoot);
  if (!promoted.ok || !promoted.manifest || !promoted.releaseId) {
    return { ok: false, gate, pointer: previous, error: promoted.error ?? "release promotion failed" };
  }
  if (previous) {
    writePreviousReleasePointer(repoRoot, previous);
  }
  const pointer = {
    schema: 1 as const,
    releaseId: promoted.releaseId,
    entry: `releases/${promoted.releaseId}/cli/index.js`,
    version: promoted.manifest.version,
    sourceCommit: promoted.manifest.sourceCommit,
    buildHash: promoted.manifest.buildHash,
    activatedAt: new Date().toISOString(),
  };
  writeReleasePointer(repoRoot, pointer);
  return { ok: true, gate, pointer };
}

/**
 * Install an already activated, clean source release into another checkout.
 * The source activation must have run the normal gate. This copies only its
 * immutable emitted tree, verifies it against both checkouts' source trees,
 * and changes the target pointer only after the copy has been checked.
 */
export function installActivatedRelease(sourceRoot: string, targetRoot: string): ReleaseBuildResult {
  const source = path.resolve(sourceRoot);
  const targetRepo = path.resolve(targetRoot);
  if (source === targetRepo) return { ok: false, releaseId: null, manifest: null, error: "source and target must differ" };
  const active = readReleasePointer(source);
  if (!active || !/^[A-Za-z0-9._-]+$/.test(active.releaseId) ||
      active.entry !== `releases/${active.releaseId}/cli/index.js`) {
    return { ok: false, releaseId: null, manifest: null, error: "source has no valid activated release" };
  }
  const sourceDir = path.join(source, "releases", active.releaseId);
  const manifest = readBuildManifest(sourceDir);
  const revision = spawnSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" });
  const status = spawnSync("git", ["-C", source, "status", "--porcelain"], { encoding: "utf8" });
  if (!manifest || manifest.sourceDirty || manifest.sourceRoot !== "src" ||
      !/^[0-9a-f]{40}$/i.test(manifest.sourceCommit ?? "") ||
      revision.status !== 0 || revision.stdout.trim() !== manifest.sourceCommit ||
      status.status !== 0 || status.stdout.trim() !== "" ||
      active.releaseId !== releaseIdFor(manifest) || active.buildHash !== manifest.buildHash ||
      active.sourceCommit !== manifest.sourceCommit || active.version !== manifest.version) {
    return { ok: false, releaseId: null, manifest, error: "source activation is not a clean committed build" };
  }
  const identity = resolveRuntimeIdentity({ runtimeDir: sourceDir });
  if (identity.buildParity !== "ok" || identity.sourceParity !== "ok" ||
      !fs.existsSync(path.join(sourceDir, "cli", "index.js"))) {
    return { ok: false, releaseId: null, manifest, error: "source release tree or source parity failed" };
  }
  if (computeSourceTreeHash(path.join(targetRepo, "src")) !== manifest.sourceHash) {
    return { ok: false, releaseId: null, manifest, error: "target source differs from activated release" };
  }
  const targetDir = path.join(targetRepo, "releases", active.releaseId);
  if (fs.existsSync(targetDir)) {
    const existing = readBuildManifest(targetDir);
    if (!existing || existing.buildHash !== manifest.buildHash ||
        existing.sourceHash !== manifest.sourceHash || existing.sourceCommit !== manifest.sourceCommit ||
        computeTreeHash(targetDir) !== manifest.buildHash) {
      return { ok: false, releaseId: null, manifest, error: "target release id collision or incomplete copy" };
    }
  } else {
    try {
      copyDir(sourceDir, targetDir);
    } catch (error) {
      return { ok: false, releaseId: null, manifest, error: `release copy failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (!fs.existsSync(path.join(targetDir, "cli", "index.js")) ||
      computeTreeHash(targetDir) !== manifest.buildHash ||
      resolveRuntimeIdentity({ runtimeDir: targetDir }).sourceParity !== "ok") {
    return { ok: false, releaseId: null, manifest, error: "target release verification failed; pointer preserved" };
  }
  const previous = readReleasePointer(targetRepo);
  if (previous && previous.releaseId !== active.releaseId) {
    const previousDir = path.join(targetRepo, "releases", previous.releaseId);
    const previousManifest = readBuildManifest(previousDir);
    if (!/^[A-Za-z0-9._-]+$/.test(previous.releaseId) ||
        previous.entry !== `releases/${previous.releaseId}/cli/index.js` ||
        !previousManifest || previousManifest.buildHash !== previous.buildHash ||
        computeTreeHash(previousDir) !== previous.buildHash ||
        !fs.existsSync(path.join(targetRepo, previous.entry))) {
      return { ok: false, releaseId: null, manifest, error: "target previous release is invalid; pointer preserved" };
    }
  }
  if (previous && previous.releaseId !== active.releaseId) writePreviousReleasePointer(targetRepo, previous);
  if (!previous || previous.releaseId !== active.releaseId) {
    writeReleasePointer(targetRepo, { ...active, activatedAt: new Date().toISOString() });
  }
  return { ok: true, releaseId: active.releaseId, manifest };
}

const POINTER_FIELDS = ["schema", "releaseId", "entry", "version", "sourceCommit", "buildHash", "activatedAt"] as const;

function writePreviousReleasePointer(repoRoot: string, pointer: NonNullable<ReturnType<typeof readReleasePointer>>): void {
  const dir = path.join(repoRoot, "releases");
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `LKG.previous.json.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(pointer, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, "LKG.previous.json"));
}

function readPreviousReleasePointer(repoRoot: string): ReturnType<typeof readReleasePointer> {
  const file = path.join(repoRoot, "releases", "LKG.previous.json");
  if (!fs.existsSync(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as ReturnType<typeof readReleasePointer>;
    return value ?? null;
  } catch {
    return null;
  }
}

export interface RollbackResult {
  ok: boolean;
  pointer: ReturnType<typeof readReleasePointer>;
  error?: string;
}

/**
 * Roll the last-known-good pointer back to the previously activated release.
 * The candidate pointer is fully validated before it replaces LKG.json
 * (schema, containment under releases/, matching build manifest, existing
 * entry), so a corrupt or tampered previous file can never become the
 * active release. The current pointer is preserved as LKG.previous.json,
 * making rollback a bounded A/B swap.
 */
export function rollbackRelease(repoRoot: string): RollbackResult {
  const current = readReleasePointer(repoRoot);
  const previous = readPreviousReleasePointer(repoRoot);
  if (!previous) {
    return { ok: false, pointer: current, error: "no previous release pointer recorded; nothing to roll back to" };
  }
  if (previous.schema !== 1 || POINTER_FIELDS.some((f) => (previous as unknown as Record<string, unknown>)[f] === undefined)) {
    return { ok: false, pointer: current, error: "previous release pointer is malformed; refusing to activate it" };
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(previous.releaseId) || previous.entry !== `releases/${previous.releaseId}/cli/index.js`) {
    return { ok: false, pointer: current, error: "previous release pointer entry is not contained in releases/; refusing to activate it" };
  }
  const entry = path.join(repoRoot, previous.entry);
  const releaseDir = path.join(repoRoot, "releases", previous.releaseId);
  const manifest = readBuildManifest(releaseDir);
  if (!fs.existsSync(entry) || !manifest || manifest.buildHash !== previous.buildHash) {
    return { ok: false, pointer: current, error: `previous release ${previous.releaseId} is missing or its manifest does not match; refusing to activate it` };
  }
  if (current && current.releaseId === previous.releaseId) {
    return { ok: true, pointer: current, error: "already running the previous release; pointer unchanged" };
  }
  if (current) {
    writePreviousReleasePointer(repoRoot, current);
  }
  writeReleasePointer(repoRoot, previous);
  return { ok: true, pointer: previous };
}

export type ReleaseDrift =
  | "NO_BUILD_MANIFEST"
  | "SOURCE_BUILD_MISMATCH"
  | "BUILD_RUNTIME_MISMATCH"
  | "STALE_RUNTIME"
  | "LKG_AHEAD_OF_DIST"
  | "NONE";

export interface ReleaseStatus {
  pointer: ReturnType<typeof readReleasePointer>;
  distManifest: BuildManifest | null;
  distReleaseId: string | null;
  distSourceParity: "ok" | "mismatch" | "unknown";
  distBuildParity: "ok" | "mismatch" | "unknown";
  /** Release identity reported by the running process, when known. */
  runningReleaseId: string | null;
  drift: ReleaseDrift[];
}

export function releaseStatus(repoRoot: string, runningReleaseId: string | null = null): ReleaseStatus {
  const distDir = path.join(repoRoot, "dist");
  const distManifest = readBuildManifest(distDir);
  const identity = distManifest ? resolveRuntimeIdentity({ runtimeDir: distDir }) : null;
  const pointer = readReleasePointer(repoRoot);
  const drift: ReleaseDrift[] = [];
  if (!distManifest || !identity) {
    drift.push("NO_BUILD_MANIFEST");
  } else {
    if (identity.sourceParity === "mismatch") drift.push("SOURCE_BUILD_MISMATCH");
    if (identity.buildParity === "mismatch") drift.push("BUILD_RUNTIME_MISMATCH");
  }
  if (pointer && distManifest && pointer.buildHash !== distManifest.buildHash) {
    // Normal after activation (dist is the next dev output); stale when the
    // running process still serves the pre-activation build.
    drift.push("LKG_AHEAD_OF_DIST");
    if (runningReleaseId && runningReleaseId !== pointer.releaseId) drift.push("STALE_RUNTIME");
  }
  if (!pointer && distManifest && runningReleaseId && runningReleaseId !== releaseIdFor(distManifest)) {
    // A different source or emitted tree means the running release is stale.
    drift.push("STALE_RUNTIME");
  }
  return {
    pointer,
    distManifest,
    distReleaseId: distManifest ? releaseIdFor(distManifest) : null,
    distSourceParity: identity?.sourceParity ?? "unknown",
    distBuildParity: identity?.buildParity ?? "unknown",
    runningReleaseId,
    drift,
  };
}
