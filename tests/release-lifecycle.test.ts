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
import { installationRoot, computeSourceTreeHash, computeTreeHash, readBuildManifest, readReleasePointer, resolveRuntimeIdentity, writeReleasePointer, type BuildManifest } from "../src/bridge/runtime-identity.js";
import { activateRelease, installActivatedRelease, promoteCurrentBuild, releaseStatus, rollbackRelease } from "../src/process/release.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let fixture: string;

function makeFakeRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "c2c-rel-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "src", "cli"), { recursive: true });
  mkdirSync(path.join(root, "dist", "cli"), { recursive: true });
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(path.join(root, "src", "entry.ts"), "export const v = 1;\n");
  writeFileSync(path.join(root, "src", "cli", "index.ts"), "export const v = 1;\n");
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
    sourceHash: computeSourceTreeHash(path.join(root, "src"))!,
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
  it("installs the exact clean activated tree with a validated previous release for rollback", () => {
    const target = makeFakeRepo();
    // The Windows temp volume used by CI may not record ownership. Scope the
    // Git trust exception to this child-process test, never global config.
    const gitConfig = [process.env.GIT_CONFIG_COUNT, process.env.GIT_CONFIG_KEY_0, process.env.GIT_CONFIG_VALUE_0];
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "safe.directory";
    process.env.GIT_CONFIG_VALUE_0 = fixture;
    try {
      writeFileSync(path.join(fixture, ".gitignore"), "node_modules/\ndist/\nreleases/\n");
      for (const args of [
        ["init", "-q"], ["config", "user.name", "Release Test"],
        ["config", "user.email", "release@example.invalid"],
        ["add", ".gitignore", "src", "scripts", "package.json"],
        ["commit", "-qm", "fixture source"],
      ]) {
        const result = spawnSync("git", args, { cwd: fixture, encoding: "utf8" });
        expect(result.status, `git ${args[0]}: ${result.stderr}`).toBe(0);
      }
      const activated = activateRelease(fixture, { quick: true });
      expect(activated.ok).toBe(true);

      writeFileSync(path.join(target, "dist", "cli", "index.js"), "export const old = true;\n");
      const oldManifest = readBuildManifest(path.join(target, "dist"))!;
      oldManifest.buildHash = computeTreeHash(path.join(target, "dist"))!;
      writeFileSync(path.join(target, "dist", "build-manifest.json"), JSON.stringify(oldManifest));
      const old = promoteCurrentBuild(target);
      expect(old.ok).toBe(true);
      writeReleasePointer(target, { schema: 1, releaseId: old.releaseId!, entry: `releases/${old.releaseId}/cli/index.js`,
        version: oldManifest.version, sourceCommit: oldManifest.sourceCommit, buildHash: oldManifest.buildHash,
        activatedAt: new Date().toISOString() });

      const installed = installActivatedRelease(fixture, target);
      expect(installed.ok).toBe(true);
      expect(installed.releaseId).toBe(activated.pointer?.releaseId);
      expect(computeTreeHash(path.join(target, "releases", installed.releaseId!))).toBe(installed.manifest?.buildHash);
      expect(readReleasePointer(target)?.sourceCommit).toBe(installed.manifest?.sourceCommit);
      expect(rollbackRelease(target).pointer?.releaseId).toBe(old.releaseId);

      writeFileSync(path.join(target, "src", "entry.ts"), "export const v = 2;\n");
      expect(installActivatedRelease(fixture, target).error).toMatch(/target source differs/);
      expect(readReleasePointer(target)?.releaseId).toBe(old.releaseId);
    } finally {
      for (const [key, value] of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"].map((key, index) => [key, gitConfig[index]] as const)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("prunes deleted compiler output before hashing and promoting a release", () => {
    const stale = ["retired-backend.js", "retired-backend.js.map", "orphan.js.map"];
    for (const name of stale) writeFileSync(path.join(fixture, "dist", name), "stale");
    writeFileSync(path.join(fixture, "dist", "cli", "index.js.map"), "current map");
    writeFileSync(path.join(fixture, "dist", "asset.json"), "{}");
    const result = activateRelease(fixture, { quick: true });
    expect(result.ok).toBe(true);
    const pointer = readReleasePointer(fixture)!;
    for (const name of stale) {
      expect(existsSync(path.join(fixture, "dist", name))).toBe(false);
      expect(existsSync(path.join(fixture, "releases", pointer.releaseId, name))).toBe(false);
    }
    expect(existsSync(path.join(fixture, "dist", "cli", "index.js.map"))).toBe(true);
    expect(existsSync(path.join(fixture, "dist", "asset.json"))).toBe(true);
    expect(computeTreeHash(path.join(fixture, "dist"))).toBe(readBuildManifest(path.join(fixture, "dist"))!.buildHash);
  });

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
    expect(pointer!.releaseId).toBe(`0.2.0-${distManifest.buildHash.slice(0, 8)}-${distManifest.sourceHash.slice(0, 8)}`);
    expect(pointer!.entry).toBe(`releases/${pointer!.releaseId}/cli/index.js`);
    expect(existsSync(path.join(fixture, pointer!.entry))).toBe(true);
    // The promoted copy is content-identical to dist (excluding the manifest).
    expect(computeTreeHash(path.join(fixture, "releases", pointer!.releaseId))).toBe(distManifest.buildHash);
    expect(result.gate.steps.map(s => s.name)).toEqual(["typecheck", "build", "manifest", "tests"]);
    expect(distManifest.sourceRoot).toBe("src");
    expect(resolveRuntimeIdentity({ runtimeDir: path.join(fixture, "releases", pointer!.releaseId) }).sourceParity).toBe("ok");
  });

  it("reuses an identical release without overwriting it and refuses a tampered collision", () => {
    const first = promoteCurrentBuild(fixture);
    expect(first.ok).toBe(true);
    const target = path.join(fixture, "releases", first.releaseId!);
    const manifestFile = path.join(target, "build-manifest.json");
    const originalManifest = readFileSync(manifestFile, "utf8");
    const second = promoteCurrentBuild(fixture);
    expect(second.ok).toBe(true);
    expect(readFileSync(manifestFile, "utf8")).toBe(originalManifest);

    writeFileSync(path.join(target, "cli", "index.js"), "tampered");
    const refused = promoteCurrentBuild(fixture);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/already exists with different or incomplete content/);
    expect(readFileSync(path.join(target, "cli", "index.js"), "utf8")).toBe("tampered");
  });

  it("gives changed source provenance a distinct immutable release when emitted bytes match", () => {
    const first = promoteCurrentBuild(fixture);
    expect(first.ok).toBe(true);
    const firstManifest = readBuildManifest(path.join(fixture, "dist"))!;
    writeFileSync(path.join(fixture, "src", "entry.ts"), "export const v = 1; // source comment\n");
    const script = path.join(fixture, "scripts", "write-build-manifest.mjs");
    expect(spawnSync(process.execPath, [script], { cwd: fixture }).status).toBe(0);
    const secondManifest = readBuildManifest(path.join(fixture, "dist"))!;
    expect(secondManifest.buildHash).toBe(firstManifest.buildHash);
    expect(secondManifest.sourceHash).not.toBe(firstManifest.sourceHash);
    const second = promoteCurrentBuild(fixture);
    expect(second.ok).toBe(true);
    expect(second.releaseId).not.toBe(first.releaseId);
    expect(existsSync(path.join(fixture, "releases", first.releaseId!, "cli", "index.js"))).toBe(true);
  });

  it("real build manifest keeps the same source identity after adding an unshipped backup", () => {
    const script = path.join(fixture, "scripts", "write-build-manifest.mjs");
    expect(spawnSync(process.execPath, [script], { cwd: fixture }).status).toBe(0);
    const before = readBuildManifest(path.join(fixture, "dist"))!;
    writeFileSync(path.join(fixture, "src", "entry.ts.pre-local-repair.bak"), "local backup\n");
    expect(spawnSync(process.execPath, [script], { cwd: fixture }).status).toBe(0);
    const after = readBuildManifest(path.join(fixture, "dist"))!;
    expect(after.sourceHash).toBe(before.sourceHash);
    expect(resolveRuntimeIdentity({ runtimeDir: path.join(fixture, "dist") }).sourceParity).toBe("ok");
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


it("resolves one installation from control sources, dist and served releases", () => {
  for (const tree of ["src", "dist", "releases/0.2.0-old", "releases/0.2.0-new"]) {
    expect(installationRoot(path.join(fixture, tree))).toBe(fixture);
  }
});

it("autostart launcher follows each activated LKG and rejects broken pointers", () => {
  mkdirSync(path.join(fixture, "bin"), { recursive: true });
  writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(path.join(fixture, "bin/c2c.js"), readFileSync(path.join(repoRoot, "bin/c2c.js")));
  const invoke = () => spawnSync(process.execPath, [path.join(fixture, "bin/c2c.js"), "supervisor", "run"], { encoding: "utf8" });
  for (const id of ["0.2.0-first", "0.2.0-second"]) {
    const dir = path.join(fixture, "releases", id);
    mkdirSync(path.join(dir, "cli"), { recursive: true });
    writeFileSync(path.join(dir, "cli/index.js"), `console.log(${JSON.stringify(id)});`);
    writeFileSync(path.join(dir, "build-manifest.json"), JSON.stringify({ buildHash: id }));
    writeFileSync(path.join(fixture, "releases/LKG.json"), JSON.stringify({ schema: 1, releaseId: id, entry: `releases/${id}/cli/index.js`, buildHash: id }));
    expect(invoke().stdout.trim()).toBe(id);
  }
  writeFileSync(path.join(fixture, "releases/LKG.json"), JSON.stringify({ schema: 1, releaseId: "../escape", entry: "dist/cli/index.js" }));
  expect(invoke().status).not.toBe(0);
});

it("release rollback repoints to the validated previous activation and refuses unsafe pointers", () => {
  const buildPointer = (id, buildHash) => ({
    schema: 1, releaseId: id, entry: `releases/${id}/cli/index.js`, version: "0.2.0",
    sourceCommit: null, buildHash, activatedAt: new Date().toISOString(),
  });
  const stage = (id, buildHash) => {
    const dir = path.join(fixture, "releases", id);
    mkdirSync(path.join(dir, "cli"), { recursive: true });
    writeFileSync(path.join(dir, "cli/index.js"), `console.log(${JSON.stringify(id)});`);
    writeFileSync(path.join(dir, "build-manifest.json"), JSON.stringify({ schema: 1, buildHash, sourceHash: "source-" + buildHash }));
    return buildPointer(id, buildHash);
  };
  const first = stage("0.2.0-first", "hash-first");
  const second = stage("0.2.0-second", "hash-second");
  // Simulate two activations: current = second, previous = first.
  writeFileSync(path.join(fixture, "releases/LKG.json"), JSON.stringify(second));
  writeFileSync(path.join(fixture, "releases/LKG.previous.json"), JSON.stringify(first));
  const rolled = rollbackRelease(fixture);
  expect(rolled.ok).toBe(true);
  expect(readReleasePointer(fixture)?.releaseId).toBe("0.2.0-first");
  // Bounded A/B swap: the pre-rollback pointer is retained as previous.
  expect(rollbackRelease(fixture).pointer?.releaseId).toBe("0.2.0-second");
  // A malformed previous pointer is refused, never activated.
  writeFileSync(path.join(fixture, "releases/LKG.previous.json"), JSON.stringify({ schema: 1, releaseId: "../escape", entry: "dist/cli/index.js" }));
  const refused = rollbackRelease(fixture);
  expect(refused.ok).toBe(false);
  expect(refused.error).toMatch(/refusing/);
  // A missing previous file reports nothing to roll back to.
  rmSync(path.join(fixture, "releases/LKG.previous.json"));
  expect(rollbackRelease(fixture).ok).toBe(false);
  // Rollback repoints the stable launcher within one invocation.
  writeFileSync(path.join(fixture, "releases/LKG.previous.json"), JSON.stringify(first));
  expect(rollbackRelease(fixture).ok).toBe(true);
  mkdirSync(path.join(fixture, "bin"), { recursive: true });
  writeFileSync(path.join(fixture, "bin/c2c.js"), readFileSync(path.join(repoRoot, "bin/c2c.js")));
  const out = spawnSync(process.execPath, [path.join(fixture, "bin/c2c.js"), "supervisor", "run"], { encoding: "utf8" });
  expect(out.stdout.trim()).toBe("0.2.0-first");
});
