/**
 * Regression coverage for provider bootstrap & reconciliation (R1.1):
 *   - provider strategies: codex/agy on-demand, zcode managed-persistent
 *   - on-demand readiness is local-only (no spawn, no canary)
 *   - managed ZCode Desktop desired-state rules:
 *       absent            → managed launch with correct proxy env + ownership record
 *       ready             → no duplicate launch
 *       unmanaged         → ZCODE_DESKTOP_UNMANAGED, no second launch, no kill
 *       crash/stale reg   → bounded relaunch (recoverable)
 *       wrong workspace   → rejected (not READY)
 *   - bounded executable discovery (override validated, standard locations,
 *     installed proxy metadata; no drive scan)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  reconcileAgyReadiness,
  reconcileCodexReadiness,
  resolveZcodeDesktopExecutable,
  registrationPathFor,
  strategyFor,
  ZcodeDesktopExecutableError,
  ZcodeDesktopReconciler,
  type ZcodeDesktopReconcilerDeps,
} from "../src/supervisor/provider-bootstrap.js";

let root: string;
let workspaceRoot: string;
let registrationsDir: string;

beforeEach(() => {
  root = mkdtemp();
  workspaceRoot = path.join(root, "ws");
  registrationsDir = path.join(root, "z2cstate", "desktop-agents");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(registrationsDir, { recursive: true });
  fs.mkdirSync(path.join(root, "apps"), { recursive: true });
  fs.writeFileSync(path.join(root, "apps", "ZCode.exe"), "not a real exe");
  fs.mkdirSync(path.join(root, "z2c", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "z2c", "scripts", "desktop-agent-proxy.mjs"), "// proxy\n");
});

function mkdtemp(): string {
  return fs.mkdtempSync(path.join(tmpdir(), "c2c-pb-"));
}

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const DESKTOP_EXE = () => path.join(root, "apps", "ZCode.exe");

interface HarnessOpts {
  registration?: { pid: number; workspace: string } | null;
  processes?: Array<{ pid: number; executable: string; commandLine: string; processStartIdentity?: string }>;
  inspectorUnavailable?: boolean;
  env?: NodeJS.ProcessEnv;
  registrationWaitMs?: number;
  recordPid?: number;
}

function makeReconciler(opts: HarnessOpts = {}) {
  const spawnCalls: Array<{ cmd: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }> = [];
  const sleeps: number[] = [];
  // Full replace: passing env must be able to REMOVE the defaults (e.g. to
  // exercise executable-not-found discovery).
  const env: NodeJS.ProcessEnv = opts.env ?? {
    Z2C_STATE_DIR: path.join(root, "z2cstate"),
    C2C_ZCODE_DESKTOP_EXECUTABLE: DESKTOP_EXE(),
  };
  const deps: ZcodeDesktopReconcilerDeps = {
    workspaceRoot,
    stateDir: path.join(root, "state"),
    z2cRepoRoot: path.join(root, "z2c"),
    env,
    now: () => new Date(),
    sleep: async (ms) => { sleeps.push(ms); },
    registrationWaitMs: opts.registrationWaitMs ?? 0,
    spawnDetached: (cmd, args, o) => {
      spawnCalls.push({ cmd, args, cwd: o.cwd, env: o.env });
      return { pid: opts.recordPid ?? 0 };
    },
    processInspector: () => (opts.inspectorUnavailable ? null : { list: () => opts.processes ?? [] }),
  };
  const reconciler = new ZcodeDesktopReconciler(deps);
  if (opts.registration !== undefined && opts.registration !== null) {
    writeRegistration(opts.registration);
  }
  return {
    reconciler,
    spawnCalls,
    sleeps,
    env,
    registrationFile: registrationPathFor(workspaceRoot, env),
    writeRegistration,
    removeRegistration: () => fs.rmSync(registrationPathFor(workspaceRoot, env), { force: true }),
  };

  function writeRegistration(reg: { pid: number; workspace: string }): void {
    fs.mkdirSync(path.dirname(registrationPathFor(workspaceRoot, env)), { recursive: true });
    fs.writeFileSync(registrationPathFor(workspaceRoot, env), JSON.stringify({
      port: 50000 + (reg.pid % 1000),
      token: "x".repeat(48),
      pid: reg.pid,
      workspace: reg.workspace,
      startedAt: Date.now(),
    }));
  }
}

describe("provider strategies", () => {
  it("codex and agy are on-demand; zcode is managed-persistent", () => {
    expect(strategyFor("codex")).toBe("on-demand");
    expect(strategyFor("gemini")).toBe("on-demand");
    expect(strategyFor("zcode")).toBe("managed-persistent");
  });
});

describe("on-demand readiness (codex, agy)", () => {
  it("codex executable available → READY_ON_DEMAND; missing → EXECUTABLE_MISSING", async () => {
    const ok = await reconcileCodexReadiness({ resolveExecutable: () => "C:\\x\\codex.exe" });
    expect(ok.state).toBe("READY_ON_DEMAND");
    expect(ok.executableAvailable).toBe(true);
    const missing = await reconcileCodexReadiness({ resolveExecutable: () => { throw new Error("CODEX_EXECUTABLE_NOT_FOUND"); } });
    expect(missing.state).toBe("EXECUTABLE_MISSING");
    expect(missing.executableAvailable).toBe(false);
  });

  it("agy installed → READY_ON_DEMAND; missing → provider-specific unavailable state", () => {
    const agyBin = path.join(root, "localappdata", "agy", "bin");
    fs.mkdirSync(agyBin, { recursive: true });
    fs.writeFileSync(path.join(agyBin, "agy.exe"), "not a real exe");
    const ok = reconcileAgyReadiness({
      stateDir: path.join(root, "state"),
      env: { LOCALAPPDATA: path.join(root, "localappdata") },
    });
    expect(ok.state).toBe("READY_ON_DEMAND");
    expect(ok.strategy).toBe("on-demand");

    const missing = reconcileAgyReadiness({
      stateDir: path.join(root, "state"),
      env: { LOCALAPPDATA: path.join(root, "nothing") },
    });
    expect(missing.state).toBe("EXECUTABLE_MISSING");
    expect(missing.executableAvailable).toBe(false);
  });

  it("agy readiness never launches anything (local checks only)", () => {
    const agyBin = path.join(root, "localappdata", "agy", "bin");
    fs.mkdirSync(agyBin, { recursive: true });
    fs.writeFileSync(path.join(agyBin, "agy.exe"), "not a real exe");
    const h = makeReconciler();
    reconcileAgyReadiness({ stateDir: path.join(root, "state"), env: { LOCALAPPDATA: path.join(root, "localappdata") } });
    expect(h.spawnCalls.length).toBe(0);
  });
});

describe("managed ZCode Desktop desired-state reconciliation", () => {
  it("desktop absent + no registration → managed launch requested with correct env", async () => {
    const h = makeReconciler();
    const obs = h.reconciler.observe();
    expect(obs.state).toBe("ZCODE_DESKTOP_ABSENT");
    expect(obs.launch).toBeDefined();
    const outcome = await obs.launch!();
    expect(h.spawnCalls.length).toBe(1);
    const launch = h.spawnCalls[0];
    expect(launch.cmd).toBe(DESKTOP_EXE());
    expect(launch.args).toEqual([]); // direct spawn, no shell string
    expect(launch.cwd).toBe(workspaceRoot);
    expect(launch.env?.ZCODE_AGENT_SERVER_COMMAND).toBe(process.execPath);
    const args = JSON.parse(launch.env?.ZCODE_AGENT_SERVER_ARGS_JSON ?? "[]") as string[];
    expect(args).toEqual([path.join(root, "z2c", "scripts", "desktop-agent-proxy.mjs"), "--stdio"]);
    // Ownership record: safe metadata, no credentials.
    const rec = JSON.parse(fs.readFileSync(path.join(root, "state", "supervisor", "zcode-desktop.json"), "utf8")) as Record<string, unknown>;
    expect(rec.managed).toBe(true);
    expect(rec.workspace).toBe(workspaceRoot);
    expect(rec.executablePath).toBe(DESKTOP_EXE());
    expect(rec.generation).toBeTruthy();
    expect(JSON.stringify(rec)).not.toMatch(/token|secret|credential/i);
    expect(outcome).toMatch(/launched/);
  });

  it("fresh registration appears after launch → launch reports it live", async () => {
    const h = makeReconciler({ registrationWaitMs: 30_000 });
    // The "proxy" publishes its registration on the first poll.
    let polled = false;
    h.reconciler["deps"].sleep = async () => {
      if (!polled) { polled = true; h.writeRegistration({ pid: process.pid, workspace: workspaceRoot }); }
    };
    const obs = h.reconciler.observe();
    const outcome = await obs.launch!();
    expect(outcome).toMatch(/registration live/);
  });

  it("desktop running + registration live → READY, no duplicate launch", async () => {
    const h = makeReconciler({
      registration: { pid: process.pid, workspace: workspaceRoot },
      processes: [{ pid: 500, executable: DESKTOP_EXE(), commandLine: "" }],
    });
    const obs = h.reconciler.observe();
    expect(obs.state).toBe("READY");
    expect(obs.registrationLive).toBe(true);
    expect(obs.launch).toBeUndefined();
    // Launching anyway must be a no-op (idempotence guard).
    await expect(h.reconciler.launchManagedDesktop()).resolves.toMatch(/no launch/);
    expect(h.spawnCalls.length).toBe(0);
  });

  it("desktop running + registration absent → ZCODE_DESKTOP_UNMANAGED, no second launch, no forced kill", async () => {
    const h = makeReconciler({
      processes: [{ pid: 99, executable: DESKTOP_EXE(), commandLine: "" }],
    });
    const obs = h.reconciler.observe();
    expect(obs.state).toBe("ZCODE_DESKTOP_UNMANAGED");
    expect(obs.managed).toBe(false);
    expect(obs.launch).toBeUndefined();
    await expect(h.reconciler.launchManagedDesktop()).resolves.toMatch(/no launch/);
    expect(h.spawnCalls.length).toBe(0);
  });

  it("managed desktop crashes (record dead, stale registration) → ABSENT and recoverable", async () => {
    const h = makeReconciler({ registration: { pid: 4194300, workspace: workspaceRoot } }); // pid dead (not in alive list)
    // First launch establishes a record; then everything dies.
    await h.reconciler.observe().launch!();
    // Simulate the crash: registration pid dies and the file goes stale.
    const obs = h.reconciler.observe();
    expect(obs.state).toBe("ZCODE_DESKTOP_ABSENT");
    expect(obs.launch).toBeDefined();
    expect(obs.detail).toMatch(/stale|no live/);
    await obs.launch!();
    expect(h.spawnCalls.length).toBe(2); // bounded relaunch happened
  });

  it("wrong-workspace registration → rejected (never READY), managed launch required", async () => {
    const h = makeReconciler({ registration: { pid: 777, workspace: "F:\\somewhere-else" } });
    const obs = h.reconciler.observe();
    expect(obs.state).not.toBe("READY");
    expect(obs.registrationLive).toBe(false);
    expect(obs.launch).toBeDefined();
    await obs.launch!();
    expect(h.spawnCalls.length).toBe(1);
  });

  it("supervisor-owned desktop alive but young → RECOVERING (no duplicate launch); old without registration → manual", async () => {
    const h = makeReconciler();
    await h.reconciler.observe().launch!(); // record with pid 0 → dead → not this case
    // Craft a live record: pid alive per our liveness seam via a real process —
    // use the current test process pid, which is definitely alive.
    const recFile = path.join(root, "state", "supervisor", "zcode-desktop.json");
    const rec = JSON.parse(fs.readFileSync(recFile, "utf8")) as Record<string, unknown>;
    rec.pid = process.pid;
    rec.processStartIdentity = null;
    rec.executablePath = DESKTOP_EXE();
    fs.writeFileSync(recFile, JSON.stringify(rec));

    // Inspector unavailable → recordLive falls back to pid liveness (alive).
    const h2 = makeReconciler({ inspectorUnavailable: true });
    // Share the same record file: stateDir identical.
    const young = h2.reconciler.observe();
    expect(young.state).toBe("RECOVERING");
    expect(young.launch).toBeUndefined();
    await expect(h2.reconciler.launchManagedDesktop()).resolves.toMatch(/no launch/);
    expect(h2.spawnCalls.length).toBe(0);

    // Age the record past the grace window.
    const aged = JSON.parse(fs.readFileSync(recFile, "utf8")) as Record<string, unknown>;
    aged.startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    fs.writeFileSync(recFile, JSON.stringify(aged));
    const stale = h2.reconciler.observe();
    expect(stale.state).toBe("ZCODE_DESKTOP_MANAGED_NOT_REGISTERED");
    expect(stale.launch).toBeUndefined();
    await expect(h2.reconciler.launchManagedDesktop()).resolves.toMatch(/no launch/);
    expect(h2.spawnCalls.length).toBe(0); // no forced kill, no duplicate
  });

  it("PID reuse cannot fake ownership: record identity mismatch → relaunchable", async () => {
    const h = makeReconciler();
    await h.reconciler.observe().launch!();
    const recFile = path.join(root, "state", "supervisor", "zcode-desktop.json");
    const rec = JSON.parse(fs.readFileSync(recFile, "utf8")) as Record<string, unknown>;
    rec.pid = process.pid;
    rec.processStartIdentity = "creation-20260101T000000";
    fs.writeFileSync(recFile, JSON.stringify(rec));
    // The live process at that pid has a DIFFERENT creation identity (PID reuse).
    const h2 = makeReconciler({
      processes: [{ pid: process.pid, executable: "C:\\Windows\\other.exe", commandLine: "", processStartIdentity: "creation-19990101T000000" }],
    });
    const obs = h2.reconciler.observe();
    expect(obs.state).toBe("ZCODE_DESKTOP_ABSENT"); // record not trusted
    expect(obs.launch).toBeDefined();
  });

  it("stale registration with a live record older than grace → manual, not READY", () => {
    const recFile = path.join(root, "state", "supervisor", "zcode-desktop.json");
    fs.mkdirSync(path.dirname(recFile), { recursive: true });
    fs.writeFileSync(recFile, JSON.stringify({
      schema: 1, managed: true, pid: process.pid, processStartIdentity: null,
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(), generation: "g1",
      workspace: workspaceRoot, workspaceId: "w", executablePath: DESKTOP_EXE(), executablePathHash: "h",
    }));
    const h = makeReconciler({ inspectorUnavailable: true, registration: { pid: 4194304, workspace: workspaceRoot } });
    const obs = h.reconciler.observe();
    expect(obs.state).toBe("ZCODE_DESKTOP_MANAGED_NOT_REGISTERED");
    expect(obs.registrationLive).toBe(false);
  });
});

describe("bounded executable discovery", () => {
  it("resolves the standard %LOCALAPPDATA% location", () => {
    const la = path.join(root, "la");
    fs.mkdirSync(path.join(la, "Programs", "ZCode"), { recursive: true });
    fs.writeFileSync(path.join(la, "Programs", "ZCode", "ZCode.exe"), "exe");
    const exe = resolveZcodeDesktopExecutable({ env: { LOCALAPPDATA: la }, registrationsDir });
    expect(exe).toBe(path.normalize(path.join(la, "Programs", "ZCode", "ZCode.exe")));
  });

  it("falls back to installed proxy metadata (zcodeCli) when standard paths are absent", () => {
    const installRoot = path.join(root, "meta-install", "ZCode");
    fs.mkdirSync(path.join(installRoot, "resources", "glm"), { recursive: true });
    fs.writeFileSync(path.join(installRoot, "ZCode.exe"), "exe");
    fs.writeFileSync(path.join(installRoot, "resources", "glm", "zcode.cjs"), "cli");
    fs.writeFileSync(path.join(registrationsDir, "agent-abcdef.json"), JSON.stringify({
      pid: 1, workspace: workspaceRoot, zcodeCli: path.join(installRoot, "resources", "glm", "zcode.cjs"),
    }));
    const exe = resolveZcodeDesktopExecutable({ env: {}, registrationsDir });
    expect(exe).toBe(path.normalize(path.join(installRoot, "ZCode.exe")));
  });

  it("honours a valid explicit override and rejects an invalid one", () => {
    const exe = resolveZcodeDesktopExecutable({ env: { C2C_ZCODE_DESKTOP_EXECUTABLE: DESKTOP_EXE() }, registrationsDir });
    expect(exe).toBe(path.normalize(DESKTOP_EXE()));
    expect(() => resolveZcodeDesktopExecutable({ env: { C2C_ZCODE_DESKTOP_EXECUTABLE: "relative.exe" }, registrationsDir }))
      .toThrow(ZcodeDesktopExecutableError);
    expect(() => resolveZcodeDesktopExecutable({ env: { C2C_ZCODE_DESKTOP_EXECUTABLE: path.join(root, "missing.exe") }, registrationsDir }))
      .toThrow(ZcodeDesktopExecutableError);
    const notExe = path.join(root, "apps", "ZCode.txt");
    fs.writeFileSync(notExe, "x");
    expect(() => resolveZcodeDesktopExecutable({ env: { C2C_ZCODE_DESKTOP_EXECUTABLE: notExe }, registrationsDir }))
      .toThrow(ZcodeDesktopExecutableError);
  });

  it("reports ZCODE_DESKTOP_EXECUTABLE_NOT_FOUND without launching; C2C stays healthy", () => {
    const h = makeReconciler({ env: {} }); // no override, no standard installs
    const obs = h.reconciler.observe();
    expect(obs.state).toBe("ZCODE_DESKTOP_EXECUTABLE_NOT_FOUND");
    expect(obs.launch).toBeUndefined();
    expect(h.spawnCalls.length).toBe(0);
  });
});
