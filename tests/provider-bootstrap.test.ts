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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));
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
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

it("passes the requested workspace to the production spawn for launch and open", async () => {
  const spawn = vi.mocked(childProcess.spawn).mockReturnValue({ pid: 0, unref() {} } as childProcess.ChildProcess);
  let rows: Array<{ pid: number; executable: string; commandLine: string }> = [];
  const reconciler = new ZcodeDesktopReconciler({
    workspaceRoot, stateDir: path.join(root, "state"), z2cRepoRoot: path.join(root, "z2c"),
    env: { C2C_ZCODE_DESKTOP_EXECUTABLE: DESKTOP_EXE(), Z2C_STATE_DIR: path.join(root, "z2cstate") },
    processInspector: () => ({ list: () => rows }), registrationWaitMs: 0, openWaitMs: 0,
    sleep: async () => {},
  });
  await reconciler.launchManagedDesktop();
  expect(spawn).toHaveBeenLastCalledWith(DESKTOP_EXE(), ["--open-workspace", workspaceRoot], expect.objectContaining({ cwd: workspaceRoot, windowsHide: true }));
  rows = [{ pid: 99, executable: DESKTOP_EXE(), commandLine: DESKTOP_EXE() }];
  const product = path.join(root, "product");
  await reconciler.requestWorkspaceOpen([product]);
  expect(spawn).toHaveBeenLastCalledWith(DESKTOP_EXE(), ["--open-workspace", product], expect.objectContaining({ cwd: product, windowsHide: true }));
});

const DESKTOP_EXE = () => path.join(root, "apps", "ZCode.exe");

interface HarnessOpts {
  registration?: { pid: number; workspace: string } | null;
  processes?: Array<{ pid: number; executable: string; commandLine: string; processStartIdentity?: string }>;
  inspectorUnavailable?: boolean;
  env?: NodeJS.ProcessEnv;
  registrationWaitMs?: number;
  recordPid?: number;
  gracefulClose?: (pid: number) => Promise<boolean>;
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
    ...(opts.gracefulClose ? { gracefulClose: opts.gracefulClose } : {}),
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
  it("desktop absent + no registration → managed launch requested with correct bundled Agent env", async () => {
    const h = makeReconciler();
    const obs = h.reconciler.observe();
    expect(obs.state).toBe("ZCODE_DESKTOP_ABSENT");
    expect(obs.launch).toBeDefined();
    const outcome = await obs.launch!();
    expect(h.spawnCalls.length).toBe(1);
    const launch = h.spawnCalls[0];
    expect(launch.cmd).toBe(DESKTOP_EXE());
    // Direct spawn (no shell string); the workspace path is passed as the
    // official CLI argument so the Desktop opens it on first launch.
    expect(launch.args).toEqual(["--open-workspace", workspaceRoot]);
    expect(launch.cwd).toBe(workspaceRoot);
    expect(launch.env?.ZCODE_AGENT_SERVER_COMMAND).toBeUndefined();
    expect(launch.env?.ZCODE_AGENT_SERVER_ARGS_JSON).toBeUndefined();
    expect("ZCODE_AGENT_SERVER_COMMAND" in (launch.env ?? {})).toBe(false);
    expect("ZCODE_AGENT_SERVER_ARGS_JSON" in (launch.env ?? {})).toBe(false);
    // Ownership record: safe metadata, no credentials.
    const rec = JSON.parse(fs.readFileSync(path.join(root, "state", "supervisor", "zcode-desktop.json"), "utf8")) as Record<string, unknown>;
    expect(rec.managed).toBe(true);
    expect(rec.workspace).toBe(workspaceRoot);
    expect(rec.executablePath).toBe(DESKTOP_EXE());
    expect(rec.generation).toBeTruthy();
    expect(JSON.stringify(rec)).not.toMatch(/token|secret|credential/i);
    expect(outcome).toMatch(/launched/);
  });

  it("stale parent env containing both ZCODE_AGENT_SERVER_* vars is scrubbed from launch/open child env", async () => {
    const h = makeReconciler({
      env: {
        Z2C_STATE_DIR: path.join(root, "z2cstate"),
        C2C_ZCODE_DESKTOP_EXECUTABLE: DESKTOP_EXE(),
        ZCODE_AGENT_SERVER_COMMAND: "C:\\stale\\proxy.exe",
        ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify(["--stale-proxy"]),
      },
    });
    const obs = h.reconciler.observe();
    expect(obs.launch).toBeDefined();
    await obs.launch!();
    expect(h.spawnCalls.length).toBe(1);
    const launch = h.spawnCalls[0];
    expect(launch.env?.ZCODE_AGENT_SERVER_COMMAND).toBeUndefined();
    expect(launch.env?.ZCODE_AGENT_SERVER_ARGS_JSON).toBeUndefined();
    expect("ZCODE_AGENT_SERVER_COMMAND" in (launch.env ?? {})).toBe(false);
    expect("ZCODE_AGENT_SERVER_ARGS_JSON" in (launch.env ?? {})).toBe(false);

    // Open workspace also scrubs the overrides
    const hOpen = makeReconciler({
      processes: [{ pid: 300, executable: DESKTOP_EXE(), commandLine: "" }],
      env: {
        Z2C_STATE_DIR: path.join(root, "z2cstate"),
        C2C_ZCODE_DESKTOP_EXECUTABLE: DESKTOP_EXE(),
        ZCODE_AGENT_SERVER_COMMAND: "C:\\stale\\proxy.exe",
        ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify(["--stale-proxy"]),
      },
    });
    await hOpen.reconciler.requestWorkspaceOpen([path.join(root, "other")]);
    expect(hOpen.spawnCalls.length).toBe(1);
    const openCall = hOpen.spawnCalls[0];
    expect(openCall.env?.ZCODE_AGENT_SERVER_COMMAND).toBeUndefined();
    expect(openCall.env?.ZCODE_AGENT_SERVER_ARGS_JSON).toBeUndefined();
    expect("ZCODE_AGENT_SERVER_COMMAND" in (openCall.env ?? {})).toBe(false);
    expect("ZCODE_AGENT_SERVER_ARGS_JSON" in (openCall.env ?? {})).toBe(false);
  });

  it("launch succeeds with bundled Agent without waiting for proxy registration", async () => {
    const h = makeReconciler({ registrationWaitMs: 30_000 });
    const obs = h.reconciler.observe();
    const outcome = await obs.launch!();
    expect(outcome).toMatch(/launched/);
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

  it("a running user/bundled Desktop with no registration is READY/non-actionable and no managedRestart", async () => {
    const h = makeReconciler({
      processes: [{ pid: 99, executable: DESKTOP_EXE(), commandLine: "" }],
    });
    const obs = h.reconciler.observe();
    expect(obs.state).toBe("READY");
    expect(obs.managed).toBe(false);
    expect(obs.desktopPid).toBe(99);
    expect(obs.registrationLive).toBe(false);
    expect(obs.launch).toBeUndefined();
    expect(obs.managedRestart).toBeUndefined();
    // Launching next to running Desktop is a guarded no-op.
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

  it("supervisor-owned live Desktop remains idempotently healthy without registration", async () => {
    const h = makeReconciler();
    await h.reconciler.observe().launch!();

    const recFile = path.join(root, "state", "supervisor", "zcode-desktop.json");
    const rec = JSON.parse(fs.readFileSync(recFile, "utf8")) as Record<string, unknown>;
    rec.pid = process.pid;
    rec.processStartIdentity = null;
    rec.executablePath = DESKTOP_EXE();
    fs.writeFileSync(recFile, JSON.stringify(rec));

    const h2 = makeReconciler({ inspectorUnavailable: true });
    const young = h2.reconciler.observe();
    expect(young.state).toBe("READY");
    expect(young.managed).toBe(true);
    expect(young.desktopPid).toBe(process.pid);
    expect(young.registrationLive).toBe(false);
    expect(young.launch).toBeUndefined();
    expect(young.managedRestart).toBeUndefined();
    await expect(h2.reconciler.launchManagedDesktop()).resolves.toMatch(/no launch/);
    expect(h2.spawnCalls.length).toBe(0);

    // Age the record past the grace window; remains healthy and idempotent
    const aged = JSON.parse(fs.readFileSync(recFile, "utf8")) as Record<string, unknown>;
    aged.startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    fs.writeFileSync(recFile, JSON.stringify(aged));
    const stale = h2.reconciler.observe();
    expect(stale.state).toBe("READY");
    expect(stale.managed).toBe(true);
    expect(stale.launch).toBeUndefined();
    expect(stale.managedRestart).toBeUndefined();
    await expect(h2.reconciler.launchManagedDesktop()).resolves.toMatch(/no launch/);
    expect(h2.spawnCalls.length).toBe(0);
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

  it("stale registration with a live supervisor record remains READY", () => {
    const recFile = path.join(root, "state", "supervisor", "zcode-desktop.json");
    fs.mkdirSync(path.dirname(recFile), { recursive: true });
    fs.writeFileSync(recFile, JSON.stringify({
      schema: 1, managed: true, pid: process.pid, processStartIdentity: null,
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(), generation: "g1",
      workspace: workspaceRoot, workspaceId: "w", executablePath: DESKTOP_EXE(), executablePathHash: "h",
    }));
    const h = makeReconciler({ inspectorUnavailable: true, registration: { pid: 4194304, workspace: workspaceRoot } });
    const obs = h.reconciler.observe();
    expect(obs.state).toBe("READY");
    expect(obs.managed).toBe(true);
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

// ── Automatic workspace activation + safe unmanaged-Desktop recovery (Z2/Z3/Z4) ──

describe("desired-workspace registration and safe recovery", () => {
  const engAiRoot = () => path.join(root, "engineering-ai");

  function makeMultiReconciler(opts: HarnessOpts & { desired?: string[] } = {}) {
    fs.mkdirSync(engAiRoot(), { recursive: true });
    const h = makeReconciler(opts);
    // Rebuild with desired roots (the harness passes fixed deps).
    const deps: ZcodeDesktopReconcilerDeps = {
      workspaceRoot,
      stateDir: path.join(root, "state"),
      z2cRepoRoot: path.join(root, "z2c"),
      env: opts.env ?? {
        Z2C_STATE_DIR: path.join(root, "z2cstate"),
        C2C_ZCODE_DESKTOP_EXECUTABLE: DESKTOP_EXE(),
      },
      now: () => new Date(),
      sleep: async () => {},
      registrationWaitMs: 0,
      openWaitMs: 0,
      restartWaitMs: 0,
      spawnDetached: (cmd, args, o) => {
        h.spawnCalls.push({ cmd, args, cwd: o.cwd, env: o.env });
        return { pid: 0 };
      },
      processInspector: () => (opts.inspectorUnavailable ? null : { list: () => opts.processes ?? [] }),
      ...(opts.gracefulClose ? { gracefulClose: opts.gracefulClose } : {}),
      desiredWorkspaceRoots: opts.desired,
    };
    return { reconciler: new ZcodeDesktopReconciler(deps), spawnCalls: h.spawnCalls, writeRegistration: h.writeRegistration };
  }

  it("primary registration live but desired workspace missing → ZCODE_WORKSPACE_NOT_OPEN with an open action", () => {
    const h = makeMultiReconciler({
      desired: [engAiRoot()],
      registration: { pid: process.pid, workspace: workspaceRoot },
    });
    const obs = h.reconciler.observe();
    expect(obs.state).toBe("ZCODE_WORKSPACE_NOT_OPEN");
    expect(obs.missingWorkspaceRoots).toEqual([path.normalize(engAiRoot())]);
    expect(obs.launch).toBeUndefined();
    expect(obs.openWorkspaces).toBeDefined();
    // READY requires EVERY desired workspace registration.
    expect(obs.registrationLive).toBe(false);
  });

  it("official workspace-open has no override", async () => {
    const h = makeMultiReconciler({
      desired: [engAiRoot()],
      processes: [{ pid: 500, executable: DESKTOP_EXE(), commandLine: "" }],
      registration: { pid: process.pid, workspace: workspaceRoot },
      env: {
        Z2C_STATE_DIR: path.join(root, "z2cstate"),
        C2C_ZCODE_DESKTOP_EXECUTABLE: DESKTOP_EXE(),
        ZCODE_AGENT_SERVER_COMMAND: "C:\\bad\\command",
        ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify(["--override"]),
      },
    });
    const obs = h.reconciler.observe();
    const outcome = await obs.openWorkspaces!();
    expect(h.spawnCalls.length).toBe(1);
    expect(h.spawnCalls[0].cmd).toBe(DESKTOP_EXE());
    expect(h.spawnCalls[0].args).toEqual(["--open-workspace", path.normalize(engAiRoot())]);
    expect(h.spawnCalls[0].env?.ZCODE_AGENT_SERVER_COMMAND).toBeUndefined();
    expect(h.spawnCalls[0].env?.ZCODE_AGENT_SERVER_ARGS_JSON).toBeUndefined();
    expect("ZCODE_AGENT_SERVER_COMMAND" in (h.spawnCalls[0].env ?? {})).toBe(false);
    expect("ZCODE_AGENT_SERVER_ARGS_JSON" in (h.spawnCalls[0].env ?? {})).toBe(false);
    expect(outcome).toMatch(/workspace open request sent/);
  });

  it("open action with no running Desktop never spawns an unmanaged instance", async () => {
    const h = makeMultiReconciler({ desired: [engAiRoot()] });
    const outcome = await h.reconciler.requestWorkspaceOpen([engAiRoot()]);
    expect(h.spawnCalls.length).toBe(0);
    expect(outcome).toMatch(/managed launch required/);
  });

  it("exact workspace binding survives recovery: desired roots dedupe and never bind a neighbor", async () => {
    const h = makeMultiReconciler({ desired: [workspaceRoot, workspaceRoot.toUpperCase()] });
    const obs = h.reconciler.observe();
    // workspaceRoot duplicated (case-variant) must collapse; registration missing → ABSENT.
    expect(obs.state).toBe("ZCODE_DESKTOP_ABSENT");
    expect(obs.missingWorkspaceRoots).toEqual([path.normalize(workspaceRoot)]);
  });

  it("running Desktop without registration is READY; direct attemptManagedRestart relaunches with bundled Agent env", async () => {
    const closeCalls: number[] = [];
    const processes = [{ pid: 99, executable: DESKTOP_EXE(), commandLine: "" }];
    const h = makeMultiReconciler({
      processes,
      desired: [engAiRoot()],
      gracefulClose: async (pid) => {
        closeCalls.push(pid);
        processes.splice(0, processes.length); // the Desktop actually exits
        return true;
      },
    });
    const obs = h.reconciler.observe();
    expect(obs.state).toBe("READY");
    expect(obs.managedRestart).toBeUndefined();
    const outcome = await h.reconciler.attemptManagedRestart(99);
    // Exactly one graceful close of the unmanaged pid, then the managed launch.
    expect(closeCalls).toEqual([99]);
    const launch = h.spawnCalls.find((c) => c.args.includes(workspaceRoot));
    expect(launch).toBeDefined();
    expect(launch!.env?.ZCODE_AGENT_SERVER_COMMAND).toBeUndefined();
    expect(launch!.env?.ZCODE_AGENT_SERVER_ARGS_JSON).toBeUndefined();
    expect(launch!.cwd).toBe(workspaceRoot);
    expect(outcome).toMatch(/launched/);
  });

  it("Desktop refusing graceful close records refusal, no force kill, once per generation", async () => {
    const closeCalls: number[] = [];
    const h = makeMultiReconciler({
      processes: [{ pid: 99, executable: DESKTOP_EXE(), commandLine: "" }],
      gracefulClose: async (pid) => {
        closeCalls.push(pid);
        return false;
      },
    });
    const outcome = await h.reconciler.attemptManagedRestart(99);
    expect(closeCalls).toEqual([99]);
    expect(outcome).toMatch(/did not close gracefully/);
    // A second restart attempt short-circuits (no duplicate closes).
    const reconciler = h.reconciler as unknown as { attemptManagedRestart(pid: number): Promise<string> };
    await expect(reconciler.attemptManagedRestart(99)).resolves.toMatch(/already refused/);
    expect(closeCalls).toEqual([99]);
  });

  it("a NEW Desktop generation is recoverable again after an earlier refusal", async () => {
    const h = makeMultiReconciler({
      processes: [{ pid: 99, executable: DESKTOP_EXE(), commandLine: "" }],
      gracefulClose: async () => false,
    });
    await h.reconciler.attemptManagedRestart(99);
    // The old instance exits; the user (or OS) starts a different one.
    const deps = h.reconciler["deps"] as unknown as { processInspector: () => { list: () => Array<{ pid: number; executable: string; commandLine: string }> } | null };
    deps.processInspector = () => ({ list: () => [{ pid: 200, executable: DESKTOP_EXE(), commandLine: "" }] });
    const obs2 = h.reconciler.observe();
    expect(obs2.state).toBe("READY");
    expect(obs2.desktopPid).toBe(200);
  });
});

describe("GUI main-process selection among same-exe processes", () => {
  it("targets only the bare-command-line GUI process; agent children and helpers are excluded", async () => {
    const closeCalls: number[] = [];
    const processes = [
      { pid: 10, executable: DESKTOP_EXE(), commandLine: `"${DESKTOP_EXE()}" --type=renderer --user-data-dir=X` },
      { pid: 20, executable: DESKTOP_EXE(), commandLine: `${DESKTOP_EXE()} --no-warnings ${path.join(root, "z2c", "scripts", "desktop-agent-proxy.mjs")}` },
      { pid: 30, executable: DESKTOP_EXE(), commandLine: `"${DESKTOP_EXE()}"` }, // the GUI main
    ];
    const h = makeReconciler({
      processes,
      gracefulClose: async (pid) => {
        closeCalls.push(pid);
        processes.splice(0, processes.length);
        return true;
      },
    });
    const obs = h.reconciler.observe();
    expect(obs.state).toBe("READY");
    expect(obs.desktopPid).toBe(30);
    const outcome = await h.reconciler.attemptManagedRestart(30);
    expect(closeCalls).toEqual([30]);
    expect(outcome).toMatch(/launched/);
  });
});
