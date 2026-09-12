/**
 * Scalable lifecycle-history storage tests for the governed ZCode queue.
 *
 * receipts.jsonl is append-only lifecycle truth that grows with executed
 * history. These tests prove the storage contract beyond the legacy
 * whole-file 8 MiB cap:
 *
 * - bounded streaming reads (a >8 MiB history is readable, never rejected);
 * - deterministic segment rotation (receipts.NNNNNN.jsonl) with the active
 *   receipts.jsonl as the only append target;
 * - lifecycle merging, duplicate detection, cancellation truth and strict
 *   fail-closed parsing work ACROSS segment boundaries;
 * - a single pathological record fails closed instead of being skipped.
 *
 * Historical records — including the duplicate CANCELLED evidence of the
 * pre-hotfix bug — are never deleted or rewritten.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ZcodeControl,
  ZcodeControlError,
  ZcodeCoordinatorStore,
} from "../src/execution/zcode-control.js";
import { cleanup, makeTmpDir } from "./helpers.js";

let root: string;
const createdDirs: string[] = [];

beforeEach(() => {
  root = makeTmpDir("zcode-receipts-storage");
  createdDirs.push(root);
});

afterEach(() => {
  for (const dir of createdDirs) cleanup(dir);
  createdDirs.length = 0;
});

const control = () => new ZcodeControl(root);
const store = () => new ZcodeCoordinatorStore(root);

function receiptLine(taskId: string, event: string, extra: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      task_id: taskId,
      timestamp: "2026-09-12T00:00:00.000Z",
      event,
      model: null,
      session: null,
      workspace: null,
      verification_summary: null,
      error: null,
      ...extra,
    }) + "\n"
  );
}

/** Bulk-write valid receipt records directly (the coordinator owns appends;
 * tests emulate exactly the serialized one-line record shape it produces). */
function bulkAppendReceipts(taskId: string, event: string, count: number): void {
  const handle = fs.openSync(path.join(root, "receipts.jsonl"), "a");
  try {
    const line = receiptLine(taskId, event);
    for (let i = 0; i < count; i += 1) fs.writeSync(handle, line, null, "utf8");
  } finally {
    fs.closeSync(handle);
  }
}

async function enqueueTask(taskId: string): Promise<void> {
  await control().enqueue({
    task_id: taskId,
    role: "worker",
    priority: 0,
    instruction: "Scratch-safe deterministic storage probe inside the authorized workspace.",
  });
}

describe("scalable ZCode lifecycle history storage", () => {
  it("T1: reads a >8 MiB receipts history without ZCODE_FILE_TOO_LARGE and keeps API output bounded", async () => {
    await enqueueTask("t1_history_task_1");
    await enqueueTask("t1_history_task_2");
    // ~110 bytes per record; 90k records ≈ 9.9 MiB, comfortably past the
    // legacy 8 MiB whole-file cap.
    bulkAppendReceipts("t1_history_task_1", "START", 45_000);
    bulkAppendReceipts("t1_history_task_2", "START", 45_000);
    const size = fs.statSync(path.join(root, "receipts.jsonl")).size;
    expect(size).toBeGreaterThan(8 * 1024 * 1024);

    const { tasks, total } = control().listTasks(100);
    expect(total).toBe(2);
    expect(tasks).toHaveLength(2);
    // Bounded representation: the view shows at most the last 50 receipts
    // even though the underlying history is enormous.
    for (const task of tasks) expect(task.receipts.length).toBeLessThanOrEqual(50);
    expect(tasks[0].status).toBe("running");
    const got = control().getTask("t1_history_task_2");
    expect(got?.status).toBe("running");
  });

  it("T2: merges lifecycle status across a rotated segment boundary (START old, COMPLETED active)", async () => {
    await enqueueTask("t2_spanning_task");
    const storeRef = store();
    await storeRef.appendReceipt({ task_id: "t2_spanning_task", event: "START" });
    // Rotate deterministically, exactly as the coordinator would.
    fs.renameSync(path.join(root, "receipts.jsonl"), path.join(root, "receipts.000001.jsonl"));
    await storeRef.appendReceipt({ task_id: "t2_spanning_task", event: "COMPLETED", model: "GLM-5.3-Flash" });

    const view = control().getTask("t2_spanning_task");
    expect(view?.status).toBe("completed");
    expect(view?.receipts.map((r) => r.event)).toEqual(["START", "COMPLETED"]);
  });

  it("T3: rejects a duplicate task id whose receipts live in an older segment", async () => {
    await enqueueTask("t3_dup_task");
    const storeRef = store();
    await storeRef.appendReceipt({ task_id: "t3_dup_task", event: "START" });
    fs.renameSync(path.join(root, "receipts.jsonl"), path.join(root, "receipts.000001.jsonl"));
    await storeRef.appendReceipt({ task_id: "t3_dup_task", event: "COMPLETED" });

    await expect(
      control().enqueue({
        task_id: "t3_dup_task",
        role: "worker",
        priority: 0,
        instruction: "duplicate attempt",
      })
    ).rejects.toMatchObject({ code: "ZCODE_DUPLICATE_TASK_ID" });
  });

  it("T4: cancellation truth across segments — a terminal CANCELLED in an old segment keeps the task terminal", async () => {
    await enqueueTask("t4_cancel_span");
    const storeRef = store();
    await storeRef.appendReceipt({ task_id: "t4_cancel_span", event: "START" });
    fs.renameSync(path.join(root, "receipts.jsonl"), path.join(root, "receipts.000001.jsonl"));
    await storeRef.appendReceipt({ task_id: "t4_cancel_span", event: "CANCELLED" });

    // The terminal status is observed across the boundary, so the control
    // plane refuses to record a cancellation request at all — no new
    // CANCELLED can ever be generated for this task.
    await expect(control().requestCancel("t4_cancel_span"))
      .rejects.toMatchObject({ code: "ZCODE_ALREADY_TERMINAL" });
    expect(control().getTask("t4_cancel_span")?.status).toBe("cancelled");
  });

  it("T5: malformed JSON in an OLDER segment fails closed for history reads", async () => {
    await enqueueTask("t5_malformed_old");
    const storeRef = store();
    await storeRef.appendReceipt({ task_id: "t5_malformed_old", event: "START" });
    fs.renameSync(path.join(root, "receipts.jsonl"), path.join(root, "receipts.000001.jsonl"));
    fs.writeFileSync(path.join(root, "receipts.000001.jsonl"), '{"task_id": broken\n", "utf8');

    expectZcodeErrorLike(() => control().listTasks(10), "ZCODE_MALFORMED_FILE");
  });

  it("T6: malformed JSON in the ACTIVE segment fails closed", async () => {
    await enqueueTask("t6_malformed_active");
    const storeRef = store();
    await storeRef.appendReceipt({ task_id: "t6_malformed_active", event: "START" });
    fs.appendFileSync(path.join(root, "receipts.jsonl"), "not json at all\n", "utf8");

    expectZcodeErrorLike(() => control().getTask("t6_malformed_active"), "ZCODE_MALFORMED_FILE");
  });

  it("T7: a single oversized record fails closed with an explicit bounded-record error", async () => {
    await enqueueTask("t7_oversized_record");
    const storeRef = store();
    await storeRef.appendReceipt({ task_id: "t7_oversized_record", event: "START" });
    // One pathological line > 1 MiB; the rest of the file stays valid.
    const junk = "x".repeat(1024 * 1024 + 64);
    fs.appendFileSync(
      path.join(root, "receipts.jsonl"),
      JSON.stringify({ task_id: "t7_oversized_record", event: "COMPLETED", verification_summary: junk }) + "\n",
      "utf8"
    );

    expectZcodeErrorLike(() => control().getTask("t7_oversized_record"), "ZCODE_RECORD_TOO_LARGE");
  });

  it("T8: segment filename escapes fail closed (directory-as-segment and symlinked segment)", async () => {
    // A directory masquerading as a segment must never be read as truth.
    fs.mkdirSync(path.join(root, "receipts.000042.jsonl"));
    expectZcodeErrorLike(() => control().listTasks(10), "ZCODE_PATH_UNSAFE");
    fs.rmdirSync(path.join(root, "receipts.000042.jsonl"));

    // A symlinked segment pointing outside the queue root must fail closed.
    const outside = makeTmpDir("zcode-escape-target");
    createdDirs.push(outside);
    const outsideFile = path.join(outside, "evil.jsonl");
    fs.writeFileSync(outsideFile, receiptLine("outside_task", "COMPLETED"), "utf8");
    let symlinkCreated = false;
    try {
      fs.symlinkSync(outsideFile, path.join(root, "receipts.000099.jsonl"), "file");
      symlinkCreated = true;
    } catch {
      // Windows without symlink privilege: the directory case already proves
      // the escape rejection path.
    }
    if (symlinkCreated) {
      expectZcodeErrorLike(() => control().listTasks(10), "ZCODE_PATH_UNSAFE");
    }
  });

  it("T9: a fresh control instance after rotation still sees the complete history", async () => {
    await enqueueTask("t9_restart_task");
    const storeRef = store();
    await storeRef.appendReceipt({ task_id: "t9_restart_task", event: "START" });
    // Force a rotation through the real append path by pushing the active
    // segment over the threshold with a valid record burst.
    bulkAppendReceipts("t9_restart_task", "START", 80_000); // ≈ 8.8 MiB in active
    await storeRef.appendReceipt({ task_id: "t9_restart_task", event: "COMPLETED" });
    // The oversized active file was rotated on the next coordinator append.
    expect(fs.existsSync(path.join(root, "receipts.000001.jsonl"))).toBe(true);

    const fresh = new ZcodeControl(root);
    const view = fresh.getTask("t9_restart_task");
    expect(view?.status).toBe("completed");
    expect(view?.receipts[0].event).toBe("START");
    expect(view?.receipts[view.receipts.length - 1].event).toBe("COMPLETED");
  });

  it("T10: coordinator appends stay idempotent across rotation — no new terminal receipts for a cancelled task", async () => {
    await enqueueTask("t10_cancel_idem");
    const storeRef = store();
    await storeRef.appendReceipt({ task_id: "t10_cancel_idem", event: "START" });
    bulkAppendReceipts("t10_cancel_idem", "START", 80_000); // forces rotation on next append
    await storeRef.appendReceipt({ task_id: "t10_cancel_idem", event: "CANCELLED" });
    expect(fs.existsSync(path.join(root, "receipts.000001.jsonl"))).toBe(true);

    const countReceipts = (): number => {
      let count = 0;
      for (const name of fs.readdirSync(root)) {
        if (name === "receipts.jsonl" || /^receipts\.\d{6}\.jsonl$/.test(name)) {
          count += fs
            .readFileSync(path.join(root, name), "utf8")
            .split("\n")
            .filter((line) => line.trim() !== "").length;
        }
      }
      return count;
    };
    const before = countReceipts();
    // Repeated "ticks" (fresh control reads + refused cancel requests) must
    // not append anything: the terminal truth is already recorded.
    for (let i = 0; i < 3; i += 1) {
      await expect(control().requestCancel("t10_cancel_idem"))
        .rejects.toMatchObject({ code: "ZCODE_ALREADY_TERMINAL" });
      expect(control().getTask("t10_cancel_idem")?.status).toBe("cancelled");
    }
    expect(countReceipts()).toBe(before);
  });

  it("coordinator append rotates the legacy oversized active segment on the next receipt", async () => {
    await enqueueTask("legacy_rotate_task");
    // Emulate the live legacy state: an active receipts.jsonl already past
    // the 8 MiB rotation threshold.
    bulkAppendReceipts("legacy_rotate_task", "START", 80_000);
    const legacySize = fs.statSync(path.join(root, "receipts.jsonl")).size;
    expect(legacySize).toBeGreaterThan(8 * 1024 * 1024);

    await store().appendReceipt({ task_id: "legacy_rotate_task", event: "COMPLETED" });
    expect(fs.existsSync(path.join(root, "receipts.000001.jsonl"))).toBe(true);
    expect(fs.statSync(path.join(root, "receipts.jsonl")).size).toBeLessThan(1024);

    const view = control().getTask("legacy_rotate_task");
    expect(view?.status).toBe("completed");
  });
});

function expectZcodeErrorLike(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof ZcodeControlError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected ZcodeControlError ${code}, but nothing was thrown`);
}
