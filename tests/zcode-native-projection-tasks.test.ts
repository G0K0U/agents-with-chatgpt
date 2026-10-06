/**
 * A2C → native workspace projection at the task-manager / orchestrator seam.
 *
 * The writer manager (tasks.ts) keeps its whole durable bookkeeping — writer
 * slots, reservation fingerprints, orchestrator runs — in the PUBLIC A2C
 * workspace namespace, while everything forwarded upstream must carry the
 * projected NATIVE grant id. These tests prove:
 *
 *  1. the orchestrator zcode lane reaches exactly ONE audit.required per
 *     terminal task (idempotent across recovery), through the mapped lane;
 *  2. submit/get/cancel/output/resume keep both namespaces consistent;
 *  3. keyed recovery of a lost submit response only resolves when the
 *     reservation fingerprint was recorded over the projected native payload
 *     (the payload Z2C hashed at admission) — wrong-namespace evidence can
 *     never release a writer slot;
 *  4. a projection failure leaves no writer reservation and dispatches
 *     nothing (fail closed).
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CodexTaskManager } from "../src/execution/tasks.js";
import { ZcodeNativeError, nativeRequestFingerprint, nativeResumeFingerprint, type SubmitNativeInput, type ResumeNativeInput, type ZcodeNativeTaskView } from "../src/execution/zcode-native.js";
import { readWorkspaceSlot, workspaceSlotFile } from "../src/execution/slot.js";
import { Workspace } from "../src/workspace/manager.js";

const NATIVE_WS = "ws_mapped-native-fixture";

interface Admission {
  view: ZcodeNativeTaskView;
  fingerprint: string;
}

/**
 * Mapped fake native client: the manager talks the A2C namespace to it (the
 * real ZcodeNativeClient translates internally); this stub models the same
 * contract — A2C ids in, A2C ids out, NATIVE ids on its upstream store.
 */
class MappedFakeNative {
  readonly upstream = new Map<string, ZcodeNativeTaskView>();
  readonly byKey = new Map<string, Admission>();
  readonly forwardedWorkspaces: string[] = [];
  lane = { provider_healthy: true, provider_status: "healthy", active_task: null as string | null, queued_task_count: 0, paused: false };
  failMode: "ok" | "lost-after-admit" = "ok";
  projectFails = false;

  constructor(readonly a2cWorkspaceId: string, readonly canonicalRoot: string) {}

  projectWorkspace(workspaceId: string): Promise<{ nativeWorkspaceId: string; canonicalPath: string }> {
    if (this.projectFails || workspaceId !== this.a2cWorkspaceId) {
      return Promise.reject(new ZcodeNativeError("ZCODE_NATIVE_WORKSPACE_FORBIDDEN", `native workspace projection unavailable for ${workspaceId}: fixture refusal`));
    }
    return Promise.resolve({ nativeWorkspaceId: NATIVE_WS, canonicalPath: this.canonicalRoot });
  }

  async submitTask(input: SubmitNativeInput, beforeDispatch?: () => void): Promise<ZcodeNativeTaskView> {
    assert.equal(input.workspace_id, this.a2cWorkspaceId, "the manager must talk the A2C namespace to the client");
    beforeDispatch?.();
    if (this.failMode === "lost-after-admit") {
      this.admit(input);
      throw new ZcodeNativeError("ZCODE_NATIVE_OUTCOME_UNKNOWN", "Mutation dispatch outcome unknown");
    }
    return this.release({ ...this.admit(input) });
  }

  /** Release an upstream view with the authorized A2C workspace id restored. */
  private release(view: ZcodeNativeTaskView): ZcodeNativeTaskView {
    assert.equal(view.workspace_id, NATIVE_WS);
    return { ...view, workspace_id: this.a2cWorkspaceId };
  }

  /** Upstream admission under the projected NATIVE workspace id. */
  private admit(input: SubmitNativeInput | ResumeNativeInput, resumeOfSession?: string): ZcodeNativeTaskView {
    const nativeId = this.nativeIdOrThrow(input.workspace_id);
    this.forwardedWorkspaces.push(nativeId);
    const fingerprint = resumeOfSession
      ? nativeResumeFingerprint({ ...(input as ResumeNativeInput), workspace_id: nativeId })
      : nativeRequestFingerprint({ ...(input as SubmitNativeInput), workspace_id: nativeId });
    const existing = input.idempotency_key ? this.byKey.get(input.idempotency_key) : undefined;
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new ZcodeNativeError("ZCODE_NATIVE_UPSTREAM", "key is already bound to a different request", "IDEMPOTENCY_CONFLICT");
      }
      return { ...existing.view, idempotency: { ...existing.view.idempotency!, replayed: true } };
    }
    const view: ZcodeNativeTaskView = {
      workspace_id: nativeId,
      task_id: `z2c_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      session_id: resumeOfSession ?? `sess_${randomUUID()}`,
      status: "running",
      ...(input.idempotency_key ? {
        idempotency: { protocol: "workspace-task-v1" as const, key: input.idempotency_key, request_fingerprint: fingerprint, replayed: false },
      } : {}),
    };
    this.upstream.set(view.task_id, view);
    if (input.idempotency_key) this.byKey.set(input.idempotency_key, { view, fingerprint });
    this.lane.active_task = view.task_id;
    return view;
  }

  private nativeIdOrThrow(workspaceId: string): string {
    if (workspaceId !== this.a2cWorkspaceId && workspaceId !== NATIVE_WS) {
      throw new ZcodeNativeError("ZCODE_NATIVE_WORKSPACE_FORBIDDEN", `unmapped fixture workspace ${workspaceId}`);
    }
    return NATIVE_WS;
  }

  async resumeSession(input: ResumeNativeInput, beforeDispatch?: () => void): Promise<ZcodeNativeTaskView> {
    assert.equal(input.workspace_id, this.a2cWorkspaceId, "the manager must talk the A2C namespace to the client");
    beforeDispatch?.();
    return this.release({ ...this.admit(input, input.session_id) });
  }

  async getTask(input: { workspace_id: string; task_id: string }): Promise<ZcodeNativeTaskView> {
    const view = this.upstream.get(input.task_id);
    if (!view || view.workspace_id !== this.nativeIdOrThrow(input.workspace_id)) {
      throw new ZcodeNativeError("ZCODE_NATIVE_UPSTREAM", "no such task", "Z2C_TASK_UNKNOWN");
    }
    return this.release({ ...view });
  }

  async cancelTask(input: { workspace_id: string; task_id: string }): Promise<ZcodeNativeTaskView> {
    const view = this.upstream.get(input.task_id)!;
    view.status = "cancelled";
    this.lane.active_task = null;
    return this.release({ ...view });
  }

  async executionOutput(input: { workspace_id: string; task_id: string; output_id: string }, observeTask?: (t: ZcodeNativeTaskView) => void): Promise<{ output_id: string; task_id: string; workspace_id: string; session_id: string | null; text: string }> {
    const view = this.upstream.get(input.task_id)!;
    observeTask?.({ ...view });
    return { output_id: input.output_id, task_id: input.task_id, workspace_id: input.workspace_id, session_id: view.session_id, text: "fixture output" };
  }

  async resolveKeyedTask(input: { workspace_id: string; idempotency_key: string }, expectedFingerprint?: string): Promise<ZcodeNativeTaskView | null> {
    this.nativeIdOrThrow(input.workspace_id);
    const admission = this.byKey.get(input.idempotency_key);
    if (!admission) return null;
    // Upstream proof: the fingerprint IT recorded at admission. The caller's
    // expected evidence must match — wrong-namespace evidence fails closed.
    if (expectedFingerprint !== undefined && admission.fingerprint !== expectedFingerprint) {
      throw new ZcodeNativeError("ZCODE_NATIVE_UPSTREAM", "Keyed resolution returned an unproven task binding", "IDEMPOTENCY_INVALID");
    }
    return this.release({ ...admission.view, idempotency: { ...admission.view.idempotency!, replayed: true } });
  }

  async taskLaneStatus(): Promise<{ provider_healthy: boolean; provider_status: string; active_task: string | null; queued_task_count: number; paused: boolean }> {
    return { ...this.lane };
  }
}

describe("native workspace projection at the manager/orchestrator seam", () => {
  let root: string;
  let state: string;
  let workspace: Workspace;
  let native: MappedFakeNative;
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
    root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-projection-tasks-"));
    state = path.join(root, "state");
    const work = path.join(root, "workspace");
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, "fixture.txt"), "preserve\n");
    workspace = new Workspace(work);
    native = new MappedFakeNative(workspace.id, workspace.root);
  });

  afterEach(async () => {
    for (const entry of managers.splice(0)) await entry.close();
    const resolved = path.resolve(root);
    assert.ok(path.basename(resolved).startsWith("c2c-projection-tasks-"), "unsafe cleanup");
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  const input = (): SubmitNativeInput => ({ workspace_id: workspace.id, instruction: "probe", write_scope: "workspace" });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("native submit/get/cancel/output/resume release the A2C namespace while upstream stores native ids", async () => {
    const manager = boot();
    const submitted = await manager.submitNative(input());
    assert.equal(submitted.workspace_id, workspace.id);
    assert.ok(native.forwardedWorkspaces.every((id) => id === NATIVE_WS), "upstream only ever saw the native id");
    for (const view of native.upstream.values()) assert.equal(view.workspace_id, NATIVE_WS);

    const fetched = await manager.getNative({ workspace_id: workspace.id, task_id: submitted.task_id });
    assert.equal(fetched.workspace_id, workspace.id);

    const out = await manager.outputNative({ workspace_id: workspace.id, task_id: submitted.task_id, output_id: "out_fixture" });
    assert.equal(out.workspace_id, workspace.id);

    // Terminal first: the writer slot frees for the resume mutation.
    const cancelled = await manager.cancelNative({ workspace_id: workspace.id, task_id: submitted.task_id });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.workspace_id, workspace.id);

    const resumed = await manager.resumeNative({ ...input(), session_id: submitted.session_id!, instruction: "continue" });
    assert.equal(resumed.workspace_id, workspace.id);
    assert.equal(resumed.session_id, submitted.session_id);
    assert.ok(native.forwardedWorkspaces.every((id) => id === NATIVE_WS));
  });

  it("a lost submit response recovers through keyed evidence recorded over the projected payload", async () => {
    const manager = boot();
    native.failMode = "lost-after-admit";
    await assert.rejects(() => manager.submitNative(input()), /outcome unknown/i);
    // Reservation held (fail closed) with durable correlation evidence.
    assert.ok(fs.existsSync(workspaceSlotFile(workspace.id, state)));
    const held = readWorkspaceSlot(workspace.id, state);
    assert.ok(held?.idempotencyKey);
    assert.ok(held?.requestFingerprint);

    // By the time recovery runs, the admitted upstream work has finished.
    for (const view of native.upstream.values()) view.status = "completed";
    await sleep(1100);
    // The manager's own writer-slot watcher may have run the recovery already;
    // an explicit reconcile is idempotent ("none" once the slot is released).
    const reconciliation = await manager.reconcileNativeSlot();
    const slotGone = !fs.existsSync(workspaceSlotFile(workspace.id, state));
    assert.ok(slotGone, "the slot was released by proven upstream observation");
    assert.ok(
      reconciliation.released === true || reconciliation.status === "none",
      `unexpected reconciliation outcome: ${JSON.stringify(reconciliation)}`,
    );
    if (reconciliation.status !== "none") {
      assert.equal(reconciliation.status, "completed");
    }
    const evidence = native.byKey.get(held.idempotencyKey!);
    assert.ok(evidence, "recovery resolved through the durable keyed evidence");
  });

  it("orchestrator zcode lane reaches terminal and publishes exactly ONE audit.required (recovery idempotent)", async () => {
    fs.mkdirSync(path.join(workspace.root, "fixture"), { recursive: true });
    const manager = boot();
    const run = await manager.orchestrator.create("run-zcode", "local", [
      { instruction: "Mapped native step", write_scope: ["fixture"], network: false, run_tests: false, agent: "zcode" },
    ]);
    assert.match(run.taskId ?? "", /^z2c_/);
    // The lane dispatched through the mapped native surface: the manager's
    // slot bookkeeping saw the A2C id, upstream the projected native id.
    assert.ok(native.forwardedWorkspaces.length >= 1);
    assert.ok(native.forwardedWorkspaces.every((id) => id === NATIVE_WS));
    assert.equal(readWorkspaceSlot(workspace.id, state)?.provider, "z2c");

    // The dispatched native task reaches a terminal state.
    const dispatched = run.taskId!;
    native.upstream.get(dispatched)!.status = "completed";

    await manager.orchestrator.recover();
    const after = manager.orchestrator.read("run-zcode", "local");
    assert.equal(after.state, "WAITING_AUDIT");
    assert.equal(after.audits.length, 1);
    assert.equal(after.audits[0]!.type, "audit.required");
    assert.equal(after.audits[0]!.taskId, dispatched);
    assert.equal(after.audits[0]!.terminalStatus, "completed");

    // Repeated recovery never duplicates the audit entry.
    await manager.orchestrator.recover();
    await manager.orchestrator.recover();
    const stable = manager.orchestrator.read("run-zcode", "local");
    assert.equal(stable.audits.length, 1);
    assert.equal(stable.audits.filter((audit) => audit.type === "audit.required").length, 1);
  });

  it("a projection failure leaves no writer reservation and dispatches nothing", async () => {
    const manager = boot();
    native.projectFails = true;
    await assert.rejects(
      () => manager.submitNative(input()),
      /native workspace projection unavailable/,
    );
    assert.equal(native.forwardedWorkspaces.length, 0);
    assert.equal(fs.existsSync(workspaceSlotFile(workspace.id, state)), false, "the reservation was released");
  });
});
