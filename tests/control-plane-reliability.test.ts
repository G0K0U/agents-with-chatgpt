import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, cleanup, write } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import { ControlPlaneLifecycle } from "../src/bridge/control-plane.js";
import { ControlPlaneError, safeCause } from "../src/bridge/control-plane-error.js";
import { ZcodeSessionError, type ZcodeSessionClient } from "../src/execution/zcode-session-client.js";
import { pauseProductDispatch, productDispatchPaused } from "../src/config/dispatch-policy.js";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(cleanup));
function fixture() {
  const root = makeTmpDir("control-repair"); dirs.push(root); write(root, "package.json", "{}");
  const stateDir = makeTmpDir("control-repair-state"); dirs.push(stateDir);
  const workspace = new Workspace(root);
  const registry = new WorkspaceRegistry({ initial: [{ id: workspace.id, name: "test", canonicalPath: root, enabled: true, createdAt: new Date().toISOString() }] });
  const sessions = new Map<string, any>(); let serial = 0;
  const client = {
    runtimeCapabilities: vi.fn(async () => ({ z2c_protocol_version: 1, provider_status: "healthy" })),
    ensureGrant: vi.fn(async () => ({ workspace_id: "ws_test" })), workspaceList: vi.fn(async () => ({ workspaces: [] })),
    createSession: vi.fn(async (args: any) => {
      const s = { workspace_id: args.workspace_id, session_id: `sess_test${++serial}`, provider_id: "account:zai-coding-plan", model_id: "live-model", thought_level: "live-effort", plan_enabled: true, entitlement: { requested: args.entitlement_plan, observed: args.entitlement_plan, source: "provider-registry" } };
      Object.assign(s, { available_models: [{ provider_id: s.provider_id, model_id: s.model_id, reasoning_levels: [s.thought_level] }] });
      sessions.set(s.session_id, s); return s;
    }), readSession: vi.fn(async (args: any) => sessions.get(args.session_id)),
    modelCatalog: vi.fn(async () => ({ runtime_settings: { models: [{ provider_id: "account:zai-coding-plan", model_id: "live-model", reasoning_levels: ["live-effort"] }] } })),
    callTool: vi.fn(async (name: string, args: any) => name === "provider_status" ? { status: "healthy" } : sessions.get(args.session_id)), resetSession: vi.fn(), close: vi.fn(),
  };
  return { opts: { stateDir, workspace, registry, routeReady: async () => true, client: client as unknown as ZcodeSessionClient }, client };
}
describe("restart control-plane contract", () => {
  it("authenticated health reads stay READY after first route observation and reconcile on route recovery", async () => {
    const { opts, client } = fixture(); const cp = new ControlPlaneLifecycle(opts);
    await cp.authenticatedRouteObserved(100_000);
    expect(cp.snapshot().READY).toBe(true);
    const observations = client.runtimeCapabilities.mock.calls.length;
    for (const at of [100_001, 101_000, 130_000]) {
      await cp.authenticatedRouteObserved(at);
      expect(cp.snapshot()).toMatchObject({ READY: true, RECONCILING: false });
    }
    expect(client.runtimeCapabilities).toHaveBeenCalledTimes(observations);
    client.runtimeCapabilities.mockRejectedValueOnce(new Error("provider lost during route recovery"));
    await cp.authenticatedRouteObserved(220_000);
    expect(cp.snapshot()).toMatchObject({ READY: false, PROVIDER_STATE: "NOT_READY", LAST_RECONCILIATION_RESULT: "FAIL" });
    await cp.reconcile();
    expect(cp.snapshot().READY).toBe(true);
    expect(client.createSession).toHaveBeenCalledTimes(2);
    await cp.close();
  });
  it("retains timestamped provider observations during periodic reconciliation without claiming READY", async () => {
    const { opts, client } = fixture(); const cp = new ControlPlaneLifecycle(opts); await cp.reconcile();
    let finish!: (value: any) => void;
    const previous = await client.runtimeCapabilities();
    client.runtimeCapabilities.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = cp.reconcile();
    expect(cp.snapshot()).toMatchObject({ READY: false, READY_STATE: "RECONCILING", RECONCILING: true,
      RECONCILIATION_PHASE: "WAIT_PROVIDER", PROVIDER_STATE: "READY", NATIVE_SESSION_STATE: "READY", PROVIDER_OBSERVED_AT: expect.any(String) });
    finish(previous); await pending; expect(cp.snapshot()).toMatchObject({ READY: true, RECONCILING: false });
    client.runtimeCapabilities.mockRejectedValueOnce(new Error("provider lost")); await cp.reconcile();
    expect(cp.snapshot()).toMatchObject({ READY: false, PROVIDER_STATE: "NOT_READY", NATIVE_SESSION_STATE: "MISSING" }); await cp.close();
  });
  it("reconciles twice and across process generations without duplicate sessions or grants", async () => {
    const { opts, client } = fixture();
    const first = new ControlPlaneLifecycle({ ...opts, generation: "one" });
    await first.reconcile(); await first.reconcile(); await first.close();
    const second = new ControlPlaneLifecycle({ ...opts, generation: "two" }); await second.reconcile();
    expect(second.snapshot().READY).toBe(true); expect(client.createSession).toHaveBeenCalledTimes(2);
    expect(second.snapshot().GENERATION).toBe("two"); await second.close();
  });
  it("reattaches only existing owned diagnostic sessions after provider restart; sends no turn", async () => {
    const { opts, client } = fixture(); const first = new ControlPlaneLifecycle(opts); await first.reconcile(); await first.close();
    client.readSession.mockRejectedValue(new ZcodeSessionError("ZCODE_SESSION_UPSTREAM", "Session is not active", "SESSION_STALE"));
    const second = new ControlPlaneLifecycle(opts); await second.reconcile();
    expect(second.snapshot().READY).toBe(true); expect(client.createSession).toHaveBeenCalledTimes(2);
    expect(client.callTool.mock.calls.filter(c => c[0] === "zcode_session_resume")).toHaveLength(2);
    await second.close();
  });
  it("keeps health readable and preserves corrupt workspace registry bytes", async () => {
    const { opts, client } = fixture(); const file = write(opts.stateDir, "workspaces.json", "bad bytes");
    const cp = new ControlPlaneLifecycle({ ...opts, registryFailure: new ControlPlaneError("WORKSPACE_REGISTRY_UNAVAILABLE", "workspace_registry", "bridge") }); await cp.reconcile();
    expect(cp.snapshot()).toMatchObject({ READY: false, LAST_ERROR_CODE: "WORKSPACE_REGISTRY_UNAVAILABLE" });
    expect(fs.readFileSync(file, "utf8")).toBe("bad bytes"); expect(client.createSession).not.toHaveBeenCalled(); await cp.close();
  });
  it("fails closed on protocol skew before workspace/session mutation", async () => {
    const { opts, client } = fixture(); client.runtimeCapabilities.mockResolvedValue({ z2c_protocol_version: 9, provider_status: "healthy" });
    const cp = new ControlPlaneLifecycle(opts); await cp.reconcile(); expect(cp.snapshot().LAST_ERROR_CODE).toBe("VERSION_MISMATCH"); expect(client.ensureGrant).not.toHaveBeenCalled(); await cp.close();
  });
  it("never retries unknown session creation on another reconciliation", async () => {
    const { opts, client } = fixture(); client.createSession.mockRejectedValue(new ZcodeSessionError("ZCODE_SESSION_OUTCOME_UNKNOWN", "lost response"));
    const cp = new ControlPlaneLifecycle(opts); await cp.reconcile(); await cp.reconcile(); expect(client.createSession).toHaveBeenCalledTimes(1); expect(cp.snapshot().READY).toBe(false); await cp.close();
  });
  it("reports native version skew before registering workspaces or creating sessions", async () => {
    const { opts, client } = fixture();
    client.runtimeCapabilities.mockResolvedValue({ z2c_protocol_version: 1, provider_status: "incompatible", zcode_runtime_version: "0.17.0", expected_zcode_version: "0.16.x" } as any);
    const cp = new ControlPlaneLifecycle(opts); await cp.reconcile();
    expect(cp.snapshot()).toMatchObject({ READY: false, LAST_ERROR_CODE: "VERSION_MISMATCH", LAST_FAILURE_LAYER: "native_protocol", cause: { observed_version: "0.17.0", expected_version: "0.16.x" } });
    expect(client.ensureGrant).not.toHaveBeenCalled(); expect(client.createSession).not.toHaveBeenCalled(); await cp.close();
  });
  it("preserves malformed binding bytes without creating sessions or using an unsafe archive path", async () => {
    const { opts, client } = fixture();
    const file = write(opts.stateDir, "runtime/control-plane-bindings.json", JSON.stringify({schema:1,bindings:{START:{workspace_id:"ws_test",operation_id:"../../outside",state:"READY",session_id:"sess_test1"}}}));
    const before = fs.readFileSync(file);
    const cp = new ControlPlaneLifecycle(opts); await cp.reconcile();
    expect(cp.snapshot()).toMatchObject({READY:false,LAST_ERROR_CODE:"SESSION_STALE"});
    expect(client.createSession).not.toHaveBeenCalled(); expect(fs.readFileSync(file)).toEqual(before); await cp.close();
  });
  it("does not convert entitlement fallback into READY", async () => {
    const { opts, client } = fixture(); client.readSession.mockResolvedValue({ entitlement: { requested: "START", observed: "DEFAULT", source: "provider-registry" } } as any);
    const cp = new ControlPlaneLifecycle(opts); await cp.reconcile(); expect(cp.snapshot().READY).toBe(false); expect(cp.snapshot().LAST_ERROR_CODE).toBe("PROVIDER_SESSION_STALE"); await cp.close();
  });
  it("queries a lost committed create response and never creates a duplicate session", async () => {
    const { opts, client } = fixture(); const create = client.createSession.getMockImplementation()!; let lost = false; let committed: any;
    client.createSession.mockImplementation(async (args: any) => {
      const result = await create(args);
      if (!lost) { lost = true; committed = result; throw new ZcodeSessionError("ZCODE_SESSION_OUTCOME_UNKNOWN", "lost response"); }
      return result;
    });
    const call = client.callTool.getMockImplementation()!;
    client.callTool.mockImplementation(async (name: string, args: any) => name === "zcode_session_create_operation" ? { state: "CREATED", session_id: committed.session_id } : call(name, args));
    const first = new ControlPlaneLifecycle(opts); await first.reconcile(); await first.close();
    const second = new ControlPlaneLifecycle(opts); await second.reconcile();
    expect(second.snapshot().READY).toBe(true); expect(client.createSession).toHaveBeenCalledTimes(2); await second.close();
  });
  it("recreates only an owned readonly boot probe after authoritative NOT_PERSISTED", async () => {
    const { opts, client } = fixture(); const cp = new ControlPlaneLifecycle(opts); await cp.reconcile();
    client.readSession.mockRejectedValueOnce(new ZcodeSessionError("ZCODE_SESSION_UPSTREAM", "safe stale cause", "SESSION_STALE"));
    const call = client.callTool.getMockImplementation()!;
    client.callTool.mockImplementationOnce(async () => ({ status: "healthy" }));
    client.callTool.mockImplementationOnce(async () => { throw new ZcodeSessionError("ZCODE_SESSION_UPSTREAM", "safe stale cause", "SESSION_STALE", "native_session", "NOT_PERSISTED"); });
    await cp.reconcile(); await cp.reconcile();
    expect(cp.snapshot().READY).toBe(true); expect(client.createSession).toHaveBeenCalledTimes(3);
    expect(fs.readdirSync(path.join(opts.stateDir, "runtime/diagnostic-history"))).toHaveLength(1); await cp.close();
  });
  it("persists product pause without modifying workspace queue settings", () => {
    const { opts } = fixture(); pauseProductDispatch(opts.stateDir); expect(productDispatchPaused(opts.stateDir)).toBe(true);
    expect(fs.existsSync(path.join(opts.stateDir, "queues"))).toBe(false);
  });
  it("projects nested causes without secrets or raw exception bodies", () => {
    const cause = safeCause({ code: "ZCODE_SESSION_UPSTREAM", upstreamCode: "PERMISSION_REVIEW_TIMEOUT", message: "Authorization: Bearer private-token cookie=password" });
    expect(cause.error_code).toBe("PERMISSION_REVIEW_TIMEOUT"); expect(JSON.stringify(cause)).not.toContain("private-token");
    expect(safeCause({ status: 401 }).error_code).toBe("AUTH_REQUIRED"); expect(safeCause({ status: 403 }).error_code).toBe("FORBIDDEN");
    expect(safeCause({ code: "FILE_NOT_FOUND", message: "private-path-secret" })).toMatchObject({ error_code: "FILE_NOT_FOUND", failure_layer: "workspace_read", retryable: false });
    expect(safeCause({ code: "INVALID_MODEL", message: "private-account-secret" })).toMatchObject({ error_code: "INVALID_MODEL", failure_layer: "task_admission" });
    expect(JSON.stringify(safeCause({ code: "FILE_NOT_FOUND", message: "private-path-secret" }))).not.toContain("private-path-secret");
  });
});
