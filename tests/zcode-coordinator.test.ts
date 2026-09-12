/**
 * Deterministic tests for the C2C-owned ZCode free-window coordinator.
 *
 * Everything runs against an isolated temporary queue root with a scripted
 * in-memory native lane; no real Z2C or Desktop session is touched.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ZcodeControl,
  ZcodeCoordinatorStore,
  describeControlPlane,
} from "../src/execution/zcode-control.js";
import { startBridge } from "../src/bridge/server.js";
import {
  ZcodeCoordinator,
  coordinatorTasksConflict,
  parseCoordinatorWindows,
  resetZcodeCoordinatorsForTests,
  resolveCoordinatorWorkspaceId,
  startZcodeCoordinator,
  withinCoordinatorWindows,
  type ZcodeCoordinatorNative,
} from "../src/execution/zcode-coordinator.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import { cleanup, makeTmpDir } from "./helpers.js";

interface FakeNativeTask {
  task_id: string;
  workspace_id: string;
  session_id: string;
  status: string;
  exit_status: string | null;
  model_binding: { provider_id: string; model_id: string };
  instruction: string;
  idempotency_key?: string;
}

/** Scripted native lane: tasks are keyed by the coordinator's idempotency key. */
function makeFakeNative(workspaceId: string, options: { available?: boolean; provider?: string; attested?: boolean } = {}) {
  const tasks = new Map<string, FakeNativeTask>();
  let counter = 0;
  const available = options.available ?? true;
  const attested = options.attested ?? true;
  const provider = options.provider ?? "zcode-desktop";
  const native: ZcodeCoordinatorNative & { tasks: Map<string, FakeNativeTask>; submitKeys: string[] } = {
    tasks,
    submitKeys: [],
    async status(id) {
      if (!available) throw new Error("native control plane unreachable");
      return {
        available,
        provider: { name: provider },
        start_plan: {
          attested,
          provider_id: attested ? "builtin:zai-start-plan" : "UNKNOWN",
          model_id: attested ? "GLM-5.3-Flash" : "UNKNOWN",
          mismatches: attested ? [] : ["model_binding unobserved"],
        },
        ...(id ? {} : {}),
      };
    },
    async submitTask(input) {
      native.submitKeys.push(input.idempotency_key ?? "");
      const existing = input.idempotency_key ? tasks.get(input.idempotency_key) : undefined;
      if (existing) return existing; // durable idempotency replay
      counter += 1;
      const task: FakeNativeTask = {
        task_id: `z2c_fake_${counter}`,
        workspace_id: input.workspace_id,
        session_id: `sess_00000000-0000-0000-0000-${String(counter).padStart(12, "0")}`,
        status: "running",
        exit_status: null,
        model_binding: { provider_id: "builtin:zai-start-plan", model_id: "GLM-5.3-Flash" },
        instruction: input.instruction,
        idempotency_key: input.idempotency_key,
      };
      if (input.idempotency_key) tasks.set(input.idempotency_key, task);
      return task;
    },
    async getTask(input) {
      for (const task of tasks.values()) {
        if (task.task_id === input.task_id) {
          return {
            task_id: task.task_id,
            status: task.status,
            exit_status: task.exit_status,
            model_binding: task.model_binding,
          };
        }
      }
      const error = new Error("Z2C tool error") as Error & { upstreamCode?: string };
      error.upstreamCode = "TASK_NOT_FOUND";
      throw error;
    },
    async cancelTask(input) {
      for (const task of tasks.values()) {
        if (task.task_id === input.task_id) task.status = "cancelled";
      }
      return { task_id: input.task_id, status: "cancelling" };
    },
  };
  return native;
}

function receipts(root: string): Array<Record<string, unknown>> {
  const file = path.join(root, "receipts.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

let root: string;
const createdDirs: string[] = [];
const createdCoordinators: ZcodeCoordinator[] = [];

beforeEach(() => {
  root = makeTmpDir("zcode-coordinator");
  createdDirs.push(root);
});

afterEach(async () => {
  for (const coordinator of createdCoordinators) {
    await coordinator.stop().catch(() => {});
  }
  createdCoordinators.length = 0;
  resetZcodeCoordinatorsForTests();
  for (const dir of createdDirs) cleanup(dir);
  createdDirs.length = 0;
});

function makeCoordinator(
  native: ReturnType<typeof makeFakeNative> | null,
  overrides: Record<string, unknown> = {}
): ZcodeCoordinator {
  const coordinator = new ZcodeCoordinator({
    queueRoot: root,
    workspaceId: "wskyc039abcd",
    native: native ?? null,
    ...(overrides as object),
  });
  createdCoordinators.push(coordinator);
  return coordinator;
}

async function enqueue(overrides: Record<string, unknown> = {}) {
  const control = new ZcodeControl(root);
  return control.enqueue({
    task_id: `task_${Math.random().toString(16).slice(2, 10)}`,
    role: "worker",
    priority: 0,
    instruction: "Scratch-safe deterministic change inside the authorized workspace.",
    ...overrides,
  } as never);
}

async function requestCancel(taskId: string) {
  return new ZcodeControl(root).requestCancel(taskId);
}

describe("zcode coordinator lifecycle", () => {
  it("claims a queued task, dispatches through the native lane, and writes START plus terminal receipts", async () => {
    const native = makeFakeNative("wskyc039abcd");
    const task = (await enqueue()) as { task_id: string };
    const coordinator = makeCoordinator(native, { pollMs: 1000 });

    await coordinator.runTick();
    expect(native.submitKeys).toEqual([task.task_id]);
    const view = new ZcodeControl(root).getTask(task.task_id);
    expect(view?.status).toBe("running");
    expect(view?.receipts.map((r) => r.event)).toEqual(["START"]);

    for (const entry of native.tasks.values()) entry.status = "completed";
    await coordinator.runTick();
    const done = new ZcodeControl(root).getTask(task.task_id);
    expect(done?.status).toBe("completed");
    expect(done?.receipts.map((r) => r.event)).toEqual(["START", "COMPLETED"]);
    expect(done?.receipts[1].model).toBe("GLM-5.3-Flash");
  });

  it("never claims when the native lane is unavailable and records the degraded layer", async () => {
    const native = makeFakeNative("wskyc039abcd", { available: false });
    await enqueue();
    const coordinator = makeCoordinator(native, { pollMs: 1000 });

    await coordinator.runTick();
    expect(native.submitKeys).toEqual([]);
    const state = describeControlPlane({ root });
    expect(state.level).toBe("ZCODE_DESKTOP_UNAVAILABLE");
    expect(state.coordinator.running).toBe(true);
  });

  it("records dispatch failures in the worker-state last_error field", async () => {
    const native = makeFakeNative("wskyc039abcd");
    native.submitTask = async () => {
      throw new Error("Z2C tool error: admission refused");
    };
    await enqueue();
    const coordinator = makeCoordinator(native, { pollMs: 1000 });

    await coordinator.runTick();
    const raw = new ZcodeCoordinatorStore(root).readRawWorkerState();
    expect(String(raw?.last_error)).toContain("admission refused");
    // The failed task stays queued for a bounded retry; nothing is forged.
    const view = new ZcodeControl(root).listTasks(10).tasks[0];
    expect(view.status).toBe("queued");
    expect(view.receipts).toEqual([]);
  });

  it("does not claim outside the configured window and claims inside it", async () => {
    const native = makeFakeNative("wskyc039abcd");
    await enqueue();
    let hour = 20;
    const coordinator = makeCoordinator(native, {
      windowSpec: "01:00-09:00",
      pollMs: 1000,
      now: () => new Date(2026, 8, 11, hour, 0, 0),
    });

    await coordinator.runTick();
    expect(native.submitKeys).toEqual([]);
    expect(describeControlPlane({ root, now: new Date(2026, 8, 11, 20, 0, 0) }).level).toBe("OUTSIDE_CLAIM_WINDOW");

    hour = 3;
    await coordinator.runTick();
    expect(native.submitKeys).toHaveLength(1);
  });

  it("honours CANCEL_REQUESTED for a queued task with a CANCELLED receipt and never dispatches it", async () => {
    const native = makeFakeNative("wskyc039abcd");
    const task = (await enqueue()) as { task_id: string };
    await requestCancel(task.task_id);
    const coordinator = makeCoordinator(native, { pollMs: 1000 });

    await coordinator.runTick();
    await coordinator.runTick();
    await coordinator.runTick();
    expect(native.submitKeys).toEqual([]);
    const view = new ZcodeControl(root).getTask(task.task_id);
    expect(view?.status).toBe("cancelled");
    expect(view?.receipts.map((r) => r.event)).toEqual(["CANCELLED"]);
  });

  it("forwards cancellation of a running task to the native lane and writes CANCELLED", async () => {
    const native = makeFakeNative("wskyc039abcd");
    const task = (await enqueue()) as { task_id: string };
    const coordinator = makeCoordinator(native, { pollMs: 1000 });
    await coordinator.runTick(); // dispatch → running

    await requestCancel(task.task_id);
    await coordinator.runTick(); // forwards cancel; native is now 'cancelled'
    await coordinator.runTick(); // observes terminal CANCELLED
    await coordinator.runTick(); // terminal state is idempotent
    const view = new ZcodeControl(root).getTask(task.task_id);
    expect(view?.status).toBe("cancelled");
    expect(view?.receipts.map((r) => r.event)).toEqual(["START", "CANCELLED"]);
  });

  it("writes exactly one CANCELLED receipt for a queued cancel, then stays idempotent over 10 further ticks", async () => {
    const native = makeFakeNative("wskyc039abcd");
    const task = (await enqueue()) as { task_id: string };
    await requestCancel(task.task_id);
    const coordinator = makeCoordinator(native, { pollMs: 1000 });

    await coordinator.runTick(); // writes the single CANCELLED terminal receipt
    expect(new ZcodeControl(root).getTask(task.task_id)?.receipts.map((r) => r.event)).toEqual(["CANCELLED"]);

    for (let i = 0; i < 10; i += 1) await coordinator.runTick();
    const view = new ZcodeControl(root).getTask(task.task_id);
    expect(view?.status).toBe("cancelled");
    expect(view?.receipts.map((r) => r.event)).toEqual(["CANCELLED"]);
    expect(native.submitKeys).toEqual([]);
  });

  it("never appends CANCELLED to a COMPLETED task carrying a stale CANCEL_REQUESTED", async () => {
    const native = makeFakeNative("wskyc039abcd");
    const task = (await enqueue()) as { task_id: string };
    const coordinator = makeCoordinator(native, { pollMs: 1000 });
    await coordinator.runTick(); // dispatch
    for (const entry of native.tasks.values()) entry.status = "completed";
    await coordinator.runTick(); // observes COMPLETED
    // A CANCEL_REQUESTED record that predates the terminal receipt is the
    // realistic "stale request" shape; write it directly (requestCancel
    // refuses terminal tasks).
    fs.appendFileSync(
      path.join(root, "control.jsonl"),
      JSON.stringify({ event: "CANCEL_REQUESTED", task_id: task.task_id, timestamp: new Date().toISOString() }) + "\n"
    );

    for (let i = 0; i < 10; i += 1) await coordinator.runTick();
    const view = new ZcodeControl(root).getTask(task.task_id);
    expect(view?.status).toBe("completed");
    expect(view?.receipts.map((r) => r.event)).toEqual(["START", "COMPLETED"]);
  });

  it("never appends CANCELLED to a FAILED task carrying a stale CANCEL_REQUESTED", async () => {
    const native = makeFakeNative("wskyc039abcd");
    const task = (await enqueue()) as { task_id: string };
    const coordinator = makeCoordinator(native, { pollMs: 1000 });
    await coordinator.runTick(); // dispatch
    for (const entry of native.tasks.values()) entry.status = "failed";
    await coordinator.runTick(); // observes FAILED
    fs.appendFileSync(
      path.join(root, "control.jsonl"),
      JSON.stringify({ event: "CANCEL_REQUESTED", task_id: task.task_id, timestamp: new Date().toISOString() }) + "\n"
    );

    for (let i = 0; i < 10; i += 1) await coordinator.runTick();
    const view = new ZcodeControl(root).getTask(task.task_id);
    expect(view?.status).toBe("failed");
    expect(view?.receipts.map((r) => r.event)).toEqual(["START", "FAILED"]);
  });

  it("respects depends_on: only claims when every dependency reached COMPLETED", async () => {
    const native = makeFakeNative("wskyc039abcd");
    const first = (await enqueue({ task_id: "dep_first_task" })) as { task_id: string };
    await enqueue({ task_id: "dep_second_task", depends_on: ["dep_first_task"] });
    const coordinator = makeCoordinator(native, { pollMs: 1000 });

    await coordinator.runTick();
    // Only the dependency-free task is claimed; the dependent stays queued.
    expect(native.submitKeys).toEqual(["dep_first_task"]);

    for (const entry of native.tasks.values()) entry.status = "completed";
    await coordinator.runTick();
    expect(first.task_id).toBe("dep_first_task");
    expect(native.submitKeys).toEqual(["dep_first_task", "dep_second_task"]);
    const second = new ZcodeControl(root).getTask("dep_second_task");
    expect(second?.status).toBe("running");
  });

  it("does not claim a second conflicting write task while one is active", async () => {
    const native = makeFakeNative("wskyc039abcd");
    await enqueue({ task_id: "conflict_a", mode: "write", resources: ["frontend"] });
    await enqueue({ task_id: "conflict_b", mode: "write", resources: ["frontend"] });
    const coordinator = makeCoordinator(native, { pollMs: 1000 });

    await coordinator.runTick();
    expect(native.submitKeys).toEqual(["conflict_a"]);
  });

  it("treats an undeclared write as globally exclusive and read tasks as non-conflicting", () => {
    expect(coordinatorTasksConflict(
      { mode: null, resources: [], exclusive_paths: [] },
      { mode: null, resources: [], exclusive_paths: [] }
    )).toBe(true);
    expect(coordinatorTasksConflict(
      { mode: "read", resources: [], exclusive_paths: [] },
      { mode: null, resources: [], exclusive_paths: [] }
    )).toBe(false);
    expect(coordinatorTasksConflict(
      { mode: "write", resources: ["a"], exclusive_paths: [] },
      { mode: "write", resources: ["b"], exclusive_paths: [] }
    )).toBe(false);
    expect(coordinatorTasksConflict(
      { mode: "write", resources: ["a"], exclusive_paths: ["src/**"] },
      { mode: "write", resources: ["b"], exclusive_paths: ["src/**"] }
    )).toBe(true);
  });

  it("recovers a START-less interrupted task by re-dispatching the same idempotency key", async () => {
    const native = makeFakeNative("wskyc039abcd");
    const task = (await enqueue()) as { task_id: string };
    const first = makeCoordinator(native, { pollMs: 1000 });
    await first.runTick();
    // Simulate a crash after dispatch but before the terminal receipt: the
    // native task exists, receipts hold only START.
    await first.stop();

    const second = makeCoordinator(native, { pollMs: 1000 });
    await second.runTick();
    // Exactly one native task exists for this key — the replay returned the
    // same task instead of executing twice.
    expect(native.submitKeys.filter((key) => key === task.task_id)).toHaveLength(2);
    expect([...native.tasks.values()]).toHaveLength(1);
    const view = new ZcodeControl(root).getTask(task.task_id);
    expect(view?.receipts.filter((r) => r.event === "START")).toHaveLength(1);
  });

  it("adopts an active task recorded in worker-state and finalizes it after restart", async () => {
    const native = makeFakeNative("wskyc039abcd");
    await enqueue({ task_id: "adopt_me_task" });
    const first = makeCoordinator(native, { pollMs: 1000 });
    await first.runTick();
    await first.stop();

    const nativeTask = [...native.tasks.values()][0];
    const second = makeCoordinator(native, { pollMs: 1000 });
    await second.runTick();
    for (const entry of native.tasks.values()) entry.status = "completed";
    await second.runTick();
    const view = new ZcodeControl(root).getTask("adopt_me_task");
    expect(view?.receipts.map((r) => r.event)).toEqual(["START", "COMPLETED"]);
    expect(nativeTask.task_id).toBeTruthy();
  });

  it("goes STANDBY while a foreign owner heartbeat is fresh, then takes over when stale", async () => {
    const native = makeFakeNative("wskyc039abcd");
    await enqueue();
    const store = new ZcodeCoordinatorStore(root);
    store.writeWorkerState({
      schema: "engai.c2c_zcode_worker_state",
      status: "running",
      owner: { pid: process.pid + 12345, started_at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    });

    const coordinator = makeCoordinator(native, { pollMs: 1000 });
    await coordinator.runTick();
    expect(coordinator.getStatus().standby).toBe(true);
    expect(native.submitKeys).toEqual([]);

    store.writeWorkerState({
      schema: "engai.c2c_zcode_worker_state",
      status: "running",
      owner: { pid: process.pid + 12345, started_at: new Date().toISOString() },
      updated_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    await coordinator.runTick();
    expect(coordinator.getStatus().standby).toBe(false);
    expect(native.submitKeys).toHaveLength(1);
  });

  it("duplicate start for the same queue root returns the live coordinator", () => {
    const first = startZcodeCoordinator({
      queueRoot: root,
      workspaceId: "wskyc039abcd",
      native: makeFakeNative("wskyc039abcd"),
      pollMs: 60_000,
    });
    const second = startZcodeCoordinator({
      queueRoot: root.toUpperCase(),
      workspaceId: "wskyc039abcd",
      native: makeFakeNative("wskyc039abcd"),
      pollMs: 60_000,
    });
    expect(second).toBe(first);
    createdCoordinators.push(first);
  });

  it("graceful stop writes a stopped heartbeat and releases ownership", async () => {
    const native = makeFakeNative("wskyc039abcd");
    await enqueue();
    const coordinator = makeCoordinator(native, { pollMs: 1000 });
    await coordinator.runTick();
    await coordinator.stop();

    const state = describeControlPlane({ root });
    expect(state.level).toBe("COORDINATOR_NOT_RUNNING");
    expect(state.coordinator.status).toBe("stopped");
  });

  it("fail-closed malformed receipts never crash the loop; terminal precedence stays deterministic", async () => {
    const native = makeFakeNative("wskyc039abcd");
    const task = (await enqueue()) as { task_id: string };
    // Malformed line appended directly to receipts.jsonl.
    fs.appendFileSync(path.join(root, "receipts.jsonl"), "{not json}\n", "utf8");
    const coordinator = makeCoordinator(native, { pollMs: 1000 });
    await coordinator.runTick();
    // The malformed truth file fails the whole read; nothing was claimed.
    expect(native.submitKeys).toEqual([]);
    // Repair the truth file; the loop proceeds deterministically.
    const raw = fs.readFileSync(path.join(root, "receipts.jsonl"), "utf8").split("\n").filter(Boolean);
    const kept = raw.filter((line) => line !== "{not json}");
    fs.writeFileSync(path.join(root, "receipts.jsonl"), kept.length > 0 ? kept.join("\n") + "\n" : "");
    await coordinator.runTick(); // dispatches now that the truth file parses
    for (const entry of native.tasks.values()) entry.status = "completed";
    await coordinator.runTick(); // observes the terminal receipt
    const view = new ZcodeControl(root).getTask(task.task_id);
    expect(view?.status).toBe("completed");
  });
});

describe("zcode coordinator window parsing", () => {
  it("parses lists of ranges and rejects malformed specs", () => {
    expect(parseCoordinatorWindows(undefined)).toBeNull();
    expect(parseCoordinatorWindows("01:00-09:30,22:00-23:59")).toEqual([
      { start: 60, end: 570 },
      { start: 1320, end: 1439 },
    ]);
    expect(() => parseCoordinatorWindows("25:00-26:00")).toThrow();
    expect(() => parseCoordinatorWindows("09:00-09:00")).toThrow();
    expect(() => parseCoordinatorWindows("tomorrow")).toThrow();
  });

  it("evaluates membership including overnight ranges", () => {
    const overnight = parseCoordinatorWindows("22:00-06:00");
    expect(withinCoordinatorWindows(overnight, new Date(2026, 8, 11, 23, 30))).toBe(true);
    expect(withinCoordinatorWindows(overnight, new Date(2026, 8, 11, 3, 0))).toBe(true);
    expect(withinCoordinatorWindows(overnight, new Date(2026, 8, 11, 12, 0))).toBe(false);
    expect(withinCoordinatorWindows(null, new Date(2026, 8, 11, 12, 0))).toBe(true);
  });
});

describe("zcode coordinator workspace mapping", () => {
  it("maps the queue root to the enabled workspace containing it", () => {
    const stateDir = makeTmpDir("zcode-coord-registry");
    createdDirs.push(stateDir);
    const registry = new WorkspaceRegistry({ initial: [
      { id: "aaaaaaaaaaaa", name: "somewhere-else", canonicalPath: makeTmpDir("zcode-other-ws"), enabled: true },
      { id: "bbbbbbbbbbbb", name: "authorized-root", canonicalPath: path.resolve(root, ".."), enabled: true },
    ]});
    createdDirs.pop();
    // root sits inside bbbbbbbbbbbb → that entry wins.
    expect(resolveCoordinatorWorkspaceId(root, registry)).toBe("bbbbbbbbbbbb");
  });

  it("returns null when no authorized workspace contains the queue root", () => {
    const registry = new WorkspaceRegistry({ initial: [] });
    expect(resolveCoordinatorWorkspaceId(root, registry)).toBeNull();
  });
});

describe("zcode coordinator bridge lifecycle", () => {
  it("starts with the bridge, claims nothing while the lane is down, and stops with it", async () => {
    const wsRoot = makeTmpDir("zcode-bridge-ws");
    createdDirs.push(wsRoot);
    const queueRoot = path.join(wsRoot, "var", "c2c-zcode");
    fs.mkdirSync(queueRoot, { recursive: true });
    const authDir = makeTmpDir("zcode-bridge-auth");
    createdDirs.push(authDir);
    const previous = {
      queue: process.env.C2C_ZCODE_QUEUE_ROOT,
      nativeUrl: process.env.ZCODE_NATIVE_URL,
      nativeToken: process.env.ZCODE_NATIVE_TOKEN,
      disable: process.env.C2C_ZCODE_COORDINATOR_DISABLE,
    };
    process.env.C2C_ZCODE_QUEUE_ROOT = queueRoot;
    // Deterministically dead loopback endpoint: the adapter must degrade, not crash.
    process.env.ZCODE_NATIVE_URL = "http://127.0.0.1:1/mcp";
    delete process.env.ZCODE_NATIVE_TOKEN;
    delete process.env.C2C_ZCODE_COORDINATOR_DISABLE;
    let bridge: Awaited<ReturnType<typeof startBridge>> | null = null;
    try {
      bridge = await startBridge({
        workspaceRoot: wsRoot,
        port: 0,
        persistRuntime: false,
        authStoreFile: path.join(authDir, "store.json"),
        zcodeCoordinator: true,
      });
      expect(bridge.zcodeCoordinator).toBeTruthy();

      const control = new ZcodeControl(queueRoot);
      const task = (await control.enqueue({
        role: "worker",
        priority: 0,
        instruction: "Bridge lifecycle probe task.",
      })) as { task_id: string };
      await bridge.zcodeCoordinator!.runTick();
      // The dead native lane means no dispatch, but the coordinator is live.
      expect(control.getTask(task.task_id)?.status).toBe("queued");
      const live = describeControlPlane({ root: queueRoot });
      expect(live.coordinator.running).toBe(true);
      expect(live.level).toBe("ZCODE_DESKTOP_UNAVAILABLE");

      await bridge.close();
      bridge = null;
      const after = describeControlPlane({ root: queueRoot });
      expect(after.level).toBe("COORDINATOR_NOT_RUNNING");
    } finally {
      if (bridge) await bridge.close().catch(() => {});
      if (previous.queue === undefined) delete process.env.C2C_ZCODE_QUEUE_ROOT;
      else process.env.C2C_ZCODE_QUEUE_ROOT = previous.queue;
      if (previous.nativeUrl === undefined) delete process.env.ZCODE_NATIVE_URL;
      else process.env.ZCODE_NATIVE_URL = previous.nativeUrl;
      if (previous.nativeToken === undefined) delete process.env.ZCODE_NATIVE_TOKEN;
      else process.env.ZCODE_NATIVE_TOKEN = previous.nativeToken;
      if (previous.disable === undefined) delete process.env.C2C_ZCODE_COORDINATOR_DISABLE;
      else process.env.C2C_ZCODE_COORDINATOR_DISABLE = previous.disable;
    }
  });

  it("stays disabled when C2C_ZCODE_COORDINATOR_DISABLE is set", async () => {
    const wsRoot = makeTmpDir("zcode-bridge-ws-off");
    createdDirs.push(wsRoot);
    const queueRoot = path.join(wsRoot, "var", "c2c-zcode");
    fs.mkdirSync(queueRoot, { recursive: true });
    const authDir = makeTmpDir("zcode-bridge-auth-off");
    createdDirs.push(authDir);
    const previous = process.env.C2C_ZCODE_COORDINATOR_DISABLE;
    process.env.C2C_ZCODE_COORDINATOR_DISABLE = "1";
    let bridge: Awaited<ReturnType<typeof startBridge>> | null = null;
    try {
      bridge = await startBridge({
        workspaceRoot: wsRoot,
        port: 0,
        persistRuntime: false,
        authStoreFile: path.join(authDir, "store.json"),
        zcodeCoordinator: true,
      });
      expect(bridge.zcodeCoordinator).toBeUndefined();
    } finally {
      if (bridge) await bridge.close().catch(() => {});
      if (previous === undefined) delete process.env.C2C_ZCODE_COORDINATOR_DISABLE;
      else process.env.C2C_ZCODE_COORDINATOR_DISABLE = previous;
    }
  });
});

describe("control plane status layers", () => {
  it("reports QUEUE_ROOT_MISSING when nothing is configured", () => {
    const missingRoot = path.join(makeTmpDir("zcode-missing-base"), "does-not-exist");
    createdDirs.push(path.dirname(missingRoot));
    const status = describeControlPlane({ root: missingRoot, registry: new WorkspaceRegistry({ initial: [] }) });
    expect(status.level).toBe("QUEUE_ROOT_MISSING");
    expect(status.queue_root).toBe("MISSING");
  });

  it("reports the attested READY state from a fresh healthy worker-state", () => {
    const store = new ZcodeCoordinatorStore(root);
    store.writeWorkerState({
      schema: "engai.c2c_zcode_worker_state",
      status: "idle",
      owner: { pid: process.pid, started_at: new Date().toISOString() },
      within_window: true,
      max_parallel: 1,
      active: [],
      native: {
        available: true,
        provider: "zcode-desktop",
        model: "GLM-5.3",
        attested: true,
        observed_at: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    });
    const status = describeControlPlane({ root });
    expect(status.level).toBe("READY");
    expect(status.native.attested).toBe(true);
    expect(status.workspace_binding).toBe("OK");
  });

  it("distinguishes WRONG_PROVIDER from AUTH_NOT_ATTESTED", () => {
    const store = new ZcodeCoordinatorStore(root);
    store.writeWorkerState({
      status: "idle",
      owner: { pid: process.pid, started_at: new Date().toISOString() },
      within_window: true,
      native: { available: true, provider: "some-other-provider", model: "GLM-5.3", attested: false, observed_at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    });
    expect(describeControlPlane({ root }).level).toBe("WRONG_PROVIDER");

    store.writeWorkerState({
      status: "idle",
      owner: { pid: process.pid, started_at: new Date().toISOString() },
      within_window: true,
      native: { available: true, provider: "zcode-desktop", model: "UNKNOWN", attested: false, observed_at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    });
    expect(describeControlPlane({ root }).level).toBe("AUTH_NOT_ATTESTED");
  });

  it("reports WORKSPACE_BINDING_FAILED on a recorded namespace mismatch", () => {
    const store = new ZcodeCoordinatorStore(root);
    store.writeWorkerState({
      status: "running",
      owner: { pid: process.pid, started_at: new Date().toISOString() },
      within_window: true,
      native: { available: true, provider: "zcode-desktop", model: "GLM-5.3", attested: true, observed_at: new Date().toISOString(), namespace_mismatch: true },
      updated_at: new Date().toISOString(),
    });
    const status = describeControlPlane({ root });
    expect(status.level).toBe("WORKSPACE_BINDING_FAILED");
    expect(status.workspace_binding).toBe("FAILED");
  });

  it("sanitizes the bounded worker-state view and never leaks raw errors", async () => {
    const native = makeFakeNative("wskyc039abcd", { available: false });
    const coordinator = makeCoordinator(native, { pollMs: 1000 });
    await coordinator.runTick();
    const control = new ZcodeControl(root);
    const listing = control.listTasks(50);
    expect(listing.worker_state).not.toBeNull();
    expect(JSON.stringify(listing)).not.toMatch(/[A-Za-z]:\\\\?[Uu]sers/);
  });
});
