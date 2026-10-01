import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DshNativeService } from "../src/execution/dsh-native-service.js";
import { DshNativeError, type DshNativeClient, type DshNativeTask } from "../src/execution/dsh-native-client.js";
import { makeTmpDir, cleanup } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) cleanup(dir); });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function fixture() {
  const root = makeTmpDir("dsh-workspace");
  const state = makeTmpDir("dsh-state");
  dirs.push(root, state);
  let generation = "generation-one";
  let sessionId = "";
  let requestId = "";
  let instruction = "";
  let phase: "empty" | "running" | "done" = "empty";
  let sends = 0;
  let cancels = 0;
  let executes = 0;
  let executeError = false;
  let selectedModel = "Bonsai2-CRACK-PQ2.ninfer";
  const client = {
    health: async () => ({ adapter: "dsh-a2c-native-session-adapter", version: "0.1.0",
      generation, hostPid: 123, dshVersion: "2.0.13-beta.1", harnessVersion: "0.1.6-alpha.2", capabilities: {} }),
    create: async (_root: string, id: string) => { sessionId = id; return {
      generation, sessionId: id, cwd: root, createdAt: "2026-09-27T00:00:00.000Z" }; },
    read: async () => ({ generation, sessionId, cwd: root, origin: null,
      createdAt: "2026-09-27T00:00:00.000Z", running: phase === "running",
      status: phase === "running" ? "running" : "cold", lastSeq: 0,
      selection: { provider: "qqz-kvmem", model: selectedModel, reasoningEffort: "high" },
      messages: phase === "empty" ? [] : [{ seq: 1, at: "2026-09-27T00:01:00.000Z",
        role: "user", text: instruction, requestId, model: null, provider: null }] }),
    modelCatalog: async () => ({ generation, default: { provider: "qqz-kvmem",
      model: "Bonsai2-CRACK-PQ2.ninfer" }, groups: [{ id: "qqz-kvmem", name: "Local",
        models: ["Bonsai2-CRACK-PQ2.ninfer", "Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf"].map((id, index) => ({
          id, name: id, backend: index === 0 ? "ninfer" : "kvmem", slot: index === 0 ? "b" : "a",
          profile: index === 0 ? "text:fast" : "vision:fast",
          reasoning: { efforts: ["low", "medium", "high"].map((effort) => ({ id: effort })) },
        })) }] }),
    task: async (_root: string, id: string, nativeId: string): Promise<DshNativeTask> => ({
      generation, sessionId: id, requestId: nativeId, found: phase !== "empty",
      running: phase === "running", activeRequestId: requestId || null,
      ...(phase === "empty" ? {} : { userSeq: 1, userAt: "2026-09-27T00:01:00.000Z",
        promptSha256: hash(instruction) }),
      terminal: phase === "done" ? { seq: 9, at: "2026-09-27T00:02:00.000Z", reason: "completed" } : null,
      final: phase === "done" ? { seq: 8, at: "2026-09-27T00:01:59.000Z",
        text: "Wrote and read the test file.", provider: "qqz-kvmem",
        model: "Bonsai2-CRACK-PQ2.ninfer" } : null,
      toolCalls: phase === "done" ? 2 : 0, toolResults: phase === "done" ? 2 : 0,
      events: [],
    }),
    send: async (_root: string, id: string, nativeId: string, text: string, expected: string) => {
      assert.equal(expected, generation);
      sends++; phase = "running"; requestId = nativeId; instruction = text;
      return { generation, sessionId: id, requestId: nativeId, accepted: true, duplicate: false };
    },
    execute: async (_root: string, id: string, nativeId: string, text: string, model: string,
      effort: string, expected: string) => {
      assert.equal(expected, generation);
      executes++; phase = "running"; requestId = nativeId; instruction = text; selectedModel = model;
      if (executeError) throw new DshNativeError("D2C_UNAVAILABLE", "Transport outcome unknown");
      return { generation, sessionId: id, requestId: nativeId, accepted: true, duplicate: false,
        sequence: 1, model, effort };
    },
    cancel: async (_root: string, id: string, nativeId: string, expected: string) => {
      assert.equal(expected, generation); cancels++;
      return { generation, sessionId: id, requestId: nativeId, cancelled: true };
    },
  } as unknown as DshNativeClient;
  return { root, state, client, service: new DshNativeService(state, client),
    setPhase: (next: typeof phase) => { phase = next; },
    setGeneration: (next: string) => { generation = next; },
    sends: () => sends, cancels: () => cancels, executes: () => executes,
    setExecuteError: (value: boolean) => { executeError = value; } };
}

describe("D2C native session ownership and terminal evidence", () => {
  it("resumes an owned request, waits for native turn/end, and captures final visible output", async () => {
    const f = fixture();
    const created = await f.service.create("ws-test", f.root, "client-A", "create-0001");
    const sent = await f.service.send("ws-test", f.root, created.sessionId, "client-A",
      "request-0001", "Write and read one test file.", "Bonsai2-CRACK-PQ2.ninfer");
    assert.equal(sent.status, "accepted");
    assert.equal((await f.service.task("ws-test", f.root, sent.taskId)).status, "running");
    assert.equal(f.sends(), 1);
    await assert.rejects(() => f.service.send("ws-test", f.root, created.sessionId, "client-B",
      "request-0001", "Write and read one test file."),
    (error: unknown) => error instanceof DshNativeError && error.code === "D2C_NOT_OWNER");
    const otherRoot = makeTmpDir("dsh-other-workspace");
    dirs.push(otherRoot);
    await assert.rejects(() => f.service.send("ws-test", otherRoot, created.sessionId, "client-A",
      "request-0003", "Write and read one test file."),
    (error: unknown) => error instanceof DshNativeError && error.code === "D2C_NOT_OWNER");
    await assert.rejects(() => f.service.read(otherRoot, created.sessionId),
    (error: unknown) => error instanceof DshNativeError && error.code === "D2C_IDENTITY_MISMATCH");
    await assert.rejects(() => f.service.send("ws-test", f.root, created.sessionId, "client-A",
      "request-0001", "Different prompt"),
    (error: unknown) => error instanceof DshNativeError && error.code === "D2C_DUPLICATE_CONFLICT");
    f.setPhase("done");
    f.setGeneration("generation-two");
    assert.equal((await f.service.attach("ws-test", f.root, created.sessionId, "client-A")).generation,
      "generation-two");
    const done = await f.service.task("ws-test", f.root, sent.taskId);
    assert.equal(done.status, "completed");
    assert.equal(done.nativeEvidence.terminalSeq, 9);
    assert.equal(done.nativeEvidence.toolCalls, 2);
    assert.equal(done.actionEvidence.finalOutputCaptured, true);
    assert.match(f.service.output("ws-test", sent.taskId, "client-A").text, /Wrote and read/);
    assert.equal((await f.service.send("ws-test", f.root, created.sessionId, "client-A",
      "request-0001", "Write and read one test file.")).taskId, sent.taskId);
    assert.equal(f.sends(), 1);
  });

  it("cancels only the caller's active native request", async () => {
    const f = fixture();
    const { sessionId } = await f.service.create("ws-test", f.root, "client-A", "create-0002");
    const task = await f.service.send("ws-test", f.root, sessionId, "client-A",
      "request-0002", "Wait for cancellation.");
    await assert.rejects(() => f.service.cancel("ws-test", f.root, task.taskId, "client-B"),
      (error: unknown) => error instanceof DshNativeError && error.code === "D2C_NOT_OWNER");
    assert.equal((await f.service.cancel("ws-test", f.root, task.taskId, "client-A")).cancelRequested, true);
    assert.equal(f.cancels(), 1);
    f.setPhase("done");
    await assert.rejects(() => f.service.cancel("ws-test", f.root, task.taskId, "client-A"),
      (error: unknown) => error instanceof DshNativeError && error.code === "D2C_NOT_RUNNING");
  });
});

describe("D2C selected task admission", () => {
  for (const servedEffort of ["xhigh", "low", null]) it(`attests resolved effort at terminal: ${servedEffort}`, async () => {
    const f = fixture();
    const execute = f.client.execute.bind(f.client);
    f.client.execute = async (...args) => ({ ...await execute(...args), resolvedEffort: "xhigh" });
    const readTask = f.client.task.bind(f.client);
    f.client.task = async (...args) => ({ ...await readTask(...args), served: {
      provider: "qqz-kvmem", model: "Bonsai2-CRACK-PQ2.ninfer", reasoningEffort: servedEffort,
    } });
    const task = await f.service.submitSelected("ws-test", f.root, "client-A", "effort-0001",
      "Check exact effort", "Bonsai2-CRACK-PQ2.ninfer", "high");
    assert.equal(task.resolvedEffort, "xhigh");
    f.setPhase("done");
    const done = await f.service.task("ws-test", f.root, task.taskId);
    assert.equal(done.status, servedEffort === "xhigh" ? "completed" : "failed");
    assert.equal(done.outputAvailable, servedEffort === "xhigh");
    if (servedEffort !== "xhigh") assert.equal(done.error?.code, "D2C_EFFORT_MISMATCH");
  });

  it("binds the exact model and effort and does not replay a duplicate request", async () => {
    const f = fixture();
    const first = await f.service.submitSelected("ws-test", f.root, "client-A", "selected-0001",
      "A small selected task", "Bonsai2-CRACK-PQ2.ninfer", "low");
    assert.equal(first.providerModel, "Bonsai2-CRACK-PQ2.ninfer");
    assert.equal(first.effort, "low");
    assert.equal(first.selectionScope, "transactional-global-lease");
    assert.equal(first.status, "accepted");
    const duplicate = await f.service.submitSelected("ws-test", f.root, "client-A", "selected-0001",
      "A small selected task", "Bonsai2-CRACK-PQ2.ninfer", "low");
    assert.equal(duplicate.taskId, first.taskId);
    assert.equal(f.executes(), 1);
    await assert.rejects(() => f.service.submitSelected("ws-test", f.root, "client-A", "selected-0001",
      "A small selected task", "Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf", "low"),
    (error: unknown) => error instanceof DshNativeError && error.code === "D2C_DUPLICATE_CONFLICT");
  });

  it("refuses unsupported model and effort before native dispatch", async () => {
    const f = fixture();
    await assert.rejects(() => f.service.submitSelected("ws-test", f.root, "client-A", "selected-0002",
      "A small selected task", "not-in-catalog", "low"),
    (error: unknown) => error instanceof DshNativeError && error.code === "D2C_UNSUPPORTED_MODEL");
    await assert.rejects(() => f.service.submitSelected("ws-test", f.root, "client-A", "selected-0003",
      "A small selected task", "Bonsai2-CRACK-PQ2.ninfer", "ultra" as "high"),
    (error: unknown) => error instanceof DshNativeError && error.code === "D2C_BAD_SELECTION");
    assert.equal(f.executes(), 0);
  });

  it("persists an ambiguous outcome and never replays the native mutation", async () => {
    const f = fixture();
    f.setExecuteError(true);
    await assert.rejects(() => f.service.submitSelected("ws-test", f.root, "client-A", "selected-0004",
      "A small selected task", "Bonsai2-CRACK-PQ2.ninfer", "high"),
    (error: unknown) => error instanceof DshNativeError && error.code === "D2C_OUTCOME_UNKNOWN");
    const duplicate = await f.service.submitSelected("ws-test", f.root, "client-A", "selected-0004",
      "A small selected task", "Bonsai2-CRACK-PQ2.ninfer", "high");
    assert.equal(duplicate.status, "running");
    assert.equal(f.executes(), 1);
  });
});
