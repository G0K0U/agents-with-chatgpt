#!/usr/bin/env node
/**
 * z2c launcher: prefers the compiled CLI (dist/), falls back to tsx for
 * development checkouts (src/).
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const distCli = join(here, "..", "dist", "cli", "z2c.js");
const srcCli = join(here, "..", "src", "cli", "z2c.ts");

let nodeArgs;
let entry;
if (existsSync(distCli)) {
  nodeArgs = [distCli];
  entry = distCli;
} else if (existsSync(srcCli)) {
  nodeArgs = ["--import", "tsx", srcCli];
  entry = srcCli;
} else {
  console.error("z2c: neither dist/cli/z2c.js nor src/cli/z2c.ts found — build first (npm run build).");
  process.exit(1);
}

const child = spawn(process.execPath, [...nodeArgs, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, Z2C_BIN_ENTRY: entry },
});
child.on("exit", (code) => process.exit(code ?? 1));
