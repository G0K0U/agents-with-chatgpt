#!/usr/bin/env node
// Fake ZCode app-server implementing the OFFICIAL open-source contract
// (docs/zcode-open-source-integration-audit.md) for ZcodeOfficialProvider tests.
//
// Faithful behaviors:
//   - runtime/capabilities -> { independentPlanState: true }
//   - strict params: method-existence probes with {} -> -32602
//   - session/create (no model) -> snapshot with the runtime DEFAULT model
//   - session/setModel validates against settings.model.available
//   - session/setThoughtLevel validates against settings.thoughtLevel.available
//   - session/send -> { accepted: true } + session/event turn.completed notification
//   - session/close -> further reads fail (-32000), like a closed runtime
//   - workspace/updateProviderRegistry -> -32601 (method does not exist in the
//     official protocol; a caller sending it is a legacy-lane bug)
//
// Test instrumentation: appends one JSON line per received request
// {method, hasKeyMaterial} to the file named by FAKE_APP_SERVER_LOG.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const NL = "\n";
const LOG = process.env.FAKE_APP_SERVER_LOG ?? "";

// Mirrors the LIVE standalone runtime shape (audited 2026-09-21):
// single provider "zai-api", availability list follows the current model,
// GLM-5.3-Flash requires options.reasoningLevel.
const PROVIDER_ID = process.env.FAKE_APP_SERVER_PROVIDER_ID ?? "zai-api";
const CATALOG = {
  "GLM-5.3": { providerId: PROVIDER_ID, modelId: "GLM-5.3" },
  "GLM-5.3-Flash": { providerId: PROVIDER_ID, modelId: "GLM-5.3-Flash" },
};
const DEFAULT_MODEL = CATALOG["GLM-5.3"]; // runtime default ≠ governed Flash → setModel must happen
const DEFAULT_THOUGHT = "high";
const THOUGHT_LEVELS = ["low", "high", "max"];

const hasKeyMaterial = Boolean(process.env.Z2C_MODEL_API_KEY || process.env.ZCODE_RUNTIME_API_KEY);

// Version detection probe (provider runs `node fixture --version` first).
if (process.argv.includes("--version")) {
  process.stdout.write("0.16.9\n");
  process.exit(0);
}

const sessions = new Map(); // id -> { workspace, mode, model, thoughtLevel, closed, messages, v4 }
const v4Subscriptions = new Map(); // subscriptionId -> { topic, sessionId }
let v4SubCounter = 0;

// Cold-resume model: like the real agent, sessions persist across process
// restarts when FAKE_APP_SERVER_STATE names a state file.
const STATE_FILE = process.env.FAKE_APP_SERVER_STATE ?? "";
function loadState() {
  if (!STATE_FILE || !existsSync(STATE_FILE)) return;
  try {
    for (const [id, s] of Object.entries(JSON.parse(readFileSync(STATE_FILE, "utf8")))) sessions.set(id, s);
  } catch { /* corrupt state = fresh runtime */ }
}
function saveState() {
  if (!STATE_FILE) return;
  try { writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(sessions))); } catch { /* best effort */ }
}
loadState();

const send = (obj) => process.stdout.write(JSON.stringify(obj) + NL);

function v4ConfigOf(state) {
  return {
    provider: state.model.providerId,
    model: state.model.modelId,
    thought: state.thoughtLevel,
    thoughtLevels: THOUGHT_LEVELS,
    followupMode: "queue",
    mode: state.mode,
    planEnabled: state.v4?.planEnabled ?? false,
  };
}

function v4SnapshotOf(state) {
  return {
    protocolVersion: 1,
    sessionId: state.sessionId,
    logEpoch: state.v4.logEpoch,
    seq: state.v4.revision,
    revision: state.v4.revision,
    control: { phase: "draft" },
    config: v4ConfigOf(state),
  };
}

function pushV4Frame(subscriptionId, topic, payload) {
  // The live runtime wraps the wire frame in a notification envelope.
  send({
    method: "v4/conversation/frame",
    params: {
      wireVersion: 3,
      kind: "complete",
      deliveryKind: "initial",
      logicalFrameId: `${subscriptionId}-lf-${++v4SubCounter}`,
      logicalFrameOrdinal: 1,
      topic,
      subscriptionId,
      frame: { topic, subscriptionId, sentAt: Date.now(), fromSeq: 0, toSeq: payload.kind === "snapshot" ? 0 : 1, payload },
    },
  });
}

function log(method) {
  if (!LOG) return;
  try { appendFileSync(LOG, JSON.stringify({ method, hasKeyMaterial }) + NL); } catch { /* test-only */ }
}

function snapshot(state, messageLimit) {
  const msgs = state ? state.messages : [];
  return {
    protocol: { name: "zcode", version: "0.16" },
    session: state
      ? {
          sessionId: state.sessionId,
          workspace: state.workspace,
          sessionKind: "task",
          title: "fake",
          mode: state.mode,
          status: state.closed ? "closed" : "idle",
          model: { providerId: state.model.providerId, modelId: state.model.modelId },
          createdAt: 0,
          updatedAt: 0,
        }
      : undefined,
    settings: state
      ? {
          model: { current: state.model, available: [{ ref: state.model, label: state.model.modelId }] },
          thoughtLevel: { enabled: true, current: state.thoughtLevel, available: THOUGHT_LEVELS.map((value) => ({ value })) },
          mode: { current: state.mode },
        }
      : undefined,
    projection: { status: state?.closed ? "closed" : "idle", pendingPermissions: [], activeToolCalls: [] },
    runtime: {},
    messages: typeof messageLimit === "number" ? msgs.slice(-messageLimit) : msgs,
  };
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg.method !== "string") return;
  if (typeof msg.id === "undefined") return; // notifications not expected from Z2C
  const id = msg.id;
  const params = msg.params ?? {};
  log(msg.method);

  const methodMissing = () => send({ id, error: { code: -32601, message: `method not found (fake): ${msg.method}` } });
  const invalidParams = () => send({ id, error: { code: -32602, message: "Invalid params (fake)" } });
  const notFound = () => send({ id, error: { code: -32000, message: "session not found (fake)" } });

  switch (msg.method) {
    case "runtime/capabilities":
      return send({ id, result: { independentPlanState: true } });

    case "workspace/updateProviderRegistry":
      return methodMissing(); // official standalone protocol has no such method

    case "session/create": {
      if (params.sessionId) return invalidParams();
      if (!params.workspace?.workspaceKey || !params.workspace?.workspacePath) return invalidParams();
      const sessionId = `sess_${randomUUID()}`;
      // Mirrors the LIVE runtime: a requested plan mode at create is silently
      // not honored (state stays at the default). Readonly governance is
      // established via the v4 CAS path instead (see v4/command).
      const requestedMode = params.mode === "plan" ? "build" : (params.mode ?? "build");
      const state = {
        sessionId,
        workspace: { workspaceKey: params.workspace.workspaceKey, workspacePath: params.workspace.workspacePath },
        mode: requestedMode,
        model: { ...DEFAULT_MODEL }, // runtime default, NOT the requested model
        thoughtLevel: DEFAULT_THOUGHT,
        closed: false,
        messages: [],
      };
      state.v4 = { logEpoch: `${randomUUID().slice(0, 18)}`, revision: 0, planEnabled: false };
      sessions.set(sessionId, state);
      saveState();
      return send({ id, result: snapshot(state) });
    }

    case "session/setModel": {
      const state = sessions.get(params.sessionId);
      if (!state) return notFound();
      const model = CATALOG[params.model?.modelId];
      if (!model || model.providerId !== params.model?.providerId) {
        return send({ id, error: { code: -32603, message: "Provider Registry 中不存在 Model (fake)" } });
      }
      // Mirrors the live runtime: Flash requires an explicit reasoning level.
      if (model.modelId === "GLM-5.3-Flash" && !params.model?.options?.reasoningLevel) {
        return send({ id, error: { code: -32603, message: `Reasoning level is required for ${model.providerId}/${model.modelId}` } });
      }
      state.model = { ...model };
      saveState();
      return send({ id, result: snapshot(state) });
    }

    case "session/setThoughtLevel": {
      const state = sessions.get(params.sessionId);
      if (!state) return notFound();
      if (!THOUGHT_LEVELS.includes(params.thoughtLevel)) {
        return send({ id, error: { code: -32602, message: "thought level not supported (fake)" } });
      }
      state.thoughtLevel = params.thoughtLevel;
      saveState();
      return send({ id, result: snapshot(state) });
    }

    case "session/read": {
      const state = sessions.get(params.sessionId);
      if (!state) return notFound();
      return send({ id, result: snapshot(state, params.messageLimit) });
    }

    case "session/messages": {
      const state = sessions.get(params.sessionId);
      if (!state) return notFound();
      return send({ id, result: { messages: state.messages } });
    }

    case "session/list": {
      const all = [...sessions.values()].filter((s) => !s.closed);
      const filtered = params.workspace
        ? all.filter((s) => s.workspace.workspaceKey === params.workspace.workspaceKey)
        : all;
      return send({ id, result: { sessions: filtered.map((s) => ({ sessionId: s.sessionId, workspace: s.workspace, status: "idle", model: s.model })) } });
    }

    case "session/send": {
      const state = sessions.get(params.sessionId);
      if (!state) return notFound();
      if (typeof params.content !== "string" || params.content.length === 0) return invalidParams();
      state.messages.push({ info: { role: "user" }, parts: [{ type: "text", text: params.content }] });
      state.messages.push({
        info: { role: "assistant" },
        parts: [{ type: "text", text: `FAKE OFFICIAL REPLY: ${params.content.slice(0, 40)}` }],
      });
      saveState();
      send({ id, result: { sessionId: state.sessionId, accepted: true, stateRevision: state.messages.length } });
      // Official turn lifecycle notifications, emitted after the response.
      const now = Date.now();
      setImmediate(() => {
        send({ method: "session/event", params: { type: "turn.started", eventId: randomUUID(), sessionId: state.sessionId, seq: 1, timestamp: now, payload: { turnNumber: 1, input: params.content } } });
        send({ method: "session/event", params: { type: "turn.completed", eventId: randomUUID(), sessionId: state.sessionId, seq: 2, timestamp: now + 5, payload: { response: "FAKE OFFICIAL REPLY", tokenCount: 1, toolCallCount: 0, duration: 5, resultType: "success", inputId: params.inputId } } });
        send({ method: "state.updated", params: { type: "state.updated", scope: "session", sessionId: state.sessionId, revision: 2, reason: "prompt_completed", patch: { status: "idle" } } });
      });
      return;
    }

    case "session/resume": {
      const state = sessions.get(params.sessionId);
      if (!state) return notFound();
      if (params.workspace && (params.workspace.workspaceKey !== state.workspace.workspaceKey)) return invalidParams();
      state.closed = false;
      saveState();
      return send({ id, result: snapshot(state) });
    }

    case "session/stop": {
      const state = sessions.get(params.sessionId);
      if (!state) return notFound();
      return send({ id, result: {} });
    }

    case "session/close": {
      const state = sessions.get(params.sessionId);
      if (!state) return notFound();
      state.closed = true;
      saveState();
      return send({ id, result: { closed: true } });
    }

    // ── v4 authoritative state (mirrors the audited live shapes) ──
    case "v4/conversation/subscribe": {
      const sid = String(params.topic ?? "").replace(/^conversation\//, "");
      const state = sessions.get(sid);
      if (!state) return notFound();
      if (!state.v4) state.v4 = { logEpoch: `${randomUUID().slice(0, 18)}`, revision: 0, planEnabled: false };
      const subscriptionId = `sub-${++v4SubCounter}-${randomUUID().slice(0, 8)}`;
      v4Subscriptions.set(subscriptionId, { topic: params.topic, sessionId: sid });
      send({ id, result: { ack: { subscriptionId, mode: "snapshot", logEpoch: state.v4.logEpoch } } });
      pushV4Frame(subscriptionId, params.topic, { kind: "snapshot", snapshot: v4SnapshotOf(state) });
      return;
    }

    case "v4/conversation/resync": {
      const sub = v4Subscriptions.get(params.subscriptionId);
      const state = sub && sessions.get(sub.sessionId);
      if (!sub || !state) return notFound();
      send({ id, result: { ack: { subscriptionId: params.subscriptionId, mode: "snapshot", logEpoch: state.v4.logEpoch } } });
      pushV4Frame(params.subscriptionId, sub.topic, { kind: "snapshot", snapshot: v4SnapshotOf(state) });
      return;
    }

    case "v4/command": {
      const state = sessions.get(params.sessionId);
      if (!state) {
        return send({ id, result: { commandId: params.commandId, status: "rejected", reasonCode: "proto.sessionNotFound", revisionAtDecision: 0 } });
      }
      if (!state.v4) state.v4 = { logEpoch: `${randomUUID().slice(0, 18)}`, revision: 0, planEnabled: false };
      const requiresCas = ["switchCollaborationMode", "switchModelConfig", "sendText", "stop", "compact", "forkAssistant", "applyFileRewind", "editUserQuery", "retryTurn"];
      if (requiresCas.includes(params.type) && (typeof params.baseRevision !== "number" || typeof params.baseLogEpoch !== "string")) {
        return send({ id, result: { commandId: params.commandId, status: "rejected", reasonCode: "proto.invalidPayload", message: "CAS commands require baseRevision and baseLogEpoch", revisionAtDecision: state.v4.revision } });
      }
      if (params.baseRevision !== state.v4.revision) {
        return send({ id, result: { commandId: params.commandId, status: "stale", reasonCode: "proto.staleRevision", revisionAtDecision: state.v4.revision } });
      }
      // FAKE_CAS_STALE_ONCE=1: the FIRST command per session reports a stale
      // verdict even though the revision matched — proves the provider
      // refreshes its CAS material and retries instead of failing.
      if (process.env.FAKE_CAS_STALE_ONCE === "1" && !state.v4.staleOnceUsed) {
        state.v4.staleOnceUsed = true;
        saveState();
        return send({ id, result: { commandId: params.commandId, status: "stale", reasonCode: "proto.staleRevision", revisionAtDecision: state.v4.revision } });
      }
      if (params.type !== "switchCollaborationMode") {
        return send({ id, result: { commandId: params.commandId, status: "rejected", reasonCode: "proto.unsupportedCommand", revisionAtDecision: state.v4.revision } });
      }
      const requested = params.payload?.mode;
      // FAKE_V4_DISABLE_PLAN=1: command "succeeds" but plan is never actually
      // established — simulates an unobservable/unhonored transition so tests
      // can prove the provider fails closed on missing authoritative evidence.
      const applyPlan = process.env.FAKE_V4_DISABLE_PLAN !== "1";
      if (requested === "plan") {
        if (state.v4.planEnabled) return send({ id, result: { commandId: params.commandId, status: "noop", revisionAtDecision: state.v4.revision } });
        if (applyPlan) state.v4.planEnabled = true;
      } else {
        state.mode = requested;
        if (state.v4.planEnabled) state.v4.planEnabled = false;
      }
      state.v4.revision += 1;
      saveState();
      send({ id, result: { commandId: params.commandId, status: "accepted", revisionAtDecision: state.v4.revision - 1 } });
      // Deliver the state transition as a delta frame (like the live runtime).
      for (const [subId, sub] of v4Subscriptions) {
        if (sub.sessionId === state.sessionId) {
          pushV4Frame(subId, sub.topic, { kind: "deltas", deltas: [{ op: "state.updated", patch: { config: v4ConfigOf(state), revision: state.v4.revision } }] });
        }
      }
      return;
    }

    default:
      // Method-existence probes with empty params prove dispatch, like the real agent.
      if (Object.keys(params).length === 0) return invalidParams();
      return methodMissing();
  }
});
