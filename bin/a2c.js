#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist", "cli", "index.js");
const root = path.resolve(here, "..");
const pointerFile = path.join(root, "releases", "LKG.json");
let activeEntry = null;
if (existsSync(pointerFile)) {
  const pointer = JSON.parse(readFileSync(pointerFile, "utf8"));
  const expected = `releases/${pointer.releaseId}/cli/index.js`;
  if (pointer.schema !== 1 || !/^[a-zA-Z0-9._-]+$/.test(pointer.releaseId) || pointer.entry !== expected) {
    throw new Error("Invalid LKG pointer; refusing mutable dist fallback");
  }
  activeEntry = path.join(root, pointer.entry);
  const manifest = JSON.parse(readFileSync(path.join(path.dirname(activeEntry), "..", "build-manifest.json"), "utf8"));
  if (manifest.buildHash !== pointer.buildHash || !existsSync(activeEntry)) throw new Error("LKG release unavailable or mismatched");
}

if (activeEntry) {
  await import(pathToFileURL(activeEntry).href);
} else if (existsSync(dist)) {
  await import(pathToFileURL(dist).href);
} else {
  // dev fallback: run TypeScript sources through the tsx ESM loader
  const entry = path.join(here, "..", "src", "cli", "index.ts");
  const result = spawnSync(process.execPath, ["--import", "tsx/esm", entry, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
