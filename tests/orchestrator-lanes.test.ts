import { afterEach, expect, it, vi } from "vitest";
import { OrchestratorCore, type OrchestratorLane, type ResolvedStepSelection } from "../src/execution/orchestrator-core.js";
import type { CodexTaskView } from "../src/execution/tasks.js";
import { cleanup, makeTmpDir } from "./helpers.js";

/**
 * Provider-neutral orchestration: every agent family dispatches through its
 * AUTHORITATIVE lane seam (task-manager codex/gemini, injected zcode/dsh
 * native lanes), all terminal statuses enter WAITING_AUDIT exactly once, and
 * PASS/REWORK/BLOCKED drive the documented next-step behavior. No silent
 * provider substitution anywhere.
 */

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(cleanup); });

interface FakeTask { taskId: string; status: string; outputIds: number[]; verification?: unknown }

function laneHarness(lanes?: Record<string, OrchestratorLane>) {
  const dir = makeTmpDir("orch-lanes"); dirs.push(dir);
  const tasks = new Map<string, FakeTask>();
  const submitCalls: Array<{ input: Record<string, unknown>; key: string }> = [];
  const executor = {
    submit: vi.fn((input: Record<string, unknown>, access: { orchestratorKey?: string }) => {
      const key = access.orchestratorKey!;
      submitCalls.push({ input, key });
      if (!tasks.has(key)) tasks.set(key, { taskId: key, status: "queued", outputIds: [] });
      return tasks.get(key)!;
    }),
    get: (id: string) => tasks.get(id)! as unknown as CodexTaskView,
  };
  const core = new OrchestratorCore(dir, "ws", executor as never, {
    ...(lanes ? { lanes: lanes as never } : {}),
  });
  const nativeLanes = lanes ?? {};
  return { dir, core, tasks, submitCalls, executor, nativeLanes };
}

function resolveThrough(agent: string, model = "model-x", effort: string | null = null): unknown {
  // Simulate the live-catalog resolution outcome for the step.
  return agent;
}

function laneSubmitRecorder(lane: OrchestratorLane, calls: Array<{ step: unknown; resolved: ResolvedStepSelection }>): OrchestratorLane {
  return {
    submit: async (step, resolved, access) => { calls.push({ step, resolved }); return lane.submit(step, resolved, access); },
    get: lane.get,
  };
}

const baseStep = { instruction: "Bounded step", write_scope: ["fixture"], run_tests: false, network: false };

it.each([
  ["codex", undefined],
  ["antigravity", undefined],
  ["zcode", "zcode"],
  ["dsh", "dsh"],
] as const)("dispatches a %s step through its lane and reaches WAITING_AUDIT on completion", async (agent, laneKey) => {
  const nativeCalls: Array<{ step: unknown; resolved: ResolvedStepSelection }> = [];
  const injected: Record<string, OrchestratorLane> = {};
  if (laneKey === "zcode") {
    injected.zcode = {
      submit: async (_step, resolved, access) => {
        nativeCalls.push({ step: _step, resolved });
        return { taskId: `z2c_${access.orchestratorKey}`, status: "running", outputIds: ["out_1"], verification: null };
      },
      get: async (taskId) => ({ taskId, status: "completed", outputIds: ["out_1"], verification: null }),
    };
  }
  if (laneKey === "dsh") {
    injected.dsh = {
      submit: async (_step, resolved, access) => {
        nativeCalls.push({ step: _step, resolved });
        return { taskId: `c2c_dsh_${access.orchestratorKey}`, status: "running", outputIds: [1], verification: null };
      },
      get: async (taskId) => ({ taskId, status: "completed", outputIds: [1], verification: null }),
    };
  }
  const harness = laneHarness(Object.keys(injected).length ? injected : undefined);
  const plan = [{ ...baseStep, agent }];
  const run = await harness.core.create("run", "owner", plan);
  if (laneKey) {
    // Native lanes are injected seams; the codex executor must NOT be used.
    expect(harness.executor.submit).not.toHaveBeenCalled();
    expect(nativeCalls).toHaveLength(1);
    expect(String(nativeCalls[0]!.resolved.agent)).toBe(agent);
  } else if (agent === "codex") {
    expect(harness.executor.submit).toHaveBeenCalledTimes(1);
    expect(harness.submitCalls[0]!.input.provider).toBe("codex");
  } else {
    // antigravity → the manager's gemini lane (model-baked efforts: no effort field).
    expect(harness.executor.submit).toHaveBeenCalledTimes(1);
    expect(harness.submitCalls[0]!.input.provider).toBe("gemini");
    expect(harness.submitCalls[0]!.input.effort).toBeUndefined();
  }
  const taskId = run.taskId!;
  const view = laneKey
    ? null
    : (harness.tasks.get(taskId) as unknown as { status: string });
  if (view) view.status = "completed";
  await harness.core.recover();
  const after = harness.core.read("run", "owner");
  expect(after.state).toBe("WAITING_AUDIT");
  expect(after.audits).toHaveLength(1);
  expect(after.audits[0]!.type).toBe("audit.required");
  expect(after.audits[0]!.terminalStatus).toBe("completed");
});

it.each(["failed", "cancelled", "interrupted", "timed_out"] as const)("enters WAITING_AUDIT for native-lane terminal %s (audit covers every terminal state)", async (status) => {
  const harness = laneHarness({
    zcode: {
      submit: async (_s, _r, access) => ({ taskId: `z2c_${access.orchestratorKey}`, status: "running", outputIds: [], verification: null }),
      get: async (taskId) => ({ taskId, status, outputIds: [], error: { code: "X", message: "boom" }, verification: null }),
    },
  });
  await harness.core.create("run", "owner", [{ ...baseStep, agent: "zcode" }]);
  await harness.core.recover();
  const run = harness.core.read("run", "owner");
  expect(run.state).toBe("WAITING_AUDIT");
  expect(run.audits).toHaveLength(1);
  expect(run.audits[0]!.terminalStatus).toBe(status);
  expect(run.audits[0]!.passBlockers!.join(",")).toContain(`terminal:${status}`);
});

it("REWORK re-dispatches the SAME step through the SAME agent lane (no bypass)", async () => {
  const harness = laneHarness({
    zcode: {
      submit: async (_s, _r, access) => {
        return { taskId: `z2c_${access.orchestratorKey}`, status: "running", outputIds: [], verification: null };
      },
      get: async (taskId) => ({ taskId, status: "completed", outputIds: [], verification: { status: "failed", exitCode: 1 }, error: { code: "X", message: "boom" } }),
    },
  });
  await harness.core.create("run", "owner", [{ ...baseStep, agent: "zcode" }]);
  await harness.core.recover();
  const run = harness.core.read("run", "owner");
  const id = run.audits[0]!.id;
  await harness.core.claim("run", "owner", id, "reviewer");
  await harness.core.submitAudit("run", "owner", id, "reviewer", "REWORK");
  // After REWORK the run re-dispatches step 0 attempt 2 through the SAME
  // zcode lane (never a direct submit, never another agent).
  await harness.core.recover();
  const reworked = harness.core.read("run", "owner");
  expect(reworked).toMatchObject({ step: 0, attempt: 2, state: "WAITING_AUDIT" });
  expect(reworked.taskId).toContain("z2c_run:0:2");
  expect(reworked.audits.at(-1)!.id).toBe("run:0:2");
});

it("PASS advances to the next step and BLOCKED stops the run (native lane)", async () => {
  let attempt = 0;
  const harness = laneHarness({
    zcode: {
      submit: async (_s, _r, access) => ({ taskId: `z2c_${access.orchestratorKey}`, status: "running", outputIds: [], verification: null }),
      get: async (taskId) => ({ taskId, status: "completed", outputIds: [], verification: null }),
    },
  });
  await harness.core.create("run", "owner", [
    { ...baseStep, agent: "zcode" },
    { ...baseStep, instruction: "Second", agent: "zcode" },
  ]);
  await harness.core.recover();
  attempt += 1;
  const a = harness.core.read("run", "owner").audits[0]!.id;
  await harness.core.claim("run", "owner", a, "r");
  await harness.core.submitAudit("run", "owner", a, "r", "PASS");
  // PASS advances to step 1; the fake lane completes it immediately.
  await harness.core.recover();
  expect(harness.core.read("run", "owner")).toMatchObject({ step: 1, attempt: 1, state: "WAITING_AUDIT" });
  const b = harness.core.read("run", "owner").audits.at(-1)!.id;
  expect(b).toBe("run:1:1");
  await harness.core.claim("run", "owner", b, "r");
  await harness.core.submitAudit("run", "owner", b, "r", "BLOCKED");
  expect(harness.core.read("run", "owner").state).toBe("BLOCKED");
});

it("an agent with NO wired lane fails loudly instead of substituting another provider", async () => {
  const harness = laneHarness();
  await expect(harness.core.create("run", "owner", [{ ...baseStep, agent: "zcode" }]))
    .rejects.toThrow(/No execution lane is wired for agent/);
  expect(harness.executor.submit).not.toHaveBeenCalled();
});
