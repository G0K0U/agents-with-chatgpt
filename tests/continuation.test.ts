import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { CodexTaskManager } from "../src/execution/tasks.js";
import { ContinuationController, installApprovedManifest, continuationDirectory, type ApprovedManifest } from "../src/execution/continuation.js";
import { Workspace } from "../src/workspace/manager.js";
import { makeTmpDir, cleanup, write, isolateStateDir } from "./helpers.js";
import type { AppServerClient, AppServerNotification } from "../src/execution/app-server.js";
import { verificationFingerprint } from "../src/execution/continuation-evidence.js";
import { reviewFingerprint, REVIEW_TIMEOUT_MS } from "../src/execution/continuation-review.js";
import { ZcodeNativeError, nativeRequestFingerprint, type ZcodeNativeTaskView } from "../src/execution/zcode-native.js";

class NativeFixture implements AppServerClient {
  handler?: (n: AppServerNotification) => void | Promise<void>;
  requests: Array<{ method: string; params: any }> = [];
  threadId = randomUUID(); turns = 0; hold = false; fail = false; model = "gpt-6-astra";
  async initialize() {}
  async request<T>(method: string, params?: any): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/start") { this.threadId = randomUUID(); return { model: this.model, thread: { id: this.threadId } } as T; }
    if (method === "turn/start") {
      this.turns++;
      const date = new Date().toISOString().slice(0, 10).replaceAll("-", "/");
      write(process.env.CODEX_HOME!, `sessions/${date}/rollout-${this.threadId}.jsonl`, JSON.stringify({ type: "session_meta", payload: { id: this.threadId } }) + "\n" + JSON.stringify({ type: "turn_context", timestamp: new Date().toISOString(), payload: { turn_id: "turn-fixture", thread_id: this.threadId, model: this.model, effort: params.effort ?? "high" } }));
      if (!this.hold) setTimeout(() => this.complete(), 0);
      return { turn: { id: "turn-fixture" } } as T;
    }
    if (method === "turn/interrupt") setTimeout(() => this.complete("interrupted"), 0);
    return {} as T;
  }
  complete(status = this.fail ? "failed" : "completed") {
    for (const command of ["pnpm typecheck", "pnpm test"]) {
      this.handler?.({ method: "item/started", params: { threadId: this.threadId, turnId: "turn-fixture", item: { id: command, type: "commandExecution", command } } });
      this.handler?.({ method: "item/completed", params: { threadId: this.threadId, turnId: "turn-fixture", item: { id: command, type: "commandExecution", command, exitCode: this.fail ? 1 : 0, aggregatedOutput: "fixture check" } } });
    }
    this.handler?.({ method: "turn/completed", params: { threadId: this.threadId, turnId: "turn-fixture", status } });
  }
  notify() {} respond() {} respondError() {} setRequestHandler() {}
  setNotificationHandler(handler: (n: AppServerNotification) => void | Promise<void>) { this.handler = handler; }
  async close() {}
}

describe("approved continuation workflow", () => {
  let root: string, state: string, native: string, oldNative: string | undefined;
  let manager: CodexTaskManager, controller: ContinuationController, fake: NativeFixture;
  let manifest: ApprovedManifest, authorized: boolean, now: number, collections: number, mirrorFail: boolean;
  let reviewHold: boolean, reviewUnavailable: boolean, reviewCalls: any[], reviewTasks: Map<string, ZcodeNativeTaskView>, reviewInputs: Map<string, any>;
  let reviewOutput: ((receipt: any) => string) | undefined;
  let reviewAfterOutput: (() => void) | undefined;
  let reviewFailure: string | undefined, reviewLoseReply: boolean;
  beforeEach(() => {
    root = makeTmpDir("continuation-workspace"); state = isolateStateDir(); native = makeTmpDir("continuation-native");
    oldNative = process.env.CODEX_HOME; process.env.CODEX_HOME = native;
    write(root, "apps/web/index.ts", "export const x = 1;"); write(root, "docs/report.md", "fixture"); write(root, "tests/a.ts", "fixture");
    fake = new NativeFixture(); authorized = true; now = Date.now(); collections = 0; mirrorFail = false;
    reviewFailure = undefined; reviewLoseReply = false;
    reviewHold = false; reviewUnavailable = false; reviewCalls = []; reviewTasks = new Map(); reviewInputs = new Map(); reviewOutput = undefined; reviewAfterOutput = undefined;
    const node = (id: string, dependencies: string[] = []) => ({ id, provider: "codex" as const, model: "gpt-6-astra" as const, effort: "high" as const, instruction: `Bounded ${id}`, writeScope: ["apps/web", "docs"], network: false, networkBoundary: "offline" as const, dependencies, idempotencyKey: id, timeoutMs: 10000, correctiveInputs: [], kind: "ui" as const });
    manifest = { version: 1, planId: "approved", workspaceId: new Workspace(root).id, ownerId: "owner", approvedAt: new Date(now).toISOString(), authorizationReference: "test-user-request", enabled: true, leaseMs: 86400000, maxNewTasks: 12, nodes: [node("U02"), node("U03", ["U02"])] };
  });
  function boot(install = true, paused = false) {
    if (install) installApprovedManifest(state, manifest);
    manager = new CodexTaskManager(new Workspace(root), { stateDir: state, fullAccess: true, appServerFactory: () => fake, continuationAuthorize: () => authorized, interruptGraceMs: 50,
      nativeClient: {
        submitTask: async (input, beforeDispatch) => {
          beforeDispatch?.(); reviewCalls.push(input);
          if (reviewUnavailable) throw new ZcodeNativeError("ZCODE_NATIVE_UNAVAILABLE", "Z2C unavailable");
          if (reviewFailure) throw new ZcodeNativeError("ZCODE_NATIVE_UPSTREAM", "key protocol rejected", reviewFailure);
          const prior = [...reviewTasks.values()].find(t => t.workspace_id === input.workspace_id && t.idempotency?.key === input.idempotency_key);
          if (prior) {
            if (prior.idempotency!.request_fingerprint !== nativeRequestFingerprint(input)) throw new ZcodeNativeError("ZCODE_NATIVE_UPSTREAM", "conflict", "IDEMPOTENCY_CONFLICT");
            return { ...prior, idempotency: { ...prior.idempotency!, replayed: true } };
          }
          const task = { task_id: `z2c_review_${reviewCalls.length}`, workspace_id: input.workspace_id, session_id: `sess_${randomUUID()}`,
            status: "running", output_id: `out_${reviewCalls.length}`, model_binding: { provider_id: "builtin:zai-start-plan", model_id: "GLM-5.3-Flash", source: "session/read" },
            idempotency: { protocol: "workspace-task-v1" as const, key: input.idempotency_key!, request_fingerprint: nativeRequestFingerprint(input), replayed: false } };
          reviewTasks.set(task.task_id, task); reviewInputs.set(task.task_id, JSON.parse(input.instruction.split("\nEvidence:\n")[1]));
          if (reviewLoseReply) { reviewLoseReply = false; throw new ZcodeNativeError("ZCODE_NATIVE_TIMEOUT", "accepted reply lost"); }
          return task;
        },
        getTask: async ({ task_id }) => {
          const task = reviewTasks.get(task_id)!;
          if (!reviewHold) task.status = "completed";
          return { ...task };
        },
        executionOutput: async ({ task_id, output_id }) => {
          const task = reviewTasks.get(task_id)!, input = reviewInputs.get(task_id);
          const receipt = { schema_version: 1, decision: "PASS", reviewed_task_id: input.executor_task_id, source_fingerprint: input.source_fingerprint, summary: "Fixture independent review", findings: [] };
          const text = reviewOutput ? reviewOutput(receipt) : JSON.stringify(receipt);
          reviewAfterOutput?.();
          return { workspace_id: task.workspace_id, task_id, session_id: task.session_id, output_id, text };
        },
        cancelTask: async () => { throw new Error("Not expected"); }, resumeSession: async () => { throw new Error("Not expected"); },
      } });
    controller = new ContinuationController(manager, { authorize: () => authorized, now: () => now,
      // Typed verifier fixture; real subprocess and fake-output negatives live in continuation-evidence.test.ts.
      verify: async () => ({ version: 1, profile: "web-source-v1", passed: !fake.fail,
        before: verificationFingerprint(root), after: verificationFingerprint(root), startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        checks: [{ id: "web-typecheck", argv: [], exitCode: fake.fail ? 1 : 0, outputHash: "fixture" }, { id: "web-contracts", argv: [], exitCode: 0, outputHash: "fixture", tests: 1 }] }),
      collect: async () => { collections++; if (mirrorFail) throw new Error("mirror"); return { state: "MIRRORED" }; } });
    if (paused) manager.setQueuePaused(true);
    manager.continuationController = controller; controller.start();
  }
  async function until(predicate: () => boolean) {
    for (let i = 0; i < 200; i++) { await new Promise(r => setTimeout(r, 5)); await controller.settled(); if (predicate()) return; }
    throw new Error(JSON.stringify(controller.status()));
  }
  const status = () => controller.status() as any;
  async function losePersistedIdentity() {
    await manager.close();
    const file = path.join(continuationDirectory(state, manifest.workspaceId), "state.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8")), attempt = saved.nodes.U02.machineReview.attempts[0];
    const reviewer = attempt.reviewer; delete attempt.reviewer; attempt.state = "DISPATCHING";
    fs.writeFileSync(file, JSON.stringify(saved)); return reviewer;
  }
  it("lost accepted reply followed by restart recovers the same keyed upstream task", async () => {
    reviewHold = true; reviewLoseReply = true; boot(); await until(() => status().nodes.U02.state === "WAITING_REVIEW_RECOVERY");
    expect(reviewTasks.size).toBe(1); expect(status().machineReview.U02.reviewer).toBeNull();
    const accepted = [...reviewTasks.values()][0];
    await manager.close(); boot(false); await controller.settled();
    expect(status().machineReview.U02.reviewer.task_id).toBe(accepted.task_id);
    expect(reviewTasks.size).toBe(1); expect(reviewCalls).toHaveLength(2); expect(reviewCalls[1]).toEqual(reviewCalls[0]);
    expect(fake.turns).toBe(1);
  });
  it.each(["docs/report.md", "apps/web/index.ts"])("source changed after crash at %s recovers original identity and marks old PASS stale", async file => {
    reviewHold = true; boot(); await until(() => reviewCalls.length === 1);
    const reviewer = await losePersistedIdentity();
    write(root, file, "changed after dispatch crash");
    if (file.startsWith("apps/")) fake.fail = true;
    boot(false); await controller.settled();
    expect(status().machineReview.U02.reviewer).toEqual(reviewer);
    expect(reviewCalls[1]).toEqual(reviewCalls[0]); expect(reviewTasks.size).toBe(1);
    reviewAfterOutput = () => { reviewHold = true; };
    reviewHold = false; controller.wake("old-pass"); await controller.settled();
    expect(status().nodes.U02.machineReview.attempts[0].state).toBe("STALE");
    expect(status().machineReview.U02.lastValidReceipt).toBeNull(); expect(status().nodes.U03.taskIds).toEqual([]);
    if (!fake.fail) {
      reviewHold = true; controller.wake("new-source-review"); await controller.settled();
      expect(reviewCalls.at(-1).idempotency_key).not.toBe(reviewCalls[0].idempotency_key);
      expect(reviewCalls.at(-1).instruction).not.toBe(reviewCalls[0].instruction);
    }
  });
  it.each(["IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_UPGRADE_REQUIRED", "IDEMPOTENCY_INVALID"])("crash recovery blocks %s without a new key or Codex reviewer", async failure => {
    reviewHold = true; boot(); await until(() => reviewCalls.length === 1);
    await losePersistedIdentity(); reviewFailure = failure;
    boot(false); await controller.settled();
    expect(status().nodes.U02.state).toBe("BLOCKED_REVIEW");
    expect(status().machineReview.U02.state).toBe("DISPATCH_BLOCKED");
    if (failure === "IDEMPOTENCY_UPGRADE_REQUIRED") expect(status().nodes.U02.machineReview.attempts[0].error).toBe("REVIEW_Z2C_UPGRADE_REQUIRED");
    controller.wake("retry"); await controller.settled();
    expect(reviewCalls).toHaveLength(2); expect(reviewCalls[1]).toEqual(reviewCalls[0]);
    expect(reviewTasks.size).toBe(1); expect(fake.turns).toBe(1); expect(status().nodes.U03.taskIds).toEqual([]);
  });
  it("keeps legacy unkeyed DISPATCHING state uncertain without guessing a key", async () => {
    reviewHold = true; boot(); await until(() => reviewCalls.length === 1); await losePersistedIdentity();
    const file = path.join(continuationDirectory(state, manifest.workspaceId), "state.json"), saved = JSON.parse(fs.readFileSync(file, "utf8"));
    delete saved.nodes.U02.machineReview.attempts[0].reviewRequest;
    fs.writeFileSync(file, JSON.stringify(saved)); boot(false); await controller.settled();
    expect(status().machineReview.U02.state).toBe("REVIEW_DISPATCH_UNCERTAIN"); expect(reviewCalls).toHaveLength(1);
  });
  it.each(["pause", "lease", "revoke"])("does not recover an unbound intent while %s safety forbids dispatch", async gate => {
    reviewHold = true; boot(); await until(() => reviewCalls.length === 1); await losePersistedIdentity();
    if (gate === "lease") now += manifest.leaseMs;
    if (gate === "revoke") authorized = false;
    boot(false, gate === "pause"); await controller.settled();
    expect(reviewCalls).toHaveLength(1); expect(status().nodes.U03.taskIds).toEqual([]);
  });
  it("requires readonly independent PASS after executor completion and deterministic PASS", async () => {
    reviewHold = true; boot(); await until(() => reviewCalls.length === 1);
    expect(status().nodes.U02.evidence.status).toBe("completed");
    expect(status().nodes.U02.gate.passed).toBe(true);
    expect(status().nodes.U02.state).toBe("WAITING_REVIEW");
    expect(status().nodes.U03.taskIds).toEqual([]);
    expect(manager.getQueueState().activeTask).toBeNull();
    expect(reviewCalls[0]).toMatchObject({ write_scope: "readonly", mode: "plan" });
    expect(status().machineReview.U02.reviewer.model_binding).toMatchObject({ provider_id: "builtin:zai-start-plan", model_id: "GLM-5.3-Flash" });
    reviewHold = false; controller.wake("review-completed"); await until(() => status().state === "BACKLOG_COMPLETE");
    expect(status().machineReview.U02.lastValidReceipt.decision).toBe("PASS");
    expect(status().lastAuthenticatedChatGptReviewAt).toBeNull();
    expect(status().independentAcceptance).toBe("PENDING_CHATGPT");
  });
  it("recovers a known readonly reviewer across restart without duplicate dispatch or terminal receipt", async () => {
    reviewHold = true; boot(); await until(() => reviewCalls.length === 1);
    const reviewer = status().machineReview.U02.reviewer;
    await manager.close(); boot(false); await controller.settled();
    expect(reviewCalls).toHaveLength(1); expect(status().machineReview.U02.reviewer).toEqual(reviewer);
    reviewHold = false; controller.wake("review-completed"); await until(() => status().state === "BACKLOG_COMPLETE");
    const receipt = status().machineReview.U02.lastValidReceipt;
    controller.wake("duplicate-terminal"); controller.wake("duplicate-terminal"); await controller.settled();
    expect(reviewCalls).toHaveLength(2); expect(status().machineReview.U02.lastValidReceipt).toEqual(receipt);
  });
  it("recovers the accepted-reviewer / unpersisted-id crash window with one upstream task", async () => {
    reviewHold = true; boot(); await until(() => reviewCalls.length === 1); await manager.close();
    const file = path.join(continuationDirectory(state, manifest.workspaceId), "state.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    const attempt = saved.nodes.U02.machineReview.attempts[0], reviewer = attempt.reviewer; delete attempt.reviewer; attempt.state = "DISPATCHING";
    fs.writeFileSync(file, JSON.stringify(saved)); boot(false); await controller.settled();
    expect(status().machineReview.U02.reviewer).toEqual(reviewer);
    expect(reviewCalls[1]).toEqual(reviewCalls[0]); expect(reviewTasks.size).toBe(1);
    expect(status().events.find((e: any) => e.type === "review-dispatch-recovered").detail.upstreamReplayed).toBe(true);
    for (let i = 0; i < 4; i++) { controller.wake("restart"); await controller.settled(); }
    expect(reviewCalls).toHaveLength(2); expect(fake.turns).toBe(1); expect(status().nodes.U03.taskIds).toEqual([]);
    reviewHold = false; controller.wake("completion"); await until(() => status().state === "BACKLOG_COMPLETE");
    const receipt = status().machineReview.U02.lastValidReceipt, accepted = reviewTasks.size;
    controller.wake("duplicate-completion"); await controller.settled();
    expect(reviewTasks.size).toBe(accepted); expect(status().machineReview.U02.lastValidReceipt).toEqual(receipt);
  });
  it("Z2C unavailable retries only the same keyed request and never submits a Codex reviewer", async () => {
    reviewUnavailable = true; boot(); await until(() => status().nodes.U02.state === "WAITING_REVIEW_RECOVERY");
    for (let i = 0; i < 4; i++) { now += 5_000; controller.wake("retry"); await controller.settled(); }
    expect(reviewCalls.length).toBeGreaterThan(1); expect(reviewCalls.every(c => JSON.stringify(c) === JSON.stringify(reviewCalls[0]))).toBe(true);
    expect(reviewTasks.size).toBe(0); expect(fake.turns).toBe(1); expect(status().submitted).toBe(1);
  });
  it.each(["malformed", "missing", "wrong-fingerprint", "wrong-task", "wrong-schema", "oversized", "extra-identity"])("blocks %s reviewer output", async failure => {
    reviewOutput = receipt => {
      if (failure === "malformed") return "```json\n{}\n```";
      if (failure === "missing") return "";
      if (failure === "wrong-fingerprint") receipt.source_fingerprint = "0".repeat(64);
      if (failure === "wrong-task") receipt.reviewed_task_id = "c2c_00000000";
      if (failure === "wrong-schema") receipt.schema_version = 2;
      if (failure === "oversized") receipt.summary = "x".repeat(13000);
      if (failure === "extra-identity") receipt.provider = "codex";
      return JSON.stringify(receipt);
    };
    boot(); await until(() => status().nodes.U02.state === "BLOCKED_REVIEW");
    expect(status().nodes.U03.taskIds).toEqual([]); expect(fake.turns).toBe(1);
  });
  it.each(["model", "provider", "session", "workspace", "task", "output", "failed"])("blocks changed reviewer %s metadata", async field => {
    reviewHold = true; boot(); await until(() => reviewCalls.length === 1);
    const original = manager.getNative.bind(manager);
    manager.getNative = async (...args: Parameters<typeof manager.getNative>) => {
      const result = await original(...args);
      if (field === "model") result.model_binding = { ...result.model_binding!, model_id: "Codex" };
      if (field === "provider") result.model_binding = null;
      if (field === "session") result.session_id = `sess_${randomUUID()}`;
      if (field === "workspace") result.workspace_id = "other";
      if (field === "task") result.task_id = "z2c_other";
      if (field === "output") result.output_id = null;
      if (field === "failed") result.status = "failed";
      return result;
    };
    reviewHold = false; controller.wake("review-completed"); await controller.settled();
    expect(status().nodes.U02.state).toBe("BLOCKED_REVIEW"); expect(status().nodes.U03.taskIds).toEqual([]);
  });
  it.each(["docs/report.md", "apps/web/index.ts", "tests/a.ts"])("a %s mutation during review invalidates PASS", async file => {
    reviewAfterOutput = () => { write(root, file, "changed during review"); reviewHold = true; };
    boot(); await until(() => status().nodes.U02.machineReview?.attempts[0]?.state === "STALE");
    expect(status().nodes.U03.taskIds).toEqual([]); expect(status().machineReview.U02.lastValidReceipt).toBeNull();
  });
  it("caps stale review dispatches at three", async () => {
    reviewAfterOutput = () => write(root, "docs/report.md", `mutation ${reviewCalls.length}`);
    boot(); await until(() => status().nodes.U02.machineReview?.attempts[0]?.state === "STALE");
    for (let i = 0; i < 5; i++) { controller.wake("freshness"); await controller.settled(); }
    expect(reviewCalls).toHaveLength(3); expect(status().nodes.U02.state).toBe("BLOCKED_REVIEW"); expect(fake.turns).toBe(1);
  });
  it("bounds known reviewer timeout without retry", async () => {
    reviewHold = true; boot(); await until(() => reviewCalls.length === 1);
    now += 600001; controller.wake("elapsed"); await controller.settled();
    expect(status().nodes.U02.state).toBe("BLOCKED_REVIEW"); expect(reviewCalls).toHaveLength(1);
  });
  it("wakes ACTIVE review within ten seconds without ChatGPT or duplicate submissions", async () => {
    reviewHold = true; manifest.maxNewTasks = 1; boot(); await until(() => reviewCalls.length === 1);
    // Restart with timers faked so both controller timers are under the same clock.
    await manager.close(); vi.useFakeTimers(); boot(false); await controller.settled();
    const collectorCount = collections;
    expect((controller as any).reviewTimer.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000); await controller.settled();
    expect(reviewCalls).toHaveLength(1); expect(collections).toBe(collectorCount);
    reviewHold = false;
    await vi.advanceTimersByTimeAsync(10_000); await controller.settled();
    expect(status().nodes.U02.state).toBe("STABLE"); expect(reviewCalls).toHaveLength(1);
    expect((controller as any).reviewTimer).toBeNull();
    controller.close(); expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
  it.each(["success", "failure", "workspace", "task", "session", "model", "provider", "pending"])("timeout cancellation preserves exact reviewer truth: %s", async outcome => {
    reviewHold = true; boot(); await until(() => reviewCalls.length === 1);
    const reviewer = status().machineReview.U02.reviewer;
    const cancel = vi.spyOn(manager, "cancelNative").mockImplementation(async () => {
      if (outcome === "failure") throw new Error("offline");
      const result = { ...reviewTasks.get(reviewer.task_id)!, status: "cancelled", model_binding: { ...reviewer.model_binding } };
      if (outcome === "workspace") result.workspace_id = "other";
      if (outcome === "task") result.task_id = "z2c_other";
      if (outcome === "session") result.session_id = `sess_${randomUUID()}`;
      if (outcome === "model") result.model_binding.model_id = "Codex";
      if (outcome === "provider") result.model_binding.provider_id = "codex";
      if (outcome === "pending") result.status = "cancelling";
      return result;
    });
    now += REVIEW_TIMEOUT_MS; controller.wake("elapsed"); await controller.settled();
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ workspace_id: reviewer.workspace_id, task_id: reviewer.task_id }, true);
    const attempt = status().nodes.U02.machineReview.attempts[0];
    expect(attempt).toMatchObject({ state: "BLOCKED", reviewer, cancellation: outcome === "success" ? "CONFIRMED" : "UNCONFIRMED" });
    expect(attempt.error).toBe(outcome === "success" ? "REVIEW_TIMEOUT" : "REVIEW_TIMEOUT_CANCELLATION_UNCONFIRMED");
    controller.wake("again"); await controller.settled();
    expect(cancel).toHaveBeenCalledTimes(1); expect(reviewCalls).toHaveLength(1); expect(status().nodes.U03.taskIds).toEqual([]);
    await manager.close(); boot(false); await controller.settled();
    expect(status().state).not.toBe("BROKEN_CONTINUATION"); expect(status().nodes.U03.taskIds).toEqual([]);
  });
  it("retries a timed out unbound dispatch only with its original key and never guesses a cancellation id", async () => {
    reviewUnavailable = true; boot(); await until(() => status().nodes.U02.state === "WAITING_REVIEW_RECOVERY");
    const cancel = vi.spyOn(manager, "cancelNative");
    now += REVIEW_TIMEOUT_MS; controller.wake("elapsed"); await controller.settled();
    expect(cancel).not.toHaveBeenCalled(); expect(reviewCalls.length).toBeGreaterThan(1);
    expect(reviewCalls.at(-1)).toEqual(reviewCalls[0]); expect(status().nodes.U03.taskIds).toEqual([]);
  });
  it("cancels a timed out known review while paused and the source is unsafe", async () => {
    reviewHold = true; boot(); await until(() => reviewCalls.length === 1);
    manager.setQueuePaused(true);
    write(root, "docs/oversized.bin", Buffer.alloc(16 * 1024 * 1024 + 1));
    const cancel = vi.spyOn(manager, "cancelNative").mockRejectedValue(new Error("offline"));
    now += REVIEW_TIMEOUT_MS; controller.wake("elapsed"); await controller.settled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(status().nodes.U02.machineReview.attempts[0].cancellation).toBe("UNCONFIRMED");
    expect(status().nodes.U03.taskIds).toEqual([]); expect((controller as any).reviewTimer).toBeNull();
  });
  it.each(["pause", "lease", "revoke"])("preserves %s while an independent review completes", async control => {
    reviewAfterOutput = () => {
      if (control === "pause") manager.setQueuePaused(true);
      if (control === "lease") now += manifest.leaseMs + 1;
      if (control === "revoke") authorized = false;
    };
    boot(); await until(() => status().machineReview.U02.attempts === 1);
    expect(status().nodes.U03.taskIds).toEqual([]); expect(fake.turns).toBe(1);
  });
  it("REWORK executes only approved corrective input and requires another review", async () => {
    manifest.nodes[0].correctiveInputs = ["Approved corrective input"];
    reviewOutput = receipt => JSON.stringify({ ...receipt, decision: reviewCalls.length === 1 ? "REWORK" : "PASS" });
    boot(); await until(() => status().nodes.U02.state === "STABLE");
    expect(reviewCalls.length).toBeGreaterThanOrEqual(2);
    expect(status().nodes.U02.taskIds).toHaveLength(2);
  });
  it("REWORK without approved correction never invents executor input", async () => {
    reviewOutput = receipt => JSON.stringify({ ...receipt, decision: "REWORK" });
    boot(); await until(() => status().nodes.U02.state === "REWORK");
    controller.wake("retry"); await controller.settled(); expect(fake.turns).toBe(1);
  });
  it("verification nodes require review without running the UI source gate", async () => {
    manifest.nodes = [{ ...manifest.nodes[0], kind: "verification", writeScope: ["tests", "docs"] }];
    reviewHold = true; boot(); await until(() => reviewCalls.length === 1);
    expect(status().nodes.U02.gate).toBeUndefined(); expect(status().nodes.U02.state).toBe("WAITING_REVIEW");
    reviewHold = false; controller.wake("review-completed"); await controller.settled(); expect(status().nodes.U02.state).toBe("STABLE");
  });
  it.each(["workspace", "schema", "task", "extra", "receipt", "blocked-identity", "stale-identity", "key", "prompt"])("rejects invalid persisted review %s", async field => {
    reviewHold = true; boot(); await until(() => reviewCalls.length === 1); await manager.close();
    const file = path.join(continuationDirectory(state, manifest.workspaceId), "state.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8")), attempt = saved.nodes.U02.machineReview.attempts[0];
    if (field === "workspace") attempt.reviewer.workspace_id = "another";
    if (field === "key") attempt.reviewRequest.idempotency_key = randomUUID();
    if (field === "prompt") attempt.reviewRequest.instruction += "changed";
    if (field === "schema") attempt.state = "STABLE";
    if (field === "task") attempt.executorTaskId = "c2c_00000000";
    if (field === "extra") attempt.instruction = "unapproved";
    if (field === "receipt") attempt.state = "PASS";
    if (field === "blocked-identity" || field === "stale-identity") { attempt.state = field === "blocked-identity" ? "BLOCKED" : "STALE"; delete attempt.reviewer; }
    fs.writeFileSync(file, JSON.stringify(saved)); boot(false); await controller.settled();
    expect(status().state).toBe("BROKEN_CONTINUATION"); expect(reviewCalls).toHaveLength(1);
  });
  it("uses a deterministic docs-inclusive review fingerprint independent of the web gate", () => {
    const before = reviewFingerprint(root, manifest.nodes[0]), gateBefore = verificationFingerprint(root);
    expect(before).toBeTruthy(); expect(reviewFingerprint(root, manifest.nodes[0])).toBe(before);
    write(root, "docs/report.md", "docs-only mutation");
    expect(verificationFingerprint(root)).toBe(gateBefore); expect(reviewFingerprint(root, manifest.nodes[0])).not.toBe(before);
    const changed = reviewFingerprint(root, manifest.nodes[0]);
    write(root, "docs/audit-loop-state.md", "mirror change"); write(root, "dist/generated.js", "generated");
    expect(reviewFingerprint(root, manifest.nodes[0])).toBe(changed);
    write(root, "var/db/unrelated.bin", "database mutation");
    expect(reviewFingerprint(root, manifest.nodes[0])).toBe(changed);
    write(root, "var/db/unrelated.bin", "another database mutation");
    expect(reviewFingerprint(root, manifest.nodes[0])).toBe(changed);
    write(root, "src/relevant.ts", "source mutation");
    expect(reviewFingerprint(root, manifest.nodes[0])).not.toBe(changed);
    const sourceChanged = reviewFingerprint(root, manifest.nodes[0]);
    write(root, "vitest.config.ts", "root config mutation");
    expect(reviewFingerprint(root, manifest.nodes[0])).not.toBe(sourceChanged);
    expect(reviewFingerprint(root, { ...manifest.nodes[0], instruction: "different governance" })).not.toBe(reviewFingerprint(root, manifest.nodes[0]));
  });
  it("invalidates a saved PASS on docs-only edits before dependency release", async () => {
    manifest.maxNewTasks = 1; boot(); await until(() => status().error === "TASK_BUDGET_EXHAUSTED");
    expect(status().machineReview.U02.lastValidReceipt?.decision).toBe("PASS");
    reviewHold = true; write(root, "docs/report.md", "later docs edit");
    expect(status().machineReview.U02.lastValidReceipt).toBeNull();
    controller.wake("freshness"); await controller.settled();
    expect(status().nodes.U02.machineReview.attempts[0].state).toBe("STALE");
    expect(status().machineReview.U02.lastValidReceipt).toBeNull();
    expect(status().nodes.U02.state).not.toBe("STABLE"); expect(status().nodes.U03.taskIds).toEqual([]);
  });
  it("polls a known reviewer to STALE even when changed source fails the web gate", async () => {
    reviewHold = true; boot(); await until(() => reviewCalls.length === 1);
    write(root, "apps/web/index.ts", "broken source"); fake.fail = true; reviewHold = false;
    controller.wake("review-completed"); await controller.settled();
    expect(status().nodes.U02.machineReview.attempts[0].state).toBe("STALE");
    expect(status().nodes.U02.gate.passed).toBe(false); expect(status().nodes.U03.taskIds).toEqual([]);
  });
  it("rejects fingerprint symlinks, including ancestor junctions, and oversized files", () => {
    const link = path.join(root, "docs/linked");
    fs.symlinkSync(native, link, "junction");
    try { expect(reviewFingerprint(root, manifest.nodes[0])).toBeNull(); expect(reviewFingerprint(link, manifest.nodes[0])).toBeNull(); }
    finally { fs.unlinkSync(link); }
    fs.writeFileSync(path.join(root, "docs/large.bin"), Buffer.alloc(16 * 1024 * 1024 + 1));
    expect(reviewFingerprint(root, manifest.nodes[0])).toBeNull();
  });
  it("rejects a previously read source mutated later in the fingerprint walk", () => {
    const original = fs.readSync;
    let mutated = false;
    vi.spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const result = (original as any)(...args);
      // The first one-byte growth probe follows the source read; mutate after its immediate checks.
      if (!mutated && (args[1] as Buffer).length === 7) {
        mutated = true; write(root, "apps/web/index.ts", "changed earlier source after its read");
      }
      return result;
    }) as typeof fs.readSync);
    expect(reviewFingerprint(root, manifest.nodes[0])).toBeNull(); expect(mutated).toBe(true);
  });
  it.each(["REWORK", "BLOCKED"])("does not label historical PASS valid after a fresh %s receipt", async decision => {
    manifest.maxNewTasks = 1; boot(); await until(() => status().error === "TASK_BUDGET_EXHAUSTED");
    expect(status().machineReview.U02.lastValidReceipt?.decision).toBe("PASS");
    write(root, "docs/report.md", "changed acceptance input");
    reviewOutput = receipt => JSON.stringify({ ...receipt, decision });
    controller.wake("freshness"); await controller.settled();
    expect(status().nodes.U02.machineReview.attempts.at(-1).state).toBe(decision);
    expect(status().machineReview.U02.lastValidReceipt).toBeNull(); expect(status().nodes.U03.taskIds).toEqual([]);
  });
  it("rejects a protected continuation workspace directory replaced by a junction", async () => {
    reviewHold = true; boot(); await until(() => reviewCalls.length === 1); await manager.close();
    const dir = continuationDirectory(state, manifest.workspaceId), archived = `${dir}-fixture`;
    fs.renameSync(dir, archived); fs.symlinkSync(archived, dir, "junction");
    try { expect(() => new ContinuationController(manager, { authorize: () => true })).toThrow(/regular protected/); }
    finally { fs.unlinkSync(dir); fs.renameSync(archived, dir); }
  });
  it("architecture gate: a paused U02/U03 approval remains frozen across review_due and restart", async () => {
    boot(true, true); await controller.settled();
    now += 3600001; controller.wake("review_due"); await controller.settled();
    expect(fake.turns).toBe(0); expect(status().submitted).toBe(0);
    expect(status().lastAuthenticatedChatGptReviewAt).toBeNull();
    expect(status().independentAcceptance).toBe("PENDING_CHATGPT");
    await manager.close(); boot(false); await controller.settled();
    expect(manager.getQueueState().paused).toBe(true); expect(fake.turns).toBe(0);
  });
  it("architecture gate: later successful verification cannot accept an actual failed command", async () => {
    fake.fail = true; boot(); await until(() => status().nodes.U02.state === "FAILED");
    fake.fail = false; write(root, "apps/web/index.ts", "export const repaired = 2;");
    controller.wake("review_due"); await controller.settled();
    expect(status().nodes.U02.state).toBe("FAILED");
    expect(status().nodes.U03.taskIds).toEqual([]); expect(fake.turns).toBe(1);
  });
  it.each(["running", "failed", "cancelled"])("architecture gate: stale %s snapshots cannot reverse a terminal node after restart", async staleStatus => {
    boot(); await until(() => status().state === "BACKLOG_COMPLETE");
    await manager.close(); boot(false); await controller.settled();
    const original = manager.get.bind(manager);
    manager.get = ((...args: Parameters<typeof manager.get>) => ({ ...original(...args), status: staleStatus })) as typeof manager.get;
    controller.wake("stale-event"); await controller.settled();
    expect(status().nodes.U02.state).toBe("STABLE"); expect(status().nodes.U03.state).toBe("STABLE");
    expect(status().nodes.U03.evidence.status).toBe("completed"); expect(fake.turns).toBe(2);
  });
  it("architecture gate: exact current-turn model mismatch blocks acceptance and successors", async () => {
    fake.hold = true; boot(); await until(() => fake.turns === 1);
    const date = new Date().toISOString().slice(0, 10).replaceAll("-", "/");
    const file = path.join(native, `sessions/${date}/rollout-${fake.threadId}.jsonl`);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"model":"gpt-6-astra"', '"model":"other-model"'));
    fake.complete(); await until(() => status().nodes.U02.state === "WAITING_REVIEW");
    expect(status().nodes.U03.taskIds).toEqual([]); expect(fake.turns).toBe(1);
  });
  afterEach(async () => {
    vi.useRealTimers(); vi.restoreAllMocks();
    await manager?.close();
    if (oldNative === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldNative;
    cleanup(root); cleanup(state); cleanup(native);
  });
  it("dispatches terminal → next automatically with exact native model and stable source proof", async () => {
    boot(); await until(() => status().state === "BACKLOG_COMPLETE");
    expect(fake.turns).toBe(2); expect(status().events.filter((e: any) => e.type === "handoff")).toHaveLength(2);
    expect(fake.requests.filter(r => r.method === "turn/start").every(r => r.params.model === "gpt-6-astra" && r.params.effort === "high")).toBe(true);
    expect(status().nodes.U02.evidence.actualModel.source).toBe("native_turn_context");
  });
  it("does not duplicate on finish callbacks or restart", async () => {
    boot(); await until(() => status().state === "BACKLOG_COMPLETE");
    controller.wake("terminal"); controller.wake("terminal"); await controller.settled();
    await manager.close(); boot(false); await controller.settled();
    expect(fake.turns).toBe(2); expect(collections).toBeLessThan(8);
  });
  it("recovers the enqueue / controller persist crash window", async () => {
    boot(); await until(() => status().state === "BACKLOG_COMPLETE"); await manager.close();
    const file = path.join(continuationDirectory(state, manifest.workspaceId), "state.json");
    const s = JSON.parse(fs.readFileSync(file, "utf8")); s.nodes.U02 = { taskIds: [], state: "PENDING" }; s.nodes.U03 = { taskIds: [], state: "PENDING" }; s.submitted = 0;
    fs.writeFileSync(file, JSON.stringify(s)); boot(false); await controller.settled();
    expect(fake.turns).toBe(2); expect(status().submitted).toBe(2);
  });
  it("blocks dependents on regression failure while independent approved work progresses", async () => {
    manifest.nodes.push({ ...manifest.nodes[0], id: "NORMAL_RUNNER", idempotencyKey: "normal", kind: "verification", writeScope: ["tests", "docs"] });
    fake.fail = true; boot(); await until(() => fake.turns === 2 && status().state === "WAITING_REVIEW");
    expect(status().nodes.U03.taskIds).toEqual([]); expect(status().nodes.NORMAL_RUNNER.taskIds).toHaveLength(1);
  });
  it("preserves user pause across restart and explicit cancellation stops continuation", async () => {
    fake.hold = true; boot(); await until(() => fake.turns === 1);
    manager.setQueuePaused(true); await manager.cancel(status().nodes.U02.taskIds[0], { ownerId: "owner" });
    await until(() => status().state === "PAUSED_BY_USER"); await manager.close(); boot(false); await controller.settled();
    manager.setQueuePaused(false); await controller.settled(); expect(status().state).toBe("PAUSED_BY_USER"); expect(fake.turns).toBe(1);
  });
  it("enforces lease expiration and total dispatch budget", async () => {
    manifest.maxNewTasks = 1; boot(); await until(() => status().error === "TASK_BUDGET_EXHAUSTED"); expect(fake.turns).toBe(1);
    now += 86400001; controller.wake("elapsed"); await controller.settled(); expect(status().error).toBe("LEASE_EXPIRED");
  });
  it("uses only two distinct approved corrective retries", async () => {
    manifest.nodes[0].correctiveInputs = ["Correct failed bounded input one", "Correct failed bounded input two"]; fake.fail = true;
    boot(); await until(() => status().state === "WAITING_REVIEW" && fake.turns === 3); expect(status().submitted).toBe(3);
  });
  it("fails closed on missing owner grant or native model mismatch", async () => {
    authorized = false; boot(); await controller.settled(); expect(status().state).toBe("BROKEN_CONTINUATION"); expect(fake.turns).toBe(0);
    authorized = true; fake.model = "other-model"; controller.wake("restart"); await until(() => status().nodes.U02.state === "FAILED"); expect(fake.turns).toBe(0);
  });
  it("rejects wrong model, scope, duplicate corrective input and untrusted fields", () => {
    for (const patch of [{ model: "fallback" }, { writeScope: ["../src"] }, { correctiveInputs: [manifest.nodes[0].instruction] }, { surprise: true }]) {
      expect(() => installApprovedManifest(state, { ...manifest, nodes: [{ ...manifest.nodes[0], ...patch }] })).toThrow();
    }
  });
  it("detects manifest tampering and stays default off", async () => {
    boot(false); expect(status().state).toBe("DISABLED"); await manager.close();
    installApprovedManifest(state, manifest);
    const file = path.join(continuationDirectory(state, manifest.workspaceId), "approved-manifest.json");
    fs.writeFileSync(file, JSON.stringify({ ...manifest, ownerId: "attacker" })); boot(false);
    expect(status().state).toBe("BROKEN_CONTINUATION"); expect(fake.turns).toBe(0);
  });
  it("reports stale reviewer and mirror failure without silently accepting", async () => {
    mirrorFail = true; boot(); await until(() => status().state === "BACKLOG_COMPLETE");
    expect(status().review).toBe("REVIEW_OVERDUE"); expect(status().error).toBe("AUDIT_COLLECTOR_OR_MIRROR_FAILED");
    expect(status().independentAcceptance).toBe("PENDING_CHATGPT");
  });
  it("holds conflicting audit writers and never starts a worker inside collection", async () => {
    boot(false);
    let release!: () => void;
    const held = manager.withIdleCollector(() => new Promise<void>(r => { release = r; }));
    await expect(manager.withIdleCollector(async () => {})).rejects.toThrow("ownership wait");
    const task = manager.submit({ workspace_id: manifest.workspaceId, instruction: "manual fixture", write_scope: ["apps/web"], run_tests: false }, { ownerId: "owner" });
    expect(task.status).toBe("queued"); expect(fake.turns).toBe(0); release(); await held;
    await until(() => fake.turns === 1);
  });
  it("terminates at the approved task timeout through the official lifecycle", async () => {
    manifest.nodes[0].timeoutMs = 100; fake.hold = true; boot();
    await until(() => status().nodes.U02.state === "FAILED");
    expect(status().nodes.U02.evidence.error.code).toBe("TASK_TIMEOUT");
    expect(fake.requests.some(r => r.method === "turn/interrupt")).toBe(true);
    expect(fake.turns).toBe(1);
  });
  it("raises a visible health failure for ready queued work without a writer for over 120 seconds", async () => {
    boot(); await until(() => status().state === "BACKLOG_COMPLETE");
    const original = manager.getQueueState.bind(manager);
    manager.getQueueState = () => ({ ...original(), activeTask: null, queuedTaskCount: 1 });
    controller.wake("elapsed"); await controller.settled(); now += 120001;
    controller.wake("elapsed"); await controller.settled(); expect(status().health).toBe("BROKEN_CONTINUATION");
  });
  it("records authenticated correlations without inventing a ChatGPT review receipt", async () => {
    boot(); await until(() => status().state === "BACKLOG_COMPLETE");
    controller.observeRequest("owner", "hourly-probe-1");
    const file = path.join(continuationDirectory(state, manifest.workspaceId), "supervision-observations.json");
    const observations = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(observations[0]).toMatchObject({ authenticated: true, correlation: "hourly-probe-1", requestOrigin: "unknown", chatGptScheduledAudit: "unverified" });
    expect(status().lastAuthenticatedChatGptReviewAt).toBeNull();
    expect(controller.status("another-owner")).toEqual({ state: "DISABLED" });
  });
  it("does not busy-retry a failed mirror after waiting for the product writer", async () => {
    fake.hold = true; boot(); await until(() => fake.turns === 1);
    now += 3600001; controller.wake("elapsed"); await controller.settled(); expect(status().mirror.state).toBe("OWNERSHIP_WAIT");
    mirrorFail = true; fake.hold = false; fake.complete(); await until(() => status().state === "BACKLOG_COMPLETE");
    expect(status().mirror.state).toBe("FAILED"); expect(collections).toBeLessThan(6);
  });
});
