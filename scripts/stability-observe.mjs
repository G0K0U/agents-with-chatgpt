#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const [releaseId, countRaw, workspaceRootArg, stateDirArg, publicHost, portRaw,
  workspaceId, pausedWorkspaceId, z2cStateDirArg] = process.argv.slice(2);
const samples = Number(countRaw);
const port = Number(portRaw);
if (!/^[A-Za-z0-9._-]+$/.test(releaseId ?? "") || !Number.isInteger(samples) || samples !== 30 ||
    !path.isAbsolute(workspaceRootArg ?? "") || !path.isAbsolute(stateDirArg ?? "") ||
    !path.isAbsolute(z2cStateDirArg ?? "") ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(publicHost ?? "") ||
    !Number.isInteger(port) || port < 1 || port > 65535 ||
    !/^[a-f0-9]{12}$/.test(workspaceId ?? "") || !/^[a-f0-9]{12}$/.test(pausedWorkspaceId ?? "")) {
  throw new Error("usage: stability-observe.mjs <release-id> 30 <workspace-root> <state-dir> <public-host> <origin-port> <workspace-id> <paused-workspace-id> <z2c-state-dir>");
}
const root = path.resolve(process.cwd());
const runtimeModule = await import(pathToFileURL(path.join(root, "releases", releaseId, "bridge", "runtime.js")).href);
const ownerModule = await import(pathToFileURL(path.join(root, "releases", releaseId, "bridge", "state-owner.js")).href);
const stateDir = path.resolve(stateDirArg);
const z2cDir = path.resolve(z2cStateDirArg);
const hostname = `https://${publicHost}`;
const expected = runtimeModule.readRuntimeState(workspaceId, stateDir);
if (!expected?.pid || path.resolve(expected.workspaceRoot).toLowerCase() !== path.resolve(workspaceRootArg).toLowerCase()) {
  throw new Error("stability runtime pointer or workspace binding missing");
}
let expectedInstance = null;
const failures = [];
const resourcePoints = [];

async function getHealth(url) {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8_000) });
  const body = await response.text();
  if (response.status !== 200 || body.length > 64 * 1024) throw new Error("health_http_or_size");
  return JSON.parse(body);
}

function resource(pid) {
  if (process.platform !== "win32") return null;
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const statement = `(Get-Process -Id ${pid} -ErrorAction Stop | Select-Object Id,PrivateMemorySize64,Handles | ConvertTo-Json -Compress)`;
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", statement], {
    encoding: "utf8", timeout: 5_000, windowsHide: true,
  });
  if (result.status !== 0) return null;
  const value = JSON.parse(result.stdout);
  return { privateBytes: value.PrivateMemorySize64, handles: value.Handles };
}

for (let i = 0; i < samples; i++) {
  try {
    const [local, publicly, z2c, challenge] = await Promise.all([
      getHealth(`http://127.0.0.1:${port}/health`),
      getHealth(`${hostname}/health`),
      getHealth("http://127.0.0.1:8766/health"),
      fetch(`${hostname}/mcp`, { redirect: "manual", signal: AbortSignal.timeout(8_000) }),
    ]);
    if (local.status !== "ok" || publicly.status !== "ok" ||
        local.workspaceId !== workspaceId || publicly.workspaceId !== workspaceId ||
        local.release?.releaseId !== releaseId || publicly.release?.releaseId !== releaseId ||
        !local.instanceId || local.instanceId !== publicly.instanceId ||
        z2c.status !== "ok" || z2c.provider !== "healthy" || challenge.status !== 401) {
      throw new Error("health_identity_or_mcp");
    }
    await challenge.body?.cancel();
    expectedInstance ??= local.instanceId;
    if (local.instanceId !== expectedInstance) throw new Error("unexpected_instance_change");
    const rows = runtimeModule.getSystemProcessInspector().list();
    if (!rows) throw new Error("process_inventory_unavailable");
    const bridgeListeners = rows.filter((row) => row.listeningPorts.includes(port));
    const z2cListeners = rows.filter((row) => row.listeningPorts.includes(8766));
    if (bridgeListeners.length !== 1 || bridgeListeners[0].pid !== expected.pid || z2cListeners.length !== 1) {
      throw new Error("duplicate_or_missing_listener");
    }
    const owner = ownerModule.readStateDomainOwnerStatus(stateDir, { list: () => rows });
    if (owner.state !== "active" || owner.owner?.pid !== expected.pid ||
        owner.owner?.generation !== expected.stateDomainGeneration) throw new Error("owner_generation_changed");
    const pointer = runtimeModule.readRuntimeState(workspaceId, stateDir);
    if (pointer?.pid !== expected.pid || pointer?.stateDomainGeneration !== expected.stateDomainGeneration) {
      throw new Error("runtime_generation_changed");
    }
    const queue = JSON.parse(fs.readFileSync(path.join(stateDir, "queues", `${pausedWorkspaceId}.json`), "utf8"));
    if (queue.paused !== true || fs.existsSync(path.join(stateDir, "locks", `${pausedWorkspaceId}.json`))) {
      throw new Error("engineering_queue_or_writer_changed");
    }
    const z2cState = JSON.parse(fs.readFileSync(path.join(z2cDir, "state.json"), "utf8"));
    for (const id of [workspaceId, pausedWorkspaceId]) {
      const q = z2cState.queues?.[id];
      if (q?.activeTask || (q?.queuedTaskIds?.length ?? 0) !== 0) throw new Error("historical_z2c_queue_dispatched");
    }
    if ([0, 14, 29].includes(i)) resourcePoints.push({ sample: i + 1, ...resource(expected.pid) });
  } catch (error) {
    failures.push({ sample: i + 1, reason: String(error?.message ?? error).slice(0, 80) });
  }
  if (i + 1 < samples) await new Promise((resolve) => setTimeout(resolve, 1000));
}
const start = resourcePoints[0];
const end = resourcePoints.at(-1);
const resourceDelta = start && end && Number.isFinite(start.privateBytes) && Number.isFinite(end.privateBytes) &&
  Number.isFinite(start.handles) && Number.isFinite(end.handles) ? {
    privateBytes: end.privateBytes - start.privateBytes,
    handles: end.handles - start.handles,
  } : null;
const result = { ok: failures.length === 0, samples, failures: failures.length,
  failureDetails: failures, releaseId, pid: expected.pid, instanceId: expectedInstance,
  resourcePoints,
  resourceDelta,
};
console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 1;
