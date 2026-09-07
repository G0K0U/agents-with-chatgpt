import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeState, findBridgeObservation, readRuntimeState, reconcileBridgeRuntime,
  runtimeFile, writeRuntimeState, type RuntimeState, type BridgeProcessIdentity } from "../src/bridge/runtime.js";
import { stateDomainOwnerFile, type StateDomainOwnerRecord } from "../src/bridge/state-owner.js";
import { ensureBridge, findSharedBridgeObservation, stopBridge, type SharedBridgeObservationOptions } from "../src/process/daemon.js";
import { writeSecureJson } from "../src/config/paths.js";
import { Workspace } from "../src/workspace/manager.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { cleanup, makeTmpDir } from "./helpers.js";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(() => { throw new Error("Unexpected duplicate spawn"); }),
}));

describe("G7C runtime pointer lifecycle (hermetic)", () => {
  let base: string, stateDir: string, file: string, workspace: Workspace;
  let owner: StateDomainOwnerRecord, runtime: RuntimeState, rows: BridgeProcessIdentity[];
  let options: SharedBridgeObservationOptions;
  let expectedSpawns: number;
  beforeEach(() => {
    base = makeTmpDir("g7c-pointer");
    expectedSpawns = 0;
    fs.mkdirSync(path.join(base, "workspace"));
    workspace = new Workspace(path.join(base, "workspace"));
    stateDir = path.join(base, "state");
    vi.stubEnv("C2C_STATE_DIR", stateDir);
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network access"); }));
    owner = { schema: 1, stateDir, generation: randomUUID(), workspaceId: workspace.id, workspaceRoot: workspace.root,
      pid: 987654321, processStartIdentity: "exact-owner-start", acquiredAt: "2026-09-06T13:49:57.917Z", authFile: "" };
    owner.authFile = path.join(stateDir, "auth", `bridge.${owner.generation}.json`);
    writeSecureJson(stateDomainOwnerFile(stateDir), owner);
    runtime = { service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, workspaceRoot: workspace.root,
      pid: owner.pid, port: 48765, adminToken: "fixture-only", adminTokenKnown: true, publicUrl: null,
      startedAt: "2026-09-06T13:49:57.927Z", stateDir, stateDomainGeneration: owner.generation };
    writeRuntimeState(runtime, stateDir); file = runtimeFile(workspace.id, stateDir);
    rows = [{ pid: owner.pid, processStartIdentity: owner.processStartIdentity!, executable: process.execPath,
      commandLine: `"${process.execPath}" "${path.resolve("src/cli/index.ts")}" serve --workspace "${workspace.root}" --state-dir "${stateDir}"`,
      listeningPorts: [runtime.port] }];
    options = { stateDir, processInspector: { list: () => rows }, isProcessAlive: () => "alive",
      probe: async () => ({ service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, status: "ok" }) };
  });
  afterEach(() => {
    expect(spawn).toHaveBeenCalledTimes(expectedSpawns);
    vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); cleanup(base);
  });
  const observe = () => reconcileBridgeRuntime(workspace.id, workspace.root, options);

  it("second start and repeated reconcile preserve exact owner's authenticated bytes", async () => {
    const before = fs.readFileSync(file);
    expect(await observe()).toMatchObject({ state: "healthy", reconciled: false });
    expect(await findBridgeObservation(workspace.id, workspace.root, { ...options, repairRuntime: false }))
      .toMatchObject({ state: "healthy" });
    for (let i = 0; i < 2; i++) {
      expect(await ensureBridge(workspace.root, options)).toMatchObject({ spawned: false, runtime });
    }
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it.each([true, false])("missing pointer with exact live owner gives distinct safe error (repair=%s)", async repairRuntime => {
    fs.unlinkSync(file); options.repairRuntime = repairRuntime;
    expect(await observe()).toMatchObject({ state: "unknown", reason: "admin_proof_unavailable", runtime: null });
    await expect(ensureBridge(workspace.root, options)).rejects.toThrow(/BRIDGE_RUNTIME_CREDENTIAL_UNAVAILABLE/);
    await expect(stopBridge(workspace.root, options)).rejects.toThrow(/admin_proof_unavailable/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("never treats tokenless owner metadata as privileged control", async () => {
    writeRuntimeState({ ...runtime, adminToken: "", adminTokenKnown: false }, stateDir);
    const killProcess = vi.fn();
    await expect(ensureBridge(workspace.root, options)).rejects.toThrow(/BRIDGE_RUNTIME_CREDENTIAL_UNAVAILABLE/);
    await expect(stopBridge(workspace.root, { ...options, killProcess })).rejects.toThrow(/admin_proof_unavailable/);
    expect(killProcess).not.toHaveBeenCalled();
  });

  it.each(["reused", "identity-missing", "inspection-null", "generation", "owner-invalid"])("fails closed for %s", async mode => {
    if (mode === "reused") rows[0].processStartIdentity = "reused-pid";
    if (mode === "identity-missing") rows[0].processStartIdentity = undefined;
    if (mode === "inspection-null") options.processInspector = { list: () => null };
    if (mode === "generation") writeRuntimeState({ ...runtime, stateDomainGeneration: randomUUID() }, stateDir);
    if (mode === "owner-invalid") fs.writeFileSync(stateDomainOwnerFile(stateDir), "{");
    const before = fs.readFileSync(file);
    expect(await observe()).toMatchObject({ state: "unknown" });
    await expect(ensureBridge(workspace.root, options)).rejects.toThrow(/uncertain/);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it.each(["alive", "unknown", "dead"] as const)("stale evidence requires conclusive death (%s) and is never unlinked by discovery", async liveness => {
    fs.unlinkSync(stateDomainOwnerFile(stateDir)); rows = [];
    options.isProcessAlive = () => liveness; options.probe = async () => null;
    const before = fs.readFileSync(file);
    expect(await observe()).toMatchObject(liveness === "dead"
      ? { state: "stopped", reason: "pid_missing" } : { state: "unknown", reason: "pid_unknown" });
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("never deletes a same-PID/time replacement generation published during stale probing", async () => {
    fs.unlinkSync(stateDomainOwnerFile(stateDir)); rows = []; options.isProcessAlive = () => "dead";
    const replacement = { ...runtime, stateDomainGeneration: randomUUID(), adminToken: "replacement-fixture" };
    options.probe = async () => { writeRuntimeState(replacement, stateDir); return null; };
    expect(await observe()).toMatchObject({ state: "unknown", reason: "runtime_changed" });
    expect(readRuntimeState(workspace.id, stateDir)).toEqual(replacement);
    clearRuntimeState(workspace.id, runtime, stateDir);
    expect(readRuntimeState(workspace.id, stateDir)).toEqual(replacement);
  });

  it("missing initial read cannot unlink a pointer published during inventory", async () => {
    fs.unlinkSync(file); fs.unlinkSync(stateDomainOwnerFile(stateDir));
    options.processInspector = { list: () => { writeRuntimeState(runtime, stateDir); return []; } };
    expect(await observe()).toMatchObject({ state: "unknown", reason: "runtime_changed" });
    expect(readRuntimeState(workspace.id, stateDir)).toEqual(runtime);
  });

  it.each([true, false])("transient read failure never deletes a valid pointer even without a supplied root (repair=%s)", async repairRuntime => {
    const before = fs.readFileSync(file); const read = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementationOnce((...args: any[]) => {
      if (String(args[0]) === file) throw Object.assign(new Error("fixture read denied"), { code: "EACCES" });
      return (read as any)(...args);
    });
    expect(await reconcileBridgeRuntime(workspace.id, undefined, { ...options, repairRuntime }))
      .toMatchObject({ state: "unknown", reason: "runtime_unreadable" });
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("malformed pointer and a live serve without a responding listener cannot permit startup", async () => {
    fs.writeFileSync(file, "{");
    expect(await observe()).toMatchObject({ state: "unknown", reason: "runtime_unreadable" });
    expect(fs.readFileSync(file, "utf8")).toBe("{");
    fs.unlinkSync(file); options.probe = async () => null; rows[0].listeningPorts = [];
    expect(await observe()).toMatchObject({ state: "unknown", reason: "runtime_initializing" });
    await expect(ensureBridge(workspace.root, options)).rejects.toThrow(/runtime_initializing/);
  });

  it("runtime publication failure keeps the previous credential instead of unlink/retry", () => {
    const before = fs.readFileSync(file);
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw Object.assign(new Error("fixture sharing violation"), { code: "EPERM" }); });
    expect(() => writeRuntimeState({ ...runtime, publicUrl: "https://fixture.invalid" }, stateDir)).toThrow(/sharing violation/);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  it("shared requester cannot bypass missing owner's credential or create its own pointer", async () => {
    fs.mkdirSync(path.join(base, "requester")); const requester = new Workspace(path.join(base, "requester"));
    fs.unlinkSync(file);
    expect(await findSharedBridgeObservation(requester.id, requester.root, options))
      .toMatchObject({ state: "unknown", reason: "admin_proof_unavailable" });
    await expect(ensureBridge(requester.root, options)).rejects.toThrow(/BRIDGE_RUNTIME_CREDENTIAL_UNAVAILABLE/);
    expect(readRuntimeState(requester.id, stateDir)).toBeNull();
  });

  it("boots deterministically after conclusive owner death while retaining stale evidence until publication", async () => {
    rows = []; options.isProcessAlive = () => "dead";
    options.probe = async () => rows.length
      ? { service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, status: "ok" } : null;
    const oldBytes = fs.readFileSync(file);
    const replacement = { ...runtime, pid: owner.pid - 1, stateDomainGeneration: randomUUID(), startedAt: "2026-09-07T01:00:00.000Z" };
    expectedSpawns = 1;
    vi.mocked(spawn).mockImplementationOnce(() => {
      expect(fs.readFileSync(file)).toEqual(oldBytes);
      const nextOwner = { ...owner, pid: replacement.pid, generation: replacement.stateDomainGeneration,
        processStartIdentity: "replacement-start", authFile: path.join(stateDir, "auth", `bridge.${replacement.stateDomainGeneration}.json`) };
      writeSecureJson(stateDomainOwnerFile(stateDir), nextOwner);
      writeRuntimeState(replacement, stateDir);
      rows = [{ pid: replacement.pid, processStartIdentity: nextOwner.processStartIdentity, executable: process.execPath,
        commandLine: `"${process.execPath}" "${path.resolve("src/cli/index.ts")}" serve --workspace "${workspace.root}" --state-dir "${stateDir}"`,
        listeningPorts: [replacement.port] }];
      return { unref: vi.fn(), exitCode: null } as any;
    });
    expect(await ensureBridge(workspace.root, options)).toMatchObject({ spawned: true, runtime: replacement });
    expect(readRuntimeState(workspace.id, stateDir)).toEqual(replacement);
  });
});
