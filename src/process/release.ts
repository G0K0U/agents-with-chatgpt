import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
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
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
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
    const testArgs = opts.quick ? ["run", ...FOCUSED_TESTS] : ["run"];
    ok = push(runStep(repoRoot, "tests", vitest, testArgs, 1_800_000)) && ok;
  }
  return { ok, steps };
}

function copyDir(src: string, dest: string): void {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: false });
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
  if (identity.buildParity !== "ok") {
    return { ok: false, releaseId: null, manifest, error: "dist tree changed after the build; rebuild before promoting" };
  }
  const releaseId = releaseIdFor(manifest);
  copyDir(distDir, path.join(repoRoot, "releases", releaseId));
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

/** True when the release id's embedded build hash matches the manifest. */
function releaseHashOf(runningReleaseId: string, distManifest: BuildManifest): string {
  // releaseId = "<version>-<buildHash[0..8]>"; match by prefix.
  const prefix = runningReleaseId.split("-").slice(1).join("-");
  return distManifest.buildHash.startsWith(prefix) ? distManifest.buildHash : `mismatch:${runningReleaseId}`;
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
  if (!pointer && distManifest && runningReleaseId && distManifest.buildHash !== releaseHashOf(runningReleaseId, distManifest)) {
    // Classic stale runtime with no LKG pointer yet: the dist tree was
    // rebuilt after the running process started (release ids embed the build
    // hash prefix, so a differing id means a differing tree).
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
