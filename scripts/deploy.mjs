#!/usr/bin/env node
/**
 * One-command local deployment for a fresh clone of Agents with ChatGPT.
 *
 *   Windows:  node scripts\deploy.mjs
 *   POSIX:    node scripts/deploy.mjs
 *
 * What it does (idempotent — safe to re-run at any time):
 *   1. checks prerequisites (Node.js >= 22, git, pnpm via corepack)
 *   2. installs dependencies (pnpm install --frozen-lockfile)
 *   3. builds (pnpm build)
 *   4. installs and builds the bundled Z2C companion
 *   5. hands off to `a2c deploy`: initializes local state, starts/reuses the
 *      local bridge, runs health checks, and prints the success summary plus
 *      explicit next actions.
 *
 * TUNNEL / PUBLIC-HOST BOUNDARY: this script never creates Cloudflare
 * tunnels, DNS records, or public hostnames, and never touches an existing
 * tunnel configuration. If no public connection has been chosen, `a2c deploy`
 * prints a HUMAN ACTION REQUIRED section with the exact commands — those stay
 * human-operated on purpose.
 *
 * Options are passed through to `a2c deploy`:
 *   --workspace <path>     workspace root to deploy for (default: cwd)
 *   --state-dir <path>     explicit state directory
 *   --autostart            opt in to the Windows logon autostart task
 *   --no-start-bridge      checks and tunnel gate only
 *   --skip-install         skip pnpm install (already installed)
 *   --skip-build           skip pnpm build (already built)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PASSTHROUGH = new Set(["--workspace", "--state-dir", "--autostart", "--no-start-bridge", "--json"]);
const LOCAL_ONLY = new Set(["--skip-install", "--skip-build"]);

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  printHelp();
  process.exit(0);
}

const passthroughArgs = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (!PASSTHROUGH.has(arg) && !LOCAL_ONLY.has(arg)) {
    fail(`unknown option: ${arg} (supported: ${[...PASSTHROUGH, ...LOCAL_ONLY].join(", ")})`);
  }
  if (!PASSTHROUGH.has(arg)) continue; // local-only flags are consumed here
  passthroughArgs.push(arg);
  if (arg === "--workspace" || arg === "--state-dir") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) fail(`option ${arg} needs a value`);
    passthroughArgs.push(value);
    index += 1;
  }
}

const skipInstall = args.includes("--skip-install");
const skipBuild = args.includes("--skip-build");
const steps = [];
const startedAt = Date.now();

step("node >= 22", checkNode(), `found Node.js ${process.versions.node}; install the LTS from https://nodejs.org and re-run`);
step("git on PATH", commandWorks("git", ["--version"]), "git not found — needed for update/redeploy (https://git-scm.com)");
const pnpm = resolvePnpm();
step("pnpm available", Boolean(pnpm.command), pnpm.detail);

if (skipInstall) {
  step("dependencies", fs.existsSync(path.join(repoRoot, "node_modules", "express", "package.json")), "node_modules missing; re-run without --skip-install");
} else {
  run(pnpm.command, ["install", "--frozen-lockfile"], pnpm.prefix, "pnpm install");
  step("dependencies installed", true, "pnpm install --frozen-lockfile");
}

if (skipBuild) {
  step("build output", fs.existsSync(path.join(repoRoot, "dist", "cli", "index.js")), "dist missing; re-run without --skip-build");
} else {
  run(pnpm.command, ["run", "build"], pnpm.prefix, "pnpm build");
  step("build completed", fs.existsSync(path.join(repoRoot, "dist", "cli", "index.js")), "dist/cli/index.js still missing after build");
}

// The published A2C distribution includes Z2C source. A missing companion
// means the package is incomplete, so the GLM lane must not be advertised.
const z2cDir = path.join(repoRoot, "z2c");
if (fs.existsSync(path.join(z2cDir, "package.json"))) {
  run("npm", ["ci", "--no-audit", "--no-fund"], "", "z2c install", z2cDir);
  run("npm", ["run", "build"], "", "z2c build", z2cDir);
  const built = fs.existsSync(path.join(z2cDir, "dist", "service", "main.js"));
  step("Z2C companion built", built, "z2c/dist/service/main.js missing; the GLM (ZCode) lane will stay unavailable");
} else {
  step("Z2C companion present", false, "z2c/package.json missing from this distribution");
}

console.log("");
console.log("Prerequisites and build ready; running the local deployment checks…");
console.log("");
const deploy = spawnSync(process.execPath, [path.join(repoRoot, "bin", "a2c.js"), "deploy", ...passthroughArgs], {
  cwd: repoRoot,
  stdio: "inherit",
});
console.log("");
console.log(`deploy finished in ${Math.round((Date.now() - startedAt) / 1000)}s (${steps.filter((s) => s.ok).length}/${steps.length} setup steps ok)`);
process.exit(deploy.status ?? 1);

// ---------------------------------------------------------------- helpers

function step(name, ok, detail) {
  steps.push({ name, ok, detail });
  const mark = ok ? "OK  " : "FAIL";
  console.log(`[${mark}] ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) fail(`step failed: ${name}`);
}

function run(command, args_, prefix, label, cwd = repoRoot) {
  const result = spawnSync(command, [...prefix, ...args_], {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    fail(`${label} failed (exit ${result.status}) — fix the error above and re-run; re-running is safe.`);
  }
}

function checkNode() {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  return major >= 22;
}

function commandWorks(command, args_) {
  try {
    return spawnSync(command, args_, { stdio: "ignore", timeout: 15_000, shell: process.platform === "win32" }).status === 0;
  } catch {
    return false;
  }
}

/** pnpm directly, else through corepack (reads packageManager from package.json; no shims needed). */
function resolvePnpm() {
  if (commandWorks("pnpm", ["--version"])) return { command: "pnpm", prefix: [], detail: "pnpm on PATH" };
  if (commandWorks("corepack", ["--version"])) {
    return { command: "corepack", prefix: ["pnpm"], detail: "using corepack pnpm (from package.json packageManager)" };
  }
  return { command: null, prefix: [], detail: "no pnpm and no corepack; enable corepack (`corepack enable`) or install pnpm, then re-run" };
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function printHelp() {
  console.log(`One-command local deployment for a fresh clone.

  Windows:  node scripts\\deploy.mjs
  POSIX:    node scripts/deploy.mjs

Automates: prerequisite checks, dependency install, build, local state init,
local bridge start + health checks, and prints next actions. Re-running is
always safe (idempotent).

Options (passed to a2c deploy unless noted):
  --workspace <path>   workspace root to deploy for (default: current directory)
  --state-dir <path>   explicit state directory
  --autostart          opt in to the Windows logon autostart task
  --no-start-bridge    checks and tunnel gate only (no bridge start)
  --json               machine-readable deploy report
  --skip-install       skip pnpm install
  --skip-build         skip pnpm build

Tunnels/domains are NEVER configured automatically: if no public connection
has been chosen you get an explicit HUMAN ACTION REQUIRED section with the
exact commands to run yourself.`);
}
