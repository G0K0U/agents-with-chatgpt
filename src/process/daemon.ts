import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, ensureDir, getDefaultStateDir, getStateDir } from "../config/paths.js";
import {
  bridgeProcessStateDir,
  clearRuntimeState,
  clearRuntimeStateAt,
  findBridgeObservation,
  findLiveBridge,
  getSystemProcessInspector,
  isBridgeServeProcess,
  isOwnedBridgeProcess,
  probeBridge,
  readRuntimeState,
  readRuntimeStateAt,
  safeProbe,
  SERVICE_NAME,
  type BridgeObservation,
  type BridgeObservationOptions,
  type BridgeProbe,
  type BridgeProcessIdentity,
  type BridgeProcessInspector,
  type HealthPayload,
  type RuntimeState,
} from "../bridge/runtime.js";
import { readStateDomainOwnerStatus, stateDomainOwnerFile, type StateDomainOwnerRecord } from "../bridge/state-owner.js";
import { readBuildManifest, readReleasePointer } from "../bridge/runtime-identity.js";
import type { TunnelStatus } from "../tunnel/provider.js";
import type { PublicProbeResult } from "../tunnel/probe.js";
import { Workspace } from "../workspace/manager.js";
import { canonicalizeWorkspaceRoot, stableWorkspaceId } from "../workspace/identity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to the CLI entry, works from dist/ and from tsx dev runs. */
function cliEntry(): { cmd: string; args: string[] } {
  // A verified last-known-good release outranks mutable dev output: a source
  // edit can never put unverified code into production until it is activated.
  const projectRoot = path.resolve(__dirname, "..", "..");
  const pointer = readReleasePointer(projectRoot);
  if (pointer) {
    const releaseRoot = path.join(projectRoot, "releases");
    const rel = path.relative(releaseRoot, path.join(projectRoot, pointer.entry));
    const entry = path.join(projectRoot, pointer.entry);
    // entry = releases/<id>/cli/index.js; the manifest sits at releases/<id>/.
    const releaseDir = path.dirname(path.dirname(entry));
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) && fs.existsSync(entry)
        && readBuildManifest(releaseDir)) {
      return { cmd: process.execPath, args: [entry] };
    }
  }
  const distEntry = path.resolve(__dirname, "..", "cli", "index.js");
  if (fs.existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry] };
  }
  // dev fallback: run TypeScript sources through the tsx ESM loader
  const tsEntry = path.join(projectRoot, "src", "cli", "index.ts");
  return { cmd: process.execPath, args: ["--import", "tsx/esm", tsEntry] };
}

export interface AuthorizedWorkspaceMetadata {
  id: string;
  name: string;
  root: string;
  enabled?: boolean;
}

export interface AdminInfo {
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
  authorizedWorkspaces?: AuthorizedWorkspaceMetadata[];
  port: number;
  publicUrl: string | null;
  tunnel: TunnelStatus;
  publicProbe: PublicProbeResult | null;
  tokenCount: number;
  pairingActive: boolean;
  pid: number;
  startedAt: string;
  stateDir?: string;
  stateDomainGeneration?: string;
}

export interface SharedBridgeObservationOptions extends BridgeObservationOptions {
  /** Test seam allowing hermetic validation of admin responses without real network calls */
  adminFetchImpl?: <T = unknown>(
    runtime: RuntimeState,
    method: "GET" | "POST",
    route: string,
    timeoutMs?: number,
    payload?: unknown
  ) => Promise<T>;
}

export type SharedBridgeObservation =
  | {
      state: "healthy";
      runtime: RuntimeState;
      shared: boolean;
      requestedWorkspace?: { id: string; root: string };
      reconciled?: boolean;
      owner?: StateDomainOwnerRecord;
      authorizedWorkspace?: AuthorizedWorkspaceMetadata;
      adminInfo?: AdminInfo;
    }
  | {
      state: "stopped";
      runtime: RuntimeState | null;
      reason: "runtime_missing" | "pid_missing";
      conflictOwner?: StateDomainOwnerRecord;
    }
  | {
      state: "unknown";
      runtime: RuntimeState | null;
      reason:
        | "probe_failed"
        | "pid_unknown"
        | "workspace_mismatch"
        | "stale_runtime"
        | "ownership_unknown"
        | "duplicate_bridges"
        | "runtime_initializing"
        | "runtime_unreadable"
        | "runtime_changed"
        | "active_owner_conflict"
        | "admin_proof_unavailable"
        | "unauthorized_workspace";
      conflictOwner?: StateDomainOwnerRecord;
    };

export interface EnsureBridgeResult {
  runtime: RuntimeState;
  spawned: boolean;
  observation?: SharedBridgeObservation;
}

export interface EnsureBridgeOptions extends SharedBridgeObservationOptions {
  port?: number;
}

export interface StopBridgeOptions extends SharedBridgeObservationOptions {
  /** A detached restart may stop only the runtime captured by its handoff. */
  expectedRuntime?: Pick<RuntimeState, "pid" | "port" | "startedAt" | "stateDomainGeneration"> & { processStartIdentity?: string };
  /** Test seam; production always uses process.kill after revalidation. */
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
}

/** Build the only serve invocation used by a detached bridge child. */
export function bridgeServeArgv(
  cliArgs: readonly string[],
  workspaceRoot: string,
  stateDir: string,
  port?: number
): string[] {
  return [
    ...cliArgs,
    "serve",
    "--workspace",
    workspaceRoot,
    "--state-dir",
    stateDir,
    ...(port ? ["--port", String(port)] : []),
  ];
}

const STOP_GRACE_MS = 20_000;
const STOP_FALLBACK_MS = 5_000;

function sameStateDir(left: string | undefined, right: string): boolean {
  if (!left) return true;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" || process.platform === "darwin"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForBridgeStop(runtime: RuntimeState, timeoutMs: number, probe: BridgeProbe, inspector?: BridgeProcessInspector): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = runtime.stateDir
      ? readRuntimeStateAt(runtime.workspaceId, runtime.stateDir)
      : readRuntimeState(runtime.workspaceId);
    const currentIsReplacement = Boolean(
      current && (current.pid !== runtime.pid || current.startedAt !== runtime.startedAt)
    );
    const health = await safeProbe(probe, runtime.port);
    const oldBridgeStillServes = health?.workspaceId === runtime.workspaceId;
    const alive = inspector ? (inspector.list()?.some(row => row.pid === runtime.pid) ?? true) : isProcessAlive(runtime.pid);
    if (!alive && !currentIsReplacement && !oldBridgeStillServes) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * Discover an authorized shared bridge without transferring ownership or
 * writing an owner pointer under the requested workspace's identity.
 * Acquisition remains single-owner; any missing proof blocks lifecycle work.
 */
export async function findSharedBridgeObservation(
  workspaceId: string,
  workspaceRoot: string,
  opts: SharedBridgeObservationOptions = {},
): Promise<SharedBridgeObservation> {
  const stateDir = getStateDir(opts.stateDir);
  const requestedWorkspace = { id: workspaceId, root: canonicalizeWorkspaceRoot(workspaceRoot) };
  const observation = await findBridgeObservation(workspaceId, workspaceRoot, { ...opts, stateDir });
  if (observation.state !== "stopped") {
    if (observation.state === "healthy" && (observation.runtime.adminTokenKnown === false || !observation.runtime.adminToken)) {
      return { state: "unknown", runtime: observation.runtime, reason: "admin_proof_unavailable" };
    }
    return observation.state === "healthy" ? { ...observation, shared: false, requestedWorkspace } : observation;
  }
  const inspector = opts.processInspector ?? getSystemProcessInspector();
  const status = readStateDomainOwnerStatus(stateDir, inspector);
  if (status.state === "absent" || status.state === "stale") return observation;
  const fail = (reason: "active_owner_conflict" | "admin_proof_unavailable" | "unauthorized_workspace" | "runtime_changed"): SharedBridgeObservation =>
    ({ state: "unknown", runtime: null, reason });
  if (status.state !== "active") return fail("active_owner_conflict");
  const owner = status.owner;
  // Reject aliases and inspect only this canonical domain, never a packaged
  // or isolated runtime as an alternative source of shared authorization.
  const canonical = (value: string) => fs.realpathSync.native(value);
  try {
    if (!sameStateDir(canonical(stateDir), stateDir) ||
        !sameStateDir(canonical(path.join(stateDir, "runtime")), path.join(stateDir, "runtime")) ||
        stableWorkspaceId(requestedWorkspace.root) !== workspaceId ||
        stableWorkspaceId(canonicalizeWorkspaceRoot(owner.workspaceRoot)) !== owner.workspaceId) return fail("active_owner_conflict");
    for (const file of [stateDomainOwnerFile(stateDir), path.join(stateDir, "runtime", `${owner.workspaceId}.json`)]) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !sameStateDir(canonical(file), file)) return fail("active_owner_conflict");
    }
    const ownerObservation = await findBridgeObservation(owner.workspaceId, owner.workspaceRoot, {
      ...opts, stateDir, repairRuntime: false,
    });
    if (ownerObservation.state !== "healthy") return fail("active_owner_conflict");
    const runtime = ownerObservation.runtime;
    const matches = () => {
      const currentOwner = readStateDomainOwnerStatus(stateDir, inspector);
      const processInfo = inspector.list()?.find(row => row.pid === owner.pid);
      const pointer = readRuntimeState(owner.workspaceId, stateDir);
      return currentOwner.state === "active" && currentOwner.owner.generation === owner.generation &&
        currentOwner.owner.pid === owner.pid && currentOwner.owner.processStartIdentity === owner.processStartIdentity &&
        currentOwner.owner.workspaceId === owner.workspaceId && sameStateDir(currentOwner.owner.workspaceRoot, owner.workspaceRoot) &&
        Boolean(owner.processStartIdentity && processInfo?.processStartIdentity === owner.processStartIdentity &&
          isOwnedBridgeProcess(processInfo, owner.workspaceId, owner.workspaceRoot) && processInfo.listeningPorts.includes(runtime.port)) &&
        runtime.pid === owner.pid && runtime.workspaceId === owner.workspaceId && sameStateDir(runtime.workspaceRoot, owner.workspaceRoot) &&
        Boolean(runtime.stateDir && sameStateDir(runtime.stateDir, stateDir)) && runtime.stateDomainGeneration === owner.generation &&
        pointer?.pid === runtime.pid && pointer.port === runtime.port && pointer.startedAt === runtime.startedAt &&
        pointer.workspaceRoot === runtime.workspaceRoot && pointer.stateDir === runtime.stateDir &&
        pointer.stateDomainGeneration === owner.generation && pointer.adminToken === runtime.adminToken && pointer.adminTokenKnown !== false;
    };
    if (!matches()) return fail("active_owner_conflict");
    if (runtime.adminTokenKnown !== true || !runtime.adminToken) return fail("admin_proof_unavailable");
    const info = await (opts.adminFetchImpl ?? adminFetch)<AdminInfo>(runtime, "GET", "/admin/info", 5000);
    if (!info || info.workspaceId !== owner.workspaceId || typeof info.workspaceRoot !== "string" ||
        !sameStateDir(info.workspaceRoot, owner.workspaceRoot) || !info.stateDir || !sameStateDir(info.stateDir, stateDir) ||
        info.stateDomainGeneration !== owner.generation || info.pid !== runtime.pid || info.port !== runtime.port ||
        info.startedAt !== runtime.startedAt || !info.tunnel || typeof info.tunnel.running !== "boolean" ||
        typeof info.tunnel.provider !== "string" || (info.publicUrl !== null && typeof info.publicUrl !== "string")) return fail("active_owner_conflict");
    const authorizedWorkspace = Array.isArray(info.authorizedWorkspaces) ? info.authorizedWorkspaces.find(row =>
      row?.id === workspaceId && row.enabled !== false && typeof row.root === "string" &&
      path.isAbsolute(row.root) && sameStateDir(row.root, requestedWorkspace.root)) : undefined;
    if (!authorizedWorkspace) return fail("unauthorized_workspace");
    if (!matches()) return fail("runtime_changed");
    return { state: "healthy", runtime, shared: true, requestedWorkspace, owner, authorizedWorkspace,
      adminInfo: info, reconciled: ownerObservation.reconciled };
  } catch {
    return fail("admin_proof_unavailable");
  }
}

/**
 * Ensure a bridge is running for the workspace. Reuses a live instance,
 * otherwise spawns a detached daemon and waits for it to become healthy.
 */
export async function ensureBridge(workspaceRoot: string, opts: EnsureBridgeOptions = {}): Promise<EnsureBridgeResult> {
  const workspace = new Workspace(workspaceRoot);
  const stateDir = getStateDir(opts.stateDir);
  const probe = opts.probe ?? probeBridge;
  const observation = await findSharedBridgeObservation(workspace.id, workspace.root, { ...opts, stateDir });
  if (observation.state === "healthy") {
    if (!sameStateDir(observation.runtime.stateDir, stateDir)) {
      throw new Error(
        `A live bridge is using a non-canonical state directory (${observation.runtime.stateDir}); run c2c restart before starting the canonical domain.`
      );
    }
    return { runtime: observation.runtime, spawned: false, observation };
  }
  if (observation.state === "unknown") {
    if (observation.reason === "admin_proof_unavailable") {
      throw new Error("BRIDGE_RUNTIME_CREDENTIAL_UNAVAILABLE: Live bridge ownership is present but its privileged runtime credential is unavailable; refusing to start another bridge. An operator-controlled shutdown of the exact owner, followed by start, is required if the original authenticated pointer cannot be restored.");
    }
    throw new Error(
      `Bridge state is uncertain (${observation.reason}); refusing to start another bridge.`
    );
  }

  // A shutdown can remove runtime metadata before the old HTTP listener has
  // actually gone away. Refuse to create a second bridge for the same
  // workspace in that window; the server's normal EADDRINUSE fallback is only
  // for legitimate different-workspace port sharing.
  const preferredPort = opts.port ?? DEFAULT_PORT;
  const occupied = await probe(preferredPort, 500);
  if (occupied?.workspaceId === workspace.id) {
    throw new Error(
      `A bridge for workspace ${workspace.id} is already listening on port ${preferredPort}; refusing to start a duplicate.`
    );
  }

  // The per-workspace runtime pointer cannot see a legacy bridge serving a
  // different workspace from the same shared auth domain. Check the
  // bridge-wide owner before spawning so the failure is actionable instead
  // of becoming a 20-second child-start timeout.
  const ownerStatus = readStateDomainOwnerStatus(stateDir, opts.processInspector);
  if (ownerStatus.state === "active") {
    throw new Error(
      `C2C state domain is already owned by workspace ${ownerStatus.owner.workspaceId}; refusing to share OAuth/runtime state. Set an explicit isolated C2C_STATE_DIR for an independent bridge.`
    );
  }
  if (ownerStatus.state === "unknown") {
    throw new Error(
      `C2C state-domain ownership is uncertain (${ownerStatus.reason}); refusing to start another bridge.`
    );
  }

  const logDir = ensureDir(path.join(stateDir, "logs"));
  const logFile = path.join(logDir, `bridge-${workspace.id}.out.log`);
  const out = fs.openSync(logFile, "a", 0o600);
  try {
    // Existing files may have been created with a permissive umask. Keep the
    // daemon's inherited stdout/stderr log owner-readable only.
    fs.chmodSync(logFile, 0o600);
  } catch {
    // Windows / filesystems without chmod semantics
  }
  const { cmd, args } = cliEntry();
  const child = spawn(
    cmd,
    bridgeServeArgv(args, workspace.root, stateDir, opts.port),
    {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, C2C_STATE_DIR: stateDir, C2C_RESTART_HELPER: undefined },
    }
  );
  child.unref();
  fs.closeSync(out);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const runtime = await findLiveBridge(workspace.id, workspace.root, { ...opts, stateDir });
    if (runtime) return { runtime, spawned: true };
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(`Bridge process exited with code ${child.exitCode}. See ${logFile}`);
    }
  }
  throw new Error(`Bridge did not become healthy within 20s. See ${logFile}`);
}

export async function adminFetch<T = unknown>(
  runtime: RuntimeState,
  method: "GET" | "POST",
  route: string,
  timeoutMs = 60_000,
  payload?: unknown
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      method,
      headers: { Authorization: `Bearer ${runtime.adminToken}`, ...(payload === undefined ? {} : { "Content-Type": "application/json" }) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) {
      throw new Error((body as { message?: string }).message ?? `Admin request failed (${response.status})`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function stopBridge(workspaceRoot: string, opts: StopBridgeOptions = {}): Promise<boolean> {
  const workspace = new Workspace(workspaceRoot);
  const stateDir = getStateDir(opts.stateDir);
  const probe = opts.probe ?? probeBridge;
  const observation = await findSharedBridgeObservation(workspace.id, workspace.root, { ...opts, stateDir });
  if (observation.state === "stopped") return false;
  if (observation.state === "unknown") {
    throw new Error(`Bridge ownership is uncertain (${observation.reason}); refusing to stop a process.`);
  }

  const runtime = observation.runtime;
  // A shared stop shuts down the actual owner and affects every authorized
  // workspace. Never relabel its runtime or clean the requesting workspace.
  if (opts.expectedRuntime && (runtime.pid !== opts.expectedRuntime.pid || runtime.port !== opts.expectedRuntime.port ||
      runtime.startedAt !== opts.expectedRuntime.startedAt || runtime.stateDomainGeneration !== opts.expectedRuntime.stateDomainGeneration ||
      (observation.shared && opts.expectedRuntime.processStartIdentity !== undefined &&
        observation.owner?.processStartIdentity !== opts.expectedRuntime.processStartIdentity))) {
    throw new Error("Bridge ownership changed before shutdown; refusing to stop a replacement.");
  }
  const terminate = opts.killProcess ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  let shutdownRequested = false;
  if (runtime.adminTokenKnown !== false && runtime.adminToken.length > 0) {
    try {
      await (opts.adminFetchImpl ?? adminFetch)(runtime, "POST", "/admin/shutdown", 5000,
        observation.shared ? { expectedRuntime: {
          workspaceId: runtime.workspaceId, pid: runtime.pid, port: runtime.port,
          startedAt: runtime.startedAt, stateDomainGeneration: runtime.stateDomainGeneration,
        } } : undefined);
      shutdownRequested = true;
    } catch {
      // A reconciled pointer may not have the process-local admin secret.
      // The validated PID fallback below remains narrowly scoped.
    }
  }

  // The admin response only acknowledges the shutdown request. Do not report
  // success until the old PID and listener are gone. When admin auth is not
  // available, waiting serves no purpose, so revalidate and signal promptly.
  if (shutdownRequested && await waitForBridgeStop(runtime, STOP_GRACE_MS, probe, opts.processInspector)) {
    if (runtime.stateDir && !sameStateDir(runtime.stateDir, stateDir)) {
      clearRuntimeStateAt(runtime.workspaceId, runtime, runtime.stateDir);
    } else {
      clearRuntimeState(runtime.workspaceId, runtime, stateDir);
    }
    return true;
  }

  const rechecked = await findSharedBridgeObservation(workspace.id, workspace.root, {
    ...opts,
    stateDir,
    repairRuntime: false,
  });
  if (rechecked.state === "stopped") return true;
  if (
    rechecked.state !== "healthy" ||
    rechecked.runtime.pid !== runtime.pid ||
    rechecked.runtime.port !== runtime.port ||
    rechecked.runtime.startedAt !== runtime.startedAt ||
    rechecked.runtime.stateDomainGeneration !== runtime.stateDomainGeneration ||
    rechecked.runtime.workspaceId !== runtime.workspaceId ||
    (observation.shared && (!rechecked.shared || rechecked.owner?.processStartIdentity !== observation.owner?.processStartIdentity))
  ) {
    throw new Error("Bridge ownership changed during shutdown; refusing to stop an ambiguous process.");
  }
  try {
    terminate(runtime.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }

  if (await waitForBridgeStop(runtime, STOP_FALLBACK_MS, probe, opts.processInspector)) {
    if (runtime.stateDir && !sameStateDir(runtime.stateDir, stateDir)) {
      clearRuntimeStateAt(runtime.workspaceId, runtime, runtime.stateDir);
    } else {
      clearRuntimeState(runtime.workspaceId, runtime, stateDir);
    }
    return true;
  }
  throw new Error(
    `Bridge did not stop cleanly (pid ${runtime.pid}, port ${runtime.port}); refusing to start a replacement.`
  );
}
