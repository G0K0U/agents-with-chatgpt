import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrchestratorCore, acquireStateLock } from "../src/execution/orchestrator-core.js";
import { CodexTaskManager, type CodexTaskView } from "../src/execution/tasks.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir, makeGitRepo } from "./helpers.js";

describe("durable minimal orchestrator", () => {
  let dir: string;
  const plan = [{ instruction: "Update the fixture", write_scope: ["src"], network: false, run_tests: false }];
  let tasks: Map<string, CodexTaskView>;
  let manager: Pick<CodexTaskManager, "submit" | "get">;
  let core: OrchestratorCore;
  beforeEach(() => {
    dir = makeTmpDir("orchestrator"); tasks = new Map();
    manager = {
      submit: vi.fn((_input, access) => {
        const key = access!.orchestratorKey!;
        if (!tasks.has(key)) tasks.set(key, { taskId: key, status: "queued", outputIds: [] } as unknown as CodexTaskView);
        return tasks.get(key)!;
      }),
      get: vi.fn(id => [...tasks.values()].find(t => t.taskId === id)!),
    };
    core = new OrchestratorCore(dir, "ws", manager);
  });
  afterEach(() => { vi.restoreAllMocks(); cleanup(dir); });
  async function terminal() {
    const run = core.read("run", "owner");
    const task = manager.get(run.taskId!);
    task.status = "completed"; task.outputIds = [7];
    await core.recover();
    return core.read("run", "owner").audits.at(-1)!;
  }
  it("persists explicit defaults and monotonically advances once on duplicate terminal events", async () => {
    const run = await core.create("run", "owner", plan);
    expect(run.steps[0]).toMatchObject({ agent: "codex" });
    manager.get(run.taskId!).status = "running";
    await core.recover();
    expect(core.read("run", "owner").state).toBe("RUNNING");
    const audit = await terminal();
    await core.recover();
    expect(audit).toMatchObject({ type: "audit.required", outputIds: [7] });
    const generation = core.read("run", "owner").generation;
    await core.recover(); core = new OrchestratorCore(dir, "ws", manager); await core.recover();
    expect(core.read("run", "owner")).toMatchObject({ generation, state: "WAITING_AUDIT", audits: [audit] });
    expect(generation).toBeGreaterThan(run.generation);
    expect(manager.submit).toHaveBeenCalledTimes(1);
  });
  it("PASS advances the explicit next step and completes, with idempotent audit submission", async () => {
    await core.create("run", "owner", [...plan, { ...plan[0], instruction: "Verify fixture" }]);
    const a = await terminal(); await core.recover(); await core.claim("run", "owner", a.id, "reviewer");
    await core.submitAudit("run", "owner", a.id, "reviewer", "PASS");
    await core.submitAudit("run", "owner", a.id, "reviewer", "PASS");
    expect(tasks.size).toBe(2);
    await expect(core.submitAudit("run", "owner", a.id, "reviewer", "REWORK")).rejects.toThrow("conflict");
    const b = await terminal(); await core.recover(); await core.claim("run", "owner", b.id, "reviewer");
    expect((await core.submitAudit("run", "owner", b.id, "reviewer", "PASS")).state).toBe("COMPLETE");
  });
  it("REWORK increments only current attempt and preserves explicit scope and instruction", async () => {
    await core.create("run", "owner", plan);
    const a = await terminal(); await core.recover(); await core.claim("run", "owner", a.id, "reviewer");
    const run = await core.submitAudit("run", "owner", a.id, "reviewer", "REWORK", "Check existing evidence");
    expect(run).toMatchObject({ step: 0, attempt: 2 });
    const calls = vi.mocked(manager.submit).mock.calls;
    expect(calls[0][0]).toEqual(calls[1][0]);
    expect(calls[0][1]?.orchestratorKey).not.toEqual(calls[1][1]?.orchestratorKey);
  });
  it("BLOCKED stops across restart and resume", async () => {
    await core.create("run", "owner", plan);
    const a = await terminal(); await core.recover(); await core.claim("run", "owner", a.id, "reviewer");
    await core.submitAudit("run", "owner", a.id, "reviewer", "BLOCKED");
    core = new OrchestratorCore(dir, "ws", manager); await core.recover();
    expect((await core.pause("run", "owner", false)).state).toBe("BLOCKED");
    expect(tasks.size).toBe(1);
  });
  it("pause persists audit results but defers the next dispatch until resume", async () => {
    await core.create("run", "owner", plan); await core.pause("run", "owner", true);
    const a = await terminal(); await core.recover(); await core.claim("run", "owner", a.id, "reviewer");
    expect((await core.submitAudit("run", "owner", a.id, "reviewer", "REWORK")).state).toBe("IDLE");
    core = new OrchestratorCore(dir, "ws", manager); await core.recover();
    expect(tasks.size).toBe(1);
    await core.pause("run", "owner", false); expect(tasks.size).toBe(2);
  });
  it("recovers the crash window after task admission but before run task binding", async () => {
    await core.create("run", "owner", plan);
    const file = path.join(dir, "orchestrator/ws/run.json");
    const run = JSON.parse(fs.readFileSync(file, "utf8")); delete run.taskId;
    fs.writeFileSync(file, JSON.stringify(run));
    core = new OrchestratorCore(dir, "ws", manager); await core.recover();
    expect(tasks.size).toBe(1);
    expect(core.read("run", "owner").taskId).toBe("run:0:1");
  });
  it("rejects a second state writer, wrong owner, claim conflicts and unclaimed audit", async () => {
    await core.create("run", "owner", plan);
    expect(() => core.read("run", "intruder")).toThrow("owner");
    const a = await terminal(); await core.recover();
    await expect(core.submitAudit("run", "owner", a.id, "reviewer", "PASS")).rejects.toThrow("claim");
    await core.claim("run", "owner", a.id, "reviewer");
    await expect(core.claim("run", "owner", a.id, "other")).rejects.toThrow("claimed");
    const lock = path.join(dir, "orchestrator/ws/writer.lock"); fs.writeFileSync(lock, String(process.pid));
    await expect(new OrchestratorCore(dir, "ws", manager).pause("run", "owner", true)).rejects.toThrow();
    fs.unlinkSync(lock);
    await expect(core.create("../escape", "owner", plan)).rejects.toThrow();
  });
  it("preserves pinned selections and rejects conflicting create retries and oversized notes", async () => {
    const pinned = [{ ...plan[0], model: "explicit", effort: "high" }];
    await core.create("run", "owner", pinned); await core.create("run", "owner", pinned);
    expect(core.read("run", "owner").steps[0]).toMatchObject({ model: "explicit", effort: "high" });
    await expect(core.create("run", "owner", plan)).rejects.toThrow("scope");
    await expect(core.submitAudit("run", "owner", "x", "r", "PASS", "x".repeat(1001))).rejects.toThrow();
  });
  it("fails closed for corrupt state and revoked authorization", async () => {
    const denied = new OrchestratorCore(dir, "ws", manager, { authorize: () => false });
    expect((await denied.create("run", "owner", plan)).state).toBe("BLOCKED");
    expect(tasks.size).toBe(0);
    fs.writeFileSync(path.join(dir, "orchestrator/ws/run.json"), "invalid");
    expect(() => core.read("run", "owner")).toThrow(); await core.recover(); expect(tasks.size).toBe(0);
  });
  it.each(["failed", "cancelled", "interrupted", "timed_out"] as const)("records one audit for terminal %s", async status => {
    const run = await core.create("run", "owner", plan);
    manager.get(run.taskId!).status = status;
    await core.recover(); await core.recover();
    expect(core.read("run", "owner").audits).toHaveLength(1);
    expect(core.read("run", "owner").state).toBe("WAITING_AUDIT");
  });
  it("recovers persisted dispatch intent when admission was unavailable", async () => {
    vi.mocked(manager.submit).mockImplementationOnce(() => { throw Object.assign(new Error("busy"), { code: "QUEUE_FULL" }); });
    await expect(core.create("run", "owner", plan)).rejects.toThrow("busy");
    expect(core.read("run", "owner").state).toBe("DISPATCHED");
    core = new OrchestratorCore(dir, "ws", manager); await core.recover();
    expect(tasks.size).toBe(1);
  });
  it("records a permanent admission failure without automatic retries", async () => {
    vi.mocked(manager.submit).mockImplementationOnce(() => { throw Object.assign(new Error("invalid"), { code: "INVALID_TASK" }); });
    expect((await core.create("run", "owner", plan)).state).toBe("FAIL");
    await core.recover(); expect(manager.submit).toHaveBeenCalledTimes(1);
  });
  it("recovers dead writer and reaper locks, retaining live writer exclusion", async () => {
    const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    expect(exited.status).toBe(0);
    const file = path.join(dir, "fixture.lock");
    fs.writeFileSync(file, JSON.stringify({ pid: Number(exited.stdout) }));
    fs.writeFileSync(`${file}.reaper`, exited.stdout);
    const release = acquireStateLock(file);
    try { expect(() => acquireStateLock(file)).toThrow(); }
    finally { release(); }
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
  it("real task manager deduplicates durable admissions across restart without a second queue", async () => {
    const root = path.join(dir, "project"); fs.mkdirSync(root); makeGitRepo(root);
    const workspace = new Workspace(root);
    let real = new CodexTaskManager(workspace, { stateDir: dir });
    try {
      real.setQueuePaused(true);
      const run = await real.orchestrator.create("run", "local", plan);
      expect(real.get(run.taskId!).status).toBe("queued");
      await real.close();
      const file = path.join(dir, "orchestrator", workspace.id, "run.json");
      const saved = JSON.parse(fs.readFileSync(file, "utf8")); delete saved.taskId;
      fs.writeFileSync(file, JSON.stringify(saved));
      real = new CodexTaskManager(workspace, { stateDir: dir });
      await real.orchestrator.recover();
      expect(real.orchestrator.read("run", "local").taskId).toBe(run.taskId);
      expect(fs.readdirSync(path.join(dir, "tasks", workspace.id)).filter(f => f.endsWith(".json"))).toHaveLength(1);
    } finally { await real.close(); }
  });
});
