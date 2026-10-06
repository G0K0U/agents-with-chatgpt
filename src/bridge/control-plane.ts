import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import type { Workspace } from "../workspace/manager.js";
import { writeSecureJson } from "../config/paths.js";
import { productDispatchPaused } from "../config/dispatch-policy.js";
import { currentBootId, runtimeGeneration } from "./boot-identity.js";
import { ControlPlaneError, safeCause, type SafeCause } from "./control-plane-error.js";
import { VERSION } from "../version.js";
import { installationIdentity } from "./installation-identity.js";
import { readWorkspaceSlot, reconcileWorkspaceSlot } from "../execution/slot.js";
import { ZcodeSessionClient, loadZcodeSessionConfig, type ZcodeSessionState } from "../execution/zcode-session-client.js";

type Plan = "START" | "INDIVIDUAL";
type Binding = { workspace_id: string; session_id?: string; operation_id: string; keyed?: boolean; state: "CREATING" | "READY" | "UNKNOWN" };
type State = "BOOTING" | "WAIT_PROVIDER" | "REGISTER_HOST" | "RECONCILE_ROUTES" | "RECONCILE_WORKSPACES" | "RECONCILE_SESSIONS" | "VERIFY_PROVIDER_BINDING" | "SELF_TEST" | "READY" | "DEGRADED_PROVIDER" | "DEGRADED_ROUTING" | "DEGRADED_WORKSPACE" | "DEGRADED_SESSION" | "AUTH_REQUIRED" | "VERSION_MISMATCH" | "FAILED_INTERNAL";

export interface ControlPlaneOptions {
  stateDir: string;
  generation?: string;
  workspace: Workspace;
  registry: WorkspaceRegistry;
  registryFailure?: unknown;
  client?: ZcodeSessionClient;
  /** Route observation must verify this bridge instance, not just HTTP 200. */
  routeReady: () => Promise<boolean>;
}

/** One lifecycle per existing bridge. Health is a cached safe projection. */
export class ControlPlaneLifecycle {
  private state: State = "BOOTING";
  private failure: SafeCause | null = null;
  private failureStep: string | null = null;
  private capabilities: Record<string, unknown> = {};
  private plans: Partial<Record<Plan, ZcodeSessionState>> = {};
  private lastAt: string | null = null;
  private lastResult: string | null = null;
  private running: Promise<void> | null = null;
  private client?: ZcodeSessionClient;
  private closed = false;
  private timer?: NodeJS.Timeout;
  private bindings: Partial<Record<Plan, Binding>> = {};
  private bindingsInvalid = false;
  private readonly file: string;
  private readonly installationId: string | null;
  private routeVerified = false;
  private writerState: string = "UNKNOWN";
  private providerObservedAt: string | null = null;
  private sessionsObservedAt: string | null = null;
  private reconciling = false;
  constructor(private readonly opts: ControlPlaneOptions) {
    this.client = opts.client;
    try { this.installationId = installationIdentity(opts.stateDir); } catch { this.installationId = null; }
    this.file = path.join(opts.stateDir, "runtime", "control-plane-bindings.json");
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (saved.schema !== 1 || !saved.bindings || typeof saved.bindings !== "object" || Array.isArray(saved.bindings)) throw new Error();
      for (const [plan, binding] of Object.entries(saved.bindings) as Array<[string, Binding]>) {
        if (!["START", "INDIVIDUAL"].includes(plan) || !binding || typeof binding !== "object" ||
            typeof binding.workspace_id !== "string" || !binding.workspace_id ||
            typeof binding.operation_id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(binding.operation_id) ||
            !["CREATING", "READY", "UNKNOWN"].includes(binding.state) ||
            (binding.session_id !== undefined && (typeof binding.session_id !== "string" || !binding.session_id)) ||
            (binding.keyed !== undefined && typeof binding.keyed !== "boolean")) throw new Error();
      }
      this.bindings = saved.bindings;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.bindingsInvalid = true;
    }
  }
  snapshot(): Record<string, unknown> {
    return {
      ...this.capabilities,
      A2C_VERSION: VERSION, BRIDGE_VERSION: VERSION, A2C_PROTOCOL: 1, A2C_V2_SCHEMA: 1,
      BOOT_ID: currentBootId(), GENERATION: this.opts.generation ?? runtimeGeneration,
      A2C: "RUNNING", FISHTANK_STATE: this.routeVerified ? "AUTHENTICATED_ROUTE_OBSERVED" : "UNKNOWN",
      INSTALLATION_ID: this.installationId, HOST_ID: null, HOST_REGISTRATION_STATE: "EXTERNAL_UNOBSERVED",
      ROUTING_STATE: this.routeVerified ? "READY" : this.failure?.error_code === "ROUTE_UNAVAILABLE" ? "FAILED" : "RECONCILING",
      WORKSPACE_REGISTRY_STATE: this.opts.registryFailure ? "FAILED" : "READY",
      WORKSPACE_COUNT: this.opts.registry.enabledIds().length,
      PROVIDER_STATE: this.capabilities.provider_status === "healthy" ? "READY" : "NOT_READY",
      PROVIDER_SESSION_STATE: Object.keys(this.plans).length === 2 ? "READY" : "NOT_READY",
      NATIVE_SESSION_STATE: Object.keys(this.plans).length === 2 ? "READY" : "MISSING",
      WRITER_STATE: this.writerState,
      ENTITLEMENT_CAPABILITY: this.capabilities.entitlement_capability ?? null,
      Z2C_PROTOCOL: this.capabilities.z2c_protocol_version ?? null,
      READY_STATE: this.reconciling && this.lastResult === "PASS" ? "RECONCILING" : this.state,
      RECONCILING: this.reconciling, RECONCILIATION_PHASE: this.state,
      PROVIDER_OBSERVED_AT: this.providerObservedAt, SESSION_OBSERVED_AT: this.sessionsObservedAt,
      PROVIDER_OBSERVATION_SOURCE: "Z2C_LIVE_RUNTIME", SESSION_OBSERVATION_SOURCE: "OFFICIAL_NATIVE_SESSION_READBACK",
      READY: this.state === "READY" && !this.reconciling,
      LAST_RECONCILIATION_AT: this.lastAt, LAST_RECONCILIATION_RESULT: this.lastResult,
      LAST_FAILURE_LAYER: this.failure?.failure_layer ?? null, LAST_ERROR_CODE: this.failure?.error_code ?? null,
      failure_step: this.failureStep, cause: this.failure,
      PRODUCT_TASK_DISPATCH_PAUSED: productDispatchPaused(this.opts.stateDir),
      entitlement_acceptance: this.plans,
    };
  }
  private saveBindings(): void { writeSecureJson(this.file, { schema: 1, bindings: this.bindings }, { durable: true }); }
  private async binding(plan: Plan, workspaceId: string, mayRecreate = true): Promise<ZcodeSessionState> {
    if (this.bindingsInvalid) throw new ControlPlaneError("SESSION_STALE", "native_session", "z2c");
    const client = this.client!;
    let binding = this.bindings[plan];
    if (binding?.keyed && binding.state !== "READY") {
      // Query the exact durable intent. A lost response after server commit
      // can be recovered; an unknown/failed operation is never re-created.
      const operation = await client.callTool("zcode_session_create_operation", { operation_id: binding.operation_id }) as { state: string; session_id?: string };
      if (operation.state === "CREATED" && operation.session_id) {
        binding.session_id = operation.session_id; binding.state = "READY"; this.saveBindings();
      }
    }
    if (binding && (binding.workspace_id !== workspaceId || !binding.session_id || binding.state !== "READY")) {
      throw new ControlPlaneError("SESSION_STALE", "native_session", "z2c");
    }
    if (!binding) {
      // Persist intent BEFORE create. A lost create response stays UNKNOWN;
      // startup never blindly retries it or creates a second session.
      binding = { workspace_id: workspaceId, operation_id: randomUUID(), keyed: true, state: "CREATING" };
      this.bindings[plan] = binding; this.saveBindings();
      try {
        const created = await client.createSession({ workspace_id: workspaceId, access: "readonly", entitlement_plan: plan, operation_id: binding.operation_id });
        binding.session_id = created.session_id; binding.state = "READY"; this.saveBindings();
      } catch (error) { binding.state = "UNKNOWN"; this.saveBindings(); throw error; }
    }
    let state: ZcodeSessionState;
    try { state = await client.readSession({ workspace_id: workspaceId, session_id: binding.session_id! }); }
    catch (error) {
      // Resume only this locally-owned diagnostic session; never send a turn,
      // resume a product task, or change the recorded explicit entitlement.
      if (safeCause(error).error_code !== "SESSION_STALE" && !/SESSION_NOT_ACTIVE|Session is not active|SESSION_NOT_FOUND/i.test(String((error as Error).message))) throw error;
      try {
        state = await client.callTool("zcode_session_resume", { workspace_id: workspaceId, session_id: binding.session_id, access: "readonly", entitlement_plan: plan }) as ZcodeSessionState;
      } catch (resumeError) {
        // Empty boot-probe sessions may be runtime-only in ZCode. Recreate
        // ONLY after resume authoritatively reports no persisted record. Never
        // use INACTIVE, timeout, transport failure or a product task as proof.
        if (!mayRecreate || (resumeError as { nativeSessionState?: string }).nativeSessionState !== "NOT_PERSISTED") throw resumeError;
        writeSecureJson(path.join(this.opts.stateDir, "runtime", "diagnostic-history", `${binding.operation_id}.json`), { schema: 1, plan, binding, invalidation_reason: "AUTHORITATIVE_NOT_PERSISTED", boot_id: currentBootId(), at: new Date().toISOString() }, { durable: true });
        delete this.bindings[plan]; this.saveBindings();
        return this.binding(plan, workspaceId, false);
      }
    }
    const att = state as ZcodeSessionState & { entitlement?: { requested?: string; observed?: string; source?: string } };
    if (att.entitlement?.requested !== plan || att.entitlement?.observed !== plan || att.entitlement?.source !== "provider-registry" || !state.provider_id || /^(builtin:)?zai-api$/.test(state.provider_id) || !state.model_id || !state.thought_level || state.plan_enabled !== true) {
      throw new ControlPlaneError("PROVIDER_SESSION_STALE", "provider_binding", "z2c");
    }
    const available = (state as unknown as { available_models?: Array<{ provider_id: string | null; model_id: string; reasoning_levels: string[] }> }).available_models;
    if (!available?.some(m => m.model_id === state.model_id && m.provider_id === state.provider_id && m.reasoning_levels.includes(state.thought_level!))) {
      throw new ControlPlaneError("PROVIDER_NOT_READY", "live_model_catalog", "z2c");
    }
    return state;
  }
  reconcile(): Promise<void> {
    if (this.running) return this.running;
    if (this.closed) return Promise.resolve();
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }
  private lastAuthenticatedRouteAt: number | null = null;
  authenticatedRouteObserved(now = Date.now()): Promise<void> {
    const recovered = this.lastAuthenticatedRouteAt === null || now - this.lastAuthenticatedRouteAt >= 90_000;
    this.lastAuthenticatedRouteAt = now;
    // Routine authenticated reads observe readiness. Only newly live route
    // evidence triggers startup work; the 30-second reconcile timer remains.
    return recovered ? this.reconcile() : Promise.resolve();
  }
  private async run(): Promise<void> {
    // Retain the last observed facts while querying live dependencies. A
    // periodic observation in progress is not evidence of a missing provider.
    this.reconciling = true; this.failure = null;
    let step = "runtime_capabilities";
    try {
      this.writerState = "IDLE";
      const directory = path.join(this.opts.stateDir, "locks");
      if (fs.existsSync(directory)) for (const file of fs.readdirSync(directory)) {
        if (!/^[A-Za-z0-9_-]{1,64}\.json$/.test(file)) continue;
        const id = file.slice(0, -5);
        const lease = readWorkspaceSlot(id, this.opts.stateDir);
        if (!lease) { this.writerState = "UNKNOWN"; continue; }
        if (currentBootId() && lease.bootId && lease.bootId !== currentBootId()) {
          reconcileWorkspaceSlot(id, () => null, this.opts.stateDir); continue;
        }
        this.writerState = lease.leaseExpiresAt && Date.parse(lease.leaseExpiresAt) < Date.now() ? "EXPIRED_REQUIRES_LIVENESS_PROOF" : "ACTIVE_OR_UNRESOLVED";
      }
      this.state = "WAIT_PROVIDER";
      this.client ??= new ZcodeSessionClient(loadZcodeSessionConfig());
      this.capabilities = await this.client.runtimeCapabilities();
      this.providerObservedAt = new Date().toISOString();
      if (this.capabilities.z2c_protocol_version !== 1) throw new ControlPlaneError("VERSION_MISMATCH", "z2c_protocol", "z2c", String(this.capabilities.z2c_protocol_version));
      const nativeCapabilities = this.capabilities.capabilities as { ok?: boolean; expectedVersion?: string; detectedVersion?: string } | null;
      if (this.capabilities.provider_status === "incompatible" || nativeCapabilities?.ok === false) {
        throw new ControlPlaneError("VERSION_MISMATCH", "native_protocol", "zcode-native",
          String(this.capabilities.zcode_runtime_version ?? nativeCapabilities?.detectedVersion ?? "UNKNOWN"),
          String(this.capabilities.expected_zcode_version ?? nativeCapabilities?.expectedVersion ?? "UNKNOWN"));
      }
      if (this.capabilities.provider_status !== "healthy") throw new ControlPlaneError("PROVIDER_NOT_READY", "provider", "z2c");
      this.state = "REGISTER_HOST";
      if (!this.installationId) throw new ControlPlaneError("HOST_NOT_REGISTERED", "installation_identity", "bridge");
      this.state = "RECONCILE_ROUTES"; step = "route_registry";
      this.routeVerified = await this.opts.routeReady();
      if (!this.routeVerified) throw new ControlPlaneError("ROUTE_UNAVAILABLE", "routing", "bridge");
      this.state = "RECONCILE_WORKSPACES"; step = "workspace_list";
      if (this.opts.registryFailure) throw this.opts.registryFailure;
      this.opts.registry.getWorkspace(this.opts.workspace.id);
      // Existing durable authorization is authoritative. Never downgrade a
      // write grant; this is an idempotent local read registration.
      const grant = await this.client.ensureGrant(this.opts.workspace.root, false);
      await this.client.workspaceList();
      this.state = "SELF_TEST"; step = "workspace_info";
      this.opts.workspace.detectProject();
      step = "read_file";
      const candidate = ["package.json", "pyproject.toml", "README.md", "AGENTS.md"].find(file => fs.existsSync(path.join(this.opts.workspace.root, file)));
      if (!candidate) throw new ControlPlaneError("WORKSPACE_NOT_READY", "boot_self_test", "bridge");
      await this.opts.workspace.readFile(candidate, { startLine: 1, endLine: 1 });
      step = "zcode_native_status";
      const native = await this.client.callTool("provider_status", { workspace_id: grant.workspace_id }) as { status?: string };
      if (native.status !== "healthy") throw new ControlPlaneError("PROVIDER_NOT_READY", "native_status", "z2c");
      this.state = "RECONCILE_SESSIONS";
      for (const plan of ["START", "INDIVIDUAL"] as const) {
        step = `${plan}_selector`;
        this.plans[plan] = await this.binding(plan, grant.workspace_id);
      }
      this.sessionsObservedAt = new Date().toISOString();
      this.state = "VERIFY_PROVIDER_BINDING"; step = "live_model_catalog";
      const catalog = await this.client.modelCatalog();
      if (!catalog.runtime_settings) throw new ControlPlaneError("PROVIDER_NOT_READY", "model_catalog", "z2c");
      this.state = "READY"; this.failureStep = null; this.lastResult = "PASS";
    } catch (error) {
      this.failure = safeCause(error); this.failureStep = step; this.lastResult = "FAIL";
      if (step === "runtime_capabilities") { this.capabilities = {}; this.plans = {}; this.providerObservedAt = null; this.sessionsObservedAt = null; }
      else if (step.endsWith("_selector")) { this.plans = {}; this.sessionsObservedAt = null; }
      const code = this.failure.error_code;
      this.state = code === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : code === "VERSION_MISMATCH" ? "VERSION_MISMATCH" : code === "ROUTE_UNAVAILABLE" ? "DEGRADED_ROUTING" : code.startsWith("WORKSPACE") ? "DEGRADED_WORKSPACE" : code.includes("SESSION") ? "DEGRADED_SESSION" : code === "INTERNAL_ERROR" ? "FAILED_INTERNAL" : "DEGRADED_PROVIDER";
      this.client?.resetSession();
    }
    this.lastAt = new Date().toISOString();
    this.reconciling = false;
    if (!this.closed) writeSecureJson(path.join(this.opts.stateDir, "runtime", "control-plane-health.json"), this.snapshot());
  }
  start(): void {
    void this.reconcile().catch(() => undefined);
    this.timer = setInterval(() => { void this.reconcile().catch(() => undefined); }, 30_000); this.timer.unref();
  }
  async close(): Promise<void> { this.closed = true; if (this.timer) clearInterval(this.timer); await this.running; this.client?.close(); }
}
