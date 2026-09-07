import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ensureBridge, stopBridge } from "../src/process/daemon.js";
import {
  isOwnedBridgeProcess,
  readRuntimeState,
  reconcileBridgeRuntime,
  runtimeFile,
  writeRuntimeState,
  type BridgeProbe,
  type BridgeProcessIdentity,
  type BridgeProcessInspector,
  type RuntimeState,
} from "../src/bridge/runtime.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { readTunnelState, writeTunnelState } from "../src/tunnel/state.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeEntrypoint = fs.existsSync(path.join(repositoryRoot, "dist", "cli", "index.js"))
  ? path.join(repositoryRoot, "dist", "cli", "index.js")
  : path.join(repositoryRoot, "src", "cli", "index.ts");

const dirs: string[] = [];

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function bridgeProcess(
  root: string,
  pid: number,
  port: number,
  overrides: Partial<BridgeProcessIdentity> = {}
): BridgeProcessIdentity {
  const stateDir = process.env.C2C_STATE_DIR;
  return {
    pid,
    executable: process.execPath,
    commandLine: `${quote(process.execPath)} ${quote(bridgeEntrypoint)} serve --workspace ${quote(root)}${stateDir ? ` --state-dir ${quote(stateDir)}` : ""}`,
    listeningPorts: [port],
    ...overrides,
  };
}

function inspector(processes: readonly BridgeProcessIdentity[]): BridgeProcessInspector {
  return { list: () => processes };
}

function probeFor(workspaceId: string, ports: readonly number[]): BridgeProbe {
  const allowed = new Set(ports);
  return async (port) =>
    allowed.has(port)
      ? { service: SERVICE_NAME, version: VERSION, workspaceId, status: "ok" }
      : null;
}

function runtime(workspace: Workspace, pid: number, port: number): RuntimeState {
  return {
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    pid,
    port,
    adminToken: "stale-admin-token",
    publicUrl: null,
    startedAt: "2026-09-03T00:00:00.000Z",
  };
}

function workspace(name: string): Workspace {
  const root = makeTmpDir(name);
  dirs.push(root);
  write(root, "hello.txt", `${name}\n`);
  return new Workspace(root);
}

afterEach(() => {
  for (const dir of dirs) cleanup(dir);
  dirs.length = 0;
  delete process.env.C2C_STATE_DIR;
});

describe("bridge runtime ownership reconciliation", () => {
  it("restart runtime fence rejects a changed generation before admin shutdown or signaling", async () => {
    dirs.push(isolateStateDir());
    const current = workspace("restart-generation-fence");
    const candidate = bridgeProcess(current.root, 33009, 50115);
    const persisted = runtime(current, candidate.pid, candidate.listeningPorts[0]);
    writeRuntimeState(persisted);
    const signaled: number[] = [];
    await expect(stopBridge(current.root, {
      processInspector: inspector([candidate]), probe: probeFor(current.id, [candidate.listeningPorts[0]]),
      expectedRuntime: { ...persisted, startedAt: "2026-09-02T00:00:00.000Z" },
      killProcess: pid => { signaled.push(pid); },
    })).rejects.toThrow(/ownership changed before shutdown/);
    expect(signaled).toEqual([]); expect(readRuntimeState(current.id)?.pid).toBe(persisted.pid);
  });
  it("retains conclusively dead runtime evidence until the next owner publishes", async () => {
    dirs.push(isolateStateDir());
    const current = workspace("runtime-missing-pid");
    writeRuntimeState(runtime(current, 22001, 50101));

    const observation = await reconcileBridgeRuntime(current.id, current.root, {
      processInspector: inspector([]),
      probe: probeFor(current.id, []),
      signalProcess: () => {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      },
    });

    expect(observation).toMatchObject({ state: "stopped", reason: "pid_missing" });
    expect(readRuntimeState(current.id)?.pid).toBe(22001);
  });

  it("adopts one validated bridge when the persisted PID is stale", async () => {
    dirs.push(isolateStateDir());
    const current = workspace("runtime-adopt");
    writeRuntimeState(runtime(current, 22002, 50102));
    const candidate = bridgeProcess(current.root, 33002, 50103);

    const observation = await reconcileBridgeRuntime(current.id, current.root, {
      processInspector: inspector([candidate]),
      probe: probeFor(current.id, [candidate.listeningPorts[0]]),
    });

    expect(observation).toMatchObject({ state: "healthy", reconciled: true });
    if (observation.state !== "healthy") return;
    expect(observation.runtime).toMatchObject({
      pid: candidate.pid,
      port: candidate.listeningPorts[0],
      workspaceId: current.id,
      workspaceRoot: current.root,
      adminTokenKnown: false,
      adminToken: "",
    });
    expect(readRuntimeState(current.id)).toMatchObject({ pid: 22002, port: 50102 });
    expect(runtimeFile(current.id)).toContain("runtime");
  });

  it("rejects a reused PID with an unrelated executable", async () => {
    dirs.push(isolateStateDir());
    const current = workspace("runtime-pid-reuse");
    const reused = bridgeProcess(current.root, 22003, 50104, {
      executable: process.platform === "win32" ? "C:\\Windows\\System32\\svchost.exe" : "/usr/bin/sleep",
    });
    writeRuntimeState(runtime(current, reused.pid, reused.listeningPorts[0]));

    expect(isOwnedBridgeProcess(reused, current.id, current.root)).toBe(false);
    const observation = await reconcileBridgeRuntime(current.id, current.root, {
      processInspector: inspector([reused]),
      probe: probeFor(current.id, [reused.listeningPorts[0]]),
    });

    expect(observation).toMatchObject({ state: "unknown", reason: "stale_runtime" });
    expect(readRuntimeState(current.id)).toMatchObject({ pid: reused.pid });
  });

  it("rejects the expected executable when the command line is not the bridge", async () => {
    dirs.push(isolateStateDir());
    const current = workspace("runtime-commandline");
    const wrongCommand = bridgeProcess(current.root, 22004, 50105, {
      commandLine: `${quote(process.execPath)} -e ${quote("setInterval(() => {}, 1000)")}`,
    });
    writeRuntimeState(runtime(current, wrongCommand.pid, wrongCommand.listeningPorts[0]));

    expect(isOwnedBridgeProcess(wrongCommand, current.id, current.root)).toBe(false);
    const observation = await reconcileBridgeRuntime(current.id, current.root, {
      processInspector: inspector([wrongCommand]),
      probe: probeFor(current.id, [wrongCommand.listeningPorts[0]]),
    });

    expect(observation).toMatchObject({ state: "unknown", reason: "stale_runtime" });
  });

  it("fails closed when process ownership inspection is unavailable", async () => {
    dirs.push(isolateStateDir());
    const current = workspace("runtime-inspection-unavailable");
    writeRuntimeState(runtime(current, 22009, 50115));

    const observation = await reconcileBridgeRuntime(current.id, current.root, {
      processInspector: { list: () => null },
      probe: probeFor(current.id, [50115]),
    });

    expect(observation).toMatchObject({ state: "unknown", reason: "ownership_unknown" });
    expect(readRuntimeState(current.id)).toMatchObject({ pid: 22009, port: 50115 });
  });

  it("fails closed when multiple valid bridges exist and does not launch a third", async () => {
    dirs.push(isolateStateDir());
    const current = workspace("runtime-duplicate");
    writeRuntimeState(runtime(current, 22005, 50106));
    const first = bridgeProcess(current.root, 33005, 50107);
    const second = bridgeProcess(current.root, 33006, 50108);
    const processInspector = inspector([first, second]);
    const probe = probeFor(current.id, [first.listeningPorts[0], second.listeningPorts[0]]);

    const observation = await reconcileBridgeRuntime(current.id, current.root, { processInspector, probe });
    expect(observation).toMatchObject({ state: "unknown", reason: "duplicate_bridges" });
    expect(readRuntimeState(current.id)).toMatchObject({ pid: 22005, port: 50106 });
    await expect(ensureBridge(current.root, { processInspector, probe })).rejects.toThrow(/duplicate_bridges/);
    await expect(stopBridge(current.root, { processInspector, probe })).rejects.toThrow(/duplicate_bridges/);
  });

  it("refuses privileged stop of a bridge discovered without its credential", async () => {
    dirs.push(isolateStateDir());
    const current = workspace("runtime-stop-adopted");
    writeRuntimeState(runtime(current, 22007, 50112));
    const candidate = bridgeProcess(current.root, 987_654_321, 50113);
    let active = true;
    const processInspector: BridgeProcessInspector = { list: () => (active ? [candidate] : []) };
    const probe: BridgeProbe = async (port) =>
      active && port === candidate.listeningPorts[0]
        ? { service: SERVICE_NAME, version: VERSION, workspaceId: current.id, status: "ok" }
        : null;
    const signaled: number[] = [];

    await expect(stopBridge(current.root, {
      processInspector,
      probe,
      killProcess: (pid) => {
        signaled.push(pid);
        active = false;
      },
    })).rejects.toThrow(/admin_proof_unavailable/);

    expect(signaled).toEqual([]);
    expect(readRuntimeState(current.id)?.pid).toBe(22007);
  });

  it("does not spawn a duplicate and preserves named tunnel preference after adoption", async () => {
    dirs.push(isolateStateDir());
    const current = workspace("runtime-named");
    writeRuntimeState(runtime(current, 22006, 50109));
    writeTunnelState({
      workspaceId: current.id,
      preference: "named",
      provider: "cloudflare-named",
      tunnelName: "c2c-runtime-test",
      tunnelId: "52087d82-cd6f-461c-add4-cc52050e205f",
      hostname: "c2c-runtime.example.test",
      zone: "example.test",
    });
    const candidate = bridgeProcess(current.root, 33007, 50110);
    const processInspector = inspector([candidate]);
    const probe = probeFor(current.id, [candidate.listeningPorts[0]]);

    await expect(ensureBridge(current.root, { processInspector, probe })).rejects.toThrow(/BRIDGE_RUNTIME_CREDENTIAL_UNAVAILABLE/);
    expect(readTunnelState(current.id)).toMatchObject({
      preference: "named",
      provider: "cloudflare-named",
      hostname: "c2c-runtime.example.test",
    });
  });

  it("accepts a validated recorded pointer without rewriting it", async () => {
    dirs.push(isolateStateDir());
    const current = workspace("runtime-recorded");
    const candidate = bridgeProcess(current.root, 33008, 50111);
    const persisted = runtime(current, candidate.pid, candidate.listeningPorts[0]);
    writeRuntimeState(persisted);

    const observation = await reconcileBridgeRuntime(current.id, current.root, {
      processInspector: inspector([candidate]),
      probe: probeFor(current.id, [candidate.listeningPorts[0]]),
    });

    expect(observation).toMatchObject({ state: "healthy", reconciled: false });
    expect(readRuntimeState(current.id)).toMatchObject({
      pid: persisted.pid,
      port: persisted.port,
      startedAt: persisted.startedAt,
      adminToken: persisted.adminToken,
    });
  });

  it("preserves runtime when process inventory is incomplete or empty but PID probe is alive", async () => {
    dirs.push(isolateStateDir());
    const current = workspace("runtime-incomplete-inventory-live-pid");
    const persisted = runtime(current, 44001, 50201);
    writeRuntimeState(persisted);

    const observation = await reconcileBridgeRuntime(current.id, current.root, {
      processInspector: inspector([]),
      probe: probeFor(current.id, []),
      signalProcess: (pid) => {
        expect(pid).toBe(persisted.pid);
      },
    });

    expect(observation).toMatchObject({ state: "unknown", reason: "pid_unknown" });
    const preserved = readRuntimeState(current.id);
    expect(preserved).toMatchObject({
      pid: persisted.pid,
      port: persisted.port,
      adminToken: persisted.adminToken,
    });
  });

  it("fails closed and preserves runtime when PID probe fails with permission error or unknown error", async () => {
    dirs.push(isolateStateDir());
    const current = workspace("runtime-permission-fail-closed");
    const persisted = runtime(current, 44002, 50202);
    writeRuntimeState(persisted);

    const observationEperm = await reconcileBridgeRuntime(current.id, current.root, {
      processInspector: inspector([]),
      probe: probeFor(current.id, []),
      signalProcess: () => {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      },
    });
    expect(observationEperm).toMatchObject({ state: "unknown", reason: "pid_unknown" });
    expect(readRuntimeState(current.id)).toMatchObject({ pid: persisted.pid });

    const observationEacces = await reconcileBridgeRuntime(current.id, current.root, {
      processInspector: inspector([]),
      probe: probeFor(current.id, []),
      signalProcess: () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    });
    expect(observationEacces).toMatchObject({ state: "unknown", reason: "pid_unknown" });
    expect(readRuntimeState(current.id)).toMatchObject({ pid: persisted.pid });

    const observationUnknown = await reconcileBridgeRuntime(current.id, current.root, {
      processInspector: inspector([]),
      probe: probeFor(current.id, []),
      signalProcess: () => {
        throw new Error("unexpected signaling failure");
      },
    });
    expect(observationUnknown).toMatchObject({ state: "unknown", reason: "pid_unknown" });
    expect(readRuntimeState(current.id)).toMatchObject({ pid: persisted.pid });
  });

  it("allows replacement after ESRCH without a racy stale-pointer unlink", async () => {
    dirs.push(isolateStateDir());
    const current = workspace("runtime-esrch-cleanup");
    const persisted = runtime(current, 44003, 50203);
    writeRuntimeState(persisted);

    const observation = await reconcileBridgeRuntime(current.id, current.root, {
      processInspector: inspector([]),
      probe: probeFor(current.id, []),
      signalProcess: () => {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      },
    });

    expect(observation).toMatchObject({ state: "stopped", reason: "pid_missing" });
    expect(readRuntimeState(current.id)).toEqual({ ...persisted, adminTokenKnown: true });
  });

  it("preserves runtime when PID probe returns ESRCH but same-workspace health listener answers on recorded port", async () => {
    dirs.push(isolateStateDir());
    const current = workspace("runtime-esrch-conflicting-health");
    const persisted = runtime(current, 44004, 50204);
    writeRuntimeState(persisted);

    const observation = await reconcileBridgeRuntime(current.id, current.root, {
      processInspector: inspector([]),
      probe: probeFor(current.id, [persisted.port]),
      signalProcess: () => {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      },
    });

    expect(observation).toMatchObject({ state: "unknown", reason: "pid_unknown" });
    expect(readRuntimeState(current.id)).toMatchObject({
      pid: persisted.pid,
      port: persisted.port,
      adminToken: persisted.adminToken,
    });
  });

  it("preserves runtime without mutation when repairRuntime is false even for dead PID", async () => {
    dirs.push(isolateStateDir());
    const current = workspace("runtime-readonly-no-mutation");
    const persisted = runtime(current, 44005, 50205);
    writeRuntimeState(persisted);

    const observation = await reconcileBridgeRuntime(current.id, current.root, {
      processInspector: inspector([]),
      probe: probeFor(current.id, []),
      repairRuntime: false,
      signalProcess: () => {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      },
    });

    expect(observation).toMatchObject({ state: "stopped", reason: "pid_missing" });
    expect(readRuntimeState(current.id)).toMatchObject({
      pid: persisted.pid,
      port: persisted.port,
      adminToken: persisted.adminToken,
    });
  });

  it("refuses to spawn a new bridge writer when bridge state is ambiguous", async () => {
    dirs.push(isolateStateDir());
    const current = workspace("runtime-ensurebridge-ambiguous");
    const persisted = runtime(current, 44006, 50206);
    writeRuntimeState(persisted);

    await expect(
      ensureBridge(current.root, {
        processInspector: inspector([]),
        probe: probeFor(current.id, []),
        signalProcess: () => {},
      })
    ).rejects.toThrow(/Bridge state is uncertain \(pid_unknown\); refusing to start another bridge\./);

    expect(readRuntimeState(current.id)).toMatchObject({
      pid: persisted.pid,
      port: persisted.port,
      adminToken: persisted.adminToken,
    });
  });

  it("preserves runtime using real current process PID when omitted from process inventory", async () => {
    dirs.push(isolateStateDir());
    const current = workspace("runtime-real-process-pid");
    const persisted = runtime(current, process.pid, 50207);
    writeRuntimeState(persisted);

    const observation = await reconcileBridgeRuntime(current.id, current.root, {
      processInspector: inspector([]),
      probe: probeFor(current.id, []),
    });

    expect(observation).toMatchObject({ state: "unknown", reason: "pid_unknown" });
    expect(readRuntimeState(current.id)).toMatchObject({
      pid: process.pid,
      port: persisted.port,
      adminToken: persisted.adminToken,
    });
  });
});
