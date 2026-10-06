import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  CodexTaskManager,
  isSessionIdleEvidence,
} from "../src/execution/tasks.js";
import {
  ZcodeNativeError,
  type SubmitNativeInput,
  type ZcodeNativeTaskView,
} from "../src/execution/zcode-native.js";
import {
  acquireWorkspaceSlot,
  bindWorkspaceSlot,
  WorkspaceSlotError,
  readWorkspaceSlot,
  workspaceSlotFile,
} from "../src/execution/slot.js";
import { listExecutionOutputs, readExecutionOutput } from "../src/execution/output.js";
import { Workspace } from "../src/workspace/manager.js";

/**
 * Timeout writer recovery close-loop (regression for the busy_timeout hold).
 *
 * A Z2C task whose provider waiter timed out freezes as status=failed with a
 * "turn timeout" exit_status while the REAL runtime turn keeps running
 (historical proof: z2c_8dc37c61087753e74e kept mutating for minutes past
 * its 15-minute timeout). The task snapshot never updates again, so polling
 * get_task alone can never close the loop. Recovery must come from the
 * EXACT bound session's own runtime observation: a genuine "idle" from the
 * runtime releases the writer exactly once (capturing the final visible
 * output when the upstream exposed one); busy/unknown/empty status, a
 * vanished session, a disconnected observation lane, or a missing adapter
 * all keep the slot (fail closed). Queue-empty is NEVER sufficient, and
 * there is no TTL: no guess ever releases a timeout-held writer.
 */

interface FakeSessionEntry {
  status: string;
  present: boolean;
}

class TimeoutRecoveryFakeNative {
  tasks = new Map<string, ZcodeNativeTaskView>();
  sessions = new Map<string, FakeSessionEntry>();
  lane = { provider_healthy: true, provider_status: "healthy", active_task: null as string | null, queued_task_count: 0, paused: false };
  observationDown = false;
  adapterInstalled = true;
  sessionProbeCalls: Array<{ workspace_id: string; session_id: string }> = [];
  outputCalls: Array<{ task_id: string; output_id: string }> = [];
  outputText = "final visible summary of the recovered turn";
  outputFails = false;
  submitCalls = 0;

  admit(input: SubmitNativeInput): ZcodeNativeTaskView {
    const view: ZcodeNativeTaskView = {
      workspace_id: input.workspace_id,
      task_id: "z2c_" + randomUUID().replaceAll("-", "").slice(0, 18),
      session_id: "sess_" + randomUUID(),
      status: "running",
    };
    this.tasks.set(view.task_id, view);
    this.sessions.set(view.session_id!, { status: "running", present: true });
    this.lane.active_task = view.task_id;
    return view;
  }

  async submitTask(input: SubmitNativeInput, beforeDispatch?: () => void): Promise<ZcodeNativeTaskView> {
    this.submitCalls++;
    beforeDispatch?.();
    return { ...this.admit(input) };
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
    this.outputCalls.push({ task_id: req.task_id, output_id: req.output_id });
    if (this.outputFails) throw new ZcodeNativeError("ZCODE_NATIVE_UPSTREAM", "output read failed");
    const view = this.tasks.get(req.task_id)!;
    observeTask?.({ ...view });
    return { output_id: req.output_id, task_id: req.task_id, workspace_id: req.workspace_id, session_id: view.session_id ?? null, text: this.outputText };
  }
  async resolveKeyedTask(): Promise<null> {
    return null;
  }
  async taskLaneStatus(): Promise<{ provider_healthy: boolean; provider_status: string; active_task: string | null; queued_task_count: number; paused: boolean }> {
    return { ...this.lane };
  }
  async projectWorkspace(workspaceId: string): Promise<{ nativeWorkspaceId: string; canonicalPath: string }> {
    return { nativeWorkspaceId: workspaceId, canonicalPath: "fixture-root" };
  }
  /**
   * The minimal session-runtime observation adapter under test: the runtime's
   * own per-session status, relayed through the exact-session discovery
   * entry. Observation failures throw; a vanished session is unknown, never
   * idle; an empty status is unknown, never idle.
   */
  async sessionRuntimeStatus(input: { workspace_id: string; session_id: string }): Promise<{
    session_id: string;
    workspace_id: string;
    runtime_status: string | null;
    locally_owned: boolean;
  }> {
    if (!this.adapterInstalled) {
      throw new Error("sessionRuntimeStatus is not a function on this client");
    }
    if (this.observationDown) {
      throw new ZcodeNativeError("ZCODE_NATIVE_UNAVAILABLE", "Z2C semantic service unreachable");
    }
    this.sessionProbeCalls.push({ workspace_id: input.workspace_id, session_id: input.session_id });
    const entry = this.sessions.get(input.session_id);
    if (!entry || !entry.present) {
      throw new ZcodeNativeError("ZCODE_NATIVE_UPSTREAM", "session not present in native discovery");
    }
    return {
      session_id: input.session_id,
      workspace_id: input.workspace_id,
      runtime_status: entry.status === "" ? null : entry.status,
      locally_owned: true,
    };
  }
}

describe("timeout writer recovery close-loop (exact-session idle evidence)", () => {
  let root: string;
  let state: string;
  let workspace: Workspace;
  let native: TimeoutRecoveryFakeNative;
  const managers: CodexTaskManager[] = [];

  async function boot(): Promise<CodexTaskManager> {
    const manager = new CodexTaskManager(workspace, {
      stateDir: state,
      nativeClient: native as never,
    });
    managers.push(manager);
    // Drain the constructor's in-flight startup reconciliation so every later
    // explicit reconcile observes fresh state instead of joining that flight.
    await manager.reconcileNativeSlot().catch(() => undefined);
    return manager;
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-timeout-recovery-"));
    state = path.join(root, "state");
    const work = path.join(root, "workspace");
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, "fixture.txt"), "preserve\n");
    workspace = new Workspace(work);
    native = new TimeoutRecoveryFakeNative();
  });

  afterEach(async () => {
    for (const entry of managers.splice(0)) await entry.close();
    const resolved = path.resolve(root);
    assert.ok(path.basename(resolved).startsWith("c2c-timeout-recovery-"), "unsafe cleanup");
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  const input = (): SubmitNativeInput => ({ workspace_id: workspace.id, instruction: "probe", write_scope: "workspace" });

  /** Submit through the manager, then freeze the upstream task as timeout-failed. */
  async function holdTimeoutWriter(): Promise<ZcodeNativeTaskView> {
    const manager = managers[managers.length - 1]!;
    const submitted = await manager.submitNative(input());
    const view = native.tasks.get(submitted.task_id)!;
    view.status = "failed";
    view.exit_status = "turn timeout";
    view.output_id = "z2co_" + randomUUID().replaceAll("-", "").slice(0, 16);
    // The provider lane drains — queue-empty alone must NOT release anything.
    native.lane.active_task = null;
    return view;
  }

  it("isSessionIdleEvidence accepts only the runtime's exact idle value", () => {
    assert.equal(isSessionIdleEvidence("idle"), true);
    for (const notIdle of ["running", "pending", "queued", "error", "unknown", "IDLE", " idle", "idle ", "", null, undefined]) {
      assert.equal(isSessionIdleEvidence(notIdle), false, `status ${String(notIdle)} must not prove idle`);
    }
  });

  it("a frozen timeout-failed task keeps the writer through repeated reconciles even with an empty lane", async () => {
    const manager = await boot();
    const task = await holdTimeoutWriter();
    for (let i = 0; i < 3; i++) {
      const result = await manager.reconcileNativeSlot();
      assert.equal(result.released, false, `reconcile ${i} must not release on a frozen failed snapshot`);
      assert.equal(result.status, "busy_timeout");
    }
    assert.ok(readWorkspaceSlot(workspace.id, state), "writer slot retained");
    assert.equal(manager.getQueueState().activeWriter?.status, "busy_timeout");
    assert.equal(native.lane.active_task, null, "lane is empty: queue-empty must not be sufficient");
    assert.throws(() => acquireWorkspaceSlot(workspace.id, randomUUID(), state, "z2c"), WorkspaceSlotError,
      "a second writer must stay blocked while the session may still be running");
    for (const call of native.sessionProbeCalls) {
      assert.equal(call.session_id, task.session_id, "probes only ever target the exact bound session");
    }
    assert.equal(native.tasks.get(task.task_id)!.status, "failed");
  });

  it("a genuine session idle releases the writer exactly once and captures the final visible output", async () => {
    const manager = await boot();
    const task = await holdTimeoutWriter();
    native.sessions.get(task.session_id!)!.status = "idle";
    const result = await manager.reconcileNativeSlot();
    assert.equal(result.released, true, "genuine idle must release the writer");
    assert.equal(result.status, "released_timeout_idle");
    assert.equal(readWorkspaceSlot(workspace.id, state), null, "writer slot released");
    assert.equal(native.outputCalls.length, 1, "final visible output fetched once from the upstream");
    assert.equal(native.outputCalls[0]!.task_id, task.task_id);
    const saved = listExecutionOutputs(workspace.id, 20, state).find((entry) => entry.taskId === task.task_id);
    assert.ok(saved, "captured output persisted for audit");
    const body = readExecutionOutput(workspace.id, saved!.id, state);
    assert.equal(body.ok, true);
    assert.equal(body.ok && body.text.includes(native.outputText), true, "captured text is the upstream's final output");
    // The release is final and idempotent: later reconciles see no slot at all.
    assert.deepEqual(await manager.reconcileNativeSlot(), { status: "none", released: false });
    assert.equal(native.outputCalls.length, 1, "no repeated output capture after release");
    const next = acquireWorkspaceSlot(workspace.id, randomUUID(), state, "z2c");
    assert.ok(next.taskId, "the next writer can acquire the workspace");
  });

  it("release proceeds even when the upstream exposed no output_id", async () => {
    const manager = await boot();
    const task = await holdTimeoutWriter();
    delete task.output_id;
    native.sessions.get(task.session_id!)!.status = "idle";
    const result = await manager.reconcileNativeSlot();
    assert.equal(result.released, true);
    assert.equal(readWorkspaceSlot(workspace.id, state), null);
    assert.equal(native.outputCalls.length, 0, "no output probe without an upstream output_id");
  });

  it("an output capture failure does not block the single release", async () => {
    const manager = await boot();
    const task = await holdTimeoutWriter();
    native.outputFails = true;
    native.sessions.get(task.session_id!)!.status = "idle";
    const result = await manager.reconcileNativeSlot();
    assert.equal(result.released, true, "writer safety wins over best-effort capture");
    assert.equal(readWorkspaceSlot(workspace.id, state), null);
    assert.equal(native.outputCalls.length, 1);
  });

  it("a disconnected observation lane keeps the writer; recovery resumes when the lane returns", async () => {
    const manager = await boot();
    const task = await holdTimeoutWriter();
    native.observationDown = true;
    let result = await manager.reconcileNativeSlot();
    assert.equal(result.released, false);
    assert.equal(result.status, "busy_timeout", "unknown observation must not release");
    assert.ok(readWorkspaceSlot(workspace.id, state));
    // The lane comes back and the session meanwhile finished its real turn.
    native.observationDown = false;
    native.sessions.get(task.session_id!)!.status = "idle";
    result = await manager.reconcileNativeSlot();
    assert.equal(result.released, true);
    assert.equal(readWorkspaceSlot(workspace.id, state), null);
  });

  it("a session that vanished from discovery is unknown, never idle: hold", async () => {
    const manager = await boot();
    const task = await holdTimeoutWriter();
    native.sessions.delete(task.session_id!);
    const result = await manager.reconcileNativeSlot();
    assert.deepEqual(result, { status: "busy_timeout", released: false });
    assert.ok(readWorkspaceSlot(workspace.id, state), "a missing session proves nothing");
  });

  for (const status of ["running", "pending", "queued", "error", "unknown", ""]) {
    it(`session runtime status ${JSON.stringify(status)} never releases the timeout-held writer`, async () => {
      const manager = await boot();
      const task = await holdTimeoutWriter();
      native.sessions.get(task.session_id!)!.status = status;
      const result = await manager.reconcileNativeSlot();
      assert.equal(result.released, false, `status ${JSON.stringify(status)} is not idle evidence`);
      assert.equal(result.status, "busy_timeout");
      assert.ok(readWorkspaceSlot(workspace.id, state));
    });
  }

  it("restart mid-hold: a fresh manager recovers by itself without re-dispatching", async () => {
    const manager = await boot();
    const task = await holdTimeoutWriter();
    await manager.close();
    managers.pop();
    assert.ok(readWorkspaceSlot(workspace.id, state), "the durable hold survives the restart");
    // The session finished while the bridge was down.
    native.sessions.get(task.session_id!)!.status = "idle";
    const revived = await boot();
    // The constructor's startup reconciliation IS the recovery: by the time
    // boot() drains it, the genuine idle has already released the durable
    // hold — no manual action, and never a re-dispatch.
    assert.equal(readWorkspaceSlot(workspace.id, state), null, "startup reconciliation closes the loop without manual action");
    assert.equal(native.submitCalls, 1, "recovery never re-submits the task");
    // Post-release reconciles observe the clean state (the release was single and final).
    assert.deepEqual(await revived.reconcileNativeSlot(), { status: "none", released: false });
  });

  it("without a session-status adapter the writer stays held (interface gap, fail closed)", async () => {
    const manager = await boot();
    await holdTimeoutWriter();
    (native as unknown as { adapterInstalled: boolean }).adapterInstalled = false;
    const result = await manager.reconcileNativeSlot();
    assert.equal(result.released, false, "no adapter means no idle evidence, so no release");
    assert.equal(result.status, "busy_timeout");
    assert.ok(readWorkspaceSlot(workspace.id, state));
  });

  it("a timeout-held slot without a bound session id cannot be released (reportable interface limit)", async () => {
    // Forge a bound slot that never learned its session (legacy bind shape),
    // BEFORE boot so startup reconciliation observes the held state.
    const reservation = randomUUID();
    acquireWorkspaceSlot(workspace.id, reservation, state, "z2c");
    bindWorkspaceSlot(workspace.id, reservation, "z2c_legacytask01", null, state);
    native.tasks.set("z2c_legacytask01", {
      workspace_id: workspace.id,
      task_id: "z2c_legacytask01",
      session_id: null,
      status: "failed",
      exit_status: "turn timeout",
    });
    native.lane.active_task = null;
    const manager = await boot();
    const result = await manager.reconcileNativeSlot();
    assert.equal(result.released, false, "no session means no exact observation is possible");
    assert.equal(result.status, "busy_timeout");
    assert.ok(readWorkspaceSlot(workspace.id, state));
    assert.equal(native.sessionProbeCalls.length, 0, "never probed without a bound session id");
    assert.equal(native.outputCalls.length, 0);
  });

  it("task-level failed with an empty exit_status remains a confirmed terminal (unchanged semantics)", async () => {
    const manager = await boot();
    const submitted = await manager.submitNative(input());
    const view = native.tasks.get(submitted.task_id)!;
    view.status = "failed";
    view.exit_status = "";
    native.lane.active_task = null;
    const result = await manager.reconcileNativeSlot();
    assert.equal(result.released, true, "non-timeout failures keep their reliably-terminal release");
    assert.equal(readWorkspaceSlot(workspace.id, state), null);
    assert.equal(native.sessionProbeCalls.length, 0, "no session probe for reliably-terminal outcomes");
  });

  it("the probe only ever queries the exact bound session and workspace namespace", async () => {
    const manager = await boot();
    const task = await holdTimeoutWriter();
    native.sessions.get(task.session_id!)!.status = "idle";
    await manager.reconcileNativeSlot();
    assert.ok(native.sessionProbeCalls.length >= 1, "reconciliation probed the bound session");
    for (const call of native.sessionProbeCalls) {
      assert.equal(call.session_id, task.session_id, "every probe targets the exact bound session");
      assert.equal(call.workspace_id, workspace.id, "every probe targets the authorized workspace");
    }
    assert.ok(fs.existsSync(workspaceSlotFile(workspace.id, state)) === false);
  });
});
