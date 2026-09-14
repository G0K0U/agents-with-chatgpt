#!/usr/bin/env node
// Post-build step: record deterministic build identity into dist/build-manifest.json.
// Runs after `tsc` so the dist tree is final. See src/bridge/runtime-identity.ts.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "dist");
const srcDir = path.join(repoRoot, "src");
const MANIFEST_NAME = "build-manifest.json";

function collectFiles(root, out) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) collectFiles(full, out);
    else if (entry.isFile() && entry.name !== MANIFEST_NAME && !entry.name.endsWith(".map")) out.push(full);
  }
}

function treeHash(root) {
  if (!existsSync(root)) return null;
  const files = [];
  collectFiles(root, files);
  if (files.length === 0) return null;
  const hashed = files.sort().map((file) => ({
    rel: path.relative(root, file).replaceAll("\\", "/"),
    digest: createHash("sha256").update(readFileSync(file)).digest("hex"),
  }));
  const hasher = createHash("sha256");
  for (const { rel, digest } of hashed) hasher.update(`${rel}:${digest}\n`);
  return hasher.digest("hex");
}

function git(args) {
  try {
    return execSync(`git ${args}`, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const buildHash = treeHash(distDir);
const sourceHash = treeHash(srcDir);
if (!buildHash || !sourceHash) {
  console.error("write-build-manifest: dist/ or src/ missing; refusing to write a manifest");
  process.exit(1);
}
const commit = git("rev-parse HEAD");
const dirty = git("status --porcelain") !== "" && git("status --porcelain") !== null;
const manifest = {
  schema: 1,
  version: pkg.version,
  sourceCommit: commit,
  sourceDirty: Boolean(dirty),
  sourceRoot: srcDir,
  sourceHash,
  buildHash,
  builtAt: new Date().toISOString(),
  nodeVersion: process.version,
};
writeFileSync(path.join(distDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8" });
console.log(`build manifest: ${manifest.version} build=${manifest.buildHash.slice(0, 8)} source=${manifest.sourceHash.slice(0, 8)}${manifest.sourceDirty ? " (dirty)" : ""}`);
