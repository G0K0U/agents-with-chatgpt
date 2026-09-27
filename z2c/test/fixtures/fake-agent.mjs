#!/usr/bin/env node
// Fake ZCode agent used by desktop mux/provider tests. Implements just enough
// of the ZCode Protocol to exercise the control plane:
//   - method-existence probes (empty params) -> -32602 (proves method present)
//   - session/create -> { session: { sessionId: "sess_<uuid>", model } }
//   - session/read   -> { session: { sessionId, model, thoughtLevel, workspace } }
//   - session/setModel -> same-session model switch (validated against the
//     fake agent's available models; unsupported models fail closed)
//   - session/setThoughtLevel -> same-session reasoning level switch
//   - session/send   -> { accepted: true } + state.updated prompt_started/completed
//   - session/stop   -> {}
//   - session/list   -> { sessions: [...] }
//   - session/messages -> persisted user + assistant text
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const NL = "\n";
const sessions = new Map(); // sessionId -> { instruction, replied, model, thoughtLevel }

// Model state the fake agent reports for each of its sessions (as the real
// app-server does in its session state); session/list exposes it per session.
const FAKE_MODEL = { providerId: "builtin:zai-coding-plan", modelId: "GLM-5.3" }; // current observed Desktop identity (2026-09-16 entitlement)
const AVAILABLE_MODELS = new Set(["GLM-5.3", "GLM-5.3-Flash"]); // models this fake agent accepts on its provider
const THOUGHT_LEVELS = new Set(["low", "high", "max"]);

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg && typeof msg.id !== "undefined" && typeof msg.method === "string") {
    const id = msg.id;
    const params = msg.params ?? {};
    if (Object.keys(params).length === 0) {
      process.stdout.write(JSON.stringify({ id, error: { code: -32602, message: "Invalid params (fake)" } }) + NL);
      return;
    }
    switch (msg.method) {
      case "session/create": {
        // Desktop has bootstrapped its model registry under this EXACT key.
        // A filesystem-equivalent spelling is a different native context.
        if (params.workspace?.workspaceKey !== process.cwd() || params.workspace?.workspacePath !== process.cwd()) {
          emit({ id, error: { code: -32603, message: "Model config is missing for Desktop workspace key" } });
          return;
        }
        const sessionId = "sess_" + randomUUID();
        sessions.set(sessionId, { instruction: null, replied: false, model: FAKE_MODEL, thoughtLevel: null, workspace: params.workspace });
        process.stdout.write(JSON.stringify({ id, result: { session: { sessionId, mode: "build", model: FAKE_MODEL } } }) + NL);
        return;
      }
      case "session/read": {
        // Exact-session read surface (installed strict contract: sessionId
        // alone); the snapshot's session carries model + workspace association.
        const s = sessions.get(params.sessionId);
        if (!s) {
          process.stdout.write(JSON.stringify({ id, error: { code: -32602, message: "Session is not active: " + params.sessionId } }) + NL);
          return;
        }
        process.stdout.write(JSON.stringify({
          id,
          result: { session: { sessionId: params.sessionId, model: s.model, thoughtLevel: s.thoughtLevel ?? null, workspace: s.workspace } },
        }) + NL);
        return;
      }
      case "session/setModel": {
        const sess = sessions.get(params.sessionId);
        if (!sess) {
          process.stdout.write(JSON.stringify({ id, error: { code: -32602, message: "Session is not active: " + params.sessionId } }) + NL);
          return;
        }
        if (params.model?.providerId !== sess.model.providerId || !AVAILABLE_MODELS.has(params.model?.modelId)) {
          const available = [...AVAILABLE_MODELS].map((m) => sess.model.providerId + "/" + m).join(", ");
          process.stdout.write(JSON.stringify({
            id,
            error: { code: -32603, message: "Unsupported model: " + (params.model?.providerId ?? "?") + "/" + (params.model?.modelId ?? "?") + ". Available models: main, " + available + "." },
          }) + NL);
          return;
        }
        sess.model = { providerId: sess.model.providerId, modelId: params.model.modelId };
        process.stdout.write(JSON.stringify({ id, result: { sessionId: params.sessionId, model: sess.model } }) + NL);
        return;
      }
      case "session/setThoughtLevel": {
        const sess = sessions.get(params.sessionId);
        if (!sess) {
          process.stdout.write(JSON.stringify({ id, error: { code: -32602, message: "Session is not active: " + params.sessionId } }) + NL);
          return;
        }
        if (!params.thoughtLevel || !THOUGHT_LEVELS.has(params.thoughtLevel)) {
          process.stdout.write(JSON.stringify({ id, error: { code: -32602, message: "unsupported thoughtLevel: " + String(params.thoughtLevel) } }) + NL);
          return;
        }
        sess.thoughtLevel = params.thoughtLevel;
        process.stdout.write(JSON.stringify({ id, result: { sessionId: params.sessionId, thoughtLevel: sess.thoughtLevel } }) + NL);
        return;
      }
      case "session/send": {
        const { sessionId, content } = params;
        const s = sessions.get(sessionId);
        if (s) { s.instruction = content; s.replied = true; }
        process.stdout.write(JSON.stringify({ id, result: { accepted: true, sessionId } }) + NL);
        emit({ method: "state.updated", params: { scope: "session", sessionId, reason: "prompt_started", patch: { status: "running" }, type: "state.updated" } });
        setTimeout(() => {
          emit({ method: "state.updated", params: { scope: "session", sessionId, reason: "prompt_completed", patch: { status: "idle" }, type: "state.updated" } });
        }, 150);
        return;
      }
      case "session/stop":
        process.stdout.write(JSON.stringify({ id, result: {} }) + NL);
        return;
      case "session/list": {
        const list = [...sessions.entries()].map(([sessionId, s]) => ({
          sessionId,
          status: "idle",
          workspace: { workspacePath: params.workspace?.workspacePath ?? "", workspaceKey: params.workspace?.workspaceKey ?? "" },
          title: s.instruction?.slice(0, 30) ?? "fake",
          model: s.model,
          updatedAt: Date.now(),
        }));
        process.stdout.write(JSON.stringify({ id, result: { sessions: list } }) + NL);
        return;
      }
      case "session/messages": {
        const s = sessions.get(params.sessionId);
        const messages = [];
        if (s?.instruction) {
          messages.push({ info: { role: "user" }, parts: [{ type: "text", text: s.instruction }] });
          messages.push({
            info: { role: "assistant" },
            parts: [{ type: "text", text: "FAKE_OK:" + s.instruction }],
          });
        }
        process.stdout.write(JSON.stringify({ id, result: { messages } }) + NL);
        return;
      }
      case "session/resume":
        process.stdout.write(JSON.stringify({ id, result: { sessionId: params.sessionId } }) + NL);
        return;
      default:
        process.stdout.write(JSON.stringify({ id, result: { fake: true } }) + NL);
    }
    return;
  }
  if (msg && msg.method === "fake/notify") {
    emit({ method: "state.updated", params: msg.params ?? {} });
  }
});

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + NL);
}
process.on("SIGTERM", () => process.exit(0));
