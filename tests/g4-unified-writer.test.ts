import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { CodexTaskManager } from "../src/execution/tasks.js";
import { Workspace } from "../src/workspace/manager.js";
import { readWorkspaceSlot } from "../src/execution/slot.js";
import { writeWorkspaceQueuePauseState } from "../src/execution/queue-state.js";
import { type ZcodeNativeTaskView } from "../src/execution/zcode-native.js";
import { registerZcodeNativeTools } from "../src/mcp/zcode-native-tools.js";
import type { AppServerClient, AppServerNotification } from "../src/execution/app-server.js";
import type { ExecutionBackend, BackendExecutionResult } from "../src/execution/backend.js";

// No models, credentials, sockets, or fixture Git mutations in this suite.
vi.mock("node:child_process", () => ({
  spawn: () => { throw new Error("Child process forbidden in unified writer tests"); },
  spawnSync: () => { throw new Error("Child process forbidden in unified writer tests"); },
  execSync: () => Buffer.from(""),
}));
vi.mock("../src/workspace/git.js", () => ({ gitStatus: () => [], gitInfo: () => ({ isRepo: false }), gitDiff: () => "" }));
vi.mock("../src/execution/runtime.js", () => ({ prepareCodexRuntime: (root: string) => ({ root, serenaHome: root, env: {} }) }));

class FakeCodex implements AppServerClient {
  notifyHandler?: (notification: AppServerNotification) => void | Promise<void>;
  starts = 0;
  async initialize() {}
  async request<T>(method: string): Promise<T> {
    if (method === "thread/start") return { thread: { id: "thread-fixture" } } as T;
    if (method === "turn/start") { this.starts++; return { turn: { id: "turn-fixture" } } as T; }
    if (method === "turn/interrupt") this.finish("interrupted");
    return {} as T;
  }
  finish(status = "completed") { void this.notifyHandler?.({ method: "turn/completed", params: { threadId: "thread-fixture", turnId: "turn-fixture", status } }); }
  notify() {}
  setNotificationHandler(handler: (notification: AppServerNotification) => void | Promise<void>) { this.notifyHandler = handler; }
  setRequestHandler() {}
  respond() {}
  respondError() {}
  async close() {}
}

class FakeGemini implements ExecutionBackend {
  readonly provider = "gemini" as const;
  starts = 0;
  done?: (result: BackendExecutionResult) => void;
  async initialize() {}
  execute() { this.starts++; return new Promise<BackendExecutionResult>(resolve => { this.done = resolve; }); }
  finish(status: "completed" | "cancelled" = "completed") {
    this.done?.({ status, provider: "gemini", providerRuntime: "fixture", providerModel: "gemini-3.8-flash-high", output: "fixture", changedFiles: [], exitCode: 0, quiescent: true });
  }
  async cancel() { this.finish("cancelled"); }
  async close() { this.finish("cancelled"); }
}

class FakeNative {
  tasks = new Map<string, ZcodeNativeTaskView>();
  submitCalls = 0;
  resumeCalls = 0;
  cancelCalls = 0;
  getCalls = 0;
  beforeHook?: () => void;
  afterHook?: () => void;
  cancelStatus = "cancelled";
  onDispatch?: () => void;
  async submitTask(input: { workspace_id: string }, hook?: () => void) {
    this.beforeHook?.(); hook?.(); this.afterHook?.(); this.onDispatch?.(); this.submitCalls++;
    return this.create(input.workspace_id);
  }
  create(workspaceId: string, sessionId = "sess_" + randomUUID()) {
    const view = { workspace_id: workspaceId, task_id: "z2c_" + randomUUID(), session_id: sessionId, status: "running" };
    this.tasks.set(view.task_id, view); return { ...view };
  }
  async resumeSession(input: { workspace_id: string; session_id: string }, hook?: () => void) {
    this.beforeHook?.(); hook?.(); this.afterHook?.(); this.onDispatch?.(); this.resumeCalls++;
    return this.create(input.workspace_id, input.session_id);
  }
  async getTask(input: { task_id: string }) {
    this.getCalls++;
    const view = this.tasks.get(input.task_id); if (!view) throw new Error("missing"); return { ...view };
  }
  async cancelTask(input: { task_id: string }) {
    this.cancelCalls++; const view = this.tasks.get(input.task_id)!; view.status = this.cancelStatus; return { ...view };
  }
  async executionOutput(input: { workspace_id: string; task_id: string; output_id: string }, observeTask?: (task: ZcodeNativeTaskView) => void) {
    observeTask?.({ ...this.tasks.get(input.task_id)! });
    return { ...input, session_id: this.tasks.get(input.task_id)!.session_id, text: "fixture" };
  }
}

describe("G4 unified native/direct provider lifecycle (offline)", () => {
  let root: string, state: string, workspace: Workspace, manager: CodexTaskManager;
  let codex: FakeCodex, gemini: FakeGemini, native: FakeNative;
  const managers: CodexTaskManager[] = [];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-g4-unified-"));
    state = path.join(root, "state");
    const work = path.join(root, "workspace"); fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, "fixture.txt"), "preserve\n");
    workspace = new Workspace(work); codex = new FakeCodex(); gemini = new FakeGemini(); native = new FakeNative();
    manager = boot();
    vi.stubGlobal("fetch", () => { throw new Error("Network forbidden in unified writer tests"); });
  });
  afterEach(async () => {
    codex.finish(); gemini.finish();
    for (const entry of managers.splice(0)) await entry.close();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("c2c-g4-unified-")) throw new Error("Unsafe fixture cleanup");
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  function boot() {
    const result = new CodexTaskManager(workspace, { stateDir: state, fullAccess: true, orchestrator: "legacy",
      appServerFactory: () => codex, antigravityBackend: gemini, nativeClient: native });
    managers.push(result); return result;
  }
  const input = () => ({ workspace_id: workspace.id, instruction: "fixture", write_scope: "workspace" as const });
  const direct = (provider: "codex" | "gemini") => manager.submit({ workspace_id: workspace.id, provider,
    instruction: "fixture", write_scope: [workspace.root], run_tests: false, network: false }, { ownerId: "alice" });

  it.each([
    ["codex", "gemini"], ["codex", "z2c"], ["gemini", "codex"],
    ["gemini", "z2c"], ["z2c", "codex"], ["z2c", "gemini"],
  ] as const)("%s holds the workspace slot against %s", async (first, second) => {
    if (first === "z2c") await manager.submitNative(input());
    else {
      direct(first);
      await vi.waitFor(() => expect(first === "codex" ? codex.starts : gemini.starts).toBe(1));
    }
    const held = readWorkspaceSlot(workspace.id, state);
    expect(held).toMatchObject({ provider: first });
    if (second === "z2c") await expect(manager.submitNative(input())).rejects.toThrow(/busy|slot/);
    else if (first === "z2c") expect(() => direct(second)).toThrow(/writer slot/);
    else {
      const queued = direct(second);
      await Promise.resolve(); expect(manager.get(queued.taskId).status).toBe("queued");
      await manager.cancel(queued.taskId, { ownerId: "alice" });
    }
    expect(readWorkspaceSlot(workspace.id, state)).toEqual(held);
    expect(codex.starts + gemini.starts + native.submitCalls).toBe(1);
    expect(manager.getQueueState().activeWriter).toMatchObject({ provider: first, taskId: held!.taskId });
  });

  it.each(["codex", "gemini", "z2c"] as const)("readonly native runs alongside %s", async provider => {
    if (provider === "z2c") await manager.submitNative(input());
    else { direct(provider); await vi.waitFor(() => expect(codex.starts + gemini.starts).toBe(1)); }
    const held = readWorkspaceSlot(workspace.id, state);
    const readonly = await manager.submitNative({ ...input(), write_scope: "readonly" });
    expect(readWorkspaceSlot(workspace.id, state)).toEqual(held);
    await manager.cancelNative({ workspace_id: workspace.id, task_id: readonly.task_id });
    expect(readWorkspaceSlot(workspace.id, state)).toEqual(held);
  });

  it("binds the reservation visible at dispatch to the returned upstream task/session", async () => {
    native.onDispatch = () => {
      expect(readWorkspaceSlot(workspace.id, state)).toMatchObject({ version: 1, provider: "z2c" });
      expect(readWorkspaceSlot(workspace.id, state)!.taskId).toMatch(/^[0-9a-f-]{36}$/);
    };
    const task = await manager.submitNative(input());
    expect(readWorkspaceSlot(workspace.id, state)).toMatchObject({ taskId: task.task_id, sessionId: task.session_id });
    expect(manager.getQueueState().activeWriter).toMatchObject({ provider: "z2c", taskId: task.task_id, sessionId: task.session_id, status: "running" });
    expect(manager.list()).toEqual([]);
  });

  it("pause blocks new dispatches for all providers and keeps cancellation available", async () => {
    const task = await manager.submitNative(input());
    const held = readWorkspaceSlot(workspace.id, state);
    manager.setQueuePaused(true);
    await expect(manager.submitNative(input())).rejects.toThrow(/paused/);
    await expect(manager.submitNative({ ...input(), write_scope: "readonly" })).rejects.toThrow(/paused/);
    await expect(manager.resumeNative({ ...input(), session_id: task.session_id! })).rejects.toThrow(/paused/);
    const query = { workspace_id: workspace.id, task_id: task.task_id };
    expect((await manager.getNative(query)).status).toBe("running");
    native.cancelStatus = "cancelling";
    await manager.cancelNative(query);
    expect(readWorkspaceSlot(workspace.id, state)).toEqual(held);
    native.cancelStatus = "cancelled";
    await manager.cancelNative(query);
    expect(readWorkspaceSlot(workspace.id, state)).toBeNull();
    const codexTask = direct("codex"), geminiTask = direct("gemini");
    await Promise.resolve();
    expect(codex.starts + gemini.starts).toBe(0);
    expect(manager.get(codexTask.taskId).status).toBe("queued");
    expect(manager.get(geminiTask.taskId).status).toBe("queued");
    expect(manager.getQueueState().paused).toBe(true);
  });

  it("pause during attestation releases the reservation before dispatch", async () => {
    native.beforeHook = () => manager.setQueuePaused(true);
    await expect(manager.submitNative(input())).rejects.toThrow(/paused/);
    expect(native.submitCalls).toBe(0);
    expect(readWorkspaceSlot(workspace.id, state)).toBeNull();
  });

  it("attestation failure releases the reservation; uncertain dispatch retains it", async () => {
    native.beforeHook = () => { throw new Error("attestation failed"); };
    await expect(manager.submitNative(input())).rejects.toThrow(/attestation/);
    expect(readWorkspaceSlot(workspace.id, state)).toBeNull();
    native.beforeHook = undefined;
    native.afterHook = () => { throw new Error("dispatch unavailable"); };
    await expect(manager.submitNative(input())).rejects.toThrow(/dispatch unavailable/);
    const held = readWorkspaceSlot(workspace.id, state);
    await manager.close(); manager = boot();
    expect(await manager.reconcileNativeSlot()).toEqual({ status: "unresolved", released: false });
    expect(readWorkspaceSlot(workspace.id, state)).toEqual(held);
  });

  it.each(["completed", "failed", "cancelled", "interrupted"])("%s status releases the native slot", async status => {
    const task = await manager.submitNative(input());
    native.tasks.get(task.task_id)!.status = status;
    await manager.getNative({ workspace_id: workspace.id, task_id: task.task_id });
    expect(readWorkspaceSlot(workspace.id, state)).toBeNull();
    const next = await manager.submitNative(input());
    expect(readWorkspaceSlot(workspace.id, state)!.taskId).toBe(next.task_id);
  });

  it.each(["running", "completed", "unavailable"])("restart reconciles the exact bound task when status is %s", async status => {
    const task = await manager.submitNative(input());
    const held = readWorkspaceSlot(workspace.id, state);
    manager.setQueuePaused(true); await manager.close();
    const lookup = vi.spyOn(native, "getTask");
    if (status === "unavailable") lookup.mockRejectedValue(new Error("offline"));
    else native.tasks.get(task.task_id)!.status = status;
    manager = boot();
    await vi.waitFor(() => {
      expect(lookup).toHaveBeenCalledWith({ workspace_id: workspace.id, task_id: task.task_id });
      if (status === "completed") expect(readWorkspaceSlot(workspace.id, state)).toBeNull();
      else expect(manager.getQueueState().activeWriter).toMatchObject({ taskId: task.task_id, status: status === "unavailable" ? "unresolved" : status });
    });
    if (status !== "completed") expect(readWorkspaceSlot(workspace.id, state)).toEqual(held);
    expect(manager.getQueueState().paused).toBe(true);
  });

  it("output status releases a completed native writer", async () => {
    const task = await manager.submitNative(input());
    native.tasks.get(task.task_id)!.status = "completed";
    await manager.outputNative({ workspace_id: workspace.id, task_id: task.task_id, output_id: "out_fixture" });
    expect(readWorkspaceSlot(workspace.id, state)).toBeNull();
  });

  it("polls terminal status while paused and releases the slot", async () => {
    const task = await manager.submitNative(input());
    manager.setQueuePaused(true);
    native.tasks.get(task.task_id)!.status = "completed";
    await vi.waitFor(() => expect(readWorkspaceSlot(workspace.id, state)).toBeNull(), { timeout: 3000 });
    expect(manager.getQueueState().paused).toBe(true);
  });

  it("resumes an authorized upstream session and keeps the new task's slot on old terminal reads", async () => {
    const original = native.create(workspace.id);
    native.tasks.get(original.task_id)!.status = "completed";
    const resumed = await manager.resumeNative({ ...input(), session_id: original.session_id! });
    const held = readWorkspaceSlot(workspace.id, state);
    expect(held).toMatchObject({ taskId: resumed.task_id, sessionId: original.session_id });
    await manager.getNative({ workspace_id: workspace.id, task_id: original.task_id });
    expect(readWorkspaceSlot(workspace.id, state)).toEqual(held);
  });

  it.each(["task_id", "session_id", "workspace_id"])("mismatched %s status retains the slot", async field => {
    const task = await manager.submitNative(input());
    const held = readWorkspaceSlot(workspace.id, state);
    Object.assign(native.tasks.get(task.task_id)!, { status: "completed", [field]: "other" });
    expect(await manager.reconcileNativeSlot()).toEqual({ status: "unresolved", released: false });
    expect(readWorkspaceSlot(workspace.id, state)).toEqual(held);
  });

  it("queued Codex/Gemini work honors persisted pause after native release", async () => {
    manager.setQueuePaused(true);
    const first = direct("codex"), second = direct("gemini");
    manager.setQueuePaused(false);
    const task = await manager.submitNative(input());
    await Promise.resolve(); expect(codex.starts + gemini.starts).toBe(0);
    writeWorkspaceQueuePauseState(workspace.id, true, state);
    native.tasks.get(task.task_id)!.status = "completed";
    await manager.reconcileNativeSlot(); await Promise.resolve();
    expect(codex.starts + gemini.starts).toBe(0);
    manager.setQueuePaused(false);
    await vi.waitFor(() => expect(codex.starts).toBe(1));
    expect(gemini.starts).toBe(0);
    codex.finish(); await vi.waitFor(() => expect(gemini.starts).toBe(1)); gemini.finish();
    await vi.waitFor(() => expect(manager.get(second.taskId).status).toBe("completed"));
    expect(manager.get(first.taskId).status).toBe("completed");
  });

  it("authorized principals share native task access, including cancel while paused", async () => {
    const handlers = new Map<string, Function>();
    const writerManagerFor = vi.fn(() => manager);
    registerZcodeNativeTools({ registerTool: (name: string, _schema: unknown, handler: Function) => handlers.set(name, handler) } as any, {
      requireScope: () => null,
      resolveWorkspace: id => { if (id !== workspace.id) throw new Error("workspace denied"); },
      taskGate: () => {}, writerManagerFor,
      ok: data => ({ content: [{ type: "text", text: JSON.stringify(data) }] }),
      fail: (_code, message) => ({ isError: true, content: [{ type: "text", text: message }] }),
      mapError: () => ({ isError: true, content: [] }), untrustedNote: "",
    });
    const invoke = async (name: string, args: unknown, clientId: string) =>
      handlers.get("zcode_native_" + name)!(args, { authInfo: { clientId } });
    const result = await invoke("submit_task", input(), "alice");
    const task = JSON.parse(result.content[0].text);
    const query = { workspace_id: workspace.id, task_id: task.task_id };
    manager.setQueuePaused(true);
    for (const name of ["get_task", "execution_output", "cancel_task"]) {
      expect((await invoke(name, { ...query, output_id: "out_fixture" }, "bob")).isError).not.toBe(true);
    }
    expect(readWorkspaceSlot(workspace.id, state)).toBeNull();
    expect(native.cancelCalls).toBe(1);
    expect(manager.getQueueState().paused).toBe(true);
    manager.setQueuePaused(false);
    expect((await invoke("resume_session", { ...input(), session_id: task.session_id }, "bob")).isError).not.toBe(true);
    expect(native.resumeCalls).toBe(1);
    writerManagerFor.mockClear();
    for (const name of ["submit_task", "get_task", "cancel_task", "resume_session", "execution_output"]) {
      expect((await invoke(name, { ...input(), workspace_id: "denied" }, "bob")).isError).toBe(true);
    }
    expect(writerManagerFor).not.toHaveBeenCalled();
  });
});
