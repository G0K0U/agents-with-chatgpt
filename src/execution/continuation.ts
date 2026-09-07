import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { ensureDir, writeSecureJson } from "../config/paths.js";
import type { CodexTaskManager, CodexTaskView } from "./tasks.js";
import { sanitizeExecutionCommand } from "./sanitize.js";
import { ZcodeNativeError, ZCODE_IDEMPOTENCY_PROTOCOL, assertNativeIdempotency, nativeRequestFingerprint } from "./zcode-native.js";
import { observeNativeModel, verificationFingerprint } from "./continuation-evidence.js";
import { verifyWebSource, sourceGatePassed, type SourceGate } from "./continuation-verifier.js";
import { machineReviewSchema, reviewFingerprint, reviewIdentity, reviewPrompt, parseReviewReceipt,
  MAX_REVIEW_ATTEMPTS, REVIEW_TIMEOUT_MS, type MachineReview, type ReviewAttempt } from "./continuation-review.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const nodeSchema = z.object({
  id, provider: z.literal("codex"), model: z.literal("gpt-6-astra"), effort: z.literal("high"),
  instruction: z.string().min(1).max(8000), writeScope: z.array(z.string().min(1).max(300)).min(1).max(16),
  network: z.boolean(), networkBoundary: z.enum(["offline", "existing-loopback-only"]),
  dependencies: z.array(id).max(12), idempotencyKey: id,
  timeoutMs: z.number().int().min(100).max(30 * 60_000),
  correctiveInputs: z.array(z.string().min(1).max(8000)).max(2),
  externalTaskId: z.string().regex(/^c2c_[a-f0-9]{8,32}$/).optional(),
  kind: z.enum(["ui", "verification"]),
}).strict();
export const manifestSchema = z.object({
  version: z.literal(1), planId: id, workspaceId: id, ownerId: z.string().min(1).max(128),
  approvedAt: z.string().datetime(), authorizationReference: z.string().min(1).max(200),
  enabled: z.literal(true), leaseMs: z.number().int().positive().max(24 * 60 * 60_000),
  maxNewTasks: z.number().int().min(1).max(12), nodes: z.array(nodeSchema).min(1).max(12),
}).strict();
export type ApprovedManifest = z.infer<typeof manifestSchema>;
export type ApprovedNode = ApprovedManifest["nodes"][number];
type NodeState = { taskIds: string[]; state: string; evidence?: unknown; gate?: SourceGate; gateTaskId?: string; gateAttempts?: string[]; machineReview?: MachineReview };
interface ControllerState {
  version: 1; manifestHash: string; activatedAt: number | null; paused: boolean; cancelled: boolean;
  submitted: number; nodes: Record<string, NodeState>; state: string; error: string | null;
  readySince: number | null; lastCheckpointAt: number | null; mirror: unknown;
  challenge: string; generatedAt: string; events: Array<{ id: string; at: string; type: string; detail: unknown }>;
}
export interface ContinuationHooks {
  authorize(owner: string, workspace: string, scope: string): boolean;
  collect?(manifest: ApprovedManifest, snapshot: unknown, eventId: string): Promise<unknown>;
  now?: () => number;
  verify?: typeof verifyWebSource;
}

export function continuationDirectory(stateDir: string, workspaceId: string): string {
  id.parse(workspaceId);
  const root = ensureDir(path.join(stateDir, "continuation"));
  const dir = ensureDir(path.join(root, workspaceId));
  for (const candidate of [stateDir, root, dir]) {
    if (fs.lstatSync(candidate).isSymbolicLink() || path.resolve(fs.realpathSync.native(candidate)).toLowerCase() !== path.resolve(candidate).toLowerCase()) {
      throw new Error("Continuation state must be a regular protected state directory");
    }
  }
  return dir;
}

/** Local deployment entry point only. No MCP manifest loader and no repository instruction discovery. */
export function installApprovedManifest(stateDir: string, input: unknown): string {
  const manifest = validateManifest(input);
  const dir = continuationDirectory(stateDir, manifest.workspaceId);
  const file = path.join(dir, "approved-manifest.json");
  if (fs.existsSync(file)) {
    if (hash(readRegular(file)) !== hash(manifest)) throw new Error("An existing approval cannot be replaced implicitly");
    return file;
  }
  // Approval anchor is separate from the mutable controller journal. Protected state access is the trust boundary.
  writeSecureJson(path.join(dir, "approval.json"), { manifestHash: hash(manifest), ownerId: manifest.ownerId });
  writeSecureJson(file, manifest);
  return file;
}
function readRegular(file: string): unknown {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("Invalid protected continuation record");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function validateManifest(input: unknown): ApprovedManifest {
  const manifest = manifestSchema.parse(input);
  const seen = new Set<string>();
  const keys = new Set<string>();
  for (const node of manifest.nodes) {
    if (seen.has(node.id) || keys.has(node.idempotencyKey) || node.dependencies.some(d => !seen.has(d))) throw new Error("Duplicate or non-topological approved node");
    if (new Set([node.instruction, ...node.correctiveInputs]).size !== node.correctiveInputs.length + 1) throw new Error("Retries require changed corrective input");
    if (node.network !== (node.networkBoundary === "existing-loopback-only")) throw new Error("Network boundary mismatch");
    if (node.writeScope.some(s => !/^(apps\/web|apps\/api\/tests|apps\/runner\/tests|tests|docs)(\/[A-Za-z0-9_.-]+)*$/.test(s) || s.split("/").includes(".."))) throw new Error("Unapproved write root");
    if (node.kind === "ui" && node.writeScope.some(s => !/^(apps\/web|docs)(\/|$)/.test(s))) throw new Error("UI scope mismatch");
    if (node.kind === "verification" && node.writeScope.some(s => !/^(apps\/api\/tests|apps\/runner\/tests|tests|docs)(\/|$)/.test(s))) throw new Error("Verification scope mismatch");
    seen.add(node.id); keys.add(node.idempotencyKey);
  }
  return manifest;
}

/** Executor dispatch uses submit; independent readonly review uses submitNative exclusively. */
export class ContinuationController {
  private readonly runtimeLoadedAt = new Date().toISOString();
  private readonly loadedControllerSha256 = createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex");
  private serial: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private reviewTimer: NodeJS.Timeout | null = null;
  private reviewRetryAt = new Map<string, number>();
  private closed = false;
  private readonly dir: string;
  private readonly now: () => number;
  private manifest: ApprovedManifest | null = null;
  private state: ControllerState | null = null;
  private loadError: string | null = null;
  constructor(private readonly manager: CodexTaskManager, private readonly hooks: ContinuationHooks) {
    this.dir = continuationDirectory(manager.stateDir, manager.workspace.id);
    this.now = hooks.now ?? Date.now;
    try {
      const file = path.join(this.dir, "approved-manifest.json");
      if (!fs.existsSync(file)) return; // Default off, including after restart.
      this.manifest = validateManifest(readRegular(file));
      const approval = readRegular(path.join(this.dir, "approval.json")) as { manifestHash: string; ownerId: string };
      if (this.manifest.workspaceId !== manager.workspace.id || approval.manifestHash !== hash(this.manifest) || approval.ownerId !== this.manifest.ownerId) throw new Error("Approval integrity mismatch");
      const stateFile = path.join(this.dir, "state.json");
      this.state = fs.existsSync(stateFile) ? readRegular(stateFile) as ControllerState : {
        version: 1, manifestHash: hash(this.manifest), activatedAt: null, paused: false, cancelled: false,
        submitted: 0, nodes: Object.fromEntries(this.manifest.nodes.map(n => [n.id, { taskIds: n.externalTaskId ? [n.externalTaskId] : [], state: "PENDING" }])),
        state: "ACTIVATION_PENDING", error: null, readySince: null, lastCheckpointAt: null, mirror: null,
        challenge: randomUUID(), generatedAt: new Date(this.now()).toISOString(), events: [],
      };
      if (!fs.existsSync(stateFile) && fs.existsSync(path.join(this.dir, "acceptance-probe.json"))) {
        const probe = readRegular(path.join(this.dir, "acceptance-probe.json")) as { challenge: string; generatedAt: string };
        if (typeof probe.challenge !== "string" || !/^[0-9a-f-]{36}$/.test(probe.challenge) || !Number.isFinite(Date.parse(probe.generatedAt))) throw new Error("Invalid acceptance probe");
        this.state.challenge = probe.challenge; this.state.generatedAt = probe.generatedAt;
      }
      if (this.state.version !== 1 || this.state.manifestHash !== approval.manifestHash || typeof this.state.paused !== "boolean" || typeof this.state.cancelled !== "boolean" || !Number.isInteger(this.state.submitted) || this.state.submitted < 0 || !Array.isArray(this.state.events) || this.manifest.nodes.some(n => !Array.isArray(this.state?.nodes[n.id]?.taskIds))) throw new Error("Controller state invalid");
      if (Object.keys(this.state.nodes).sort().join() !== this.manifest.nodes.map(n => n.id).sort().join()) throw new Error("Unknown persisted node");
      const reviewerIds = new Set<string>(), intentIds = new Set<string>();
      for (const node of this.manifest.nodes) {
        const ns = this.state.nodes[node.id];
        if (ns.taskIds.length > 3 || ns.taskIds.some(t => !/^c2c_[a-f0-9]{8,32}$/.test(t))) throw new Error("Invalid executor history");
        if (ns.machineReview !== undefined) {
          ns.machineReview = machineReviewSchema.parse(ns.machineReview);
          for (const attempt of ns.machineReview.attempts) {
            if (!ns.taskIds.includes(attempt.executorTaskId) || intentIds.has(attempt.intentId) ||
                (attempt.reviewRequest && attempt.reviewRequest.workspace_id !== manager.workspace.id) ||
                (attempt.reviewer && (attempt.reviewer.workspace_id !== manager.workspace.id || reviewerIds.has(attempt.reviewer.task_id)))) throw new Error("Cross-node/workspace review state");
            intentIds.add(attempt.intentId);
            if (attempt.reviewer) reviewerIds.add(attempt.reviewer.task_id);
            if (attempt !== ns.machineReview.attempts.at(-1) && ["ACTIVE", "DISPATCHING", "REVIEW_DISPATCH_UNCERTAIN", "DISPATCH_BLOCKED", "BLOCKED", "PASS"].includes(attempt.state)) throw new Error("Invalid review attempt ordering");
            if (attempt.state === "DISPATCHING" && !attempt.reviewRequest) { attempt.state = "REVIEW_DISPATCH_UNCERTAIN"; attempt.error = "LEGACY_UNKEYED_DISPATCH_REQUIRES_REPAIR"; }
            if (attempt.state === "REVIEW_DISPATCH_UNCERTAIN") ns.state = attempt.state;
            if (attempt.cancellation === "PENDING") {
              attempt.cancellation = "UNCONFIRMED"; attempt.error = "REVIEW_TIMEOUT_CANCELLATION_UNCONFIRMED";
            }
          }
        }
        // Legacy deterministic-only STABLE cannot grandfather a review receipt.
        if (ns.state === "STABLE" && ns.machineReview?.attempts.at(-1)?.state !== "PASS") ns.state = "WAITING_REVIEW";
      }
    } catch { this.loadError = "Protected continuation approval/state invalid; explicit repair required"; }
  }
  start(): void {
    if (!this.manifest || this.loadError) return;
    this.wake("restart");
    // Health/checkpoint timer only. It never starts a separate worker or restarts the bridge.
    this.timer = setInterval(() => this.wake("elapsed"), 60_000);
    this.timer.unref();
  }
  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.reviewTimer) clearTimeout(this.reviewTimer);
    this.timer = null; this.reviewTimer = null;
  }
  private scheduleReviewWake(): void {
    if (this.reviewTimer) clearTimeout(this.reviewTimer);
    this.reviewTimer = null;
    if (this.closed || this.loadError) return;
    const active = Object.values(this.state?.nodes ?? {}).flatMap(ns => ns.machineReview?.attempts ?? []).filter(a => a.state === "ACTIVE" || (a.state === "DISPATCHING" && a.reviewRequest));
    if (!active.length) return;
    const oldest = Math.min(...active.map(a => a.dispatchedAt));
    const deadline = Math.min(...active.map(a => a.state === "ACTIVE" ? a.deadline : this.now() + 10_000));
    // One unref wake of the existing serialized controller; no worker or collector loop.
    const delay = Math.max(1, Math.min(10_000, 5_000 + Math.max(0, this.now() - oldest) / 60, deadline - this.now()));
    this.reviewTimer = setTimeout(() => { this.reviewTimer = null; this.wake("active-review"); }, delay);
    this.reviewTimer.unref();
  }
  wake(reason: string): void {
    this.serial = this.serial.then(() => this.reconcile(reason)).catch(() => {
      if (this.state) { this.state.state = "BROKEN_CONTINUATION"; this.state.error = "Controller reconciliation failed; inspect protected evidence"; this.save(); }
    }).finally(() => this.scheduleReviewWake());
  }
  async settled(): Promise<void> { await this.serial; }
  authorizesTask(task: { ownerId?: string; workspaceId: string; instructionHash: string; writeScope: string[]; network: boolean; continuation?: { idempotencyKey: string; model: string; effort: string; timeoutMs: number } }): boolean {
    const m = this.manifest, s = this.state, pin = task.continuation;
    if (!m || !s || !pin || this.loadError || s.paused || s.cancelled || s.activatedAt === null || this.now() >= s.activatedAt + m.leaseMs || task.ownerId !== m.ownerId || task.workspaceId !== m.workspaceId || !this.hooks.authorize(m.ownerId, m.workspaceId, "execution.submit")) return false;
    try { if (hash(validateManifest(readRegular(path.join(this.dir, "approved-manifest.json")))) !== s.manifestHash) return false; } catch { return false; }
    return m.nodes.some(n => n.dependencies.every(d => this.reviewPassed(m.nodes.find(node => node.id === d)!)) && [n.instruction, ...n.correctiveInputs].some((instruction, attempt) =>
      pin.idempotencyKey === `${m.planId}:${n.idempotencyKey}:${attempt}` && task.instructionHash === createHash("sha256").update(instruction).digest("hex") &&
      JSON.stringify(task.writeScope) === JSON.stringify(n.writeScope) && task.network === n.network && pin.model === n.model && pin.effort === n.effort && pin.timeoutMs <= n.timeoutMs && pin.timeoutMs > 0));
  }
  setPaused(paused: boolean): void { if (this.state) { this.state.paused = paused; this.save(); this.wake("user-control"); } }
  observeRequest(ownerId: string | undefined, correlation: string): void {
    if (!this.manifest || !this.state || (ownerId && ownerId !== this.manifest.ownerId)) return;
    const file = path.join(this.dir, "supervision-observations.json");
    const prior = fs.existsSync(file) ? readRegular(file) as unknown[] : [];
    if (!Array.isArray(prior)) throw new Error("Invalid supervision observation history");
    writeSecureJson(file, [...prior.slice(-49), { observedAt: new Date(this.now()).toISOString(),
      authenticated: Boolean(ownerId), principalHash: ownerId ? hash(ownerId) : null,
      correlation: correlation.slice(0, 128), requestOrigin: "unknown", chatGptScheduledAudit: "unverified",
      challenge: this.state.challenge, generatedAt: this.state.generatedAt, loadedControllerSha256: this.loadedControllerSha256 }]);
  }
  status(ownerId?: string): unknown {
    if (this.loadError) return { state: "BROKEN_CONTINUATION", error: this.loadError };
    if (!this.manifest || !this.state || (ownerId && ownerId !== this.manifest.ownerId)) return { state: "DISABLED" };
    const s = this.state;
    const safeState = JSON.parse(JSON.stringify(s, (key, value) => {
      if (["threadId", "turnId", "providerSessionId", "ownerId"].includes(key)) return undefined;
      if (key === "reviewRequest") { const { instruction: _instruction, ...proof } = value; return proof; }
      if (key === "command" && typeof value === "string") return sanitizeExecutionCommand(value);
      return value;
    }));
    return { ...safeState, machineReview: Object.fromEntries(this.manifest.nodes.map(n => {
      const attempts = s.nodes[n.id].machineReview?.attempts ?? [];
      const latest = attempts.at(-1);
      return [n.id, { state: attempts.at(-1)?.state ?? "PENDING", reviewer: attempts.at(-1)?.reviewer ?? null,
        idempotencyKey: latest?.reviewRequest?.idempotency_key ?? null,
        attempts: attempts.length, lastValidReceipt: latest?.state === "PASS" && latest.receipt?.decision === "PASS" &&
          latest.executorTaskId === s.nodes[n.id].taskIds.at(-1) && latest.fingerprint === reviewFingerprint(this.manager.workspace.root, n) ? latest.receipt : null }];
    })), runtimeLoadedAt: this.runtimeLoadedAt, loadedControllerSha256: this.loadedControllerSha256, runtimePid: process.pid, planId: this.manifest.planId, workspaceId: this.manifest.workspaceId,
      responseAt: new Date(this.now()).toISOString(), evidenceAt: s.events.at(-1)?.at ?? null,
      review: "REVIEW_OVERDUE", lastAuthenticatedChatGptReviewAt: null,
      independentAcceptance: "PENDING_CHATGPT", nativeZcodeSchedule: "UNVERIFIED", chatGptScheduling: "UNKNOWN",
      health: s.readySince !== null && this.now() - s.readySince > 120_000 ? "BROKEN_CONTINUATION" : s.error ? "DEGRADED" : "OK",
      nextEligible: this.manifest.nodes.filter(n => s.nodes[n.id].state === "PENDING" && n.dependencies.every(d => this.reviewPassed(this.manifest!.nodes.find(x => x.id === d)!))).map(n => n.id),
      leaseExpiresAt: s.activatedAt === null ? null : new Date(s.activatedAt + this.manifest.leaseMs).toISOString(),
      callerIdentityProof: "Challenge proves freshness only; caller context must be independently authenticated" };
  }
  private save(): void {
    if (!this.state) return;
    continuationDirectory(this.manager.stateDir, this.manager.workspace.id);
    const file = path.join(this.dir, "state.json");
    try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid state target"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    writeSecureJson(file, this.state, { durable: true });
  }
  private canReview(): boolean {
    const m = this.manifest!, s = this.state!, queue = this.manager.getQueueState();
    return !this.closed && !s.paused && !s.cancelled && !queue.paused && !queue.activeTask && !queue.queuedTaskCount &&
      s.activatedAt !== null && this.now() < s.activatedAt + m.leaseMs && this.hooks.authorize(m.ownerId, m.workspaceId, "execution.submit");
  }
  private reviewPassed(node: ApprovedNode): boolean {
    const ns = this.state!.nodes[node.id], attempt = ns.machineReview?.attempts.at(-1);
    return Boolean(ns.state === "STABLE" && attempt?.state === "PASS" && attempt.reviewer && attempt.receipt?.decision === "PASS" &&
      attempt.executorTaskId === ns.taskIds.at(-1) && attempt.fingerprint === reviewFingerprint(this.manager.workspace.root, node));
  }
  private async boundedReviewCall<T>(call: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([Promise.resolve().then(call), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ZcodeNativeError("ZCODE_NATIVE_TIMEOUT", "Review transport timeout")), 20_000);
    })]); } finally { if (timer) clearTimeout(timer); }
  }
  private async timeoutReview(ns: NodeState, attempt: ReviewAttempt): Promise<void> {
    if (attempt.state !== "ACTIVE" || !attempt.reviewer) return;
    const reviewer = attempt.reviewer;
    attempt.state = "BLOCKED"; attempt.error = "REVIEW_TIMEOUT_CANCELLATION_UNCONFIRMED";
    attempt.cancellation = "PENDING"; ns.state = "BLOCKED_REVIEW";
    this.save(); // A crash during cancellation must never turn into a retry or a successor.
    try {
      const cancelled = await this.boundedReviewCall(() => this.manager.cancelNative({ workspace_id: reviewer.workspace_id, task_id: reviewer.task_id }, true));
      reviewIdentity(cancelled, reviewer.workspace_id, reviewer);
      if (!["completed", "cancelled", "failed"].includes(cancelled.status)) throw new Error("Cancellation not terminal");
      attempt.cancellation = "CONFIRMED"; attempt.error = "REVIEW_TIMEOUT";
    } catch { attempt.cancellation = "UNCONFIRMED"; }
    this.save();
  }
  private async machineReview(node: ApprovedNode, task: CodexTaskView, gateEligible = true): Promise<void> {
    const ns = this.state!.nodes[node.id];
    const review = ns.machineReview ??= { attempts: [] };
    let attempt = review.attempts.at(-1);
    ns.state = "WAITING_REVIEW";
    if (attempt?.state === "REVIEW_DISPATCH_UNCERTAIN" || attempt?.state === "DISPATCH_BLOCKED") {
      ns.state = attempt.state === "DISPATCH_BLOCKED" ? "BLOCKED_REVIEW" : attempt.state; return;
    }
    // Recover the ORIGINAL request before inspecting changed or unsafe source.
    if (attempt?.state === "DISPATCHING") {
      if (!this.canReview()) return;
      if (!await this.dispatchReview(ns, attempt, true)) return;
      if (this.now() >= attempt.deadline) { await this.timeoutReview(ns, attempt); return; }
    }
    const fingerprint = reviewFingerprint(this.manager.workspace.root, node);
    if (!fingerprint) { ns.state = "BLOCKED_REVIEW"; return; }
    if (attempt?.state === "PASS") {
      if (attempt.executorTaskId === task.taskId && attempt.fingerprint === fingerprint) { if (gateEligible) ns.state = "STABLE"; return; }
      attempt.state = "STALE";
    }
    if (attempt?.state === "BLOCKED") { ns.state = "BLOCKED_REVIEW"; return; }
    if (attempt?.state === "REWORK" && attempt.executorTaskId === task.taskId) {
      ns.state = "REWORK"; return;
    }
    if (attempt?.state === "ACTIVE" && (attempt.fingerprint !== fingerprint || attempt.executorTaskId !== task.taskId)) {
      // Keep polling the known task to terminal, but its result can never release changed input.
      attempt.error = "SOURCE_CHANGED";
    }
    if (!this.canReview()) return;
    if (!gateEligible && attempt?.state !== "ACTIVE") return;
    if (!attempt || attempt.state === "STALE" || attempt.state === "REWORK") {
      if (review.attempts.length >= MAX_REVIEW_ATTEMPTS) { ns.state = "BLOCKED_REVIEW"; return; }
      let instruction: string;
      try { instruction = reviewPrompt(node, task, ns.gate, fingerprint); }
      catch { ns.state = "BLOCKED_REVIEW"; return; }
      const intentId = randomUUID(), dispatchedAt = this.now();
      const request = { workspace_id: this.manifest!.workspaceId, instruction, write_scope: "readonly" as const,
        mode: "plan" as const, idempotency_key: intentId };
      attempt = { intentId, executorTaskId: task.taskId, fingerprint, dispatchedAt,
        deadline: dispatchedAt + REVIEW_TIMEOUT_MS, state: "DISPATCHING",
        reviewRequest: { ...request, protocol: ZCODE_IDEMPOTENCY_PROTOCOL, requestFingerprint: nativeRequestFingerprint(request) } };
      review.attempts.push(attempt);
      this.save(); // Exact immutable prompt and key precede any upstream dispatch.
      if (!await this.dispatchReview(ns, attempt, false)) return;
    }
    if (attempt.state !== "ACTIVE" || !attempt.reviewer || !this.canReview()) return;
    if (this.now() >= attempt.deadline) { await this.timeoutReview(ns, attempt); return; }
    try {
      const reviewer = attempt.reviewer;
      const observed = await this.boundedReviewCall(() => this.manager.getNative({ workspace_id: reviewer.workspace_id, task_id: reviewer.task_id }, true));
      reviewIdentity(observed, this.manifest!.workspaceId, reviewer);
      if (["queued", "running", "cancelling"].includes(observed.status)) return;
      if (observed.status !== "completed" || !observed.output_id) throw new Error("Review unsuccessful or output missing");
      const output = await this.boundedReviewCall(() => this.manager.outputNative({ workspace_id: reviewer.workspace_id, task_id: reviewer.task_id, output_id: observed.output_id! }, true));
      if (output.workspace_id !== reviewer.workspace_id || output.task_id !== reviewer.task_id || output.session_id !== reviewer.session_id || output.output_id !== observed.output_id) throw new Error("Review output namespace");
      const receipt = parseReviewReceipt(output.text, attempt);
      // Recheck task metadata after outputNative's internal lookup as well.
      const finalTask = await this.boundedReviewCall(() => this.manager.getNative({ workspace_id: reviewer.workspace_id, task_id: reviewer.task_id }, true));
      reviewIdentity(finalTask, this.manifest!.workspaceId, reviewer);
      if (finalTask.status !== "completed" || finalTask.output_id !== observed.output_id) throw new Error("Review terminal metadata changed");
      if (this.now() >= attempt.deadline) { await this.timeoutReview(ns, attempt); return; }
      if (attempt.error === "SOURCE_CHANGED" || reviewFingerprint(this.manager.workspace.root, node) !== attempt.fingerprint) {
        attempt.state = "STALE"; ns.state = "STALE";
      } else {
        attempt.receipt = receipt; attempt.state = receipt.decision;
        ns.state = receipt.decision === "PASS" && gateEligible && this.canReview() ? "STABLE" : receipt.decision === "REWORK" ? "REWORK" : "WAITING_REVIEW";
      }
    } catch {
      if (this.now() >= attempt.deadline) { await this.timeoutReview(ns, attempt); return; }
      attempt.state = "BLOCKED"; attempt.error = "REVIEW_EVIDENCE_INVALID_OR_UNAVAILABLE"; ns.state = "BLOCKED_REVIEW";
    }
    this.save();
  }
  private async dispatchReview(ns: NodeState, attempt: ReviewAttempt, recovering: boolean): Promise<boolean> {
    // Manager queue notifications can wake reconciliation synchronously after
    // a failed submit. Keep retries on the existing 5–10s cadence, not a
    // self-sustaining microtask loop. Restart safely resets this local throttle.
    if ((this.reviewRetryAt.get(attempt.intentId) ?? 0) > this.now()) {
      ns.state = "WAITING_REVIEW_RECOVERY"; return false;
    }
    this.reviewRetryAt.set(attempt.intentId, this.now() + 5_000);
    const request = attempt.reviewRequest;
    if (!request || request.idempotency_key !== attempt.intentId || request.workspace_id !== this.manifest!.workspaceId ||
        request.requestFingerprint !== nativeRequestFingerprint(request)) {
      attempt.state = "DISPATCH_BLOCKED"; attempt.error = "REVIEW_IDEMPOTENCY_UNPROVEN"; ns.state = "BLOCKED_REVIEW"; this.save(); return false;
    }
    try {
      this.save(); // Re-prove durable intent on every retry, including a prior failed save.
      const { protocol: _protocol, requestFingerprint: _fingerprint, ...input } = request;
      const submitted = await this.boundedReviewCall(() => this.manager.submitNative(input, () => {
        if (!this.canReview()) throw new Error("Review authorization paused or expired before dispatch");
      }));
      assertNativeIdempotency(submitted, input);
      const identity = reviewIdentity(submitted, this.manifest!.workspaceId, attempt.reviewer);
      attempt.reviewer = identity; attempt.state = "ACTIVE"; delete attempt.error;
      this.save(); // Bind identity immediately, before events, polling or freshness work.
      this.event(recovering ? "review-dispatch-recovered" : "review-dispatch", {
        intentId: attempt.intentId, idempotencyKey: request.idempotency_key, reviewer: identity,
        upstreamReplayed: submitted.idempotency!.replayed,
      }, `review-dispatch:${attempt.intentId}:${recovering ? "recovered" : "fresh"}`);
      this.save(); return true;
    } catch (error) {
      // Transport loss remains replayable with this exact key. Protocol,
      // conflict, namespace and malformed identity failures require repair.
      const permanent = !(error instanceof ZcodeNativeError && ["ZCODE_NATIVE_UNAVAILABLE", "ZCODE_NATIVE_TIMEOUT"].includes(error.code));
      const malformed = error instanceof z.ZodError;
      attempt.state = permanent || malformed ? "DISPATCH_BLOCKED" : "DISPATCHING";
      attempt.error = error instanceof ZcodeNativeError && error.upstreamCode === "IDEMPOTENCY_UPGRADE_REQUIRED"
        ? "REVIEW_Z2C_UPGRADE_REQUIRED" : permanent || malformed ? "REVIEW_IDEMPOTENCY_REJECTED" : "REVIEW_REPLAY_PENDING";
      ns.state = attempt.state === "DISPATCH_BLOCKED" ? "BLOCKED_REVIEW" : "WAITING_REVIEW_RECOVERY";
      this.save(); return false;
    }
  }
  private event(type: string, detail: unknown, key: string): void {
    const s = this.state!;
    if (!s.events.some(e => e.id === key)) s.events.push({ id: key, type, detail, at: new Date(this.now()).toISOString() });
  }
  private async reconcile(reason: string): Promise<void> {
    const m = this.manifest, s = this.state;
    if (this.closed || !m || !s || this.loadError) return;
    // Conserve quota for already admitted reviewers, even if paused, revoked or unfingerprintable.
    for (const ns of Object.values(s.nodes)) {
      const attempt = ns.machineReview?.attempts.at(-1);
      if (attempt?.state === "ACTIVE" && this.now() >= attempt.deadline) await this.timeoutReview(ns, attempt);
    }
    // Re-read the approval on every event so edits during a live lease fail closed.
    if (hash(validateManifest(readRegular(path.join(this.dir, "approved-manifest.json")))) !== s.manifestHash) throw new Error("Manifest changed");
    if (!this.hooks.authorize(m.ownerId, m.workspaceId, "execution.submit")) { s.state = "BROKEN_CONTINUATION"; s.error = "Owner authorization unavailable or revoked"; this.save(); return; }
    s.activatedAt ??= this.now();
    const access = { ownerId: m.ownerId, workspaceId: m.workspaceId };
    const queue = this.manager.getQueueState(); // All writers, including other owners.
    const priorTerminalCount = s.events.filter(e => e.type === "terminal").length;
    for (const n of m.nodes) {
      const ns = s.nodes[n.id];
      // Recover the enqueue/persist crash window using the durable task idempotency key.
      for (let attempt = 0; attempt <= n.correctiveInputs.length; attempt++) {
        const found = this.manager.findByIdempotencyKey(`${m.planId}:${n.idempotencyKey}:${attempt}`, access);
        if (found && !ns.taskIds.includes(found.taskId)) ns.taskIds.push(found.taskId);
      }
      if (!ns.taskIds.length) continue;
      const observedTask = this.manager.get(ns.taskIds.at(-1)!, access) as CodexTaskView;
      // The first terminal receipt is immutable, including across controller restarts.
      // Delayed manager snapshots cannot rewrite its status or command evidence.
      const terminal = s.events.find(e => e.id === `terminal:${observedTask.taskId}` && e.type === "terminal");
      const task = terminal ? terminal.detail as CodexTaskView : observedTask;
      const normalizedScope = task.writeScope.map(scope => path.isAbsolute(scope) ? path.relative(this.manager.workspace.root, scope).replaceAll("\\", "/") : scope);
      if (task.workspaceId !== m.workspaceId || task.taskId !== observedTask.taskId || task.provider !== n.provider || task.orchestrator !== "legacy" || JSON.stringify(normalizedScope) !== JSON.stringify(n.writeScope) || task.network !== n.network) {
        ns.state = "BLOCKED_POLICY"; ns.evidence = { taskId: task.taskId, reason: "Imported task provider/scope/network mismatch" }; continue;
      }
      ns.evidence = task;
      if (task.status === "queued" || task.status === "running" || task.status === "cancelling") { ns.state = "ACTIVE"; continue; }
      this.event("terminal", task, `terminal:${task.taskId}`);
      // A consumed dependency is historical evidence for its already-admitted successor.
      if (ns.state === "STABLE" && ns.machineReview?.attempts.at(-1)?.state === "PASS" && m.nodes.some(child => child.dependencies.includes(n.id) && s.nodes[child.id].taskIds.length > 0)) continue;
      // Gate evidence belongs to the bridge controller, separate from immutable task history.
      const pendingReview = ns.machineReview?.attempts.at(-1);
      if (pendingReview?.state === "DISPATCHING" && this.canReview()) {
        // Identity recovery precedes even the current source gate: never
        // rebuild an old request using new verification evidence.
        if (!await this.dispatchReview(ns, pendingReview, true)) continue;
        if (this.now() >= pendingReview.deadline) await this.timeoutReview(ns, pendingReview);
      }
      const actual = observeNativeModel(task.threadId ?? undefined, task.startedAt ?? task.submittedAt, task.turnId ?? undefined);
      const source = verificationFingerprint(this.manager.workspace.root);
      const gateAttempt = `${task.taskId}:${source}`;
      const terminalEligible = task.status === "completed";
      if (this.canReview() && !task.cancelRequestedAt && terminalEligible &&
          actual?.model === n.model && actual.effort === n.effort && n.kind === "ui" && source &&
          !(ns.gateAttempts ?? []).includes(gateAttempt) && !(ns.gateTaskId === task.taskId && (ns.gateAttempts ?? []).includes(source)) && (ns.gateAttempts?.length ?? 0) < 3) {
        ns.gateAttempts = [...(ns.gateAttempts ?? []), gateAttempt];
        this.save();
        ns.gate = await this.manager.withIdleCollector(() => (this.hooks.verify ?? verifyWebSource)(this.manager.workspace.root));
        ns.gateTaskId = task.taskId;
        this.event("source-verification", { node: n.id, taskId: task.taskId, actualModel: actual, gate: ns.gate }, `gate:${task.taskId}:${source}`);
        this.save();
      }
      const gateEligible = terminalEligible && actual?.model === n.model && actual.effort === n.effort &&
        (n.kind === "verification" || (ns.gateTaskId === task.taskId && sourceGatePassed(ns.gate, verificationFingerprint(this.manager.workspace.root))));
      if (task.status === "cancelled" || task.cancelRequestedAt) { s.cancelled = true; ns.state = "CANCELLED"; }
      else if (gateEligible || ["ACTIVE", "DISPATCHING", "DISPATCH_BLOCKED", "REVIEW_DISPATCH_UNCERTAIN"].includes(ns.machineReview?.attempts.at(-1)?.state ?? "")) await this.machineReview(n, task, gateEligible);
      else if (task.status === "completed") ns.state = "WAITING_REVIEW";
      else ns.state = /quota|rate.limit/i.test(`${task.error?.code ?? ""} ${task.error?.message ?? ""}`) ? "WAITING_QUOTA" : "FAILED";
    }
    s.submitted = m.nodes.reduce((sum, n) => sum + s.nodes[n.id].taskIds.filter(t => t !== n.externalTaskId).length, 0);
    // Collector runs only at idle boundaries; fragments remain durable while a product writer owns the slot.
    const checkpointDue = s.lastCheckpointAt === null || this.now() - s.lastCheckpointAt >= 60 * 60_000;
    if (checkpointDue || priorTerminalCount !== s.events.filter(e => e.type === "terminal").length || (!queue.activeTask && (s.mirror as { state?: string } | null)?.state === "OWNERSHIP_WAIT")) {
      const eventId = `checkpoint:${Math.floor(this.now() / (60 * 60_000))}:${s.events.filter(e => e.type === "terminal").length}`;
      this.event("checkpoint", { reason, ownershipWait: Boolean(queue.activeTask) }, eventId);
      this.save();
      if (!queue.activeTask && this.hooks.collect) {
        try { s.mirror = await this.manager.withIdleCollector(() => this.hooks.collect!(m, this.status(), eventId)); s.error = null; }
        catch (error) {
          s.error = "AUDIT_COLLECTOR_OR_MIRROR_FAILED";
          s.mirror = { state: "FAILED", code: typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "COLLECTOR_FAILED", observedAt: new Date(this.now()).toISOString() };
        }
      } else s.mirror = { state: "OWNERSHIP_WAIT", fragment: "protected continuation events" };
      s.lastCheckpointAt = this.now();
    }
    if (this.closed) { this.save(); return; }
    if (this.manager.getQueueState().paused || s.paused || s.cancelled) { s.state = "PAUSED_BY_USER"; s.readySince = null; this.save(); return; }
    if (!this.hooks.authorize(m.ownerId, m.workspaceId, "execution.submit")) { s.state = "BROKEN_CONTINUATION"; this.save(); return; }
    if (this.now() >= s.activatedAt + m.leaseMs) { s.state = "WAITING_REVIEW"; s.error = "LEASE_EXPIRED"; this.save(); return; }
    // Collection may itself observe a changed workspace. Invalidate before selecting a successor.
    for (const n of m.nodes) {
      const ns = s.nodes[n.id], attempt = ns.machineReview?.attempts.at(-1);
      if (attempt?.state === "PASS" && !m.nodes.some(child => child.dependencies.includes(n.id) && s.nodes[child.id].taskIds.length) &&
          attempt.fingerprint !== reviewFingerprint(this.manager.workspace.root, n)) { attempt.state = "STALE"; ns.state = "STALE"; }
    }
    const eligible = m.nodes.find(n => {
      const ns = s.nodes[n.id];
      return (ns.state === "PENDING" || ((ns.state === "FAILED" || (ns.state === "REWORK" && (ns.machineReview?.attempts.length ?? 0) < MAX_REVIEW_ATTEMPTS)) && !n.externalTaskId && ns.taskIds.length <= n.correctiveInputs.length)) && n.dependencies.every(d => this.reviewPassed(m.nodes.find(node => node.id === d)!));
    });
    if (queue.activeTask) { s.state = "RUNNING"; s.readySince = null; this.save(); return; }
    if (queue.queuedTaskCount) { s.readySince ??= this.now(); s.state = this.now() - s.readySince > 120_000 ? "BROKEN_CONTINUATION" : "RUNNING"; this.save(); return; }
    if (!eligible) {
      s.state = m.nodes.every(n => s.nodes[n.id].state === "STABLE") ? "BACKLOG_COMPLETE" : m.nodes.some(n => s.nodes[n.id].state === "WAITING_QUOTA") ? "WAITING_QUOTA" : "WAITING_REVIEW";
      s.readySince = null; this.save(); return;
    }
    s.readySince ??= this.now();
    if (s.submitted >= m.maxNewTasks) { s.state = "WAITING_REVIEW"; s.error = "TASK_BUDGET_EXHAUSTED"; this.save(); return; }
    const ns = s.nodes[eligible.id];
    const attempt = ns.taskIds.length;
    const key = `${m.planId}:${eligible.idempotencyKey}:${attempt}`;
    this.event("dispatch-intent", { node: eligible.id, key }, `intent:${key}`);
    this.save(); // Intent first; submit itself durably owns the idempotency key.
    if (!this.canReview() || !eligible.dependencies.every(d => this.reviewPassed(m.nodes.find(node => node.id === d)!))) return;
    const task = this.manager.submit({ workspace_id: m.workspaceId,
      instruction: attempt === 0 ? eligible.instruction : eligible.correctiveInputs[attempt - 1],
      write_scope: eligible.writeScope, network: eligible.network, run_tests: false,
    }, { ...access, continuation: { idempotencyKey: key, model: eligible.model, effort: eligible.effort, timeoutMs: Math.min(eligible.timeoutMs, s.activatedAt + m.leaseMs - this.now()),
      authorize: () => !s.paused && !s.cancelled && !this.manager.getQueueState().paused && this.now() < s.activatedAt! + m.leaseMs && this.hooks.authorize(m.ownerId, m.workspaceId, "execution.submit") } });
    ns.taskIds.push(task.taskId); ns.state = "ACTIVE"; s.submitted++; s.readySince = null; s.state = "RUNNING";
    this.event("handoff", { node: eligible.id, taskId: task.taskId, key }, `handoff:${key}`);
    this.save();
  }
}
