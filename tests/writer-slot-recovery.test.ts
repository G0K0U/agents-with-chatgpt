import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CodexTaskManager } from "../src/execution/tasks.js";
import { ZcodeNativeError, nativeRequestFingerprint, type SubmitNativeInput, type ZcodeNativeTaskView } from "../src/execution/zcode-native.js";
import { acquireWorkspaceSlot, readWorkspaceSlot, workspaceSlotFile } from "../src/execution/slot.js";
import { Workspace } from "../src/workspace/manager.js";

/**
 * Bounded, fail-closed recovery for unresolved z2c writer reservations.
 *
 * A dispatch whose response was lost keeps the reservation (fail closed) but
 * records durable correlation evidence (idempotency key + fingerprint) BEFORE
 * the request leaves. Reconciliation then resolves the outcome by OBSERVATION
 * only — key lookup / queue-empty proof — and never re-submits.
 */
type Behavior = "ok" | "lost-after-store" | "lost-before-store" | "unreachable-after-dispatch";

class RecoveryFakeNative {
  behavior: Behavior = "ok";
  tasks = new Map<string, ZcodeNativeTaskView>();
  byKey = new Map<string, ZcodeNativeTaskView>();
  lane = { provider_healthy: true, provider_status: "healthy", active_task: null as string | null, queued_task_count: 0, paused: false };
  observationDown = false;
  submitCalls = 0;

  private admit(input: SubmitNativeInput): ZcodeNativeTaskView {
    const view: ZcodeNativeTaskView = {
      workspace_id: input.workspace_id,
      task_id: "z2c_" + randomUUID().slice(0, 12),
      session_id: "sess_" + randomUUID(),
      status: "running",
    };
    this.tasks.set(view.task_id, view);
    if (input.idempotency_key) this.byKey.set(input.idempotency_key, view);
    this.lane.active_task = view.task_id;
    return view;
  }

  async submitTask(input: SubmitNativeInput, beforeDispatch?: () => void): Promise<ZcodeNativeTaskView> {
    this.submitCalls++;
    beforeDispatch?.();
    if (this.behavior === "lost-before-store" || this.behavior === "unreachable-after-dispatch") {
      throw new ZcodeNativeError("ZCODE_NATIVE_OUTCOME_UNKNOWN", "Mutation dispatch outcome unknown");
    }
    const view = this.admit(input);
    if (this.behavior === "lost-after-store") {
      throw new ZcodeNativeError("ZCODE_NATIVE_OUTCOME_UNKNOWN", "Mutation dispatch outcome unknown");
    }
    return { ...view };
  }
  async resumeSession(req: { workspace_id: string; session_id: string; instruction: string }, beforeDispatch?: () => void): Promise<ZcodeNativeTaskView> {
    return this.submitTask({ workspace_id: req.workspace_id, instruction: req.instruction }, beforeDispatch);
  }
  async getTask(req: { workspace_id: string; task_id: string }): Promise<ZcodeNativeTaskView> {
    const view = this.tasks.get(req.task_id);
    if (!view) throw new ZcodeNativeError("ZCODE_NATIVE_UPSTREAM", "missing");
    return { ...view };
  }
  async cancelTask(req: { workspace_id: string; task_id: string }): Promise<ZcodeNativeTaskView> {
    const view = this.tasks.get(req.task_id)!;
    view.status = "cancelled";
    this.lane.active_task = null;
    return { ...view };
  }
  async executionOutput(req: { workspace_id: string; task_id: string; output_id: string }, observeTask?: (t: ZcodeNativeTaskView) => void): Promise<{ output_id: string; task_id: string; workspace_id: string; session_id: string | null; text: string }> {
    observeTask?.({ ...this.tasks.get(req.task_id)! });
    return { ...req, session_id: this.tasks.get(req.task_id)!.session_id, text: "fixture" };
  }
  async resolveKeyedTask(req: { workspace_id: string; idempotency_key: string }, expectedFingerprint?: string): Promise<ZcodeNativeTaskView | null> {
    if (this.observationDown) throw new ZcodeNativeError("ZCODE_NATIVE_UNAVAILABLE", "Z2C semantic service unreachable");
    const view = this.byKey.get(req.idempotency_key);
    if (!view) return null;
    return { ...view, idempotency: { protocol: "workspace-task-v1", key: req.idempotency_key, request_fingerprint: expectedFingerprint ?? "any", replayed: true } };
  }
  async taskLaneStatus(): Promise<{ provider_healthy: boolean; provider_status: string; active_task: string | null; queued_task_count: number; paused: boolean }> {
    if (this.observationDown) throw new ZcodeNativeError("ZCODE_NATIVE_UNAVAILABLE", "Z2C semantic service unreachable");
    return { ...this.lane };
  }
  async projectWorkspace(workspaceId: string): Promise<{ nativeWorkspaceId: string; canonicalPath: string }> {
    // Identity mapping: the fake upstream accepts the same ids it echoes.
    return { nativeWorkspaceId: workspaceId, canonicalPath: "fixture-root" };
  }
}

describe("unresolved z2c writer reservation recovery (fail closed, observation only)", () => {
  let root: string;
  let state: string;
  let workspace: Workspace;
  let native: RecoveryFakeNative;
  const managers: CodexTaskManager[] = [];

  function boot(): CodexTaskManager {
    const manager = new CodexTaskManager(workspace, {
      stateDir: state,
      nativeClient: native as never,
      nativeReservationRecoveryMs: 1000,
    });
    managers.push(manager);
    return manager;
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-slot-recovery-"));
    state = path.join(root, "state");
    const work = path.join(root, "workspace");
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, "fixture.txt"), "preserve\n");
    workspace = new Workspace(work);
    native = new RecoveryFakeNative();
  });

  afterEach(async () => {
    for (const entry of managers.splice(0)) await entry.close();
    const resolved = path.resolve(root);
    assert.ok(path.basename(resolved).startsWith("c2c-slot-recovery-"), "unsafe cleanup");
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  const input = (): SubmitNativeInput => ({ workspace_id: workspace.id, instruction: "probe", write_scope: "workspace" });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (const status of ["failed", "timed_out", "cancelled", "completed"]) {
    it(`bound native ${status} clears and repeated reconciliation is idempotent`, async () => {
      const manager = boot();
      const task = await manager.submitNative(input());
      // "turn timeout" on failed is deliberately NOT used here: the
      // isNativeTimeoutFailure guard keeps the slot occupied for that case
      // (see timeout-writer-and-network-default.test.ts). This suite proves
      // reliably-terminal failures clear the slot.
      Object.assign(native.tasks.get(task.task_id)!, { status, exit_status: status === "failed" ? "session error" : "turn timeout" });
      native.lane.active_task = null;
      await manager.reconcileNativeSlot();
      assert.equal(manager.getQueueState().activeWriter, null);
      assert.deepEqual(await manager.reconcileNativeSlot(), { status: "none", released: false });
    });

    it(`lost response with authoritative ${status} releases the UUID reservation without a session bind`, async () => {
      native.behavior = "lost-after-store";
      const manager = boot();
      await assert.rejects(() => manager.submitNative(input()));
      const task = [...native.tasks.values()][0]!;
      Object.assign(task, { status, session_id: "unavailable", exit_status: status === "failed" ? "session error" : "turn timeout" });
      native.lane.active_task = null;
      await sleep(1100);
      await Promise.all([manager.reconcileNativeSlot(), manager.reconcileNativeSlot()]);
      assert.equal(readWorkspaceSlot(workspace.id, state), null);
      assert.equal(native.submitCalls, 1);
      assert.deepEqual(await manager.reconcileNativeSlot(), { status: "none", released: false });
    });
  }

  it("a legacy native task ID without session metadata is queried directly, preserving a running writer", async () => {
    const task = await native.submitTask(input());
    acquireWorkspaceSlot(workspace.id, task.task_id, state, "z2c");
    const manager = boot();
    assert.equal((await manager.reconcileNativeSlot()).status, "running");
    assert.equal(readWorkspaceSlot(workspace.id, state)?.taskId, task.task_id);
    native.tasks.get(task.task_id)!.status = "failed";
    await manager.reconcileNativeSlot();
    assert.equal(readWorkspaceSlot(workspace.id, state), null);
  });

  it("a late terminal response resolves its UUID reservation through the exact key proof", async () => {
    const submit = native.submitTask.bind(native);
    native.submitTask = async (request, hook) => {
      const task = await submit(request, hook);
      return { ...task, status: "failed", session_id: "unavailable", exit_status: "session error",
        idempotency: { protocol: "workspace-task-v1", key: request.idempotency_key!,
          request_fingerprint: nativeRequestFingerprint(request), replayed: false } };
    };
    const manager = boot();
    assert.equal((await manager.submitNative(input())).status, "failed");
    assert.equal(readWorkspaceSlot(workspace.id, state), null);
  });

  it("a terminal status read clears an unresolved reservation only with its exact correlation proof", async () => {
    native.behavior = "lost-after-store";
    const manager = boot();
    await assert.rejects(() => manager.submitNative(input()));
    const slot = readWorkspaceSlot(workspace.id, state)!;
    const task = [...native.tasks.values()][0]!;
    task.status = "failed";
    task.idempotency = { protocol: "workspace-task-v1", key: slot.idempotencyKey!,
      request_fingerprint: "0".repeat(64), replayed: false };
    await manager.getNative({ workspace_id: workspace.id, task_id: task.task_id });
    assert.equal(readWorkspaceSlot(workspace.id, state)?.taskId, slot.taskId);
    task.idempotency.request_fingerprint = slot.requestFingerprint!;
    await manager.getNative({ workspace_id: workspace.id, task_id: task.task_id });
    assert.equal(readWorkspaceSlot(workspace.id, state), null);
  });

  it("startup recovers a lost terminal response without manual slot cleanup", async () => {
    native.behavior = "lost-after-store";
    const manager = boot();
    await assert.rejects(() => manager.submitNative(input()));
    await manager.close();
    [...native.tasks.values()][0]!.status = "failed";
    native.lane.active_task = null;
    await sleep(1100);
    const revived = boot();
    await revived.reconcileNativeSlot();
    assert.equal(revived.getQueueState().activeWriter, null);
  });

  it("a failure BEFORE dispatch releases the reservation immediately", async () => {
    native.behavior = "unreachable-after-dispatch";
    // Queue pause check throws before the hook: the request never left.
    const manager = boot();
    manager.setQueuePaused(true);
    native.submitCalls = 0;
    await assert.rejects(() => manager.submitNative(input()), /paused/);
    assert.equal(native.submitCalls, 0, "nothing was dispatched");
    assert.equal(fs.existsSync(workspaceSlotFile(workspace.id, state)), false, "reservation released at once");
  });

  it("a lost response with an EXISTING upstream task re-binds the slot after the window (no re-submit)", async () => {
    native.behavior = "lost-after-store";
    const manager = boot();
    await assert.rejects(() => manager.submitNative(input()), /outcome unknown/i);
    // The reservation is retained with correlation evidence.
    const slot = readWorkspaceSlot(workspace.id, state);
    assert.ok(slot, "reservation retained (fail closed)");
    assert.ok(slot!.idempotencyKey, "idempotency key recorded");
    assert.ok(slot!.dispatchedAt, "dispatch timestamp recorded");
    // Recovery by observation: the key resolves upstream → re-bind.
    await sleep(1100);
    const result = await manager.reconcileNativeSlot();
    assert.equal(result.released, false);
    const bound = readWorkspaceSlot(workspace.id, state);
    assert.equal(bound?.nativeTaskId, [...native.tasks.keys()][0], "slot re-bound to the recovered native task");
    assert.equal(native.submitCalls, 1, "never double-dispatched");
  });

  it("a lost response with NO upstream task releases after the bounded window (key unbound + empty lane)", async () => {
    native.behavior = "lost-before-store";
    const manager = boot();
    await assert.rejects(() => manager.submitNative(input()), /outcome unknown/i);
    // Retained (fail closed) immediately after the loss — checked directly
    // before the bounded window can elapse.
    assert.ok(readWorkspaceSlot(workspace.id, state), "reservation retained right after the loss");
    await sleep(1100);
    // The 1s watch poller may release before the explicit call; either path is
    // the same bounded recovery. The durable proof is the slot file's absence.
    const result = await manager.reconcileNativeSlot();
    assert.ok(["released_key_unbound", "none"].includes(result.status), `unexpected status ${result.status}`);
    for (let i = 0; i < 50 && fs.existsSync(workspaceSlotFile(workspace.id, state)); i++) await sleep(50);
    assert.equal(fs.existsSync(workspaceSlotFile(workspace.id, state)), false, "writer slot restored to null");
    assert.equal(native.submitCalls, 1, "never re-submitted");
  });

  it("outcome TRULY unknown (upstream observation unreachable) keeps the reservation fail closed", async () => {
    native.behavior = "lost-before-store";
    native.observationDown = true;
    const manager = boot();
    await assert.rejects(() => manager.submitNative(input()), /outcome unknown/i);
    await sleep(1100);
    const result = await manager.reconcileNativeSlot();
    assert.deepEqual(result, { status: "unresolved", released: false });
    assert.ok(readWorkspaceSlot(workspace.id, state), "reservation kept: outcome cannot be proven");
  });

  it("a non-empty upstream lane never releases a key-unbound reservation (defense in depth)", async () => {
    native.behavior = "lost-before-store";
    const manager = boot();
    await assert.rejects(() => manager.submitNative(input()), /outcome unknown/i);
    native.lane.active_task = "z2c_someone_else_running";
    await sleep(1100);
    const result = await manager.reconcileNativeSlot();
    assert.deepEqual(result, { status: "unresolved", released: false });
    assert.ok(readWorkspaceSlot(workspace.id, state));
  });

  it("a LEGACY reservation without evidence releases only via the queue-empty proof after the window", async () => {
    const manager = boot();
    void manager;
    // Forge the pre-evidence ghost: acquired long ago, no key/fingerprint.
    const file = workspaceSlotFile(workspace.id, state);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const ghost = {
      version: 1, workspaceId: workspace.id, provider: "z2c",
      taskId: randomUUID(), pid: process.pid,
      acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    };
    fs.writeFileSync(file, JSON.stringify(ghost), { mode: 0o600 });
    native.lane.active_task = null;
    native.lane.queued_task_count = 0;
    // Healthy upstream + empty queue after the window → safe release. The
    // fresh manager's startup reconciliation (or its 1s poller) performs it.
    const fresh = boot();
    for (let i = 0; i < 50 && fs.existsSync(file); i++) await sleep(50);
    const result = await fresh.reconcileNativeSlot();
    assert.ok(["released_queue_drained", "none"].includes(result.status), `unexpected status ${result.status}`);
    assert.equal(fs.existsSync(file), false);
    // An unhealthy or busy upstream would have kept it (covered above).
  });

  it("restart recovery: the reservation and its evidence survive a fresh manager process", async () => {
    native.behavior = "lost-after-store";
    const manager = boot();
    await assert.rejects(() => manager.submitNative(input()), /outcome unknown/i);
    await manager.close();
    managers.pop();
    await sleep(1100);
    // A fresh process over the same state dir recovers by observation.
    const revived = boot();
    const result = await revived.reconcileNativeSlot();
    assert.equal(result.released, false); // task exists upstream → bound, not released
    const bound = readWorkspaceSlot(workspace.id, state);
    assert.equal(bound?.nativeTaskId, [...native.tasks.keys()][0]);
    assert.equal(native.submitCalls, 1, "still never double-dispatched");
  });

  it("the dispatch evidence records a fingerprint matching the keyed upstream contract", async () => {
    const manager = boot();
    await manager.submitNative(input());
    const slot = readWorkspaceSlot(workspace.id, state);
    assert.ok(slot?.idempotencyKey && slot?.requestFingerprint);
    const keyed: SubmitNativeInput = { ...input(), idempotency_key: slot!.idempotencyKey! };
    assert.equal(slot!.requestFingerprint, nativeRequestFingerprint(keyed));
  });

  it("an idempotency conflict converges only when the authoritative lane is empty", async () => {
    native.behavior = "lost-before-store";
    native.resolveKeyedTask = async () => {
      throw new ZcodeNativeError("ZCODE_NATIVE_UPSTREAM", "conflicting fingerprint", "IDEMPOTENCY_INVALID");
    };
    const manager = boot();
    await assert.rejects(() => manager.submitNative(input()));
    native.lane.active_task = "z2c_other";
    await sleep(1100);
    assert.equal((await manager.reconcileNativeSlot()).released, false);
    assert.ok(readWorkspaceSlot(workspace.id, state));
    native.lane.active_task = null;
    await manager.reconcileNativeSlot();
    assert.equal(readWorkspaceSlot(workspace.id, state), null);
    assert.equal(native.submitCalls, 1);
  });

  it("a projection failure after reservation never leaks a writer", async () => {
    native.projectWorkspace = async () => { throw new Error("projection unavailable"); };
    const manager = boot();
    await assert.rejects(() => manager.submitNative(input()), /projection unavailable/);
    assert.equal(readWorkspaceSlot(workspace.id, state), null);
    assert.equal(native.submitCalls, 0);
  });
});
