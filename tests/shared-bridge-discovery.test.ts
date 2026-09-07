import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { writeSecureJson } from "../src/config/paths.js";
import { readRuntimeState, writeRuntimeState, type RuntimeState, type BridgeProcessIdentity } from "../src/bridge/runtime.js";
import { stateDomainOwnerFile, type StateDomainOwnerRecord } from "../src/bridge/state-owner.js";
import { findSharedBridgeObservation, ensureBridge, stopBridge, type AdminInfo, type SharedBridgeObservationOptions } from "../src/process/daemon.js";
import { diagnoseSharedTunnel } from "../src/process/shared-doctor.js";
import { resolveRestartTarget, requestRestart, runRestartHelper, type RestartDeps } from "../src/process/restart.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { makeTmpDir, cleanup } from "./helpers.js";

describe("post-reboot shared bridge discovery (hermetic)", () => {
  let base: string, stateDir: string, a: Workspace, b: Workspace;
  let owner: StateDomainOwnerRecord, runtime: RuntimeState, info: AdminInfo;
  let rows: BridgeProcessIdentity[], options: SharedBridgeObservationOptions;
  beforeEach(() => {
    base = makeTmpDir("g7a-shared");
    for (const name of ["a", "b", "state"]) fs.mkdirSync(path.join(base, name));
    a = new Workspace(path.join(base, "a")); b = new Workspace(path.join(base, "b")); stateDir = path.join(base, "state");
    vi.stubEnv("C2C_STATE_DIR", stateDir);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Network forbidden in hermetic discovery test"); }));
    owner = { schema: 1, stateDir, generation: randomUUID(), workspaceId: a.id, workspaceRoot: a.root,
      pid: 900001, processStartIdentity: "owner-start", acquiredAt: "2026-09-06T00:00:00.000Z", authFile: "" };
    owner.authFile = path.join(stateDir, "auth", `bridge.${owner.generation}.json`);
    writeSecureJson(stateDomainOwnerFile(stateDir), owner);
    runtime = { service: SERVICE_NAME, version: VERSION, workspaceId: a.id, workspaceRoot: a.root,
      pid: owner.pid, port: 50111, adminToken: "test-admin", adminTokenKnown: true, publicUrl: "https://stale.example",
      startedAt: owner.acquiredAt, stateDir, stateDomainGeneration: owner.generation };
    writeRuntimeState(runtime, stateDir);
    rows = [{ pid: owner.pid, processStartIdentity: owner.processStartIdentity!, executable: process.execPath,
      commandLine: `"${process.execPath}" "${path.resolve("src/cli/index.ts")}" serve --workspace "${a.root}" --state-dir "${stateDir}"`,
      listeningPorts: [runtime.port] }];
    info = { workspaceId: a.id, workspaceRoot: a.root, workspaceName: a.name, stateDir,
      stateDomainGeneration: owner.generation, pid: runtime.pid, port: runtime.port, startedAt: runtime.startedAt,
      authorizedWorkspaces: [{ id: a.id, root: a.root, name: a.name }, { id: b.id, root: b.root, name: b.name }],
      publicUrl: "https://owner.example", tunnel: { provider: "cloudflare-named", running: true, url: "https://owner.example" },
      publicProbe: null, tokenCount: 1, pairingActive: false };
    options = { stateDir, processInspector: { list: () => rows },
      probe: async port => rows.some(row => row.listeningPorts.includes(port))
        ? { service: SERVICE_NAME, version: VERSION, workspaceId: a.id, status: "ok" } : null,
      adminFetchImpl: vi.fn(async () => structuredClone(info)) as SharedBridgeObservationOptions["adminFetchImpl"] };
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); cleanup(base); });
  const discover = () => findSharedBridgeObservation(b.id, b.root, options);

  it("reuses active A for authorized B without fabricating a B runtime", async () => {
    const before = fs.readFileSync(path.join(stateDir, "runtime", `${a.id}.json`), "utf8");
    expect(await discover()).toMatchObject({ state: "healthy", shared: true, runtime: { workspaceId: a.id, workspaceRoot: a.root },
      requestedWorkspace: { id: b.id, root: b.root } });
    expect(await ensureBridge(b.root, options)).toMatchObject({ spawned: false, runtime: { workspaceId: a.id } });
    expect(options.adminFetchImpl).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: a.id, adminToken: "test-admin" }), "GET", "/admin/info", 5000);
    expect(readRuntimeState(b.id, stateDir)).toBeNull();
    expect(fs.readFileSync(path.join(stateDir, "runtime", `${a.id}.json`), "utf8")).toBe(before);
  });
  it.each(["absent", "wrong-root", "disabled"])("fails closed for authorization %s", async mode => {
    info.authorizedWorkspaces = mode === "absent" ? [] : [{ id: b.id, root: mode === "wrong-root" ? a.root : b.root, name: b.name, enabled: mode !== "disabled" }];
    expect(await discover()).toMatchObject({ state: "unknown", reason: "unauthorized_workspace" });
    await expect(ensureBridge(b.root, options)).rejects.toThrow(/uncertain/);
  });
  it.each(["token", "admin", "missing-runtime", "process-start"])("fails closed with unavailable %s proof", async mode => {
    if (mode === "token") writeRuntimeState({ ...runtime, adminTokenKnown: false, adminToken: "" }, stateDir);
    if (mode === "admin") options.adminFetchImpl = async () => { throw new Error("404"); };
    if (mode === "missing-runtime") fs.unlinkSync(path.join(stateDir, "runtime", `${a.id}.json`));
    if (mode === "process-start") rows[0].processStartIdentity = undefined;
    expect(await discover()).toMatchObject({ state: "unknown" });
  });
  it.each(["workspaceId", "workspaceRoot", "stateDir", "stateDomainGeneration", "pid", "port", "startedAt"])("rejects mismatched admin %s", async field => {
    (info as unknown as Record<string, unknown>)[field] = field === "pid" || field === "port" ? 9 : "wrong";
    expect(await discover()).toMatchObject({ state: "unknown" });
  });
  it("rejects runtime generation mismatch and owner changes during authenticated proof", async () => {
    writeRuntimeState({ ...runtime, stateDomainGeneration: randomUUID() }, stateDir);
    expect(await discover()).toMatchObject({ state: "unknown" });
    writeRuntimeState(runtime, stateDir);
    options.adminFetchImpl = async <T>() => {
      writeSecureJson(stateDomainOwnerFile(stateDir), { ...owner, generation: randomUUID() });
      return info as T;
    };
    expect(await discover()).toMatchObject({ state: "unknown" });
  });
  it("does not share when the requested observation is uncertain or duplicate owner bridges exist", async () => {
    rows.push({ ...rows[0], pid: 900002 });
    expect(await discover()).toMatchObject({ state: "unknown" });
    expect(options.adminFetchImpl).not.toHaveBeenCalled();
  });
  it("keeps isolated domains independent", async () => {
    const isolated = path.join(base, "isolated"); fs.mkdirSync(isolated);
    expect(await findSharedBridgeObservation(b.id, b.root, { ...options, stateDir: isolated })).toMatchObject({ state: "stopped" });
    expect(options.adminFetchImpl).not.toHaveBeenCalled();
  });
  it("rejects an owner runtime linked outside its canonical state domain", async () => {
    const file = path.join(stateDir, "runtime", `${a.id}.json`);
    fs.linkSync(file, path.join(base, "linked-runtime.json"));
    expect(await discover()).toMatchObject({ state: "unknown" });
    expect(options.adminFetchImpl).not.toHaveBeenCalled();
  });
  it("B doctor uses current authenticated owner named URL and public probe with no B tunnel file", async () => {
    const observation = await discover();
    if (observation.state !== "healthy") throw new Error("proof failed");
    const probe = vi.fn(async (url: string) => ({ ok: true, url, status: 401, checkedAt: "now" }));
    expect(await diagnoseSharedTunnel(observation, probe)).toMatchObject({ report: { ok: true, detail: info.publicUrl } });
    expect(probe).toHaveBeenCalledWith(info.publicUrl, 8000);
    expect(fs.existsSync(path.join(stateDir, "tunnels", `${b.id}.json`))).toBe(false);
    probe.mockResolvedValue({ ok: false, url: info.publicUrl!, status: 503, checkedAt: "now" });
    expect(await diagnoseSharedTunnel(observation, probe)).toMatchObject({ report: { ok: false, detail: "NAMED_TUNNEL_DOWN" } });
    observation.adminInfo!.publicUrl = null;
    expect(await diagnoseSharedTunnel(observation, probe)).toMatchObject({ publicUrl: null, report: { ok: false } });
  });
  it("shared stop targets actual owner, sends a generation fence, and removes only owner pointer", async () => {
    const kill = vi.fn();
    options.adminFetchImpl = vi.fn(async <T>(_runtime: RuntimeState, method: string) => {
      if (method === "POST") { rows = []; return {} as T; }
      return structuredClone(info) as T;
    });
    expect(await stopBridge(b.root, { ...options, expectedRuntime: runtime, killProcess: kill })).toBe(true);
    expect(options.adminFetchImpl).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: a.id }), "POST", "/admin/shutdown", 5000,
      { expectedRuntime: { workspaceId: a.id, pid: runtime.pid, port: runtime.port, startedAt: runtime.startedAt, stateDomainGeneration: owner.generation } });
    expect(kill).not.toHaveBeenCalled(); expect(readRuntimeState(a.id, stateDir)).toBeNull(); expect(readRuntimeState(b.id, stateDir)).toBeNull();
  });
  it("stop rejects changed generation before shutdown and re-proves authorization before PID fallback", async () => {
    const kill = vi.fn();
    await expect(stopBridge(b.root, { ...options, expectedRuntime: { ...runtime, stateDomainGeneration: randomUUID() }, killProcess: kill })).rejects.toThrow(/ownership changed/);
    options.adminFetchImpl = async <T>(_runtime: RuntimeState, method: string) => {
      if (method === "POST") { info.authorizedWorkspaces = []; throw new Error("shutdown unavailable"); }
      return structuredClone(info) as T;
    };
    await expect(stopBridge(b.root, { ...options, killProcess: kill })).rejects.toThrow(/ownership changed/);
    expect(kill).not.toHaveBeenCalled();
  });
  it("PID fallback signals only the re-proven actual owner", async () => {
    options.adminFetchImpl = async <T>(_runtime: RuntimeState, method: string) => {
      if (method === "POST") throw new Error("shutdown unavailable");
      return structuredClone(info) as T;
    };
    const kill = vi.fn(() => { rows = []; });
    expect(await stopBridge(b.root, { ...options, killProcess: kill })).toBe(true);
    expect(kill).toHaveBeenCalledExactlyOnceWith(owner.pid, "SIGTERM");
  });
  it("shared restart stops through B authorization but starts A and keeps A tunnel configuration", async () => {
    const old = { pid: runtime.pid, port: runtime.port, startedAt: runtime.startedAt,
      stateDomainGeneration: owner.generation, processStartIdentity: owner.processStartIdentity! };
    const replacement = { ...old, pid: 900002, startedAt: "2026-09-06T01:00:00.000Z", stateDomainGeneration: randomUUID(), processStartIdentity: "new" };
    let started = false;
    const deps: RestartDeps = { resolveTarget: (root, dir) => resolveRestartTarget(root, dir, options),
      observe: vi.fn(async () => started ? replacement : old), processStart: () => "helper", launch: vi.fn(async () => {}),
      stop: vi.fn(async () => true), ensure: vi.fn(async () => { started = true; return { spawned: true, runtime: { ...runtime, ...replacement } }; }),
      tunnel: vi.fn(async () => true) };
    writeSecureJson(path.join(stateDir, "tunnels", `${a.id}.json`), { workspaceId: a.id, preference: "named", provider: "cloudflare-named",
      tunnelName: "owner", tunnelId: randomUUID(), hostname: "owner.example" });
    writeSecureJson(path.join(stateDir, "tunnels", `${b.id}.json`), { workspaceId: "invalid-requester-state" });
    const record = await requestRestart(b.root, { stateDir, tunnel: true }, deps);
    expect(await runRestartHelper(record.id, stateDir, deps)).toMatchObject({ state: "complete", workspaceId: a.id, requestedWorkspace: { id: b.id } });
    expect(deps.stop).toHaveBeenCalledWith(b.root, { stateDir, expectedRuntime: old });
    expect(deps.ensure).toHaveBeenCalledWith(a.root, { stateDir, port: old.port });
    expect(deps.tunnel).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: a.id }));
  });
  it("shared restart persists A as owner, B as requester, and fences revoked authorization before helper stop", async () => {
    const identity = { pid: runtime.pid, port: runtime.port, startedAt: runtime.startedAt,
      stateDomainGeneration: owner.generation, processStartIdentity: owner.processStartIdentity! };
    const deps: RestartDeps = { resolveTarget: (root, dir) => resolveRestartTarget(root, dir, options),
      observe: vi.fn(async () => identity), processStart: () => "helper", launch: vi.fn(async () => {}),
      stop: vi.fn(async () => true), ensure: vi.fn(), tunnel: vi.fn() };
    const record = await requestRestart(b.root, { stateDir, tunnel: false }, deps);
    expect(record).toMatchObject({ workspaceId: a.id, workspaceRoot: a.root, requestedWorkspace: { id: b.id, root: b.root }, old: identity });
    expect(deps.observe).toHaveBeenCalledWith(a.root, stateDir);
    info.authorizedWorkspaces = [];
    expect(await runRestartHelper(record.id, stateDir, deps)).toMatchObject({ state: "failed", error: "VALIDATION_FAILED" });
    expect(deps.stop).not.toHaveBeenCalled(); expect(deps.ensure).not.toHaveBeenCalled();
  });
  it("stale restart recovery retains the actual shared owner and requesting workspace authorization", async () => {
    const old = { pid: runtime.pid, port: runtime.port, startedAt: runtime.startedAt,
      stateDomainGeneration: owner.generation, processStartIdentity: owner.processStartIdentity! };
    const deps: RestartDeps = { resolveTarget: (root, dir) => resolveRestartTarget(root, dir, options),
      observe: vi.fn(async () => old), processStart: () => "helper", launch: vi.fn(async () => {}),
      processIdentity: pid => pid === old.pid ? "same" : "gone", stop: vi.fn(async () => false), ensure: vi.fn(), tunnel: vi.fn() };
    const previous = await requestRestart(b.root, { stateDir, tunnel: false }, deps);
    const createdAt = Date.now() - 180_001;
    writeSecureJson(path.join(stateDir, "runtime", "restart-handoff.json"), { ...previous, createdAt, expiresAt: createdAt + 180_000,
      state: "stopping", helper: { pid: 900099, start: "dead-helper" } });
    const next = await requestRestart(b.root, { stateDir, tunnel: false }, deps);
    expect(next.id).not.toBe(previous.id);
    expect(next).toMatchObject({ workspaceId: a.id, workspaceRoot: a.root, requestedWorkspace: { id: b.id, root: b.root }, old });
    expect(await runRestartHelper(next.id, stateDir, deps)).toMatchObject({ state: "failed", error: "STOP_FAILED" });
    expect(deps.stop).toHaveBeenCalledWith(b.root, { stateDir, expectedRuntime: old });
    expect(deps.ensure).not.toHaveBeenCalled();
  });
});
