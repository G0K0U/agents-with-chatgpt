import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  acquireWorkspaceSlot, bindWorkspaceSlot, readWorkspaceSlot, reconcileWorkspaceSlot,
  reconcileUnknownWorkspaceSlots, releaseWorkspaceSlot, WorkspaceSlotError,
} from "../src/execution/slot.js";
import { writeWorkspaceQueuePauseState } from "../src/execution/queue-state.js";

describe("G4 workspace writer slot", () => {
  let state: string;
  const workspace = "g4_workspace";
  beforeEach(() => { state = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-g4-slot-")); });
  afterEach(() => {
    const resolved = path.resolve(state);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("c2c-g4-slot-")) throw new Error("Unsafe fixture cleanup");
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  it.each(["codex", "gemini", "z2c"] as const)("%s acquisition and release use the workspace slot", provider => {
    const id = provider === "z2c" ? randomUUID() : "c2c_12345678";
    const slot = acquireWorkspaceSlot(workspace, id, state, provider);
    expect(acquireWorkspaceSlot(workspace, id, state, provider)).toEqual(slot);
    expect(() => acquireWorkspaceSlot(workspace, "c2c_87654321", state)).toThrow(WorkspaceSlotError);
    expect(releaseWorkspaceSlot(workspace, "c2c_87654321", state)).toBe(false);
    expect(releaseWorkspaceSlot(workspace, id, state)).toBe(true);
    expect(releaseWorkspaceSlot(workspace, id, state)).toBe(false);
  });

  it("binding replaces the reservation id in the same slot", () => {
    const reservation = acquireWorkspaceSlot(workspace, randomUUID(), state, "z2c");
    const bound = bindWorkspaceSlot(workspace, reservation.taskId, "z2c_task", "sess_" + randomUUID(), state);
    expect(readWorkspaceSlot(workspace, state)).toEqual(bound);
    expect(releaseWorkspaceSlot(workspace, reservation.taskId, state)).toBe(false);
    expect(releaseWorkspaceSlot(workspace, bound.taskId, state)).toBe(true);
  });

  it("local registry reconciliation retains native leases for upstream status lookup", () => {
    const reservation = acquireWorkspaceSlot(workspace, randomUUID(), state, "z2c");
    const bound = bindWorkspaceSlot(workspace, reservation.taskId, "z2c_task", "sess_" + randomUUID(), state);
    expect(reconcileWorkspaceSlot(workspace, () => null, state)).toEqual({ lock: bound, cleared: false, reason: "unresolved" });
    expect(reconcileUnknownWorkspaceSlots([], state)).toEqual({ scanned: 1, cleared: 0 });
  });

  it.each(["codex", "gemini"] as const)("%s registry reconciliation retains running tasks and releases terminal or missing tasks", provider => {
    acquireWorkspaceSlot(workspace, "c2c_12345678", state, provider);
    expect(reconcileWorkspaceSlot(workspace, () => ({ workspaceId: workspace, status: "running" }), state).cleared).toBe(false);
    expect(reconcileWorkspaceSlot(workspace, () => ({ workspaceId: workspace, status: "completed" }), state).cleared).toBe(true);
    acquireWorkspaceSlot(workspace, "c2c_12345678", state, provider);
    expect(reconcileWorkspaceSlot(workspace, () => null, state).cleared).toBe(true);
  });

  it.each(["codex", "gemini", "z2c"] as const)("pause blocks new %s acquisition and permits terminal release", provider => {
    const id = provider === "z2c" ? randomUUID() : "c2c_12345678";
    const held = acquireWorkspaceSlot(workspace, id, state, provider);
    writeWorkspaceQueuePauseState(workspace, true, state);
    expect(() => acquireWorkspaceSlot(workspace, "c2c_87654321", state, provider)).toThrow(/paused/);
    expect(readWorkspaceSlot(workspace, state)).toEqual(held);
    expect(releaseWorkspaceSlot(workspace, id, state)).toBe(true);
  });
});
