import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestRestart, runRestartHelper, readRestartHandoff, waitRestartHandoff, restartLaunchSpec, inspectRestartProcessIdentity, type RestartDeps, type RestartHandoff } from "../src/process/restart.js";
import * as runtime from "../src/bridge/runtime.js";
import { stableWorkspaceId } from "../src/workspace/identity.js";
import { makeTmpDir, cleanup } from "./helpers.js";

describe("detached restart handoff (offline)", () => {
  let base: string, root: string, state: string, deps: RestartDeps;
  const old = { pid: 1001, port: 48765, startedAt: "2026-09-06T01:00:00.000Z", stateDomainGeneration: randomUUID(), processStartIdentity: "old-start" };
  const replacement = { ...old, pid: 1002, stateDomainGeneration: randomUUID(), processStartIdentity: "new-start", startedAt: "2026-09-06T02:00:00.000Z" };
  beforeEach(() => {
    base = makeTmpDir(); root = path.join(base, "workspace"); state = path.join(base, "state"); fs.mkdirSync(root);
    let started = false;
    deps = {
      observe: vi.fn(async () => started ? replacement : old), processStart: vi.fn(() => "helper-start"),
      launch: vi.fn(async () => {}), stop: vi.fn(async () => true),
      ensure: vi.fn(async () => { started = true; return { spawned: true, runtime: { ...replacement, service: "c2c", version: "test",
        workspaceRoot: root, workspaceId: stableWorkspaceId(root), stateDir: state, adminToken: "SECRET-ADMIN", publicUrl: null } }; }),
      tunnel: vi.fn(async () => true),
    };
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); cleanup(base); });
  const request = (tunnel = false) => requestRestart(root, { stateDir: state, tunnel }, deps);
  const handoffFile = () => path.join(state, "runtime", "restart-handoff.json");
  const lockDir = () => path.join(state, "runtime", "restart-handoff.lock");
  async function abandoned(overrides: Partial<RestartHandoff> = {}) {
    const record = await request();
    const stale = { ...record, createdAt: Date.now() - 180_001, expiresAt: Date.now() - 1,
      state: "stopping" as const, helper: { pid: 65416, start: "dead-helper-start" }, ...overrides };
    stale.expiresAt = stale.createdAt + 180_000;
    fs.writeFileSync(handoffFile(), JSON.stringify(stale));
    if (stale.helper) fs.writeFileSync(path.join(lockDir(), "claim"), "");
    deps.processIdentity = vi.fn((pid, start) => pid === old.pid && start === old.processStartIdentity ? "same" : "gone");
    vi.mocked(deps.launch).mockClear();
    return stale;
  }

  it("recovers expired stopping with a dead helper and preserves exact quarantined evidence", async () => {
    const stale = await abandoned();
    const evidence = fs.readFileSync(handoffFile(), "utf8");
    const next = await request();
    expect(next.id).not.toBe(stale.id);
    expect(next.old).toEqual(old);
    expect((await request()).id).toBe(next.id);
    expect(deps.launch).toHaveBeenCalledTimes(1);
    expect(deps.stop).not.toHaveBeenCalled(); expect(deps.ensure).not.toHaveBeenCalled();
    const archive = path.join(state, "runtime", `restart-handoff.${stale.id}.stale`);
    expect(fs.readFileSync(path.join(archive, "stale-handoff.json"), "utf8")).toBe(evidence);
    expect(fs.existsSync(path.join(archive, "claim"))).toBe(true);
    expect((await runRestartHelper(next.id, state, deps)).state).toBe("complete");
    expect(deps.stop).toHaveBeenCalledWith(root, { stateDir: state, expectedRuntime: old });
    expect(deps.ensure).toHaveBeenCalledTimes(1);
  });
  it("recovers a legacy lock with only a claim after proving its helper dead", async () => {
    const stale = await abandoned();
    fs.unlinkSync(path.join(lockDir(), "handoff-id"));
    // A real legacy record was created after its directory, unlike this edited fixture.
    const stat = fs.lstatSync(lockDir());
    const now = Date.now();
    stale.createdAt = Math.ceil(stat.birthtimeMs) + 1; stale.expiresAt = stale.createdAt + 180_000;
    fs.writeFileSync(handoffFile(), JSON.stringify(stale));
    vi.spyOn(Date, "now").mockReturnValue(now + 180_002);
    expect((await request()).id).not.toBe(stale.id);
    expect(deps.launch).toHaveBeenCalledTimes(1);
  });
  it.each(["same", "unknown"] as const)("expired helper identity %s fails closed without changing evidence", async status => {
    await abandoned();
    deps.processIdentity = vi.fn(() => status);
    const before = fs.readFileSync(handoffFile(), "utf8");
    await expect(request()).rejects.toThrow();
    expect(fs.readFileSync(handoffFile(), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(lockDir(), "claim"))).toBe(true);
    expect(deps.launch).not.toHaveBeenCalled();
  });
  it("treats PID reuse as gone only with a different observed process start identity", async () => {
    await abandoned();
    vi.spyOn(runtime, "getSystemProcessInspector").mockReturnValue({ list: () => [
      { pid: old.pid, processStartIdentity: old.processStartIdentity, executable: process.execPath, commandLine: "fixture", listeningPorts: [] },
      { pid: 65416, processStartIdentity: "reused-start", executable: "another-program", commandLine: "fixture", listeningPorts: [] },
    ] });
    deps.processIdentity = inspectRestartProcessIdentity;
    await request();
    expect(deps.launch).toHaveBeenCalledTimes(1);
  });
  it.each(["unavailable", "missing-start", "omitted-live", "denied", "duplicate-pid", "throws"])("process inspection %s cannot authorize reclaim", async mode => {
    await abandoned();
    const row = { pid: 65416, executable: process.execPath, commandLine: "fixture", listeningPorts: [] };
    vi.spyOn(runtime, "getSystemProcessInspector").mockReturnValue({ list: () => {
      if (mode === "throws") throw new Error("inspection failed");
      return mode === "unavailable" ? null : mode === "missing-start" ? [row] : mode === "duplicate-pid" ? [row, row] : [];
    } });
    vi.spyOn(process, "kill").mockImplementation(() => {
      if (mode === "denied") throw Object.assign(new Error("denied"), { code: "EPERM" });
      return true;
    });
    deps.processIdentity = inspectRestartProcessIdentity;
    await expect(request()).rejects.toThrow();
    expect(deps.launch).not.toHaveBeenCalled();
  });
  it("proves death using a successful inventory and ESRCH, never PID absence alone", () => {
    vi.spyOn(runtime, "getSystemProcessInspector").mockReturnValue({ list: () => [] });
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    expect(inspectRestartProcessIdentity(65416, "helper-start")).toBe("gone");
  });
  it.each(["complete", "failed"] as const)("terminal %s requires a dead helper even before expiry", async terminal => {
    const stale = await abandoned({ state: terminal, createdAt: Date.now() });
    deps.processIdentity = vi.fn(() => "same");
    await expect(request()).rejects.toThrow();
    deps.processIdentity = vi.fn(pid => pid === old.pid ? "same" : "gone");
    expect((await request()).id).not.toBe(stale.id);
    expect(deps.launch).toHaveBeenCalledTimes(1);
  });
  it("reclaims an abandoned pre-helper request only beyond launch grace", async () => {
    const stale = await abandoned({ helper: null, state: "requested", createdAt: Date.now() - 10_001 });
    expect((await request()).id).not.toBe(stale.id);
    expect(deps.launch).toHaveBeenCalledTimes(1);
    await expect(runRestartHelper(stale.id, state, deps)).rejects.toThrow();
  });
  it("fails closed for an unpublished helper identity even after expiry", async () => {
    await abandoned({ helper: null, state: "requested" });
    fs.writeFileSync(path.join(lockDir(), "claim"), "");
    await expect(request()).rejects.toThrow();
    expect(deps.launch).not.toHaveBeenCalled();
  });
  it("two concurrent reclaimers launch at most one new helper", async () => {
    const stale = await abandoned();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let arrivals = 0;
    deps.observe = vi.fn(async () => { if (++arrivals === 2) release(); await barrier; return old; });
    const results = await Promise.allSettled([request(), request()]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(deps.launch).toHaveBeenCalledTimes(1);
    expect(readRestartHandoff(state).id).not.toBe(stale.id);
    expect(fs.readFileSync(path.join(lockDir(), "handoff-id"), "utf8")).toBe(readRestartHandoff(state).id);
  });
  it.each(["stopping", "requested"] as const)("independent processes reclaim %s with only one launch", async stage => {
    await abandoned(stage === "requested" ? { state: stage, helper: null } : {});
    const fixture = path.join(base, "reclaim-contender.mjs"), starts = path.join(base, "launches");
    const ready = [path.join(base, "ready-0"), path.join(base, "ready-1")];
    const moduleUrl = pathToFileURL(path.resolve("dist/process/restart.js")).href;
    fs.writeFileSync(fixture, `import fs from 'node:fs'; import { requestRestart } from ${JSON.stringify(moduleUrl)};
      const ready = ${JSON.stringify(ready)}, old = ${JSON.stringify(old)};
      let first = true;
      try { await requestRestart(${JSON.stringify(root)}, { stateDir: ${JSON.stringify(state)}, tunnel: false }, {
        observe: async () => {
          if (first) { first = false; fs.writeFileSync(ready[Number(process.argv[2])], 'ready');
            const deadline = Date.now() + 5000;
            while (!ready.every(file => fs.existsSync(file))) {
              if (Date.now() > deadline) throw new Error('fixture barrier timeout');
              await new Promise(resolve => setTimeout(resolve, 5));
            }
          } return old;
        },
        processIdentity: pid => pid === old.pid ? 'same' : 'gone', processStart: () => 'fixture',
        launch: async id => fs.appendFileSync(${JSON.stringify(starts)}, id + '\\n')
      }); } catch (error) { fs.writeFileSync(ready[Number(process.argv[2])] + '.error', String(error.message)); process.exitCode = 2; }`);
    const children = [0, 1].map(index => spawn(process.execPath, [fixture, String(index)], { windowsHide: true, stdio: "ignore" }));
    const results = await Promise.all(children.map(child => new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve); child.once("error", reject);
    })));
    const errors = ready.map(file => fs.existsSync(file + ".error") ? fs.readFileSync(file + ".error", "utf8") : "success");
    expect(results.filter(code => code === 0), JSON.stringify(errors)).toHaveLength(1);
    const launches = fs.readFileSync(starts, "utf8").trim().split("\n");
    expect(launches).toEqual([readRestartHandoff(state).id]);
    expect((await request()).id).toBe(launches[0]);
  });
  it("a delayed pre-helper claimant cannot poison or rename the winning generation", async () => {
    const stale = await abandoned({ state: "requested", helper: null });
    const next = { ...stale, id: randomUUID(), createdAt: Date.now(), expiresAt: Date.now() + 180_000 };
    next.expiresAt = next.createdAt + 180_000;
    const originalOpen = fs.openSync;
    let raced = false;
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      if (!raced && file === path.join(lockDir(), `claim-${stale.id}`) && flags === "wx") {
        raced = true;
        // Emulate a second process winning after our last read but before our
        // exclusive claim. The losing process must not alter its generation.
        const archive = path.join(state, "runtime", `restart-handoff.${stale.id}.stale`);
        fs.renameSync(lockDir(), archive);
        fs.writeFileSync(path.join(archive, "stale-handoff.json"), JSON.stringify(stale));
        fs.mkdirSync(lockDir());
        fs.writeFileSync(path.join(lockDir(), "handoff-id"), next.id);
        fs.writeFileSync(handoffFile(), JSON.stringify(next));
      }
      return originalOpen(file, flags, mode);
    });
    await expect(request()).rejects.toThrow();
    expect(raced).toBe(true);
    expect(deps.launch).not.toHaveBeenCalled();
    expect((await request()).id).toBe(next.id);
    expect((await runRestartHelper(next.id, state, deps)).state).toBe("complete");
    expect(deps.ensure).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])("bounded rename retry revalidates identity (becomes unavailable: %s)", async unavailable => {
    const stale = await abandoned({ state: "requested", helper: null });
    const originalRename = fs.renameSync;
    let denied = false;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (source === lockDir() && !denied) {
        denied = true;
        if (unavailable) deps.processIdentity = vi.fn(() => "unknown");
        throw Object.assign(new Error("transient fixture handle"), { code: "EPERM" });
      }
      return originalRename(source, destination);
    });
    if (unavailable) {
      await expect(request()).rejects.toThrow(/identity unavailable/);
      expect(readRestartHandoff(state).id).toBe(stale.id);
      expect(fs.existsSync(path.join(lockDir(), `claim-${stale.id}`))).toBe(false);
      expect(deps.launch).not.toHaveBeenCalled();
    } else {
      expect((await request()).id).not.toBe(stale.id);
      expect(deps.launch).toHaveBeenCalledTimes(1);
    }
    expect(denied).toBe(true);
  });
  it("a stopping record without a helper identity is malformed, even without a claim", async () => {
    await abandoned({ state: "stopping", helper: null });
    await expect(request()).rejects.toThrow(/Invalid restart handoff/);
    expect(deps.launch).not.toHaveBeenCalled();
  });
  it("retains readable helper identity failure evidence but never reclaims its abandoned lock", async () => {
    const record = await request();
    deps.processStart = vi.fn(() => { throw new Error("inspection unavailable"); });
    expect(await runRestartHelper(record.id, state, deps)).toMatchObject({ state: "failed", error: "VALIDATION_FAILED", helper: null });
    expect(readRestartHandoff(state).error).toBe("VALIDATION_FAILED");
    // Model a crash before that helper could remove its own claim/lock.
    fs.mkdirSync(lockDir()); fs.writeFileSync(path.join(lockDir(), "handoff-id"), record.id);
    fs.writeFileSync(path.join(lockDir(), `claim-${record.id}`), record.id);
    deps.processIdentity = vi.fn(() => "gone");
    vi.mocked(deps.launch).mockClear();
    await expect(request()).rejects.toThrow(/identity unavailable/);
    expect(deps.launch).not.toHaveBeenCalled();
  });
  it("refuses recovery while current owner validation sees a shutdown transition", async () => {
    await abandoned();
    const before = fs.readFileSync(handoffFile(), "utf8");
    deps.observe = vi.fn(async () => { throw new Error("owner/runtime missing during shutdown"); });
    await expect(request()).rejects.toThrow();
    expect(fs.readFileSync(handoffFile(), "utf8")).toBe(before);
    expect(fs.existsSync(lockDir())).toBe(true);
    expect(deps.launch).not.toHaveBeenCalled(); expect(deps.ensure).not.toHaveBeenCalled();
  });
  it("a live captured old runtime cannot be bypassed by observing a different owner", async () => {
    await abandoned(); deps.observe = vi.fn(async () => replacement);
    await expect(request()).rejects.toThrow(/still live/);
    expect(deps.launch).not.toHaveBeenCalled();
    deps.processIdentity = vi.fn(() => "gone");
    expect((await request()).old).toEqual(replacement);
  });
  it("rechecks the current owner after reclamation before publishing or launching", async () => {
    const stale = await abandoned();
    vi.mocked(deps.observe).mockResolvedValueOnce(old).mockRejectedValueOnce(new Error("owner now shutting down"));
    await expect(request()).rejects.toThrow();
    expect(readRestartHandoff(state).id).toBe(stale.id);
    expect(deps.launch).not.toHaveBeenCalled();
  });
  it.each(["unexpected-entry", "claim-directory", "claim-hardlink", "wrong-token", "malformed", "foreign-domain", "runtime-alias"])("unsafe %s fails closed and preserves evidence", async mode => {
    const stale = await abandoned();
    const sentinel = path.join(base, "sentinel"); fs.writeFileSync(sentinel, "untouched");
    if (mode === "unexpected-entry") fs.writeFileSync(path.join(lockDir(), "unexpected"), "data");
    if (mode === "claim-directory" || mode === "claim-hardlink") {
      fs.unlinkSync(path.join(lockDir(), "claim"));
      if (mode === "claim-directory") fs.mkdirSync(path.join(lockDir(), "claim"));
      else fs.linkSync(sentinel, path.join(lockDir(), "claim"));
    }
    if (mode === "wrong-token") fs.writeFileSync(path.join(lockDir(), "handoff-id"), randomUUID());
    if (mode === "malformed") fs.writeFileSync(handoffFile(), "{}");
    if (mode === "foreign-domain") fs.writeFileSync(handoffFile(), JSON.stringify({ ...stale, stateDir: base }));
    if (mode === "runtime-alias") {
      const moved = path.join(base, "runtime-evidence");
      fs.renameSync(path.join(state, "runtime"), moved);
      fs.symlinkSync(moved, path.join(state, "runtime"), "junction");
    }
    const before = fs.readFileSync(handoffFile(), "utf8");
    await expect(request()).rejects.toThrow();
    expect(fs.readFileSync(handoffFile(), "utf8")).toBe(before);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("untouched");
    expect(deps.launch).not.toHaveBeenCalled();
  });
  it("stale recovery remains inside the selected isolated state directory", async () => {
    await abandoned();
    const other = path.join(base, "other-state");
    const otherRecord = await requestRestart(root, { stateDir: other, tunnel: false }, deps);
    const otherFile = path.join(other, "runtime", "restart-handoff.json");
    const before = fs.readFileSync(otherFile, "utf8");
    vi.mocked(deps.launch).mockClear();
    vi.stubEnv("C2C_STATE_DIR", other);
    await request();
    expect(fs.readFileSync(otherFile, "utf8")).toBe(before);
    expect(readRestartHandoff(other).id).toBe(otherRecord.id);
    expect(fs.readdirSync(path.join(other, "runtime")).some(name => name.endsWith(".stale"))).toBe(false);
    expect(deps.launch).toHaveBeenCalledTimes(1);
  });

  it("caller may die after launch: the helper owns stop, start, and durable sanitized result", async () => {
    const record = await request();
    expect(deps.stop).not.toHaveBeenCalled(); expect(deps.ensure).not.toHaveBeenCalled();
    const done = await runRestartHelper(record.id, state, deps);
    expect(done.state).toBe("complete"); expect(done.helper?.start).toBe("helper-start");
    expect(deps.stop).toHaveBeenCalledWith(root, { stateDir: state, expectedRuntime: old });
    expect(deps.ensure).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(readRestartHandoff(state))).not.toContain("SECRET-ADMIN");
    await expect(runRestartHelper(record.id, state, deps)).rejects.toThrow();
    expect(deps.ensure).toHaveBeenCalledTimes(1);
  });
  it("manual caller can wait while the independently launched helper completes", async () => {
    const record = await request();
    const wait = waitRestartHandoff(record.id, state, 2000);
    await runRestartHelper(record.id, state, deps);
    expect((await wait).replacement?.pid).toBe(replacement.pid);
  });
  it("duplicate requests reuse one pending or running helper", async () => {
    const record = await request();
    expect((await request()).id).toBe(record.id);
    let resume!: () => void;
    deps.stop = vi.fn(() => new Promise(resolve => { resume = () => resolve(true); }));
    const work = runRestartHelper(record.id, state, deps);
    await vi.waitFor(() => expect(readRestartHandoff(state).state).toBe("stopping"));
    expect((await request()).id).toBe(record.id);
    await expect(runRestartHelper(record.id, state, deps)).rejects.toThrow();
    expect(deps.launch).toHaveBeenCalledTimes(1);
    resume(); await work;
    expect(deps.ensure).toHaveBeenCalledTimes(1);
  });
  it.each(["stop", "ensure", "tunnel"] as const)("%s failure is visible and sanitized", async stage => {
    if (stage === "tunnel") {
      fs.mkdirSync(path.join(state, "tunnels"), { recursive: true });
      fs.writeFileSync(path.join(state, "tunnels", `${stableWorkspaceId(root)}.json`), JSON.stringify({ workspaceId: stableWorkspaceId(root), preference: "quick", provider: "cloudflare-quick" }));
    }
    deps[stage] = vi.fn(async () => { throw new Error("Bearer SECRET-ADMIN raw upstream error"); }) as never;
    const record = await request(stage === "tunnel");
    expect((await runRestartHelper(record.id, state, deps)).state).toBe("failed");
    await expect(waitRestartHandoff(record.id, state, 100)).rejects.toThrow(/helper failed/);
    expect(JSON.stringify(readRestartHandoff(state))).not.toMatch(/Bearer|SECRET|raw upstream/);
  });
  it("rejects ambiguous state and tunnel selection before shutdown", async () => {
    await expect(request(true)).rejects.toThrow();
    deps.observe = vi.fn(async () => { throw new Error("ambiguous owner"); });
    await expect(request()).rejects.toThrow();
    expect(deps.stop).not.toHaveBeenCalled(); expect(deps.launch).not.toHaveBeenCalled();
  });
  it("persists launch failure without touching the bridge", async () => {
    deps.launch = vi.fn(async () => { throw new Error("secret launch error"); });
    await expect(request()).rejects.toThrow(/launch failed/);
    expect(readRestartHandoff(state)).toMatchObject({ state: "failed", error: "LAUNCH_FAILED", helper: null });
    expect(deps.stop).not.toHaveBeenCalled();
  });
  it("changed tunnel state blocks helper shutdown and never spawns a second helper", async () => {
    const record = await request();
    fs.mkdirSync(path.join(state, "tunnels"));
    fs.writeFileSync(path.join(state, "tunnels", `${record.workspaceId}.json`), JSON.stringify({ workspaceId: "other", preference: "quick" }));
    expect((await runRestartHelper(record.id, state, deps)).error).toBe("VALIDATION_FAILED");
    expect(deps.stop).not.toHaveBeenCalled(); expect(deps.ensure).not.toHaveBeenCalled();
  });
  it("malformed tunnel state fails closed even without --tunnel", async () => {
    fs.mkdirSync(path.join(state, "tunnels"), { recursive: true });
    fs.writeFileSync(path.join(state, "tunnels", `${stableWorkspaceId(root)}.json`), "not-json");
    await expect(request()).rejects.toThrow();
    expect(deps.launch).not.toHaveBeenCalled();
  });
  it("rejects a handoff hardlink and preserves the target bytes", async () => {
    const record = await request();
    const file = path.join(state, "runtime", "restart-handoff.json"), target = path.join(base, "untouched");
    fs.linkSync(file, target);
    const before = fs.readFileSync(target, "utf8");
    await expect(runRestartHelper(record.id, state, deps)).rejects.toThrow(/Unsafe/);
    expect(fs.readFileSync(target, "utf8")).toBe(before); expect(deps.stop).not.toHaveBeenCalled();
  });
  it("rejects changed runtime, mismatched request, expired handoff, and arbitrary helper arguments", async () => {
    const record = await request();
    await expect(request(true)).rejects.toThrow(/ambiguous/);
    await expect(runRestartHelper("../../anything", state, deps)).rejects.toThrow();
    const file = path.join(state, "runtime", "restart-handoff.json");
    fs.writeFileSync(file, JSON.stringify({ ...record, createdAt: 1, expiresAt: 180001 }));
    await expect(runRestartHelper(record.id, state, deps)).rejects.toThrow(/stale/);
    await expect(request()).rejects.toThrow(/stale/);
    fs.writeFileSync(file, JSON.stringify(record));
    deps.observe = vi.fn(async () => replacement);
    expect((await runRestartHelper(record.id, state, deps)).error).toBe("VALIDATION_FAILED");
    expect(deps.stop).not.toHaveBeenCalled();
  });
  it("rejects state aliases, corrupt records, and recursive invocation", async () => {
    await request();
    fs.writeFileSync(path.join(state, "runtime", "restart-handoff.json"), "{}");
    await expect(request()).rejects.toThrow();
    vi.stubEnv("C2C_RESTART_HELPER", "1");
    await expect(request()).rejects.toThrow(/Recursive/);
    vi.unstubAllEnvs();
    const alias = path.join(base, "alias"); fs.symlinkSync(state, alias, "junction");
    await expect(requestRestart(root, { stateDir: alias, tunnel: false }, deps)).rejects.toThrow();
  });
  it("uses a fixed hidden detached executable entry with no shell or loader injection", () => {
    // Build is a requested prerequisite for this process-level assertion.
    return import("../dist/process/restart.js").then(module => {
      vi.stubEnv("NODE_OPTIONS", "--import arbitrary.js");
      const spec = module.restartLaunchSpec(randomUUID(), state);
      expect(spec.command).toBe(process.execPath);
      expect(spec.args).toHaveLength(2);
      expect(spec.args[0]).toBe(path.resolve("dist/process/restart-helper.js"));
      expect(spec.options).toMatchObject({ detached: true, windowsHide: true, shell: false, stdio: "ignore" });
      expect(spec.options.env.NODE_OPTIONS).toBeUndefined();
      expect(() => restartLaunchSpec("bad;cmd", state)).toThrow();
    });
  });

  it("real detached child survives parent termination immediately after claiming and starts exactly once", async () => {
    // Both processes use test-only dependencies. No bridge, service, network, or real runtime is touched.
    const moduleUrl = pathToFileURL(path.resolve("dist/process/restart.js")).href;
    const childFile = path.join(base, "fixture-child.mjs");
    const parentFile = path.join(base, "fixture-parent.mjs");
    const countFile = path.join(base, "starts");
    const readyFile = path.join(base, "child-ready");
    const releaseFile = path.join(base, "parent-exited");
    const doneFile = path.join(base, "child-done");
    const waitForFile = `async function waitForFile(file) {
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(file)) {
        if (Date.now() >= deadline) throw new Error('fixture handshake timeout');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }`;
    fs.writeFileSync(childFile, `import fs from 'node:fs'; import { runRestartHelper } from ${JSON.stringify(moduleUrl)};
      const state = ${JSON.stringify(state)}, old = ${JSON.stringify(old)}, replacement = ${JSON.stringify(replacement)};
      ${waitForFile}
      let started = false;
      const result = await runRestartHelper(process.argv[2], state, { processStart: () => 'fixture-child-start',
        observe: async () => started ? replacement : old, stop: async () => {
          fs.writeFileSync(${JSON.stringify(readyFile)}, process.argv[2]);
          await waitForFile(${JSON.stringify(releaseFile)}); return true;
        },
        ensure: async () => { started = true; fs.appendFileSync(${JSON.stringify(countFile)}, 'start\\n'); return { runtime: replacement, spawned: true }; },
        tunnel: async () => true, launch: async () => { throw new Error('recursive'); } });
      fs.writeFileSync(${JSON.stringify(doneFile)}, JSON.stringify(result));`);
    fs.writeFileSync(parentFile, `import fs from 'node:fs'; import { spawn } from 'node:child_process'; import { requestRestart } from ${JSON.stringify(moduleUrl)};
      ${waitForFile}
      await requestRestart(${JSON.stringify(root)}, { stateDir: ${JSON.stringify(state)}, tunnel: false }, {
        observe: async () => (${JSON.stringify(old)}), processStart: () => 'fixture-parent-start',
        launch: async id => { const child = spawn(process.execPath, [${JSON.stringify(childFile)}, id], { detached: true, windowsHide: true, stdio: 'ignore' }); child.unref();
          await new Promise((r,j) => { child.once('spawn',r); child.once('error',j); });
          await waitForFile(${JSON.stringify(readyFile)});
          if (fs.readFileSync(${JSON.stringify(readyFile)}, 'utf8') !== id) throw new Error('wrong fixture generation');
          process.kill(process.pid, 'SIGTERM'); }
      });`);
    const parent = spawn(process.execPath, [parentFile], { windowsHide: true, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { parent.once("exit", () => resolve()); parent.once("error", reject); });
    // stop() is reached only after the helper has claimed, published its identity,
    // and validated the old runtime. Hold it there until the parent really exits.
    // Poll separate markers, not the durable record while Windows replaces it.
    const claimed = readRestartHandoff(state);
    expect(fs.readFileSync(readyFile, "utf8")).toBe(claimed.id);
    expect(claimed.state).toBe("stopping");
    expect(claimed.helper?.start).toBe("fixture-child-start");
    expect(fs.existsSync(countFile)).toBe(false);
    fs.writeFileSync(releaseFile, claimed.id);
    await vi.waitFor(() => expect(fs.existsSync(doneFile)).toBe(true), { timeout: 10_000 });
    const done = readRestartHandoff(state);
    expect(done.state, JSON.stringify(done)).toBe("complete");
    expect(done.id).toBe(claimed.id);
    expect(done.helper).toEqual(claimed.helper);
    expect(fs.readFileSync(countFile, "utf8")).toBe("start\n");
  }, 15_000);
});
