import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileStateDomains, inspectStateTree } from "../src/bridge/state-migration.js";
import { packagedStateDirCandidates, writeSecureJson } from "../src/config/paths.js";
import { bridgeServeArgv } from "../src/process/daemon.js";
import { readRuntimeState } from "../src/bridge/runtime.js";
import { stateDomainOwnerFile } from "../src/bridge/state-owner.js";
import { startBridge } from "../src/bridge/server.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const dirs: string[] = [];

function stateDir(name: string): string {
  const dir = makeTmpDir(name);
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
});

describe("C2C Windows state-domain migration", () => {
  it("keeps the explicit child state domain in the detached serve argv", () => {
    const workspace = "C:\\Users\\Test\\codex-with-chatgpt";
    const state = "C:\\Users\\Test\\AppData\\Local\\codex-with-chatgpt";
    expect(bridgeServeArgv(["node", "dist/cli/index.js"], workspace, state, 48_765)).toEqual([
      "node",
      "dist/cli/index.js",
      "serve",
      "--workspace",
      workspace,
      "--state-dir",
      state,
      "--port",
      "48765",
    ]);
  });

  it("merges valid OAuth and continuation state without copying live ownership files", () => {
    const canonical = stateDir("migration-canonical");
    const packaged = stateDir("migration-packaged");
    const generation = "11111111-1111-4111-8111-111111111111";
    const redirect = "https://chatgpt.com/connector/oauth/test";
    const canonicalClient = {
      clientId: "c2c_client_canonical",
      clientName: "canonical",
      redirectUris: [redirect],
      createdAt: "2026-09-03T00:00:00.000Z",
    };
    const packagedClient = {
      clientId: "c2c_client_packaged",
      clientName: "packaged",
      redirectUris: [redirect],
      createdAt: "2026-09-03T00:01:00.000Z",
    };
    const packagedToken = {
      hash: "a".repeat(64),
      kind: "access",
      clientId: packagedClient.clientId,
      workspaceIds: ["9f8e7d6c5b4a"],
      scopes: ["workspace.read"],
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      revoked: false,
    };

    writeSecureJson(path.join(canonical, "auth", "bridge.json"), {
      clients: [canonicalClient],
      tokens: [],
    });
    writeSecureJson(path.join(canonical, "auth", `bridge.${generation}.json`), {
      clients: [canonicalClient],
      tokens: [],
    });
    writeSecureJson(path.join(canonical, "auth", "bridge-active.json"), {
      schema: 1,
      generation,
      authFile: path.join(canonical, "auth", `bridge.${generation}.json`),
      updatedAt: "2026-09-03T00:00:00.000Z",
    });
    writeSecureJson(path.join(packaged, "auth", "bridge.json"), {
      clients: [packagedClient],
      tokens: [packagedToken],
    });
    writeSecureJson(path.join(packaged, "runtime", "state-domain-owner.json"), {
      schema: 1,
      stateDir: packaged,
      generation,
      workspaceId: "9f8e7d6c5b4a",
      workspaceRoot: "C:\\Users\\Test\\codex-with-chatgpt",
      pid: 1234,
      processStartIdentity: null,
      acquiredAt: "2026-09-03T00:00:00.000Z",
      authFile: path.join(packaged, "auth", `bridge.${generation}.json`),
    });
    writeSecureJson(path.join(packaged, "locks", "9f8e7d6c5b4a.json"), {
      version: 1,
      workspaceId: "9f8e7d6c5b4a",
      taskId: "c2c_abcdef123456",
      pid: 1234,
      acquiredAt: "2026-09-03T00:00:00.000Z",
    });
    writeSecureJson(path.join(packaged, "tasks", "9f8e7d6c5b4a", "c2c_abcdef123456.json"), {
      taskId: "c2c_abcdef123456",
      workspaceId: "9f8e7d6c5b4a",
      status: "completed",
      submittedAt: "2026-09-03T00:00:00.000Z",
      completedAt: "2026-09-03T00:02:00.000Z",
    });
    writeSecureJson(path.join(packaged, "sessions", "registry.json"), {
      version: 1,
      sessions: [{
        id: "c2cs_abcdef1234567890",
        workspaceId: "9f8e7d6c5b4a",
        ownerId: "client-owner",
        title: "migration session",
        goalSummary: "preserve state",
        status: "active",
        changedFiles: [],
        verificationStatus: null,
        currentState: "created",
        nextIntendedAction: null,
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:02:00.000Z",
      }],
    });
    write(packaged, "executions/9f8e7d6c5b4a.jsonl", JSON.stringify({
      taskId: "c2c_abcdef123456",
      workspaceId: "9f8e7d6c5b4a",
      iteration: 1,
      changedFiles: [],
      tests: null,
      exitStatus: "ok",
      timestamp: "2026-09-03T00:02:00.000Z",
      network: false,
    }) + "\n");

    const beforePackaged = inspectStateTree(packaged);
    const report = reconcileStateDomains({
      canonicalStateDir: canonical,
      sourceStateDirs: [packaged],
      authorizedWorkspaceIds: ["9f8e7d6c5b4a"],
    });

    expect(report.sourceTreesPreserved).toBe(true);
    expect(report.auth?.blocked).toBe(false);
    expect(report.auth?.clients).toBe(2);
    expect(report.auth?.tokens).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(canonical, "auth", "bridge.json"), "utf8")).clients).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(path.join(canonical, "auth", `bridge.${generation}.json`), "utf8")).clients).toHaveLength(2);
    expect(fs.existsSync(path.join(canonical, "tasks", "9f8e7d6c5b4a", "c2c_abcdef123456.json"))).toBe(true);
    expect(fs.existsSync(path.join(canonical, "executions", "9f8e7d6c5b4a.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(canonical, "sessions", "registry.json"))).toBe(true);
    expect(fs.existsSync(path.join(canonical, "runtime", "state-domain-owner.json"))).toBe(false);
    expect(fs.existsSync(path.join(canonical, "locks", "9f8e7d6c5b4a.json"))).toBe(false);
    expect(inspectStateTree(packaged).fingerprint).toBe(beforePackaged.fingerprint);
    expect(inspectStateTree(packaged).tasks.files).toBe(beforePackaged.tasks.files);
  });

  it("finds the package virtualization layout without enumerating arbitrary directories", () => {
    if (process.platform !== "win32") return;
    const home = stateDir("fake-user-home");
    const packageRoot = path.join(home, "AppData", "Local", "Packages", "OpenAI.Codex_Test", "LocalCache", "Local", "codex-with-chatgpt");
    fs.mkdirSync(packageRoot, { recursive: true });
    expect(packagedStateDirCandidates(home, path.join(home, "AppData", "Local", "codex-with-chatgpt"))).toEqual([packageRoot]);
  });

  it("uses one explicit state domain for bridge registries, runtime, and task managers", async () => {
    const canonical = stateDir("bridge-state-context");
    const workspaceRoot = stateDir("bridge-state-workspace");
    write(workspaceRoot, "package.json", JSON.stringify({ name: "state-context-fixture" }));
    const bridge = await startBridge({
      workspaceRoot,
      stateDir: canonical,
      port: 0,
      persistRuntime: true,
      stateDomainProcessInspector: {
        list: () => [{
          pid: process.pid,
          executable: process.execPath,
          commandLine: "vitest state-context",
          listeningPorts: [],
          processStartIdentity: "state-context-test",
        }],
      },
    });
    try {
      expect(bridge.registry.file.startsWith(canonical)).toBe(true);
      expect(bridge.sessions.file.startsWith(canonical)).toBe(true);
      expect(bridge.taskManagers.get(bridge.workspace.id).stateDir).toBe(canonical);
      expect(readRuntimeState(bridge.workspace.id, canonical)).toMatchObject({ stateDir: canonical });
      expect(fs.existsSync(stateDomainOwnerFile(canonical))).toBe(true);
    } finally {
      await bridge.close();
    }
  });
});
