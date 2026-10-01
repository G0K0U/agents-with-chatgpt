import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OrchestratorCore } from "../src/execution/orchestrator-core.js";
import { pendingWakes, startChatWake } from "../src/execution/chat-wake.js";
import { registerOrchestratorTools } from "../src/mcp/orchestrator-tools.js";
import type { CodexTaskView } from "../src/execution/tasks.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const dirs: string[] = [];
const services: Awaited<ReturnType<typeof startChatWake>>[] = [];
afterEach(async () => { for (const s of services.splice(0)) await s.close(); dirs.splice(0).forEach(cleanup); });

it("runs PASS -> REWORK -> PASS via audit tools, with durable wake deduplication and unchanged limits", async () => {
  const dir = makeTmpDir("r4-loop"); dirs.push(dir);
  const tasks = new Map<string, CodexTaskView>();
  const executor = {
    submit: vi.fn((_input: unknown, access: any) => {
      const taskId = access.orchestratorKey;
      if (!tasks.has(taskId)) tasks.set(taskId, { taskId, status: "running", outputIds: [] } as unknown as CodexTaskView);
      return tasks.get(taskId)!;
    }),
    get: (id: string) => tasks.get(id)!,
  };
  let core = new OrchestratorCore(dir, "ws", executor);
  const handlers = new Map<string, any>();
  const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  registerOrchestratorTools({ registerTool: (name: string, _schema: unknown, handler: unknown) => handlers.set(name, handler) } as unknown as McpServer, {
    resolve: () => core, requireScope: () => null, ok, mapError: e => ({ ...ok(String(e)), isError: true }),
  });
  const call = async (name: string, args = {}) => handlers.get(name)({ workspace_id: "ws", run_id: "run", ...args }, { authInfo: { clientId: "owner" } });
  const read = () => core.read("run", "owner");
  const step = { instruction: "Change fixture", write_scope: ["fixture"], model: "explicit-model", effort: "low", network: false, run_tests: false };
  expect((await call("orchestrator_run_create", { steps: [step, { ...step, instruction: "Check fixture" }] })).isError).toBeUndefined();
  const wakeOptions = { dir: path.join(dir, "wake"), secret: "hermetic-only", pending: () => pendingWakes(dir, "ws", "owner"), port: 0 };
  let service = await startChatWake(wakeOptions); services.push(service);
  const bridge = async (route: string, body = {}) => {
    const res = await fetch(`http://127.0.0.1:${service.port}/wake/${route}`, { method: "POST", headers: { Authorization: "Bearer hermetic-only" }, body: JSON.stringify(body) });
    expect(res.status).toBe(200); return res.json();
  };
  const finish = async (failed = false) => {
    const task = executor.get(read().taskId!); task.status = "completed"; task.outputIds = [7];
    if (failed) task.stableVerification = { passed: false, sourceHash: null, commands: [{ command: "fixture-test", exitCode: 1 }] };
    await core.recover(); await core.recover();
    expect(read().state).toBe("WAITING_AUDIT");
  };
  const audit = async (verdict: string) => {
    const audit_id = read().audits.at(-1)!.id;
    expect((await call("orchestrator_audit_claim", { audit_id })).isError).toBeUndefined();
    return call("orchestrator_audit_submit", { audit_id, verdict });
  };
  await finish();
  const first = await bridge("next"); expect(first.event.audit_id).toBe("run:0:1");
  await bridge("ack", { event: first.event, status: "wake_submitted" });
  // Restart both sides while waiting: no redispatch and no second wake request.
  await service.close(); services.pop();
  core = new OrchestratorCore(dir, "ws", executor); await core.recover();
  service = await startChatWake(wakeOptions); services.push(service);
  expect(await bridge("next")).toEqual({ event: null });
  expect(executor.submit).toHaveBeenCalledTimes(1);
  expect((await audit("PASS")).isError).toBeUndefined();
  expect(read()).toMatchObject({ step: 1, attempt: 1 });
  await finish(true);
  const second = await bridge("next");
  await bridge("ack", { event: second.event, status: "wake_failed" });
  expect(await bridge("next")).toEqual({ event: null });
  core = new OrchestratorCore(dir, "ws", executor); await core.recover();
  const visible = JSON.parse((await call("orchestrator_run_read")).content[0].text);
  expect(visible.audits.at(-1)).toMatchObject({ terminalStatus: "completed", passBlockers: ["command:0:exit:1"], outputIds: [7] });
  expect((await audit("PASS")).isError).toBe(true);
  expect(read().state).toBe("WAITING_AUDIT"); expect(executor.submit).toHaveBeenCalledTimes(2);
  expect((await audit("REWORK")).isError).toBeUndefined();
  expect(read()).toMatchObject({ step: 1, attempt: 2 });
  expect(executor.submit.mock.calls[1][0]).toEqual(executor.submit.mock.calls[2][0]);
  await finish();
  const third = await bridge("next"); expect(third.event.audit_id).toBe("run:1:2");
  await bridge("ack", { event: third.event, status: "wake_submitted" });
  expect((await audit("PASS")).isError).toBeUndefined();
  expect(read().state).toBe("COMPLETE"); expect(read().audits).toHaveLength(3);
  expect(await bridge("next")).toEqual({ event: null });
  expect(executor.submit).toHaveBeenCalledTimes(3);
});

it.each(["failed", "cancelled", "interrupted", "timed_out"] as const)("vetoes PASS for %s and BLOCKED survives restart", async status => {
  const dir = makeTmpDir("r4-failure"); dirs.push(dir);
  const task = { taskId: "task", status, outputIds: [] } as unknown as CodexTaskView;
  const executor = { submit: vi.fn(() => task), get: () => task };
  let core = new OrchestratorCore(dir, "ws", executor);
  const run = await core.create("run", "owner", [{ instruction: "Bounded step", write_scope: ["fixture"] }]);
  const id = run.audits[0]!.id; await core.claim("run", "owner", id, "owner");
  await expect(core.submitAudit("run", "owner", id, "owner", "PASS")).rejects.toThrow("deterministic");
  await core.submitAudit("run", "owner", id, "owner", "BLOCKED");
  core = new OrchestratorCore(dir, "ws", executor); await core.recover();
  expect(core.read("run", "owner").state).toBe("BLOCKED"); expect(executor.submit).toHaveBeenCalledTimes(1);
});
