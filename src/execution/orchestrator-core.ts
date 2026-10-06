import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ensureDir, writeSecureJson } from "../config/paths.js";
import type { CatalogAgent } from "./model-catalog.js";
import type { CodexTaskManager, CodexTaskView, TaskAccessContext } from "./tasks.js";

// Local copies of the bounded selection patterns: importing them from
// model-catalog.js at module top level creates an initialization cycle
// (model-catalog → tasks → orchestrator-core) that TDZ-crashes on direct
// imports. Same literals, single-line comment points at the source of truth.
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/; // keep in sync with model-catalog.ts
const EFFORT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/; // keep in sync with model-catalog.ts

/**
 * Provider-neutral, workspace-agnostic orchestration steps.
 *
 * `agent` names the execution family (codex | antigravity | zcode | dsh);
 * `provider` is accepted as a legacy alias for the same field. Model, effort
 * and provider route are FREE-FORM caller intents: they are resolved against
 * the agent's authoritative live catalog at admission AND re-resolved fresh at
 * every dispatch attempt. Nothing here defaults to a fixed workspace, a fixed
 * provider, or an encoded model list — an omitted model/effort resolves to the
 * agent's catalog default (documented deterministic policy), and any
 * ambiguous or unsupported request fails with candidates instead of guessing.
 */
export const ORCHESTRATOR_AGENTS = ["codex", "antigravity", "zcode", "dsh"] as const;
export type OrchestratorAgent = CatalogAgent;
const agentSchema = z.enum(ORCHESTRATOR_AGENTS);
const agentIdentity = z.object({
  agent: agentSchema.optional(),
  provider: agentSchema.optional(),
  model: z.string().min(1).max(100).optional(),
  effort: z.string().regex(EFFORT_PATTERN).optional(),
  /** Optional provider route constraint (exact provider_id after resolution). */
  provider_route: z.string().regex(MODEL_ID_PATTERN).optional(),
  entitlement_plan: z.enum(["DEFAULT", "START", "INDIVIDUAL"]).optional(),
}).strict().refine(
  value => !(value.agent !== undefined && value.provider !== undefined && value.agent !== value.provider),
  { message: "agent and provider alias must match when both are given" },
);

export const orchestratorStepSchema = z.object({
  instruction: z.string().min(1).max(8000),
  write_scope: z.array(z.string().min(1).max(300)).min(1).max(16),
  network: z.boolean().default(true),
  run_tests: z.boolean().default(true),
  agent: agentSchema.default("codex"),
  provider: agentSchema.optional(),
  model: z.string().min(1).max(100).optional(),
  effort: z.string().regex(EFFORT_PATTERN).optional(),
  provider_route: z.string().regex(MODEL_ID_PATTERN).optional(),
  entitlement_plan: z.enum(["DEFAULT", "START", "INDIVIDUAL"]).optional(),
}).strict().superRefine((step, ctx) => {
  if (step.entitlement_plan !== undefined && step.agent !== "zcode") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entitlement_plan"], message: "entitlement_plan requires agent zcode" });
  }
  if (step.provider !== undefined && step.provider !== step.agent) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["provider"],
      message: "provider alias must match agent when both are given" });
  }
});
export const orchestratorPlanSchema = z.array(orchestratorStepSchema).min(1).max(64);
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** One step's exact execution selection, persisted as run/audit evidence. */
export interface ResolvedStepSelection {
  agent: OrchestratorAgent;
  provider_id: string | null;
  model_id: string;
  effort: string | null;
  /** Live-catalog provenance of the resolution. */
  catalog_revision: string | null;
  resolved_at: string;
}

/**
 * Deterministic catalog resolution seam. Implementations MUST resolve against
 * the agent's authoritative live catalog (fresh evidence; no stale
 * authorization) and MUST NOT fall back to another agent/model/effort:
 *  - ambiguous free-form name → throw with `candidates` (never guess);
 *  - unsupported effort for the exact model → UNSUPPORTED_EFFORT;
 *  - unknown model with complete evidence → MODEL_NOT_FOUND;
 *  - catalog unavailable/stale → MODEL_CATALOG_UNAVAILABLE (retryable).
 */
export class StepSelectionError extends Error {
  constructor(readonly code:
    | "AMBIGUOUS_MODEL" | "MODEL_NOT_FOUND" | "UNSUPPORTED_EFFORT"
    | "AGENT_UNKNOWN" | "MODEL_CATALOG_UNAVAILABLE" | "PROVIDER_ROUTE_MISMATCH",
    message: string,
    readonly candidates: Array<{ agent: string; provider_id: string | null; model_id: string; display_name: string | null; default_effort: string | null }> = []) {
    super(message);
    this.name = "StepSelectionError";
  }
}
export type StepSelectionResolver = (selection: {
  agent: OrchestratorAgent; model?: string; effort?: string; provider_route?: string;
}) => Promise<ResolvedStepSelection> | ResolvedStepSelection;

/**
 * Unified provider-neutral task projection for ONE orchestrated step. Every
 * lane reuses its provider's AUTHORITATIVE execution surface (Codex task
 * manager, Antigravity backend via the manager's gemini lane, ZCode native
 * submission through Z2C, DSH native service) and projects the result into
 * this single shape — no second runner is written for any provider.
 */
export interface OrchestratorLaneTaskView {
  taskId: string;
  status: "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted" | "timed_out";
  outputIds: Array<string | number>;
  error?: { code?: string; message: string } | string | null;
  verification?: { status?: string; exitCode?: number | null } | null;
  stableVerification?: { commands?: Array<{ exitCode?: number | null }> } | null;
}

/** One agent's dispatch/observation seam; submit/get may be async (native lanes). */
export interface OrchestratorLane {
  submit(step: Step, resolved: ResolvedStepSelection, access: TaskAccessContext):
    Promise<OrchestratorLaneTaskView> | OrchestratorLaneTaskView;
  get(taskId: string, access: TaskAccessContext):
    Promise<OrchestratorLaneTaskView> | OrchestratorLaneTaskView;
}

type Verdict = "PASS" | "REWORK" | "BLOCKED";

/** Deterministic evidence is a veto, never an automatic audit verdict. */
function passBlockers(task: Pick<OrchestratorLaneTaskView, "status" | "error" | "verification" | "stableVerification">): string[] {
  const blockers: string[] = [];
  if (task.status !== "completed") blockers.push(`terminal:${task.status}`);
  if (task.error) blockers.push("task.error");
  if (task.verification && (task.verification.status !== "passed"
    || task.verification.exitCode !== 0)) blockers.push("task.verification");
  task.stableVerification?.commands?.forEach((command, index) => {
    if (command.exitCode !== null && command.exitCode !== 0) blockers.push(`command:${index}:exit:${command.exitCode}`);
  });
  return blockers;
}

/** Publish a complete PID atomically; serialize stale-lock reclamation too. */
export function acquireStateLock(file: string, depth = 0): () => void {
  if (depth > 8) throw new Error("Orchestrator lock recovery requires inspection");
  const candidate = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(candidate, String(process.pid), { flag: "wx", mode: 0o600 });
  const publish = () => {
    try { fs.linkSync(candidate, file); }
    catch (error) {
      // Some Windows temp volumes do not support hard links. Exclusive copy
      // preserves writer exclusion; an incomplete owner record fails closed.
      if (!["EISDIR", "ENOTSUP", "EPERM", "EXDEV", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      fs.copyFileSync(candidate, file, fs.constants.COPYFILE_EXCL);
    }
  };
  const dead = () => {
    let pid: number;
    try {
      const owner: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      pid = typeof owner === "number" ? owner : (owner as { pid: number })?.pid;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid orchestrator lock");
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  try {
    try { publish(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !dead()) throw error;
      const releaseReaper = acquireStateLock(`${file}.reaper`, depth + 1);
      try {
        if (dead()) fs.unlinkSync(file);
        publish();
      } finally { releaseReaper(); }
    }
    return () => { fs.unlinkSync(file); };
  } finally { fs.unlinkSync(candidate); }
}

export interface OrchestratorRun {
  version: 1; runId: string; workspaceId: string; ownerId: string;
  generation: number; state: "IDLE" | "DISPATCHED" | "RUNNING" | "WAITING_AUDIT" | "COMPLETE" | "BLOCKED" | "FAIL";
  paused: boolean; steps: Step[]; step: number; attempt: number; taskId?: string;
  /** The exact selection resolved from the live catalog for the CURRENT attempt. */
  resolved?: ResolvedStepSelection;
  /** Permanent plan defect that failed the run (never a fallback candidate). */
  failure?: { code: string; message: string; candidates?: StepSelectionError["candidates"] };
  audits: Array<{ id: string; type: "audit.required"; sequence: number; taskId: string;
    step: number; attempt: number; outputIds: Array<string | number>; records: string[];
    terminalStatus?: CodexTaskView["status"]; passBlockers?: string[];
    resolved?: ResolvedStepSelection;
    claimant?: string; verdict?: Verdict; note?: string }>;
}

/** Normalized internal step (defaults applied; provider alias folded into agent). */
export interface Step {
  instruction: string;
  write_scope: string[];
  network: boolean;
  run_tests: boolean;
  agent: OrchestratorAgent;
  model?: string;
  effort?: string;
  provider_route?: string;
  entitlement_plan?: "DEFAULT" | "START" | "INDIVIDUAL";
}

function normalizeStep(raw: z.infer<typeof orchestratorStepSchema>): Step {
  return {
    instruction: raw.instruction,
    write_scope: raw.write_scope,
    network: raw.network,
    run_tests: raw.run_tests,
    agent: raw.provider ?? raw.agent,
    ...(raw.entitlement_plan !== undefined ? { entitlement_plan: raw.entitlement_plan } : {}),
    ...(raw.model !== undefined ? { model: raw.model } : {}),
    ...(raw.effort !== undefined ? { effort: raw.effort } : {}),
    ...(raw.provider_route !== undefined ? { provider_route: raw.provider_route } : {}),
  };
}

/** No execution queue: all admissions and writer ownership belong to the task manager. */
export class OrchestratorCore {
  private readonly dir: string;
  private busy = false;
  constructor(stateDir: string, readonly workspaceId: string,
    private readonly manager: Pick<CodexTaskManager, "submit" | "get">,
    private readonly hooks: {
      validate?: (step: Step) => void;
      /** Live-catalog resolution; provider-neutral and workspace-agnostic. */
      resolveSelection?: StepSelectionResolver;
      /** Per-agent dispatch/observation lanes reusing each provider's authoritative surface. */
      lanes?: Partial<Record<OrchestratorAgent, OrchestratorLane>>;
      authorize?: (owner: string) => boolean;
      onPersistedRun?: () => void;
    } = {}) {
    idSchema.parse(workspaceId);
    this.dir = path.join(stateDir, "orchestrator", workspaceId);
  }
  /** The lane for one agent: an injected seam, or the task-manager default. */
  private lane(agent: OrchestratorAgent): OrchestratorLane {
    const injected = this.hooks.lanes?.[agent];
    if (injected) return injected;
    // Default lane: the manager's own codex/gemini execution. The Antigravity
    // family runs on the gemini backend lane; its efforts are model-baked, so
    // the effort field is only forwarded for the codex family.
    const provider = agent === "antigravity" ? "gemini" : agent === "codex" ? "codex" : null;
    if (provider === null) {
      throw new StepSelectionError("AGENT_UNKNOWN",
        `No execution lane is wired for agent "${agent}" (inject hooks.lanes.${agent} or use codex/antigravity)`);
    }
    return {
      submit: (step, resolved, access) => this.manager.submit({
        workspace_id: this.workspaceId,
        instruction: step.instruction,
        write_scope: step.write_scope,
        network: step.network,
        run_tests: step.run_tests,
        provider,
        ...(provider === "codex" && resolved.model_id ? { model: resolved.model_id } : {}),
        ...(provider === "codex" && resolved.effort ? { effort: resolved.effort } : {}),
      }, access),
      get: (taskId, access) => this.manager.get(taskId, access),
    };
  }
  hasRuns(): boolean { return fs.existsSync(this.dir) && fs.readdirSync(this.dir).some(f => f.endsWith(".json")); }
  private file(id: string): string { return path.join(this.dir, `${idSchema.parse(id)}.json`); }
  private save(run: OrchestratorRun): void {
    run.generation++;
    writeSecureJson(this.file(run.runId), run, { durable: true });
  }
  /** Async-aware writer exclusion: the busy flag and file lock span awaits. */
  private async locked<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.busy) throw new Error("Orchestrator workspace is busy");
    ensureDir(this.dir);
    const lock = path.join(this.dir, "writer.lock");
    const release = acquireStateLock(lock);
    this.busy = true;
    try { return await fn(); }
    finally { this.busy = false; release(); }
  }
  private load(id: string, owner?: string): OrchestratorRun {
    const run = JSON.parse(fs.readFileSync(this.file(id), "utf8")) as OrchestratorRun;
    if (run.version !== 1 || run.runId !== id || run.workspaceId !== this.workspaceId
      || !Number.isSafeInteger(run.generation)) throw new Error("Invalid orchestrator state");
    if (owner !== undefined && run.ownerId !== owner) throw new Error("Orchestrator owner mismatch");
    return run;
  }
  read(id: string, owner: string): OrchestratorRun { return this.load(id, owner); }

  /** Resolve one step's selection through the live-catalog seam (fail loud, never substitute). */
  private async resolveStep(step: Step): Promise<ResolvedStepSelection> {
    if (!this.hooks.resolveSelection) {
      // Contract-only deployments (unit tests, harnesses without a catalog
      // service) resolve to the request as-is: the manager's own admission
      // gates still validate every dispatch. No substitution, no fallback
      // route — an explicit unsupported request fails in validate/admission.
      return {
        agent: step.agent,
        provider_id: step.provider_route ?? null,
        model_id: step.model ?? "",
        effort: step.effort ?? null,
        catalog_revision: null,
        resolved_at: new Date().toISOString(),
      };
    }
    return await this.hooks.resolveSelection(step);
  }

  async create(id: string, owner: string, plan: unknown): Promise<OrchestratorRun> {
    const steps = orchestratorPlanSchema.parse(plan).map(normalizeStep);
    steps.forEach(step => this.hooks.validate?.(step));
    // Admit the plan only when every step resolves against the live catalog
    // right now: ambiguous/unsupported requests fail with candidates instead
    // of guessing, and no step is ever silently re-routed to another agent.
    for (const step of steps) await this.resolveStep(step);
    return await this.locked(async () => {
      if (fs.existsSync(this.file(id))) {
        const existing = this.load(id, owner);
        if (JSON.stringify(existing.steps) !== JSON.stringify(steps)) throw new Error("Run id scope mismatch");
        return existing;
      }
      const run: OrchestratorRun = { version: 1, runId: id, workspaceId: this.workspaceId, ownerId: owner,
        generation: 0, state: "IDLE", paused: false, steps, step: 0, attempt: 1, audits: [] };
      this.save(run);
      this.hooks.onPersistedRun?.();
      await this.advance(run);
      return run;
    });
  }
  async pause(id: string, owner: string, paused: boolean): Promise<OrchestratorRun> {
    return await this.locked(async () => { const run = this.load(id, owner); run.paused = paused; this.save(run);
      await this.advance(run); return run; });
  }
  async claim(id: string, owner: string, auditId: string, claimant: string): Promise<OrchestratorRun> {
    return await this.locked(() => {
      const run = this.load(id, owner);
      const audit = run.audits.find(a => a.id === auditId);
      if (!audit || audit.verdict || run.state !== "WAITING_AUDIT") throw new Error("Audit is not pending");
      if (audit.claimant && audit.claimant !== claimant) throw new Error("Audit already claimed");
      if (!audit.claimant) { audit.claimant = claimant; this.save(run); }
      return run;
    });
  }
  async submitAudit(id: string, owner: string, auditId: string, claimant: string, verdict: Verdict, note?: string): Promise<OrchestratorRun> {
    z.enum(["PASS", "REWORK", "BLOCKED"]).parse(verdict);
    z.string().max(1000).optional().parse(note);
    return await this.locked(async () => {
      const run = this.load(id, owner);
      const audit = run.audits.find(a => a.id === auditId);
      if (!audit || audit.claimant !== claimant) throw new Error("Audit claim mismatch");
      if (audit.verdict) {
        if (audit.verdict !== verdict || audit.note !== note) throw new Error("Audit result conflict");
        return run;
      }
      if (run.state !== "WAITING_AUDIT" || audit.taskId !== run.taskId) throw new Error("Stale audit");
      if (verdict === "PASS") {
        const lane = this.lane(audit.resolved?.agent ?? run.steps[audit.step]!.agent);
        const task = await lane.get(audit.taskId, { ownerId: owner, workspaceId: this.workspaceId });
        const blockers = [...(audit.passBlockers ?? []), ...passBlockers(task)];
        if (blockers.length) throw new Error(`PASS rejected by deterministic evidence: ${[...new Set(blockers)].join(", ")}`);
      }
      audit.verdict = verdict; audit.note = note;
      if (verdict === "BLOCKED") run.state = "BLOCKED";
      else {
        if (verdict === "PASS") { run.step++; run.attempt = 1; }
        else run.attempt++;
        run.taskId = undefined;
        run.resolved = undefined;
        run.state = run.step === run.steps.length ? "COMPLETE" : "IDLE";
      }
      this.save(run); // decision and next intent commit together, before admission
      await this.advance(run);
      return run;
    });
  }
  /** Called after lifecycle notifications and at manager startup. Durable tasks are authoritative. */
  async recover(): Promise<void> {
    if (this.busy || !fs.existsSync(this.dir)) return;
    await this.locked(async () => {
      for (const file of fs.readdirSync(this.dir).filter(f => /^[A-Za-z0-9_-]+\.json$/.test(f))) {
        try { await this.advance(this.load(file.slice(0, -5))); }
        catch { /* An unavailable task/store is not permission to redispatch. Retry later. */ }
      }
    });
  }
  private async advance(run: OrchestratorRun): Promise<void> {
    if (["COMPLETE", "BLOCKED", "FAIL", "WAITING_AUDIT"].includes(run.state)) return;
    if (!run.taskId) {
      if (run.paused) return;
      if (this.hooks.authorize && !this.hooks.authorize(run.ownerId)) {
        run.state = "BLOCKED"; this.save(run); return;
      }
      // Fresh live-catalog resolution for EVERY dispatch attempt: a model or
      // effort that stopped being advertised fails loudly here instead of
      // running on a substituted route. Retryable catalog outages keep the
      // durable DISPATCHED intent; deterministic plan defects fail the run.
      if (run.state !== "DISPATCHED" || !run.resolved) {
        let resolved: ResolvedStepSelection;
        try {
          resolved = await this.resolveStep(run.steps[run.step]!);
        } catch (error) {
          if (error instanceof StepSelectionError && error.code === "MODEL_CATALOG_UNAVAILABLE") throw error;
          run.state = "FAIL";
          run.failure = error instanceof StepSelectionError
            ? { code: error.code, message: error.message, ...(error.candidates.length ? { candidates: error.candidates } : {}) }
            : { code: "SELECTION_FAILED", message: String((error as Error)?.message ?? error) };
          this.save(run);
          return;
        }
        run.state = "DISPATCHED";
        run.resolved = resolved;
        run.failure = undefined;
        this.save(run);
      }
      const step = run.steps[run.step]!;
      const access: TaskAccessContext = { ownerId: run.ownerId, workspaceId: this.workspaceId,
        orchestratorKey: `${run.runId}:${run.step}:${run.attempt}` };
      const lane = this.lane(run.resolved!.agent);
      let task: OrchestratorLaneTaskView;
      try {
        task = await lane.submit(step, run.resolved!, access);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code && !["QUEUE_FULL", "WORKSPACE_SLOT_BUSY", "CODEX_UNAVAILABLE",
          "TASK_IN_PROGRESS", "ZCODE_NATIVE_UNAVAILABLE", "ZCODE_NATIVE_TIMEOUT"].includes(code)) {
          run.state = "FAIL"; this.save(run); return;
        }
        throw error;
      }
      run.taskId = task.taskId;
      this.save(run);
    }
    const lane = this.lane(run.resolved?.agent ?? run.steps[run.step]!.agent);
    const task = await lane.get(run.taskId, { ownerId: run.ownerId, workspaceId: this.workspaceId });
    if (["completed", "failed", "cancelled", "interrupted", "timed_out"].includes(task.status)) {
      const id = `${run.runId}:${run.step}:${run.attempt}`;
      if (!run.audits.some(a => a.id === id)) run.audits.push({ id, type: "audit.required",
        sequence: run.generation + 1, taskId: task.taskId, step: run.step, attempt: run.attempt,
        terminalStatus: task.status, passBlockers: passBlockers(task),
        ...(run.resolved ? { resolved: run.resolved } : {}),
        outputIds: [...task.outputIds] as number[], records: ["agent_task_read", "agent_output_read", "task.verification", "task.tests"] });
      run.state = "WAITING_AUDIT";
      this.save(run); // audit.required and state are one atomic record
    } else if (task.status === "running" && run.state !== "RUNNING") {
      run.state = "RUNNING"; this.save(run);
    }
  }
}
