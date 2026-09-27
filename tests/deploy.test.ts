/**
 * Regression coverage for the one-command local deployment flow:
 *   - the tunnel gate is read-only: it never creates or mutates tunnel state
 *   - an unset public connection yields HUMAN ACTION REQUIRED with exact commands
 *   - existing quick/named configuration is reported as preserved, never overwritten
 *   - rendered output never leaks tunnel ids or pairing secrets
 *   - runLocalDeploy orchestration: bridge reuse detection, local MCP probe,
 *     one-time state-domain import only when the bridge is stopped
 *   - the check-only path is idempotent: repeated runs leave the state dir unchanged
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readTunnelState, tunnelStateFile, writeTunnelState } from "../src/tunnel/state.js";
import { HUMAN_ACTION_HEADER, readTunnelGate, renderDeployReport, runLocalDeploy, type DeployReport } from "../src/process/deploy.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Deploy never spawns a bridge in these tests; keep the process boundary hermetic.
vi.mock("../src/process/daemon.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/process/daemon.js")>();
  return {
    ...actual,
    ensureBridge: vi.fn(),
    findSharedBridgeObservation: vi.fn(),
  };
});
vi.mock("../src/bridge/state-migration.js", () => ({
  reconcileStateDomains: vi.fn(),
}));

import { ensureBridge, findSharedBridgeObservation } from "../src/process/daemon.js";
import { reconcileStateDomains } from "../src/bridge/state-migration.js";

const mockedEnsureBridge = vi.mocked(ensureBridge);
const mockedFind = vi.mocked(findSharedBridgeObservation);

describe("deploy tunnel gate (read-only)", () => {
  let base: string;
  let stateDir: string;
  let workspaceId: string;

  beforeEach(() => {
    base = makeTmpDir("deploy-gate");
    stateDir = path.join(base, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.join(base, "workspace"), { recursive: true });
    fs.mkdirSync(path.join(base, "other-workspace"), { recursive: true });
    workspaceId = new Workspace(path.join(base, "workspace")).id;
  });
  afterEach(() => cleanup(base));

  it("unset connection: reports HUMAN ACTION REQUIRED with exact commands and writes nothing", () => {
    const gate = readTunnelGate(workspaceId, stateDir);
    expect(gate.humanActionRequired).toBe(true);
    expect(gate.preference).toBe("unset");
    expect(gate.needsChoice).toBe(true);
    expect(gate.instructions.join("\n")).toContain("tunnel choose --mode quick");
    expect(gate.instructions.join("\n")).toContain("tunnel choose --mode named --zone");
    // Read-only proof: the gate must not create tunnel state.
    expect(fs.existsSync(tunnelStateFile(workspaceId, stateDir))).toBe(false);
  });

  it("existing named configuration: preserved byte-identical, not overwritten, no secret echoed", () => {
    writeTunnelState({
      workspaceId,
      preference: "named",
      askedAt: new Date().toISOString(),
      provider: "cloudflare-named",
      tunnelName: "fixture-tunnel",
      tunnelId: "0123abcd-0000-1111-2222-333344445555",
      hostname: "c2c-fixture.example.com",
      zone: "example.com",
      configuredAt: new Date().toISOString(),
    }, stateDir);
    const file = tunnelStateFile(workspaceId, stateDir);
    const before = fs.readFileSync(file, "utf8");

    const gate = readTunnelGate(workspaceId, stateDir);

    expect(gate.humanActionRequired).toBe(false);
    expect(gate.namedReady).toBe(true);
    expect(gate.existingConfigurationPreserved).toBe(true);
    expect(gate.hostname).toBe("c2c-fixture.example.com");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("existing quick configuration: preserved and reported, no human action required", () => {
    writeTunnelState({
      workspaceId,
      preference: "quick",
      askedAt: new Date().toISOString(),
      provider: "cloudflare-quick",
    }, stateDir);
    const file = tunnelStateFile(workspaceId, stateDir);
    const before = fs.readFileSync(file, "utf8");

    const gate = readTunnelGate(workspaceId, stateDir);

    expect(gate.humanActionRequired).toBe(false);
    expect(gate.preference).toBe("quick");
    expect(gate.existingConfigurationPreserved).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(readTunnelState(workspaceId, stateDir).preference).toBe("quick");
  });

  it("rendering: HUMAN ACTION REQUIRED only when the gate requires it, and never leaks the tunnel id", () => {
    writeTunnelState({
      workspaceId,
      preference: "named",
      askedAt: new Date().toISOString(),
      provider: "cloudflare-named",
      tunnelName: "fixture-tunnel",
      tunnelId: "0123abcd-0000-1111-2222-333344445555",
      hostname: "c2c-fixture.example.com",
      configuredAt: new Date().toISOString(),
    }, stateDir);

    const unsetGate = readTunnelGate(path.join(base, "other-workspace"), stateDir);
    const unsetLines = renderDeployReport(fixtureReport(unsetGate));
    expect(unsetLines.some((line) => line.includes(HUMAN_ACTION_HEADER))).toBe(true);
    expect(unsetLines.join("\n")).toContain("tunnel choose");

    const namedGate = readTunnelGate(workspaceId, stateDir);
    const namedLines = renderDeployReport(fixtureReport(namedGate));
    const text = namedLines.join("\n");
    expect(text).toContain("left untouched");
    expect(text).not.toContain("0123abcd-0000-1111-2222-333344445555");
    expect(text).not.toContain("fixture-tunnel");
    expect(text).not.toMatch(/pairing code/i);
  });
});

describe("runLocalDeploy orchestration (hermetic, bridge mocked)", () => {
  let base: string;
  let stateDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    base = makeTmpDir("deploy-run");
    stateDir = path.join(base, "state");
    workspaceRoot = path.join(base, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    cleanup(base);
  });

  it("check-only run (--no-start-bridge): initializes the state dir, starts nothing, is idempotent", async () => {
    const first = await runLocalDeploy({ workspaceRoot, stateDir, startBridge: false, autostart: false });
    expect(first.bridge.started).toBe(false);
    expect(first.bridge.port).toBeNull();
    expect(first.workspace.root).toBe(fs.realpathSync.native(workspaceRoot));
    expect(first.checks.map((check) => check.id)).toEqual(expect.arrayContaining(["node", "git", "pnpm", "dependencies", "build", "bridge"]));
    expect(first.checks.find((check) => check.id === "node")?.ok).toBe(true);
    expect(first.tunnelGate.humanActionRequired).toBe(true);
    expect(first.nextActions.join("\n")).toContain("tunnel choose");
    expect(fs.existsSync(stateDir)).toBe(true);
    // JSON must round-trip (machine-readable contract).
    expect(JSON.parse(JSON.stringify(first))).toMatchObject({ version: first.version });
    // The overall verdict tracks the fatal checks; the build check reads the
    // real repo, which supported flows always build before testing.
    const distBuilt = fs.existsSync(path.join(repoRoot, "dist", "cli", "index.js"));
    expect(first.checks.find((check) => check.id === "build")?.ok).toBe(distBuilt);
    if (distBuilt) expect(first.ok).toBe(true);

    const snapshotAfterFirst = stateDirSnapshot(stateDir);
    const second = await runLocalDeploy({ workspaceRoot, stateDir, startBridge: false, autostart: false });
    expect(second.checks.find((check) => check.id === "build")?.ok).toBe(distBuilt);
    if (distBuilt) expect(second.ok).toBe(true);
    expect(stateDirSnapshot(stateDir)).toEqual(snapshotAfterFirst);
    expect(mockedEnsureBridge).not.toHaveBeenCalled();
    expect(reconcileStateDomains).not.toHaveBeenCalled();
  });

  it("bridge start path: starts once, probes local MCP, and reuses a live bridge on re-run", async () => {
    const runtime = { port: 47291 } as const;
    mockedFind.mockResolvedValueOnce({ state: "stopped", runtime: null, reason: "runtime_missing" } as never);
    mockedEnsureBridge.mockResolvedValueOnce({ runtime, spawned: true, observation: undefined } as never);
    stubFetch(401);

    const first = await runLocalDeploy({ workspaceRoot, stateDir, startBridge: true, autostart: false });
    expect(first.bridge).toMatchObject({ started: true, reused: false, port: 47291, localMcpOk: true });
    expect(first.checks.find((check) => check.id === "bridge")?.ok).toBe(true);
    expect(reconcileStateDomains).toHaveBeenCalledTimes(1);
    expect(mockedEnsureBridge).toHaveBeenCalledTimes(1);

    mockedFind.mockResolvedValueOnce({ state: "healthy", runtime, shared: false } as never);
    mockedEnsureBridge.mockResolvedValueOnce({ runtime, spawned: false, observation: undefined } as never);
    const second = await runLocalDeploy({ workspaceRoot, stateDir, startBridge: true, autostart: false });
    expect(second.bridge).toMatchObject({ started: true, reused: true, port: 47291, localMcpOk: true });
    // Import boundary runs only while no bridge is serving.
    expect(reconcileStateDomains).toHaveBeenCalledTimes(1);
  });

  it("failed local MCP probe fails the bridge check and the deployment", async () => {
    mockedFind.mockResolvedValueOnce({ state: "stopped", runtime: null, reason: "runtime_missing" } as never);
    mockedEnsureBridge.mockResolvedValueOnce({ runtime: { port: 47292 }, spawned: true } as never);
    stubFetch(200); // MCP answered without the expected 401 auth gate

    const report = await runLocalDeploy({ workspaceRoot, stateDir, startBridge: true, autostart: false });
    expect(report.bridge.localMcpOk).toBe(false);
    expect(report.checks.find((check) => check.id === "bridge")?.ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("autostart outside Windows is reported honestly and is non-fatal", async () => {
    if (process.platform === "win32") return; // covered by real registration on Windows
    const report = await runLocalDeploy({ workspaceRoot, stateDir, startBridge: false, autostart: true });
    expect(report.autostart.requested).toBe(true);
    expect(report.autostart.registered).toBe(false);
    expect(report.autostart.detail).toContain("supervisor start");
    expect(report.checks.find((check) => check.id === "autostart")?.fatal).toBe(false);
  });
});

// ---------------------------------------------------------------- fixtures

function stubFetch(status: number): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({ status }) as unknown as Response));
}

function stateDirSnapshot(dir: string): string[] {
  const walk = (current: string, prefix = ""): string[] =>
    fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const child = path.join(current, entry.name);
      const rel = path.join(prefix, entry.name);
      return entry.isDirectory() ? walk(child, rel) : [rel];
    });
  return fs.existsSync(dir) ? walk(dir).sort() : [];
}

function fixtureReport(tunnelGate: ReturnType<typeof readTunnelGate>): DeployReport {
  return {
    ok: true,
    product: "Agents with ChatGPT",
    version: "0.0.0-test",
    platform: "test",
    repoRoot: "/fixture",
    stateDir: "/fixture/state",
    workspace: { id: "fixture", name: "fixture", root: "/fixture/ws" },
    checks: [],
    bridge: { started: true, reused: false, port: 40000, localMcpOk: true },
    z2cLane: { available: false, detail: "fixture" },
    tunnelGate,
    autostart: { requested: false, registered: false, detail: "not requested" },
    nextActions: tunnelGate.instructions,
  };
}
