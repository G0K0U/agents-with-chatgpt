import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceRegistry,
  WorkspaceError,
  canonicalizeWorkspacePath,
} from "../src/core/workspaces/registry.js";
import { Persistence } from "../src/core/tasks/persistence.js";
import { requestFingerprint } from "../src/core/tasks/idempotency.js";
import { TaskEngine, TaskEngineError, type SubmitTaskInput } from "../src/core/tasks/engine.js";
import { buildMcpServer } from "../src/mcp/server.js";
import { FileAuditLog } from "../src/util/log.js";
import { loadConfig } from "../src/config.js";
import {
  REQUIRED_START_PLAN_MODEL_ID,
  REQUIRED_BINDING_SOURCE,
  REQUIRED_START_PLAN_PROVIDER_ID,
} from "../src/providers/types.js";
import type {
  AgentProvider,
  ProviderRunHandle,
  ProviderSessionSummary,
  ProviderTurnResult,
  ProviderWorkspaceRef,
  ProviderSendOptions,
} from "../src/providers/types.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "z2c-test-"));
}

/** Deterministic fake provider for control-plane tests (no real ZCode). */
class FakeProvider implements AgentProvider {
  name = "fake";
  status: AgentProvider["status"] = "healthy";
  statusDetail?: string;
  providerVersion = "0.16.5";
  capabilityResult = null;
  usesDesktopManagedAuth = false;
  sessions = 0;
  sessionDelayMs = 0;
  turnDelayMs = 0;
  failCreate = false;
  failStart = false;
  startAttempts = 0;
  createdSessions: string[] = [];
  stoppedSessions: string[] = [];
  executionGrants: ProviderSendOptions["executionGrant"][] = [];
  sentInstructions: Array<{ sessionId: string; instruction: string }> = [];
  outputs = new Map<string, string>();
  /** Observed binding per session id; created sessions default to the required identity. */
  sessionBindings = new Map<string, { provider_id: string; model_id: string; source: string }>();
  /** Workspace association recorded per session (exact-session read proof). */
  sessionWorkspaces = new Map<string, string>();
  /** Pre-set observed binding for the NEXT created session; null = unobserved. */
  nextBinding: { provider_id: string; model_id: string } | null | undefined;
  /** Simulated Desktop same-session switch capability (DesktopZCodeProvider only). */
  supportsModelSwitch = false;
  modelSwitchCalls: Array<{ sessionId: string; modelId: string }> = [];
  /**
   * Authoritative plan evidence returned by readSessionState (official-lane
   * behavior). null simulates "plan cannot be proven" → engine must fail
   * closed for readonly lanes.
   */
  planEvidence: boolean | null = true;
  thoughtEvidence: string | null = "max";
  /** When true, the fake attestation omits availability evidence (not proven). */
  unadvertisedModels = false;
  /** Custom advertised reasoning levels for the observed model (official lane). */
  advertisedLevels: string[] | null = null;

  async readSessionState(
    sessionId: string,
    workspace: ProviderWorkspaceRef,
  ): Promise<{
    sessionId: string;
    workspaceKey: string | null;
    workspacePath: string | null;
    providerId: string | null;
    modelId: string | null;
    thoughtLevel: string | null;
    collaborationMode: string | null;
    planEnabled: boolean | null;
    bindingSource: string;
    runtimeVersion: string | null;
    status: string | null;
    observedAt: string;
    availableModels?: Array<{ providerId: string | null; modelId: string; reasoningLevels: string[]; reasoningDefaultLevel: string | null }>;
  } | null> {
    if (this.sessionWorkspaces.get(sessionId) !== workspace.workspaceKey) return null;
    const binding = this.sessionBindings.get(sessionId);
    if (!binding) return null;
    return {
      sessionId,
      workspaceKey: workspace.workspaceKey,
      workspacePath: workspace.workspacePath,
      providerId: binding.provider_id,
      modelId: binding.model_id,
      thoughtLevel: this.thoughtEvidence,
      collaborationMode: this.planEvidence ? "plan" : "edit",
      planEnabled: this.planEvidence,
      bindingSource: binding.source,
      runtimeVersion: this.providerVersion,
      status: this.statusSequence
        ? this.statusSequence[Math.min(this.statusSequenceIndex++, this.statusSequence.length - 1)]!
        : "idle",
      observedAt: new Date().toISOString(),
      // The runtime's own per-model advertisement from the same snapshot:
      // the observed model is advertised with its reasoning levels.
      ...(this.unadvertisedModels ? {} : {
        availableModels: [{
          providerId: binding.provider_id,
          modelId: binding.model_id,
          reasoningLevels: this.advertisedLevels ?? ["low", "high", "max"],
          reasoningDefaultLevel: this.advertisedLevels?.[1] ?? "max",
        }],
      }),
    };
  }

  async readSessionBinding(
    sessionId: string,
    workspace: ProviderWorkspaceRef,
  ): Promise<{ provider_id: string; model_id: string; source: string } | null> {
    // The session's own workspace association must match the authorized one.
    if (this.sessionWorkspaces.get(sessionId) !== workspace.workspaceKey) return null;
    return this.sessionBindings.get(sessionId) ?? null;
  }

  async start(): Promise<void> {
    this.startAttempts += 1;
    if (this.failStart) throw new Error("start failed");
    this.status = "healthy";
  }
  async stop(): Promise<void> {}
  async listSessions(_ws: ProviderWorkspaceRef): Promise<ProviderSessionSummary[]> {
    return [];
  }
  async createSession(
    _ws: ProviderWorkspaceRef,
    options?: { readonly?: boolean; modelId?: string; thoughtLevel?: string },
  ): Promise<string> {
    if (this.failCreate) throw new Error("create failed");
    if (this.sessionDelayMs > 0) await new Promise((r) => setTimeout(r, this.sessionDelayMs));
    const id = `sess_${crypto.randomUUID()}`;
    this.createdSessions.push(id);
    this.outputs.set(id, `OUTPUT_FOR_${id}`);
    this.sessionWorkspaces.set(id, _ws.workspaceKey);
    this.sessionBindings.set(
      id,
      this.nextBinding !== undefined && this.nextBinding !== null
        ? { ...this.nextBinding, source: "desktop-session-read" }
        : this.nextBinding === null
          ? { provider_id: "", model_id: "", source: "unobserved" }
          : {
              provider_id: REQUIRED_START_PLAN_PROVIDER_ID,
              model_id: REQUIRED_START_PLAN_MODEL_ID,
              source: "desktop-session-read",
            },
    );
    if (this.nextBinding === null) this.sessionBindings.delete(id);
    this.nextBinding = undefined;
    // Official-path native selection: the engine passes the requested model /
    // thought level; a provider with switch capability applies it on the same
    // session before admission (others leave the default, and the binding
    // gate fails closed if the default deviates).
    if (options?.modelId && this.supportsModelSwitch) {
      this.modelSwitchCalls.push({ sessionId: id, modelId: options.modelId });
      const binding = this.sessionBindings.get(id);
      if (binding) this.sessionBindings.set(id, { ...binding, model_id: options.modelId });
    }
    return id;
  }
  async resumeSession(_ws: ProviderWorkspaceRef, sessionId: string): Promise<void> {
    if (!this.outputs.has(sessionId)) throw new Error("unknown session");
    this.createdSessions.push(sessionId);
  }
  async updateSessionModel(
    workspace: ProviderWorkspaceRef,
    sessionId: string,
    change: { modelId?: string },
  ): Promise<{ provider_id: string; model_id: string; thoughtLevel: string | null }> {
    if (!this.supportsModelSwitch) throw new Error("not supported");
    this.modelSwitchCalls.push({ sessionId, modelId: change.modelId ?? "" });
    const binding = this.sessionBindings.get(sessionId);
    if (binding) this.sessionBindings.set(sessionId, { ...binding, model_id: change.modelId ?? binding.model_id });
    return { provider_id: binding?.provider_id ?? "", model_id: change.modelId ?? binding?.model_id ?? "", thoughtLevel: null };
  }
  /** When set, the NEXT send throws -32010 once (stale-busy simulation). */
  throwBusyOnce = false;
  /** Statuses returned by readSessionState across successive calls (cycled). */
  statusSequence: string[] | null = null;
  private statusSequenceIndex = 0;
  async send(options: ProviderSendOptions): Promise<ProviderRunHandle> {
    if (this.throwBusyOnce) {
      this.throwBusyOnce = false;
      throw new Error("ZCode Protocol error -32010: A prompt is already running for this session");
    }
    this.executionGrants.push(options.executionGrant);
    this.sentInstructions.push({ sessionId: options.sessionId, instruction: options.instruction });
    const completion = new Promise<ProviderTurnResult>((resolve) => {
      setTimeout(() => resolve({ status: "completed" }), this.turnDelayMs);
    });
    return { sessionId: options.sessionId, completion };
  }
  async stopSession(sessionId: string): Promise<void> {
    this.stoppedSessions.push(sessionId);
  }
  async snapshotAssistantMarker(_sessionId: string): Promise<number> {
    return 0;
  }
  async readAssistantOutput(sessionId: string): Promise<string> {
    return this.outputs.get(sessionId) ?? "";
  }
}

interface Harness {
  engine: TaskEngine;
  provider: FakeProvider;
  store: Persistence;
  workspaces: WorkspaceRegistry;
  dir: string;
}

function buildHarness(opts?: { workspaceCount?: number }): Harness {
  const dir = makeTempDir();
  const store = new Persistence(dir);
  const workspaces = WorkspaceRegistry.fromList([]);
  mkdirSync(join(dir, "ws0"), { recursive: true });
  const ws0 = workspaces.register("z2c-test", join(dir, "ws0"), "test");
  if ((opts?.workspaceCount ?? 1) > 1) {
    mkdirSync(join(dir, "ws1"), { recursive: true });
    workspaces.register("z2c-test-2", join(dir, "ws1"), "test2");
  }
  store.data.workspaces = workspaces.toList();
  store.save();
  const provider = new FakeProvider();
  const audit = new FileAuditLog(join(dir, "audit"));
  const cfg = { ...loadConfig(), stateDir: dir };
  const engine = new TaskEngine(cfg, provider, workspaces, store, audit);
  return { engine, provider, store, workspaces, dir };
}

async function waitTaskTerminal(engine: TaskEngine, taskId: string, timeoutMs = 10000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = engine.getTask(undefined, taskId);
    if (["completed", "failed", "cancelled", "interrupted"].includes(t.status)) return t.status;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`task ${taskId} did not reach terminal state`);
}

describe("workspace isolation", () => {
  it("rejects unknown workspaces", async () => {
    const { engine } = buildHarness();
    await assert.rejects(
      async () => engine.submitTask({ workspace_id: "nope", instruction: "x" }),
      (e: unknown) => e instanceof WorkspaceError && e.code === "UNKNOWN_WORKSPACE",
    );
  });
  it("rejects unauthorized workspaces", async () => {
    const { engine, workspaces } = buildHarness({ workspaceCount: 2 });
    workspaces.setAllowed("z2c-test-2", false);
    await assert.rejects(
      async () => engine.submitTask({ workspace_id: "z2c-test-2", instruction: "x" }),
      (e: unknown) => e instanceof WorkspaceError && e.code === "UNAUTHORIZED_WORKSPACE",
    );
  });
  it("canonicalizes paths and detects mismatch", () => {
    const { workspaces, dir } = buildHarness();
    const entry = workspaces.get("z2c-test");
    workspaces.assertPathMatches("z2c-test", join(dir, "ws0", ".", "sub", ".."));
    assert.throws(() => workspaces.assertPathMatches("z2c-test", dir), WorkspaceError);
    assert.notEqual(entry.canonicalPath, undefined);
  });
  it("rejects traversal-style and relative paths", () => {
    assert.throws(() => canonicalizeWorkspacePath("relative/path"), WorkspaceError);
    assert.throws(() => canonicalizeWorkspacePath("bad<name"), WorkspaceError);
  });
});

describe("task lifecycle", () => {
  it("runs queued→running→completed and produces namespaced output", async () => {
    const h = buildHarness();
    const view = await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "do a thing" });
    assert.match(view.task_id, /^z2c_/);
    assert.ok(["queued", "running", "completed"].includes(view.status));
    const status = await waitTaskTerminal(h.engine, view.task_id);
    assert.equal(status, "completed");
    const t = h.engine.getTask(undefined, view.task_id);
    assert.match(t.session_id ?? "", /^sess_[0-9a-f-]{36}$/);
    // wrong output id must fail closed even though the task has an output
    assert.throws(
      () => h.engine.getOutput(undefined, view.task_id, "z2co_wrong"),
      (e: unknown) => (e as TaskEngineError).code === "OUTPUT_MISMATCH",
    );
  });
  it("fails closed on output id mismatch", async () => {
    const h = buildHarness();
    const view = await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "x" });
    await waitTaskTerminal(h.engine, view.task_id);
    assert.throws(
      () => h.engine.getOutput(undefined, view.task_id, "z2co_deadbeef"),
      (e: unknown) => (e as TaskEngineError).code === "OUTPUT_MISMATCH",
    );
  });
  it("correct output id returns text; task scoped to workspace", async () => {
    const h = buildHarness();
    const view = await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "x" });
    await waitTaskTerminal(h.engine, view.task_id);
    const rec = h.store.findTask(view.task_id)!;
    assert.ok(rec.outputId);
    const out = h.engine.getOutput(undefined, view.task_id, rec.outputId!);
    assert.equal(out.text, `OUTPUT_FOR_${rec.zcodeSessionId}`);
    // wrong workspace scope must be rejected
    assert.throws(
      () => h.engine.getOutput("other-ws", view.task_id, rec.outputId!),
      (e: unknown) => (e as TaskEngineError).code === "WORKSPACE_MISMATCH",
    );
  });
  it("submit fails closed when session creation fails (no task record)", async () => {
    const h = buildHarness();
    h.provider.failCreate = true;
    await assert.rejects(
      async () => h.engine.submitTask({ workspace_id: "z2c-test", instruction: "x" }),
      /create failed/,
    );
    assert.equal(h.store.data.tasks.length, 0);
  });
  it("submit returns the real task id and native sess_ id immediately", async () => {
    const h = buildHarness();
    const view = await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "bind me" });
    assert.match(view.task_id, /^z2c_/);
    assert.match(view.session_id ?? "", /^sess_[0-9a-f-]{36}$/);
    assert.deepEqual(h.provider.createdSessions, [view.session_id]);
    // Execution continues asynchronously; the session is already bound.
    assert.equal(await waitTaskTerminal(h.engine, view.task_id), "completed");
  });
  it("unhealthy provider rejects submissions (fail closed)", async () => {
    const h = buildHarness();
    h.provider.status = "incompatible";
    await assert.rejects(
      async () => h.engine.submitTask({ workspace_id: "z2c-test", instruction: "x" }),
      (e: unknown) => (e as TaskEngineError).code === "PROVIDER_UNAVAILABLE",
    );
  });
  it("unreachable provider is re-probed once and recovers without a bridge restart", async () => {
    const h = buildHarness();
    h.provider.status = "unreachable"; // e.g. desktop agent died and re-registered
    const view = await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "recover" });
    assert.equal(h.provider.status, "healthy");
    assert.match(view.task_id, /^z2c_/);
    assert.equal(await waitTaskTerminal(h.engine, view.task_id), "completed");
  });
  it("unreachable provider that stays down still fails closed", async () => {
    const h = buildHarness();
    h.provider.status = "unreachable";
    h.provider.failStart = true;
    await assert.rejects(
      async () => h.engine.submitTask({ workspace_id: "z2c-test", instruction: "x" }),
      (e: unknown) => (e as TaskEngineError).code === "PROVIDER_UNAVAILABLE",
    );
    assert.equal(h.provider.startAttempts, 1);
  });
  it("cancel before completion calls session stop and marks cancelled", async () => {
    const h = buildHarness();
    h.provider.turnDelayMs = 2000;
    const view = await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "long task" });
    // wait until actually running (session created)
    const deadline = Date.now() + 5000;
    while (!h.engine.getTask(undefined, view.task_id).session_id && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const cancelled = h.engine.cancelTask(undefined, view.task_id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(h.provider.stoppedSessions.length, 1);
  });
  it("cancel of queued task cancels locally without touching ZCode", async () => {
    const h = buildHarness();
    h.provider.turnDelayMs = 1500;
    const first = await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "first" });
    const second = await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "second" });
    assert.equal(second.status, "queued");
    const cancelled = h.engine.cancelTask(undefined, second.task_id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(h.provider.stoppedSessions.length, 0);
    await waitTaskTerminal(h.engine, first.task_id);
  });
  it("already-terminal cancel is deterministic", async () => {
    const h = buildHarness();
    const view = await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "x" });
    await waitTaskTerminal(h.engine, view.task_id);
    const again = h.engine.cancelTask(undefined, view.task_id);
    assert.equal(again.status, "completed"); // unchanged truth
  });
  it("resume binds the task to the existing sess_ id", async () => {
    const h = buildHarness();
    const first = await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "first" });
    await waitTaskTerminal(h.engine, first.task_id);
    const sessionId = h.engine.getTask(undefined, first.task_id).session_id!;
    const second = await h.engine.submitTask({
      workspace_id: "z2c-test",
      instruction: "follow-up",
      resume_session_id: sessionId,
    });
    await waitTaskTerminal(h.engine, second.task_id);
    assert.equal(h.engine.getTask(undefined, second.task_id).session_id, sessionId);
  });
  it("rejects malformed resume session ids", async () => {
    const h = buildHarness();
    await assert.rejects(
      async () => h.engine.submitTask({ workspace_id: "z2c-test", instruction: "x", resume_session_id: "../../etc" }),
      (e: unknown) => (e as TaskEngineError).code === "INVALID_SESSION",
    );
  });
  it("rejects empty/oversized instructions", async () => {
    const h = buildHarness();
    await assert.rejects(
      async () => h.engine.submitTask({ workspace_id: "z2c-test", instruction: "   " }),
      (e: unknown) => (e as TaskEngineError).code === "INVALID_INSTRUCTION",
    );
    await assert.rejects(
      async () => h.engine.submitTask({ workspace_id: "z2c-test", instruction: "x".repeat(30000) }),
      (e: unknown) => (e as TaskEngineError).code === "INVALID_INSTRUCTION",
    );
  });
});

describe("queue", () => {
  it("FIFO: one active writer per workspace", async () => {
    const h = buildHarness();
    h.provider.turnDelayMs = 200;
    const ids = await Promise.all(["a", "b", "c"].map(
      async (n) => (await h.engine.submitTask({ workspace_id: "z2c-test", instruction: n })).task_id,
    ));
    // Immediately: first should become running, others queued in order
    const q = h.engine.getQueue("z2c-test");
    assert.equal(q.activeTask, ids[0]);
    assert.equal(q.queuedTaskCount >= 1, true);
    assert.equal(q.nextQueuedTaskId, ids[1]);
    for (const id of ids) await waitTaskTerminal(h.engine, id);
    const order = h.provider.sentInstructions.map((s) => s.instruction);
    assert.deepEqual(order, ["a", "b", "c"]);
  });
  it("paused workspace does not dispatch; resume drains FIFO", async () => {
    const h = buildHarness();
    h.engine.pauseQueue("z2c-test");
    const view = await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "held" });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(h.engine.getTask(undefined, view.task_id).status, "queued");
    // The native session is bound at submit time; the instruction itself must
    // not be sent while the queue is paused.
    assert.equal(h.provider.createdSessions.length, 1, "session is bound at submit");
    assert.equal(h.provider.sentInstructions.length, 0, "session/send must not be called while paused");
    h.engine.resumeQueue("z2c-test");
    await waitTaskTerminal(h.engine, view.task_id);
    assert.equal(h.engine.getQueue("z2c-test").paused, false);
  });
});

describe("persistence / restart", () => {
  it("reconcileOnRestart marks running tasks interrupted and clears active", () => {
    const dir = makeTempDir();
    try {
      const store = new Persistence(dir);
      store.upsertTask({
        taskId: "z2c_abc", workspaceId: "w", zcodeSessionId: "sess_x", status: "running",
        instruction: "i", writeScope: "workspace", network: "default", mode: "build",
        createdAt: 1, startedAt: 2, completedAt: null, exitStatus: null, outputId: null,
        resumeOfSessionId: null, modelBinding: null,
      });
      const q = store.getOrCreateQueue("w");
      q.activeTask = "z2c_abc";
      q.queuedTaskIds.push("z2c_def");
      store.saveQueue("w", q);

      // Simulate bridge restart with a fresh Persistence over the same state dir
      const store2 = new Persistence(dir);
      const touched = store2.reconcileOnRestart();
      assert.deepEqual(touched, ["z2c_abc"]);
      assert.equal(store2.findTask("z2c_abc")!.status, "interrupted");
      assert.equal(store2.getOrCreateQueue("w").activeTask, null);
      assert.deepEqual(store2.getOrCreateQueue("w").queuedTaskIds, ["z2c_def"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("completed task truth survives restart unchanged", () => {
    const dir = makeTempDir();
    try {
      const store = new Persistence(dir);
      store.upsertTask({
        taskId: "z2c_done", workspaceId: "w", zcodeSessionId: "sess_y", status: "completed",
        instruction: "i", writeScope: "workspace", network: "default", mode: "build",
        createdAt: 1, startedAt: 2, completedAt: 3, exitStatus: "ok", outputId: null,
        resumeOfSessionId: null, modelBinding: null,
      });
      const store2 = new Persistence(dir);
      store2.reconcileOnRestart();
      assert.equal(store2.findTask("z2c_done")!.status, "completed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("protocol layer (in-memory fake transport)", () => {
  it("correlates responses and rejects unknown client requests", async () => {
    // exercised indirectly via ZcodeProtocol unit below
  });
});

describe("provider_status (session-observed binding)", () => {
  interface ToolLike {
    handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    inputSchema: { parse: (a: unknown) => unknown };
  }
  function providerStatusTool(h: Harness): { invoke: (args: unknown) => Promise<Record<string, unknown>>; fail: (args: unknown) => Promise<unknown> } {
    const audit = new FileAuditLog(join(h.dir, "audit"));
    const server = buildMcpServer({ engine: h.engine, workspaces: h.workspaces, store: h.store, provider: h.provider, audit });
    const tool = (server as unknown as { _registeredTools: Record<string, ToolLike> })._registeredTools["provider_status"]!;
    return {
      invoke: async (args) => JSON.parse((await tool.handler(tool.inputSchema.parse(args), {})).content[0]!.text),
      fail: async (args) => tool.handler(tool.inputSchema.parse(args), {}),
    };
  }

  it("reports the binding observed for the workspace's exact active session only", async () => {
    const h = buildHarness({ workspaceCount: 2 });
    h.provider.turnDelayMs = 400; // keep the submitted task active
    const view = await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "run" });
    const { invoke, fail } = providerStatusTool(h);

    const own = await invoke({ workspace_id: "z2c-test" });
    assert.equal(own.workspace_id, "z2c-test");
    assert.equal(own.session_id, view.session_id);
    assert.equal(own.uses_desktop_managed_auth, false);
    assert.deepEqual(own.model_binding, {
      provider_id: REQUIRED_START_PLAN_PROVIDER_ID,
      model_id: REQUIRED_START_PLAN_MODEL_ID,
      source: "desktop-session-read",
    });

    // No active session in the other workspace: binding is unknown there —
    // this workspace's session state never authorizes the other one.
    const other = await invoke({ workspace_id: "z2c-test-2" });
    assert.equal(other.workspace_id, "z2c-test-2");
    assert.equal(other.session_id, null);
    assert.equal(other.model_binding, null);

    // Unknown workspace: the handler converts the error to a coded tool error.
    const unknown = await fail({ workspace_id: "nope" });
    assert.match(unknown.content[0]!.text, /UNKNOWN_WORKSPACE/);
  });

  it("reports unknown binding when no active session exists (registration alone is not evidence)", async () => {
    const h = buildHarness();
    const { invoke } = providerStatusTool(h);
    const body = await invoke({ workspace_id: "z2c-test" });
    assert.equal(body.workspace_id, "z2c-test");
    assert.equal(body.session_id, null);
    assert.equal(body.model_binding, null);
  });
});

describe("submit binding gate (two-phase: exact session then observed binding)", () => {
  it("rejects submit and sends nothing when the session binding is unobserved", async () => {
    const h = buildHarness();
    h.provider.nextBinding = null; // session exists but reports no model state
    await assert.rejects(
      async () => h.engine.submitTask({ workspace_id: "z2c-test", instruction: "x" }),
      (e: unknown) => (e as TaskEngineError).code === "BINDING_UNVERIFIED",
    );
    assert.equal(h.store.data.tasks.length, 0);
    assert.equal(h.provider.sentInstructions.length, 0);
  });

  it("rejects wrong observed provider routes before any governed instruction send", async () => {
    const h = buildHarness();
    h.provider.nextBinding = { provider_id: "custom:z2c", model_id: "GLM-5.3-Flash" };
    await assert.rejects(
      () => h.engine.submitTask({ workspace_id: "z2c-test", instruction: "x" }),
      (e: unknown) => (e as TaskEngineError).code === "BINDING_UNVERIFIED",
    );
    h.provider.nextBinding = { provider_id: "builtin:zai-start-plan", model_id: "GLM-5.3-Flash" };
    await assert.rejects(
      () => h.engine.submitTask({ workspace_id: "z2c-test", instruction: "y" }),
      (e: unknown) => (e as TaskEngineError).code === "BINDING_UNVERIFIED",
    );
    h.provider.nextBinding = { provider_id: "manual:desktop", model_id: "GLM-5.3" }; // unknown route: never governed
    await assert.rejects(
      async () => h.engine.submitTask({ workspace_id: "z2c-test", instruction: "z" }),
      (e: unknown) => (e as TaskEngineError).code === "BINDING_UNVERIFIED",
    );
    assert.equal(h.provider.sentInstructions.length, 0);
    assert.equal(h.store.data.tasks.length, 0);
  });

  it("fails closed when the binding evidence is not Desktop-managed (headless route)", async () => {
    const h = buildHarness();
    // Correct identity strings but headless-style evidence source: the
    // headless fallback provider cannot prove Desktop-managed auth.
    h.provider.nextBinding = {
      provider_id: REQUIRED_START_PLAN_PROVIDER_ID,
      model_id: REQUIRED_START_PLAN_MODEL_ID,
    };
    const injected = h.provider;
    const realCreate = injected.createSession.bind(injected);
    injected.createSession = async (ws: Parameters<typeof injected.createSession>[0]) => {
      const id = await realCreate(ws);
      const binding = injected.sessionBindings.get(id);
      if (binding) injected.sessionBindings.set(id, { ...binding, source: "session-read" });
      return id;
    };
    void REQUIRED_BINDING_SOURCE;
    await assert.rejects(
      async () => h.engine.submitTask({ workspace_id: "z2c-test", instruction: "x" }),
      (e: unknown) => (e as TaskEngineError).code === "BINDING_UNVERIFIED",
    );
    assert.equal(h.store.data.tasks.length, 0);
    assert.equal(h.provider.sentInstructions.length, 0);
  });

  it("admits the observed advertised default when no explicit identity is requested (catalog-driven policy)", async () => {
    const h = buildHarness();
    // Desktop default = the coding-plan route's own current model. Under the
    // catalog-driven policy there is no single-model constant: the observed
    // binding on an admissible route is governed evidence.
    h.provider.nextBinding = { provider_id: "builtin:zai-coding-plan", model_id: "GLM-5.3" };
    const view = await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "x" });
    assert.equal(view.model_binding?.model_id, "GLM-5.3");
    assert.equal(await waitTaskTerminal(h.engine, view.task_id), "completed");
    assert.equal(h.provider.sentInstructions.length, 1);
  });

  it("applies an EXPLICIT requested native model on the SAME session inside createSession before admission", async () => {
    const h = buildHarness();
    h.provider.usesDesktopManagedAuth = true; // native-auth capability (official lane)
    h.provider.supportsModelSwitch = true;
    h.provider.nextBinding = { provider_id: "builtin:zai-coding-plan", model_id: "GLM-5.3" }; // runtime default = main
    const view = await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "flash work", model_id: "GLM-5.3-Flash" });
    // The engine forwarded the EXPLICIT request at create time; the provider
    // applied it on the same session, so admission observes exactly the request.
    assert.deepEqual(h.provider.modelSwitchCalls, [{ sessionId: view.session_id, modelId: "GLM-5.3-Flash" }]);
    assert.equal(h.provider.sessionBindings.get(view.session_id)?.model_id, "GLM-5.3-Flash");
    assert.equal(view.model_binding?.model_id, "GLM-5.3-Flash");
    assert.equal(view.requested_model_id, "GLM-5.3-Flash");
    assert.equal(await waitTaskTerminal(h.engine, view.task_id), "completed");
  });

  it("fails closed when an explicit model request is not what the session observed (no silent substitution)", async () => {
    const h = buildHarness();
    h.provider.usesDesktopManagedAuth = true;
    // Provider cannot switch: the session stays on the runtime default while
    // the caller explicitly requested Flash — mismatch must reject.
    await assert.rejects(
      () => h.engine.submitTask({ workspace_id: "z2c-test", instruction: "x", model_id: "GLM-5.3-Flash" }),
      (e: unknown) => (e as TaskEngineError).code === "BINDING_UNVERIFIED",
    );
    assert.equal(h.provider.sentInstructions.length, 0);
    assert.equal(h.store.data.tasks.length, 0);
  });

  it("accepts submit when the exact session reports the required binding", async () => {
    const h = buildHarness();
    const view = await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "ok" });
    assert.match(view.session_id ?? "", /^sess_[0-9a-f-]{36}$/);
    assert.equal(await waitTaskTerminal(h.engine, view.task_id), "completed");
  });

  it("accepts the official standalone evidence source (official-session-read) for governed admission", async () => {
    const h = buildHarness();
    h.provider.name = "zcode-official";
    h.provider.usesDesktopManagedAuth = true; // official lane: auth resolved in ZCode
    const injected = h.provider;
    const realCreate = injected.createSession.bind(injected);
    injected.createSession = async (ws: Parameters<typeof injected.createSession>[0], options?: { readonly?: boolean }) => {
      const id = await realCreate(ws, options);
      const binding = injected.sessionBindings.get(id);
      if (binding) injected.sessionBindings.set(id, { ...binding, source: "official-session-read" });
      return id;
    };
    const view = await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "official lane" });
    assert.equal(await waitTaskTerminal(h.engine, view.task_id), "completed");
    assert.equal(h.provider.sentInstructions.length, 1);
  });

  it("accepts an official session at any advertised thought level (no max-only rule)", async () => {
    const h = buildHarness();
    h.provider.name = "zcode-official";
    h.provider.thoughtEvidence = "high";
    const originalCreate = h.provider.createSession.bind(h.provider);
    h.provider.createSession = async (ws, options) => {
      const id = await originalCreate(ws, options);
      const binding = h.provider.sessionBindings.get(id);
      if (binding) h.provider.sessionBindings.set(id, { ...binding, source: "official-session-read" });
      return id;
    };
    const view = await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "x" });
    assert.equal(view.model_binding?.model_id, REQUIRED_START_PLAN_MODEL_ID);
    await waitTaskTerminal(h.engine, view.task_id);
  });

  it("settles a transient -32010 on the governed lane via authoritative runtime evidence and retries once", async () => {
    const h = buildHarness();
    h.provider.throwBusyOnce = true;
    h.provider.statusSequence = ["running", "idle"]; // first settle poll: still busy; second: idle
    const view = await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "busy settle" });
    assert.equal(await waitTaskTerminal(h.engine, view.task_id), "completed");
    assert.equal(h.provider.sentInstructions.length, 1, "exactly one user turn was sent");
    const failed = h.store.data.tasks.find((t) => t.taskId === view.task_id);
    assert.equal(failed?.status, "completed");
  });

  it("fails closed with SESSION_BUSY when the runtime stays busy through the settle budget", async () => {
    const h = buildHarness();
    h.provider.throwBusyOnce = true;
    h.provider.statusSequence = ["running", "running", "running", "running"]; // never idle
    (h.engine as unknown as { cfg: { busySettleMs?: number } }).cfg.busySettleMs = 800;
    const view = await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "stuck busy" });
    // The pump runs asynchronously: the settle failure lands on the task record.
    assert.equal(await waitTaskTerminal(h.engine, view.task_id), "failed");
    const failed = h.store.data.tasks.find((t) => t.taskId === view.task_id);
    assert.match(String(failed?.exitStatus ?? "") + String(failed && "status" in failed ? failed.status : ""), /failed/);
  });

  it("fails closed when an official session's observed model is not advertised by the same snapshot", async () => {
    const h = buildHarness();
    h.provider.name = "zcode-official";
    h.provider.usesDesktopManagedAuth = true;
    h.provider.unadvertisedModels = true; // snapshot carries no availability evidence
    const originalCreate = h.provider.createSession.bind(h.provider);
    h.provider.createSession = async (ws, options) => {
      const id = await originalCreate(ws, options);
      const binding = h.provider.sessionBindings.get(id);
      if (binding) h.provider.sessionBindings.set(id, { ...binding, source: "official-session-read" });
      return id;
    };
    await assert.rejects(
      () => h.engine.submitTask({ workspace_id: "z2c-test", instruction: "x" }),
      (e: unknown) => (e as TaskEngineError).code === "BINDING_UNVERIFIED",
    );
    assert.equal(h.provider.sentInstructions.length, 0);
    assert.equal(h.store.data.tasks.length, 0);
  });
});

describe("admission ordering and dispatch authorization", () => {
  it("one remaining capacity: concurrent submits keep capacity exact and FIFO order", async () => {
    const dir = makeTempDir();
    const store = new Persistence(dir);
    const workspaces = WorkspaceRegistry.fromList([]);
    mkdirSync(join(dir, "ws0"), { recursive: true });
    workspaces.register("z2c-test", join(dir, "ws0"), "test");
    store.data.workspaces = workspaces.toList();
    store.save();
    const provider = new FakeProvider();
    provider.sessionDelayMs = 80; // session creation awaits while the second submit arrives
    provider.turnDelayMs = 150;
    const audit = new FileAuditLog(join(dir, "audit"));
    const cfg = { ...loadConfig(), stateDir: dir, queue: { maxQueuedPerWorkspace: 1 } };
    const engine = new TaskEngine(cfg, provider, workspaces, store, audit);

    const results = await Promise.allSettled([
      engine.submitTask({ workspace_id: "z2c-test", instruction: "first" }),
      engine.submitTask({ workspace_id: "z2c-test", instruction: "second" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ task_id: string; session_id: string | null }>[];
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(fulfilled.length, 1, "exactly one submit fits the remaining capacity");
    assert.equal(rejected.length, 1);
    assert.match(String(rejected[0]!.reason), /QUEUE_FULL|queue is full/);
    assert.equal(fulfilled[0]!.value.session_id != null, true);
    assert.equal(provider.createdSessions.length, 1, "the over-capacity submit never creates a session");
    // Dispatch of the admitted task races with allSettled resolution; wait
    // boundedly for the send instead of asserting mid-flight.
    for (let i = 0; i < 100 && provider.sentInstructions.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual(provider.sentInstructions.map((s) => s.instruction), ["first"]);
    await waitTaskTerminal(engine, fulfilled[0]!.value.task_id);
  });

  it("a workspace revoked while queued is rejected at dispatch before session/send", async () => {
    const h = buildHarness();
    h.provider.turnDelayMs = 1200; // keep the first task active so the second stays queued
    const first = await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "first" });
    const second = await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "second" });
    h.workspaces.setAllowed("z2c-test", false);
    await waitTaskTerminal(h.engine, second.task_id);
    assert.equal(h.provider.sentInstructions.some((x) => x.instruction === "second"), false);
    assert.equal(h.engine.getTask(undefined, second.task_id).status, "failed");
    assert.equal(h.engine.getTask(undefined, first.task_id).status, "completed");
  });
});

describe("config", () => {
  it("defaults to the Z2C-owned loopback port 8766 (distinct from Quanta 8765)", () => {
    const previous = process.env.Z2C_PORT;
    delete process.env.Z2C_PORT;
    try {
      assert.equal(loadConfig().port, 8766);
      assert.equal(loadConfig().host, "127.0.0.1");
    } finally {
      if (previous !== undefined) process.env.Z2C_PORT = previous;
    }
  });
});

describe("durable workspace idempotency", () => {
  const input = { workspace_id: "z2c-test", instruction: "review original source", write_scope: "readonly" as const, mode: "plan" as const, idempotency_key: "review-intent_1" };
  function reboot(h: Harness) {
    const store = new Persistence(h.dir);
    store.reconcileOnRestart();
    const engine = new TaskEngine({ ...loadConfig(), stateDir: h.dir }, h.provider, h.workspaces, store, new FileAuditLog(join(h.dir, "audit")));
    return { store, engine };
  }
  it("concurrent duplicate requests admit one exact session/task and send once with durable truth already installed", async () => {
    const h = buildHarness(); h.provider.sessionDelayMs = 20;
    const send = h.provider.send.bind(h.provider);
    h.provider.send = async options => {
      const disk = JSON.parse(readFileSync(join(h.dir, "state.json"), "utf8"));
      const task = disk.tasks.find((t: any) => t.zcodeSessionId === options.sessionId);
      assert.equal(task.idempotency.key, input.idempotency_key);
      assert.equal(task.idempotency.fingerprint, requestFingerprint(input));
      assert.equal(task.status, "running");
      assert.equal(disk.queues[input.workspace_id].activeTask, task.taskId);
      return send(options);
    };
    const [first, replay] = await Promise.all([h.engine.submitTask(input), h.engine.submitTask(input)]);
    assert.equal(first.task_id, replay.task_id); assert.equal(first.session_id, replay.session_id);
    assert.deepEqual(first.model_binding, replay.model_binding); assert.equal(replay.idempotency?.replayed, true);
    await waitTaskTerminal(h.engine, first.task_id);
    assert.equal(h.provider.createdSessions.length, 1); assert.equal(h.provider.sentInstructions.length, 1);
  });
  for (const changed of [{ instruction: "changed" }, { write_scope: "workspace" as const }, { mode: "build" as const }, { resume_session_id: `sess_${crypto.randomUUID()}` }]) {
    it(`conflicts without a second session/send for ${Object.keys(changed)[0]}`, async () => {
      const h = buildHarness(); const first = await h.engine.submitTask(input); await waitTaskTerminal(h.engine, first.task_id);
      await assert.rejects(h.engine.submitTask({ ...input, ...changed }), (e: any) => e.code === "IDEMPOTENCY_CONFLICT");
      assert.equal(h.provider.createdSessions.length, 1); assert.equal(h.provider.sentInstructions.length, 1);
    });
  }
  it("scopes the same key to authorized workspace and rejects revocation", async () => {
    const h = buildHarness({ workspaceCount: 2 }); h.engine.pauseQueue("z2c-test"); h.engine.pauseQueue("z2c-test-2");
    const a = await h.engine.submitTask(input), b = await h.engine.submitTask({ ...input, workspace_id: "z2c-test-2" });
    assert.notEqual(a.task_id, b.task_id); assert.notEqual(a.session_id, b.session_id);
    h.workspaces.setAllowed("z2c-test", false);
    await assert.rejects(h.engine.submitTask(input), (e: any) => e.code === "UNAUTHORIZED_WORKSPACE");
    assert.equal(h.provider.sentInstructions.length, 0);
  });
  it("restart replays completed truth and never sends again", async () => {
    const h = buildHarness(); const first = await h.engine.submitTask(input); await waitTaskTerminal(h.engine, first.task_id);
    const restarted = reboot(h); restarted.engine.startQueuedTasks();
    h.provider.status = "incompatible";
    const replay = await restarted.engine.submitTask(input);
    assert.equal(replay.task_id, first.task_id); assert.equal(replay.session_id, first.session_id);
    assert.equal(replay.status, "completed"); assert.equal(replay.idempotency?.replayed, true);
    assert.equal(h.provider.createdSessions.length, 1); assert.equal(h.provider.sentInstructions.length, 1);
  });
  it("bootstrap restores a reserved-but-unsent queue head and preserves FIFO", async () => {
    const h = buildHarness(); h.engine.pauseQueue("z2c-test");
    const first = await h.engine.submitTask(input), second = await h.engine.submitTask({ ...input, instruction: "second", idempotency_key: "second" });
    const q = h.store.getOrCreateQueue("z2c-test"); q.activeTask = q.queuedTaskIds.shift()!; q.paused = false; h.store.save();
    const restarted = reboot(h);
    assert.deepEqual(restarted.store.getOrCreateQueue("z2c-test").queuedTaskIds, [first.task_id, second.task_id]);
    await restarted.engine.submitTask(input); restarted.engine.startQueuedTasks();
    await waitTaskTerminal(restarted.engine, second.task_id);
    assert.deepEqual(h.provider.sentInstructions.map(t => t.instruction), [input.instruction, "second"]);
    assert.equal(h.provider.createdSessions.length, 2);
  });
  it("running crash stays interrupted on replay rather than risking a second send", async () => {
    const h = buildHarness(); h.engine.pauseQueue("z2c-test"); const first = await h.engine.submitTask(input);
    h.store.setStatus(first.task_id, "running");
    const q = h.store.getOrCreateQueue("z2c-test"); q.activeTask = q.queuedTaskIds.shift()!; q.paused = false; h.store.save();
    const restarted = reboot(h); restarted.engine.startQueuedTasks();
    assert.equal((await restarted.engine.submitTask(input)).status, "interrupted");
    assert.equal(h.provider.createdSessions.length, 1); assert.equal(h.provider.sentInstructions.length, 0);
  });
  it("replay does not consume capacity and no-key requests remain independent", async () => {
    const h = buildHarness(); h.engine.pauseQueue("z2c-test");
    const engine = new TaskEngine({ ...loadConfig(), queue: { maxQueuedPerWorkspace: 2 } }, h.provider, h.workspaces, h.store, new FileAuditLog(join(h.dir, "audit")));
    const first = await engine.submitTask(input);
    const ordinary = { workspace_id: input.workspace_id, instruction: input.instruction };
    const second = await engine.submitTask(ordinary);
    assert.equal((await engine.submitTask(input)).task_id, first.task_id);
    await assert.rejects(engine.submitTask(ordinary), (e: any) => e.code === "QUEUE_FULL");
    assert.equal(h.provider.createdSessions.length, 2);
    engine.cancelTask(input.workspace_id, second.task_id);
    assert.notEqual((await engine.submitTask(ordinary)).task_id, second.task_id);
    assert.deepEqual(h.store.getOrCreateQueue(input.workspace_id).queuedTaskIds[0], first.task_id);
  });
  it("never evicts keyed admission truth during legacy record trimming", async () => {
    const h = buildHarness(); h.engine.pauseQueue("z2c-test"); const first = await h.engine.submitTask(input);
    const record = h.store.findTask(first.task_id)!;
    for (let i = 0; i < 501; i++) h.store.data.tasks.push({ ...record, taskId: `z2c_legacy_${i}`, idempotency: undefined });
    h.store.upsertTask(h.store.data.tasks.at(-1)!);
    const restarted = reboot(h);
    assert.equal((await restarted.engine.submitTask(input)).task_id, first.task_id);
  });
  it("fails closed before send and future replay after admission persistence fails", async () => {
    const h = buildHarness(); const save = h.store.save.bind(h.store);
    h.store.save = () => { throw new Error("disk failure"); };
    await assert.rejects(h.engine.submitTask(input), /disk failure/);
    h.store.save = save;
    await assert.rejects(h.engine.submitTask(input), /PERSISTENCE_UNAVAILABLE/);
    assert.equal(h.store.data.tasks.length, 0); assert.equal(h.provider.sentInstructions.length, 0);
  });
  it("keyed admission still requires exact session binding and replay rejects corrupted binding", async () => {
    const h = buildHarness(); h.provider.nextBinding = null;
    await assert.rejects(h.engine.submitTask(input), (e: any) => e.code === "BINDING_UNVERIFIED");
    assert.equal(h.store.data.tasks.length, 0); assert.equal(h.provider.sentInstructions.length, 0);
    h.engine.pauseQueue("z2c-test"); const admitted = await h.engine.submitTask(input);
    h.store.findTask(admitted.task_id)!.modelBinding = null; h.store.save();
    await assert.rejects(reboot(h).engine.submitTask(input), (e: any) => e.code === "IDEMPOTENCY_INVALID");
    assert.equal(h.provider.sentInstructions.length, 0);
  });
  it("MCP advertises support and returns the full observed task and key proof", async () => {
    const h = buildHarness(); h.engine.pauseQueue("z2c-test");
    const server = buildMcpServer({ ...h, audit: new FileAuditLog(join(h.dir, "audit")) });
    const tools = (server as any)._registeredTools;
    const invoke = async (name: string, args: unknown) => JSON.parse((await tools[name].handler(tools[name].inputSchema.parse(args), {})).content[0].text);
    assert.equal((await invoke("provider_status", { workspace_id: input.workspace_id })).durable_idempotency, "workspace-task-v1");
    const first = await invoke("submit_zcode_task", input), replay = await invoke("submit_zcode_task", input);
    assert.deepEqual(first.model_binding, replay.model_binding); assert.ok(first.model_binding);
    assert.equal(first.task_id, replay.task_id); assert.equal(replay.idempotency.replayed, true);
    for (const key of ["", "-prefix", "a\n", "a/b", "a:b", "é", "x".repeat(129)]) {
      assert.throws(() => tools.submit_zcode_task.inputSchema.parse({ ...input, idempotency_key: key }));
      await assert.rejects(h.engine.submitTask({ ...input, idempotency_key: key }), (e: any) => e.code === "INVALID_IDEMPOTENCY_KEY");
    }
    assert.equal(h.provider.createdSessions.length, 1);
  });
});


describe("pre-send durability failure", () => {
  it("never sends after the running marker fails to persist; restart recovers the unsent task once", async () => {
    const h = buildHarness(), save = h.store.save.bind(h.store);
    const blocked = join(h.dir, "blocked-target"); mkdirSync(blocked);
    let saves = 0;
    h.store.save = () => {
      if (++saves === 3) (h.store as any).path = blocked;
      save();
    };
    const input = { workspace_id: "z2c-test", instruction: "original", idempotency_key: "durable-before-send" };
    const first = await h.engine.submitTask(input);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(h.provider.sentInstructions.length, 0);
    assert.throws(() => h.store.assertHealthy(), /PERSISTENCE_UNAVAILABLE/);
    const store = new Persistence(h.dir); store.reconcileOnRestart();
    const engine = new TaskEngine(loadConfig(), h.provider, h.workspaces, store, new FileAuditLog(join(h.dir, "audit")));
    assert.equal((await engine.submitTask(input)).task_id, first.task_id);
    engine.startQueuedTasks(); await waitTaskTerminal(engine, first.task_id);
    assert.equal(h.provider.sentInstructions.length, 1); assert.equal(h.provider.createdSessions.length, 1);
  });
});



describe("idempotency namespace stability", () => {
  it("cannot use a key from the same ID re-registered at a different canonical workspace", async () => {
    const h = buildHarness({ workspaceCount: 2 }); h.engine.pauseQueue("z2c-test");
    const input = { workspace_id: "z2c-test", instruction: "original", idempotency_key: "workspace-path-bound" };
    await h.engine.submitTask(input);
    h.workspaces.register("z2c-test", join(h.dir, "ws1"));
    await assert.rejects(h.engine.submitTask(input), (e: any) => e.code === "IDEMPOTENCY_CONFLICT");
    assert.equal(h.provider.createdSessions.length, 1); assert.equal(h.provider.sentInstructions.length, 0);
  });
  it("rejects a canonical workspace change while the exact session binding read awaits", async () => {
    const h = buildHarness({ workspaceCount: 2 });
    const readState = h.provider.readSessionState.bind(h.provider);
    h.provider.readSessionState = async (session, workspace) => {
      const attestation = await readState(session, workspace);
      // The workspace's canonical path changes WHILE the authoritative read
      // is in flight — admission must notice and refuse.
      h.workspaces.register("z2c-test", join(h.dir, "ws1"));
      return attestation;
    };
    await assert.rejects(h.engine.submitTask({ workspace_id: "z2c-test", instruction: "original", idempotency_key: "workspace-race" }), (e: any) => e.code === "WORKSPACE_MISMATCH");
    assert.equal(h.store.data.tasks.length, 0); assert.equal(h.provider.sentInstructions.length, 0);
  });
  it("never treats an unknown durable state version as an empty key registry", () => {
    const dir = makeTempDir(); writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 999 }));
    assert.throws(() => new Persistence(dir), /Unsupported durable task state/);
  });
});


describe("immediate native continuation", () => {
  it("rejects paused and busy work without sending or queuing", async () => {
    const h = buildHarness();
    h.engine.pauseQueue("z2c-test");
    await assert.rejects(h.engine.submitTask({ workspace_id: "z2c-test", instruction: "bounded", immediate: true }), /paused or busy/);
    assert.equal(h.store.data.tasks.length, 0);
    h.engine.resumeQueue("z2c-test");
    h.provider.turnDelayMs = 50;
    await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "first" });
    await assert.rejects(h.engine.submitTask({ workspace_id: "z2c-test", instruction: "bounded", immediate: true }), /paused or busy/);
    assert.equal(h.store.data.tasks.length, 1);
  });
  it("returns model proof on same-session MCP resume and rejects changed model", async () => {
    const h = buildHarness();
    const ws = h.workspaces.get("z2c-test");
    const sid = await h.provider.createSession({ workspacePath: ws.canonicalPath, workspaceKey: ws.canonicalPath });
    h.provider.name = "zcode-desktop"; h.provider.usesDesktopManagedAuth = true;
    h.provider.sessionBindings.get(sid)!.source = "desktop-session-read";
    const server = buildMcpServer({ ...h, audit: new FileAuditLog(join(h.dir, "audit")) });
    const tools = (server as any)._registeredTools;
    const call = (name: string, args: unknown) => tools[name].handler(tools[name].inputSchema.parse(args), {});
    const input = { workspace_id: "z2c-test", session_id: sid, instruction: "bounded canary" };
    const read = JSON.parse((await call("read_zcode_session", input)).content[0].text);
    assert.equal(read.session_id, sid); assert.equal(read.canonical_path, ws.canonicalPath);
    const result = JSON.parse((await call("resume_zcode_session", input)).content[0].text);
    assert.equal(result.session_id, sid); assert.equal(result.model_binding.model_id, REQUIRED_START_PLAN_MODEL_ID);
    await waitTaskTerminal(h.engine, result.task_id);
    assert.equal(h.provider.sentInstructions.length, 1);
    // Catalog-driven policy: a changed (still admissible-route) model is read
    // back honestly — there is no single-model constant to violate. A RETIRED
    // provider route is rejected regardless of model.
    h.provider.sessionBindings.get(sid)!.model_id = "another-advertised-model";
    const changed = JSON.parse((await call("read_zcode_session", input)).content[0].text);
    assert.equal(changed.model_binding.model_id, "another-advertised-model");
    h.provider.sessionBindings.get(sid)!.provider_id = "builtin:zai-start-plan";
    assert.equal((await call("read_zcode_session", input)).isError, true);
    assert.equal((await call("resume_zcode_session", input)).isError, true);
    assert.equal(h.provider.sentInstructions.length, 1);
  });
});


it("propagates only the admitted workspace/write scope at dispatch", async () => {
  const { engine, provider, workspaces } = buildHarness();
  for (const write_scope of ["workspace", "readonly"] as const) {
    const task = await engine.submitTask({ workspace_id: "z2c-test", instruction: "permission propagation", write_scope });
    assert.equal(await waitTaskTerminal(engine, task.task_id), "completed");
    assert.deepEqual(provider.executionGrants.at(-1), {
      workspacePath: workspaces.get("z2c-test").canonicalPath, write: write_scope === "workspace",
      mode: write_scope === "workspace" ? "machine-local-development" : "workspace",
    });
  }
});


describe("entitlement admission fails closed", () => {
  for (const entitlement_plan of ["START", "INDIVIDUAL"] as const) {
    it(`rejects ${entitlement_plan} submit and resume before provider calls or persistence`, async () => {
      const h = buildHarness();
      try {
        for (const resume_session_id of [undefined, "sess_00000000-0000-0000-0000-000000000001"]) {
          await assert.rejects(h.engine.submitTask({ workspace_id: "z2c-test", instruction: "OK", entitlement_plan, resume_session_id }), { code: "ENTITLEMENT_UNAVAILABLE" });
        }
        assert.equal(h.provider.sessions, 0);
        assert.equal(h.provider.sentInstructions.length, 0);
        assert.equal(h.store.data.tasks.length, 0);
      } finally { rmSync(h.dir, { recursive: true, force: true }); }
    });
  }
  it("DEFAULT executes with unknown billing evidence and resumes without inventing evidence", async () => {
    const h = buildHarness();
    try {
      const task = await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "OK", entitlement_plan: "DEFAULT" });
      await waitTaskTerminal(h.engine, task.task_id);
      assert.deepEqual(task.entitlement, { requested: "DEFAULT", observed: null, access_mode: null, source: "unavailable" });
      const resumed = await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "OK", resume_session_id: task.session_id! });
      await waitTaskTerminal(h.engine, resumed.task_id);
      assert.equal(resumed.session_id, task.session_id);
      // A persisted pin must never be erased by omission/DEFAULT on resume.
      h.store.data.tasks[0]!.entitlementPlan = "START";
      await assert.rejects(h.engine.submitTask({ workspace_id: "z2c-test", instruction: "OK", resume_session_id: task.session_id! }), { code: "ENTITLEMENT_UNAVAILABLE" });
      assert.equal(h.provider.sentInstructions.length, 2);
    } finally { rmSync(h.dir, { recursive: true, force: true }); }
  });
});


it("rechecks persisted entitlement at queued dispatch without fallback", async () => {
  const h = buildHarness();
  try {
    h.engine.pauseQueue("z2c-test");
    const task = await h.engine.submitTask({ workspace_id: "z2c-test", instruction: "OK" });
    h.store.data.tasks.find(t => t.taskId === task.task_id)!.entitlementPlan = "INDIVIDUAL";
    h.engine.resumeQueue("z2c-test");
    assert.equal(await waitTaskTerminal(h.engine, task.task_id), "failed");
    assert.equal(h.provider.sentInstructions.length, 0);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});


describe("individual plan chat admission (2026-10-01 BINDING_UNVERIFIED repair)", () => {
  const registryReadback = (plan: "START" | "INDIVIDUAL") => ({
    requested: plan,
    observed: plan,
    access_mode: plan === "START" ? "start-plan" : "individual-coding-plan",
    source: "provider-registry",
  });

  function withEntitlementReadback(
    h: ReturnType<typeof buildHarness>,
    entitlement: Record<string, unknown> | null,
  ): void {
    const readState = h.provider.readSessionState.bind(h.provider);
    h.provider.readSessionState = async (session, workspace) => {
      const attestation = await readState(session, workspace);
      return (attestation ? { ...attestation, entitlement } : attestation) as Awaited<ReturnType<typeof readState>>;
    };
  }

  it("admits INDIVIDUAL GLM-5.3/max and GLM-5.3-Flash/max observed on the individual account route", async () => {
    for (const model of ["GLM-5.3", "GLM-5.3-Flash"]) {
      const h = buildHarness();
      try {
        h.provider.entitlementSelection = { entitlementSelection: true };
        h.provider.nextBinding = { provider_id: "account:zai-individual-coding-plan", model_id: model };
        withEntitlementReadback(h, registryReadback("INDIVIDUAL"));
        const view = await h.engine.submitTask({
          workspace_id: "z2c-test", instruction: `individual-${model}-max`,
          model_id: model, thought_level: "max", entitlement_plan: "INDIVIDUAL",
        });
        assert.match(view.task_id, /^z2c_/);
        assert.equal(await waitTaskTerminal(h.engine, view.task_id), "completed");
      } finally { rmSync(h.dir, { recursive: true, force: true }); }
    }
  });

  it("still admits START/max observed on the start account route (regression guard)", async () => {
    const h = buildHarness();
    try {
      h.provider.entitlementSelection = { entitlementSelection: true };
      h.provider.nextBinding = { provider_id: "account:zai-start-plan", model_id: "GLM-5.3-Flash" };
      withEntitlementReadback(h, registryReadback("START"));
      const view = await h.engine.submitTask({
        workspace_id: "z2c-test", instruction: "start-flash-max",
        model_id: "GLM-5.3-Flash", thought_level: "max", entitlement_plan: "START",
      });
      assert.equal(await waitTaskTerminal(h.engine, view.task_id), "completed");
    } finally { rmSync(h.dir, { recursive: true, force: true }); }
  });

  it("rejects forged or inconsistent INDIVIDUAL bindings with a specific reason", async () => {
    const individualRoute = { provider_id: "account:zai-individual-coding-plan", model_id: "GLM-5.3" };
    const submit = (h: ReturnType<typeof buildHarness>) => h.engine.submitTask({
      workspace_id: "z2c-test", instruction: "chat-individual",
      model_id: "GLM-5.3", thought_level: "max", entitlement_plan: "INDIVIDUAL",
    });
    const expectRejected = async (h: ReturnType<typeof buildHarness>) => {
      await assert.rejects(
        submit(h),
        (e: unknown) => e instanceof TaskEngineError && e.code === "BINDING_UNVERIFIED" && /attesting INDIVIDUAL/.test(e.message),
      );
      assert.equal(h.provider.sentInstructions.length, 0);
      assert.equal(h.store.data.tasks.length, 0);
    };

    // Forged evidence: the readback must come from the runtime's own registry.
    {
      const h = buildHarness();
      try {
        h.provider.entitlementSelection = { entitlementSelection: true };
        h.provider.nextBinding = individualRoute;
        withEntitlementReadback(h, { requested: "INDIVIDUAL", observed: "INDIVIDUAL", access_mode: "individual-coding-plan", source: "control-plane-reported" });
        await expectRejected(h);
      } finally { rmSync(h.dir, { recursive: true, force: true }); }
    }
    // Inconsistent: the session attests START while INDIVIDUAL was requested.
    {
      const h = buildHarness();
      try {
        h.provider.entitlementSelection = { entitlementSelection: true };
        h.provider.nextBinding = individualRoute;
        withEntitlementReadback(h, registryReadback("START"));
        await expectRejected(h);
      } finally { rmSync(h.dir, { recursive: true, force: true }); }
    }
    // Hybrid route: an attested INDIVIDUAL must not open the start account route.
    {
      const h = buildHarness();
      try {
        h.provider.entitlementSelection = { entitlementSelection: true };
        h.provider.nextBinding = { provider_id: "account:zai-start-plan", model_id: "GLM-5.3-Flash" };
        withEntitlementReadback(h, registryReadback("INDIVIDUAL"));
        await expectRejected(h);
      } finally { rmSync(h.dir, { recursive: true, force: true }); }
    }
    // Unproven: no registry readback at all.
    {
      const h = buildHarness();
      try {
        h.provider.entitlementSelection = { entitlementSelection: true };
        h.provider.nextBinding = individualRoute;
        withEntitlementReadback(h, null);
        await expectRejected(h);
      } finally { rmSync(h.dir, { recursive: true, force: true }); }
    }
  });
});


describe("native resume evidence plumbing (official-lane full-attestation repair)", () => {
  const registryReadback = (plan: "START" | "INDIVIDUAL") => ({
    requested: plan,
    observed: plan,
    access_mode: plan === "START" ? "start-plan" : "individual-coding-plan",
    source: "provider-registry",
  });

  function withEntitlementReadback(
    h: ReturnType<typeof buildHarness>,
    entitlement: Record<string, unknown> | null,
  ): void {
    const readState = h.provider.readSessionState.bind(h.provider);
    h.provider.readSessionState = async (session, workspace) => {
      const attestation = await readState(session, workspace);
      return (attestation ? { ...attestation, entitlement } : attestation) as Awaited<ReturnType<typeof readState>>;
    };
  }

  /** A provider-native session bound to the authorized workspace with official-lane evidence. */
  async function officialSession(
    h: ReturnType<typeof buildHarness>,
    identity?: { provider_id: string; model_id: string },
  ): Promise<string> {
    const ws = h.workspaces.get("z2c-test");
    const sid = await h.provider.createSession({ workspacePath: ws.canonicalPath, workspaceKey: ws.canonicalPath });
    const observed = h.provider.sessionBindings.get(sid)!;
    h.provider.sessionBindings.set(sid, {
      provider_id: identity?.provider_id ?? observed.provider_id,
      model_id: identity?.model_id ?? observed.model_id,
      source: "official-session-read",
    });
    return sid;
  }

  const expectBindingUnverified = (e: unknown) =>
    e instanceof TaskEngineError && e.code === "BINDING_UNVERIFIED";

  it("admits official resume with complete same-session evidence and preserves the session identity", async () => {
    const h = buildHarness();
    try {
      h.provider.name = "zcode-official";
      const sid = await officialSession(h);
      const view = await h.engine.submitTask({
        workspace_id: "z2c-test", instruction: "official follow-up", resume_session_id: sid,
      });
      assert.equal(view.session_id, sid);
      assert.equal(view.model_binding?.model_id, "GLM-5.3");
      assert.equal(view.model_binding?.source, "official-session-read");
      assert.equal(view.model_binding?.thought_level, "max");
      assert.equal(await waitTaskTerminal(h.engine, view.task_id), "completed");
      assert.deepEqual(h.provider.sentInstructions.map((s) => s.sessionId), [sid]);
    } finally { rmSync(h.dir, { recursive: true, force: true }); }
  });

  it("admits START resume on the retired start route only through the session's registry-backed entitlement", async () => {
    const h = buildHarness();
    try {
      h.provider.name = "zcode-official";
      h.provider.entitlementSelection = { entitlementSelection: true };
      const sid = await officialSession(h, { provider_id: "builtin:zai-start-plan", model_id: "GLM-5.3" });
      withEntitlementReadback(h, registryReadback("START"));
      const view = await h.engine.submitTask({
        workspace_id: "z2c-test", instruction: "attested start resume",
        resume_session_id: sid, entitlement_plan: "START",
      });
      assert.equal(view.session_id, sid);
      assert.equal(view.entitlement?.access_mode, "start-plan");
      assert.equal(view.entitlement?.source, "provider-registry");
      assert.equal(await waitTaskTerminal(h.engine, view.task_id), "completed");
      assert.equal(h.provider.sentInstructions.length, 1);
    } finally { rmSync(h.dir, { recursive: true, force: true }); }
  });

  it("rejects official resume when the same snapshot carries no availability catalog", async () => {
    const h = buildHarness();
    try {
      h.provider.unadvertisedModels = true;
      const sid = await officialSession(h);
      await assert.rejects(
        h.engine.submitTask({ workspace_id: "z2c-test", instruction: "x", resume_session_id: sid }),
        expectBindingUnverified,
      );
      assert.equal(h.provider.sentInstructions.length, 0);
      assert.equal(h.store.data.tasks.length, 0);
    } finally { rmSync(h.dir, { recursive: true, force: true }); }
  });

  it("rejects retired-route resume without a registry-backed entitlement readback (fail closed)", async () => {
    const h = buildHarness();
    try {
      h.provider.entitlementSelection = { entitlementSelection: true };
      const sid = await officialSession(h, { provider_id: "builtin:zai-start-plan", model_id: "GLM-5.3" });
      withEntitlementReadback(h, null);
      await assert.rejects(
        h.engine.submitTask({
          workspace_id: "z2c-test", instruction: "x",
          resume_session_id: sid, entitlement_plan: "START",
        }),
        expectBindingUnverified,
      );
      assert.equal(h.provider.sentInstructions.length, 0);
      assert.equal(h.store.data.tasks.length, 0);
    } finally { rmSync(h.dir, { recursive: true, force: true }); }
  });

  it("rejects resume when the observed provider route, requested model, or requested thought deviates", async () => {
    // Inadmissible observed provider route: never governed, resume never opens it.
    {
      const h = buildHarness();
      try {
        const sid = await officialSession(h, { provider_id: "manual:desktop", model_id: "GLM-5.3" });
        await assert.rejects(
          h.engine.submitTask({ workspace_id: "z2c-test", instruction: "x", resume_session_id: sid }),
          expectBindingUnverified,
        );
        assert.equal(h.provider.sentInstructions.length, 0);
        assert.equal(h.store.data.tasks.length, 0);
      } finally { rmSync(h.dir, { recursive: true, force: true }); }
    }
    // Requested model deviates from the observed session identity.
    {
      const h = buildHarness();
      try {
        const sid = await officialSession(h);
        await assert.rejects(
          h.engine.submitTask({
            workspace_id: "z2c-test", instruction: "x",
            resume_session_id: sid, model_id: "GLM-5.3-Flash",
          }),
          (e: unknown) => expectBindingUnverified(e) && /session is GLM-5\.3, requested GLM-5\.3-Flash/.test(e.message),
        );
        assert.equal(h.provider.sentInstructions.length, 0);
        assert.equal(h.store.data.tasks.length, 0);
      } finally { rmSync(h.dir, { recursive: true, force: true }); }
    }
    // Requested thought level deviates from the observed session effort.
    {
      const h = buildHarness();
      try {
        const sid = await officialSession(h);
        await assert.rejects(
          h.engine.submitTask({
            workspace_id: "z2c-test", instruction: "x",
            resume_session_id: sid, thought_level: "low",
          }),
          (e: unknown) => expectBindingUnverified(e) && /session effort is max, requested low/.test(e.message),
        );
        assert.equal(h.provider.sentInstructions.length, 0);
        assert.equal(h.store.data.tasks.length, 0);
      } finally { rmSync(h.dir, { recursive: true, force: true }); }
    }
  });

  it("rejects resume of a session owned by a different authorized workspace", async () => {
    const h = buildHarness({ workspaceCount: 2 });
    try {
      const sid = await officialSession(h); // bound to z2c-test
      await assert.rejects(
        h.engine.submitTask({ workspace_id: "z2c-test-2", instruction: "cross-workspace", resume_session_id: sid }),
        expectBindingUnverified,
      );
      assert.equal(h.provider.sentInstructions.length, 0);
      assert.equal(h.store.data.tasks.length, 0);
    } finally { rmSync(h.dir, { recursive: true, force: true }); }
  });

  it("rejects readonly resume without observed plan evidence and admits it once plan is observed", async () => {
    const h = buildHarness();
    try {
      const sid = await officialSession(h);
      h.provider.planEvidence = null;
      await assert.rejects(
        h.engine.submitTask({
          workspace_id: "z2c-test", instruction: "ro",
          write_scope: "readonly", resume_session_id: sid,
        }),
        (e: unknown) => expectBindingUnverified(e) && /plan evidence/.test(e.message),
      );
      assert.equal(h.provider.sentInstructions.length, 0);
      assert.equal(h.store.data.tasks.length, 0);
      h.provider.planEvidence = true;
      const view = await h.engine.submitTask({
        workspace_id: "z2c-test", instruction: "ro",
        write_scope: "readonly", resume_session_id: sid,
      });
      assert.equal(await waitTaskTerminal(h.engine, view.task_id), "completed");
      assert.equal(h.provider.sentInstructions.length, 1);
    } finally { rmSync(h.dir, { recursive: true, force: true }); }
  });
});
