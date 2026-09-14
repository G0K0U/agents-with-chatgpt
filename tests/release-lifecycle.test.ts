/**
 * Regression coverage for the release lifecycle:
 *   - gate failure preserves the previous last-known-good pointer
 *   - successful gate + promotion activates atomically
 *   - promotion refuses a dist tree modified after its build
 *   - releaseStatus reports drift classes deterministically
 *
 * The gate's toolchain (tsc/vitest) is stubbed; the manifest step is real and
 * runs against fixture src/dist trees, so hashing and promotion are exercised
 * end-to-end without the real TypeScript toolchain.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeTreeHash, readBuildManifest, readReleasePointer, type BuildManifest } from "../src/bridge/runtime-identity.js";
import { activateRelease, promoteCurrentBuild, releaseStatus } from "../src/process/release.js";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let fixture: string;

function makeFakeRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "c2c-rel-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "dist", "cli"), { recursive: true });
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(path.join(root, "src", "entry.ts"), "export const v = 1;\n");
  writeFileSync(path.join(root, "dist", "cli", "index.js"), "export const v = 1;\n");
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.2.0" }));
  // The gate's manifest step runs the REAL script; copy it into the fixture.
  const realScript = readFileSync(path.join(repoRoot, "scripts", "write-build-manifest.mjs"), "utf8");
  writeFileSync(path.join(root, "scripts", "write-build-manifest.mjs"), realScript);
  // Pre-existing manifest so gate-less reads work; activate rewrites it via
  // the real manifest script.
  const manifest: BuildManifest = {
    schema: 1,
    version: "0.2.0",
    sourceCommit: "feed0001",
    sourceDirty: false,
    sourceRoot: path.join(root, "src"),
    sourceHash: computeTreeHash(path.join(root, "src"))!,
    buildHash: computeTreeHash(path.join(root, "dist"))!,
    builtAt: new Date().toISOString(),
    nodeVersion: process.version,
  };
  writeFileSync(path.join(root, "dist", "build-manifest.json"), JSON.stringify(manifest, null, 2));
  installStubShims(root);
  return root;
}

/**
 * The gate spawns `node <repoRoot>/node_modules/typescript/bin/tsc` and
 * `node <repoRoot>/node_modules/vitest/vitest.mjs`; stub both. Set
 * `<root>/releases/stub-gate-fails` to make the vitest stub fail.
 */
function installStubShims(root: string): void {
  const tscDir = path.join(root, "node_modules", "typescript", "bin");
  const vitestDir = path.join(root, "node_modules", "vitest");
  mkdirSync(tscDir, { recursive: true });
  mkdirSync(vitestDir, { recursive: true });
  writeFileSync(path.join(tscDir, "tsc"), "process.exit(0);\n");
  const stubFlag = path.join(root, "releases", "stub-gate-fails");
  writeFileSync(path.join(vitestDir, "vitest.mjs"), `
import { existsSync } from "node:fs";
process.exit(existsSync(${JSON.stringify(stubFlag)}) ? 1 : 0);
`);
}

beforeEach(() => {
  fixture = makeFakeRepo();
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

describe("release lifecycle", () => {
  it("failed gate preserves the previous last-known-good pointer", () => {
    const pointer = {
      schema: 1 as const,
      releaseId: "0.1.0-older000",
      entry: "releases/0.1.0-older000/cli/index.js",
      version: "0.1.0",
      sourceCommit: "older000",
      buildHash: "a".repeat(64),
      activatedAt: new Date().toISOString(),
    };
    mkdirSync(path.join(fixture, "releases"), { recursive: true });
    writeFileSync(path.join(fixture, "releases", "LKG.json"), JSON.stringify(pointer));
    writeFileSync(path.join(fixture, "releases", "stub-gate-fails"), "1");

    const result = activateRelease(fixture, { quick: true });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/last-known-good release preserved/);
    expect(result.gate.steps.find(s => s.name === "tests")?.ok).toBe(false);
    expect(readReleasePointer(fixture)).toEqual(pointer);
  });

  it("successful gate promotes an immutable copy and activates it", () => {
    const result = activateRelease(fixture, { quick: true });
    expect(result.ok).toBe(true);
    const pointer = readReleasePointer(fixture);
    expect(pointer).not.toBeNull();
    const distManifest = readBuildManifest(path.join(fixture, "dist"))!;
    expect(pointer!.releaseId).toBe(`0.2.0-${distManifest.buildHash.slice(0, 8)}`);
    expect(pointer!.entry).toBe(`releases/${pointer!.releaseId}/cli/index.js`);
    expect(existsSync(path.join(fixture, pointer!.entry))).toBe(true);
    // The promoted copy is content-identical to dist (excluding the manifest).
    expect(computeTreeHash(path.join(fixture, "releases", pointer!.releaseId))).toBe(distManifest.buildHash);
    expect(result.gate.steps.map(s => s.name)).toEqual(["typecheck", "build", "manifest", "tests"]);
  });

  it("promotion refuses a dist tree modified after its build", () => {
    writeFileSync(path.join(fixture, "dist", "cli", "index.js"), "export const v = 999; // tampered after build");
    const result = promoteCurrentBuild(fixture);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/changed after the build/);
  });

  it("releaseStatus reports drift classes", () => {
    activateRelease(fixture, { quick: true });
    // Emulate a fresh dev build after activation: dist content changes and a
    // new manifest is written (dist ahead of LKG).
    writeFileSync(path.join(fixture, "dist", "cli", "index.js"), "export const v = 2; // next dev build");
    const nextManifest = JSON.parse(readFileSync(path.join(fixture, "dist", "build-manifest.json"), "utf8")) as BuildManifest;
    nextManifest.buildHash = computeTreeHash(path.join(fixture, "dist"))!;
    writeFileSync(path.join(fixture, "dist", "build-manifest.json"), JSON.stringify(nextManifest, null, 2));
    // Running process still on the pre-activation build => STALE_RUNTIME.
    let status = releaseStatus(fixture, "0.1.0-older000");
    expect(status.drift).toContain("LKG_AHEAD_OF_DIST");
    expect(status.drift).toContain("STALE_RUNTIME");
    // Running process restarted onto the activated release => STALE_RUNTIME clears.
    const pointer = readReleasePointer(fixture)!;
    status = releaseStatus(fixture, pointer.releaseId);
    expect(status.drift).toEqual(["LKG_AHEAD_OF_DIST"]);
    // A repo without a manifest reports NO_BUILD_MANIFEST.
    rmSync(path.join(fixture, "dist", "build-manifest.json"));
    expect(releaseStatus(fixture, null).drift).toEqual(["NO_BUILD_MANIFEST"]);
  });
});
