/**
 * Gemini on-demand lifecycle (G1–G5):
 *   - executable present + zero sessions → READY_ON_DEMAND, callable, never degraded
 *   - durable evidence: AUTH_REQUIRED / QUOTA_BLOCKED / FAILED only from real failed tasks
 *   - evidence survives backend restart (G5) without any startup canary (G4)
 *   - stale AGY conversation → discarded, fresh session carries the task (G2)
 *   - missing executable → explicit EXECUTABLE_MISSING
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import {
  AntigravityBackend,
  antigravityEvidenceReadiness,
  readAntigravityAttemptEvidence,
  type AntigravityAttemptEvidence,
} from "../src/execution/antigravity.js";
import type { BackendExecutionRequest } from "../src/execution/backend.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(), execSync: vi.fn(() => Buffer.from("1.2.3")) };
});

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(spawn).mockReset();
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    if (!path.basename(resolved).startsWith("c2c-gem-") || path.dirname(resolved) !== path.resolve(os.tmpdir())) {
      throw new Error("Unsafe fixture cleanup");
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-gem-"));
  roots.push(parent);
  const root = path.join(parent, "My Projects", "engineering-ai");
  fs.mkdirSync(root, { recursive: true });
  const backend = new AntigravityBackend({ executablePath: process.execPath, stateDir: path.join(parent, "state") });
  const request: BackendExecutionRequest = {
    taskId: "c2c_gem_fixture", workspaceId: "fixture", workspaceRoot: root,
    instruction: "Read the project name from pyproject.toml", writeScope: [root], writableRoots: [root],
    networkRequested: true, networkEffective: true, fullAccess: true, runTests: false,
    model: "gemini-3.8-flash-high", timeoutMs: 5000,
  };
  return { parent, backend, request };
}

function manualChild() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 0 });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
  return child;
}

function writeEvidence(stateDir: string, evidence: AntigravityAttemptEvidence): void {
  const file = path.join(stateDir, "providers", "antigravity", "last-attempt.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(evidence));
}

const STALE = "0cf0cffd-0000-4000-8000-000000000000";
const FRESH = "20e31154-0000-4000-8000-000000000000";

describe("Gemini on-demand status semantics (G3/G4/G5)", () => {
  it("executable found with zero sessions → READY_ON_DEMAND and callable; status never degrades on idleness", async () => {
    const { backend } = fixture();
    const status = await backend.getProviderStatus();
    expect(status).toMatchObject({ status: "AVAILABLE", readiness: "READY_ON_DEMAND", cliInstalled: true, providerReachable: true, activeSessionsCount: 0 });
  });

  it("missing executable → explicit EXECUTABLE_MISSING / UNAVAILABLE", async () => {
    const { parent } = fixture();
    const backend = new AntigravityBackend({ stateDir: path.join(parent, "state") });
    vi.stubEnv("LOCALAPPDATA", path.join(parent, "no-agy-here"));
    const status = await backend.getProviderStatus();
    expect(status).toMatchObject({ status: "UNAVAILABLE", readiness: "EXECUTABLE_MISSING", cliInstalled: false, providerReachable: false });
  });

  it("real failed auth task evidence → AUTH_REQUIRED; model evidence → QUOTA_BLOCKED; a later success clears it", async () => {
    const { parent, backend } = fixture();
    const stateDir = path.join(parent, "state");
    expect((await backend.getProviderStatus()).readiness).toBe("READY_ON_DEMAND");
    writeEvidence(stateDir, {
      schema: 1,
      lastAttempt: { at: new Date().toISOString(), taskId: "c2c_auth", status: "failed", reason: "AUTH_ERROR", exitCode: 1 },
      lastSuccessAt: null, lastAuthErrorAt: new Date().toISOString(), lastModelErrorAt: null,
    });
    expect(await backend.getProviderStatus()).toMatchObject({ status: "DEGRADED", readiness: "AUTH_REQUIRED", providerReachable: false });
    writeEvidence(stateDir, {
      schema: 1,
      lastAttempt: { at: new Date().toISOString(), taskId: "c2c_quota", status: "failed", reason: "MODEL_UNAVAILABLE", exitCode: 1 },
      lastSuccessAt: null, lastAuthErrorAt: null, lastModelErrorAt: new Date().toISOString(),
    });
    expect(await backend.getProviderStatus()).toMatchObject({ status: "DEGRADED", readiness: "QUOTA_BLOCKED", providerReachable: false });
    writeEvidence(stateDir, {
      schema: 1,
      lastAttempt: { at: new Date().toISOString(), taskId: "c2c_ok", status: "completed", reason: null, exitCode: 0 },
      lastSuccessAt: new Date().toISOString(), lastAuthErrorAt: null, lastModelErrorAt: null,
    });
    expect(await backend.getProviderStatus()).toMatchObject({ status: "AVAILABLE", readiness: "READY_ON_DEMAND", providerReachable: true });
  });

  it("evidence survives a backend restart (G5): a fresh instance reads the durable record without spawning (G4)", async () => {
    const { parent } = fixture();
    const stateDir = path.join(parent, "state");
    writeEvidence(stateDir, {
      schema: 1,
      lastAttempt: { at: new Date().toISOString(), taskId: "c2c_before_restart", status: "failed", reason: "AUTH_ERROR", exitCode: 1 },
      lastSuccessAt: null, lastAuthErrorAt: new Date().toISOString(), lastModelErrorAt: null,
    });
    const restarted = new AntigravityBackend({ executablePath: process.execPath, stateDir });
    const status = await restarted.getProviderStatus();
    expect(status).toMatchObject({ status: "DEGRADED", readiness: "AUTH_REQUIRED", providerReachable: false });
    expect(status.lastCanaryStatus?.taskId).toBe("c2c_before_restart");
    expect(vi.mocked(spawn).mock.calls.length).toBe(0);
  });

  it("a completed real task records success evidence that unblocks earlier failures", async () => {
    const { parent, backend, request } = fixture();
    const stateDir = path.join(parent, "state");
    writeEvidence(stateDir, {
      schema: 1,
      lastAttempt: { at: new Date().toISOString(), taskId: "c2c_auth", status: "failed", reason: "AUTH_ERROR", exitCode: 1 },
      lastSuccessAt: null, lastAuthErrorAt: new Date().toISOString(), lastModelErrorAt: null,
    });
    const child = manualChild();
    const pending = backend.execute(request);
    child.stdout.write(JSON.stringify({ type: "result", result: { status: "SUCCESS", response: "project name is engineering-ai", conversation_id: FRESH } }) + "\n");
    child.emit("close", 0);
    expect(await pending).toMatchObject({ status: "completed", providerSessionId: FRESH });
    const evidence = readAntigravityAttemptEvidence(stateDir);
    expect(evidence?.lastAttempt.status).toBe("completed");
    expect(evidence?.lastSuccessAt).toBeTruthy();
    expect((await backend.getProviderStatus()).readiness).toBe("READY_ON_DEMAND");
    expect(JSON.stringify(evidence)).not.toMatch(/token|secret|credential/i);
  });
});

describe("Gemini stale-session recovery (G2)", () => {
  it("dead conversation → discarded once, fresh session carries the task", async () => {
    const { backend, request } = fixture();
    const spawnedArgs: string[][] = [];
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(spawn).mockImplementation(((exe, args, options) => {
      spawnedArgs.push(args as string[]);
      const attempt = spawnedArgs.length;
      const script = [
        "const attempt = Number(process.argv[1]);",
        'if (attempt === 1) {',
        '  process.stderr.write("Error: failed to resume conversation ' + STALE + '");',
        '  process.exit(1);',
        '}',
        'process.stdout.write(JSON.stringify({type:"init", init:{conversation_id:"' + FRESH + '", tools:[]}})+"\\n");',
        'process.stdout.write(JSON.stringify({type:"result", result:{status:"SUCCESS", response:"recovered", conversation_id:"' + FRESH + '", model:"gemini-3.8-flash-high"}})+"\\n");',
      ].join("\n");
      return actual.spawn(process.execPath, ["-e", script, String(attempt)], options);
    }) as typeof spawn);
    vi.spyOn(backend as unknown as { terminateProcess: (pid: number) => void }, "terminateProcess").mockImplementation(() => {});
    const result = await backend.execute({ ...request, timeoutMs: 120_000, providerSessionId: STALE });
    // Attempt 1 resumed the stale conversation; attempt 2 started fresh.
    expect(spawnedArgs.length).toBe(2);
    expect(spawnedArgs[0]).toContain("--conversation");
    expect(spawnedArgs[0][spawnedArgs[0].indexOf("--conversation") + 1]).toBe(STALE);
    expect(spawnedArgs[1]).not.toContain("--conversation");
    expect(result).toMatchObject({ status: "completed", providerSessionId: FRESH, actualProvider: "antigravity" });
    expect(result.sessionRecovered).toBe(true);
  });

  it("pre-session failure without a supplied conversation is NOT retried (no hidden double-spend)", async () => {
    const { backend, request } = fixture();
    const child = manualChild();
    const pending = backend.execute(request);
    child.stderr.write("Error: failed to resume conversation whatever\n");
    child.emit("close", 1);
    const result = await pending;
    expect(result).toMatchObject({ status: "failed", error: { code: "ANTIGRAVITY_SESSION_START_FAILED" } });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("pure mapping: cancelled and timed-out attempts never block the lane", () => {
    const now = new Date().toISOString();
    expect(antigravityEvidenceReadiness({
      schema: 1,
      lastAttempt: { at: now, taskId: "t", status: "cancelled", reason: null, exitCode: null },
      lastSuccessAt: null, lastAuthErrorAt: null, lastModelErrorAt: null,
    })).toBeNull();
    expect(antigravityEvidenceReadiness({
      schema: 1,
      lastAttempt: { at: now, taskId: "t", status: "timed_out", reason: "CLI_EXIT_UNCLASSIFIED", exitCode: null },
      lastSuccessAt: null, lastAuthErrorAt: null, lastModelErrorAt: null,
    })).toBeNull();
  });
});
