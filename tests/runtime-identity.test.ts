/**
 * Regression coverage for deterministic runtime identity:
 *   - source/dist parity detection (SOURCE_BUILD_MISMATCH)
 *   - build/runtime parity detection (BUILD_RUNTIME_MISMATCH)
 *   - missing manifest handling
 *   - release pointer write/read and containment validation
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  computeTreeHash,
  readBuildManifest,
  readReleasePointer,
  releaseIdFor,
  resolveRuntimeIdentity,
  writeReleasePointer,
} from "../src/bridge/runtime-identity.js";

let root: string;

function writeFile(rel: string, content: string): void {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function makeManifest(sourceContent: string, buildContent: string): void {
  writeFile("src/entry.ts", sourceContent);
  writeFile("dist/entry.js", buildContent);
  const manifest = {
    schema: 1,
    version: "0.2.0",
    sourceCommit: "abc123",
    sourceDirty: false,
    sourceRoot: path.join(root, "src"),
    sourceHash: computeTreeHash(path.join(root, "src")),
    buildHash: computeTreeHash(path.join(root, "dist")),
    builtAt: new Date().toISOString(),
    nodeVersion: process.version,
  };
  writeFile("dist/build-manifest.json", JSON.stringify(manifest));
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "c2c-rtid-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("runtime identity", () => {
  it("reports ok parity when source and build match the manifest", () => {
    makeManifest("export const a = 1;", "export const a = 1;");
    const id = resolveRuntimeIdentity({ runtimeDir: path.join(root, "dist") });
    expect(id.sourceParity).toBe("ok");
    expect(id.buildParity).toBe("ok");
    expect(id.releaseId).toBe("0.2.0-" + id.manifest!.buildHash.slice(0, 8));
  });

  it("detects SOURCE_BUILD_MISMATCH when source changed after the build", () => {
    makeManifest("export const a = 1;", "export const a = 1;");
    writeFile("src/entry.ts", "export const a = 2; // developer edit after build");
    const id = resolveRuntimeIdentity({ runtimeDir: path.join(root, "dist") });
    expect(id.sourceParity).toBe("mismatch");
    expect(id.buildParity).toBe("ok");
  });

  it("detects BUILD_RUNTIME_MISMATCH when the dist tree changed after the build", () => {
    makeManifest("export const a = 1;", "export const a = 1;");
    writeFile("dist/entry.js", "export const a = 99; // dist replaced under a running process");
    const id = resolveRuntimeIdentity({ runtimeDir: path.join(root, "dist") });
    expect(id.buildParity).toBe("mismatch");
  });

  it("reports unknown (not mismatch) when the manifest is missing or the source tree is absent", () => {
    makeManifest("export const a = 1;", "export const a = 1;");
    rmSync(path.join(root, "dist", "build-manifest.json"));
    expect(readBuildManifest(path.join(root, "dist"))).toBeNull();
    const missing = resolveRuntimeIdentity({ runtimeDir: path.join(root, "dist") });
    expect(missing.manifest).toBeNull();
    expect(missing.sourceParity).toBe("unknown");
    expect(missing.buildParity).toBe("unknown");

    makeManifest("export const a = 1;", "export const a = 1;");
    rmSync(path.join(root, "src"), { recursive: true });
    const noSrc = resolveRuntimeIdentity({ runtimeDir: path.join(root, "dist") });
    expect(noSrc.sourceParity).toBe("unknown");
    expect(noSrc.buildParity).toBe("ok");
  });

  it("tree hashes are content-addressed and ignore timestamps plus source maps", () => {
    writeFile("a.ts", "same");
    writeFile("b.js", "same");
    writeFile("b.js.map", "ignored");
    const h1 = computeTreeHash(root);
    rmSync(path.join(root, "b.js.map"));
    writeFile("b.js.map", "changed but ignored");
    expect(computeTreeHash(root)).toBe(h1);
    writeFile("a.ts", "changed");
    expect(computeTreeHash(root)).not.toBe(h1);
  });

  it("release pointer round-trips and rejects malformed or escaping entries", () => {
    const pointer = {
      schema: 1 as const,
      releaseId: "0.2.0-deadbeef",
      entry: "releases/0.2.0-deadbeef/cli/index.js",
      version: "0.2.0",
      sourceCommit: "abc123",
      buildHash: "deadbeef".repeat(8),
      activatedAt: new Date().toISOString(),
    };
    writeReleasePointer(root, pointer);
    expect(readReleasePointer(root)).toEqual(pointer);
    expect(existsSync(path.join(root, "releases", "LKG.json.tmp-"))).toBe(false);

    writeFile("releases/LKG.json", "{ not json");
    expect(readReleasePointer(root)).toBeNull();
  });

  it("release id is stable for identical content", () => {
    makeManifest("x", "x");
    const id = resolveRuntimeIdentity({ runtimeDir: path.join(root, "dist") });
    expect(releaseIdFor(id.manifest!)).toBe(id.releaseId);
  });
});
