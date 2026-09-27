/**
 * F01 regressions: the trusted local operator verification registry.
 *
 *  - an ordinary workspace (not the bridge repo, not Engineering AI) resolves
 *    a registered profile for run_tests=true;
 *  - the record is stored in the C2C state dir, keyed by canonical workspace
 *    identity, and re-validated on every read;
 *  - tampered records fail closed (never execute);
 *  - shell-script executables and other unsafe shapes are rejected at
 *    registration;
 *  - a task cannot gain execution capability by mutating workspace files.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, cleanup, write, isolateStateDir } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";
import { CodexTaskManager } from "../src/execution/tasks.js";
import {
  OperatorVerificationError,
  listOperatorVerificationProfiles,
  readOperatorVerificationProfile,
  registerOperatorVerificationProfile,
  removeOperatorVerificationProfile,
  resolveVerificationProfile,
} from "../src/execution/operator-verification.js";
import { getStateDir } from "../src/config/paths.js";

let root: string;
let workspace: Workspace;
let stateDir: string;

beforeEach(() => {
  isolateStateDir();
  stateDir = getStateDir();
  root = makeTmpDir("operator-verify-ws");
  write(root, "package.json", JSON.stringify({ name: "ordinary-project", private: true }));
  write(root, "index.js", "console.log('hi');\n");
  write(root, "tests/smoke.test.js", "import { test } from 'node:test';\ntest('smoke', () => {});\n");
  workspace = new Workspace(root);
});

afterEach(() => {
  cleanup(root);
});

const nodeExecutable = process.execPath;

function baseInput(overrides: Partial<Parameters<typeof registerOperatorVerificationProfile>[0]> = {}) {
  return {
    workspaceRoot: root,
    id: "node-tests",
    executable: nodeExecutable,
    argv: ["--test", "tests/*.test.js"],
    cwd: "workspace" as const,
    timeoutMs: 120_000,
    sandbox: "workspaceWrite" as const,
    summaryKind: "generic" as const,
    ...overrides,
  };
}

describe("operator verification registry", () => {
  it("registers, stores outside the workspace, and resolves by canonical workspace identity", () => {
    const record = registerOperatorVerificationProfile(baseInput(), stateDir);
    expect(record.workspaceId).toBe(workspace.id);
    const file = path.join(stateDir, "verification-profiles", `${workspace.id}.json`);
    expect(fs.existsSync(file)).toBe(true);
    // Stored OUTSIDE the target repository.
    const relative = path.relative(root, file);
    expect(relative.startsWith("..") || path.isAbsolute(relative)).toBe(true);

    const resolved = resolveVerificationProfile(workspace, stateDir);
    expect(resolved).toMatchObject({
      id: "node-tests",
      workspaceId: workspace.id,
      executable: nodeExecutable,
      sandbox: "workspaceWrite",
      network: false,
    });
    expect(readOperatorVerificationProfile(workspace.id, stateDir).argv).toEqual(["--test", "tests/*.test.js"]);
    expect(listOperatorVerificationProfiles(stateDir)).toHaveLength(1);
  });

  it("returns null for an unregistered workspace (task fails closed with NO_VERIFICATION_PROFILE)", () => {
    expect(resolveVerificationProfile(workspace, stateDir)).toBeNull();
    expect(() => readOperatorVerificationProfile(workspace.id, stateDir))
      .toThrowError(OperatorVerificationError);
  });

  it("rejects shell-dependent executables and other unsafe shapes at registration", () => {
    for (const badExecutable of [
      path.join(root, "run-tests.cmd"),
      path.join(root, "run-tests.bat"),
      path.join(root, "run-tests.ps1"),
      "not a real file.exe",
    ]) {
      expect(() => registerOperatorVerificationProfile(baseInput({ executable: badExecutable }), stateDir))
        .toThrowError(/executable/i);
    }
    // Path traversal / argument injection shapes never reach disk.
    expect(() => registerOperatorVerificationProfile(baseInput({ timeoutMs: 10 }), stateDir))
      .toThrowError(/timeout/i);
    expect(() => registerOperatorVerificationProfile(baseInput({ argv: ["run {evil}"] }), stateDir))
      .toThrowError(/placeholder/i);
    expect(listOperatorVerificationProfiles(stateDir)).toHaveLength(0);
  });

  it("fails closed when the stored record is tampered with (task cannot escalate to execution)", () => {
    registerOperatorVerificationProfile(baseInput(), stateDir);
    const file = path.join(stateDir, "verification-profiles", `${workspace.id}.json`);
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    // A tampered executable and a tampered network flag must both be rejected
    // on read — never executed.
    fs.writeFileSync(file, JSON.stringify({ ...record, executable: path.join(root, "evil.cmd") }));
    expect(() => resolveVerificationProfile(workspace, stateDir)).toThrowError(OperatorVerificationError);
    fs.writeFileSync(file, JSON.stringify({ ...record, network: true }));
    expect(() => resolveVerificationProfile(workspace, stateDir)).toThrowError(OperatorVerificationError);
    fs.writeFileSync(file, "{ not json");
    expect(() => resolveVerificationProfile(workspace, stateDir)).toThrowError(OperatorVerificationError);
  });

  it("binds the record to its workspace: it never resolves for a different workspace", () => {
    registerOperatorVerificationProfile(baseInput(), stateDir);
    const other = makeTmpDir("operator-verify-other");
    try {
      write(other, "package.json", "{}");
      expect(resolveVerificationProfile(new Workspace(other), stateDir)).toBeNull();
    } finally {
      cleanup(other);
    }
  });

  it("remove drops the registration and reverts to the fail-closed default", () => {
    registerOperatorVerificationProfile(baseInput(), stateDir);
    expect(removeOperatorVerificationProfile(workspace.id, stateDir)).toBe(true);
    expect(removeOperatorVerificationProfile(workspace.id, stateDir)).toBe(false);
    expect(resolveVerificationProfile(workspace, stateDir)).toBeNull();
  });

  it("the task manager's default resolver consumes the operator registration", async () => {
    registerOperatorVerificationProfile(baseInput({
      executable: nodeExecutable,
      argv: ["--version"],
      cwd: "workspace",
      sandbox: "readOnly",
      summaryKind: "generic",
    }), stateDir);
    // No verificationProfileResolver injected: the production default chain
    // (operator registry → built-ins) must accept run_tests=true.
    let appServerStarts = 0;
    const manager = new CodexTaskManager(workspace, {
      stateDir,
      appServerFactory: () => {
        appServerStarts += 1;
        throw new Error("this test ends before any app server use");
      },
    });
    try {
      const submitted = manager.submit({
        workspace_id: workspace.id,
        instruction: "trivial task with verification",
        write_scope: ["tests"],
        run_tests: true,
      });
      // The submit path resolved the operator profile: the task was accepted
      // (it did NOT fail at submit with NO_VERIFICATION_PROFILE /
      // VERIFICATION_PROFILE_INVALID).
      expect(submitted.status).not.toBe("failed");
      expect(submitted.tests ?? "").not.toContain("verification not run");
      await manager.close();
      void appServerStarts;
    } catch (error) {
      await manager.close();
      throw error;
    }
  });

  it("a tampered profile turns run_tests=true into an explicit VERIFICATION_PROFILE_INVALID failure", async () => {
    registerOperatorVerificationProfile(baseInput(), stateDir);
    const file = path.join(stateDir, "verification-profiles", `${workspace.id}.json`);
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...record, argv: [{}, "injected"] }));
    const manager = new CodexTaskManager(workspace, {
      stateDir,
      appServerFactory: () => { throw new Error("must never start"); },
    });
    try {
      const submitted = manager.submit({
        workspace_id: workspace.id,
        instruction: "try to escalate",
        write_scope: ["tests"],
        run_tests: true,
      });
      expect(submitted.status).toBe("failed");
      expect(submitted.error?.code).toBe("VERIFICATION_PROFILE_INVALID");
      expect(submitted.tests).toBe("verification not run: local profile invalid");
    } finally {
      await manager.close();
    }
  });
});
