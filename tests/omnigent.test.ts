import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OmnigentBackend } from "../src/execution/omnigent.js";
import { OmnigentClient, loopbackUrl } from "../src/execution/omnigent-client.js";
import { executionOrchestrator } from "../src/execution/orchestrator.js";
import { CodexTaskManager, type TaskManagerOptions } from "../src/execution/tasks.js";
import type { AppServerClient, AppServerNotification } from "../src/execution/app-server.js";
import type { BackendExecutionRequest } from "../src/execution/backend.js";
import { C2CSessionRegistry } from "../src/session/registry.js";
import { Workspace } from "../src/workspace/manager.js";
import { readExecutionRecords } from "../src/execution/records.js";
import { readExecutionOutput } from "../src/execution/output.js";
import { readWorkspaceSlot } from "../src/execution/slot.js";
import { createMcpServer } from "../src/mcp/server.js";
import { nullLogger } from "../src/logger/index.js";
import { makeTmpDir, cleanup, write, makeGitRepo } from "./helpers.js";

const HOST = "host_0123456789abcdef";
const SESSION = "a".repeat(32);
const TURN = `codex_${"b".repeat(32)}`;
const ITEM = `msg_${"c".repeat(32)}`;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

/** Entire Omnigent transport is fake: no server, Codex process or network needed. */
class FakeOmnigent {
  calls: { route: string; init: RequestInit }[] = [];
  metadata: any;
  spec: any;
  instruction = "";
  text = "Changed src/index.ts.";
  online = true;
  hold = false;
  refuseStop = false;
  terminal: "completed" | "failed" | "cancelled" = "completed";
  native = true;
  snapshotOverride: Record<string, unknown> = {};
  createOverride: unknown;
  ackOverride: unknown;
  itemsOverride: unknown;
  streamOverride: string | undefined;
  beforeSubmit?: () => void;
  submitGate?: Promise<void>;
  private stream?: ReadableStreamDefaultController<Uint8Array>;

  snapshot() {
    return {
      id: SESSION, harness: "codex-native", status: "idle", runner_online: this.online,
      host_id: HOST, workspace: this.metadata.workspace, terminal_launch_args: this.metadata.terminal_launch_args,
      labels: this.metadata.labels, llm_model: "gpt-5.4", last_task_error: null, git_branch: null,
      ...this.snapshotOverride,
    };
  }

  emit(event: object) {
    try { this.stream!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); } catch { /* disconnected SSE client */ }
  }

  fetch: typeof fetch = async (url, init = {}) => {
    const route = new URL(String(url)).pathname + new URL(String(url)).search;
    this.calls.push({ route, init });
    if (route === "/v1/sessions") {
      this.online = true;
      const form = init.body as FormData;
      this.metadata = JSON.parse(form.get("metadata") as string);
      const archive = gunzipSync(Buffer.from(await (form.get("bundle") as Blob).arrayBuffer()));
      const length = parseInt(archive.subarray(124, 136).toString().replace(/\0/g, ""), 8);
      this.spec = JSON.parse(archive.subarray(512, 512 + length).toString());
      return json(this.createOverride ?? { session_id: SESSION, agent_id: `ag_${"d".repeat(32)}`, agent_name: "c2c-codex" });
    }
    if (route.includes("?include_items=false")) return json(this.snapshot());
    if (route.endsWith("/stream")) {
      return new Response(new ReadableStream({
        start: (controller) => {
          this.stream = controller;
          init.signal?.addEventListener("abort", () => { try { controller.error(new Error("aborted")); } catch {} }, { once: true });
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    }
    if (route.endsWith("/events")) {
      const event = JSON.parse(init.body as string);
      if (event.type === "message") {
        this.instruction = event.data.content[0].text;
        this.beforeSubmit?.();
        if (this.submitGate) await this.submitGate;
        if (this.streamOverride !== undefined) {
          this.stream!.enqueue(new TextEncoder().encode(this.streamOverride));
          this.stream!.close();
        } else if (this.native) {
          this.emit({ type: "session.status", conversation_id: SESSION, status: "running", response_id: TURN });
          if (!this.hold) this.emit({ type: this.terminal === "cancelled" ? "session.interrupted" : "session.status",
            conversation_id: SESSION, status: this.terminal === "completed" ? "idle" : "failed", response_id: TURN, background_task_count: 0 });
        } else {
          this.emit({ type: "response.created", response: { id: TURN, status: "in_progress" } });
          if (!this.hold) this.emit({ type: `response.${this.terminal}`, response: { id: TURN, status: this.terminal } });
        }
        return json(this.ackOverride ?? { queued: true, item_id: ITEM });
      }
      if (event.type === "stop_session" && !this.refuseStop) this.online = false;
      return json({ queued: false });
    }
    if (route.includes("/items?")) return json(this.itemsOverride ?? {
      data: [
        { id: ITEM, type: "message", status: "completed", response_id: TURN, role: "user", content: [{ type: "input_text", text: "PRIVATE INPUT" }] },
        { id: `msg_${"d".repeat(32)}`, type: "reasoning", status: "completed", response_id: TURN, content: "PRIVATE REASONING" },
        { id: `msg_${"e".repeat(32)}`, type: "message", status: "completed", response_id: `codex_${"f".repeat(32)}`, role: "assistant", content: [{ type: "output_text", text: "ANOTHER TURN" }] },
        { id: `msg_${"f".repeat(32)}`, type: "message", status: "completed", response_id: TURN, role: "assistant", content: [{ type: "output_text", text: this.text }] },
      ], has_more: false,
    });
    throw new Error(`Unexpected fake route: ${route}`);
  };
}

class FakeLegacy implements AppServerClient {
  requests: string[] = [];
  closed = false;
  handler?: (event: AppServerNotification) => void | Promise<void>;
  async initialize() {}
  async request<T>(method: string): Promise<T> {
    this.requests.push(method);
    if (method === "thread/start") return { thread: { id: "legacy-thread" } } as T;
    if (method === "turn/start") {
      queueMicrotask(() => this.handler?.({ method: "turn/completed", params: { threadId: "legacy-thread", turnId: "legacy-turn", status: "completed" } }));
      return { turn: { id: "legacy-turn" } } as T;
    }
    if (method === "command/exec") return { exitCode: 0, stdout: "7 passed\n", stderr: "" } as T;
    return {} as T;
  }
  setNotificationHandler(handler: (event: AppServerNotification) => void | Promise<void>) { this.handler = handler; }
  setRequestHandler() {}
  notify() {}
  respond() {}
  respondError() {}
  async close() { this.closed = true; }
}

async function until<T>(read: () => T, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Fake task did not reach the expected state");
}

describe("Omnigent G1", () => {
  let root: string;
  let state: string;
  let workspace: Workspace;
  let sessions: C2CSessionRegistry;
  let fake: FakeOmnigent;
  let managers: CodexTaskManager[];
  let legacy: FakeLegacy;
  let legacyFactory: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv("C2C_ORCHESTRATOR", "legacy");
    root = makeTmpDir("omnigent-ws");
    state = makeTmpDir("omnigent-state");
    write(root, "src/index.ts", "export const value = 1;\n");
    write(root, "tests/fixture.txt", "test\n");
    workspace = new Workspace(root);
    sessions = new C2CSessionRegistry({ stateDir: state });
    fake = new FakeOmnigent();
    managers = [];
    legacy = new FakeLegacy();
    legacyFactory = vi.fn(() => legacy);
  });

  afterEach(async () => {
    fake.refuseStop = false;
    fake.snapshotOverride = {};
    for (const manager of managers) await manager.close();
    vi.unstubAllEnvs();
    cleanup(root);
    cleanup(state);
  });

  function backend() {
    return new OmnigentBackend({ stateDir: state, hostId: HOST, fetch: fake.fetch, pollIntervalMs: 5, cancelTimeoutMs: 30, requestTimeoutMs: 100 });
  }

  function manager(options: TaskManagerOptions = {}) {
    const value = new CodexTaskManager(workspace, {
      stateDir: state, sessionRegistry: sessions, appServerFactory: legacyFactory, taskTimeoutMs: 1_000,
      omnigentBackend: backend(), orchestrator: "omnigent", ...options,
    });
    managers.push(value);
    return value;
  }

  function input(overrides: Record<string, unknown> = {}) {
    return { workspace_id: workspace.id, instruction: "Update the source comment.", write_scope: ["src"], run_tests: false, ...overrides };
  }

  function request(overrides: Partial<BackendExecutionRequest> = {}): BackendExecutionRequest {
    return {
      taskId: "c2c_0123456789ab", workspaceId: workspace.id, workspaceRoot: workspace.root,
      instruction: "Update the source comment.", writeScope: ["src"], writableRoots: [path.join(workspace.root, "src")],
      networkRequested: false, networkEffective: false, fullAccess: false, runTests: false, timeoutMs: 1_000, ...overrides,
    };
  }

  const terminal = (value: { status: string }) => ["completed", "failed", "cancelled", "interrupted"].includes(value.status);

  it("defaults to the unchanged legacy Codex path, with no Omnigent dispatch", async () => {
    delete process.env.C2C_ORCHESTRATOR;
    expect(executionOrchestrator()).toBe("legacy");
    const taskManager = manager({ orchestrator: undefined });
    const submitted = taskManager.submit(input());
    const result = await until(() => taskManager.get(submitted.taskId), terminal);
    expect(result).toMatchObject({ status: "completed", provider: "codex", orchestrator: "legacy", threadId: "legacy-thread" });
    expect(legacy.requests).toEqual(["thread/start", "turn/start"]);
    expect(fake.calls).toEqual([]);
  });

  it("selects Omnigent explicitly through the environment and persists Codex identities", async () => {
    vi.stubEnv("C2C_ORCHESTRATOR", "omnigent");
    const taskManager = manager({ orchestrator: undefined });
    const submitted = taskManager.submit(input(), { ownerId: "alice" });
    const result = await until(() => taskManager.get(submitted.taskId), terminal);
    expect(result).toMatchObject({ status: "completed", provider: "codex", orchestrator: "omnigent", providerSessionId: SESSION, turnId: TURN, networkReported: false });
    expect(sessions.snapshot(submitted.sessionId!, "alice", workspace.id)).toMatchObject({ provider: "codex", providerSessionId: SESSION, lastTaskId: submitted.taskId });
    const binding = JSON.parse(fs.readFileSync(path.join(state, "omnigent", workspace.id, `${submitted.taskId}.json`), "utf8"));
    expect(binding).toMatchObject({ taskId: submitted.taskId, c2cSessionId: submitted.sessionId, providerSessionId: SESSION, providerTurnId: TURN, stopped: true });
    expect(readExecutionRecords(workspace.id, 10, state)[0]).toMatchObject({ provider: "codex", orchestrator: "omnigent", providerRuntime: "omnigent:codex-native" });
    expect(legacyFactory).not.toHaveBeenCalled();
    expect(fake.calls.every((call) => call.init.redirect === "error" && call.init.credentials === "omit")).toBe(true);
    expect(fake.calls.findIndex((call) => call.route.endsWith("/stream"))).toBeLessThan(fake.calls.findIndex((call) => call.route.endsWith("/events")));
    expect(binding).not.toHaveProperty("instruction");
  });

  it("pins native Codex, scopes cwd and additional roots, and disables escalation", async () => {
    const result = await backend().execute(request({ writeScope: ["src", "tests"], writableRoots: [path.join(root, "src"), path.join(root, "tests")] }));
    expect(result.status).toBe("completed");
    expect(fake.spec).toMatchObject({ executor: { harness: "codex-native" }, spawn: false });
    expect(fake.spec).not.toHaveProperty("os_env");
    expect(fake.spec).not.toHaveProperty("terminals");
    expect(fake.metadata).not.toHaveProperty("git");
    expect(fake.metadata.workspace).toBe(path.join(workspace.root, "src"));
    expect(fake.metadata.terminal_launch_args).toEqual(expect.arrayContaining([
      "--ask-for-approval", "never", "--sandbox", "workspace-write", "sandbox_workspace_write.network_access=false",
      "sandbox_workspace_write.exclude_tmpdir_env_var=true", "sandbox_workspace_write.exclude_slash_tmp=true",
      "--add-dir", path.join(root, "tests"), "features.multi_agent=false",
    ]));
  });

  it.each(["gemini", "glm"])("does not route provider %s through Omnigent or another backend", (provider) => {
    expect(() => manager().submit(input({ provider }))).toThrow();
    expect(fake.calls).toHaveLength(0);
    expect(legacyFactory).not.toHaveBeenCalled();
  });

  it.each(["auto", "", "omni", "api_key=not-a-setting"])("fails closed on invalid orchestrator config %s", (flag) => {
    expect(() => executionOrchestrator(flag)).toThrow("C2C_ORCHESTRATOR must be legacy or omnigent");
  });

  it.each(["https://example.org", "http://localhost:6767", "http://127.0.0.1/admin", "http://user:secret@127.0.0.1", "http://127.0.0.1?token=secret"])("rejects non-loopback or credential-bearing configuration %s", (url) => {
    expect(() => loopbackUrl(url)).toThrow();
  });

  it("reports unavailable Omnigent with no fallback or raw fetch error leakage", async () => {
    const taskManager = manager({ omnigentBackend: new OmnigentBackend({ stateDir: state, hostId: HOST, fetch: async () => { throw new Error("password=private-response"); } }) });
    const submitted = taskManager.submit(input());
    const result = await until(() => taskManager.get(submitted.taskId), terminal);
    expect(result).toMatchObject({ status: "failed", error: { code: "OMNIGENT_UNAVAILABLE" } });
    expect(JSON.stringify(result)).not.toContain("private-response");
    expect(legacyFactory).not.toHaveBeenCalled();
  });

  it("reports a missing Codex runner without submitting instructions or falling back", async () => {
    fake.snapshotOverride = { status: "failed", last_task_error: { message: "token=private-response" } };
    const taskManager = manager();
    const submitted = taskManager.submit(input());
    const result = await until(() => taskManager.get(submitted.taskId), terminal);
    expect(result.error?.code).toBe("OMNIGENT_CODEX_UNAVAILABLE");
    expect(fake.instruction).toBe("");
    expect(legacyFactory).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private-response");
  });

  it.each([null, [], {}, { session_id: "../../secret" }, { session_id: "c2c_at_abcdefghijklmno" }])("fails closed on malformed session creation %#", async (value) => {
    const bad = new OmnigentBackend({ stateDir: state, hostId: HOST, fetch: async () => json(value) });
    const result = await bad.execute(request());
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("OMNIGENT_PROTOCOL_ERROR");
  });

  it.each([
    { workspace: "F:\\unrelated-workspace" }, { terminal_launch_args: ["--yolo"] }, { harness: "gemini" },
  ])("refuses changed workspace, sandbox or harness before instruction dispatch %#", async (snapshot) => {
    fake.snapshotOverride = snapshot;
    const result = await backend().execute(request());
    expect(result.status).toBe("failed");
    expect(fake.instruction).toBe("");
  });

  it.each([
    "data: not-json\n\n", "data: []\n\n", "data: [DONE]\n\n",
    `data: ${JSON.stringify({ type: "session.status", conversation_id: SESSION, status: "idle" })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { id: TURN, status: "completed" } })}\n\n`,
  ])("requires real correlated terminal evidence, not idle, EOF or malformed SSE %#", async (wire) => {
    fake.streamOverride = wire;
    const result = await backend().execute(request());
    expect(result).toMatchObject({ status: "failed", quiescent: true, error: { code: "OMNIGENT_PROTOCOL_ERROR" } });
  });

  it("fails closed on a refused/ambiguous submission acknowledgement", async () => {
    fake.ackOverride = { queued: false, denied: true, reason: "password=private-response" };
    const result = await backend().execute(request());
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("OMNIGENT_PROTOCOL_ERROR");
    expect(fake.online).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private-response");
  });

  it.each(["failed", "cancelled"] as const)("maps native terminal %s states", async (terminalStatus) => {
    fake.terminal = terminalStatus;
    const result = await backend().execute(request());
    expect(result.status).toBe(terminalStatus);
    expect(result.quiescent).toBe(true);
  });

  it("also understands typed response envelopes from the Sessions API", async () => {
    fake.native = false;
    expect((await backend().execute(request())).status).toBe("completed");
  });

  it("rejects unauthorized workspace, write scope, provider and network before dispatch", () => {
    const taskManager = manager();
    for (const overrides of [
      { workspace_id: "another-workspace" }, { write_scope: ["../"] }, { write_scope: [".git"] },
      { network: true }, { approval_mode: "never" }, { orchestrator: "legacy" },
    ]) expect(() => taskManager.submit(input(overrides))).toThrow();
    expect(fake.calls).toEqual([]);
    expect(legacyFactory).not.toHaveBeenCalled();
  });

  it("does not widen full-access requests beyond an authorized workspace and scopes", async () => {
    const outside = makeTmpDir("omnigent-outside");
    try {
      await expect(backend().execute(request({ fullAccess: true, writeScope: [outside], writableRoots: [outside] }))).rejects.toMatchObject({ code: "OMNIGENT_POLICY_UNSUPPORTED" });
      expect(fake.calls).toHaveLength(0);
      const result = await backend().execute(request({ fullAccess: true, networkRequested: true, networkEffective: true }));
      expect(result.networkReported).toBe(true);
      expect(fake.metadata.terminal_launch_args).toContain("workspace-write");
      expect(fake.metadata.terminal_launch_args).toContain("sandbox_workspace_write.network_access=true");
    } finally { cleanup(outside); }
  });

  it("keeps task reads and cancellation restricted to the C2C owner", async () => {
    fake.hold = true;
    const taskManager = manager();
    const submitted = taskManager.submit(input(), { ownerId: "alice" });
    await until(() => taskManager.get(submitted.taskId), (value) => value.providerSessionId === SESSION);
    expect(() => taskManager.get(submitted.taskId, { ownerId: "bob" })).toThrow();
    await expect(taskManager.cancel(submitted.taskId, { ownerId: "bob" })).rejects.toThrow();
    expect(fake.calls.some((call) => call.init.body === JSON.stringify({ type: "interrupt", data: {} }))).toBe(false);
    const cancelled = await taskManager.cancel(submitted.taskId, { ownerId: "alice" });
    expect(cancelled.status).toBe("cancelled");
  });

  it("maps cancellation to interrupt and verified stop, retaining task/session ids", async () => {
    fake.hold = true;
    const taskManager = manager();
    const submitted = taskManager.submit(input());
    await until(() => taskManager.get(submitted.taskId), (value) => "turnId" in value && value.turnId === TURN);
    const result = await taskManager.cancel(submitted.taskId);
    expect(result).toMatchObject({ status: "cancelled", sessionId: submitted.sessionId, providerSessionId: SESSION, turnId: TURN });
    const events = fake.calls.filter((call) => call.route.endsWith("/events")).map((call) => JSON.parse(call.init.body as string).type);
    expect(events).toContain("interrupt");
    expect(events).toContain("stop_session");
    expect(fake.online).toBe(false);
    expect(readWorkspaceSlot(workspace.id, state)).toBeNull();
    expect(legacyFactory).not.toHaveBeenCalled();
  });

  it("keeps the writer lease and queued work blocked after unconfirmed cancellation", async () => {
    fake.hold = true;
    fake.refuseStop = true;
    const taskManager = manager();
    const first = taskManager.submit(input());
    await until(() => taskManager.get(first.taskId), (value) => "turnId" in value && value.turnId === TURN);
    await expect(taskManager.cancel(first.taskId)).rejects.toMatchObject({ code: "OMNIGENT_CANCEL_UNCONFIRMED" });
    expect(taskManager.get(first.taskId).status).toBe("cancelling");
    const second = taskManager.submit(input());
    expect(taskManager.get(second.taskId).status).toBe("queued");
    expect(readWorkspaceSlot(workspace.id, state)?.taskId).toBe(first.taskId);
    fake.refuseStop = false;
    await taskManager.cancel(second.taskId);
    await taskManager.cancel(first.taskId);
    expect(readWorkspaceSlot(workspace.id, state)).toBeNull();
  });

  it("bounds execution time and confirms remote cleanup", async () => {
    fake.hold = true;
    const result = await backend().execute(request({ timeoutMs: 30 }));
    expect(result).toMatchObject({ status: "timed_out", quiescent: true, error: { code: "TASK_TIMEOUT" } });
    expect(fake.online).toBe(false);
  });

  it("drains an in-flight submission before sending cancellation", async () => {
    let release!: () => void;
    fake.submitGate = new Promise<void>((resolve) => { release = resolve; });
    fake.hold = true;
    const worker = backend();
    const running = worker.execute(request());
    await until(() => fake.instruction, Boolean);
    const cancelling = worker.cancel(request().taskId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.calls.filter((call) => call.route.endsWith("/events"))).toHaveLength(1);
    release();
    await cancelling;
    expect(await running).toMatchObject({ status: "cancelled", quiescent: true });
    expect(fake.online).toBe(false);
  });

  it("rejects missing or mismatched persistent cancellation identities", async () => {
    const worker = backend();
    await worker.initialize(workspace.root);
    worker.bindWorkspaceId(workspace.id);
    await expect(worker.cancel(request().taskId, { providerSessionId: SESSION })).rejects.toMatchObject({ code: "OMNIGENT_STATE_INVALID" });
    await worker.execute(request());
    await expect(worker.cancel(request().taskId, { providerSessionId: "f".repeat(32) })).rejects.toMatchObject({ code: "OMNIGENT_STATE_INVALID" });
  });

  it("rejects a state junction before creating anything through it", async () => {
    const target = path.join(root, "linked-state");
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(state, "omnigent"), process.platform === "win32" ? "junction" : "dir");
    await expect(backend().execute(request())).rejects.toMatchObject({ code: "OMNIGENT_STATE_INVALID" });
    expect(fs.readdirSync(target)).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects short credentials in instructions before creating task records", () => {
    const taskManager = manager();
    expect(() => taskManager.submit(input({ instruction: "Use token=short-value" }))).toThrow("Remove credentials");
    expect(fake.calls).toHaveLength(0);
    expect(fs.readdirSync(path.join(state, "tasks", workspace.id))).toEqual([]);
  });

  it("sanitizes text, excludes reasoning/other turns, and never persists credentials", async () => {
    const secret = `sk-${"Q".repeat(32)}`;
    fake.text = `Result: api_key=${secret}\nAuthorization: Bearer ${"B".repeat(32)}`;
    const taskManager = manager();
    const submitted = taskManager.submit(input());
    const result = await until(() => taskManager.get(submitted.taskId), terminal);
    const output = readExecutionOutput(workspace.id, result.outputIds[0], state);
    expect(output.ok).toBe(true);
    if (output.ok) {
      expect(output.text).toContain("[REDACTED]");
      expect(output.text).not.toMatch(/PRIVATE INPUT|PRIVATE REASONING|ANOTHER TURN/);
      expect(output.text).not.toContain(secret);
    }
    const files = fs.readdirSync(state, { recursive: true }).map(String).map((name) => path.join(state, name)).filter((file) => fs.statSync(file).isFile());
    expect(files.map((file) => fs.readFileSync(file, "utf8")).join("\n")).not.toContain(secret);
    expect(() => taskManager.submit(input({ instruction: `Use api_key=${secret}` }))).toThrow("Remove credentials");
  });

  it("withholds private-key output and rejects malformed transcript pages", async () => {
    fake.text = "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----";
    const result = await backend().execute(request());
    expect(result.output).toContain("withheld");
    expect(result.output).not.toContain("private-material");
    fake.itemsOverride = { data: "wrong", has_more: false };
    const malformed = await backend().execute(request({ taskId: "c2c_0123456789ac" }));
    expect(malformed.status).toBe("failed");
  });

  it("keeps legacy history readable and never replays an Omnigent task", async () => {
    const taskManager = manager({ orchestrator: "legacy" });
    const old = taskManager.submit(input());
    await until(() => taskManager.get(old.taskId), terminal);
    await taskManager.close();
    const newManager = manager();
    expect(newManager.get(old.taskId)).toMatchObject({ status: "completed", orchestrator: "legacy", threadId: "legacy-thread" });
    const submitted = newManager.submit(input());
    await until(() => newManager.get(submitted.taskId), terminal);
    await expect(backend().execute(request({ taskId: submitted.taskId }))).rejects.toMatchObject({ code: "OMNIGENT_ALREADY_DISPATCHED" });
    await newManager.close();
    const reloaded = manager({ orchestrator: "legacy" });
    expect(reloaded.get(submitted.taskId)).toMatchObject({ status: "completed", providerSessionId: SESSION, turnId: TURN });
  });

  it("reconciles persisted Omnigent writers after restart before releasing the workspace", async () => {
    const taskManager = manager();
    const submitted = taskManager.submit(input());
    await until(() => taskManager.get(submitted.taskId), terminal);
    await taskManager.close();
    const taskFile = path.join(state, "tasks", workspace.id, `${submitted.taskId}.json`);
    const stored = JSON.parse(fs.readFileSync(taskFile, "utf8"));
    Object.assign(stored, { status: "running", executionRecorded: false, outputIds: [], completedAt: undefined, exitStatus: undefined });
    fs.writeFileSync(taskFile, JSON.stringify(stored));
    fs.writeFileSync(path.join(state, "executions", `${workspace.id}.jsonl`), "");
    const bindingFile = path.join(state, "omnigent", workspace.id, `${submitted.taskId}.json`);
    const binding = JSON.parse(fs.readFileSync(bindingFile, "utf8"));
    fs.writeFileSync(bindingFile, JSON.stringify({ ...binding, stopped: false, status: "running" }));
    fake.online = true;
    const recovering = manager({ orchestrator: "legacy" });
    const result = await until(() => recovering.get(submitted.taskId), terminal);
    expect(result).toMatchObject({ status: "interrupted", error: { code: "BRIDGE_RESTARTED" }, providerSessionId: SESSION, turnId: TURN });
    expect(fake.online).toBe(false);
    expect(legacyFactory).not.toHaveBeenCalled();
  });

  it("does not change the orchestrator of persisted queued tasks on restart", async () => {
    const taskManager = manager();
    taskManager.setQueuePaused(true);
    const submitted = taskManager.submit(input());
    expect(submitted.status).toBe("queued");
    await taskManager.close();
    const reloaded = manager({ orchestrator: "legacy" });
    reloaded.setQueuePaused(false);
    const result = await until(() => reloaded.get(submitted.taskId), terminal);
    expect(result.error?.code).toBe("ORCHESTRATOR_CHANGED");
    expect(legacyFactory).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
  });

  it("runs C2C's registered verification after success without a legacy coding turn", async () => {
    const taskManager = manager({ verificationProfileResolver: () => ({ id: "node-check", workspaceId: workspace.id,
      executable: "node", argv: ["--version"], cwd: "workspace", timeoutMs: 1_000, network: false, sandbox: "readOnly", summaryKind: "pytest" }) });
    const submitted = taskManager.submit(input({ run_tests: true }));
    const result = await until(() => taskManager.get(submitted.taskId), terminal);
    expect(result).toMatchObject({ status: "completed", tests: "7 passed", verification: { status: "passed" } });
    expect(legacy.requests).toEqual(["command/exec"]);
  });

  it("detects changes to already dirty files and scoped violations after dispatch", async () => {
    makeGitRepo(root);
    write(root, "src/index.ts", "already dirty\n");
    fake.beforeSubmit = () => { write(root, "src/index.ts", "edited dirty file\n"); write(root, "hello.txt", "outside scope\n"); };
    const taskManager = manager({ fullAccess: true });
    const submitted = taskManager.submit(input());
    const result = await until(() => taskManager.get(submitted.taskId), terminal);
    expect(result).toMatchObject({ status: "failed", error: { code: "WRITE_SCOPE_VIOLATION" } });
    expect(result.changedFiles).toContain("src/index.ts");
  });

  it("retains the MCP tool surface and enforces authorization before backend dispatch", async () => {
    const taskManager = manager();
    const server = createMcpServer({ workspace, logger: nullLogger, stateDir: state, sessions, taskManager, authorizedWorkspaceIds: [workspace.id] });
    const tools = (server as any)._registeredTools;
    expect(Object.keys(tools)).toHaveLength(33);
    expect(Object.keys(tools).filter((name) => name.startsWith("omnigent_"))).toHaveLength(6);
    const denied = await tools.submit_codex_task.handler(input(), { authInfo: { clientId: "bob", scopes: ["execution.submit"], extra: { authorizedWorkspaceIds: [] } } });
    expect(denied.isError).toBe(true);
    expect(fake.calls).toHaveLength(0);
    await server.close();
  });

  it("bounds HTTP bodies and deadlines without leaking server errors", async () => {
    const oversized = new OmnigentClient({ fetch: async () => new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": "9000000" } }) });
    await expect(oversized.snapshot(SESSION)).rejects.toMatchObject({ code: "OMNIGENT_PROTOCOL_ERROR" });
    const timeout = new OmnigentClient({ requestTimeoutMs: 10, fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("authorization=private")));
    }) });
    await expect(timeout.snapshot(SESSION)).rejects.toMatchObject({ code: "OMNIGENT_UNAVAILABLE" });
    const refused = new OmnigentClient({ fetch: async () => new Response("secret upstream body", { status: 401 }) });
    await expect(refused.snapshot(SESSION)).rejects.toThrow("unavailable or refused");
  });
});
