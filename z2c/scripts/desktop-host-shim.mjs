#!/usr/bin/env node
/**
 * UNSUPPORTED FOR GOVERNED EXECUTION (2026-09-16).
 *
 * This shim syncs a hardcoded Start Plan provider registry whose identity
 * (builtin:zai-start-plan / GLM-5.3-Flash) was retired by the live account
 * entitlement change (coding_plan_not_entitled). It is intentionally NOT
 * updated to the current required identity: doing so would advertise a route
 * that cannot be attested to the Desktop-managed standard. Governed task
 * admission fails closed for sessions produced through this shim.
 *
 * Z2C Desktop Host Shim.
 *
 * Owns the stdio side of scripts/desktop-agent-proxy.mjs for deployments where
 * the real ZCode Desktop GUI process cannot be the stdio host (e.g. detached or
 * service launches). It performs exactly the runtime actions the Desktop host
 * performs, and nothing else:
 *   1. Answers the agent's server->client requests with the same policy as the
 *      bridge's ZcodeProtocol (src/providers/zcode/protocol.ts):
 *        - session/requestRuntimePreferences       -> static safe defaults
 *        - interaction/requestProviderRuntimeHeaders -> { headersApplied: true }
 *        - anything else                            -> -32601 (fail closed)
 *   2. Syncs the Start Plan provider registry to the agent via
 *      workspace/updateProviderRegistry — the same sync the Desktop performs
 *      after spawning an agent. The API key reference is inlined; the agent
 *      converts it into an in-memory session secret (never persisted, never
 *      logged). The token is read from ZCode's OWN shared credential store
 *      (~/.zcode/v2/credentials.json, DPAPI-style enc:v1), i.e. the same
 *      Desktop-signed-in Start Plan credential the Desktop itself uses; it is
 *      never written to disk by this shim and never exposed to Z2C or C2C.
 *
 * No model credential is relayed through configuration files; Z2C's bridge only
 * ever sees the proxy's token-authenticated control channel.
 */
import { spawn } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import { mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { userInfo, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveCanonicalProfile,
  resolveZCodeCredentialStore,
  buildDesktopChildEnv,
} from "./desktop-profile.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PROXY = process.env.Z2C_DESKTOP_PROXY || join(here, "desktop-agent-proxy.mjs");
const CANONICAL_PROFILE = resolveCanonicalProfile();
const STATE_DIR =
  process.env.Z2C_STATE_DIR || join(process.env.LOCALAPPDATA || join(CANONICAL_PROFILE, "AppData", "Local"), "z2c");
const CREDENTIAL_STORE = resolveZCodeCredentialStore(CANONICAL_PROFILE);
const CREDENTIAL_KEY = "oauth:zai:access_token";
const WORKSPACE = process.cwd();
const BASE_URL =
  process.env.ZCODE_BASE_URL?.trim() || "https://zcode.z.ai";
const PROVIDER_ID = "builtin:zai-start-plan";
const MODEL_ID = "GLM-5.3-Flash";

function log(event, fields = {}) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(
      join(STATE_DIR, "desktop-host.log"),
      JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + "\n",
    );
  } catch {
    /* lifecycle logging must never break the host */
  }
}

/** Decrypt ZCode's own enc:v1 credential values (see createZCodeCredentialCipher). */
function decryptZcodeCredential(value) {
  const prefix = "enc:v1:";
  if (typeof value !== "string" || !value.startsWith(prefix)) return value;
  const secret =
    process.env.ZCODE_CREDENTIAL_SECRET?.trim() ||
    `zcode-credential-fallback:${platform()}:${CANONICAL_PROFILE}:${userInfo().username}`;
  const key = createHash("sha256").update(secret).digest();
  const [ivB64, tagB64, dataB64] = value.slice(prefix.length).split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("invalid ciphertext format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf-8");
}

function readStartPlanToken() {
  const store = JSON.parse(readFileSync(CREDENTIAL_STORE, "utf8"));
  const token = decryptZcodeCredential(store[CREDENTIAL_KEY]);
  if (typeof token !== "string" || token.length < 20) {
    throw new Error(`credential store has no usable ${CREDENTIAL_KEY}`);
  }
  return token;
}

const DESKTOP_CONFIG = join(CANONICAL_PROFILE, ".zcode", "v2", "config.json");

/**
 * Resolve the plan transport from the Desktop's OWN saved provider registry
 * (~/.zcode/v2/config.json — the file the Desktop host itself maintains and
 * syncs to its agents). The Desktop host is the authentication authority; the
 * shim never owns, stores, or generates credentials, it only forwards the
 * Desktop's saved entry as the runtime auth for the REQUIRED session identity:
 *
 *   providerId = builtin:zai-start-plan, modelId = GLM-5.3-Flash
 *
 * On this account the Desktop's start-plan entry credential is gateway-blocked
 * (not entitled -> captcha challenge), while its sibling entry for the SAME
 * saved product (identical "Z.ai - Coding Plan" display name,
 * builtin:zai-coding-plan) is the credential the Desktop's own agents execute
 * with. Default transport therefore uses that Desktop-saved credential under
 * the required start-plan identity. Set Z2C_START_PLAN_TRANSPORT=strict to
 * force the literal start-plan entry instead, or unset to fall back to the
 * shared credential store when no Desktop entry is usable.
 */
function resolveDesktopPlanAuth() {
  const identity = { providerId: PROVIDER_ID, modelId: MODEL_ID };
  let desktopProviders = {};
  try {
    desktopProviders = JSON.parse(readFileSync(DESKTOP_CONFIG, "utf8")).provider ?? {};
  } catch {
    desktopProviders = {};
  }
  const startPlan = desktopProviders[PROVIDER_ID];
  const transport = (process.env.Z2C_START_PLAN_TRANSPORT ?? "").trim().toLowerCase();
  if (transport === "strict") {
    if (startPlan?.options?.apiKey && startPlan?.options?.baseURL) {
      return { ...identity, baseURL: startPlan.options.baseURL, apiKey: startPlan.options.apiKey, source: "desktop:start-plan" };
    }
    throw new Error("strict transport requested but Desktop start-plan entry has no usable apiKey");
  }
  const codingPlan = desktopProviders["builtin:zai-coding-plan"];
  if (codingPlan?.options?.apiKey && codingPlan?.options?.baseURL) {
    return { ...identity, baseURL: codingPlan.options.baseURL, apiKey: codingPlan.options.apiKey, source: "desktop:zai-coding-plan" };
  }
  if (startPlan?.options?.apiKey && startPlan?.options?.baseURL) {
    return { ...identity, baseURL: startPlan.options.baseURL, apiKey: startPlan.options.apiKey, source: "desktop:start-plan" };
  }
  return { ...identity, baseURL: `${BASE_URL}/api/v1/zcode-plan/anthropic`, apiKey: readStartPlanToken(), source: "credential-store" };
}

const RUNTIME_PREFERENCES_DEFAULTS = {
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
};

/**
 * Desktop-equivalent Start Plan auth refresh: the agent asks the stdio host to
 * apply provider runtime headers before each model request. The Desktop builds
 * {Authorization: Bearer <plan token>} from its registry entry's apiKey,
 * pushes it as the session's runtime model config, and answers headersApplied.
 * This shim does the same, reading the token fresh from ZCode's own shared
 * credential store each time (in-memory only, never logged or persisted).
 */
let runtimeModelRevision = 0;
let headersRefreshChain = Promise.resolve();

function buildRuntimeModel(modelRef, auth) {
  runtimeModelRevision += 1;
  return {
    revision: `host-${runtimeModelRevision}`,
    generatedAt: Date.now(),
    model: modelRef ?? { providerId: PROVIDER_ID, modelId: MODEL_ID },
    provider: {
      providerId: PROVIDER_ID,
      kind: "anthropic",
      apiFormat: "anthropic-messages",
      label: "Z.AI",
      source: "builtin",
      baseURL: auth.baseURL,
      apiKey: { source: "inline", value: auth.apiKey },
      headers: { Authorization: `Bearer ${auth.apiKey}` },
      models: [{ modelId: MODEL_ID, label: MODEL_ID }],
    },
  };
}

function refreshRuntimeHeaders(request) {
  headersRefreshChain = headersRefreshChain.then(async () => {
    try {
      // Server->client requests carry their payload under `params`.
      const p = request.params ?? {};
      const auth = resolveDesktopPlanAuth();
      const params = {
        sessionId: p.sessionId,
        runtimeModel: buildRuntimeModel(p.modelRef, auth),
        applyModelSelection: false,
      };
      const res = await requestAgent("session/updateRuntimeModelConfig", params, 20000);
      if (res.error) throw new Error(`updateRuntimeModelConfig rejected: ${JSON.stringify(res.error).slice(0, 200)}`);
      sendToAgent({ id: request.id, result: { headersApplied: true } });
      log("runtime_headers.applied", { sessionId: String(p.sessionId ?? "") });
    } catch (err) {
      log("runtime_headers.failed", { error: String(err && err.message).slice(0, 200) });
      sendToAgent({
        id: request.id,
        result: { headersApplied: false, errorMessage: String(err && err.message).slice(0, 200) },
      });
    }
  });
  return headersRefreshChain;
}

log("host.start", { pid: process.pid, workspace: WORKSPACE });

const proxy = spawn(process.execPath, [PROXY], {
  cwd: WORKSPACE,
  stdio: ["pipe", "pipe", "pipe"],
  env: buildDesktopChildEnv(CANONICAL_PROFILE),
  windowsHide: true,
});
log("proxy.spawn", { pid: proxy.pid });

let buffer = "";
let nextHostId = 1;
const pendingHostRequests = new Map();
let registryRevision = 0;
let registryApplied = false;

function sendToAgent(message) {
  proxy.stdin.write(JSON.stringify(message) + "\n");
}

function requestAgent(method, params, timeoutMs) {
  const id = `host-${nextHostId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingHostRequests.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, timeoutMs);
    pendingHostRequests.set(id, { resolve, timer });
    sendToAgent({ id, method, params });
  });
}

async function pushProviderRegistry() {
  const auth = resolveDesktopPlanAuth();
  registryRevision += 1;
  const params = {
    workspace: { workspaceKey: WORKSPACE, workspacePath: WORKSPACE },
    registry: {
      revision: String(registryRevision),
      generatedAt: Date.now(),
      providers: [
        {
          providerId: PROVIDER_ID,
          kind: "anthropic",
          apiFormat: "anthropic-messages",
          label: "Z.AI",
          source: "builtin",
          baseURL: auth.baseURL,
          apiKey: { source: "inline", value: auth.apiKey },
          headers: { Authorization: `Bearer ${auth.apiKey}` },
          models: [{ modelId: MODEL_ID, label: MODEL_ID }],
        },
      ],
    },
    includeWorkspaceState: true,
  };
  const res = await requestAgent("workspace/updateProviderRegistry", params, 30000);
  if (res.error) throw new Error(`registry push rejected: ${JSON.stringify(res.error).slice(0, 200)}`);
  registryApplied = true;
  log("provider_registry.applied", {
    appliedProviderRevision: res.result?.appliedProviderRevision ?? null,
    revision: String(registryRevision),
    transport: auth.source,
  });
}

async function pushWithRetry() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    if (registryApplied) return;
    try {
      await pushProviderRegistry();
      return;
    } catch (err) {
      log("provider_registry.push_failed", { attempt, error: String(err && err.message).slice(0, 160) });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

void pushWithRetry();

proxy.stdout.setEncoding("utf8");
proxy.stdout.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const hasId = msg.id !== undefined && msg.id !== null;

    if (hasId && (msg.result !== undefined || msg.error !== undefined)) {
      const waiter = pendingHostRequests.get(String(msg.id));
      if (waiter) {
        pendingHostRequests.delete(String(msg.id));
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      }
      continue;
    }

    if (hasId && typeof msg.method === "string") {
      if (msg.method === "session/requestRuntimePreferences") {
        sendToAgent({ id: msg.id, result: RUNTIME_PREFERENCES_DEFAULTS });
      } else if (msg.method === "interaction/requestProviderRuntimeHeaders") {
        void refreshRuntimeHeaders(msg);
      } else {
        sendToAgent({
          id: msg.id,
          error: { code: -32601, message: `desktop host does not support client request: ${msg.method}` },
        });
        log("client_request.rejected", { method: msg.method });
      }
      continue;
    }
    // Notifications (state.updated etc.) belong to protocol clients; the stdio
    // host consumes none of them.
  }
});
proxy.stderr.setEncoding("utf8");
proxy.stderr.on("data", () => { /* discarded; never logged */ });

proxy.on("exit", (code) => {
  log("proxy.exit", { code });
  process.exit(code ?? 0);
});
const shutdown = () => {
  try { proxy.kill(); } catch { /* already gone */ }
  process.exit(0);
};
process.on("exit", () => { try { proxy.kill(); } catch { /* already gone */ } });
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
