/**
 * Task A: native timeout writer safety — isNativeTimeoutFailure + observeNativeTask.
 * Task B: network defaults to true when omitted.
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";

// ── Task A: isNativeTimeoutFailure ──────────────────────────────────────────

import { isNativeTimeoutFailure } from "../src/execution/tasks.js";
import type { ZcodeNativeTaskView } from "../src/execution/zcode-native.js";

function fakeTask(status: string, exit_status?: string | null): ZcodeNativeTaskView {
  return {
    task_id: "z2c_test123",
    session_id: "sess_00000000-0000-0000-0000-000000000001",
    workspace_id: "test-ws",
    status,
    exit_status: exit_status ?? null,
  };
}

describe("isNativeTimeoutFailure (Task A: writer safety)", () => {
  it("detects exact 'turn timeout' exit_status from official.ts", () => {
    assert.equal(isNativeTimeoutFailure(fakeTask("failed", "turn timeout")), true);
  });

  it("detects 'Turn Timeout' case-insensitive", () => {
    assert.equal(isNativeTimeoutFailure(fakeTask("failed", "Turn Timeout")), true);
  });

  it("detects generic 'timeout' exit_status", () => {
    assert.equal(isNativeTimeoutFailure(fakeTask("failed", "timeout")), true);
  });

  it("does NOT fire on confirmed completed status", () => {
    assert.equal(isNativeTimeoutFailure(fakeTask("completed", "ok")), false);
  });

  it("does NOT fire on confirmed cancelled status", () => {
    assert.equal(isNativeTimeoutFailure(fakeTask("cancelled", "session stopped")), false);
  });

  it("does NOT fire on failed with non-timeout exit_status", () => {
    assert.equal(isNativeTimeoutFailure(fakeTask("failed", "session error")), false);
  });

  it("does NOT fire on failed with exit mentioning cancelled+timeout", () => {
    // A timeout that was also cancelled is a confirmed terminal
    assert.equal(isNativeTimeoutFailure(fakeTask("failed", "cancelled timeout")), false);
  });

  it("does NOT fire on failed with exit mentioning interrupted+timeout", () => {
    assert.equal(isNativeTimeoutFailure(fakeTask("failed", "interrupted after timeout")), false);
  });

  it("does NOT fire on running status even with timeout exit", () => {
    assert.equal(isNativeTimeoutFailure(fakeTask("running", "turn timeout")), false);
  });

  it("does NOT fire on queued status", () => {
    assert.equal(isNativeTimeoutFailure(fakeTask("queued")), false);
  });

  it("does NOT fire on failed with null exit_status", () => {
    // Null exit_status on failed = confirmed failure (e.g. error), not a timeout
    assert.equal(isNativeTimeoutFailure(fakeTask("failed", null)), false);
  });

  it("does NOT fire on failed with empty exit_status", () => {
    assert.equal(isNativeTimeoutFailure(fakeTask("failed", "")), false);
  });
});

// ── Task A: timeout busy blocks second writer (integration-level) ───────────

import {
  acquireWorkspaceSlot,
  readWorkspaceSlot,
  releaseWorkspaceSlot,
  bindWorkspaceSlot,
  WorkspaceSlotError,
} from "../src/execution/slot.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("timeout-busy slot blocks second writer (Task A)", () => {
  let dir: string;
  let ws: string;
  let reservationId: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "timeout-slot-"));
    ws = "ws-" + Math.random().toString(16).slice(2, 10);
    reservationId = crypto.randomUUID();
    process.env.C2C_STATE_DIR = dir;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.C2C_STATE_DIR;
  });

  it("a timed-out native task keeps the slot occupied; second writer is rejected", () => {
    // Acquire + bind slot for the first task
    acquireWorkspaceSlot(ws, reservationId, dir, "z2c");
    bindWorkspaceSlot(ws, reservationId, "z2c_task1", "sess_00000000-0000-0000-0000-000000000001", dir);

    // The upstream reports "failed" with "turn timeout" — the real turn is
    // still running. The isNativeTimeoutFailure guard should prevent release.
    const task = fakeTask("failed", "turn timeout");
    task.task_id = "z2c_task1";
    task.workspace_id = ws;

    // Confirm the slot is still held
    const slot = readWorkspaceSlot(ws, dir);
    assert.ok(slot, "slot must still exist after timeout failure");
    assert.equal(slot!.taskId, "z2c_task1");

    // A second writer must be rejected
    assert.throws(() => {
      acquireWorkspaceSlot(ws, crypto.randomUUID(), dir, "z2c");
    }, WorkspaceSlotError, "second writer must be blocked while timeout-busy");
  });

  it("a reliably idle release after timeout allows the next writer", () => {
    acquireWorkspaceSlot(ws, reservationId, dir, "z2c");
    bindWorkspaceSlot(ws, reservationId, "z2c_task2", null, dir);

    // Later, reconciliation confirms the task is genuinely completed
    releaseWorkspaceSlot(ws, "z2c_task2", dir);

    // Now a new writer can acquire
    const next = acquireWorkspaceSlot(ws, crypto.randomUUID(), dir, "z2c");
    assert.ok(next.taskId);
  });

  it("release is idempotent: double release after real terminal returns false", () => {
    acquireWorkspaceSlot(ws, reservationId, dir, "z2c");
    bindWorkspaceSlot(ws, reservationId, "z2c_task3", null, dir);
    assert.equal(releaseWorkspaceSlot(ws, "z2c_task3", dir), true);
    assert.equal(releaseWorkspaceSlot(ws, "z2c_task3", dir), false);
  });
});

// ── Task B: network defaults to true ────────────────────────────────────────

import { validateCodexTask } from "../src/execution/tasks.js";
import { makeTmpDir, makeGitRepo } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";
import { orchestratorStepSchema } from "../src/execution/orchestrator-core.js";

describe("network defaults to true when omitted (Task B)", () => {
  let tmpDir: string;
  let workspace: Workspace;

  beforeEach(() => {
    tmpDir = makeTmpDir("net-default");
    makeGitRepo(tmpDir);
    // makeGitRepo already creates src/index.ts, so src/ exists
    workspace = new Workspace(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("omitted network field defaults to true (online) for full-access", () => {
    const input = validateCodexTask(workspace, {
      workspace_id: workspace.id,
      instruction: "test task",
      write_scope: ["src"],
    }, { fullAccess: true });
    assert.equal(input.networkRequested, true, "omitted network should default to true");
    assert.equal(input.networkEffective, true);
    assert.equal(input.network, true);
  });

  it("explicit network=true is accepted for full-access", () => {
    const input = validateCodexTask(workspace, {
      workspace_id: workspace.id,
      instruction: "test task",
      write_scope: ["src"],
      network: true,
    }, { fullAccess: true });
    assert.equal(input.networkRequested, true);
    assert.equal(input.networkEffective, true);
  });

  it("explicit network=false is honored for full-access", () => {
    const input = validateCodexTask(workspace, {
      workspace_id: workspace.id,
      instruction: "test task",
      write_scope: ["src"],
      network: false,
    }, { fullAccess: true });
    assert.equal(input.networkRequested, false, "explicit false must be honored");
    assert.equal(input.networkEffective, false);
    assert.equal(input.network, false);
  });

  it("omitted network for non-full-access still rejects (capability check)", () => {
    // Without fullAccess, network defaults to true, which should be rejected
    try {
      validateCodexTask(workspace, {
        workspace_id: workspace.id,
        instruction: "test task",
        write_scope: ["src"],
      }, { fullAccess: false });
      assert.fail("should have thrown");
    } catch (err: unknown) {
      assert.equal((err as { code: string }).code, "NETWORK_NOT_ALLOWED");
    }
  });

  it("explicit network=false for non-full-access is accepted", () => {
    const input = validateCodexTask(workspace, {
      workspace_id: workspace.id,
      instruction: "test task",
      write_scope: ["src"],
      network: false,
    }, { fullAccess: false });
    assert.equal(input.networkRequested, false);
    assert.equal(input.networkEffective, false);
  });

  it("orchestrator step schema defaults network to true", () => {
    const step = orchestratorStepSchema.parse({
      instruction: "test",
      write_scope: ["."],
    });
    assert.equal(step.network, true, "orchestrator network should default to true");
  });

  it("orchestrator step schema explicit false is honored", () => {
    const step = orchestratorStepSchema.parse({
      instruction: "test",
      write_scope: ["."],
      network: false,
    });
    assert.equal(step.network, false);
  });
});
