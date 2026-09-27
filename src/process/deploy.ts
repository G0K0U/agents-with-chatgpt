import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureBridge, findSharedBridgeObservation } from "./daemon.js";
import { reconcileStateDomains } from "../bridge/state-migration.js";
import { Workspace } from "../workspace/manager.js";
import {
  isNamedTunnelReady,
  needsTunnelChoice,
  readTunnelState,
  type TunnelPreference,
} from "../tunnel/state.js";
import { detectTunnelBinaries } from "../tunnel/detect.js";
import { ensureDir, getStateDir } from "../config/paths.js";
import { resolveZ2cRepoRoot } from "../config/z2c-repo.js";
import { installationRoot } from "../bridge/runtime-identity.js";
import { PRODUCT_NAME, VERSION } from "../version.js";

/**
 * One-command local deployment check/orchestration for a fresh clone.
 *
 *   prereqs -> local bridge (reuse or start) -> local health -> tunnel gate
 *   -> success summary + explicit human next actions
 *
 * PUBLIC-CONNECTION BOUNDARY: this module only READS tunnel configuration
 * (tunnel state files, cloudflared binary presence). It never provisions a
 * tunnel, never creates DNS records, never starts cloudflared, and never
 * overwrites an existing tunnel preference. Choosing a public connection
 * (`a2c tunnel choose ...`), including the Cloudflare login that a stable
 * hostname requires, stays a human-operated step — deploy only prints the
 * exact commands.
 */

export const HUMAN_ACTION_HEADER = "HUMAN ACTION REQUIRED";

export interface DeployCheck {
  id: string;
  ok: boolean;
  /** A failed fatal check fails the whole deployment. */
  fatal: boolean;
  detail: string;
}

export interface TunnelGateReport {
  preference: TunnelPreference;
  needsChoice: boolean;
  namedReady: boolean;
  /** Stable hostname when a named tunnel is configured; never a secret. */
  hostname: string | null;
  cloudflaredInstalled: boolean;
  humanActionRequired: boolean;
  /** Exact, copy-paste commands the human must run themselves. */
  instructions: string[];
  /** True after the gate confirms existing configuration was left untouched. */
  existingConfigurationPreserved: boolean;
}

export interface DeployReport {
  ok: boolean;
  product: string;
  version: string;
  platform: string;
  repoRoot: string;
  stateDir: string;
  workspace: { id: string; name: string; root: string };
  checks: DeployCheck[];
  bridge: {
    started: boolean;
    reused: boolean;
    port: number | null;
    localMcpOk: boolean | null;
  };
  z2cLane: { available: boolean; detail: string };
  tunnelGate: TunnelGateReport;
  autostart: { requested: boolean; registered: boolean; detail: string };
  nextActions: string[];
}

export function readTunnelGate(workspaceId: string, stateDir?: string): TunnelGateReport {
  // Read-only by design: no writeTunnelState, no tunnel provisioning here.
  const state = readTunnelState(workspaceId, stateDir);
  const { cloudflared } = detectTunnelBinaries();
  const needsChoice = needsTunnelChoice(state);
  const namedReady = isNamedTunnelReady(state);
  const configured = state.preference !== "unset" || Boolean(state.askedAt);
  const instructions: string[] = [];
  if (needsChoice) {
    instructions.push(
      "No public connection has been chosen for this workspace (one-time decision).",
      "Run exactly ONE of the following yourself, or let the guided Skill setup ask you later:",
      `  Temporary address (no Cloudflare account needed): node bin${path.sep}a2c.js tunnel choose --mode quick`,
      `  Stable hostname (requires your Cloudflare login in a browser): node bin${path.sep}a2c.js tunnel choose --mode named --zone <your-domain.com>`,
      "Deploy stays in local mode until then; nothing public is exposed automatically."
    );
  } else if (namedReady) {
    instructions.push(
      `Existing stable hostname configuration was detected and left untouched: ${state.hostname}`,
      "To bring the public connection up, run `a2c restart --tunnel` yourself (or restart via the supervisor)."
    );
  } else {
    instructions.push(
      "Existing temporary-address (quick) configuration was detected and left untouched.",
      "To upgrade to a stable hostname later, run: a2c tunnel choose --mode named --zone <your-domain.com>"
    );
  }
  return {
    preference: state.preference,
    needsChoice,
    namedReady,
    hostname: state.hostname ?? null,
    cloudflaredInstalled: Boolean(cloudflared),
    humanActionRequired: needsChoice,
    instructions,
    existingConfigurationPreserved: configured,
  };
}

function commandOnPath(command: string, args: string[]): boolean {
  try {
    return spawnSync(command, args, { timeout: 10_000, stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function checkNode(): DeployCheck {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  return {
    id: "node",
    ok: major >= 20,
    fatal: true,
    detail: `v${process.versions.node}${major >= 20 ? "" : " (Node.js >= 20 required: https://nodejs.org)"}`,
  };
}

function checkGit(): DeployCheck {
  const ok = commandOnPath("git", ["--version"]);
  return {
    id: "git",
    ok,
    fatal: false,
    detail: ok ? "available" : "not found (needed for update/redeploy, not to run)",
  };
}

function checkPnpm(): DeployCheck {
  const ok = commandOnPath("pnpm", ["--version"]) || commandOnPath("corepack", ["pnpm", "--version"]);
  return {
    id: "pnpm",
    ok,
    fatal: false,
    detail: ok ? "available" : "not found (needed for update/redeploy; scripts/deploy.mjs bootstraps it via corepack)",
  };
}

function checkDependencies(repoRoot: string): DeployCheck {
  const probes = [
    path.join(repoRoot, "node_modules", "@modelcontextprotocol", "sdk", "package.json"),
    path.join(repoRoot, "node_modules", "express", "package.json"),
  ];
  const ok = probes.every((probe) => fs.existsSync(probe));
  return {
    id: "dependencies",
    ok,
    fatal: true,
    detail: ok ? "node_modules present" : "dependencies missing; run `pnpm install --frozen-lockfile` (scripts/deploy.mjs does this)",
  };
}

function checkBuild(repoRoot: string): DeployCheck {
  const ok = fs.existsSync(path.join(repoRoot, "dist", "cli", "index.js"));
  return {
    id: "build",
    ok,
    fatal: true,
    detail: ok ? "dist/cli/index.js present" : "no build output; run `pnpm build` (scripts/deploy.mjs does this)",
  };
}

function checkZ2cLane(repoRoot: string): { available: boolean; detail: string } {
  const z2cRoot = resolveZ2cRepoRoot(repoRoot);
  const proxy = path.join(z2cRoot, "scripts", "desktop-agent-proxy.mjs");
  if (fs.existsSync(proxy)) {
    return { available: true, detail: `Z2C companion at ${z2cRoot}` };
  }
  return {
    available: false,
    detail: "Z2C companion not built — the governed GLM (ZCode) lane is unavailable; Codex and Gemini lanes are unaffected",
  };
}

export interface AutostartResult {
  registered: boolean;
  detail: string;
}

function psEscape(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Register the "A2C Bridge Supervisor" logon task using the same mechanism as
 * install/register-autostart.ps1, parameterized for this clone. Explicit
 * opt-in only (`--autostart`); never called by default.
 */
export function registerAutostartTask(opts: {
  repoRoot: string;
  workspaceRoot: string;
  stateDir: string;
}): AutostartResult {
  if (process.platform !== "win32") {
    return {
      registered: false,
      detail: "autostart registration is Windows-only; start it manually with `a2c supervisor start`",
    };
  }
  const cli = path.join(opts.repoRoot, "bin", "c2c.js");
  if (!fs.existsSync(cli)) return { registered: false, detail: `launcher missing: ${cli}` };
  const workDir = opts.repoRoot;
  const argument = `"${cli}" supervisor run --workspace "${opts.workspaceRoot}" --state-dir "${opts.stateDir}"`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$node = '${psEscape(process.execPath)}'`,
    `$action = New-ScheduledTaskAction -Execute $node -Argument '${psEscape(argument)}' -WorkingDirectory '${psEscape(workDir)}'`,
    `$user = "$env:COMPUTERNAME\\$env:USERNAME"`,
    `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user`,
    `$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive`,
    `$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries`,
    `Register-ScheduledTask -TaskName 'A2C Bridge Supervisor' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
    `if (Get-ScheduledTask -TaskName 'C2C Bridge' -ErrorAction SilentlyContinue) { Disable-ScheduledTask -TaskName 'C2C Bridge' | Out-Null }`,
    "Write-Output REGISTERED",
  ].join("\r\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  let outcome: AutostartResult;
  try {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      timeout: 90_000,
      encoding: "utf8",
    });
    const registered = result.status === 0 && (result.stdout ?? "").includes("REGISTERED");
    const tail = (result.stderr ?? result.stdout ?? "").trim().split(/\r?\n/).slice(-3).join(" | ");
    outcome = registered
      ? { registered: true, detail: "Scheduled Task 'A2C Bridge Supervisor' registered (logon, LKG-aware launcher)" }
      : { registered: false, detail: `scheduled-task registration failed: ${tail || `exit ${result.status}`}` };
  } catch (error) {
    outcome = { registered: false, detail: `powershell failed: ${(error as Error).message}` };
  }
  return outcome;
}

async function probeLocalMcp(port: number): Promise<boolean | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      signal: AbortSignal.timeout(8_000),
    });
    // 401 without a token proves both MCP routing and the OAuth gate work.
    return response.status === 401;
  } catch {
    return false;
  }
}

export interface LocalDeployOptions {
  workspaceRoot: string;
  stateDir?: string;
  /** false = report only (checks + tunnel gate); never starts a bridge. */
  startBridge: boolean;
  /** Explicit opt-in only. */
  autostart: boolean;
}

/** Read-only variant used by --no-start-bridge and tests: no processes, no state mutation beyond the state dir itself. */
export async function runLocalDeploy(opts: LocalDeployOptions): Promise<DeployReport> {
  const repoRoot = installationRoot();
  const stateDir = ensureDir(getStateDir(opts.stateDir));
  const workspace = new Workspace(opts.workspaceRoot);
  const checks: DeployCheck[] = [
    checkNode(),
    checkGit(),
    checkPnpm(),
    checkDependencies(repoRoot),
    checkBuild(repoRoot),
  ];

  const bridge: DeployReport["bridge"] = { started: false, reused: false, port: null, localMcpOk: null };
  if (opts.startBridge) {
    const before = await findSharedBridgeObservation(workspace.id, workspace.root, { stateDir });
    bridge.reused = before.state === "healthy";
    if (before.state === "stopped") {
      // Same one-time import boundary as the canonical bridge-start path.
      reconcileStateDomains({ canonicalStateDir: stateDir });
    }
    const { runtime } = await ensureBridge(opts.workspaceRoot, { stateDir });
    bridge.started = true;
    bridge.port = runtime.port;
    bridge.localMcpOk = await probeLocalMcp(runtime.port);
    checks.push({
      id: "bridge",
      ok: Boolean(bridge.localMcpOk),
      fatal: true,
      detail: bridge.localMcpOk
        ? `running on port ${runtime.port} (${bridge.reused ? "reused" : "started"}); local MCP answered 401 without a token as expected`
        : `local MCP check failed on port ${runtime.port}`,
    });
  } else {
    checks.push({ id: "bridge", ok: true, fatal: false, detail: "not started (--no-start-bridge)" });
  }

  const tunnelGate = readTunnelGate(workspace.id, stateDir);
  const autostart: DeployReport["autostart"] = {
    requested: opts.autostart,
    registered: false,
    detail: "not requested (pass --autostart to register the logon task)",
  };
  if (opts.autostart) {
    const result = registerAutostartTask({ repoRoot, workspaceRoot: workspace.root, stateDir });
    autostart.registered = result.registered;
    autostart.detail = result.detail;
    checks.push({ id: "autostart", ok: result.registered, fatal: false, detail: result.detail });
  }

  const z2cLane = checkZ2cLane(repoRoot);
  const nextActions: string[] = [...tunnelGate.instructions];
  if (bridge.localMcpOk !== false && opts.startBridge) {
    nextActions.push(
      "Connect ChatGPT (human steps: browser login + one-time pairing code): run `node bin/a2c.js setup` in this workspace, or tell your coding agent \"Set up Agents with ChatGPT\" (see skill/SKILL.md)."
    );
  }
  nextActions.push("Re-check anytime: `node bin/a2c.js status` · full diagnostics: `node bin/a2c.js doctor`.");

  const ok = checks.every((check) => check.ok || !check.fatal);
  return {
    ok,
    product: PRODUCT_NAME,
    version: VERSION,
    platform: `${process.platform} ${process.arch}`,
    repoRoot,
    stateDir,
    workspace: { id: workspace.id, name: workspace.name, root: workspace.root },
    checks,
    bridge,
    z2cLane,
    tunnelGate,
    autostart,
    nextActions,
  };
}

/** Human-readable rendering. Never prints secrets (no pairing codes, tokens, tunnel ids). */
export function renderDeployReport(report: DeployReport): string[] {
  const lines: string[] = [];
  lines.push(`${report.product} — local deploy (v${report.version}, ${report.platform})`);
  lines.push("");
  for (const check of report.checks) {
    lines.push(`${check.ok ? "✓" : check.fatal ? "✗" : "·"} ${check.id}: ${check.detail}`);
  }
  lines.push(`✓ workspace: ${report.workspace.name} (${report.workspace.root})`);
  lines.push(`✓ state dir: ${report.stateDir}`);
  lines.push(`· GLM (ZCode) lane: ${report.z2cLane.detail}`);
  lines.push("");
  if (report.tunnelGate.humanActionRequired) {
    lines.push(`=== ${HUMAN_ACTION_HEADER} ===`);
    for (const instruction of report.tunnelGate.instructions) lines.push(instruction);
  } else {
    lines.push("Public connection: existing configuration detected — deploy did not read secrets and did not change it.");
    for (const instruction of report.tunnelGate.instructions) lines.push(instruction);
  }
  lines.push("");
  lines.push("Next actions:");
  for (const action of report.nextActions) lines.push(`  - ${action}`);
  lines.push("");
  lines.push(report.ok ? "Local deployment ready." : "Local deployment INCOMPLETE — fix the ✗ items above and re-run; re-running is safe.");
  return lines;
}
