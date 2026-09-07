import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getStateDir, writeSecureJson } from "../config/paths.js";
import { stateDirectories, readStateDomainOwnerStatus } from "../bridge/state-owner.js";
import { findBridgeObservation, getSystemProcessInspector, type RuntimeState } from "../bridge/runtime.js";
import { canonicalizeWorkspaceRoot, stableWorkspaceId } from "../workspace/identity.js";
import { adminFetch, ensureBridge, stopBridge, findSharedBridgeObservation, type SharedBridgeObservationOptions } from "./daemon.js";
import { isNamedTunnelReady, readTunnelState, tunnelStateFile, type TunnelState } from "../tunnel/state.js";
import { probePublicMcp } from "../tunnel/probe.js";

const TTL = 180_000;
const LAUNCH_GRACE = 10_000;
const uuid = z.string().uuid();
const identity = z.object({ pid: z.number().int().positive(), port: z.number().int().min(1).max(65535),
  startedAt: z.string().datetime(), stateDomainGeneration: uuid, processStartIdentity: z.string().min(1).max(100) }).strict();
const recordSchema = z.object({ version: z.literal(1), id: uuid, workspaceId: z.string().regex(/^[a-f0-9]{12}$/),
  requestedWorkspace: z.object({ id: z.string().regex(/^[a-f0-9]{12}$/), root: z.string().min(1).max(4096) }).strict().optional(),
  workspaceRoot: z.string().min(1).max(4096), stateDir: z.string().min(1).max(4096),
  createdAt: z.number().int().positive(), expiresAt: z.number().int().positive(),
  old: identity, helper: z.object({ pid: z.number().int().positive(), start: z.string().min(1).max(100) }).strict().nullable(),
  tunnel: z.boolean(), tunnelFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["requested", "stopping", "starting", "tunnel", "complete", "failed"]),
  error: z.enum(["LAUNCH_FAILED", "VALIDATION_FAILED", "STOP_FAILED", "START_FAILED", "TUNNEL_FAILED"]).nullable(),
  replacement: identity.nullable(), tunnelReady: z.boolean(),
}).strict();
export type RestartHandoff = z.infer<typeof recordSchema>;
type Identity = z.infer<typeof identity>;

function equalPath(a: string, b: string): boolean {
  return process.platform === "win32" || process.platform === "darwin" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function regular(file: string, missing = false): void {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16_384 ||
        !equalPath(fs.realpathSync.native(file), file)) throw new Error("Unsafe restart state file");
  } catch (error) { if (!missing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function paths(stateDir: string) {
  return { file: path.join(stateDir, "runtime", "restart-handoff.json"), lock: path.join(stateDir, "runtime", "restart-handoff.lock") };
}
function validatePaths(stateDir: string, workspaceRoot: string): void {
  if (!path.isAbsolute(stateDir) || !path.isAbsolute(workspaceRoot) ||
      !equalPath(canonicalizeWorkspaceRoot(workspaceRoot), workspaceRoot) ||
      !equalPath(stateDirectories(stateDir, workspaceRoot), stateDir)) throw new Error("Ambiguous restart domain");
  const { file, lock } = paths(stateDir);
  regular(file, true);
  if (fs.existsSync(lock)) {
    const stat = fs.lstatSync(lock);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !equalPath(fs.realpathSync.native(lock), lock)) throw new Error("Unsafe restart lock");
  }
}
function save(record: RestartHandoff): void {
  recordSchema.parse(record);
  validatePaths(record.stateDir, record.workspaceRoot);
  writeSecureJson(paths(record.stateDir).file, record, { durable: true });
}
export function readRestartHandoff(stateDir: string): RestartHandoff {
  const file = paths(stateDir).file;
  regular(file);
  const record = recordSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!equalPath(record.stateDir, stateDir) || stableWorkspaceId(record.workspaceRoot) !== record.workspaceId ||
      record.expiresAt !== record.createdAt + TTL ||
      (!record.helper && record.state !== "requested" && record.state !== "failed") ||
      (record.requestedWorkspace && (stableWorkspaceId(record.requestedWorkspace.root) !== record.requestedWorkspace.id ||
        !equalPath(canonicalizeWorkspaceRoot(record.requestedWorkspace.root), record.requestedWorkspace.root)))) throw new Error("Invalid restart handoff");
  validatePaths(stateDir, record.workspaceRoot);
  return record;
}
function tunnelFingerprint(workspaceId: string, stateDir: string, requested: boolean): string {
  const file = tunnelStateFile(workspaceId, stateDir);
  const directory = path.dirname(file);
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !equalPath(fs.realpathSync.native(directory), directory)) throw new Error("Unsafe tunnel state directory");
  }
  regular(file, true);
  // The usual reader's unset fallback is useful for setup, but malformed state
  // must never be mistaken for an unconfigured tunnel at the restart boundary.
  const state: TunnelState = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { workspaceId, preference: "unset" };
  if (state.workspaceId !== workspaceId || !["unset", "quick", "named"].includes(state.preference) ||
      (requested && state.preference === "unset") ||
      (state.preference === "named" && (!isNamedTunnelReady(state) || state.provider !== "cloudflare-named" ||
        !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i.test(state.tunnelName!) ||
        !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(state.hostname!))) ||
      (state.preference === "quick" && state.provider !== "cloudflare-quick")) throw new Error("Ambiguous tunnel state");
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
function processStart(pid: number): string {
  const entry = getSystemProcessInspector().list()?.find(row => row.pid === pid);
  if (!entry?.processStartIdentity || !equalPath(entry.executable, process.execPath)) throw new Error("Process identity unavailable");
  return entry.processStartIdentity;
}
/** Missing inventory/rows are not proof of death: inventories may omit protected processes. */
export function inspectRestartProcessIdentity(pid: number, start: string): "same" | "gone" | "unknown" {
  try {
    const rows = getSystemProcessInspector().list();
    if (!rows) return "unknown";
    const matches = rows.filter(row => row.pid === pid);
    if (matches.length > 1) return "unknown";
    const entry = matches[0];
    if (entry) return !entry.processStartIdentity ? "unknown" : entry.processStartIdentity === start ? "same" : "gone";
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return "gone";
    }
  } catch { /* inspection failures must never authorize recovery */ }
  return "unknown";
}

function stale(record: RestartHandoff): boolean {
  return Date.now() >= record.expiresAt || ["complete", "failed"].includes(record.state) ||
    (record.state === "requested" && !record.helper && Date.now() - record.createdAt > LAUNCH_GRACE);
}

/** New locks bind to a generation even before its handoff is published. */
function validateLock(record: RestartHandoff, recovering = false): void {
  validatePaths(record.stateDir, record.workspaceRoot);
  const { lock } = paths(record.stateDir);
  const entries = fs.readdirSync(lock);
  for (const name of entries) {
    const claimId = name.startsWith("claim-") ? name.slice(6) : undefined;
    if (!["handoff-id", "claim"].includes(name) && (!claimId || !uuid.safeParse(claimId).success)) throw new Error("Unsafe restart lock contents");
    regular(path.join(lock, name));
    const value = fs.readFileSync(path.join(lock, name), "utf8");
    if (value !== (claimId ?? record.id) && !(name === "claim" && value === "")) throw new Error("Restart lock generation changed");
  }
  if (recovering && !entries.includes("handoff-id")) {
    // Legacy locks had no token. Never confuse the mkdir-to-token publication
    // window of a new caller with the previous handoff still on disk.
    const stat = fs.lstatSync(lock);
    if (Date.now() - stat.mtimeMs <= LAUNCH_GRACE || stat.birthtimeMs > record.createdAt) {
      throw new Error("Restart lock identity unavailable");
    }
  }
}

function acquireLock(stateDir: string, id: string): void {
  const { lock } = paths(stateDir);
  fs.mkdirSync(lock, { mode: 0o700 });
  // A failed publication leaves an ambiguous lock, never a launch permission.
  writeExclusive(path.join(lock, "handoff-id"), id);
}

function writeExclusive(file: string, value: string | Buffer): void {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function releaseLock(record: RestartHandoff): void {
  validateLock(record);
  const { lock } = paths(record.stateDir);
  for (const name of fs.readdirSync(lock)) fs.unlinkSync(path.join(lock, name));
  fs.rmdirSync(lock);
}

async function reclaimLock(record: RestartHandoff, root: string, deps: RestartDeps): Promise<void> {
  validateLock(record, true);
  if (!record.helper && record.state === "failed" && record.error !== "LAUNCH_FAILED") {
    throw new Error("Restart helper claim identity unavailable");
  }
  const before = JSON.stringify(record);
  const prove = () => {
    if (!stale(record) || (record.helper && deps.processIdentity?.(record.helper.pid, record.helper.start) !== "gone")) {
      throw new Error("Restart handoff stale or ambiguous; helper may still be live");
    }
    const oldStatus = deps.processIdentity?.(record.old.pid, record.old.processStartIdentity) ?? "unknown";
    if (oldStatus === "unknown") throw new Error("Process identity unavailable; refusing stale recovery");
    return oldStatus;
  };
  prove();
  // This is the same healthy current owner proof required for a normal restart.
  // A missing/unresponsive owner during shutdown is deliberately not recoverable.
  const current = await deps.observe(root, record.stateDir);
  const oldStatus = prove();
  if (oldStatus === "same" && JSON.stringify(current) !== JSON.stringify(record.old)) {
    throw new Error("Old restart runtime still live outside current ownership");
  }
  validateLock(record, true);
  if (JSON.stringify(readRestartHandoff(record.stateDir)) !== before) throw new Error("Restart handoff changed during recovery");
  const { lock, file } = paths(record.stateDir);
  const evidence = fs.readFileSync(file);
  const claim = path.join(lock, `claim-${record.id}`);
  // Fence a delayed pre-helper launch with the helper's own exclusive claim.
  // A claim without a published helper identity is ambiguous, even after TTL.
  if (!record.helper && fs.existsSync(path.join(lock, "claim"))) throw new Error("Restart helper claim identity unavailable");
  const madeClaim = !record.helper || (!fs.existsSync(path.join(lock, "handoff-id")) && !fs.existsSync(path.join(lock, "claim")) && !fs.existsSync(claim));
  if (madeClaim) {
    writeExclusive(claim, record.id);
  }
  // Deterministic destination + nonempty generation/claim prevents a delayed contender
  // from renaming a newer lock (including on POSIX, which replaces empty dirs).
  // Retain quarantine permanently as both an ABA fence and forensic evidence.
  const quarantine = path.join(path.dirname(lock), `restart-handoff.${record.id}.stale`);
  let renamed = false;
  try {
    for (let attempt = 0; ; attempt++) {
      if (fs.existsSync(quarantine)) throw new Error("Restart handoff already quarantined");
      validateLock(record);
      if (JSON.stringify(readRestartHandoff(record.stateDir)) !== before) throw new Error("Restart handoff changed during recovery");
      prove();
      try { fs.renameSync(lock, quarantine); renamed = true; break; }
      catch (error) {
        // Windows can briefly deny a directory rename while another reader
        // closes its handle. Retry only this operation, with fresh proofs.
        if (attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  } finally {
    if (!renamed && madeClaim && fs.existsSync(claim)) {
      regular(claim);
      if (fs.readFileSync(claim, "utf8") === record.id) fs.unlinkSync(claim);
    }
  }
  writeExclusive(path.join(quarantine, "stale-handoff.json"), evidence);
}
async function observe(workspaceRoot: string, stateDir: string): Promise<Identity> {
  const workspaceId = stableWorkspaceId(workspaceRoot);
  const observation = await findBridgeObservation(workspaceId, workspaceRoot, { stateDir, repairRuntime: false });
  const owner = readStateDomainOwnerStatus(stateDir);
  if (observation.state !== "healthy" || !observation.runtime.stateDir || !equalPath(observation.runtime.stateDir, stateDir) ||
      owner.state !== "active" || owner.owner.workspaceId !== workspaceId || !equalPath(owner.owner.workspaceRoot, workspaceRoot) ||
      owner.owner.pid !== observation.runtime.pid || owner.owner.generation !== observation.runtime.stateDomainGeneration) {
    throw new Error("Ambiguous restart runtime ownership");
  }
  const runtime = observation.runtime;
  return identity.parse({ pid: runtime.pid, port: runtime.port, startedAt: runtime.startedAt,
    stateDomainGeneration: runtime.stateDomainGeneration, processStartIdentity: processStart(runtime.pid) });
}

/** Fixed executable and fixed compiled entry; never a shell or caller-supplied command/path. */
export function restartLaunchSpec(id: string, stateDir: string) {
  uuid.parse(id);
  const sibling = fileURLToPath(new URL("./restart-helper.js", import.meta.url));
  const entry = fs.existsSync(sibling) ? sibling : fileURLToPath(new URL("../../dist/process/restart-helper.js", import.meta.url));
  const stat = fs.lstatSync(entry);
  if (!stat.isFile() || stat.isSymbolicLink() || !equalPath(fs.realpathSync.native(entry), entry)) throw new Error("Build the trusted restart helper before restarting");
  const env = { ...process.env, C2C_STATE_DIR: stateDir, C2C_RESTART_HELPER: "1" };
  // Loader hooks and shell startup settings cannot select a different helper implementation.
  delete (env as NodeJS.ProcessEnv).NODE_OPTIONS;
  delete (env as NodeJS.ProcessEnv).NODE_PATH;
  return { command: process.execPath, args: [entry, id], options: {
    detached: true, windowsHide: true, shell: false, stdio: "ignore" as const, cwd: path.dirname(entry), env,
  } };
}
async function launch(id: string, stateDir: string): Promise<void> {
  const spec = restartLaunchSpec(id, stateDir);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, spec.options);
    child.once("error", () => reject(new Error("Restart helper launch failed")));
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
async function tunnel(runtime: RuntimeState): Promise<boolean> {
  const result = await adminFetch<{ url?: string }>(runtime, "POST", "/admin/tunnel/start", 90_000);
  if (!result.url) return false;
  const url = new URL(result.url);
  const state = readTunnelState(runtime.workspaceId, runtime.stateDir);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/" ||
      (state.preference === "named" && url.hostname !== state.hostname) ||
      (state.preference === "quick" && !/^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname))) return false;
  return (await probePublicMcp(result.url)).ok;
}
/** Dependency seam only for local tests; hidden entry exposes no dependency arguments. */
export interface RestartDeps {
  observe: typeof observe; processStart: typeof processStart; launch: typeof launch;
  stop: typeof stopBridge; ensure: typeof ensureBridge; tunnel: typeof tunnel;
  resolveTarget?: typeof resolveRestartTarget;
  processIdentity?: typeof inspectRestartProcessIdentity;
}
/** Shared restart affects all authorized workspaces and relaunches the actual
 * owner root. The requesting workspace is authorization context, never owner. */
export async function resolveRestartTarget(root: string, stateDir: string, opts: SharedBridgeObservationOptions = {}) {
  const observation = await findSharedBridgeObservation(stableWorkspaceId(root), root, { ...opts, stateDir, repairRuntime: false });
  if (observation.state !== "healthy") throw new Error("Ambiguous restart runtime ownership");
  return observation;
}
const production: RestartDeps = { observe, processStart, processIdentity: inspectRestartProcessIdentity, launch, stop: stopBridge, ensure: ensureBridge, tunnel, resolveTarget: resolveRestartTarget };

export async function requestRestart(workspaceRoot: string, opts: { stateDir?: string; tunnel: boolean }, deps: RestartDeps = production): Promise<RestartHandoff> {
  if (process.env.C2C_RESTART_HELPER === "1") throw new Error("Recursive restart forbidden");
  const requestedRoot = canonicalizeWorkspaceRoot(workspaceRoot);
  const stateDir = getStateDir(opts.stateDir);
  const target = await deps.resolveTarget?.(requestedRoot, stateDir);
  const root = target?.runtime.workspaceRoot ?? requestedRoot;
  validatePaths(stateDir, root);
  const { lock } = paths(stateDir);
  const id = randomUUID();
  try { acquireLock(stateDir, id); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const record = readRestartHandoff(stateDir);
    validateLock(record);
    if (stale(record)) {
      await reclaimLock(record, root, deps);
      // Another ordinary caller may win this mkdir. Only its generation may
      // publish a new record; a losing reclaimer must never remove that lock.
      acquireLock(stateDir, id);
    } else {
      if (!equalPath(record.requestedWorkspace?.root ?? record.workspaceRoot, requestedRoot) ||
        record.workspaceId !== stableWorkspaceId(root) || !equalPath(record.workspaceRoot, root) || record.tunnel !== opts.tunnel ||
        tunnelFingerprint(record.workspaceId, stateDir, record.tunnel) !== record.tunnelFingerprint ||
        (record.helper && deps.processStart(record.helper.pid) !== record.helper.start)) throw new Error("Restart handoff stale or ambiguous; refusing another helper");
      return record;
    }
  }
  let record: RestartHandoff | undefined;
  try {
    const old = await deps.observe(root, stateDir);
    if (target && (old.pid !== target.runtime.pid || old.port !== target.runtime.port ||
        old.startedAt !== target.runtime.startedAt || old.stateDomainGeneration !== target.runtime.stateDomainGeneration ||
        (target.shared && old.processStartIdentity !== target.owner?.processStartIdentity))) throw new Error("Restart owner changed");
    const createdAt = Date.now();
    record = { version: 1, id, workspaceId: stableWorkspaceId(root), workspaceRoot: root, stateDir,
      ...(target?.shared ? { requestedWorkspace: { id: stableWorkspaceId(requestedRoot), root: requestedRoot } } : {}),
      createdAt, expiresAt: createdAt + TTL, old, helper: null, tunnel: opts.tunnel,
      tunnelFingerprint: tunnelFingerprint(stableWorkspaceId(root), stateDir, opts.tunnel),
      state: "requested", error: null, replacement: null, tunnelReady: false };
    validateLock(record);
    save(record);
    // Nothing after launch is required for correctness. The helper claims and updates its own record.
    await deps.launch(record.id, stateDir);
    return record;
  } catch {
    if (record) { record.state = "failed"; record.error = "LAUNCH_FAILED"; save(record); }
    if (fs.readFileSync(path.join(lock, "handoff-id"), "utf8") === id) {
      // Before publication there is no record to validate against.
      fs.unlinkSync(path.join(lock, "handoff-id"));
      fs.rmdirSync(lock);
    }
    throw new Error("Restart handoff validation or launch failed; bridge was not stopped");
  }
}

export async function runRestartHelper(id: string, stateDir: string, deps: RestartDeps = production): Promise<RestartHandoff> {
  uuid.parse(id);
  const record = readRestartHandoff(stateDir);
  if (record.id !== id || record.state !== "requested" || record.helper || Date.now() > record.expiresAt) throw new Error("Invalid or stale restart handoff");
  const { lock } = paths(stateDir);
  validateLock(record);
  // Claims bind to the handoff, so a delayed old claimant cannot obstruct a
  // newer generation after its directory was quarantined. Legacy claims still
  // fence old helper launches whose identity has not yet been published.
  if (fs.existsSync(path.join(lock, "claim"))) throw new Error("Restart helper already claimed");
  const claim = path.join(lock, `claim-${id}`);
  const fd = fs.openSync(claim, "wx", 0o600);
  fs.writeFileSync(fd, id);
  fs.closeSync(fd);
  // A helper may have read its record just before recovery fenced the old
  // directory. Re-read after claiming, before it can save or stop anything.
  const latest = readRestartHandoff(stateDir);
  if (latest.id !== id || latest.helper || latest.state !== "requested" || stale(latest)) {
    fs.unlinkSync(claim);
    throw new Error("Invalid or stale restart handoff after claim");
  }
  let stage: RestartHandoff["error"] = "VALIDATION_FAILED";
  try {
    record.helper = { pid: process.pid, start: deps.processStart(process.pid) };
    save(record);
    const assertFresh = () => {
      const current = readRestartHandoff(stateDir);
      if (current.id !== id || Date.now() > record.expiresAt ||
          tunnelFingerprint(record.workspaceId, stateDir, record.tunnel) !== record.tunnelFingerprint) throw new Error("Restart handoff changed or expired");
    };
    assertFresh();
    if (record.requestedWorkspace) {
      const requested = record.requestedWorkspace;
      if (stableWorkspaceId(requested.root) !== requested.id || !deps.resolveTarget) throw new Error("Shared restart proof missing");
      const target = await deps.resolveTarget(requested.root, stateDir);
      if (!target.shared || target.runtime.workspaceId !== record.workspaceId ||
          !equalPath(target.runtime.workspaceRoot, record.workspaceRoot) || target.runtime.pid !== record.old.pid ||
          target.runtime.port !== record.old.port || target.runtime.startedAt !== record.old.startedAt ||
          target.runtime.stateDomainGeneration !== record.old.stateDomainGeneration ||
          target.owner?.processStartIdentity !== record.old.processStartIdentity) throw new Error("Shared restart owner changed");
    }
    if (JSON.stringify(await deps.observe(record.workspaceRoot, stateDir)) !== JSON.stringify(record.old)) throw new Error("Old runtime changed");
    record.state = "stopping"; save(record); stage = "STOP_FAILED";
    if (!await deps.stop(record.requestedWorkspace?.root ?? record.workspaceRoot, { stateDir, expectedRuntime: record.old })) throw new Error("Old runtime did not stop");
    assertFresh();
    record.state = "starting"; save(record); stage = "START_FAILED";
    const replacement = await deps.ensure(record.workspaceRoot, { stateDir, port: record.old.port });
    record.replacement = await deps.observe(record.workspaceRoot, stateDir);
    if (record.replacement.pid !== replacement.runtime.pid || record.replacement.startedAt !== replacement.runtime.startedAt ||
        record.replacement.stateDomainGeneration !== replacement.runtime.stateDomainGeneration) throw new Error("Replacement identity changed");
    if (record.replacement.pid === record.old.pid && record.replacement.processStartIdentity === record.old.processStartIdentity) throw new Error("Old runtime still running");
    save(record);
    if (record.tunnel) {
      assertFresh(); record.state = "tunnel"; save(record); stage = "TUNNEL_FAILED";
      record.tunnelReady = await deps.tunnel(replacement.runtime);
      if (!record.tunnelReady) throw new Error("Tunnel not ready");
    }
    assertFresh();
    if (JSON.stringify(await deps.observe(record.workspaceRoot, stateDir)) !== JSON.stringify(record.replacement)) throw new Error("Replacement changed before completion");
    record.state = "complete"; save(record);
  } catch {
    record.state = "failed"; record.error = stage; save(record);
  } finally {
    // Recovery cannot replace a lock while this helper's identity remains live.
    releaseLock(record);
  }
  return record;
}

export async function waitRestartHandoff(id: string, stateDir: string, timeoutMs = TTL): Promise<RestartHandoff> {
  uuid.parse(id);
  const deadline = Date.now() + Math.max(0, Math.min(timeoutMs, TTL));
  do {
    const record = readRestartHandoff(stateDir);
    if (record.id !== id) throw new Error("Restart handoff superseded");
    if (record.state === "failed") throw new Error(`Restart helper failed: ${record.error}`);
    if (record.state === "complete") return record;
    if (Date.now() > record.expiresAt) throw new Error("Restart handoff expired");
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error("Restart handoff wait timed out; inspect protected restart-handoff.json");
}
