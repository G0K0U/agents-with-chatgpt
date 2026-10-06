#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { probeExistingAuthorizedMcp } from "./oauth-readonly-probe.mjs";

const [mode, releaseId, workspaceRootArg, stateDirArg, publicHost, portArg, workspaceId, oldPidArg] = process.argv.slice(2);
const port = Number(portArg);
if (!["preflight", "post"].includes(mode) || !/^[A-Za-z0-9._-]+$/.test(releaseId ?? "") ||
    !path.isAbsolute(workspaceRootArg ?? "") || !path.isAbsolute(stateDirArg ?? "") ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(publicHost ?? "") ||
    !Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{12}$/.test(workspaceId ?? "")) {
  throw new Error("usage: live-acceptance.mjs <preflight|post> <release-id> <workspace-root> <state-dir> <public-host> <origin-port> <workspace-id> [old-pid]");
}
const root = path.resolve(process.cwd());
const stateDir = path.resolve(stateDirArg);
const workspaceRoot = path.resolve(workspaceRootArg);
const publicBase = `https://${publicHost}`;
const localBase = `http://127.0.0.1:${port}`;
const runtimeDir = mode === "post" ? path.join(root, "releases", releaseId) : path.join(root, "dist");
const runtimeModule = await import(pathToFileURL(path.join(runtimeDir, "bridge", "runtime.js")).href);
const ownerModule = await import(pathToFileURL(path.join(runtimeDir, "bridge", "state-owner.js")).href);

async function boundedJson(url) {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8_000) });
  const body = await response.text();
  if (body.length > 64 * 1024) throw new Error("live health response exceeded its size limit");
  if (response.status !== 200) throw new Error(`live health HTTP ${response.status}`);
  return JSON.parse(body);
}

const pointer = runtimeModule.readRuntimeState(workspaceId, stateDir);
if (!pointer || pointer.port !== port || !pointer.adminToken || pointer.adminTokenKnown === false) {
  throw new Error("live runtime pointer, fixed origin, or admin credential missing");
}
const rows = runtimeModule.getSystemProcessInspector().list();
const processInfo = rows?.find((row) => row.pid === pointer.pid);
const owner = ownerModule.readStateDomainOwnerStatus(stateDir, { list: () => rows });
if (!rows || !processInfo || owner.state !== "active" || owner.owner?.pid !== pointer.pid ||
    owner.owner?.generation !== pointer.stateDomainGeneration ||
    owner.owner?.processStartIdentity !== processInfo.processStartIdentity ||
    !runtimeModule.isOwnedBridgeProcess(processInfo, workspaceId, workspaceRoot) ||
    !processInfo.listeningPorts.includes(port)) {
  throw new Error("live process/state owner/listener identity is unproven");
}
const [local, publicly] = await Promise.all([boundedJson(`${localBase}/health`), boundedJson(`${publicBase}/health`)]);
if (local.status !== "ok" || publicly.status !== "ok" ||
    local.workspaceId !== workspaceId || publicly.workspaceId !== workspaceId) {
  throw new Error("local/public health workspace identity mismatch");
}
const unauthenticated = await fetch(`${publicBase}/mcp`, { redirect: "manual", signal: AbortSignal.timeout(8_000) });
if (unauthenticated.status !== 401) throw new Error(`public MCP unauthenticated status ${unauthenticated.status}`);

if (mode === "preflight") {
  const lkg = JSON.parse(fs.readFileSync(path.join(root, "releases", "LKG.json"), "utf8"));
  if (lkg.releaseId === releaseId || !processInfo.commandLine.includes(lkg.releaseId)) {
    throw new Error("preflight live process is not the expected old LKG");
  }
  console.log(JSON.stringify({ ok: true, stage: mode, releaseId: lkg.releaseId, pid: pointer.pid,
    port, ownerStartIdentity: processInfo.processStartIdentity,
    localHealth: 200, publicHealth: 200, unauthenticatedMcp: 401,
    publicWorkspaceMatched: true }));
} else {
  const oldPid = Number(oldPidArg);
  if (!Number.isInteger(oldPid) || oldPid <= 0 || oldPid === pointer.pid) throw new Error("old PID not replaced");
  const lkg = JSON.parse(fs.readFileSync(path.join(root, "releases", "LKG.json"), "utf8"));
  if (lkg.releaseId !== releaseId || !processInfo.commandLine.includes(releaseId) ||
      local.release?.releaseId !== releaseId || publicly.release?.releaseId !== releaseId ||
      local.release?.buildParity !== "ok" || local.release?.sourceParity !== "ok" ||
      publicly.release?.buildParity !== "ok" || publicly.release?.sourceParity !== "ok" ||
      typeof local.instanceId !== "string" || local.instanceId.length < 16 ||
      publicly.instanceId !== local.instanceId) {
    throw new Error("candidate release or local/public instance identity mismatch");
  }
  const old = rows.find((row) => row.pid === oldPid);
  if (old?.listeningPorts.includes(port)) throw new Error("old bridge still owns the fixed origin port");
  const allListeners = rows.filter((row) => row.listeningPorts.includes(port));
  if (allListeners.length !== 1 || allListeners[0].pid !== pointer.pid) throw new Error("duplicate or foreign bridge listener");
  const token = process.env.A2C_ACCEPTANCE_BEARER;
  const authenticated = token
    ? await probeExistingAuthorizedMcp({ publicBase, token, expectedWorkspaceId: workspaceId })
    : null;
  if (authenticated && !authenticated.sharedToolsPresent) throw new Error("public authenticated MCP lacks shared agent plane tools");
  console.log(JSON.stringify({ ok: true, stage: mode, releaseId, pid: pointer.pid,
    oldPid, oldBridgeStillListening: false, port, instanceId: local.instanceId,
    localHealth: 200, publicHealth: 200, unauthenticatedMcp: 401,
    authenticatedMcp: authenticated, ownerStartIdentity: processInfo.processStartIdentity }));
}
