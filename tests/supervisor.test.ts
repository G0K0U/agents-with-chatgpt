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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  mkdirSync(path.join(root, "z2c", "dist"), { recursive: true });
  mkdirSync(path.join(root, "z2c", "scripts"), { recursive: true });
  writeFileSync(path.join(root, "z2c", "dist", "index.js"), "// z2c entry\n");
  writeFileSync(path.join(root, "z2c", "scripts", "desktop-host-shim.mjs"), "// shim\n");
  writeFileSync(path.join(root, "z2c", "scripts", "desktop-agent-proxy.mjs"), "// proxy\n");
  // A fake ZCode Desktop executable for bounded discovery.
  mkdirSync(path.join(root, "apps"), { recursive: true });
  writeFileSync(path.join(root, "apps", "ZCode.exe"), "not a real exe");
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
} = {}) {
  let time = Date.parse("2026-09-13T05:00:00.000Z");
  const now = (): Date => new Date(time);
  const spawnCalls: Array<{ cmd: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }> = [];
  const healthyProbes: Partial<SupervisorProbes> = {
    bridgeHealth: async () => ({
      workspaceId: "3402ed46d3f8",
      releaseId: "0.2.0-deadbeef",
      sourceParity: "ok",
      buildParity: "ok",
      version: "0.2.0",
    }),
    publicMcp: async () => true,
    z2cListener: async () => true,
    zcodeDesktop: async () => READY_DESKTOP,
    coordinatorHeartbeatAgeMs: async () => 1_000,
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
      Z2C_STATE_DIR: path.join(root, "z2cstate"),
      C2C_ZCODE_DESKTOP_EXECUTABLE: path.join(root, "apps", "ZCode.exe"),
    },
    ...opts.deps,
    probes: healthyProbes,
  });
  const advance = (ms: number): void => { time += ms; };
  return { supervisor, advance, spawnCalls, now: () => new Date(time), workspaceRoot };
}

describe("recovery backoff", () => {
  it("uses the documented schedule and refuses unbounded retries", () => {
    expect(recoveryDelayMs(1)).toBe(0);
    expect(recoveryDelayMs(2)).toBe(5_000);
    expect(recoveryDelayMs(3)).toBe(15_000);
    expect(recoveryDelayMs(4)).toBe(30_000);
    expect(recoveryDelayMs(5)).toBeNull();
  });
});

describe("supervisor state machine", () => {
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
    expect(h.spawnCalls.filter(c => String(c.args[0]).replace(/\\/g, "/").includes("/z2c/dist/index.js")).length).toBe(1);
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
    // Attempt 3 after 15s, attempt 4 after 30s, then FAILED and no further action.
    h.advance(15_000);
    await h.supervisor.runTick();
    expect(h.spawnCalls.length).toBe(3);
    h.advance(30_000);
    await h.supervisor.runTick();
    expect(h.spawnCalls.length).toBe(4);
    h.advance(60_000);
    const snap = await h.supervisor.runTick();
    expect(h.spawnCalls.length).toBe(4); // bounded forever
    expect(snap.overall).toBe("FAILED");
    const z2c = snap.components.find(c => c.component === "z2c-listener")!;
    expect(z2c.state).toBe("FAILED");
    expect(z2c.detail).toMatch(/manual intervention/);
    // The status file persisted the same truth.
    expect(existsSync(path.join(stateDir, "supervisor", "status.json"))).toBe(true);
    const persisted = JSON.parse(readFileSync(path.join(stateDir, "supervisor", "status.json"), "utf8")) as { overall: string };
    expect(persisted.overall).toBe("FAILED");
  });

  it("launches the managed ZCode Desktop with the proxy env only when it is genuinely absent", async () => {
    let calls = 0;
    const h = makeHarness({ probes: { zcodeDesktop: async () => (calls++ === 0 ? ABSENT_DESKTOP() : READY_DESKTOP) } });
    await h.supervisor.runTick();
    await vi.waitFor(() => {
      expect(h.spawnCalls.filter(c => c.cmd.endsWith("ZCode.exe")).length).toBe(1);
    });
    const launch = h.spawnCalls.find(c => c.cmd.endsWith("ZCode.exe"))!;
    expect(launch.args).toEqual([]);
    expect(launch.cwd).toBe(h.workspaceRoot);
    expect(launch.env?.ZCODE_AGENT_SERVER_COMMAND).toBe(process.execPath);
    const args = JSON.parse(launch.env?.ZCODE_AGENT_SERVER_ARGS_JSON ?? "[]") as string[];
    expect(args[0]).toMatch(/desktop-agent-proxy\.mjs$/);
    expect(args[1]).toBe("--stdio");
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

  it("recovers the managed desktop lane through the bounded ladder, then FAILED", async () => {
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
    expect(launches()).toBe(4); // bounded forever
    expect(snap.components.find(c => c.component === "zcode-desktop")!.state).toBe("FAILED");
  });

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
      expect(h.spawnCalls.filter(c => String(c.args[0]).replace(/\\/g, "/").includes("/z2c/dist/index.js")).length).toBe(1);
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
          workspaceId: "3402ed46d3f8",
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
    expect(launch.env?.ZCODE_AGENT_SERVER_COMMAND).toBe(process.execPath);
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
    // Golden value from the live registration on this machine for the
    // supervised workspace (the proxy hashes the lower-cased cwd).
    const file = registrationPathFor("F:\\AI Startup\\codex-with-chatgpt", { LOCALAPPDATA: "C:\\u" } as NodeJS.ProcessEnv);
    expect(file.toLowerCase()).toBe("c:\\u\\z2c\\desktop-agents\\agent-24ed64cef8d57d1c.json");
  });
});
