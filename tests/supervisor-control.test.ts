import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { inspectSupervisorProcess, observeSupervisorStatus, readSupervisorSnapshot, stopSupervisorProcess } from "../src/supervisor/control.js";
import type { BridgeProcessIdentity } from "../src/bridge/runtime.js";
import type { SupervisorSnapshot } from "../src/supervisor/supervisor.js";

const root = path.resolve(import.meta.dirname, "..");
const entry = path.join(root, "bin", "c2c.js");
const exe = fs.realpathSync.native(process.execPath);
const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "a2c-supervisor-control-"));
  temporary.push(base);
  const stateDir = path.join(base, "state");
  const workspaceRoot = path.join(base, "workspace");
  fs.mkdirSync(path.join(stateDir, "supervisor"), { recursive: true });
  fs.mkdirSync(workspaceRoot);
  const commandLine = `"${exe}" "${entry}" supervisor run --workspace "${workspaceRoot}" --state-dir "${stateDir}"`;
  const row: BridgeProcessIdentity = {
    pid: process.pid, executable: exe, commandLine, listeningPorts: [], processStartIdentity: "generation-1",
  };
  const inspector = { list: () => [row] };
  const lock = {
    pid: process.pid, identity: "lock-1", acquiredAt: new Date().toISOString(), processStartIdentity: "generation-1",
    workspaceRoot, stateDir, executable: exe, entry,
  };
  const snapshot: SupervisorSnapshot = {
    schema: 2, pid: process.pid, startedAt: new Date().toISOString(), tick: 1,
    lastTickAt: new Date().toISOString(), overall: "READY", components: [], recoveryLog: [],
    processStartIdentity: "generation-1", identity: "lock-1", workspaceRoot, stateDir,
  };
  const save = () => {
    fs.writeFileSync(path.join(stateDir, "supervisor", "supervisor.lock"), JSON.stringify(lock));
    fs.writeFileSync(path.join(stateDir, "supervisor", "status.json"), JSON.stringify(snapshot));
  };
  return { stateDir, workspaceRoot, row, inspector, lock, snapshot, save };
}

describe("verified supervisor lifecycle", () => {
  it("accepts an explicit state directory through the real CLI and rejects its omission", () => {
    const f = fixture();
    const sourceCli = path.join(root, "src", "cli", "index.ts");
    const blocker = path.join(path.dirname(f.stateDir), "blocked-state");
    fs.writeFileSync(blocker, "file, not a state directory");
    const invoke = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", sourceCli,
      "supervisor", "run", "--workspace", f.workspaceRoot, ...args], {
      cwd: root, encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    const missing = invoke([]);
    expect(missing.status).toBe(1);
    expect(missing.stdout + missing.stderr).toContain("supervisor run requires explicit --state-dir");
    const supplied = invoke(["--state-dir", blocker]);
    expect(supplied.status).toBe(1);
    expect(supplied.stdout + supplied.stderr).toContain("ENOTDIR");
    expect(supplied.stdout + supplied.stderr).not.toContain("required option '--state-dir");
  });

  it("requires the exact entry, command pair, workspace, state and OS generation", () => {
    const f = fixture();
    const expected = { startIdentity: "generation-1", workspaceRoot: f.workspaceRoot, stateDir: f.stateDir, executable: exe, entry };
    expect(inspectSupervisorProcess(process.pid, expected, f.inspector).status).toBe("same");
    const arbitrary = { ...f.row, commandLine: `"${exe}" "${path.join(root, "package.json")}" supervisor run --workspace "${f.workspaceRoot}" --state-dir "${f.stateDir}"` };
    expect(inspectSupervisorProcess(process.pid, expected, { list: () => [arbitrary] }).status).toBe("reused");
    const missingState = { ...f.row, commandLine: `"${exe}" "${entry}" supervisor run --workspace "${f.workspaceRoot}"` };
    expect(inspectSupervisorProcess(process.pid, expected, { list: () => [missingState] }).status).toBe("unrelated");
    const duplicateState = { ...f.row, commandLine: `${f.row.commandLine} --state-dir "${f.stateDir}"` };
    expect(inspectSupervisorProcess(process.pid, expected, { list: () => [duplicateState] }).status).toBe("unrelated");
    expect(inspectSupervisorProcess(process.pid, { ...expected, startIdentity: "generation-2" }, f.inspector).status).toBe("reused");
    expect(inspectSupervisorProcess(process.pid, { startIdentity: "generation-2" }, f.inspector)).toMatchObject({
      status: "reused", reason: "start_identity_mismatch",
    });
  });

  it("does not present an old snapshot or invalid heartbeat as live READY", () => {
    const f = fixture();
    f.save();
    const fresh = observeSupervisorStatus(f.stateDir, f.workspaceRoot, { inspector: f.inspector });
    expect(fresh.state).toBe("running");
    expect(fresh.ok).toBe(true);
    fs.rmSync(path.join(f.stateDir, "supervisor", "supervisor.lock"));
    const noLock = observeSupervisorStatus(f.stateDir, f.workspaceRoot, { inspector: f.inspector });
    expect(noLock.state).toBe("unknown");
    expect(noLock.running).toBeNull();
    f.row.processStartIdentity = "generation-2";
    const reused = observeSupervisorStatus(f.stateDir, f.workspaceRoot, { inspector: f.inspector });
    expect(reused.state).toBe("stopped");
    expect(reused.processStatus).toBe("reused");
    expect(reused.processReason).toBe("start_identity_mismatch");
    f.row.processStartIdentity = "generation-1";
    f.save();
    f.snapshot.lastTickAt = new Date(Date.now() + 60_000).toISOString();
    f.save();
    const future = observeSupervisorStatus(f.stateDir, f.workspaceRoot, { inspector: f.inspector });
    expect(future.state).toBe("stale");
    expect(future.ok).toBe(false);
    f.snapshot.identity = "old-generation";
    f.save();
    const mismatched = observeSupervisorStatus(f.stateDir, f.workspaceRoot, { inspector: f.inspector });
    expect(mismatched.state).toBe("unknown");
  });

  it("normalizes only a missing legacy recovery log and refuses malformed history", () => {
    const f = fixture();
    const file = path.join(f.stateDir, "supervisor", "status.json");
    const legacy = { ...f.snapshot };
    delete (legacy as Partial<SupervisorSnapshot>).recoveryLog;
    fs.writeFileSync(file, JSON.stringify(legacy));
    expect(readSupervisorSnapshot(f.stateDir).snapshot?.recoveryLog).toEqual([]);
    fs.writeFileSync(file, JSON.stringify({ ...f.snapshot, recoveryLog: [{ at: 1 }] }));
    expect(readSupervisorSnapshot(f.stateDir).error).toBe("Invalid snapshot recovery log");
  });

  it("refuses to signal an untrusted or legacy process", async () => {
    const f = fixture();
    f.save();
    let signals = 0;
    f.lock.entry = path.join(root, "package.json");
    f.save();
    const result = await stopSupervisorProcess(f.stateDir, f.workspaceRoot, {
      inspector: f.inspector, signalProcess: () => { signals++; },
    });
    expect(result.stopped).toBe(false);
    expect(signals).toBe(0);
  });
});
