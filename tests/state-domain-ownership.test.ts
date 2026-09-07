import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStore } from "../src/auth/store.js";
import {
  acquireStateDomainOwner,
  resolveOwnedAuthStorage,
  stateDomainOwnerFile,
  stateDomainOwnerLockFile,
  writeAuthStatePointer,
  type StateDomainOwnerRecord,
} from "../src/bridge/state-owner.js";
import type { BridgeProcessIdentity, BridgeProcessInspector } from "../src/bridge/runtime.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { stableWorkspaceId } from "../src/workspace/identity.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";
import { writeSecureJson } from "../src/config/paths.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REDIRECT_URI = "https://chatgpt.com/connector/oauth/test";

const dirs: string[] = [];
const originalStateDir = process.env.C2C_STATE_DIR;

function currentProcessInspector(identity = "test-process-start"): BridgeProcessInspector {
  const current: BridgeProcessIdentity = {
    pid: process.pid,
    executable: process.execPath,
    commandLine: "vitest state-domain-ownership",
    listeningPorts: [],
    processStartIdentity: identity,
  };
  return { list: () => [current] };
}

function workspace(name: string): string {
  const root = makeTmpDir(name);
  dirs.push(root);
  write(root, "workspace.txt", `${name}\n`);
  return root;
}

function externalStateDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `c2c-${name}-`));
  const real = fs.realpathSync.native(dir);
  dirs.push(real);
  return real;
}

function ownedAuthStore(owner: ReturnType<typeof acquireStateDomainOwner>, workspaceId: string): AuthStore {
  const storage = resolveOwnedAuthStorage(owner);
  const store = new AuthStore(workspaceId, {
    file: storage.file,
    legacyFiles: storage.legacyFiles,
    authorizedWorkspaceIds: [workspaceId],
    generationFence: owner,
    legacyFilesReadOnly: true,
  });
  if (!fs.existsSync(storage.file)) writeSecureJson(storage.file, { clients: [], tokens: [] });
  writeAuthStatePointer(owner);
  return store;
}

function writeStaleOwner(stateDir: string, root: string, pid: number, processStartIdentity: string | null): void {
  const generation = "11111111-1111-4111-8111-111111111111";
  const authFile = path.join(stateDir, "auth", `bridge.${generation}.json`);
  const owner: StateDomainOwnerRecord = {
    schema: 1,
    stateDir,
    generation,
    workspaceId: stableWorkspaceId(new Workspace(root).root),
    workspaceRoot: new Workspace(root).root,
    pid,
    processStartIdentity,
    acquiredAt: "2026-09-03T00:00:00.000Z",
    authFile,
  };
  const lock = {
    schema: 1,
    ownerToken: "stale-owner-token",
    generation,
    stateDir,
    workspaceId: owner.workspaceId,
    pid,
    processStartIdentity,
    createdAt: owner.acquiredAt,
  };
  writeSecureJson(stateDomainOwnerFile(stateDir), owner);
  fs.writeFileSync(stateDomainOwnerLockFile(stateDir), JSON.stringify(lock), { mode: 0o600 });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) cleanup(dir);
  if (originalStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = originalStateDir;
});

describe("C2C state-domain ownership and OAuth generations", () => {
  it("lets the unified owner reject a second legacy bridge in the same state domain", async () => {
    const stateDir = makeTmpDir("state-owner-shared");
    const unifiedRoot = workspace("unified-owner");
    const legacyRoot = workspace("legacy-owner");
    const inspector = currentProcessInspector();
    const first = acquireStateDomainOwner({
      stateDir,
      workspaceRoot: unifiedRoot,
      workspaceId: new Workspace(unifiedRoot).id,
      processInspector: inspector,
    });

    expect(() => acquireStateDomainOwner({
      stateDir,
      workspaceRoot: legacyRoot,
      workspaceId: new Workspace(legacyRoot).id,
      processInspector: inspector,
    })).toThrow(/already owned.*isolated C2C_STATE_DIR/i);
    first.release();
  });

  it("allows independent bridges only when C2C_STATE_DIR is explicitly isolated", () => {
    const firstRoot = workspace("isolated-owner-a");
    const secondRoot = workspace("isolated-owner-b");
    const firstState = makeTmpDir("isolated-state-a");
    const secondState = makeTmpDir("isolated-state-b");
    const inspector = currentProcessInspector();
    const first = acquireStateDomainOwner({
      stateDir: firstState,
      workspaceRoot: firstRoot,
      workspaceId: new Workspace(firstRoot).id,
      processInspector: inspector,
    });
    const second = acquireStateDomainOwner({
      stateDir: secondState,
      workspaceRoot: secondRoot,
      workspaceId: new Workspace(secondRoot).id,
      processInspector: inspector,
    });

    expect(first.generation).not.toBe(second.generation);
    first.release();
    second.release();
  });

  it("rejects a live legacy serve pointer before creating a new owner", () => {
    const stateDir = makeTmpDir("legacy-runtime-pointer");
    const unifiedRoot = workspace("legacy-pointer-unified");
    const legacyRoot = workspace("legacy-pointer-engineering");
    const legacyWorkspace = new Workspace(legacyRoot);
    const bridgeEntrypoint = path.join(repositoryRoot, "dist", "cli", "index.js");
    const legacyPid = 2_147_000_001;
    writeSecureJson(path.join(stateDir, "runtime", `${legacyWorkspace.id}.json`), {
      service: "codex-with-chatgpt",
      version: "0.1.1",
      workspaceId: legacyWorkspace.id,
      workspaceRoot: legacyWorkspace.root,
      pid: legacyPid,
      port: 49_876,
      adminToken: "sanitized-test-token",
      publicUrl: null,
      startedAt: "2026-09-03T00:00:00.000Z",
      stateDir,
    });
    const legacyProcess: BridgeProcessIdentity = {
      pid: legacyPid,
      executable: process.execPath,
      commandLine: `"${process.execPath}" "${bridgeEntrypoint}" serve --workspace "${legacyRoot}"`,
      listeningPorts: [49_876],
      processStartIdentity: "legacy-process-start",
    };

    expect(() => acquireStateDomainOwner({
      stateDir,
      workspaceRoot: unifiedRoot,
      workspaceId: new Workspace(unifiedRoot).id,
      processInspector: { list: () => [legacyProcess] },
    })).toThrow(/legacy per-workspace bridge.*isolated C2C_STATE_DIR/i);
  });

  it("fences an old generation from writing OAuth state after a controlled transfer", () => {
    const stateDir = makeTmpDir("oauth-generation-transfer");
    const root = workspace("oauth-generation-workspace");
    const workspaceId = new Workspace(root).id;
    const inspector = currentProcessInspector();
    const first = acquireStateDomainOwner({ stateDir, workspaceRoot: root, workspaceId, processInspector: inspector });
    const oldStore = ownedAuthStore(first, workspaceId);
    const client = oldStore.registerClient({ clientName: "preserved-client", redirectUris: [REDIRECT_URI] });
    first.release();

    const replacement = acquireStateDomainOwner({ stateDir, workspaceRoot: root, workspaceId, processInspector: inspector });
    const newStore = ownedAuthStore(replacement, workspaceId);
    expect(newStore.getClient(client.clientId)).toEqual(client);
    // A pre-fencing legacy bridge can still touch bridge.json, but the active
    // generation must never consult that migration-only file again.
    writeSecureJson(path.join(stateDir, "auth", "bridge.json"), {
      clients: [{
        clientId: "c2c_client_stale_legacy",
        clientName: "stale legacy row",
        redirectUris: [REDIRECT_URI],
        createdAt: "2026-09-03T00:00:00.000Z",
      }],
      tokens: [],
    });
    expect(newStore.getClient("c2c_client_stale_legacy")).toBeUndefined();
    expect(() => oldStore.registerClient({ clientName: "stale-client", redirectUris: [REDIRECT_URI] })).toThrow(/no longer authoritative/i);
    expect(newStore.getClient(client.clientId)).toEqual(client);
    replacement.release();
  });

  it("preserves one client registration through five controlled generations", () => {
    const stateDir = makeTmpDir("oauth-generation-five-restarts");
    const root = workspace("oauth-five-restarts");
    const workspaceId = new Workspace(root).id;
    const inspector = currentProcessInspector();
    let clientId: string | null = null;

    for (let index = 0; index < 5; index += 1) {
      const owner = acquireStateDomainOwner({ stateDir, workspaceRoot: root, workspaceId, processInspector: inspector });
      const store = ownedAuthStore(owner, workspaceId);
      if (clientId === null) {
        clientId = store.registerClient({ clientName: "restart-stable-client", redirectUris: [REDIRECT_URI] }).clientId;
      }
      expect(store.getClient(clientId)).toBeDefined();
      owner.release();
    }
  });

  it("recovers a stale owner whose PID is no longer present", () => {
    const stateDir = makeTmpDir("stale-owner-recovery");
    const root = workspace("stale-owner-workspace");
    const workspaceId = new Workspace(root).id;
    writeStaleOwner(stateDir, root, 2_147_000_000, "dead-process-start");
    const recovered = acquireStateDomainOwner({
      stateDir,
      workspaceRoot: root,
      workspaceId,
      processInspector: currentProcessInspector(),
    });
    expect(recovered.generation).not.toBe("11111111-1111-4111-8111-111111111111");
    recovered.release();
  });

  it("does not let a reused PID impersonate the previous owner", () => {
    const stateDir = makeTmpDir("pid-reuse-owner");
    const root = workspace("pid-reuse-workspace");
    const workspaceId = new Workspace(root).id;
    writeStaleOwner(stateDir, root, process.pid, "old-process-start");
    const recovered = acquireStateDomainOwner({
      stateDir,
      workspaceRoot: root,
      workspaceId,
      processInspector: currentProcessInspector("new-process-start"),
    });
    expect(recovered.generation).not.toBe("11111111-1111-4111-8111-111111111111");
    recovered.release();
  });

  it("keeps both pre-authorized workspaces behind one unified bridge", async () => {
    const ownerRoot = workspace("unified-owner");
    const authorizedRoot = workspace("unified-authorized");
    const stateDir = externalStateDir("unified-workspaces-state");
    const registryFile = path.join(makeTmpDir("unified-workspaces-registry"), "workspaces.json");
    const registry = new WorkspaceRegistry({ file: registryFile });
    registry.registerTrusted({ name: "owner", canonicalPath: ownerRoot });
    registry.registerTrusted({ name: "authorized", canonicalPath: authorizedRoot });
    process.env.C2C_STATE_DIR = stateDir;
    const bridge: Bridge = await startBridge({
      workspaceRoot: ownerRoot,
      port: 0,
      persistRuntime: false,
      enforceStateOwnership: true,
      workspaceRegistryFile: registryFile,
      stateDomainProcessInspector: currentProcessInspector(),
    });
    try {
      expect(bridge.registry.enabledIds()).toEqual(expect.arrayContaining([
        stableWorkspaceId(ownerRoot),
        stableWorkspaceId(authorizedRoot),
      ]));
      const headers = { authorization: `Bearer ${bridge.adminToken}` };
      const response = await fetch(`${bridge.localBaseUrl()}/admin/info`, { headers });
      const info = await response.json();
      expect(info.authorizedWorkspaces).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: stableWorkspaceId(ownerRoot), root: ownerRoot }),
        expect.objectContaining({ id: stableWorkspaceId(authorizedRoot), root: authorizedRoot }),
      ]));
      expect((await fetch(`${bridge.localBaseUrl()}/admin/info`)).status).toBe(404);
      const rejected = await fetch(`${bridge.localBaseUrl()}/admin/shutdown`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ expectedRuntime: { workspaceId: info.workspaceId, pid: info.pid, port: info.port,
          startedAt: info.startedAt, stateDomainGeneration: "wrong-generation" } }),
      });
      expect(rejected.status).toBe(409);
      expect((await fetch(`${bridge.localBaseUrl()}/health`)).status).toBe(200);
    } finally {
      await bridge.close();
    }
  });
});
