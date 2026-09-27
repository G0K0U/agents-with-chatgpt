/**
 * Regression coverage for the bounded supervisor:
 *   - backoff schedule (immediate, 5s, 15s, 30s, then FAILED)
 *   - no restart storms: attempts are bounded and gated by nextRetryAt
 *   - targeted recovery: only the failed component's action runs
 *   - a READY observation resets the attempt counter
 *   - snapshots persist per-component state and a derived overall state
 *   - R1.1: zcode-desktop reconciliation (managed launch, bounded relaunch,
 *     unmanaged detection never kills or duplicates)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Supervisor, recoveryDelayMs, type SupervisorDeps, type SupervisorProbes } from "../src/supervisor/supervisor.js";
import { registrationPathFor, type ZcodeDesktopObservation } from "../src/supervisor/provider-bootstrap.js";

let root: string;
let stateDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "c2c-sup-"));
  stateDir = path.join(root, "state");
  // A fake Z2C companion repo so recovery actions pass their preconditions.
  mkdirSync(path.join(root, "z2c", "dist", "service"), { recursive: true });
  mkdirSync(path.join(root, "z2c", "scripts"), { recursive: true });
  writeFileSync(path.join(root, "z2c", "dist", "index.js"), "// z2c entry\n");
  writeFileSync(path.join(root, "z2c", "dist", "service", "main.js"), "// semantic entry\n");
  writeFileSync(path.join(root, "z2c", "scripts", "desktop-host-shim.mjs"), "// shim\n");
  writeFileSync(path.join(root, "z2c", "scripts", "desktop-agent-proxy.mjs"), "// proxy\n");
  // A fake ZCode Desktop executable for bounded discovery.
  mkdirSync(path.join(root, "apps"), { recursive: true });
  writeFileSync(path.join(root, "apps", "ZCode.exe"), "not a real exe");
  // A fake AGY install so the Gemini on-demand readiness resolves.
  mkdirSync(path.join(root, "agy", "bin"), { recursive: true });
  writeFileSync(path.join(root, "agy", "bin", "agy.exe"), "not a real exe");
  writeFileSync(path.join(root, "apps", "codex.exe"), "not a real exe");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const READY_DESKTOP: ZcodeDesktopObservation = {
  state: "READY",
  managed: true,
  desktopPid: 4242,
  registrationLive: true,
};

const ABSENT_DESKTOP = (): ZcodeDesktopObservation => ({
  state: "ZCODE_DESKTOP_ABSENT",
  detail: "no live desktop-agent registration and no ZCode Desktop process",
  managed: null,
  desktopPid: null,
  registrationLive: false,
  launch: async () => "launched; registration not yet live",
});

/** Deterministic clock + probe/action recorder. */
function makeHarness(opts: {
  probes?: Partial<SupervisorProbes>;
  deps?: Partial<SupervisorDeps>;
  manageDesktop?: boolean;
} = {}) {
  let time = Date.parse("2026-09-13T05:00:00.000Z");
  const now = (): Date => new Date(time);
  const spawnCalls: Array<{ cmd: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }> = [];
  const healthyProbes: Partial<SupervisorProbes> = {
    bridgeHealth: async () => ({
      workspaceId: "111111111111",
      releaseId: "0.2.0-deadbeef",
      sourceParity: "ok",
      buildParity: "ok",
      version: "0.2.0",
    }),
    publicMcp: async () => true,
    z2cListener: async () => true,
    zcodeDesktop: async () => READY_DESKTOP,
    coordinatorHeartbeatAgeMs: async () => 1_000,
    glmControlPlane: async () => ({
      level: "READY" as const,
      workspace_binding: "OK" as const,
      native: { observed: true, available: true, provider: "zcode-desktop", model: "GLM-5.3-Flash", attested: true, observed_at: new Date().toISOString() },
    }),
    queueState: async () => ({ paused: false, activeWriter: null }),
    ...opts.probes,
  };
  const workspaceRoot = path.join(root, "ws");
  mkdirSync(workspaceRoot, { recursive: true });
  const supervisor = new Supervisor({
    repoRoot: root,
    stateDir,
    workspaceRoot,
    z2cRepoRoot: path.join(root, "z2c"),
    intervalMs: 1_000,
    now,
    // Non-advancing sleep: bounded waits are fixed-step so they cannot hang.
    sleep: async () => {},
    zcodeRegistrationWaitMs: 0,
    spawnDetached: (cmd, args, o) => {
      spawnCalls.push({ cmd, args, cwd: o.cwd, env: o.env });
      // pid 0 is deterministically "not alive" so the ownership record never
      // looks live on the real machine.
      return { pid: 0 };
    },
    processInspector: () => null,
    env: {
      ...(opts.manageDesktop === false ? {} : { A2C_MANAGE_ZCODE_DESKTOP: "1" }),
      LOCALAPPDATA: root,
      Z2C_STATE_DIR: path.join(root, "z2cstate"),
      C2C_ZCODE_DESKTOP_EXECUTABLE: path.join(root, "apps", "ZCode.exe"),
      // Deterministic Codex resolution inside the sandbox root.
      C2C_CODEX_EXECUTABLE: path.join(root, "apps", "codex.exe"),
    },
    ...opts.deps,
    probes: healthyProbes,
  });
  const advance = (ms: number): void => { time += ms; };
  return { supervisor, advance, spawnCalls, now: () => new Date(time), workspaceRoot };
}

describe("recovery backoff", () => {
  it("uses the documented fast schedule, then the bounded slow lane, then refuses", () => {
    expect(recoveryDelayMs(1)).toBe(0);
    expect(recoveryDelayMs(2)).toBe(5_000);
    expect(recoveryDelayMs(3)).toBe(15_000);
    expect(recoveryDelayMs(4)).toBe(30_000);
    // Slow lane: fast budget exhausted never wedges recovery permanently.
    expect(recoveryDelayMs(5)).toBe(30 * 60_000);
    expect(recoveryDelayMs(8)).toBe(30 * 60_000);
    expect(recoveryDelayMs(9)).toBeNull();
  });
});

describe("supervisor state machine", () => {
  it("official Z2C mode does not probe, launch, or restart ZCode Desktop", async () => {
    const h = makeHarness({
      manageDesktop: false,
      probes: { zcodeDesktop: async () => { throw new Error("Desktop must not be probed"); } },
    });
    const snap = await h.supervisor.runTick();
    const bootstrap = await h.supervisor.bootstrapOnTakeover();
    expect(snap.components.find(c => c.component === "zcode-desktop")?.state).toBe("DISABLED");
    expect(snap.providerHealth?.glm.desktop).toBe("NOT_REQUIRED_OFFICIAL");
    expect(bootstrap.zcode.state).toBe("DISABLED");
    expect(h.spawnCalls.filter(c => c.cmd.endsWith("ZCode.exe"))).toHaveLength(0);
  });

  it("wakes the run loop promptly when stop is requested", async () => {
    const h = makeHarness({ deps: { sleep: () => new Promise<void>(() => {}) } });
    const running = h.supervisor.run();
    await vi.waitFor(() => expect(h.supervisor.snapshot().tick).toBe(1));
    h.supervisor.stop();
    await expect(running).resolves.toBeUndefined();
    await expect(h.supervisor.waitForRecoveries()).resolves.toBeUndefined();
  });

  it("renews the launch budget after the operator closes an unmanaged Desktop", async () => {
    let desktop: ZcodeDesktopObservation = {
      ...ABSENT_DESKTOP(), state: "ZCODE_DESKTOP_UNMANAGED", desktopPid: 99,
      managedRestart: async () => "refused",
    };
    const h = makeHarness({ probes: { zcodeDesktop: async () => desktop } });
    for (const delay of [0, 5_000, 15_000, 30_000, 60_000]) {
      h.advance(delay);
      await h.supervisor.runTick();
      await h.supervisor.waitForRecovery("zcode-desktop");
    }
    // Every simulated interval follows a settled attempt, independent of
    // how heavily the real test worker is scheduled.
    await h.supervisor.runTick();
    expect(h.supervisor.snapshot().components.find(c => c.component === "zcode-desktop")!.state).toBe("DEGRADED");
    desktop = { ...desktop, state: "USER_ACTION_REQUIRED_UNSAVED_STATE" };
    await h.supervisor.runTick();
    desktop = ABSENT_DESKTOP();
    await h.supervisor.runTick();
    await vi.waitFor(() => expect(h.spawnCalls.filter(c => c.cmd.endsWith("ZCode.exe"))).toHaveLength(1));
    expect(h.supervisor.snapshot().components.find(c => c.component === "zcode-desktop")!.attempts).toBe(1);
    await h.supervisor.runTick();
    expect(h.spawnCalls.filter(c => c.cmd.endsWith("ZCode.exe"))).toHaveLength(1);
  });

  it("reports READY overall and per component when every probe is healthy", async () => {
    const h = makeHarness();
    const snap = await h.supervisor.runTick();
    expect(snap.overall).toBe("READY");
    expect(snap.components.every(c => c.state === "READY")).toBe(true);
  });

  it("restarts z2c with bounded attempts, growing delays, and no restart storm", async () => {
    const h = makeHarness({ probes: { z2cListener: async () => false } });
    // Attempt 1: immediate.
    await h.supervisor.runTick();
    const z2cSpawn = h.spawnCalls.filter(c => String(c.args[0]).replace(/\\/g, "/").includes("/z2c/dist/service/main.js"));
    expect(z2cSpawn).toHaveLength(1);
    expect(z2cSpawn[0].env?.Z2C_PROVIDER).toBe("official");
    expect(z2cSpawn[0].env?.ZCODE_AGENT_SERVER_COMMAND).toBeUndefined();
    expect(z2cSpawn[0].env?.ZCODE_AGENT_SERVER_ARGS_JSON).toBeUndefined();
    // Backoff not yet elapsed: re-ticks must NOT respawn (no storm).
    h.advance(1_000);
    await h.supervisor.runTick();
    h.advance(3_000);
    await h.supervisor.runTick();
    expect(h.spawnCalls.length).toBe(1);
    // Attempt 2 after the 5s delay.
    h.advance(1_500);
    await h.supervisor.runTick();
    expect(h.spawnCalls.length).toBe(2);
    // Attempt 3 after 15s, attempt 4 after 30s, then the slow lane.
    h.advance(15_000);
    await h.supervisor.runTick();
    expect(h.spawnCalls.length).toBe(3);
    h.advance(30_000);
    await h.supervisor.runTick();
    expect(h.spawnCalls.length).toBe(4);
    h.advance(60_000);
    const snap = await h.supervisor.runTick();
    expect(h.spawnCalls.length).toBe(4); // fast ladder exhausted, still no storm
    expect(snap.overall).toBe("OFFLINE");
    const z2c = snap.components.find(c => c.component === "z2c-listener")!;
    expect(z2c.state).toBe("OFFLINE");
    expect(z2c.detail).toMatch(/slow-lane recovery/);
    // The status file persisted the same truth.
    expect(existsSync(path.join(stateDir, "supervisor", "status.json"))).toBe(true);
    const persisted = JSON.parse(readFileSync(path.join(stateDir, "supervisor", "status.json"), "utf8")) as { overall: string };
    expect(persisted.overall).toBe("OFFLINE");
    // The slow lane converges: after its 30-minute gate the action runs again.
    h.advance(30 * 60_000);
    await h.supervisor.runTick();
    await vi.waitFor(() => expect(h.spawnCalls.length).toBe(5));
    // ... and the budget is still finite: attempts 6-8 run on the slow lane,
    // then attempt 9 is refused forever.
    for (let i = 0; i < 3; i++) {
      h.advance(30 * 60_000);
      await h.supervisor.runTick();
    }
    await vi.waitFor(() => expect(h.spawnCalls.length).toBe(8));
    h.advance(30 * 60_000);
    const exhausted = await h.supervisor.runTick();
    const z2cExhausted = exhausted.components.find(c => c.component === "z2c-listener")!;
    expect(z2cExhausted.state).toBe("FAILED");
    expect(z2cExhausted.detail).toMatch(/manual intervention/);
  }, 40_000);

  it("launches the managed ZCode Desktop with bundled Agent env only when it is genuinely absent", async () => {
    let calls = 0;
    const h = makeHarness({ probes: { zcodeDesktop: async () => (calls++ === 0 ? ABSENT_DESKTOP() : READY_DESKTOP) } });
    await h.supervisor.runTick();
    await vi.waitFor(() => {
      expect(h.spawnCalls.filter(c => c.cmd.endsWith("ZCode.exe")).length).toBe(1);
    });
    const launch = h.spawnCalls.find(c => c.cmd.endsWith("ZCode.exe"))!;
    expect(launch.args).toEqual(["--open-workspace", h.workspaceRoot]);
    expect(launch.cwd).toBe(h.workspaceRoot);
    expect(launch.env?.ZCODE_AGENT_SERVER_COMMAND).toBeUndefined();
    expect(launch.env?.ZCODE_AGENT_SERVER_ARGS_JSON).toBeUndefined();
    // The next tick observes the live registration: READY, attempts reset.
    const snap = await h.supervisor.runTick();
    const lane = snap.components.find(c => c.component === "zcode-desktop")!;
    expect(lane.state).toBe("READY");
    expect(lane.attempts).toBe(0);
    // Ownership metadata was persisted (safe fields only).
    const rec = JSON.parse(readFileSync(path.join(stateDir, "supervisor", "zcode-desktop.json"), "utf8")) as Record<string, unknown>;
    expect(rec.managed).toBe(true);
    expect(rec.workspace).toBe(h.workspaceRoot);
    expect(rec.generation).toBeTruthy();
    expect(JSON.stringify(rec)).not.toMatch(/token|secret|apikey|api_key|credential/i);
  });

  it("refuses the legacy Z2C task bridge when the semantic entry is missing", async () => {
    rmSync(path.join(root, "z2c", "dist", "service", "main.js"));
    const h = makeHarness({ probes: { z2cListener: async () => false } });
    await h.supervisor.runTick();
    await h.supervisor.waitForRecovery("z2c-listener");
    expect(h.spawnCalls).toHaveLength(0);
    expect(h.supervisor.snapshot().recoveryLog.some((entry) =>
      entry.component === "z2c-listener" && entry.outcome.includes("semantic entry missing"))).toBe(true);
  });

  it("recovers the managed desktop lane through the bounded ladder, then the slow lane", async () => {
    const h = makeHarness({ probes: { zcodeDesktop: async () => ABSENT_DESKTOP() } });
    const launches = () => h.spawnCalls.filter(c => c.cmd.endsWith("ZCode.exe")).length;
    await h.supervisor.runTick(); // attempt 1 (immediate)
    await vi.waitFor(() => expect(launches()).toBe(1));
    h.advance(1_000);
    await h.supervisor.runTick(); // gated: no storm
    expect(launches()).toBe(1);
    h.advance(5_000);
    await h.supervisor.runTick(); // attempt 2
    await vi.waitFor(() => expect(launches()).toBe(2));
    h.advance(15_000);
    await h.supervisor.runTick(); // attempt 3
    await vi.waitFor(() => expect(launches()).toBe(3));
    h.advance(30_000);
    await h.supervisor.runTick(); // attempt 4
    await vi.waitFor(() => expect(launches()).toBe(4));
    h.advance(60_000);
    const snap = await h.supervisor.runTick();
    expect(launches()).toBe(4); // fast ladder exhausted, still no storm
    const desktop = snap.components.find(c => c.component === "zcode-desktop")!;
    expect(desktop.state).toBe("OFFLINE");
    expect(desktop.detail).toMatch(/slow-lane recovery/);
    // A transient Desktop window (like the live 2026-09-16 incident where the
    // restoring Desktop ignored open requests for minutes) converges on the
    // slow lane instead of wedging FAILED forever.
    h.advance(30 * 60_000);
    await h.supervisor.runTick();
    await vi.waitFor(() => expect(launches()).toBe(5));
  }, 40_000);

  it("reports an unmanaged desktop as DEGRADED without launching or killing anything", async () => {
    const unmanaged: ZcodeDesktopObservation = {
      state: "ZCODE_DESKTOP_UNMANAGED",
      detail: "ZCode Desktop is running without the managed proxy (pids: 99); manual managed restart required",
      managed: false,
      desktopPid: 99,
      registrationLive: false,
    };
    const h = makeHarness({ probes: { zcodeDesktop: async () => unmanaged } });
    const snap = await h.supervisor.runTick();
    expect(h.spawnCalls.length).toBe(0);
    const lane = snap.components.find(c => c.component === "zcode-desktop")!;
    expect(lane.state).toBe("DEGRADED");
    expect(lane.detail).toMatch(/without the managed proxy/);
    expect(snap.overall).toBe("DEGRADED");
  });

  it("z2c failure recovers only the z2c lane; a healthy desktop is untouched", async () => {
    const h = makeHarness({ probes: { z2cListener: async () => false } });
    await h.supervisor.runTick();
    await vi.waitFor(() => {
      expect(h.spawnCalls.filter(c => String(c.args[0]).replace(/\\/g, "/").includes("/z2c/dist/service/main.js")).length).toBe(1);
    });
    expect(h.spawnCalls.filter(c => c.cmd.endsWith("ZCode.exe")).length).toBe(0);
    expect(h.supervisor.snapshot().components.find(c => c.component === "zcode-desktop")!.state).toBe("READY");
  });

  it("attempts are reset when a component becomes READY again", async () => {
    let z2cUp = false;
    const h = makeHarness({ probes: { z2cListener: async () => z2cUp } });
    await h.supervisor.runTick(); // attempt 1
    h.advance(5_000);
    await h.supervisor.runTick(); // attempt 2
    z2cUp = true;
    h.advance(15_000);
    const snap = await h.supervisor.runTick(); // observes READY
    expect(snap.components.find(c => c.component === "z2c-listener")!.state).toBe("READY");
    expect(snap.components.find(c => c.component === "z2c-listener")!.attempts).toBe(0);
  });

  it("stale coordinator heartbeat degrades without restarting anything", async () => {
    const h = makeHarness({ probes: { coordinatorHeartbeatAgeMs: async () => 10 * 60_000 } });
    const snap = await h.supervisor.runTick();
    expect(snap.overall).toBe("DEGRADED");
    expect(h.spawnCalls.length).toBe(0);
    expect(snap.components.find(c => c.component === "zcode-coordinator")!.detail).toMatch(/stale/);
  });

  it("runtime identity drift is reported without any recovery action", async () => {
    mkdirSync(path.join(root, "releases"), { recursive: true });
    writeFileSync(path.join(root, "releases", "LKG.json"), JSON.stringify({
      schema: 1, releaseId: "0.2.0-current", entry: "releases/0.2.0-current/cli/index.js",
      version: "0.2.0", sourceCommit: "abc", buildHash: "b".repeat(64),
      activatedAt: new Date().toISOString(),
    }));
    const h = makeHarness({
      probes: {
        bridgeHealth: async () => ({
          workspaceId: "111111111111",
          releaseId: "0.1.0-older",
          sourceParity: "mismatch",
          buildParity: "ok",
          version: "0.1.0",
        }),
      },
    });
    const snap = await h.supervisor.runTick();
    const identity = snap.components.find(c => c.component === "runtime-identity")!;
    expect(identity.state).toBe("DEGRADED");
    expect(identity.detail).toMatch(/restart \(or activate\) to converge/);
    expect(h.spawnCalls.length).toBe(0);
  });

  it("core offline triggers ensure-bridge, and tunnel is reported offline without probing", async () => {
    const h = makeHarness({
      probes: {
        bridgeHealth: async () => null,
        publicMcp: async () => { throw new Error("should not probe public MCP when core is down"); },
      },
    });
    await h.supervisor.runTick();
    const snap = h.supervisor.snapshot();
    expect(snap.overall).toBe("OFFLINE");
    expect(h.spawnCalls.filter(c => c.args.some(a => String(a).includes("index.js"))).length).toBe(0);
    // ensure-bridge is an in-process action (no detached spawn recorded).
    const core = snap.components.find(c => c.component === "core")!;
    expect(core.lastAction).toBe("ensure-bridge");
  });
});

describe("takeover bootstrap (R1.1)", () => {
  it("reconciles on-demand providers without spawning them and launches the managed desktop once", async () => {
    const h = makeHarness({ probes: { zcodeDesktop: async () => ABSENT_DESKTOP() } });
    const report = await h.supervisor.bootstrapOnTakeover();
    expect(report.codex.strategy).toBe("on-demand");
    expect(report.gemini.strategy).toBe("on-demand");
    expect(report.zcode.strategy).toBe("managed-persistent");
    // Codex executable is available on dev machines; if missing the state must
    // say so instead of spawning anything. Either way: no persistent process.
    expect(["READY_ON_DEMAND", "EXECUTABLE_MISSING"]).toContain(report.codex.state);
    expect(h.spawnCalls.filter(c => String(c.cmd).toLowerCase().includes("codex")).length).toBe(0);
    expect(h.spawnCalls.filter(c => path.basename(String(c.cmd)).toLowerCase().startsWith("agy")).length).toBe(0);
    // Exactly one managed desktop launch (attempt is awaited by the takeover).
    expect(h.spawnCalls.filter(c => c.cmd.endsWith("ZCode.exe")).length).toBe(1);
    const launch = h.spawnCalls.find(c => c.cmd.endsWith("ZCode.exe"))!;
    expect(launch.env?.ZCODE_AGENT_SERVER_COMMAND).toBeUndefined();
    expect(launch.env?.ZCODE_AGENT_SERVER_ARGS_JSON).toBeUndefined();
    expect(launch.cwd).toBe(h.workspaceRoot);
    // The report is persisted on the snapshot.
    const persisted = JSON.parse(readFileSync(path.join(stateDir, "supervisor", "status.json"), "utf8")) as { schema: number; providerBootstrap?: { zcode: { state: string } } };
    expect(persisted.schema).toBe(2);
    expect(persisted.providerBootstrap?.zcode.state).toBe("ZCODE_DESKTOP_ABSENT");
  });

  it("a second takeover over a healthy managed desktop performs no launch", async () => {
    const h = makeHarness(); // default probe: READY desktop
    const report = await h.supervisor.bootstrapOnTakeover();
    expect(report.zcode.state).toBe("READY");
    expect(report.zcode.registrationLive).toBe(true);
    expect(h.spawnCalls.filter(c => c.cmd.endsWith("ZCode.exe")).length).toBe(0);
  });
});

describe("R1.1 registration layout compatibility", () => {
  it("derives the same registration file name the Z2C proxy publishes", () => {
    // Golden value for a synthetic workspace (the proxy hashes lower-cased cwd).
    const file = registrationPathFor("F:\\ExampleWork\\codex-with-chatgpt", { LOCALAPPDATA: "C:\\u" } as NodeJS.ProcessEnv);
    expect(file.toLowerCase()).toBe("c:\\u\\z2c\\desktop-agents\\agent-30358ad5b5f74dca.json");
  });
});


it("serializes concurrent supervisors and fences non-owner release", async () => {
  // A Vitest worker need not be visible to the host process inspector. Supply
  // the current worker identity so this test exercises the actual lock race.
  const originalArgv = [...process.argv];
  process.argv[1] = path.resolve("tests/supervisor.test.ts");
  const deps = { repoRoot: root, stateDir, workspaceRoot: root,
    processInspector: () => ({ list: () => [{ pid: process.pid,
      executable: realpathSync.native(process.execPath), commandLine: "synthetic vitest worker",
      listeningPorts: [], processStartIdentity: "synthetic-current-worker" }] }) };
  const first = new Supervisor(deps), second = new Supervisor(deps);
  try {
    const results = await Promise.all([first.acquireLock(), second.acquireLock()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const owner = results[0] ? first : second;
    const loser = results[0] ? second : first;
    loser.releaseLock();
    expect(existsSync(path.join(stateDir, "supervisor/supervisor.lock"))).toBe(true);
    owner.releaseLock();
    expect(existsSync(path.join(stateDir, "supervisor/supervisor.lock"))).toBe(false);
  } finally {
    first.releaseLock();
    second.releaseLock();
    process.argv.splice(0, process.argv.length, ...originalArgv);
  }
});


it("control-repo supervisor uses the authenticated Engineering AI owner for its runtime pointer", async () => {
  const daemon = await import("../src/process/daemon.js");
  const spy = vi.spyOn(daemon, "findSharedBridgeObservation").mockResolvedValue({
    state: "healthy", shared: true, runtime: { pid: 51540, port: 8765, workspaceRoot: path.join(root, "engineering-ai") },
  } as never);
  try {
    const sup = new Supervisor({ repoRoot: root, stateDir, workspaceRoot: path.join(root, "control-repo") });
    const probes = (sup as unknown as { buildProbes(): SupervisorProbes }).buildProbes();
    expect(await probes.bridgePointer()).toEqual({ pid: 51540, port: 8765 });
    expect(spy).toHaveBeenCalledWith(expect.any(String), path.join(root, "control-repo"), { stateDir });
  } finally { spy.mockRestore(); }
});

describe("provider policy (enabled/required lanes)", () => {
  const codexOnly = {
    enabled: new Set(["codex"] as const),
    required: new Set(["codex"] as const),
  };
  const codexGemini = {
    enabled: new Set(["codex", "gemini"] as const),
    required: new Set(["codex", "gemini"] as const),
  };

  it("scenario A: codex-only machine — glm lanes are DISABLED, never launched, never degrade health", async () => {
    let desktopProbeCalls = 0;
    const h = makeHarness({
      probes: {
        zcodeDesktop: async () => { desktopProbeCalls += 1; return READY_DESKTOP; },
        z2cListener: async () => { throw new Error("z2c must not be probed when glm is disabled"); },
        coordinatorHeartbeatAgeMs: async () => { throw new Error("coordinator must not be probed when glm is disabled"); },
        glmControlPlane: async () => { throw new Error("control plane must not be probed when glm is disabled"); },
      },
      deps: { providerPolicy: codexOnly },
    });
    const snap = await h.supervisor.runTick();
    await h.supervisor.bootstrapOnTakeover();
    const byName = (name: string) => snap.components.find(c => c.component === name)!;
    expect(byName("z2c-listener").state).toBe("DISABLED");
    expect(byName("zcode-desktop").state).toBe("DISABLED");
    expect(byName("zcode-coordinator").state).toBe("DISABLED");
    expect(byName("providers").state).toBe("READY");
    expect(snap.overall).toBe("READY");
    // Disabled lanes are never launched, never respawned, never probed.
    expect(h.spawnCalls.filter(c => c.cmd.endsWith("ZCode.exe"))).toHaveLength(0);
    expect(h.spawnCalls.filter(c => String(c.args[0]).replace(/\\/g, "/").includes("/z2c/dist/service/main.js"))).toHaveLength(0);
    expect(desktopProbeCalls).toBe(0);
  });

  it("scenario B: codex + gemini without GLM — no ZCode recovery loop, both lanes callable", async () => {
    const h = makeHarness({ deps: { providerPolicy: codexGemini } });
    const snap = await h.supervisor.runTick();
    const report = await h.supervisor.bootstrapOnTakeover();
    expect(report.zcode.state).toBe("DISABLED");
    expect(h.spawnCalls.filter(c => c.cmd.endsWith("ZCode.exe"))).toHaveLength(0);
    expect(h.spawnCalls.filter(c => String(c.args[0]).replace(/\\/g, "/").includes("/z2c/dist/service/main.js"))).toHaveLength(0);
    expect(snap.components.find(c => c.component === "providers")!.state).toBe("READY");
    expect(snap.overall).toBe("READY");
    const health = snap.providerHealth!;
    expect(health.codex.callable).toBe(true);
    expect(health.gemini.callable).toBe(true);
    expect(health.glm.desktop).toBe("DISABLED");
    expect(health.glm.callable).toBe(false);
  });

  it("scenario C: default policy keeps the full three-provider deployment required", async () => {
    const { parseProviderPolicy } = await import("../src/supervisor/supervisor.js");
    const policy = parseProviderPolicy({});
    expect([...policy.enabled].sort()).toEqual(["codex", "gemini", "glm"]);
    expect([...policy.required].sort()).toEqual(["codex", "gemini", "glm"]);
    // The default harness (no policy override) keeps glm fully observed.
    const h = makeHarness();
    const snap = await h.supervisor.runTick();
    expect(snap.components.find(c => c.component === "z2c-listener")!.state).toBe("READY");
    expect(snap.components.find(c => c.component === "zcode-desktop")!.state).toBe("READY");
    expect(snap.providerHealth!.glm.callable).toBe(true);
  });

  it("an enabled-but-optional provider failure stays visible without degrading the providers aggregate", async () => {
    const optionalGlm = {
      enabled: new Set(["codex", "gemini", "glm"] as const),
      required: new Set(["codex", "gemini"] as const),
    };
    const h = makeHarness({
      probes: {
        z2cListener: async () => false,
        coordinatorHeartbeatAgeMs: async () => null,
        glmControlPlane: async () => ({
          level: "QUEUE_ROOT_MISSING" as const,
          workspace_binding: "UNRESOLVED" as const,
          native: { observed: false, available: null, provider: null, model: null, attested: null, observed_at: null },
        }),
      },
      deps: { providerPolicy: optionalGlm },
    });
    const snap = await h.supervisor.runTick();
    const providers = snap.components.find(c => c.component === "providers")!;
    expect(providers.state).toBe("READY");
    expect(providers.detail).toMatch(/optional-degraded: glm=/);
    expect(snap.providerHealth!.glm.callable).toBe(false);
  });

  it("a required provider failure still degrades the providers aggregate", async () => {
    const h = makeHarness({
      probes: {
        glmControlPlane: async () => ({
          level: "WORKSPACE_BINDING_FAILED" as const,
          workspace_binding: "FAILED" as const,
          native: { observed: true, available: true, provider: "zcode-desktop", model: "GLM-5.3-Flash", attested: true, observed_at: new Date().toISOString() },
        }),
      },
    });
    const snap = await h.supervisor.runTick();
    const providers = snap.components.find(c => c.component === "providers")!;
    expect(providers.state).toBe("DEGRADED");
    expect(providers.detail).toMatch(/glm=/);
    expect(snap.overall).toBe("DEGRADED");
  });
});

describe("F02: tunnel recovery uses the actual state-domain owner runtime", () => {
  it("starts the tunnel through the shared owner's verified admin credential", async () => {
    const daemon = await import("../src/process/daemon.js");
    const spy = vi.spyOn(daemon, "findSharedBridgeObservation").mockResolvedValue({
      state: "healthy",
      shared: true,
      runtime: { pid: 51540, port: 48765, adminToken: "secret-admin-token", workspaceId: "222222222222", workspaceRoot: path.join(root, "engineering-ai") },
      owner: { workspaceId: "222222222222", pid: 51540, processStartIdentity: "/Date(1)/", generation: "g" },
    } as never);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ url: "https://tunnel.example/mcp" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchStub);
    try {
      const sup = new Supervisor({ repoRoot: root, stateDir, workspaceRoot: path.join(root, "control-repo") });
      // Private recovery action; invoked directly to pin the contract.
      const outcome = await (sup as unknown as { actionStartTunnel(): Promise<string> }).actionStartTunnel();
      expect(outcome).toBe("tunnel start accepted");
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://127.0.0.1:48765/admin/tunnel/start");
      expect((calls[0].init?.headers as Record<string, string>).authorization).toBe("Bearer secret-admin-token");
      expect(spy).toHaveBeenCalledWith(expect.any(String), path.join(root, "control-repo"), { stateDir });
    } finally {
      vi.unstubAllGlobals();
      spy.mockRestore();
    }
  });

  it("never starts a tunnel (and never creates a second bridge) on stale/wrong owner metadata", async () => {
    const daemon = await import("../src/process/daemon.js");
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);
    for (const reason of ["active_owner_conflict", "owner_runtime_unhealthy", "admin_proof_unavailable", "unauthorized_workspace"] as const) {
      const spy = vi.spyOn(daemon, "findSharedBridgeObservation").mockResolvedValue({
        state: "unknown", runtime: null, reason,
      } as never);
      try {
        const sup = new Supervisor({ repoRoot: root, stateDir, workspaceRoot: path.join(root, "control-repo") });
        const outcome = await (sup as unknown as { actionStartTunnel(): Promise<string> }).actionStartTunnel();
        expect(outcome).toBe("no authenticated shared bridge for tunnel start");
      } finally {
        spy.mockRestore();
      }
    }
    expect(fetchStub).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("a degraded public MCP triggers the tunnel-start recovery during a normal tick", async () => {
    const daemon = await import("../src/process/daemon.js");
    const spy = vi.spyOn(daemon, "findSharedBridgeObservation").mockResolvedValue({
      state: "healthy",
      shared: false,
      runtime: { pid: 51540, port: 48765, adminToken: "primary-owner-token", workspaceId: "111111111111", workspaceRoot: root },
    } as never);
    const fetchStub = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);
    try {
      const h = makeHarness({ probes: { publicMcp: async () => false } });
      await h.supervisor.runTick();
      await vi.waitFor(() => expect(fetchStub).toHaveBeenCalled());
      const first = fetchStub.mock.calls[0]!;
      expect(String(first[0])).toBe("http://127.0.0.1:48765/admin/tunnel/start");
      expect((first[1]?.headers as Record<string, string>).authorization).toBe("Bearer primary-owner-token");
    } finally {
      vi.unstubAllGlobals();
      spy.mockRestore();
    }
  });
});
