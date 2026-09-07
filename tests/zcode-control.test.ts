/**
 * Deterministic tests for the governed C2C → ZCode queue control plane.
 *
 * Every test runs against an isolated temporary queue root; the fixed
 * production root is never touched. No real ZCode worker runs here.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  FIXED_ZCODE_QUEUE_ROOT,
  ZcodeControl,
  ZcodeControlError,
} from "../src/execution/zcode-control.js";
import { cleanup, makeTmpDir } from "./helpers.js";

function expectZcodeError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof ZcodeControlError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected ZcodeControlError ${code}, but nothing was thrown`);
}

let root: string;
let control: ZcodeControl;
const createdDirs: string[] = [];

beforeEach(() => {
  root = makeTmpDir("zcode-control");
  createdDirs.push(root);
  control = new ZcodeControl(root);
});

afterAll(() => {
  for (const dir of createdDirs) {
    cleanup(dir);
  }
});

function enqueueValid(overrides: Record<string, unknown> = {}): Promise<unknown> {
  return control.enqueue({
    role: "worker",
    priority: 0,
    instruction: "Implement the governed change and run the focused tests.",
    ...overrides,
  });
}

function appendReceipt(record: Record<string, unknown>): void {
  fs.appendFileSync(path.join(root, "receipts.jsonl"), JSON.stringify(record) + "\n", "utf8");
}

describe("zcode_enqueue_task", () => {
  it("stores a complete governed record with a generated id when omitted", async () => {
    const stored = (await enqueueValid()) as { task_id: string; network: boolean; created_at: string };
    expect(stored.task_id).toMatch(/^zcode_[0-9a-f]{24}$/);
    expect(stored.network).toBe(false);
    expect(stored.created_at).toBeTruthy();
    const raw = fs.readFileSync(path.join(root, "queue.jsonl"), "utf8").trim().split("\n");
    expect(raw).toHaveLength(1);
    expect(() => JSON.parse(raw[0])).not.toThrow();
  });

  it("rejects invalid schema values and network=true", async () => {
    await expect(enqueueValid({ role: "wizard" })).rejects.toMatchObject({ code: "ZCODE_INVALID_TASK" });
    await expect(enqueueValid({ priority: 1.5 })).rejects.toMatchObject({ code: "ZCODE_INVALID_TASK" });
    await expect(enqueueValid({ network: true })).rejects.toMatchObject({ code: "ZCODE_INVALID_TASK" });
    await expect(enqueueValid({ mode: "delete" })).rejects.toMatchObject({ code: "ZCODE_INVALID_TASK" });
    await expect(enqueueValid({ instruction: "   " })).rejects.toMatchObject({ code: "ZCODE_INVALID_TASK" });
    await expect(enqueueValid({ resources: ["ok", ""] })).rejects.toMatchObject({ code: "ZCODE_INVALID_TASK" });
    await expect(enqueueValid({ task_id: "../escape" })).rejects.toMatchObject({ code: "ZCODE_INVALID_TASK" });
  });

  it("rejects duplicate task ids against both queue.jsonl and receipts.jsonl", async () => {
    await enqueueValid({ task_id: "dup_queue_1" });
    await expect(enqueueValid({ task_id: "dup_queue_1" })).rejects.toMatchObject({
      code: "ZCODE_DUPLICATE_TASK_ID",
    });
    appendReceipt({ task_id: "dup_receipt_1", event: "COMPLETED", timestamp: "2026-09-05T00:00:00Z" });
    await expect(enqueueValid({ task_id: "dup_receipt_1" })).rejects.toMatchObject({
      code: "ZCODE_DUPLICATE_TASK_ID",
    });
  });

  it("rejects credential-like instructions", async () => {
    const cases = [
      "use the api_key = sk-123 to connect",
      "store the password: hunter2",
      "set client_secret = abc",
      "attach the token: eyJhbGciOi",
      "send the cookie: session=1",
      "load the private key from disk",
      "include a Private Key block below",
    ];
    for (const instruction of cases) {
      await expect(enqueueValid({ instruction })).rejects.toMatchObject({ code: "ZCODE_CREDENTIAL_INPUT" });
    }
    // Nothing may have been written by the rejected attempts: the file is
    // only created on the first successful append.
    expect(fs.existsSync(path.join(root, "queue.jsonl"))).toBe(false);
  });

  it("serializes concurrent appends into complete, non-interleaved JSONL lines", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        enqueueValid({ task_id: `parallel_${i}`, instruction: `parallel task ${i}` }).catch(() => null)
      )
    );
    expect(results.every((result) => result !== null)).toBe(true);
    const lines = fs.readFileSync(path.join(root, "queue.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(12);
    const ids = lines.map((line) => (JSON.parse(line) as { task_id: string }).task_id);
    expect(new Set(ids).size).toBe(12);
  });
});

describe("truth-file safety", () => {
  it("fails closed on malformed JSONL and never skips the bad line", async () => {
    await enqueueValid({ task_id: "before_corrupt" });
    fs.appendFileSync(path.join(root, "queue.jsonl"), "{not valid json\n", "utf8");
    expectZcodeError(() => control.listTasks(), "ZCODE_MALFORMED_FILE");
    expectZcodeError(() => control.getTask("before_corrupt"), "ZCODE_MALFORMED_FILE");
  });

  it("fails closed on an empty middle line in receipts.jsonl", async () => {
    await enqueueValid({ task_id: "receipt_gap" });
    fs.appendFileSync(path.join(root, "receipts.jsonl"), "\n", "utf8");
    expectZcodeError(() => control.getTask("receipt_gap"), "ZCODE_MALFORMED_FILE");
  });

  it("fails closed when worker-state.json is not valid JSON", async () => {
    fs.writeFileSync(path.join(root, "worker-state.json"), "{ broken", "utf8");
    expectZcodeError(() => control.listTasks(), "ZCODE_MALFORMED_FILE");
  });

  it("rejects symlink/junction reparse-point escape of a truth file", async () => {
    const outsideDir = makeTmpDir("zcode-outside-escape");
    createdDirs.push(outsideDir);
    const outsideFile = path.join(outsideDir, "outside.jsonl");
    fs.writeFileSync(outsideFile, '{"task_id":"escapee"}\n', "utf8");
    try {
      fs.symlinkSync(outsideFile, path.join(root, "queue.jsonl"), "junction");
    } catch {
      // Symlink creation can be privilege-gated; the regular-file check is
      // still exercised by every other test.
      return;
    }
    expectZcodeError(() => control.listTasks(), "ZCODE_PATH_UNSAFE");
    await expect(enqueueValid()).rejects.toMatchObject({ code: "ZCODE_PATH_UNSAFE" });
  });

  it("fails closed when a truth file exceeds the 8 MiB read cap", async () => {
    const big = "x".repeat(1024);
    fs.writeFileSync(path.join(root, "queue.jsonl"), `{"pad":"${big}"}`.repeat(9 * 1024) + "\n", "utf8");
    expectZcodeError(() => control.listTasks(), "ZCODE_FILE_TOO_LARGE");
  });

  it("sources the queue root from operator configuration, empty by default, never from input", () => {
    expect(FIXED_ZCODE_QUEUE_ROOT).toBe(process.env.C2C_ZCODE_QUEUE_ROOT?.trim() ?? "");
  });
});

describe("status truth and receipts precedence", () => {
  it("reports queued before any receipt", async () => {
    await enqueueValid({ task_id: "status_queued" });
    const view = await control.getTask("status_queued");
    expect(view?.status).toBe("queued");
    expect(view?.receipts).toHaveLength(0);
  });

  it("terminal receipt beats START which beats CANCEL_REQUESTED", async () => {
    await enqueueValid({ task_id: "status_cancelled_only" });
    await control.requestCancel("status_cancelled_only");
    expect((await control.getTask("status_cancelled_only"))?.status).toBe("cancel_requested");

    await enqueueValid({ task_id: "status_running" });
    appendReceipt({ task_id: "status_running", event: "START", timestamp: "2026-09-05T01:00:00Z" });
    await control.requestCancel("status_running");
    expect((await control.getTask("status_running"))?.status).toBe("running");

    await enqueueValid({ task_id: "status_terminal" });
    appendReceipt({ task_id: "status_terminal", event: "START", timestamp: "2026-09-05T01:00:00Z" });
    appendReceipt({ task_id: "status_terminal", event: "COMPLETED", timestamp: "2026-09-05T02:00:00Z" });
    expect((await control.getTask("status_terminal"))?.status).toBe("completed");
  });

  it("redacts absolute paths and credential shapes from returned views", async () => {
    await enqueueValid({
      task_id: "sanitize_me",
      instruction: "Read F:\\work\\engineering-ai\\var\\c2c-zcode\\queue.jsonl and summarize it.",
      resources: ["F:\\work\\secret-resources"],
    });
    appendReceipt({
      task_id: "sanitize_me",
      event: "FAILED",
      timestamp: "2026-09-05T01:00:00Z",
      error: "leak attempt api_key = sk-abcdef123456 under F:\\work\\x",
    });
    const view = await control.getTask("sanitize_me");
    const flattened = JSON.stringify(view);
    expect(flattened).not.toContain("F:\\work");
    expect(flattened).not.toContain("sk-abcdef123456");
    expect(view?.instruction_excerpt).toContain("[local-path]");
    expect(view?.error).toContain("[REDACTED]");
  });

  it("bounds the instruction excerpt and the list size", async () => {
    for (let i = 0; i < 7; i += 1) {
      await enqueueValid({ task_id: `bounded_${i}`, instruction: "x".repeat(5000) });
    }
    const listed = await control.listTasks(5);
    expect(listed.tasks).toHaveLength(5);
    expect(listed.total).toBe(7);
    for (const task of listed.tasks) {
      expect(task.instruction_excerpt.length).toBeLessThanOrEqual(600);
    }
  });
});

describe("zcode_cancel_task", () => {
  it("appends only CANCEL_REQUESTED to control.jsonl and never touches receipts.jsonl", async () => {
    await enqueueValid({ task_id: "cancel_me" });
    const result = await control.requestCancel("cancel_me");
    expect(result).toMatchObject({ task_id: "cancel_me", status: "cancel_requested", cancel_requested: true });

    const controlRaw = fs.readFileSync(path.join(root, "control.jsonl"), "utf8").trim().split("\n");
    expect(controlRaw).toHaveLength(1);
    const record = JSON.parse(controlRaw[0]) as { event: string; task_id: string };
    expect(record.event).toBe("CANCEL_REQUESTED");
    expect(record.task_id).toBe("cancel_me");
    // receipts.jsonl must not exist: only the ZCode coordinator writes it.
    expect(fs.existsSync(path.join(root, "receipts.jsonl"))).toBe(false);
  });

  it("is idempotent for repeated cancel requests", async () => {
    await enqueueValid({ task_id: "cancel_twice" });
    const first = await control.requestCancel("cancel_twice");
    const second = await control.requestCancel("cancel_twice");
    expect(first.already_requested).toBe(false);
    expect(second.already_requested).toBe(true);
    const lines = fs.readFileSync(path.join(root, "control.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("rejects unknown tasks and already-terminal tasks", async () => {
    await expect(control.requestCancel("never_enqueued")).rejects.toMatchObject({ code: "ZCODE_TASK_UNKNOWN" });

    await enqueueValid({ task_id: "already_done" });
    appendReceipt({ task_id: "already_done", event: "COMPLETED", timestamp: "2026-09-05T01:00:00Z" });
    await expect(control.requestCancel("already_done")).rejects.toMatchObject({ code: "ZCODE_ALREADY_TERMINAL" });
    // No cancel request ever succeeded, so control.jsonl was never created.
    expect(fs.existsSync(path.join(root, "control.jsonl"))).toBe(false);
  });

  it("never fabricates terminal receipts anywhere", async () => {
    await enqueueValid({ task_id: "no_terminal_write" });
    await control.requestCancel("no_terminal_write");
    const flattened = fs.existsSync(path.join(root, "control.jsonl"))
      ? fs.readFileSync(path.join(root, "control.jsonl"), "utf8")
      : "";
    expect(flattened).not.toContain("COMPLETED");
    expect(flattened).not.toContain("CANCELLED");
    expect(flattened).not.toContain("FAILED");
    expect(fs.existsSync(path.join(root, "receipts.jsonl"))).toBe(false);
  });
});

describe("reads", () => {
  it("returns null for unknown tasks and surfaces the worker state cache", async () => {
    expect(await control.getTask("unknown_task")).toBeNull();
    fs.writeFileSync(
      path.join(root, "worker-state.json"),
      JSON.stringify({ status: "running", active: [{ task_id: "t1", slot: 1 }], max_parallel: 3 }),
      "utf8"
    );
    const listed = await control.listTasks();
    expect(listed.worker_state).toMatchObject({ status: "running", max_parallel: 3 });
  });
});
