import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchPolicyStatus, pauseProductDispatch, productDispatchPaused, resumeProductDispatch } from "../src/config/dispatch-policy.js";
import { startBridge } from "../src/bridge/server.js";
import { readWorkspaceQueuePauseState, writeWorkspaceQueuePauseState } from "../src/execution/queue-state.js";
import { cleanup, makeTmpDir } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";

const dirs: string[] = [];
function directory() { const dir = makeTmpDir("dispatch-policy"); dirs.push(dir); return dir; }
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) cleanup(dir); });
describe("operator global dispatch policy", () => {
  it("preserves missing-policy default and fails closed for malformed/unknown policy", () => {
    vi.stubEnv("PRODUCT_TASK_DISPATCH_PAUSED", ""); const dir = directory();
    expect(dispatchPolicyStatus(dir)).toMatchObject({ effectivePaused: false, stateFile: { state: "MISSING" } });
    for (const bytes of ["invalid", "null", '{"schema":2,"productTaskDispatchPaused":false}', '{"schema":1}']) {
      fs.writeFileSync(path.join(dir, "dispatch-policy.json"), bytes);
      expect(dispatchPolicyStatus(dir)).toMatchObject({ effectivePaused: true, stateFile: { state: "INVALID" } });
      expect(fs.readFileSync(path.join(dir, "dispatch-policy.json"), "utf8")).toBe(bytes);
    }
  });
  it("pauses and atomically resumes idempotently without touching queues/tasks/continuation", () => {
    vi.stubEnv("PRODUCT_TASK_DISPATCH_PAUSED", ""); const dir = directory();
    fs.mkdirSync(path.join(dir, "continuations")); fs.writeFileSync(path.join(dir, "continuations", "historical.json"), "old evidence");
    pauseProductDispatch(dir); expect(productDispatchPaused(dir)).toBe(true);
    resumeProductDispatch(dir); expect(productDispatchPaused(dir)).toBe(false);
    const bytes = fs.readFileSync(path.join(dir, "dispatch-policy.json"), "utf8");
    expect(JSON.parse(bytes)).toMatchObject({ schema: 1, productTaskDispatchPaused: false, updatedAt: expect.any(String) });
    resumeProductDispatch(dir); expect(fs.readFileSync(path.join(dir, "dispatch-policy.json"), "utf8")).toBe(bytes);
    expect(fs.readdirSync(dir).sort()).toEqual(["continuations", "dispatch-policy.json"]);
    expect(fs.readFileSync(path.join(dir, "continuations", "historical.json"), "utf8")).toBe("old evidence");
  });
  it("keeps environment true effective even after persisted resume", () => {
    vi.stubEnv("PRODUCT_TASK_DISPATCH_PAUSED", "true"); const dir = directory(); resumeProductDispatch(dir);
    expect(dispatchPolicyStatus(dir)).toMatchObject({ effectivePaused: true, stateFile: { productTaskDispatchPaused: false }, envOverride: { active: true } });
  });
  it("releases an unpaused workspace but preserves a manual workspace pause", () => {
    vi.stubEnv("PRODUCT_TASK_DISPATCH_PAUSED", ""); const dir = directory();
    writeWorkspaceQueuePauseState("workspace", false, dir); pauseProductDispatch(dir);
    expect(readWorkspaceQueuePauseState("workspace", dir)).toMatchObject({ paused: true, reason: "control_plane" });
    resumeProductDispatch(dir); expect(readWorkspaceQueuePauseState("workspace", dir)).toMatchObject({ paused: false, reason: "manual" });
    writeWorkspaceQueuePauseState("workspace", true, dir); resumeProductDispatch(dir);
    expect(readWorkspaceQueuePauseState("workspace", dir).paused).toBe(true);
  });
  it("protects status/pause/resume with existing admin gate and exposes effective state", async () => {
    vi.stubEnv("PRODUCT_TASK_DISPATCH_PAUSED", ""); const dir = directory(), root = directory();
    const bridge = await startBridge({ workspaceRoot: root, stateDir: dir, port: 0, persistRuntime: false, zcodeCoordinator: false });
    const url = `${bridge.localBaseUrl()}/admin/dispatch-policy`;
    const headers = { authorization: `Bearer ${bridge.adminToken}`, "Content-Type": "application/json" };
    const taskFilesBefore = fs.readdirSync(path.join(dir, "tasks"), { recursive: true });
    try {
      expect((await fetch(url)).status).toBe(404);
      expect((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resume" }) })).status).toBe(404);
      expect((await fetch(url, { headers })).status).toBe(200);
      for (const [action, paused] of [["pause", true], ["resume", false], ["resume", false]] as const) {
        const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ action }) });
        expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ok: true, effectivePaused: paused, stateFile: { productTaskDispatchPaused: paused } });
        expect(bridge.taskManagers.get(new Workspace(root).id).getQueueState()).toMatchObject({
          paused, state: paused ? "paused" : "running", queuedTaskCount: 0, activeTask: null, activeWriter: null,
        });
      }
      const status = await fetch(url, { headers }); expect(await status.json()).toMatchObject({ effectivePaused: false });
      expect(fs.readdirSync(path.join(dir, "tasks"), { recursive: true })).toEqual(taskFilesBefore);
      vi.stubEnv("PRODUCT_TASK_DISPATCH_PAUSED", "true");
      const blocked = await fetch(url, { method: "POST", headers, body: JSON.stringify({ action: "resume" }) });
      expect(blocked.status).toBe(409); expect(await blocked.json()).toMatchObject({ ok: false, error_code: "ENV_OVERRIDE_ACTIVE", effectivePaused: true, stateFile: { productTaskDispatchPaused: false }, restartRequired: true });
      expect((await fetch(url, { method: "POST", headers: { ...headers, "X-Forwarded-For": "127.0.0.1" }, body: JSON.stringify({ action: "resume" }) })).status).toBe(404);
      expect((await fetch(url, { method: "POST", headers, body: JSON.stringify({ action: "invalid" }) })).status).toBe(400);
    } finally { await bridge.close(); }
  });
});
