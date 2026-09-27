#!/usr/bin/env node
/**
 * z2c — the local management CLI for the Z2C service.
 *
 * Privileged actions talk to the RUNNING service over loopback using the
 * local service secret (never displayed). Secrets are never printed; only
 * fingerprints appear in status/doctor output.
 */
import { spawn } from "node:child_process";
import fs, { existsSync, openSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { loadOrCreateSecurity } from "../service/security.js";
import { existingService } from "../service/main.js";
import { Z2C_PROTOCOL_VERSION } from "../version.js";

const args = process.argv.slice(2);
const command = args[0] ?? "help";

interface LiveServiceInfo {
  healthy: boolean;
  pid: number | null;
  parentPid: number | null;
  managedBy: "supervisor" | "manual" | "none";
  commandLine: string | null;
}

/** Resolve the ACTUAL live service process on the configured port. */
async function resolveLiveService(): Promise<LiveServiceInfo> {
  const config = loadConfig();
  let healthy = false;
  try {
    const res = await fetch(`http://${config.host}:${config.port}/health`);
    healthy = res.ok;
  } catch { /* down */ }
  let pid: number | null = null;
  let parentPid: number | null = null;
  let commandLine: string | null = null;
  try {
    const { execFileSync } = await import("node:child_process");
    const conns = execFileSync("powershell.exe", ["-NoProfile", "-Command",
      `(Get-NetTCPConnection -LocalPort ${config.port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`],
      { encoding: "utf8", timeout: 15000 });
    pid = parseInt(conns.trim(), 10) || null;
    if (pid) {
      const parent = execFileSync("powershell.exe", ["-NoProfile", "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`],
        { encoding: "utf8", timeout: 15000 });
      parentPid = parseInt(parent.trim(), 10) || null;
      if (parentPid) {
        const cl = execFileSync("powershell.exe", ["-NoProfile", "-Command",
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${parentPid}').CommandLine`],
          { encoding: "utf8", timeout: 15000 });
        commandLine = cl.trim() || null;
      }
    }
  } catch { /* best effort */ }
  const managedBy = parentPid !== null && commandLine !== null && /supervisor/i.test(commandLine)
    ? "supervisor" : pid ? "manual" : "none";
  return { healthy, pid, parentPid, managedBy, commandLine };
}

function serviceMainPath(): string {
  // Compiled: dist/cli/z2c.js → dist/service/main.js; source (tsx): mirrors.
  const here = fileURLToPath(import.meta.url);
  const candidate = join(dirname(here), "..", "service", "main.js");
  if (existsSync(candidate)) return candidate;
  return here.replace(/cli[/\\]z2c\.ts$/, "service/main.ts");
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const config = loadConfig();
  const secret = loadOrCreateSecurity(config.stateDir).currentSecret().secret;
  const res = await fetch(`http://${config.host}:${config.port}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch { /* non-JSON error bodies */ }
  return { status: res.status, body: parsed };
}

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const config = loadConfig();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${config.host}:${config.port}/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function cmdStart(): Promise<void> {
  const config = loadConfig();
  // Role-aware guard: the A2C supervisor may own the service lifecycle. A
  // healthy listener on our port means either the supervisor manages it or a
  // manual instance is live — spawning a second one would fight over 8766.
  const live = await resolveLiveService();
  if (live.healthy) {
    console.log(`Z2C service already live (pid ${live.pid ?? "?"}, managed by: ${live.managedBy}). Nothing to start.`);
    console.log("To restart: z2c stop (or a2c supervisor restart when supervisor-managed), then z2c start.");
    return;
  }
  const previous = existingService(config.stateDir);
  if (previous) {
    console.log(`Stale service.json found (pid ${previous.pid} not alive); replacing.`);
  }
  if (!isAbsolute(config.zcodeCliPath) || !existsSync(config.zcodeCliPath)) {
    console.error(`ZCode agent runtime not found at ${config.zcodeCliPath} — run 'z2c doctor'.`);
    process.exit(1);
  }
  const mainPath = serviceMainPath();
  const isTs = mainPath.endsWith(".ts");
  const nodeArgs = isTs ? ["--import", "tsx", mainPath] : [mainPath];
  const logFd = openSync(join(config.stateDir, "service-out.log"), "a");
  const child = spawn(process.execPath, nodeArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, Z2C_PORT: String(config.port) },
  });
  child.unref();
  const up = await waitForHealth(45000);
  if (up) {
    console.log(`Z2C service started (pid ${child.pid}) on port ${config.port}. Protocol v${Z2C_PROTOCOL_VERSION}.`);
    console.log("Next steps: z2c workspace authorize <path>  |  z2c pair begin <deviceName>");
  } else {
    console.error(`service did not become healthy in time; see ${join(config.stateDir, "service-out.log")}`);
    process.exit(1);
  }
}

async function cmdStop(): Promise<void> {
  const config = loadConfig();
  const previous = existingService(config.stateDir);
  if (!previous) {
    console.log("Z2C service is not running.");
    return;
  }
  const { status, body } = await api("POST", "/api/admin/shutdown", { confirm: "shutdown" });
  if (status !== 200) {
    console.error(`stop failed: ${JSON.stringify(body)}`);
    process.exit(1);
  }
  console.log("Z2C service stopped.");
}

async function cmdStatus(): Promise<void> {
  const config = loadConfig();
  const pidFile = existingService(config.stateDir);
  const live = await resolveLiveService();
  console.log(live.healthy
    ? `service: LIVE pid ${live.pid} (managed by: ${live.managedBy}), port ${config.port}, protocol v${Z2C_PROTOCOL_VERSION}`
    : pidFile
      ? `service: NOT live (stale pid file: ${pidFile.pid})`
      : "service: not running");
  void pidFile;
  try {
    const { status, body } = await api("GET", "/api/status");
    if (status !== 200) throw new Error(`HTTP ${status}`);
    console.log(JSON.stringify(body, null, 2));
  } catch (err) {
    console.log(`management API unreachable: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  switch (command) {
    case "start":
      await cmdStart();
      return;
    case "stop":
      await cmdStop();
      return;
    case "status":
      await cmdStatus();
      return;
    case "pair": {
      const sub = args[1];
      if (sub === "begin") {
        const { status, body } = await api("POST", "/api/pairing/begin", { deviceName: args[2] ?? "device" });
        if (status !== 200) return fail(body);
        console.log(`Pairing request created for "${body.deviceName}".`);
        console.log(`  pairing id: ${body.pairingId}`);
        console.log(`  one-time code: ${body.code}  (5-minute TTL — share only with the device being paired)`);
        console.log(`Confirm: z2c pair confirm ${body.pairingId} <code>`);
        return;
      }
      if (sub === "confirm") {
        const { status, body } = await api("POST", "/api/pairing/confirm", { pairingId: args[2], code: args[3] });
        if (status !== 200) return fail(body);
        console.log(`Paired: clientId=${body.clientId}`);
        console.log(`Client token (shown ONCE — store it now):\n  ${body.token}`);
        console.log("The token authorizes semantic session tools ONLY in workspaces the local user authorizes.");
        return;
      }
      if (sub === "list") {
        const { body } = await api("GET", "/api/pairing/clients");
        console.log(JSON.stringify(body, null, 2));
        return;
      }
      if (sub === "revoke") {
        const { status, body } = await api("POST", "/api/pairing/revoke", { clientId: args[2] });
        if (status !== 200) return fail(body);
        console.log(`Revoked ${args[2]}.`);
        return;
      }
      return usage("usage: z2c pair begin|confirm|list|revoke");
    }
    case "workspace": {
      const sub = args[1];
      if (sub === "authorize") {
        const pathArg = args[2];
        if (!pathArg) return usage("usage: z2c workspace authorize <path> [--readonly] [--name <displayName>]");
        const write = !args.includes("--readonly");
        const nameIdx = args.indexOf("--name");
        const { status, body } = await api("POST", "/api/workspaces/authorize", {
          path: isAbsolute(pathArg) ? pathArg : resolve(pathArg),
          write,
          displayName: nameIdx >= 0 ? args[nameIdx + 1] : undefined,
        });
        if (status !== 200) return fail(body);
        console.log(JSON.stringify(body, null, 2));
        return;
      }
      if (sub === "list") {
        const { body } = await api("GET", "/api/workspaces");
        console.log(JSON.stringify(body, null, 2));
        return;
      }
      if (sub === "revoke") {
        const { status, body } = await api("POST", "/api/workspaces/revoke", { workspaceId: args[2] });
        if (status !== 200) return fail(body);
        console.log(`Revoked ${args[2]}.`);
        return;
      }
      return usage("usage: z2c workspace authorize|list|revoke");
    }
    case "sessions": {
      const { body } = await api("GET", "/api/sessions");
      console.log(JSON.stringify(body, null, 2));
      return;
    }
    case "doctor": {
      const { runDoctor } = await import("./doctor.js");
      process.exitCode = await runDoctor();
      return;
    }
    case "version":
      console.log(`z2c protocol v${Z2C_PROTOCOL_VERSION}`);
      return;
    default:
      console.log(`z2c — ZCode-to-ChatGPT local service (protocol v${Z2C_PROTOCOL_VERSION})

  z2c start                     start the local service (detached)
  z2c stop                      stop the service
  z2c status                    service/runtime/pairing/workspace status
  z2c pair begin <name>         start a pairing request (one-time code)
  z2c pair confirm <id> <code>  confirm pairing (prints client token once)
  z2c pair list | revoke <id>   list/revoke paired clients
  z2c workspace authorize <path> [--readonly] [--name <n>]
  z2c workspace list | revoke <id>
  z2c sessions                  list owned sessions
  z2c doctor                    diagnostics (stale config, ports, health)
  z2c version`);
      return;
  }
}

function usage(message: string): never {
  console.error(message);
  process.exit(2);
}

function fail(body: unknown): never {
  console.error(`error: ${(body as { error?: string })?.error ?? JSON.stringify(body)}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`z2c: ${(err as Error).message}`);
  process.exit(1);
});
