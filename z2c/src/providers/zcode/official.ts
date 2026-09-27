import type { Z2cConfig } from "../../config.js";
import { resolveCliSpawn, resolveZcodeBuiltinProviderConfigFile } from "../../config.js";
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
import { REQUIRED_START_PLAN_MODEL_ID, REQUIRED_START_PLAN_PROVIDER_ID } from "../types.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { ZcodeProcess } from "./process.js";
import { ZcodeProtocol, ZcodeProtocolError } from "./protocol.js";
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
 *  - Reverse requests from the agent are rejected fail-closed by ZcodeProtocol.
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
      current?: { providerId?: unknown; modelId?: unknown };
      available?: Array<{ providerId?: unknown; modelId?: unknown; ref?: { providerId?: unknown; modelId?: unknown } }>;
    };
    thoughtLevel?: {
      enabled?: unknown;
      current?: unknown;
      defaultLevel?: unknown;
      available?: Array<{ value?: unknown }>;
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
}

/**
 * Normalized catalog evidence from ONE native session's settings. `current`
 * and `current_model_thought_levels` describe THAT session's selection and
 * apply only to that model; they are not account-wide defaults.
 */
export interface ZcodeProviderModelCatalog {
  source_session_id: string;
  observed_at: string;
  current: { provider_id: string | null; model_id: string | null; thought_level: string | null } | null;
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

/** Parse one native `session/read` snapshot into the catalog DTO; null when the snapshot carries no model settings. */
export function parseSessionSettingsCatalog(sessionId: string, observedAt: string, snap: SessionSnapshot): ZcodeProviderModelCatalog | null {
  const settings = snap.settings ?? {};
  if (!settings.model && !settings.thoughtLevel) return null;
  const asString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
  const models: ZcodeProviderModelEntry[] = [];
  const available = Array.isArray(settings.model?.available) ? settings.model!.available! : [];
  for (const raw of available.slice(0, 100)) {
    const entry = raw as {
      providerId?: unknown; modelId?: unknown; label?: unknown;
      ref?: { providerId?: unknown; modelId?: unknown };
      reasoning?: { levels?: unknown; defaultLevel?: unknown };
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
  /** True: the provider never touches API-key based configuration; auth is ZCode-native. */
  readonly usesDesktopManagedAuth = true;

  private proc: ZcodeProcess | null = null;
  private protocol: ZcodeProtocol | null = null;
  private turnWaiters = new Map<string, (result: ProviderTurnResult) => void>();
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
    return env;
  }

  private ensureProcess(): ZcodeProtocol {
    if (!this.protocol || !this.proc?.running) {
      this.proc?.kill();
      // `--stdio` is the documented app-server transport (the exact args ZCode
      // Desktop itself uses: ["app-server", "--stdio"]). The child env is the
      // scrubbed env from spawnEnv() — see OfficialSpawnProcess below.
      const proc = new OfficialSpawnProcess(process.execPath, this.cfg.zcodeCliPath, this.spawnEnv());
      this.proc = proc;
      const protocol = new ZcodeProtocol(proc);
      this.protocol = protocol;
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
      if (!waiter) return;
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
    this.proc?.kill();
    this.proc = null;
    this.protocol = null;
    this.v4Subscriptions.clear();
    this.status = "stopped";
  }

  getRuntimeCapabilities(): Record<string, unknown> | null {
    return this.runtimeCapabilities;
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
    options?: { readonly?: boolean; modelId?: string; thoughtLevel?: string; providerId?: string },
  ): Promise<string> {
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
        persistence: "immediate",
      },
      60000,
    )) as SessionSnapshot;
    const sessionId = res.session?.sessionId;
    if (typeof sessionId !== "string" || !sessionId.startsWith("sess_")) {
      throw new Error(`session/create returned no valid session id: ${JSON.stringify(res).slice(0, 200)}`);
    }
    try {
      if (options?.readonly) {
        // Authoritative readonly establishment: subscribe the v4 conversation
        // topic and switch to plan via CAS; the transition must be OBSERVED
        // in the projection (config.planEnabled === true) or we fail closed.
        await this.setSessionCollaborationMode(sessionId, "plan", { timeoutMs: 20000 });
      }
      await this.applyRequestedIdentity(sessionId, workspace, {
        modelId: options?.modelId ?? this.policy.modelId,
        thoughtLevel: options?.thoughtLevel ?? this.policy.thoughtLevel,
        providerId: options?.providerId ?? this.policy.providerId,
      });
    } catch (err) {
      // Fail closed: a session whose identity cannot be attested is torn down.
      await proto.request("session/close", { sessionId }, 20000).catch(() => undefined);
      throw err;
    }
    return sessionId;
  }

  /**
   * Resolve requested model/thought level against the session's OWN state and
   * apply via session/setModel + session/setThoughtLevel.
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
   * refuses that ambiguity by verifying after applying).
   */
  private async applyRequestedIdentity(
    sessionId: string,
    workspace: ProviderWorkspaceRef,
    requested: { modelId: string | null; thoughtLevel: string | null; providerId?: string | null },
  ): Promise<void> {
    if (!requested.modelId && !requested.thoughtLevel && !requested.providerId) return;
    const proto = this.requireProtocol();
    const snap = await this.readSnapshot(sessionId);
    const settings = snap.settings ?? {};
    const current = settings.model?.current;
    const currentProviderId = typeof current?.providerId === "string" ? current.providerId : null;
    const tl = settings.thoughtLevel ?? {};
    const levelValues: string[] = (Array.isArray(tl.available) ? tl.available : [])
      .map((l) => (typeof l?.value === "string" ? l.value : null))
      .filter((v): v is string => v !== null);
    const observedThoughtLevel: string | undefined =
      typeof tl.current === "string" ? tl.current : levelValues[0];
    const reasoningLevel = requested.thoughtLevel ?? observedThoughtLevel;

    if (requested.modelId || requested.providerId) {
      // An explicitly requested provider is ENFORCED (user/runtime-selected
      // constraint); otherwise the provider comes from availability or the
      // session's current provider (observed, never invented by Z2C).
      const available = settings.model?.available ?? [];
      const refOf = (m: { providerId?: unknown; modelId?: unknown; ref?: { providerId?: unknown; modelId?: unknown } }) =>
        m.ref ?? { providerId: m.providerId, modelId: m.modelId };
      const requestedProvider = typeof requested.providerId === "string" ? requested.providerId : null;
      const offered = available
        .map((m) => refOf(m as { ref?: { providerId?: unknown; modelId?: unknown } }))
        .filter((r) => typeof r.modelId === "string" && r.modelId === requested.modelId && typeof r.providerId === "string");
      // When multiple routes offer Flash, select the governed coding-plan
      // route. The task engine still requires the exact observed identity;
      // a runtime without that route cannot silently admit another provider.
      const match = requestedProvider
        ? offered.find((r) => r.providerId === requestedProvider)
        : requested.modelId === REQUIRED_START_PLAN_MODEL_ID
          ? offered.find((r) => r.providerId === REQUIRED_START_PLAN_PROVIDER_ID) ?? offered[0]
          : offered[0];
      const targetProviderId = requestedProvider ?? (match ? (match.providerId as string) : currentProviderId);
      if (!targetProviderId || (!match && !requested.modelId)) {
        throw new Error(
          requestedProvider && !match
            ? `requested provider ${requestedProvider} does not offer model ${requested.modelId ?? "<current>"} on this ZCode runtime`
            : `requested model ${requested.modelId} is not offered by this ZCode runtime ` +
              `(available: ${available.map((m) => String(refOf(m as { ref?: { modelId?: unknown } })?.modelId)).filter(Boolean).slice(0, 8).join(", ") || "none"})`,
        );
      }
      const model: { providerId: string; modelId: string; options?: { reasoningLevel: string } } = {
        providerId: targetProviderId,
        modelId: (match ? (match.modelId as string) : requested.modelId)!,
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
    if (requested.thoughtLevel) {
      if (tl.enabled === false || !levelValues.includes(requested.thoughtLevel)) {
        throw new Error(
          `requested thought level ${requested.thoughtLevel} is not supported by this ZCode runtime ` +
            `(supported: ${levelValues.join(", ") || "none"})`,
        );
      }
      await proto.request("session/setThoughtLevel", { sessionId, thoughtLevel: requested.thoughtLevel }, 30000);
    }
    // Attest the EXACT session: id, workspace, provider, model, thought level.
    await this.attestSession(sessionId, workspace, {
      modelId: requested.modelId,
      thoughtLevel: requested.thoughtLevel,
      providerId: requested.providerId ?? null,
    });
  }

  async resumeSession(
    workspace: ProviderWorkspaceRef,
    sessionId: string,
    options?: { readonly?: boolean },
  ): Promise<void> {
    if (!/^sess_[0-9a-f-]{36}$/i.test(sessionId)) {
      throw new Error(`invalid ZCode session id format: ${sessionId.slice(0, 12)}…`);
    }
    await this.requireProtocol().request("session/resume", { sessionId, workspace }, 60000);
    // Live ZCode resets collaboration state (plan flag) to workspace defaults
    // on cold resume — the v4 projection replays history but execution state
    // is runtime-local. A readonly lane MUST re-establish plan via CAS and
    // re-attest; the engine's dispatch check verifies the observed flag.
    if (options?.readonly) {
      await this.setSessionCollaborationMode(sessionId, "plan", { timeoutMs: 20000 });
    }
    // Resume must land on the same authorized binding; anything else fails closed.
    await this.attestSession(sessionId, workspace, {});
  }

  async send(options: ProviderSendOptions): Promise<ProviderRunHandle> {
    const proto = this.requireProtocol();
    let timeoutTimer: NodeJS.Timeout | undefined;
    const completion = new Promise<ProviderTurnResult>((resolve) => {
      this.turnWaiters.set(options.sessionId, resolve);
      timeoutTimer = setTimeout(() => {
        if (this.turnWaiters.get(options.sessionId) === resolve) {
          this.turnWaiters.delete(options.sessionId);
          resolve({ status: "failed", detail: "turn timeout" });
        }
      }, options.timeoutMs);
    });
    // A settled turn must not leave a live ref'd timer behind (it would keep
    // the process alive for the full timeout — 15 minutes on engine lanes).
    timeoutTimer?.unref?.();
    void completion.catch(() => undefined).finally(() => clearTimeout(timeoutTimer));
    try {
      await proto.request(
        "session/send",
        { sessionId: options.sessionId, content: options.instruction, inputId: options.inputId },
        this.cfg.sendTimeoutMs,
      );
    } catch (err) {
      this.turnWaiters.delete(options.sessionId);
      throw err;
    }
    return { sessionId: options.sessionId, completion };
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.requireProtocol().request("session/stop", { sessionId }, 20000);
  }

  async closeSession(sessionId: string): Promise<void> {
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
    };
  }

  /**
   * Authoritative exact-session attestation. The session must still exist,
   * carry the authorized workspace association, and satisfy every provided
   * expectation; anything else throws (fail closed).
   */
  private async attestSession(
    sessionId: string,
    workspace: ProviderWorkspaceRef,
    expect: { modelId?: string | null; thoughtLevel?: string | null; providerId?: string | null },
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
    for (const m of fresh) {
      const info = m.info as Record<string, unknown> | undefined;
      // turn completion is NOT proof of success — model errors are recorded on
      // the assistant message and must fail the turn.
      const modelError = info?.error as { data?: { message?: string; code?: string } } | undefined;
      if (modelError) {
        throw new Error(
          `model error during turn: ${modelError.data?.code ?? "unknown"} ${modelError.data?.message ?? ""}`.trim(),
        );
      }
      for (const part of (m.parts as Array<Record<string, unknown>> | undefined) ?? []) {
        if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
      }
    }
    const joined = texts.join("\n").trim();
    if (!joined) throw new Error("turn completed but assistant produced no text output");
    return joined.length > maxChars ? joined.slice(0, maxChars) + "…[truncated]" : joined;
  }

  // ── same-session model/thought switching ──────────────────────────────────
  /**
   * Switch model and/or thought level on the EXISTING session. The provider
   * id is resolved from the session's own availability (never substituted);
   * the workspace binding and requested identity must be re-observed on
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
    if (change.thoughtLevel) {
      await this.applyRequestedIdentity(sessionId, workspace, { modelId: null, thoughtLevel: change.thoughtLevel });
    }
    if (change.modelId) {
      await this.applyRequestedIdentity(sessionId, workspace, { modelId: change.modelId, thoughtLevel: null });
    }
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
    return {
      provider_id: String(model.providerId ?? ""),
      model_id: String(model.modelId ?? ""),
      thoughtLevel: typeof snap.settings?.thoughtLevel?.current === "string" ? snap.settings.thoughtLevel.current : null,
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
