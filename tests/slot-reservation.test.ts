import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireWorkspaceSlot,
  bindWorkspaceSlot,
  releaseWorkspaceSlot,
  reconcileWorkspaceSlot,
  readWorkspaceSlot,
  workspaceSlotFile,
} from "../src/execution/slot.js";

/** Regression coverage for the writer-reservation lifecycle (problems A/E). */
describe("writer slot reservation lifecycle (ghost-slot prevention)", () => {
  let dir: string;
  let ws: string;
  let reservationId: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "slot-"));
    ws = "ws-" + Math.random().toString(16).slice(2, 10);
    reservationId = crypto.randomUUID();
    process.env.C2C_STATE_DIR = dir;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.C2C_STATE_DIR;
  });

  const crypto = {
    randomUUID: () => {
      const b = require("node:crypto").randomBytes(16);
      const h = b.toString("hex");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    },
  };

  it("acquire → bind (null session) → terminal observation releases by native id", () => {
    acquireWorkspaceSlot(ws, reservationId, dir, "z2c");
    // Upstream accepted a task with NO session id yet (pre-session dispatch).
    const bound = bindWorkspaceSlot(ws, reservationId, "z2c_abc123", null, dir);
    assert.equal(bound.nativeTaskId, "z2c_abc123");
    assert.equal(bound.sessionId, undefined);
    // Terminal observation matches by nativeTaskId and releases.
    const released = releaseWorkspaceSlot(ws, bound.taskId, dir);
    assert.equal(released, true);
    assert.equal(readWorkspaceSlot(ws, dir), null);
  });

  it("dispatch rejection (no upstream task) releases the reservation for the next writer", () => {
    acquireWorkspaceSlot(ws, reservationId, dir, "z2c");
    // Upstream rejected → the reservation is released (Z2C idempotency makes
    // a retry safe; the reservation uuid was never registered upstream).
    const released = releaseWorkspaceSlot(ws, reservationId, dir);
    assert.equal(released, true);
    // The next writer can acquire immediately.
    const next = acquireWorkspaceSlot(ws, crypto.randomUUID(), dir, "z2c");
    assert.equal(next.taskId.length > 0, true);
  });

  it("double release is idempotent (second call returns false)", () => {
    acquireWorkspaceSlot(ws, reservationId, dir, "z2c");
    assert.equal(releaseWorkspaceSlot(ws, reservationId, dir), true);
    assert.equal(releaseWorkspaceSlot(ws, reservationId, dir), false);
  });

  it("a late bind after release does not resurrect a released slot", () => {
    acquireWorkspaceSlot(ws, reservationId, dir, "z2c");
    releaseWorkspaceSlot(ws, reservationId, dir);
    assert.throws(() => bindWorkspaceSlot(ws, reservationId, "z2c_late", "sess_" + crypto.randomUUID().replaceAll("-", ""), dir));
    assert.equal(readWorkspaceSlot(ws, dir), null);
  });

  it("reconcile ISOLATES an unbound z2c reservation (upstream state unknown → retained)", () => {
    acquireWorkspaceSlot(ws, reservationId, dir, "z2c");
    const result = reconcileWorkspaceSlot(ws, (taskId) => ({ workspaceId: ws, status: "completed" }), dir);
    assert.equal(result.reason, "unresolved");
    assert.equal(result.cleared, false, "pure reservations are isolated, never silently released");
    assert.ok(readWorkspaceSlot(ws, dir));
  });

  it("reconcile isolates BOUND z2c leases too (upstream state confirmed by observeNativeTask, not the codex registry)", () => {
    acquireWorkspaceSlot(ws, reservationId, dir, "z2c");
    bindWorkspaceSlot(ws, reservationId, "z2c_term1", "sess_" + crypto.randomUUID(), dir);
    const kept = reconcileWorkspaceSlot(ws, (taskId) => ({ workspaceId: ws, status: "running" }), dir);
    assert.equal(kept.cleared, false, "bound z2c lease must be isolated for upstream observation");
    assert.equal(kept.reason, "unresolved");
    assert.ok(readWorkspaceSlot(ws, dir));
  });

  it("restart recovery: lock survives process restart and is releasable by owner id", () => {
    acquireWorkspaceSlot(ws, reservationId, dir, "z2c");
    // Simulate a restart: a fresh process reads the same state dir.
    const relock = acquireWorkspaceSlot(ws, reservationId, dir, "z2c");
    assert.equal(relock.taskId, reservationId); // same owner re-acquires idempotently
    releaseWorkspaceSlot(ws, reservationId, dir);
    assert.equal(readWorkspaceSlot(ws, dir), null);
  });

  it("slot bound with null sessionId is releasable by nativeTaskId", () => {
    acquireWorkspaceSlot(ws, reservationId, dir, "z2c");
    const bound = bindWorkspaceSlot(ws, reservationId, "z2c_task99", null, dir);
    assert.equal(bound.nativeTaskId, "z2c_task99");
    assert.equal(bound.sessionId, undefined);
    assert.equal(releaseWorkspaceSlot(ws, "z2c_task99", dir), true);
    assert.equal(readWorkspaceSlot(ws, dir), null);
  });

  it("slot already bound with session cannot be rebound", () => {
    acquireWorkspaceSlot(ws, reservationId, dir, "z2c");
    const sid = "sess_" + crypto.randomUUID();
    bindWorkspaceSlot(ws, reservationId, "z2c_task100", sid, dir);
    assert.throws(() => bindWorkspaceSlot(ws, reservationId, "z2c_task101", null, dir));
  });
});
