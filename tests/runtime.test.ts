import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge } from "../src/bridge/server.js";
import {
  findBridgeObservation,
  findLiveBridge,
  clearRuntimeState,
  readRuntimeState,
  writeRuntimeState,
  type BridgeProcessIdentity,
  type RuntimeState,
} from "../src/bridge/runtime.js";
import { ensureBridge } from "../src/process/daemon.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

function stubRuntime(workspaceId: string, workspaceRoot: string, pid: number, port: number): RuntimeState {
  return {
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId,
    workspaceRoot,
    pid,
    port,
    adminToken: "test-token",
    publicUrl: null,
    startedAt: new Date().toISOString(),
  };
}

const bridgeEntrypoint = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli", "index.js");
function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

describe("findBridgeObservation", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("treats a missing runtime file as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-missing");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const observation = await findBridgeObservation(workspace.id);
    expect(observation.state).toBe("stopped");
    if (observation.state === "stopped") expect(observation.reason).toBe("runtime_missing");
    expect(await findLiveBridge(workspace.id)).toBeNull();
  });

  it("does not let an old bridge shutdown clear a replacement runtime record", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("runtime-generation");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const oldRuntime = stubRuntime(workspace.id, workspace.root, 10_001, 49_001);
    oldRuntime.startedAt = "2026-09-03T00:00:00.000Z";
    writeRuntimeState(oldRuntime);
    const replacement = { ...oldRuntime, pid: 10_002, port: 49_002, startedAt: "2026-09-03T00:00:01.000Z" };
    writeRuntimeState(replacement);

    clearRuntimeState(workspace.id, oldRuntime.startedAt);
    expect(readRuntimeState(workspace.id)).toMatchObject({ pid: replacement.pid, startedAt: replacement.startedAt });

    clearRuntimeState(workspace.id, replacement.startedAt);
    expect(readRuntimeState(workspace.id)).toBeNull();
  });

  it("treats a dead pid plus a failed probe as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-dead");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    writeRuntimeState(stubRuntime(workspace.id, workspace.root, 999_999_999, 1));
    const options = { processInspector: { list: () => [] }, probe: async () => null };
    const observation = await findBridgeObservation(workspace.id, root, options);
    expect(observation.state).toBe("stopped");
    if (observation.state === "stopped") expect(observation.reason).toBe("pid_missing");
    expect(await findLiveBridge(workspace.id, root, options)).toBeNull();
  });

  it("does not treat a live pid plus a failed probe as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-unknown");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    try {
      if (!child.pid) throw new Error("failed to spawn helper");
      writeRuntimeState(stubRuntime(workspace.id, workspace.root, child.pid, 1));
      const options = { processInspector: { list: () => [{ pid: child.pid!, executable: process.execPath, commandLine: "test-owned helper", listeningPorts: [] }] }, probe: async () => null };
      const observation = await findBridgeObservation(workspace.id, root, options);
      expect(observation.state).toBe("unknown");
      if (observation.state === "unknown") expect(observation.reason).toBe("stale_runtime");
      expect(await findLiveBridge(workspace.id, root, options)).toBeNull();
      await expect(ensureBridge(root, options)).rejects.toThrow(/uncertain/);
    } finally {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
  });

  it("reports healthy when the local bridge answers", async () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const root = makeTmpDir("obs-live");
    dirs.push(root);
    write(root, "a.txt", "a");
    const auth = path.join(makeTmpDir("obs-auth"), "store.json");
    dirs.push(path.dirname(auth));
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: true,
      enforceStateOwnership: false,
      authStoreFile: auth,
    });
    try {
      const processInfo = {
        pid: process.pid,
        executable: process.execPath,
        commandLine: `${quote(process.execPath)} ${quote(bridgeEntrypoint)} serve --workspace ${quote(bridge.workspace.root)} --state-dir ${quote(stateDir)}`,
        listeningPorts: [bridge.port],
      };
      const probe = async (port: number) =>
        port === bridge.port
          ? { service: SERVICE_NAME, version: VERSION, workspaceId: bridge.workspace.id, status: "ok" }
          : null;
      const processInspector = { list: () => [processInfo] };
      const observation = await findBridgeObservation(bridge.workspace.id, bridge.workspace.root, { processInspector, probe });
      expect(observation.state).toBe("healthy");
      expect(await findLiveBridge(bridge.workspace.id, bridge.workspace.root, { processInspector, probe })).not.toBeNull();
    } finally {
      await bridge.close();
    }
  });

  it("does not adopt an unannotated legacy bridge into an explicit isolated state domain", async () => {
    dirs.push(isolateStateDir());
    const isolatedState = isolateStateDir();
    dirs.push(isolatedState);
    const root = makeTmpDir("runtime-isolated-domain");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const port = 49_003;
    const legacyProcess: BridgeProcessIdentity = {
      pid: 2_147_000_002,
      executable: process.execPath,
      commandLine: `${quote(process.execPath)} ${quote(bridgeEntrypoint)} serve --workspace ${quote(workspace.root)}`,
      listeningPorts: [port],
    };
    const probe = async (candidatePort: number) =>
      candidatePort === port
        ? { service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, status: "ok" }
        : null;

    const observation = await findBridgeObservation(workspace.id, workspace.root, {
      stateDir: isolatedState,
      processInspector: { list: () => [legacyProcess] },
      probe,
    });

    expect(observation.state).toBe("stopped");
  });
});
