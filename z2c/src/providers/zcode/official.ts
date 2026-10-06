import {
  entitlementAccessMode,
  entitlementFromAccessMode,
  type EntitlementAttestation,
  type EntitlementPlan,
  type EntitlementSelectionSupport,
  requireSupportedEntitlement,
  unobservedEntitlement,
} from "../entitlement.js";
import type { Z2cConfig } from "../../config.js";
import {
  builtinProviderConfigDiagnostic,
  resolveCliSpawn,
  resolveZcodeBuiltinProviderConfigFile,
} from "../../config.js";
import type {
  AgentProvider,
  CapabilityProbeResult,
  SessionStateAttestation,
  ProviderBinding,
  ProviderRunHandle,
  ProviderSendOptions,
  ProviderSessionSummary,
  ProviderTurnResult,
  ProviderWorkspaceRef,
  ReadAssistantOutputOptions,
} from "../types.js";
import type { SameSessionModelUpdate, SameSessionModelUpdateResult } from "../types.js";
import { PREFERRED_START_PLAN_MODEL_ID, PREFERRED_START_PLAN_PROVIDER_ID } from "../types.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { FileAuditLog } from "../../util/log.js";
import { classifyDevelopmentOperation } from "./permissions.js";
import { requireHighestEffort, highestEffort } from "../../util/effort-policy.js";
import { managedPackageManagerEnv } from "../../util/package-manager.js";
import { ZcodeProcess } from "./process.js";
import { ZcodeProtocol, ZcodeProtocolError, type PermissionDecisionRecord } from "./protocol.js";
import { canonicalizeWorkspacePath, isSubPath } from "../../core/workspaces/registry.js";

/**
 * Official-path provider: Z2C spawns `zcode app-server --stdio` — the SAME
 * embedder contract ZCode Desktop itself uses (source:
 * zcodeAgentProcessManager.ts resolveDefaultZCodeAgentCommand) — and speaks
 * the now open-source ZCode Protocol (schemas in @zcode/shared, verified in
 * docs/zcode-open-source-integration-audit.md).
 *
 * Security posture (mandatory invariants):
 *  - The child runs in ZCode standalone mode and resolves provider auth
 *    IN-PROCESS from ZCode's own shared credential store. Z2C never reads,
 *    holds, or passes credential material (spawn env is scrubbed).
 *  - Z2C never pushes a provider registry; provider identity is only ever
 *    OBSERVED from session state.
 *  - Reverse permissions require an active dispatch grant; unknown requests fail closed.
 *  - Every identity claim (workspace / provider / model / thought level) is
 *    attested against the authoritative `session/read` snapshot of the EXACT
 *    session; unconfirmed identity fails closed.
 */

/** Admissible binding evidence source for this provider. */
export const OFFICIAL_BINDING_SOURCE = "official-session-read";

/** V4-collaboration modes accepted by switchCollaborationMode (frozen schema). */
export type CollaborationMode = "plan" | "build" | "edit" | "yolo";

/** Lenient wire shape of a v4 conversation frame notification (see onV4Frame). */
interface V4FrameWire {
  topic?: unknown;
  subscriptionId?: unknown;
  frame?: {
    topic?: unknown;
    payload?: unknown;
  };
}

/** Extract the authoritative collaboration state from a v4 snapshot object. */
interface V4Subscription {
  subscriptionId: string;
  connectionId: string;
  topic: string;
  latest: V4CollaborationState;
  snapshotCount: number;
}

function v4StateFromSnapshot(snapshot: Record<string, unknown>, prev: V4CollaborationState): V4CollaborationState {
  const config = snapshot.config as { mode?: unknown; planEnabled?: unknown } | undefined;
  return {
    revision: typeof snapshot.revision === "number" ? snapshot.revision : prev.revision,
    logEpoch: typeof snapshot.logEpoch === "string" ? snapshot.logEpoch : prev.logEpoch,
    mode: typeof config?.mode === "string" ? config.mode : prev.mode,
    planEnabled: typeof config?.planEnabled === "boolean" ? config.planEnabled : prev.planEnabled,
    observedAt: new Date().toISOString(),
  };
}

/**
 * Authoritative v4 conversation state for one session (observed from the
 * conversation topic snapshot — the ONLY surface where plan mode exists:
 * the legacy session/read mode field never reflects planEnabled).
 */
export interface V4CollaborationState {
  revision: number | null;
  logEpoch: string | null;
  mode: string | null;
  planEnabled: boolean | null;
  observedAt: string;
}

/** Authoritative exact-session state, as observed from native surfaces. */
export interface OfficialSessionAttestation {
  /** Registry-backed entitlement readback; observed === null means unproven. */
  entitlement: EntitlementAttestation;
  sessionId: string;
  workspaceKey: string | null;
  workspacePath: string | null;
  providerId: string | null;
  modelId: string | null;
  thoughtLevel: string | null;
  mode: string | null;
  /** V4 projection collaboration mode (config.mode). */
  collaborationMode: string | null;
  /** V4 projection plan flag — the authoritative readonly evidence. */
  planEnabled: boolean | null;
  bindingSource: string;
  runtimeVersion: string | null;
  status: string | null;
  observedAt: string;
  /** Runtime-advertised models from the same snapshot; null = not observed. */
  availableModels: Array<{
    providerId: string | null;
    modelId: string;
    reasoningLevels: string[];
    reasoningDefaultLevel: string | null;
  }> | null;
}

interface SessionSnapshot {
  session?: {
    sessionId?: unknown;
    workspace?: { workspaceKey?: unknown; workspacePath?: unknown };
    mode?: unknown;
    status?: unknown;
    model?: { providerId?: unknown; modelId?: unknown };
  };
  settings?: {
    mode?: { current?: unknown };
    permission?: { mode?: unknown };
    model?: {
      current?: { providerId?: unknown; modelId?: unknown; accessMode?: unknown; accountAccess?: { mode?: unknown } };
      available?: Array<{ providerId?: unknown; modelId?: unknown; ref?: { providerId?: unknown; modelId?: unknown }; accessMode?: unknown; accountAccess?: { mode?: unknown } }>;
    };
    thoughtLevel?: {
      enabled?: unknown;
      current?: unknown;
      defaultLevel?: unknown;
      available?: Array<{ value?: unknown }>;
    };
    /** Registry-backed entitlement readback (patched runtimes only). */
    entitlement?: {
      requested?: unknown;
      observed?: { mode?: unknown } | null;
      source?: unknown;
    };
  };
}

const REQUIRED_METHODS = ["session/create", "session/send", "session/list", "session/stop", "session/read"] as const;
const PREFERRED_METHODS = ["session/resume", "session/messages", "session/close", "runtime/capabilities"] as const;

// ── model-catalog wire contract (official provider → z2c-service → A2C) ────

/** One advertised model, with only OBSERVED identity — never inferred. */
export interface ZcodeProviderModelEntry {
  provider_id: string | null;
  model_id: string;
  label: string | null;
  /** Native per-model reasoning evidence; empty when the runtime advertised none. */
  reasoning_levels: string[];
  reasoning_default_level: string | null;
  /**
   * Semantic account access mode of the route offering this model (e.g.
   * "start-plan", "individual-coding-plan"); null when not account-backed or
   * not advertised. This is the runtime's own entitlement fact, never a
   * provider-id inference.
   */
  access_mode: string | null;
}

/**
 * Normalized catalog evidence from ONE native session's settings. `current`
 * and `current_model_thought_levels` describe THAT session's selection and
 * apply only to that model; they are not account-wide defaults.
 */
export interface ZcodeProviderModelCatalog {
  source_session_id: string;
  observed_at: string;
  current: { provider_id: string | null; model_id: string | null; thought_level: string | null; access_mode: string | null } | null;
  current_model_thought_levels: string[] | null;
  models: ZcodeProviderModelEntry[];
}

function boundedStrings(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value.slice(0, max)) {
    // Accept both native `[{value}]` objects and already-normalized strings.
    const token = typeof entry === "string" ? entry : (entry as { value?: unknown } | null)?.value;
    if (typeof token === "string" && token.length > 0 && token.length <= 40) out.push(token);
  }
  return out;
}

/**
 * Normalize the runtime's own `settings.entitlement` readback into the
 * sanitized attestation shape. Unknown plan spellings, malformed payloads,
 * and non-registry sources all collapse to "unproven" — evidence is never
 * invented from provider ids or model names.
 */
export function parseEntitlementReadback(raw: unknown): EntitlementAttestation {
  if (!raw || typeof raw !== "object") return unobservedEntitlement();
  const record = raw as { requested?: unknown; observed?: unknown; source?: unknown };
  const requestedMode = typeof record.requested === "string" ? record.requested : null;
  const observedMode =
    record.observed && typeof record.observed === "object" && typeof (record.observed as { mode?: unknown }).mode === "string"
      ? (record.observed as { mode: string }).mode
      : null;
  return {
    requested: entitlementFromAccessMode(requestedMode),
    observed: entitlementFromAccessMode(observedMode),
    access_mode: observedMode,
    source: typeof record.source === "string" ? record.source : "unavailable",
  };
}

/** Parse one native `session/read` snapshot into the catalog DTO; null when the snapshot carries no model settings. */
export function parseSessionSettingsCatalog(sessionId: string, observedAt: string, snap: SessionSnapshot): ZcodeProviderModelCatalog | null {
  const settings = snap.settings ?? {};
  if (!settings.model && !settings.thoughtLevel) return null;
  const asString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
  const accessModeOf = (entry: { accessMode?: unknown; accountAccess?: { mode?: unknown } } | null | undefined): string | null =>
    asString(entry?.accessMode) ?? asString(entry?.accountAccess?.mode);
  const models: ZcodeProviderModelEntry[] = [];
  const available = Array.isArray(settings.model?.available) ? settings.model!.available! : [];
  for (const raw of available.slice(0, 100)) {
    const entry = raw as {
      providerId?: unknown; modelId?: unknown; label?: unknown;
      ref?: { providerId?: unknown; modelId?: unknown };
      reasoning?: { levels?: unknown; defaultLevel?: unknown };
      accessMode?: unknown; accountAccess?: { mode?: unknown };
    } | null;
    if (!entry) continue;
    const modelId = asString(entry.modelId) ?? asString(entry.ref?.modelId);
    if (!modelId) continue;
    models.push({
      provider_id: asString(entry.providerId) ?? asString(entry.ref?.providerId),
      model_id: modelId,
      label: asString(entry.label),
      reasoning_levels: boundedStrings(entry.reasoning?.levels, 24),
      reasoning_default_level: asString(entry.reasoning?.defaultLevel),
      access_mode: accessModeOf(entry),
    });
  }
  const current = settings.model?.current ?? null;
  const currentRef = (current as { ref?: { providerId?: unknown; modelId?: unknown } } | null | undefined)?.ref ?? null;
  const thoughtLevel = settings.thoughtLevel ?? {};
  const thoughtAvailable = Array.isArray(thoughtLevel.available)
    ? boundedStrings(thoughtLevel.available, 24)
    : null;
  return {
    source_session_id: sessionId,
    observed_at: observedAt,
    current: {
      provider_id: asString(current?.providerId) ?? asString(currentRef?.providerId),
      model_id: asString(current?.modelId) ?? asString(currentRef?.modelId),
      thought_level: asString(thoughtLevel.current),
      access_mode: accessModeOf(current),
    },
    current_model_thought_levels: thoughtAvailable,
    models,
  };
}

export class ZcodeOfficialProvider implements AgentProvider {
  readonly name = "zcode-official";
  status: AgentProvider["status"] = "stopped";
  statusDetail?: string;
  providerVersion: string | null = null;
  capabilityResult: CapabilityProbeResult | null = null;
  get expectedRuntimeVersion(): string { return this.cfg.expectedZcodeVersionPrefix + "x"; }
  /** True: the provider never touches API-key based configuration; auth is ZCode-native. */
  readonly usesDesktopManagedAuth = true;
  /**
   * Bumped every time the app-server child is (re)spawned. Callers cache
   * runtime-local evidence (e.g. "the previous turn completed") keyed to a
   * generation; a change invalidates it safely.
   */
  private runtimeGenerationCounter = 0;

  private proc: ZcodeProcess | null = null;
  private protocol: ZcodeProtocol | null = null;
  private executionGrants = new Map<string, NonNullable<ProviderSendOptions["executionGrant"]>>();
  private turnWaiters = new Map<string, (result: ProviderTurnResult) => void>();
  /** Sessions with a post-timeout cancellation handshake in flight. */
  private stoppingSessions = new Set<string>();
  private audit: FileAuditLog | null = null;
  private runtimeCapabilities: Record<string, unknown> | null = null;
  /** V4 conversation subscriptions per session (CAS state source). */
  private v4Subscriptions = new Map<string, V4Subscription>();

  constructor(
    private readonly cfg: Z2cConfig,
    private readonly policy: {
      modelId: string | null;
      thoughtLevel: string | null;
      providerId: string | null;
    } = {
      modelId: cfg.requestedModelId,
      thoughtLevel: cfg.requestedThoughtLevel,
      providerId: cfg.requestedProviderId,
    },
  ) {}

  // ── process / protocol ────────────────────────────────────────────────────
  private spawnEnv(): Record<string, string> {
    // Credential hygiene: never forward Z2C/legacy key material into the child.
    // The standalone agent resolves provider auth from ZCode's own store.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (k === "Z2C_MODEL_API_KEY" || k === "ZCODE_RUNTIME_API_KEY" || k.startsWith("Z2C_ZCODE_CREDENTIALS")) continue;
      env[k] = v;
    }
    if (!env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim()) {
      const builtinConfig = resolveZcodeBuiltinProviderConfigFile(this.cfg.zcodeCliPath);
      if (builtinConfig) {
        env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtinConfig;
      }
    }
    // EXPLICIT opt-in only: let the child resolve billing entitlements from
    // ZCode's own shared credential store in-process (standalone-account
    // runtime). Z2C never touches that store itself; without this flag the
    // child keeps the desktop-host fail-closed overlay (no START/INDIVIDUAL).
    // cfg-derived in BOTH directions: cfg=false must also strip a value
    // inherited from this service's own environment, so a machine-wide "1"
    // cannot silently opt the child in.
    if (this.cfg.standaloneAccountRuntime) {
      env.ZCODE_PROTOCOL_STANDALONE_ACCOUNT_RUNTIME = "1";
    } else {
      delete env.ZCODE_PROTOCOL_STANDALONE_ACCOUNT_RUNTIME;
    }
    return managedPackageManagerEnv(this.cfg.stateDir, env);
  }

  private ensureProcess(): ZcodeProtocol {
    if (!this.protocol || !this.proc?.running) {
      this.runtimeGenerationCounter += 1;
      this.executionGrants.clear();
      this.proc?.kill();
      // `--stdio` is the documented app-server transport (the exact args ZCode
      // Desktop itself uses: ["app-server", "--stdio"]). The child env is the
      // scrubbed env from spawnEnv() — see OfficialSpawnProcess below.
      const spawnEnvUsed = this.spawnEnv();
      const proc = new OfficialSpawnProcess(process.execPath, this.cfg.zcodeCliPath, spawnEnvUsed);
      this.proc = proc;
      const protocol = new ZcodeProtocol(proc, (params) => classifyDevelopmentOperation(params, this.executionGrants));
      this.protocol = protocol;
      const permissionAudit = new FileAuditLog(join(this.cfg.stateDir, "audit"));
      this.audit = permissionAudit;
      // Startup evidence: WHERE the child's provider config came from. The
      // payload is sanitized by construction (path + digest + counts only);
      // when no path reaches the child it records the fallback as unobserved.
      permissionAudit.record("info", "provider.configSource", {
        ...builtinProviderConfigDiagnostic(
          process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
          spawnEnvUsed.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
        ),
        // Startup evidence: whether the child was opted into standalone
        // account resolution. Boolean only — never credential material.
        standaloneAccountRuntime: this.cfg.standaloneAccountRuntime === true,
      });
      protocol.on("permission-decision", (decision: PermissionDecisionRecord) => {
        // Every decision on this surface is POLICY-derived: the callback never
        // asks a human and never observes UI delivery, so records must never
        // be reported as (or mistaken for) a user rejection.
        permissionAudit.record("info", "interaction.resolved", {
          decision: decision.allowed ? "allow" : "deny",
          source: "policy",
          ...(decision.allowed ? {} : { reason: decision.reason ?? "unclassified" }),
          ...Object.fromEntries(Object.entries(decision.correlation).filter(([, v]) => v !== null)),
          at: decision.at,
        });
      });
      protocol.on("notification", (rec: { method: string; params: unknown }) =>
        this.onNotification(rec.method, rec.params),
      );
      // Identity-check the exit: a stale process's exit event must never tear
      // down a protocol that a respawn has already replaced.
      proc.on("exit", () => {
        if (this.proc !== proc) return;
        if (this.status === "healthy") {
          this.status = "unreachable";
          this.statusDetail = "app-server process exited unexpectedly";
        }
        for (const [, waiter] of [...this.turnWaiters.entries()]) {
          waiter({ status: "failed", detail: "app-server exited mid-turn" });
        }
        this.turnWaiters.clear();
        this.executionGrants.clear();
        this.v4Subscriptions.clear();
        this.protocol = null;
      });
      proc.start();
      return protocol;
    }
    return this.protocol!;
  }

  private onNotification(method: string, params: unknown): void {
    if (method === "session/event" || method === "state.updated") {
      try {
        appendFileSync(join(this.cfg.stateDir, "notifications.log"), `[${new Date().toISOString()}] ${method}: ${JSON.stringify(params)}\n`);
      } catch {}
    }
    if (method === "v4/conversation/frame") {
      this.onV4Frame(params as V4FrameWire);
      return;
    }
    if (method === "session/event") {
      const p = params as { type?: string; sessionId?: string; payload?: { response?: unknown; reason?: unknown } };
      if (!p?.sessionId) return;
      const waiter = this.turnWaiters.get(p.sessionId);
      if (!waiter) {
        // Exact terminal evidence arriving after the turn was already resolved
        // (e.g. post-timeout): record it bounded and sanitized so the pre-
        // viously "unobserved" outcome becomes auditable. A late event must
        // never re-settle a promise or re-arm anything.
        if (p.type === "turn.completed" || p.type === "turn.failed") {
          this.audit?.record("info", "turn.terminalAfterResolution", { sessionId: p.sessionId, type: p.type });
        }
        return;
      }
      if (p.type === "turn.completed") {
        this.turnWaiters.delete(p.sessionId);
        waiter({ status: "completed" });
      } else if (p.type === "turn.failed") {
        this.turnWaiters.delete(p.sessionId);
        // C: surface the bottom error (type/message/code + turn phase) so
        // prompt failures are diagnosable instead of an opaque prompt_failed.
        const err = (p.payload && typeof p.payload === "object" ? p.payload : {}) as {
          error?: { message?: unknown; type?: unknown; code?: unknown };
          turnPhase?: unknown;
        };
        const parts: string[] = [];
        const em = err.error && typeof err.error.message === "string" ? err.error.message : null;
        const et = err.error && typeof err.error.type === "string" ? err.error.type : null;
        const ec = err.error && typeof err.error.code === "string" ? err.error.code : null;
        if (em) parts.push(em);
        if (et) parts.push("type=" + et);
        if (ec) parts.push("code=" + ec);
        if (typeof err.turnPhase === "string") parts.push("phase=" + err.turnPhase);
        waiter({ status: "failed", detail: ("turn.failed " + parts.join("; ")).trim() });
      }
      return;
    }
    if (method === "state.updated") {
      // Fallback completion signal (bounded): the official primary is the
      // turn.completed/turn.failed event above; idle/error patches keep the
      // turn bounded if events are missed (schema drift, older builds).
      const p = params as { scope?: string; sessionId?: string; reason?: string; patch?: { status?: string } };
      if (!p || p.scope !== "session" || !p.sessionId) return;
      const waiter = this.turnWaiters.get(p.sessionId);
      if (!waiter) return;
      if (p.reason === "prompt_completed" || p.patch?.status === "idle") {
        void this.resolveTurnWhenSettled(p.sessionId, waiter);
      } else if (p.reason === "prompt_failed" || p.patch?.status === "error") {
        this.turnWaiters.delete(p.sessionId);
        const stderrErr = this.proc?.getLastStderrError?.();
        const detail = stderrErr
          ? `reason=${p.reason ?? "error"}: ${stderrErr}`
          : `reason=${p.reason ?? "error"}`;
        waiter({ status: "failed", detail });
      }
    }
  }

  /** Bounded fallback settle poll (mirrors the legacy lane; see migration plan). */
  private async resolveTurnWhenSettled(sessionId: string, waiter: (result: ProviderTurnResult) => void): Promise<void> {
    const deadline = Date.now() + this.cfg.sendTimeoutMs;
    let settledChecks = 0;
    while (Date.now() < deadline) {
      const running = await this.hasRunningToolParts(sessionId).catch(() => false);
      if (!running) {
        settledChecks += 1;
        if (settledChecks >= 2) {
          if (this.turnWaiters.get(sessionId) === waiter) this.turnWaiters.delete(sessionId);
          waiter({ status: "completed" });
          return;
        }
      } else {
        settledChecks = 0;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (this.turnWaiters.get(sessionId) === waiter) this.turnWaiters.delete(sessionId);
    waiter({ status: "failed", detail: "turn timeout" });
  }

  private async hasRunningToolParts(sessionId: string): Promise<boolean> {
    const res = (await this.requireProtocol().request("session/messages", { sessionId }, 20000)) as {
      messages?: Array<Record<string, unknown>>;
    };
    const messages = res.messages ?? [];
    const assistant = messages.filter((m) => (m.info as Record<string, unknown> | undefined)?.role === "assistant");
    const last = assistant[assistant.length - 1];
    if (!last) return false;
    const parts = (last.parts as Array<Record<string, unknown>> | undefined) ?? [];
    return parts.some((p) => {
      if (p.type !== "tool") return false;
      const status = (p.state as { status?: string } | undefined)?.status;
      return status === "running" || status === "pending" || status === "queued";
    });
  }

  private requireProtocol(): ZcodeProtocol {
    if (!this.protocol || !this.proc?.running) throw new Error("official app-server not connected");
    return this.protocol!;
  }

  // ── v4 authoritative collaboration state (CAS) ────────────────────────────
  /**
   * Wire envelope of a v4 conversation frame (leniently typed — the frozen
   * schemas live in @zcode/shared; Z2C parses structurally and always
   * re-verifies semantic claims via session/read).
   */
  private onV4Frame(wire: V4FrameWire | undefined): void {
    const frame = wire?.frame;
    if (!frame || typeof frame.topic !== "string") return;
    const sub = [...this.v4Subscriptions.values()].find((s) => s.topic === frame.topic);
    if (!sub) return; // frame for a topic we don't own — ignore
    const payload = frame.payload as
      | { kind: "snapshot"; snapshot?: Record<string, unknown> }
      | { kind: "deltas"; deltas?: Array<Record<string, unknown>> }
      | undefined;
    if (!payload) return;
    if (payload.kind === "snapshot" && payload.snapshot) {
      sub.latest = v4StateFromSnapshot(payload.snapshot, sub.latest);
      sub.snapshotCount += 1;
    } else if (payload.kind === "deltas" && Array.isArray(payload.deltas)) {
      for (const delta of payload.deltas) {
        const patch = delta?.patch as { config?: Record<string, unknown>; revision?: unknown } | undefined;
        if (patch && typeof patch.revision === "number") sub.latest = { ...sub.latest, revision: patch.revision };
        const config = patch?.config as { mode?: unknown; planEnabled?: unknown } | undefined;
        if (config) {
          sub.latest = {
            ...sub.latest,
            mode: typeof config.mode === "string" ? config.mode : sub.latest.mode,
            planEnabled: typeof config.planEnabled === "boolean" ? config.planEnabled : sub.latest.planEnabled,
          };
        }
      }
    }
  }

  /**
   * Subscribe the authoritative v4 conversation topic for a session and
   * capture its snapshot (revision + logEpoch + collaboration state).
   * Fails closed if the initial snapshot frame is not observed.
   */
  async subscribeSessionState(sessionId: string): Promise<V4CollaborationState> {
    const proto = this.requireProtocol();
    const existing = this.v4Subscriptions.get(sessionId);
    if (existing) return existing.latest;
    const topic = `conversation/${sessionId}`;
    const connectionId = `z2c-${randomUUID()}`;
    // Register BEFORE the request resolves: the initial snapshot frame can
    // arrive in the same stdio chunk as the response line.
    const sub: V4Subscription = {
      subscriptionId: "?",
      connectionId,
      topic,
      latest: {
        revision: null,
        logEpoch: null,
        mode: null,
        planEnabled: null,
        observedAt: new Date().toISOString(),
      },
      snapshotCount: 0,
    };
    this.v4Subscriptions.set(sessionId, sub);
    let res: { ack?: { subscriptionId?: unknown; logEpoch?: unknown } };
    try {
      res = (await proto.request(
        "v4/conversation/subscribe",
        { topic, connectionId, clientMode: "desktop-continuous" },
        30000,
      )) as { ack?: { subscriptionId?: unknown; logEpoch?: unknown } };
    } catch (err) {
      this.v4Subscriptions.delete(sessionId);
      throw err;
    }
    const subscriptionId = res.ack?.subscriptionId;
    if (typeof subscriptionId !== "string") {
      this.v4Subscriptions.delete(sessionId);
      throw new Error("v4/conversation/subscribe returned no subscription id");
    }
    sub.subscriptionId = subscriptionId;
    if (typeof res.ack?.logEpoch === "string") sub.latest = { ...sub.latest, logEpoch: res.ack.logEpoch };
    // The initial snapshot arrives as a post-response frame notification.
    const deadline = Date.now() + 10000;
    while (sub.latest.revision === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (sub.latest.revision === null) {
      this.v4Subscriptions.delete(sessionId);
      throw new Error(`v4 snapshot frame for session ${sessionId} was not observed`);
    }
    return sub.latest;
  }

  /**
   * Force a fresh authoritative snapshot (v4/conversation/resync) and return
   * the current collaboration state once the new snapshot frame is observed.
   */
  async readSessionCollaborationState(sessionId: string): Promise<V4CollaborationState> {
    await this.subscribeSessionState(sessionId);
    const proto = this.requireProtocol();
    const sub = this.v4Subscriptions.get(sessionId)!;
    const before = sub.snapshotCount;
    await proto.request(
      "v4/conversation/resync",
      {
        subscriptionId: sub.subscriptionId,
        base: null, // null base ⇒ authoritative full snapshot
        forceSnapshot: true,
        topic: sub.topic,
        connectionId: sub.connectionId,
      },
      30000,
    );
    const deadline = Date.now() + 10000;
    while (sub.snapshotCount <= before && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return sub.latest;
  }

  /**
   * Switch the collaboration mode via the official v4 CAS command
   * (switchCollaborationMode). The CAS material (baseRevision/baseLogEpoch)
   * comes ONLY from the subscribed authoritative snapshot. plan is proven by
   * observing config.planEnabled === true in the authoritative projection —
   * stale CAS is retried from a fresh snapshot (bounded); an unobserved
   * transition fails closed.
   */
  async setSessionCollaborationMode(
    sessionId: string,
    mode: CollaborationMode,
    opts?: { timeoutMs?: number },
  ): Promise<V4CollaborationState> {
    const proto = this.requireProtocol();
    const timeoutMs = opts?.timeoutMs ?? 15000;
    const deadline = Date.now() + timeoutMs;
    let lastError = "unknown";
    while (Date.now() < deadline) {
      const snap = await this.readSessionCollaborationState(sessionId);
      if (typeof snap.revision !== "number" || typeof snap.logEpoch !== "string") {
        throw new Error("v4 CAS state unavailable (no authoritative revision/logEpoch)");
      }
      // Already in the requested state? plan ⇔ planEnabled; others ⇔ mode match without plan.
      if (mode === "plan" ? snap.planEnabled === true : snap.mode === mode && snap.planEnabled === false) {
        return snap;
      }
      let ack: { status?: string; reasonCode?: string; message?: string };
      try {
        ack = (await proto.request(
          "v4/command",
          {
            commandId: randomUUID(),
            clientId: `z2c-cmd-${randomUUID()}`,
            sessionId,
            type: "switchCollaborationMode",
            payload: { mode },
            baseRevision: snap.revision,
            baseLogEpoch: snap.logEpoch,
            issuedAt: Date.now(),
          },
          30000,
        )) as { status?: string; reasonCode?: string; message?: string };
      } catch (err) {
        throw new Error(`v4 switchCollaborationMode was rejected: ${String((err as Error).message).slice(0, 160)}`);
      }
      if (ack.status === "accepted" || ack.status === "noop" || ack.status === "duplicate") {
        // Observe the authoritative transition (bounded).
        const observeDeadline = Date.now() + timeoutMs;
        while (Date.now() < observeDeadline) {
          const state = await this.readSessionCollaborationState(sessionId);
          const achieved =
            mode === "plan"
              ? state.planEnabled === true
              : state.mode === mode && state.planEnabled === false;
          if (achieved) return state;
          await new Promise((r) => setTimeout(r, 200));
        }
        lastError = `mode transition to ${mode} was not observed in the authoritative v4 state`;
        continue;
      }
      if (ack.status === "stale") {
        // CAS raced: refresh and retry within the budget.
        lastError = `stale CAS (${ack.reasonCode ?? "unknown"})`;
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      throw new Error(
        `v4 switchCollaborationMode failed (status=${ack.status ?? "unknown"}, reason=${ack.reasonCode ?? ack.message ?? "none"})`,
      );
    }
    throw new Error(`v4 switchCollaborationMode did not converge: ${lastError}`);
  }

  // ── AgentProvider lifecycle ───────────────────────────────────────────────
  detectVersion(): string | null {
    try {
      const { command, args } = resolveCliSpawn(this.cfg.zcodeCliPath, ["--version"]);
      const out = execFileSync(command, args, {
        timeout: 15000,
        encoding: "utf8",
      });
      const m = out.match(/(\d+\.\d+\.\d+)/);
      return m ? m[1]! : null;
    } catch {
      return null;
    }
  }

  async start(): Promise<void> {
    this.providerVersion = this.detectVersion();
    if (!this.providerVersion) {
      this.status = "unreachable";
      this.statusDetail = `cannot execute ZCode CLI at ${this.cfg.zcodeCliPath}`;
      throw new Error(this.statusDetail);
    }
    if (!this.providerVersion.startsWith(this.cfg.expectedZcodeVersionPrefix)) {
      this.status = "incompatible";
      this.statusDetail = `expected ZCode ${this.cfg.expectedZcodeVersionPrefix}x, detected ${this.providerVersion}`;
      throw new Error(this.statusDetail);
    }

    const proto = this.ensureProcess();
    // Official capability discovery replaces the legacy session/list liveness
    // probe: runtime/capabilities is a read-only official method.
    const deadline = Date.now() + 20000;
    let live = false;
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
      try {
        this.runtimeCapabilities = (await proto.request("runtime/capabilities", {}, 5000)) as Record<string, unknown>;
        live = true;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!live) {
      this.status = "unreachable";
      this.statusDetail = `official app-server did not answer runtime/capabilities: ${String(lastErr).slice(0, 120)}`;
      throw new Error(this.statusDetail);
    }

    this.capabilityResult = await this.probeCapabilities();
    if (!this.capabilityResult.ok) {
      this.status = "incompatible";
      this.statusDetail = `capability probe failed: ${JSON.stringify(this.capabilityResult.required)}`;
      throw new Error(this.statusDetail);
    }
    this.status = "healthy";
    this.statusDetail = `official standalone app-server (ZCode ${this.providerVersion}, auth native)`;
  }

  private async probeCapabilities(): Promise<CapabilityProbeResult> {
    const proto = this.requireProtocol();
    const required: CapabilityProbeResult["required"] = {};
    const preferred: CapabilityProbeResult["preferred"] = {};
    // Empty params yield -32602 (invalid params) for a present method and
    // -32601 (method not found) for a missing one — no session is created.
    for (const m of REQUIRED_METHODS) {
      required[m] = (await proto.methodExists(m, {}, 10000)) ? "present" : "missing";
    }
    for (const m of PREFERRED_METHODS) {
      preferred[m] = (await proto.methodExists(m, {}, 10000)) ? "present" : "missing";
    }
    const ok = Object.values(required).every((v) => v === "present");
    return {
      ok,
      expectedVersion: this.cfg.expectedZcodeVersionPrefix + "x",
      detectedVersion: this.providerVersion,
      required,
      preferred,
      checkedAt: new Date().toISOString(),
    };
  }

  async stop(): Promise<void> {
    this.executionGrants.clear();
    this.proc?.kill();
    this.proc = null;
    this.protocol = null;
    this.v4Subscriptions.clear();
    this.status = "stopped";
  }

  getRuntimeCapabilities(): Record<string, unknown> | null {
    return this.runtimeCapabilities;
  }

  /**
   * Entitlement selection support OBSERVED from the runtime's own
   * `runtime/capabilities`. Only `entitlementSelection === true` unlocks
   * START/INDIVIDUAL plans; anything else (including absent capability or an
   * unprobed runtime) must keep them failing closed.
   */
  get entitlementSelection(): EntitlementSelectionSupport {
    return {
      entitlementSelection:
        (this.runtimeCapabilities as { entitlementSelection?: unknown } | null)
          ?.entitlementSelection === true,
    };
  }

  /** Current app-server child generation (increments on every respawn). */
  get runtimeGeneration(): number {
    return this.runtimeGenerationCounter;
  }

  /** Configured identity preference (never credentials); catalog evidence only. */
  requestedIdentity(): { modelId: string | null; thoughtLevel: string | null; providerId: string | null } {
    return { modelId: this.policy.modelId, thoughtLevel: this.policy.thoughtLevel, providerId: this.policy.providerId };
  }

  private isWorkspaceMatch(sessionPath: string | null | undefined, authorizedPath: string): boolean {
    if (!sessionPath) return false;
    try {
      const canonicalSession = canonicalizeWorkspacePath(sessionPath);
      const canonicalAuth = canonicalizeWorkspacePath(authorizedPath);
      return canonicalSession === canonicalAuth || isSubPath(canonicalAuth, canonicalSession);
    } catch {
      return false;
    }
  }

  // ── sessions ──────────────────────────────────────────────────────────────
  async listSessions(workspace?: ProviderWorkspaceRef, opts?: { timeoutMs?: number }): Promise<ProviderSessionSummary[]> {
    // The catalog observation path passes a shared-deadline budget here;
    // every other caller keeps the default 20s business timeout.
    const res = (await this.requireProtocol().request("session/list", {}, opts?.timeoutMs ?? 20000)) as {
      sessions?: Array<Record<string, unknown>>;
    };
    const summaries = (res.sessions ?? []).map((s) => ({
      sessionId: String(s.sessionId),
      workspacePath: String((s.workspace as Record<string, unknown> | undefined)?.workspacePath ?? s.workspacePath ?? ""),
      status: String(s.status ?? "unknown"),
      title: typeof s.title === "string" ? s.title : undefined,
      updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : undefined,
    }));
    if (!workspace) return summaries;
    return summaries.filter((s) => this.isWorkspaceMatch(s.workspacePath, workspace.workspacePath));
  }

  /**
   * Create a native session, then resolve and apply the requested native
   * model/thought level from ZCode's OWN availability state (never a
   * hardcoded provider id), then attest the exact session. Any unconfirmed
   * identity fails closed.
   */
  async createSession(
    workspace: ProviderWorkspaceRef,
    options?: { onCreated?: (sessionId: string) => void; entitlementPlan?: EntitlementPlan; readonly?: boolean; modelId?: string; thoughtLevel?: string; providerId?: string; preferredModelId?: string; preferredThoughtLevel?: string },
  ): Promise<string> {
    const entitlementPlan = requireSupportedEntitlement(options?.entitlementPlan, this.entitlementSelection);
    const protocolEntitlement = entitlementAccessMode(entitlementPlan);
    const proto = this.requireProtocol();
    const res = (await proto.request(
      "session/create",
      {
        workspace,
        // Write lanes run in edit mode (in-workspace edits auto-approved,
        // arbitrary commands ask). Readonly governance is NOT requested via
        // the legacy mode field — the installed runtime silently ignores it —
        // but is established and ATTESTED below through the authoritative v4
        // CAS path (switchCollaborationMode → config.planEnabled).
        mode: options?.readonly ? "plan" : "edit",
        ...(this.runtimeCapabilities?.machineLocalFilesystem === true
          ? { filesystemScope: options?.readonly ? "workspace" : "machine" } : {}),
        persistence: "immediate",
        // Semantic entitlement selector (patched runtimes only; the strict
        // protocol schema of an old runtime rejects the unknown field, which
        // keeps non-DEFAULT plans fail-closed end to end).
        ...(protocolEntitlement ? { entitlement: protocolEntitlement } : {}),
      },
      60000,
    )) as SessionSnapshot;
    const sessionId = res.session?.sessionId;
    if (typeof sessionId !== "string" || !sessionId.startsWith("sess_")) {
      throw new Error(`session/create returned no valid session id: ${JSON.stringify(res).slice(0, 200)}`);
    }
    try {
      options?.onCreated?.(sessionId);
      if (options?.readonly) {
        // Authoritative readonly establishment: subscribe the v4 conversation
        // topic and switch to plan via CAS; the transition must be OBSERVED
        // in the projection (config.planEnabled === true) or we fail closed.
        await this.setSessionCollaborationMode(sessionId, "plan", { timeoutMs: 20000 });
      }
      await this.applyRequestedIdentity(sessionId, workspace, {
        modelId: options?.modelId ?? null,
        thoughtLevel: options?.thoughtLevel ?? null,
        providerId: options?.providerId ?? this.policy.providerId ?? null,
        // Configured identity is a PREFERENCE (provider-level default for
        // direct callers; the engine forwards its own): applied only when the
        // runtime's own advertisement offers it, never admission truth.
        preferredModelId: options?.preferredModelId ?? this.policy.modelId ?? null,
        preferredThoughtLevel: options?.preferredThoughtLevel ?? this.policy.thoughtLevel ?? null,
        entitlementPlan,
      });
    } catch (err) {
      // Fail closed: a session whose identity cannot be attested is torn down.
      let closed = false;
      try { await proto.request("session/close", { sessionId }, 20000); closed = true; } catch { /* outcome remains unknown */ }
      if (err instanceof Error) Object.assign(err, { sessionCreationFailedClosed: closed });
      throw err;
    }
    return sessionId;
  }

  /**
   * Resolve requested model/thought level against the session's OWN state and
   * apply via session/setModel + session/setThoughtLevel.
   *
   * Single capability truth: effort/reasoning levels for a request are taken
   * from the TARGET model's own advertisement
   * (settings.model.available[].reasoning.levels), never from
   * settings.thoughtLevel.available — that field describes the CURRENT model
   * and is only consulted when no model switch is involved.
   *
   * Resolution order for the model (identity never invented by Z2C):
   *   1. exact match in the session's reported availability list
   *      (`settings.model.available[].ref|modelId`);
   *   2. same-provider request: setModel with the session's CURRENT
   *      providerId (observed, not substituted) + the requested modelId and
   *      the reasoning level — ZCode enforces entitlement and rejects unknown
   *      models; success is only provisional until the readback attests it.
   * Unsupported explicitly-requested identity throws (fail closed; ZCode
   * itself silently SKIPS an unsupported thoughtLevel at create time — Z2C
   * refuses that ambiguity by verifying after applying). A requested effort
   * that the TARGET model does not advertise is rejected BEFORE any switch.
   */
  private async applyRequestedIdentity(
    sessionId: string,
    workspace: ProviderWorkspaceRef,
    requested: { modelId: string | null; thoughtLevel: string | null; providerId?: string | null; preferredModelId?: string | null; preferredThoughtLevel?: string | null; entitlementPlan?: EntitlementPlan },
  ): Promise<void> {
    // Soft preferences: applied ONLY when the runtime's own advertisement
    // offers them; never admission evidence, never a hard failure.
    const snapshot = await this.readSnapshot(sessionId);
    const settings0 = snapshot.settings ?? {};
    const available0 = settings0.model?.available ?? [];
    const offeredModel = (modelId: string | null | undefined): boolean =>
      !!modelId && available0.some((m) => {
        const ref = (m as { ref?: { modelId?: unknown } }).ref ?? (m as { modelId?: unknown });
        return (ref as { modelId?: unknown }).modelId === modelId;
      });
    const effectiveRequested = {
      ...requested,
      modelId: requested.modelId ?? (offeredModel(requested.preferredModelId) ? requested.preferredModelId! : null),
    };
    const highestRequired = requireHighestEffort(this.cfg.workerEffortPolicyFile);
    if (!effectiveRequested.modelId && !requested.thoughtLevel && !requested.providerId && !highestRequired) return;
    const proto = this.requireProtocol();
    const snap = snapshot;
    const settings = snap.settings ?? {};
    const current = settings.model?.current;
    const currentProviderId = typeof current?.providerId === "string" ? current.providerId : null;
    const currentModelId = typeof current?.modelId === "string" ? current.modelId : null;
    const tl = settings.thoughtLevel ?? {};
    const currentModelLevels = boundedStrings(tl.available, 24);

    // Target-model truth from the runtime's OWN per-model advertisement.
    const available = settings.model?.available ?? [];
    const accessModeOfEntry = (entry: unknown): string | null => {
      const e = (entry ?? {}) as { accessMode?: unknown; accountAccess?: { mode?: unknown } };
      return typeof e.accessMode === "string" && e.accessMode
        ? e.accessMode
        : typeof e.accountAccess?.mode === "string" && e.accountAccess.mode
          ? e.accountAccess.mode
          : null;
    };
    const refOf = (m: { providerId?: unknown; modelId?: unknown; ref?: { providerId?: unknown; modelId?: unknown } }) =>
      m.ref ?? { providerId: m.providerId, modelId: m.modelId };
    const advertised = (modelId: string) => available
      .map((entry) => {
        const ref = refOf(entry as { ref?: { providerId?: unknown; modelId?: unknown } });
        const reasoning = (entry as { reasoning?: { levels?: unknown; defaultLevel?: unknown } }).reasoning ?? {};
        return {
          providerId: typeof ref.providerId === "string" ? ref.providerId : null,
          modelId: typeof ref.modelId === "string" ? ref.modelId : null,
          reasoningLevels: boundedStrings(reasoning.levels, 24),
          reasoningDefaultLevel: typeof reasoning.defaultLevel === "string" && reasoning.defaultLevel.length > 0 ? reasoning.defaultLevel : null,
        };
      })
      .filter((r) => r.modelId === modelId);
    const currentAdvertised = currentModelId ? advertised(currentModelId) : [];
    const currentTarget = currentAdvertised[0] ?? null;

    // Entitlement-constrained sessions only ever route over the semantic
    // access mode requested (START → start-plan, INDIVIDUAL → individual-
    // coding-plan). Routes without advertised access evidence are NOT
    // eligible — an unattestable route cannot silently carry the plan.
    const expectedAccessMode = entitlementAccessMode(requested.entitlementPlan ?? "DEFAULT");

    const requestedModel = effectiveRequested.modelId;
    const switchingModel = requestedModel !== null && requestedModel !== currentModelId;
    const targetAdvertised = switchingModel && requestedModel ? advertised(requestedModel) : currentAdvertised;

    // Effort validation targets the model being switched TO. A preferred
    // (soft) effort is applied only when the effective target advertises it.
    let effectiveThoughtLevel = requested.thoughtLevel
      ?? (requested.preferredThoughtLevel && targetAdvertised[0]?.reasoningLevels.includes(requested.preferredThoughtLevel)
        ? requested.preferredThoughtLevel
        : null);
    const advertisedLevels = targetAdvertised[0]?.reasoningLevels ?? [];
    if (highestRequired && advertisedLevels.length) {
      effectiveThoughtLevel = highestEffort(advertisedLevels, requested.thoughtLevel);
    }
    // Effort validation targets the model being switched TO.
    //  - target evidence present → definitive pre-switch validation;
    //  - target evidence absent (the runtime's available[] follows the CURRENT
    //    model) → defer to post-switch verification below against the fresh
    //    snapshot's thoughtLevel.available, which by then describes the TARGET
    //    model. The PRE-switch model's level set is never the validation base.
    if (effectiveThoughtLevel) {
      if (tl.enabled === false) {
        throw new Error("thought levels are disabled on this ZCode runtime");
      }
      const levels = targetAdvertised.length > 0 && targetAdvertised[0]!.reasoningLevels.length > 0
        ? targetAdvertised[0]!.reasoningLevels
        : switchingModel
          ? null // no per-target evidence → verified after the switch instead
          : (currentTarget?.reasoningLevels.length ? currentTarget.reasoningLevels : currentModelLevels);
      if (levels !== null && !levels.includes(effectiveThoughtLevel)) {
        const whose = switchingModel ? `target model ${requestedModel}` : `model ${currentModelId ?? "current"}`;
        throw new Error(
          `requested thought level ${effectiveThoughtLevel} is not advertised for the ${whose} ` +
            `(advertised: ${levels.join(", ") || "none"})`,
        );
      }
    }

    if (effectiveRequested.modelId) {
      // A provider route constraint applies together with a model application
      // (explicit request or an applied preference). A dropped soft preference
      // must never leave a bare provider-only switch behind.
      const requestedProvider = typeof requested.providerId === "string" ? requested.providerId : null;
      const offered = available
        .map((m) => {
          const ref = refOf(m as { ref?: { providerId?: unknown; modelId?: unknown } });
          return {
            providerId: ref.providerId,
            modelId: ref.modelId,
            accessMode: accessModeOfEntry(m),
          };
        })
        .filter((r) => typeof r.modelId === "string" && r.modelId === requestedModel && typeof r.providerId === "string");
      // Entitlement-constrained sessions intersect the offered routes with the
      // requested semantic access mode. The snapshot's availability is scoped
      // to the CURRENT model, so empty offered evidence for a DIFFERENT model
      // is the normal switch case, NOT absence: the runtime itself enforces
      // the entitlement on every setModel, and the post-set exact-session
      // attestation is the fail-closed gate. Only REAL cross-plan evidence
      // (the model advertised, but under a different access mode) rejects
      // before the switch.
      const eligible = expectedAccessMode
        ? offered.filter((r) => r.accessMode === expectedAccessMode)
        : offered;
      if (expectedAccessMode && eligible.length === 0 && offered.length > 0) {
        throw new Error(
          `no advertised route with access mode ${expectedAccessMode} offers model ${requestedModel} ` +
            `(offered routes: ${offered.map((r) => `${r.providerId}:${r.accessMode ?? "unattestable"}`).join(", ")})`,
        );
      }
      if (expectedAccessMode && requestedProvider && !eligible.some((r) => r.providerId === requestedProvider)) {
        throw new Error(
          `requested provider ${requestedProvider} does not offer model ${requestedModel} over access mode ${expectedAccessMode}`,
        );
      }
      // When multiple routes offer the same model, select the governed
      // coding-plan route. The runtime enforces entitlement for the rest;
      // a runtime without an admissible route cannot silently admit another.
      const routePool = expectedAccessMode ? eligible : offered;
      const match = requestedProvider
        ? routePool.find((r) => r.providerId === requestedProvider)
        : requestedModel === PREFERRED_START_PLAN_MODEL_ID && !expectedAccessMode
          ? routePool.find((r) => r.providerId === PREFERRED_START_PLAN_PROVIDER_ID) ?? routePool[0]
          : routePool[0];
      const targetProviderId = match ? (match.providerId as string) : currentProviderId;
      if (requestedProvider && !match) {
        // Explicit provider route with no advertised match: fail closed BEFORE
        // any setModel — never fall back to the current provider and let the
        // attestation discover the substitution after the fact.
        throw new Error(
          `requested provider ${requestedProvider} does not offer model ${requestedModel ?? "<current>"} on this ZCode runtime`,
        );
      }
      if (!targetProviderId || (!match && !requestedModel)) {
        throw new Error(
          `requested model ${requestedModel} is not offered by this ZCode runtime ` +
            `(available: ${available.map((m) => String(refOf(m as { ref?: { providerId?: unknown; modelId?: unknown } })?.modelId)).filter(Boolean).slice(0, 8).join(", ") || "none"})`,
        );
      }
      // Reasoning level submitted with setModel must belong to the TARGET
      // model: explicit request (validated above) or the target's own
      // advertised default; never the previous model's current level.
      const targetEvidence = switchingModel
        ? (match ? advertised((match.modelId as string)).find((a) => a.providerId === targetProviderId) ?? advertised((match.modelId as string))[0] : undefined)
        : currentTarget ?? undefined;
      const reasoningLevel = effectiveThoughtLevel
        ?? targetEvidence?.reasoningDefaultLevel
        ?? (targetEvidence && targetEvidence.reasoningLevels.length > 0
          ? (typeof tl.current === "string" && targetEvidence.reasoningLevels.includes(tl.current) ? tl.current : targetEvidence.reasoningLevels[0]!)
          : (typeof tl.current === "string" ? tl.current : undefined));
      const model: { providerId: string; modelId: string; options?: { reasoningLevel: string } } = {
        providerId: targetProviderId,
        modelId: (match ? (match.modelId as string) : effectiveRequested.modelId)!,
      };
      if (reasoningLevel) model.options = { reasoningLevel };
      try {
        await proto.request("session/setModel", { sessionId, model }, 30000);
      } catch (err) {
        throw new Error(
          `requested model ${model.providerId}/${model.modelId} was rejected by this ZCode runtime: ${String((err as Error).message).slice(0, 160)}`,
        );
      }
    }
    // For a switch whose target catalog was absent, observe the TARGET first.
    // Never apply the old model's highest level or silently upgrade an explicit request.
    if (highestRequired && !advertisedLevels.length) {
      const fresh = await this.readSnapshot(sessionId);
      effectiveThoughtLevel = highestEffort(boundedStrings(fresh.settings?.thoughtLevel?.available ?? [], 24), requested.thoughtLevel);
    }
    if (effectiveThoughtLevel) {
      await proto.request("session/setThoughtLevel", { sessionId, thoughtLevel: effectiveThoughtLevel }, 30000);
    }
    // Post-switch advertisement proof for the deferred case: the fresh
    // snapshot's thoughtLevel.available now describes the TARGET model; the
    // requested effort must appear in it or the switch fails closed.
    if (effectiveThoughtLevel && switchingModel && (targetAdvertised.length === 0 || targetAdvertised[0]!.reasoningLevels.length === 0)) {
      const fresh = await this.readSnapshot(sessionId);
      const postLevels = boundedStrings(fresh.settings?.thoughtLevel?.available ?? [], 24);
      if (postLevels.length > 0 && !postLevels.includes(effectiveThoughtLevel)) {
        throw new Error(
          `requested thought level ${effectiveThoughtLevel} is not advertised for the target model ` +
            `${effectiveRequested.modelId} (post-switch observed: ${postLevels.join(", ")})`,
        );
      }
    }
    // Attest the EXACT session: id, workspace, provider, model, thought level,
    // and (for constrained sessions) the registry-backed entitlement readback.
    await this.attestSession(sessionId, workspace, {
      modelId: effectiveRequested.modelId,
      thoughtLevel: effectiveThoughtLevel,
      providerId: requested.providerId ?? null,
      entitlementPlan: requested.entitlementPlan ?? null,
    });
  }

  async resumeSession(
    workspace: ProviderWorkspaceRef,
    sessionId: string,
    options?: { entitlementPlan?: EntitlementPlan; readonly?: boolean },
  ): Promise<void> {
    const entitlementPlan = requireSupportedEntitlement(options?.entitlementPlan, this.entitlementSelection);
    if (!/^sess_[0-9a-f-]{36}$/i.test(sessionId)) {
      throw new Error(`invalid ZCode session id format: ${sessionId.slice(0, 12)}…`);
    }
    const protocolEntitlement = entitlementAccessMode(entitlementPlan);
    await this.requireProtocol().request("session/resume", {
      sessionId,
      workspace,
      ...(this.runtimeCapabilities?.machineLocalFilesystem === true
        ? { filesystemScope: options?.readonly ? "workspace" : "machine" } : {}),
      // Resume-scoped entitlement: the runtime re-attests the session's current
      // binding against the requested plan and fails closed on mismatch.
      ...(protocolEntitlement ? { entitlement: protocolEntitlement } : {}),
    }, 60000);
    // Live ZCode resets collaboration state (plan flag) to workspace defaults
    // on cold resume — the v4 projection replays history but execution state
    // is runtime-local. A readonly lane MUST re-establish plan via CAS and
    // re-attest; the engine's dispatch check verifies the observed flag.
    if (options?.readonly) {
      await this.setSessionCollaborationMode(sessionId, "plan", { timeoutMs: 20000 });
    }
    // Resume must land on the same authorized binding AND (when a non-DEFAULT
    // plan was requested) on an attested matching entitlement; anything else
    // fails closed.
    await this.attestSession(sessionId, workspace, { entitlementPlan });
  }

  async send(options: ProviderSendOptions): Promise<ProviderRunHandle> {
    requireSupportedEntitlement(options.entitlementPlan, this.entitlementSelection);
    const proto = this.requireProtocol();
    if (this.turnWaiters.has(options.sessionId)) throw new Error("A prompt is already running for this session");
    // A post-timeout cancellation handshake is still in flight: the previous
    // turn's terminal state is unobserved, so a new send must fail closed
    // until the bounded handshake completes.
    if (this.stoppingSessions.has(options.sessionId)) {
      throw new Error("A stop/cancellation handshake is still in progress for this session");
    }
    // Existing/resumed sessions are checked too. A new global policy never
    // silently changes the binding of an already admitted task.
    if (requireHighestEffort(this.cfg.workerEffortPolicyFile)) {
      const snapshot = await this.readSnapshot(options.sessionId);
      const thought = snapshot.settings?.thoughtLevel;
      if (typeof thought?.current !== "string") throw new Error("HIGHEST_EFFORT_UNVERIFIED");
      highestEffort(boundedStrings(thought.available ?? [], 24), thought.current);
    }
    if (options.executionGrant) this.executionGrants.set(options.sessionId, { ...options.executionGrant });
    let timeoutTimer: NodeJS.Timeout | undefined;
    const completion = new Promise<ProviderTurnResult>((resolve) => {
      this.turnWaiters.set(options.sessionId, resolve);
      timeoutTimer = setTimeout(() => {
        if (this.turnWaiters.get(options.sessionId) === resolve) {
          this.turnWaiters.delete(options.sessionId);
          // Writer protection is revoked FIRST and unconditionally: a timed-
          // out turn must never keep write authority while the stop handshake
          // runs, and the grant is never restored by that path (fail closed).
          this.executionGrants.delete(options.sessionId);
          this.audit?.record("warn", "turn.timeout", {
            sessionId: options.sessionId, budgetMs: options.timeoutMs,
            errorCode: "TIMEOUT", failureLayer: "native_turn_budget",
          });
          // Bounded cancellation: without it the underlying turn keeps
          // executing as an orphan whose reverse-permission requests are
          // denied against the already-revoked grant.
          void this.requestPostTimeoutStop(options.sessionId);
          // Truthful outcome: the turn was NOT observed to reach a terminal
          // state — only cancellation was requested. Never fabricate "stopped"
          // or "completed"; exact terminal evidence may still arrive late.
          resolve({
            status: "failed",
            detail: `turn timeout after ${options.timeoutMs}ms; session/stop cancellation requested, terminal state unobserved; execution grant revoked`,
          });
        }
      }, options.timeoutMs);
    });
    // A settled turn must not leave a live ref'd timer behind (it would keep
    // the process alive for the full timeout — 15 minutes on engine lanes).
    timeoutTimer?.unref?.();
    void completion.catch(() => undefined).finally(() => { clearTimeout(timeoutTimer); this.executionGrants.delete(options.sessionId); });
    try {
      await proto.request(
        "session/send",
        { sessionId: options.sessionId, content: options.instruction, inputId: options.inputId },
        this.cfg.sendTimeoutMs,
      );
    } catch (err) {
      this.turnWaiters.delete(options.sessionId);
      this.executionGrants.delete(options.sessionId);
      clearTimeout(timeoutTimer);
      throw err;
    }
    return { sessionId: options.sessionId, completion };
  }

  /** Bound for the post-timeout `session/stop` handshake. */
  private static readonly POST_TIMEOUT_STOP_TIMEOUT_MS = 15000;

  /**
   * Supported bounded cancellation handshake for a turn that already timed
   * out. Best-effort by design: an unconfirmed stop (error or timeout) leaves
   * the terminal state explicitly unknown, keeps the execution grant revoked
   * (writer protection retained), and never throws into the settled turn.
   */
  private async requestPostTimeoutStop(sessionId: string): Promise<void> {
    if (this.stoppingSessions.has(sessionId)) return;
    this.stoppingSessions.add(sessionId);
    try {
      await this.requireProtocol().request("session/stop", { sessionId }, ZcodeOfficialProvider.POST_TIMEOUT_STOP_TIMEOUT_MS);
    } catch {
      // Stop unconfirmed. Terminal state stays unobserved; the grant stays
      // revoked — this path never re-arms write authority.
    } finally {
      this.stoppingSessions.delete(sessionId);
    }
  }

  async stopSession(sessionId: string): Promise<void> {
    this.executionGrants.delete(sessionId);
    await this.requireProtocol().request("session/stop", { sessionId }, 20000);
  }

  async closeSession(sessionId: string): Promise<void> {
    this.executionGrants.delete(sessionId);
    await this.requireProtocol().request("session/close", { sessionId }, 20000);
  }

  // ── model-catalog wire contract (official provider → z2c-service → A2C) ───
  //
  // Normalized, type-validated view of ONE native session's model settings.
  // Native shape (ZCode 0.16.9, see docs/zcode-open-source-integration-audit.md):
  // settings.model.available[] entries nest identity under `ref` and carry
  // per-model `reasoning: {levels, defaultLevel}`; settings.thoughtLevel
  // describes the CURRENT model's reasoning options. Both identity spellings
  // (ref-nested and top-level) and both thought-level spellings (`[{value}]`
  // and `string[]`) are accepted and normalized here, at the boundary.

  async observeSessionSettings(sessionId: string, opts?: { timeoutMs?: number }): Promise<ZcodeProviderModelCatalog | null> {
    const snap = await this.readSnapshot(sessionId, opts?.timeoutMs);
    return parseSessionSettingsCatalog(sessionId, new Date().toISOString(), snap);
  }

  // ── authoritative reads ───────────────────────────────────────────────────
  private async readSnapshot(sessionId: string, timeoutMs = 20000): Promise<SessionSnapshot> {
    return (await this.requireProtocol().request("session/read", { sessionId }, timeoutMs)) as SessionSnapshot;
  }

  private toAttestation(sessionId: string, snap: SessionSnapshot, v4?: V4CollaborationState | null): OfficialSessionAttestation {
    const s = snap.session ?? {};
    const model = (s.model ?? {}) as { providerId?: unknown; modelId?: unknown };
    // Availability evidence from the SAME authoritative snapshot: the runtime's
    // own per-model advertisement, normalized through the shared catalog
    // parser so admission and agent_model_catalog see one capability truth.
    const catalog = parseSessionSettingsCatalog(sessionId, new Date().toISOString(), snap);
    return {
      sessionId: typeof s.sessionId === "string" ? s.sessionId : sessionId,
      workspaceKey: typeof s.workspace?.workspaceKey === "string" ? s.workspace.workspaceKey : null,
      workspacePath: typeof s.workspace?.workspacePath === "string" ? s.workspace.workspacePath : null,
      providerId: typeof model.providerId === "string" ? model.providerId : null,
      modelId: typeof model.modelId === "string" ? model.modelId : null,
      thoughtLevel: typeof snap.settings?.thoughtLevel?.current === "string" ? snap.settings.thoughtLevel.current : null,
      mode: typeof s.mode === "string" ? s.mode : null,
      collaborationMode: v4?.mode ?? null,
      planEnabled: v4?.planEnabled ?? null,
      bindingSource: OFFICIAL_BINDING_SOURCE,
      runtimeVersion: this.providerVersion,
      status: typeof s.status === "string" ? s.status : null,
      observedAt: new Date().toISOString(),
      // Registry-backed entitlement readback (patched runtimes); unproven on
      // runtimes that do not publish the field.
      entitlement: this.entitlementReadback(snap),
      availableModels: catalog ? catalog.models.map((m) => ({
        providerId: m.provider_id,
        modelId: m.model_id,
        reasoningLevels: m.reasoning_levels,
        reasoningDefaultLevel: m.reasoning_default_level,
      })) : null,
    };
  }

  /**
   * Normalize the runtime's own `settings.entitlement` readback. Only
   * `source === "provider-registry"` carries evidence; anything else (field
   * absent, malformed, or an unknown access mode) maps to "unproven" without
   * inventing a plan from provider ids or model names.
   */
  private entitlementReadback(snap: SessionSnapshot): EntitlementAttestation {
    return parseEntitlementReadback(snap.settings?.entitlement);
  }

  /**
   * Authoritative exact-session attestation. The session must still exist,
   * carry the authorized workspace association, and satisfy every provided
   * expectation; anything else throws (fail closed).
   */
  private async attestSession(
    sessionId: string,
    workspace: ProviderWorkspaceRef,
    expect: { modelId?: string | null; thoughtLevel?: string | null; providerId?: string | null; entitlementPlan?: EntitlementPlan | null },
  ): Promise<OfficialSessionAttestation> {
    const snap = await this.readSnapshot(sessionId);
    const att = this.toAttestation(sessionId, snap);
    if (att.sessionId !== sessionId) throw new Error(`session/read returned a different session (requested ${sessionId})`);
    if (!this.isWorkspaceMatch(att.workspacePath, workspace.workspacePath)) {
      throw new Error(
        `session workspace mismatch (observed ${att.workspacePath ?? "none"}, ` +
          `authorized ${workspace.workspacePath})`,
      );
    }
    if (expect.modelId && att.modelId !== expect.modelId) {
      throw new Error(`model switch was not observed on the session (requested ${expect.modelId}, observed ${att.modelId ?? "none"})`);
    }
    if (expect.thoughtLevel && att.thoughtLevel !== expect.thoughtLevel) {
      throw new Error(
        `thought level switch was not observed on the session (requested ${expect.thoughtLevel}, observed ${att.thoughtLevel ?? "none"})`,
      );
    }
    if (expect.providerId && att.providerId !== expect.providerId) {
      throw new Error(
        `provider switch was not observed on the session (requested ${expect.providerId}, observed ${att.providerId ?? "none"})`,
      );
    }
    // Exact-session entitlement attestation: a non-DEFAULT request must be
    // proven by the runtime's own registry-backed readback. Missing evidence
    // or a different observed plan fails closed — never a silent fallback.
    if (expect.entitlementPlan && expect.entitlementPlan !== "DEFAULT") {
      const expectedMode = entitlementAccessMode(expect.entitlementPlan);
      const readback = att.entitlement;
      if (
        readback.source !== "provider-registry" ||
        readback.observed !== expect.entitlementPlan ||
        readback.access_mode !== expectedMode
      ) {
        throw new Error(
          `entitlement ${expect.entitlementPlan} was not attested on the session ` +
            `(observed ${readback.observed ?? "unproven"} via ${readback.source})`,
        );
      }
    }
    return att;
  }

  /**
   * Authoritative exact-session state (identity + v4 collaboration fields)
   * for admission evidence and monitoring surfaces. The v4 fields come from a
   * FORCED authoritative snapshot (resync), never from accumulated deltas —
   * deltas can carry transient interaction states.
   */
  async readSessionState(sessionId: string, workspace: ProviderWorkspaceRef): Promise<SessionStateAttestation> {
    const att = await this.attestSession(sessionId, workspace, {});
    if (this.v4Subscriptions.has(sessionId)) {
      try {
        const v4 = await this.readSessionCollaborationState(sessionId);
        att.collaborationMode = v4.mode;
        att.planEnabled = v4.planEnabled;
      } catch {
        /* v4 state unavailable — fields remain null */
      }
    }
    // Entitlement readback is part of the attestation itself (toAttestation);
    // it stays unproven unless the runtime published registry-backed evidence.
    return att;
  }

  async snapshotAssistantMarker(sessionId: string): Promise<number> {
    const res = (await this.requireProtocol().request("session/messages", { sessionId }, 20000)) as {
      messages?: Array<Record<string, unknown>>;
    };
    return ((res.messages ?? []).filter((m) => (m.info as Record<string, unknown> | undefined)?.role === "assistant")).length;
  }

  async readAssistantOutput(sessionId: string, maxChars: number, opts?: ReadAssistantOutputOptions): Promise<string> {
    const minAssistantCount = Math.max(0, opts?.minAssistantCount ?? 0);
    let messages: Array<Record<string, unknown>> = [];
    // The turn waiter resolves on turn.completed; persistence of the final
    // text can lag slightly, so poll briefly for settled non-empty text.
    for (let attempt = 0; attempt < 30; attempt++) {
      const res = (await this.requireProtocol().request("session/messages", { sessionId }, 20000)) as {
        messages?: Array<Record<string, unknown>>;
      };
      messages = res.messages ?? [];
      const assistant = messages.filter((m) => (m.info as Record<string, unknown> | undefined)?.role === "assistant");
      const fresh = assistant.slice(minAssistantCount);
      const settled =
        assistant.length >= minAssistantCount &&
        fresh.some((m) => {
          const info = m.info as Record<string, unknown> | undefined;
          if (info?.error != null) return true;
          return ((m.parts as Array<Record<string, unknown>> | undefined) ?? []).some(
            (p) => p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0,
          );
        });
      if (settled) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (messages.length === 0) {
      throw new Error("no persisted messages found for session after turn completion");
    }
    const assistant = messages.filter((m) => (m.info as Record<string, unknown> | undefined)?.role === "assistant");
    const fresh = assistant.slice(minAssistantCount);
    const texts: string[] = [];
    let turnErrorMessage: string | null = null;
    for (const m of fresh) {
      const info = m.info as Record<string, unknown> | undefined;
      // turn completion is NOT proof of success — model errors are recorded on
      // the assistant message and must fail the turn.
      const modelError = info?.error as { data?: { message?: string; code?: string } } | undefined;
      if (modelError) {
        turnErrorMessage =
          `model error during turn: ${modelError.data?.code ?? "unknown"} ${modelError.data?.message ?? ""}`.trim();
        if (!opts?.allowModelError) {
          throw new Error(turnErrorMessage);
        }
      }
      // Collect this message's text BEFORE handling the error marker: the
      // checkpoint value of a cancelled turn is the work done before it died.
      for (const part of (m.parts as Array<Record<string, unknown>> | undefined) ?? []) {
        if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
      }
      if (modelError && opts?.allowModelError) {
        // Checkpoint mode: surface the error as the terminal segment and stop
        // — the error is the turn's true ending.
        texts.push(`[${turnErrorMessage}]`);
        break;
      }
    }
    const joined = texts.join("\n").trim();
    if (!joined) throw new Error(turnErrorMessage ?? "turn completed but assistant produced no text output");
    return joined.length > maxChars ? joined.slice(0, maxChars) + "…[truncated]" : joined;
  }

  // ── same-session model/thought switching ──────────────────────────────────
  /**
   * Switch model and/or thought level on the EXISTING session. The request is
   * applied as ONE combined identity change so the effort is validated
   * against the TARGET model (never the pre-switch model), the provider id is
   * resolved from the session's own availability (never substituted), and the
   * workspace binding plus every requested field are re-observed on
   * session/read or the switch fails closed.
   */
  async updateSessionModel(
    workspace: ProviderWorkspaceRef,
    sessionId: string,
    change: SameSessionModelUpdate,
  ): Promise<SameSessionModelUpdateResult> {
    if (!change.modelId && !change.thoughtLevel) {
      throw new Error("updateSessionModel requires modelId or thoughtLevel");
    }
    if (!/^sess_[0-9a-f-]{36}$/i.test(sessionId)) {
      throw new Error("invalid ZCode session id format");
    }
    await this.applyRequestedIdentity(sessionId, workspace, {
      modelId: change.modelId ?? null,
      thoughtLevel: change.thoughtLevel ?? null,
    });
    const snap = await this.readSnapshot(sessionId);
    const s = snap.session;
    if (!s || s.sessionId !== sessionId) throw new Error("session vanished during model update");
    const ws = s.workspace as { workspaceKey?: unknown; workspacePath?: unknown } | undefined;
    if (ws?.workspaceKey !== workspace.workspaceKey || ws?.workspacePath !== workspace.workspacePath) {
      throw new Error("session workspace changed during model update");
    }
    const model = (s.model ?? {}) as { providerId?: unknown; modelId?: unknown };
    if (change.modelId && model.modelId !== change.modelId) {
      throw new Error(`model switch was not observed on the session (requested ${change.modelId})`);
    }
    const thoughtLevel = typeof snap.settings?.thoughtLevel?.current === "string" ? snap.settings.thoughtLevel.current : null;
    if (change.thoughtLevel && thoughtLevel !== change.thoughtLevel) {
      throw new Error(
        `thought level switch was not observed on the session (requested ${change.thoughtLevel}, observed ${thoughtLevel ?? "none"})`,
      );
    }
    return {
      provider_id: String(model.providerId ?? ""),
      model_id: String(model.modelId ?? ""),
      thoughtLevel,
    };
  }

  async readSessionBinding(sessionId: string, workspace: ProviderWorkspaceRef): Promise<ProviderBinding | null> {
    let snap: SessionSnapshot;
    try {
      snap = await this.readSnapshot(sessionId);
    } catch {
      return null; // unknown session → unknown binding (callers fail closed)
    }
    const session = snap.session;
    if (!session || session.sessionId !== sessionId) return null;
    const model = session.model as Record<string, unknown> | undefined;
    if (!model || typeof model.providerId !== "string" || typeof model.modelId !== "string") return null;
    const ws = session.workspace as Record<string, unknown> | undefined;
    const wsPath = typeof ws?.workspacePath === "string" ? ws.workspacePath : null;
    if (!wsPath || !this.isWorkspaceMatch(wsPath, workspace.workspacePath)) return null;
    return { provider_id: model.providerId, model_id: model.modelId, source: OFFICIAL_BINDING_SOURCE };
  }

  /** Protocol surface is monitored in tests: the official lane must never push registries. */
  get sentMethodNames(): string[] {
    return this.protocol ? this.protocol.sentMethodNames() : [];
  }

  /** OS pid of the app-server child while running (daemon child tracking). */
  get childPid(): number | null {
    return this.proc?.pid ?? null;
  }

  /** Bounded event read (official `session/events`); seq-cursor replay-safe. */
  async readSessionEvents(sessionId: string, opts?: { afterSeq?: number; limit?: number }): Promise<Array<Record<string, unknown>>> {
    const params: Record<string, unknown> = { sessionId };
    if (opts?.afterSeq !== undefined) params.afterSeq = opts.afterSeq;
    if (opts?.limit !== undefined) params.limit = opts.limit;
    const res = (await this.requireProtocol().request("session/events", params, 20000)) as { events?: Array<Record<string, unknown>> };
    return res.events ?? [];
  }

  /** Bounded message read (official `session/messages`). */
  async readSessionMessages(sessionId: string, opts?: { limit?: number }): Promise<Array<Record<string, unknown>>> {
    const params: Record<string, unknown> = { sessionId };
    if (opts?.limit !== undefined) params.limit = opts.limit;
    const res = (await this.requireProtocol().request("session/messages", params, 20000)) as { messages?: Array<Record<string, unknown>> };
    return res.messages ?? [];
  }
}

/**
 * Official spawn shape: `node <zcode.cjs> app-server --stdio` with the FULL
 * child env supplied by the provider (scrubbed of credential material) — the
 * base class would otherwise merge process.env back over the scrub.
 */
class OfficialSpawnProcess extends ZcodeProcess {
  private readonly scrubbedEnv: Record<string, string>;
  constructor(nodePath: string, cliPath: string, scrubbedEnv: Record<string, string>) {
    super(nodePath, cliPath, scrubbedEnv);
    this.scrubbedEnv = scrubbedEnv;
  }
  protected argv(): string[] {
    return ["app-server", "--stdio"];
  }
  protected buildEnv(): NodeJS.ProcessEnv {
    // The scrubbed env is already the complete environment; no re-merge.
    return { ...this.scrubbedEnv };
  }
}

export { ZcodeProtocolError };
