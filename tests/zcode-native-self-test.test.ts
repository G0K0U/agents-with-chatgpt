import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { nativeSelfTest, type NativeSelfTestDeps } from "../src/execution/zcode-native-self-test.js";
import { nativeRequestFingerprint, ZcodeNativeError, type ZcodeNativeTaskView } from "../src/execution/zcode-native.js";
import { registerZcodeNativeTools } from "../src/mcp/zcode-native-tools.js";
import { CodexTaskManager } from "../src/execution/tasks.js";
import { Workspace } from "../src/workspace/manager.js";
import { acquireWorkspaceSlot, readWorkspaceSlot, workspaceSlotFile } from "../src/execution/slot.js";
import { makeTmpDir, cleanup } from "./helpers.js";

describe("daemon-owned native protocol self-test", () => {
  let deps: NativeSelfTestDeps, tasks: Map<string, ZcodeNativeTaskView>, requests: unknown[];
  const workspace = "9f8e7d6c5b4a", secret = "TOKEN-NEVER-RELEASE-123456";
  beforeEach(() => {
    tasks = new Map(); requests = [];
    deps = {
      providerStatus: vi.fn(async () => ({ workspace_id: workspace, durable_idempotency: "workspace-task-v1" })),
      snapshot: vi.fn(() => ({ queue: "a".repeat(64), writer: "b".repeat(64) })),
      submitNative: vi.fn(async input => {
        requests.push({ ...input });
        const fingerprint = nativeRequestFingerprint(input);
        const previous = tasks.get(input.idempotency_key!);
        if (previous) {
          if (previous.idempotency!.request_fingerprint !== fingerprint) throw new ZcodeNativeError("ZCODE_NATIVE_UPSTREAM", secret, "IDEMPOTENCY_CONFLICT");
          return { ...previous, idempotency: { ...previous.idempotency!, replayed: true } };
        }
        const task: ZcodeNativeTaskView = { workspace_id: input.workspace_id, task_id: `z2c_${randomUUID()}`, session_id: `sess_${randomUUID()}`,
          status: "queued", model_binding: { provider_id: "builtin:zai-start-plan", model_id: "GLM-5.3-Flash" },
          idempotency: { protocol: "workspace-task-v1", key: input.idempotency_key!, request_fingerprint: fingerprint, replayed: false } };
        tasks.set(input.idempotency_key!, task); return task;
      }),
      cancel: vi.fn(async () => ({ ...[...tasks.values()][0]!, status: "cancelled" })),
    };
  });
  afterEach(() => vi.restoreAllMocks());
  it("admits exactly one readonly plan task; proves replay, specific conflict, and one identity", async () => {
    const result = await nativeSelfTest(workspace, deps);
    expect(result).toMatchObject({ overall: "PASS", protocol: "workspace-task-v1", replay_flags: [false, true], conflict_code: "IDEMPOTENCY_CONFLICT",
      cleanup: "cancelled", invariants: { queue_unchanged: true, writer_unchanged: true } });
    expect(tasks.size).toBe(1); expect(requests).toHaveLength(3);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]).toMatchObject({ write_scope: "readonly", mode: "plan", idempotency_key: expect.stringMatching(/^c2c_selftest_/) });
    expect(result.fingerprint_hashes.original).not.toBe(result.fingerprint_hashes.changed);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("idempotency_key");
    const firstKey = [...tasks.keys()][0];
    await nativeSelfTest(workspace, deps);
    expect([...tasks.keys()][1]).not.toBe(firstKey);
  });
  it.each([
    { workspace_id: workspace }, { workspace_id: "wrong", durable_idempotency: "workspace-task-v1" },
    { workspace_id: workspace, durable_idempotency: "legacy" },
  ])("blocks incompatible or mismatched protocol before submitting: %j", async status => {
    deps.providerStatus = vi.fn(async () => status);
    expect((await nativeSelfTest(workspace, deps)).overall).toBe("FAIL");
    expect(deps.submitNative).not.toHaveBeenCalled(); expect(deps.cancel).not.toHaveBeenCalled();
  });
  it.each(["workspace", "binding", "first_replayed", "replay_task", "replay_session", "replay_fingerprint", "replay_flag", "proof_missing"])("fails closed for %s", async fault => {
    const submit = deps.submitNative; let calls = 0;
    deps.submitNative = async input => {
      const result = structuredClone(await submit(input)); calls++;
      if (fault === "workspace") result.workspace_id = "wrong";
      if (fault === "binding") result.model_binding!.model_id = secret;
      if (fault === "first_replayed") result.idempotency!.replayed = true;
      if (fault === "proof_missing") delete result.idempotency;
      if (calls === 2) {
        if (fault === "replay_task") result.task_id = `z2c_${randomUUID()}`;
        if (fault === "replay_session") result.session_id = `sess_${randomUUID()}`;
        if (fault === "replay_fingerprint") result.idempotency!.request_fingerprint = "0".repeat(64);
        if (fault === "replay_flag") result.idempotency!.replayed = false;
      }
      return result;
    };
    const result = await nativeSelfTest(workspace, deps);
    expect(result.overall).toBe("FAIL"); expect(JSON.stringify(result)).not.toContain(secret);
  });
  it.each(["accepted", "wrong_error", "raw_error"])("never mistakes %s for an idempotency conflict", async fault => {
    const submit = deps.submitNative; let calls = 0;
    deps.submitNative = async input => {
      if (++calls === 3) {
        if (fault === "accepted") return [...tasks.values()][0]!;
        if (fault === "wrong_error") throw new ZcodeNativeError("ZCODE_NATIVE_UPSTREAM", secret, "OTHER_CONFLICT");
        throw new Error(`IDEMPOTENCY_CONFLICT ${secret}`);
      }
      return submit(input);
    };
    const result = await nativeSelfTest(workspace, deps);
    expect(result.overall).toBe("FAIL"); expect(result.conflict_code).toBeNull();
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it.each(["queue", "writer"] as const)("detects %s mutation even if later restored", async field => {
    let snapshots = 0;
    deps.snapshot = () => ({ queue: "a".repeat(64), writer: "b".repeat(64), ...(snapshots++ === 1 ? { [field]: "c".repeat(64) } : {}) });
    expect((await nativeSelfTest(workspace, deps)).overall).toBe("FAIL");
  });
  it("cleanup failure stays separate from protocol success; cannot erase a protocol failure", async () => {
    deps.cancel = vi.fn(async () => { throw new Error(`Bearer ${secret}`); });
    expect(await nativeSelfTest(workspace, deps)).toMatchObject({ overall: "PASS", cleanup: "failed" });
    deps.submitNative = vi.fn(async () => { throw new Error(secret); });
    const failed = await nativeSelfTest(workspace, deps);
    expect(failed).toMatchObject({ overall: "FAIL", cleanup: "unknown_admission" });
    expect(JSON.stringify(failed)).not.toContain(secret);
  });
  it("an unavailable invariant snapshot cannot be hidden by later successful cleanup", async () => {
    let reads = 0;
    deps.snapshot = () => {
      if (++reads === 4) throw new Error(secret);
      return { queue: "a".repeat(64), writer: "b".repeat(64) };
    };
    expect(await nativeSelfTest(workspace, deps)).toMatchObject({ overall: "FAIL", cleanup: "cancelled" });
  });
  it("does not cancel without an already-authorized cancel capability", async () => {
    delete deps.cancel;
    expect(await nativeSelfTest(workspace, deps)).toMatchObject({ overall: "PASS", cleanup: "not_authorized" });
  });
  it("real manager leaves an occupied writer slot and local task queue unchanged", async () => {
    const base = makeTmpDir(), root = path.join(base, "workspace"), state = path.join(base, "state"); fs.mkdirSync(root);
    const ws = new Workspace(root);
    const manager = new CodexTaskManager(ws, { stateDir: state, nativeClient: {
      submitTask: async (input, before) => { before?.(); return deps.submitNative(input); },
      cancelTask: async input => deps.cancel!(input),
    } as never });
    try {
      acquireWorkspaceSlot(ws.id, `c2c_${"a".repeat(16)}`, state, "gemini");
      const held = readWorkspaceSlot(ws.id, state), before = manager.nativeAdmissionSnapshot();
      const result = await nativeSelfTest(ws.id, { providerStatus: async () => ({ workspace_id: ws.id, durable_idempotency: "workspace-task-v1" }),
        submitNative: input => manager.submitNative(input), snapshot: () => manager.nativeAdmissionSnapshot(),
        cancel: input => manager.cancelNative(input, true) });
      expect(result.overall).toBe("PASS"); expect(tasks.size).toBe(1);
      expect(manager.nativeAdmissionSnapshot()).toEqual(before); expect(readWorkspaceSlot(ws.id, state)).toEqual(held);
      expect(manager.list()).toEqual([]);
      fs.writeFileSync(workspaceSlotFile(ws.id, state), "{}");
      expect(() => manager.nativeAdmissionSnapshot()).toThrow(/invalid writer slot/);
    } finally { await manager.close(); cleanup(base); }
  });
  it.each(["no_auth", "no_submit", "workspace_denied"])("MCP authorization %s prevents all upstream access and returns no raw errors", async fault => {
    const server = new McpServer({ name: "fixture", version: "1" });
    const upstream = vi.fn();
    registerZcodeNativeTools(server, {
      requireScope: (_auth, scope) => fault === "no_submit" && scope === "execution.submit" ? { content: [{ type: "text", text: secret }] } : null,
      resolveWorkspace: () => { if (fault === "workspace_denied") throw new Error(secret); },
      taskGate: upstream, writerManagerFor: upstream, nativeAdmissionSnapshot: upstream,
      ok: data => ({ content: [{ type: "text", text: JSON.stringify(data) }] }), fail: upstream, mapError: upstream, untrustedNote: "",
    });
    const tool = (server as any)._registeredTools.zcode_native_self_test;
    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(Object.keys(tool.inputSchema.shape)).toEqual(["workspace_id"]);
    const result = await tool.handler({ workspace_id: workspace }, { authInfo: fault === "no_auth" ? undefined : { scopes: ["execution.submit"] } });
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain(secret); expect(upstream).not.toHaveBeenCalled();
    await server.close();
  });
});
