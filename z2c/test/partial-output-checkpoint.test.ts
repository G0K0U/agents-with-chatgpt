import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZcodeOfficialProvider } from "../src/providers/zcode/official.js";
import { loadConfig } from "../src/config.js";
import { TaskEngine } from "../src/core/tasks/engine.js";
import { Persistence } from "../src/core/tasks/persistence.js";
import { WorkspaceRegistry } from "../src/core/workspaces/registry.js";
import { FileAuditLog } from "../src/util/log.js";
import { classifyTaskFailure } from "../src/core/tasks/failure-class.js";

const FAKE_APP_SERVER = join(process.cwd(), "test", "fixtures", "fake-app-server.mjs");

describe("task failure classification (evidence-based only)", () => {
  it("distinguishes timeout, quota, auth, connection, and model errors", () => {
    assert.equal(classifyTaskFailure("turn timeout after 900000ms; session/stop cancellation requested"), "timeout");
    assert.equal(classifyTaskFailure("model error during turn: model_request_cancelled Model request was cancelled."), "timeout");
    assert.equal(classifyTaskFailure("model error during turn: quota_exceeded 额度已用尽"), "quota_exhausted");
    assert.equal(classifyTaskFailure("model error during turn: usage_limit_reached"), "quota_exhausted");
    assert.equal(classifyTaskFailure("model error during turn: unauthorized invalid token"), "auth");
    assert.equal(classifyTaskFailure("connection lost while waiting for turn"), "connection");
    assert.equal(classifyTaskFailure("model error during turn: something_else"), "model_error");
  });

  it("never invents a cause from silence or ambiguous codes", () => {
    assert.equal(classifyTaskFailure("HTTP 429"), "error"); // bare code: not quota evidence
    assert.equal(classifyTaskFailure("unverified execution binding"), "error");
    assert.equal(classifyTaskFailure(""), "error");
    assert.equal(classifyTaskFailure(null), "error");
    assert.equal(classifyTaskFailure(undefined), "error");
  });
});

interface OfficialHarness {
  provider: ZcodeOfficialProvider;
  stateDir: string;
  workspace: string;
}

async function buildOfficialHarness(): Promise<OfficialHarness> {
  const stateDir = mkdtempSync(join(tmpdir(), "z2c-checkpoint-"));
  const workspace = mkdtempSync(join(tmpdir(), "z2c-checkpoint-ws-"));
  process.env.FAKE_APP_SERVER_LOG = join(stateDir, "fixture-log.jsonl");
  process.env.FAKE_APP_SERVER_STATE = join(stateDir, "fixture-state.json");
  const cfg = {
    ...loadConfig(),
    stateDir,
    zcodeCliPath: FAKE_APP_SERVER,
  };
  const provider = new ZcodeOfficialProvider(cfg);
  await provider.start();
  return { provider, stateDir, workspace };
}

async function stopOfficialHarness(h: OfficialHarness): Promise<void> {
  await h.provider.stop();
  rmSync(h.stateDir, { recursive: true, force: true });
  rmSync(h.workspace, { recursive: true, force: true });
  delete process.env.FAKE_APP_SERVER_LOG;
  delete process.env.FAKE_APP_SERVER_STATE;
}

describe("partial checkpoint output on model-error turns", () => {
  afterEach(() => {
    delete process.env.FAKE_MODEL_ERROR;
  });

  it("readAssistantOutput default still fails the turn on a model error", async () => {
    process.env.FAKE_MODEL_ERROR = "model_request_cancelled";
    const h = await buildOfficialHarness();
    try {
      const ws = { workspacePath: h.workspace, workspaceKey: h.workspace };
      const sessionId = await h.provider.createSession(ws, { modelId: "GLM-5.3-Flash", thoughtLevel: "max" });
      const handle = await h.provider.send({ sessionId, instruction: "OK", inputId: "in-1", timeoutMs: 5000 });
      const result = await handle.completion;
      await assert.rejects(
        () => h.provider.readAssistantOutput(sessionId, 16000),
        /model error during turn: model_request_cancelled/,
      );
      assert.ok(result);
    } finally {
      await stopOfficialHarness(h);
    }
  });

  it("allowModelError keeps pre-error text readable with the error inlined", async () => {
    process.env.FAKE_MODEL_ERROR = "model_request_cancelled";
    const h = await buildOfficialHarness();
    try {
      const ws = { workspacePath: h.workspace, workspaceKey: h.workspace };
      const sessionId = await h.provider.createSession(ws, { modelId: "GLM-5.3-Flash", thoughtLevel: "max" });
      const handle = await h.provider.send({ sessionId, instruction: "OK", inputId: "in-1", timeoutMs: 5000 });
      await handle.completion;
      const text = await h.provider.readAssistantOutput(sessionId, 16000, { allowModelError: true });
      assert.match(text, /PARTIAL CHECKPOINT BEFORE ERROR/);
      assert.match(text, /\[model error during turn: model_request_cancelled Model request was cancelled\]/);
    } finally {
      await stopOfficialHarness(h);
    }
  });
});

describe("engine failure path preserves the checkpoint output", () => {
  afterEach(() => {
    delete process.env.FAKE_MODEL_ERROR;
  });

  it("a task whose turn ends in a model error fails WITH readable partial output", async () => {
    process.env.FAKE_MODEL_ERROR = "model_request_cancelled";
    const dir = mkdtempSync(join(tmpdir(), "z2c-checkpoint-engine-"));
    const store = new Persistence(dir);
    const workspaces = WorkspaceRegistry.fromList([]);
    mkdirSync(join(dir, "ws0"), { recursive: true });
    const ws = workspaces.register("z2c-test", join(dir, "ws0"), "test");
    store.data.workspaces = workspaces.toList();
    store.save();
    const cfg = { ...loadConfig(), stateDir: dir, zcodeCliPath: FAKE_APP_SERVER };
    const provider = new ZcodeOfficialProvider(cfg);
    await provider.start();
    const engine = new TaskEngine(cfg, provider, workspaces, store, new FileAuditLog(join(dir, "audit")));
    try {
      const task = await engine.submitTask({
        workspace_id: "z2c-test",
        instruction: "produce a checkpoint then die",
      });
      const deadline = Date.now() + 15000;
      let view = engine.getTask(undefined, task.task_id);
      while (Date.now() < deadline && !["completed", "failed", "cancelled"].includes(view.status)) {
        await new Promise((r) => setTimeout(r, 50));
        view = engine.getTask(undefined, task.task_id);
      }
      assert.equal(view.status, "failed");
      assert.match(view.exit_status ?? "", /model_request_cancelled/);
      assert.ok(view.output_id, "failed task must expose its partial checkpoint output");
      const output = engine.getOutput(undefined, task.task_id, view.output_id!);
      assert.match(output.text, /PARTIAL CHECKPOINT BEFORE ERROR/);
      assert.match(output.text, /\[model error during turn: model_request_cancelled/);
      // The failure class is recorded on the audit surface for monitoring.
      const auditPath = join(dir, "audit", "audit.log");
      const audit = readFileSync(auditPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
      const errorEvent = audit.find((e) => e.event === "task.error" && e.taskId === task.task_id);
      assert.ok(errorEvent);
      assert.equal(errorEvent.failureClass, "timeout");
    } finally {
      await provider.stop();
      rmSync(dir, { recursive: true, force: true });
      delete process.env.FAKE_APP_SERVER_LOG;
      delete process.env.FAKE_APP_SERVER_STATE;
    }
  });
});
