/**
 * Full-access local control surface for the Omnigent meta-harness.
 *
 * Unlike the hardened G1 OmnigentBackend (codex-only task pipeline), this
 * module exposes the whole Sessions API the local operator elected to share
 * with ChatGPT: per-provider agent registration, session creation with
 * optional git worktrees, instruction submission, bounded transcript reads,
 * follow-up steering and cancellation. It is loopback-only by construction
 * (see loopbackUrl) and never transports Omnigent error bodies or secrets.
 */
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { ensureDir, getStateDir, writeSecureJson } from "../config/paths.js";
import { sanitizeExecutionOutput } from "./sanitize.js";
import {
  DEFAULT_OMNIGENT_URL,
  OmnigentError,
  loopbackUrl,
  object,
  omnigentId,
  protocolError,
  type OmnigentClientOptions,
} from "./omnigent-client.js";

// Gemini is deliberately NOT an Omnigent provider: on native Windows the
// antigravity-native (tmux/PTY) harness cannot register, and the antigravity
// SDK harness is the Developer-API route the operator rejected. provider=gemini
// is served by C2C's direct AntigravityBackend (agy.exe + Google OAuth) via
// submit_codex_task instead.
export const OMNIGENT_PROVIDERS = ["codex", "glm"] as const;
export type OmnigentProvider = (typeof OMNIGENT_PROVIDERS)[number];
export const OMNIGENT_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type OmnigentEffort = (typeof OMNIGENT_EFFORTS)[number];
export const OMNIGENT_SPEED_PROFILES = ["fastest", "fast", "balanced", "quality", "max"] as const;
export type OmnigentSpeedProfile = (typeof OMNIGENT_SPEED_PROFILES)[number];

const PROVIDER_EFFORTS: Record<OmnigentProvider, ReadonlySet<OmnigentEffort>> = {
  codex: new Set(OMNIGENT_EFFORTS),
  glm: new Set(),
};
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,255}$/;
const MAX_TOKENS = Number.MAX_SAFE_INTEGER;
const MAX_COST_USD = 1_000_000_000;
const MAX_LATENCY_MS = 7 * 24 * 60 * 60 * 1000;

function providerHarnesses(): Record<OmnigentProvider, string> {
  return {
    codex: "codex",
    // Custom ACP agent slug from Omnigent's local configuration.
    glm: process.env.C2C_OMNIGENT_GLM_HARNESS ?? "acp:glm-5-3-flash",
  };
}

const PROVIDER_AGENT_NAME: Record<OmnigentProvider, string> = {
  codex: "c2c-omnigent-codex",
  glm: "c2c-omnigent-glm",
};

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;

export function sanitizeOmnigentInstruction(raw: string): string {
  // Mirrors the G1 rule: the bridge must not become a credential transport.
  const sanitized = sanitizeExecutionOutput(raw.replace(
    /\b((?:access[_-]?token|refresh[_-]?token|client[_-]?secret|token|cookie|password|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"';]+/gi,
    "$1[REDACTED]"
  ));
  if (!sanitized.allowed || sanitized.text.includes("[REDACTED]")) {
    throw new OmnigentError("SENSITIVE_TASK_INPUT", "Remove credentials from the instruction before submitting it to Omnigent");
  }
  return sanitized.text;
}

/** Minimal ustar single-file archive — the bundle shape verified against the live server. */
function tarGzSingleFile(fileName: string, content: string): Uint8Array {
  const header = Buffer.alloc(512);
  header.write(fileName, 0, Math.min(fileName.length, 100), "utf8");
  header.write("0000600\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${Buffer.byteLength(content).toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
  const body = Buffer.from(content, "utf8");
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, body, padding, Buffer.alloc(1024)]));
}

function providerConfigYaml(provider: OmnigentProvider, harness: string): string {
  return [
    "spec_version: 1",
    `name: ${PROVIDER_AGENT_NAME[provider]}`,
    `description: C2C-controlled ${provider} coding worker on the ${harness} harness`,
    "instructions: |",
    "  You are a careful coding agent working on behalf of the C2C bridge.",
    "  Follow the task instruction exactly. Stay inside the assigned workspace,",
    "  never widen your own permissions, and never push, merge, or rewrite git",
    "  history unless the task explicitly says so.",
    "executor:",
    "  config:",
    `    harness: ${JSON.stringify(harness)}`,
    "",
  ].join("\n");
}

interface ProviderAgentMap {
  version: 1;
  providers: Partial<Record<OmnigentProvider, string>>;
}

interface SessionBinding {
  taskId: string;
  provider: OmnigentProvider;
  harness: string;
  agentId?: string;
  modelRequested?: string | null;
  modelEffective?: string;
  effortRequested?: OmnigentEffort | null;
  cancellation?: {
    confirmed: true;
    hard: boolean;
    confirmedAt: string;
  };
}

function loadProviderAgents(file: string): ProviderAgentMap {
  if (!fs.existsSync(file)) return { version: 1, providers: {} };
  const value = object(JSON.parse(fs.readFileSync(file, "utf8")));
  if (value.version !== 1 || typeof value.providers !== "object" || value.providers === null) throw protocolError();
  const providers: ProviderAgentMap["providers"] = {};
  for (const [provider, id] of Object.entries(value.providers)) {
    // Tolerate entries for providers that have since left the mapping (e.g. a
    // persisted gemini anchor) instead of poisoning every later load.
    if (!(OMNIGENT_PROVIDERS as readonly string[]).includes(provider)) continue;
    providers[provider as OmnigentProvider] = omnigentId(id);
  }
  return { version: 1, providers };
}

export interface OmnigentSubmitInput {
  provider: OmnigentProvider;
  workspacePath: string;
  instruction: string;
  branchName?: string;
  title?: string;
  model?: string;
  effort?: OmnigentEffort;
  speedProfile?: OmnigentSpeedProfile;
}

export interface OmnigentTaskView {
  taskId: string;
  provider?: OmnigentProvider;
  title: string | null;
  status: string;
  underlyingStatus?: string;
  harness: string | null;
  branch: string | null;
  workspacePath: string | null;
  runnerOnline: boolean | null;
  reportedModel: string | null;
  modelRequested: string | null;
  modelEffective: string | null;
  effortRequested: OmnigentEffort | null;
  effortEffective: OmnigentEffort | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  timeToFirstTokenMs: number | null;
  attemptCount: number | null;
  startedAt: string | null;
  completedAt: string | null;
  totalCostUsd: number | null;
  usageByModel: Record<string, OmnigentModelUsage> | null;
  error: { code: string; message: string } | null;
  output?: string;
}

export interface OmnigentModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
}

function optionalModel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !MODEL_PATTERN.test(value)) throw protocolError();
  return value;
}

function requestedModel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!MODEL_PATTERN.test(value)) {
    throw new OmnigentError("OMNIGENT_MODEL_INVALID", "model must be a valid model id of at most 256 characters");
  }
  return value;
}

function requestedEffort(provider: OmnigentProvider, value: OmnigentEffort | undefined): OmnigentEffort | undefined {
  if (value === undefined) return undefined;
  if (!PROVIDER_EFFORTS[provider].has(value)) {
    throw new OmnigentError(
      "OMNIGENT_CONTROL_UNSUPPORTED",
      provider === "glm"
        ? "effort is not supported by the configured GLM ACP harness"
        : `effort=${value} is not supported by provider=${provider}`
    );
  }
  return value;
}

function rejectSpeedProfile(value: OmnigentSpeedProfile | undefined): void {
  if (value !== undefined) {
    throw new OmnigentError(
      "OMNIGENT_CONTROL_UNSUPPORTED",
      "speed_profile is not supported by the installed Omnigent Sessions API"
    );
  }
}

function optionalEffort(value: unknown): OmnigentEffort | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !(OMNIGENT_EFFORTS as readonly string[]).includes(value)) throw protocolError();
  return value as OmnigentEffort;
}

function optionalInteger(value: unknown, max = MAX_TOKENS): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw protocolError();
  return value;
}

function optionalCost(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_COST_USD) throw protocolError();
  return value;
}

function optionalTimestamp(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw protocolError();
  }
  return value;
}

function aliasedInteger(source: Record<string, unknown>, names: readonly string[]): number | null {
  const present = names.filter((name) => source[name] !== undefined && source[name] !== null);
  if (present.length === 0) return null;
  const values = present.map((name) => optionalInteger(source[name]));
  if (values.some((value) => value !== values[0])) throw protocolError();
  return values[0];
}

function usageByModel(value: unknown): Record<string, OmnigentModelUsage> | null {
  if (value === undefined || value === null) return null;
  const map = object(value);
  const entries = Object.entries(map);
  if (entries.length === 0 || entries.length > 100) return entries.length === 0 ? null : (() => { throw protocolError(); })();
  const result: Record<string, OmnigentModelUsage> = {};
  for (const [model, raw] of entries) {
    if (!model || model.length > 256 || /[\u0000-\u001f\u007f]/.test(model) || ["__proto__", "prototype", "constructor"].includes(model)) {
      throw protocolError();
    }
    const usage = object(raw);
    result[model] = {
      inputTokens: aliasedInteger(usage, ["input_tokens", "promptTokens"]),
      outputTokens: aliasedInteger(usage, ["output_tokens", "candidatesTokens"]),
      reasoningTokens: aliasedInteger(usage, ["reasoning_tokens", "thoughtsTokens"]),
      cachedTokens: aliasedInteger(usage, ["cache_read_input_tokens", "cachedTokens"]),
      totalTokens: aliasedInteger(usage, ["total_tokens", "totalTokens"]),
      costUsd: (() => {
        const canonical = optionalCost(usage.total_cost_usd);
        const camel = optionalCost(usage.costUsd);
        if (canonical !== null && camel !== null && canonical !== camel) throw protocolError();
        return canonical ?? camel;
      })(),
    };
  }
  return result;
}

function sumComplete(
  usage: Record<string, OmnigentModelUsage> | null,
  field: keyof Pick<OmnigentModelUsage, "inputTokens" | "outputTokens" | "reasoningTokens" | "cachedTokens" | "totalTokens">
): number | null {
  if (!usage) return null;
  const values = Object.values(usage).map((entry) => entry[field]);
  if (values.some((value) => value === null)) return null;
  const sum = (values as number[]).reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(sum) || sum > MAX_TOKENS) throw protocolError();
  return sum;
}

export interface OmnigentControlOptions extends OmnigentClientOptions {
  stateDir?: string;
}

function validOmnigentId(value: unknown): string | null {
  try {
    return omnigentId(value);
  } catch {
    return null;
  }
}

export class OmnigentControl {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly agentsFile: string;
  private agents: ProviderAgentMap | undefined;
  private readonly harnesses = providerHarnesses();

  private bindingFile(taskId: string): string {
    return path.join(path.dirname(this.agentsFile), "control-sessions", `${omnigentId(taskId)}.json`);
  }

  private readBinding(taskId: string): SessionBinding | null {
    const file = this.bindingFile(taskId);
    if (!fs.existsSync(file)) return null;
    const stored = object(JSON.parse(fs.readFileSync(file, "utf8")));
    const cancellation = stored.cancellation === undefined ? undefined : object(stored.cancellation);
    if (cancellation && (cancellation.confirmed !== true || typeof cancellation.hard !== "boolean" ||
        typeof cancellation.confirmedAt !== "string" || cancellation.confirmedAt.length > 64)) {
      throw protocolError();
    }
    if (stored.modelRequested !== undefined && stored.modelRequested !== null) optionalModel(stored.modelRequested);
    if (stored.modelEffective !== undefined) optionalModel(stored.modelEffective);
    if (stored.effortRequested !== undefined && stored.effortRequested !== null) optionalEffort(stored.effortRequested);
    return stored as unknown as SessionBinding;
  }

  private writeBinding(binding: SessionBinding): void {
    writeSecureJson(this.bindingFile(binding.taskId), binding);
  }

  private setCancellation(taskId: string, cancellation?: SessionBinding["cancellation"]): void {
    const stored = this.readBinding(taskId);
    if (!stored) throw protocolError();
    const { cancellation: _previous, ...identity } = stored;
    writeSecureJson(this.bindingFile(taskId), cancellation ? { ...identity, cancellation } : identity);
  }

  private bindSession(
    taskId: string,
    harness: string | null,
    requested?: OmnigentProvider,
    createdWithAgentId?: string,
    observedAgentId?: unknown,
    controls?: { modelRequested: string | null; effortRequested: OmnigentEffort | null }
  ): SessionBinding {
    const file = this.bindingFile(taskId);
    const stored = this.readBinding(taskId);
    // Existing bindings survive configuration changes. Legacy sessions may be
    // adopted only when their observed harness maps to a known provider. A
    // newly-created session is trusted from the provider-specific agent used
    // in its create request, before its runner has populated snapshot.harness.
    const provider = stored?.provider ?? (createdWithAgentId !== undefined
      ? requested
      : OMNIGENT_PROVIDERS.find((candidate) => this.harnesses[candidate] === harness));
    const expectedHarness = stored?.harness ??
      (createdWithAgentId !== undefined && provider ? this.harnesses[provider as OmnigentProvider] : harness);
    const storedAgentId = validOmnigentId(stored?.agentId);
    const genericAcpMatchesPersistedAgent = stored !== null && harness === "acp" &&
      expectedHarness?.startsWith("acp:") === true && storedAgentId !== null &&
      validOmnigentId(observedAgentId) === storedAgentId;
    if (!OMNIGENT_PROVIDERS.includes(provider as OmnigentProvider) || typeof expectedHarness !== "string" ||
        (stored && (stored.taskId !== taskId || typeof stored.harness !== "string")) ||
        (stored && createdWithAgentId !== undefined && stored.agentId !== undefined &&
          stored.agentId !== createdWithAgentId) ||
        (harness !== null && harness !== expectedHarness && !genericAcpMatchesPersistedAgent) ||
        (requested !== undefined && requested !== provider) ||
        (!stored && harness === null && createdWithAgentId === undefined)) {
      throw new OmnigentError("OMNIGENT_PROVIDER_MISMATCH", "Session provider/harness does not match its immutable binding or requested provider");
    }
    if (!stored) {
      const binding: SessionBinding = {
        taskId,
        provider: provider as OmnigentProvider,
        harness: expectedHarness,
        ...(createdWithAgentId === undefined ? {} : { agentId: omnigentId(createdWithAgentId) }),
        ...(controls === undefined ? {} : controls),
      };
      this.writeBinding(binding);
      return binding;
    }
    if (controls &&
        (stored.modelRequested !== controls.modelRequested || stored.effortRequested !== controls.effortRequested)) {
      throw new OmnigentError(
        "OMNIGENT_CONTROL_MISMATCH",
        "Session model and effort controls are immutable for C2C continuations"
      );
    }
    return stored;
  }

  private assertContinuationControls(
    binding: SessionBinding,
    model: string | undefined,
    effort: OmnigentEffort | undefined,
    speedProfile: OmnigentSpeedProfile | undefined
  ): void {
    rejectSpeedProfile(speedProfile);
    const checkedModel = requestedModel(model);
    const checkedEffort = requestedEffort(binding.provider, effort);
    if ((checkedModel !== undefined && checkedModel !== binding.modelRequested) ||
        (checkedEffort !== undefined && checkedEffort !== binding.effortRequested)) {
      throw new OmnigentError(
        "OMNIGENT_CONTROL_MISMATCH",
        "Session model and effort controls are immutable for C2C continuations"
      );
    }
  }

  constructor(options: OmnigentControlOptions = {}) {
    this.baseUrl = loopbackUrl(options.baseUrl ?? process.env.C2C_OMNIGENT_URL ?? DEFAULT_OMNIGENT_URL);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = Math.max(10, Math.min(30_000, options.requestTimeoutMs ?? 15_000));
    this.agentsFile = path.join(ensureDir(getStateDir(options.stateDir)), "omnigent", "agents.json");
  }

  private async request(route: string, init: RequestInit): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl}${route}`, {
        ...init, signal: controller.signal, redirect: "error", credentials: "omit",
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new OmnigentError(
          "OMNIGENT_REQUEST_FAILED",
          `Omnigent request failed with HTTP ${response.status}`);
      }
      if (!response.body) throw protocolError();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw protocolError();
        chunks.push(chunk.value);
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      return object(JSON.parse(text));
    } catch (error) {
      if (error instanceof OmnigentError) throw error;
      if (controller.signal.aborted) {
        throw new OmnigentError("OMNIGENT_UNAVAILABLE", "Omnigent could not be reached within the local request limit");
      }
      throw protocolError();
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private async providerAgentId(provider: OmnigentProvider): Promise<string> {
    this.agents ??= loadProviderAgents(this.agentsFile);
    const known = this.agents.providers[provider];
    if (known) return known;
    // There is no standalone agent-registration API on the local build: a
    // multipart session create both validates the bundle and yields a
    // reusable session-scoped agent id (verified against the live server).
    // The anchor session stays alive so the agent row is never reaped.
    const form = new FormData();
    form.set("metadata", JSON.stringify({
      title: `c2c agent anchor (${provider})`,
      labels: { "c2c.anchor": provider },
    }));
    form.set("bundle", new Blob(
      [new Uint8Array(tarGzSingleFile("config.yaml", providerConfigYaml(provider, this.harnesses[provider])))],
      { type: "application/gzip" }
    ), "agent.tar.gz");
    const created = await this.request("/v1/sessions", { method: "POST", body: form });
    const agentId = omnigentId(created.agent_id);
    omnigentId(created.session_id); // The anchor conversation id must also be a well-formed id.
    this.agents.providers[provider] = agentId;
    writeSecureJson(this.agentsFile, this.agents);
    return agentId;
  }

  private async onlineHostId(): Promise<string> {
    const listed = await this.request("/v1/hosts", { method: "GET" });
    if (!Array.isArray(listed.hosts)) throw protocolError();
    for (const raw of listed.hosts) {
      const host = object(raw);
      if (host.status === "online" && typeof host.host_id === "string") return omnigentId(host.host_id);
    }
    throw new OmnigentError("OMNIGENT_HOST_OFFLINE", "No online Omnigent host is registered");
  }

  private async postMessage(taskId: string, instruction: string): Promise<void> {
    const ack = await this.request(`/v1/sessions/${omnigentId(taskId)}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "message",
        data: { role: "user", content: [{ type: "input_text", text: instruction }] },
      }),
    });
    if (ack.queued !== true) throw protocolError();
  }

  async status(): Promise<Record<string, unknown>> {
    const health = await this.request("/health", { method: "GET" });
    this.agents ??= loadProviderAgents(this.agentsFile);
    const agents = this.agents;
    let hosts: unknown = null;
    let harnesses: unknown = null;
    try {
      const listed = await this.request("/v1/hosts", { method: "GET" });
      hosts = Array.isArray(listed.hosts)
        ? listed.hosts.map((raw) => {
            const host = object(raw);
            return { hostId: host.host_id, name: host.name ?? null, status: host.status ?? null };
          })
        : null;
    } catch { hosts = null; }
    try {
      const catalog = await this.request("/v1/harnesses", { method: "GET" });
      harnesses = Array.isArray(catalog.data)
        ? catalog.data
            .map((raw) => object(raw))
            .filter((h) => {
              const id = String(h.id ?? "");
              return Object.values(this.harnesses).includes(id);
            })
            .map((h) => ({ id: h.id, capabilities: object(h.capabilities ?? {}),
              ready: typeof h.ready === "boolean" ? h.ready : typeof h.available === "boolean" ? h.available : null }))
        : null;
    } catch { harnesses = null; }
    return {
      health: health.status ?? null,
      baseUrl: this.baseUrl,
      hosts,
      harnesses,
      providers: Object.fromEntries(OMNIGENT_PROVIDERS.map((provider) => [
        provider,
        { harness: this.harnesses[provider], agentName: PROVIDER_AGENT_NAME[provider], agentId: agents.providers[provider] ?? null,
          discovered: Array.isArray(harnesses) ? harnesses.some((h) => h.id === this.harnesses[provider]) : null,
          ready: !Array.isArray(hosts) ? null : !hosts.some((h) => h.status === "online") ? false :
            !Array.isArray(harnesses) ? null : harnesses.find((h) => h.id === this.harnesses[provider])?.ready ??
              (harnesses.some((h) => h.id === this.harnesses[provider]) ? null : false),
        },
      ])),
    };
  }

  async submitTask(input: OmnigentSubmitInput): Promise<OmnigentTaskView> {
    const text = sanitizeOmnigentInstruction(input.instruction);
    rejectSpeedProfile(input.speedProfile);
    const model = requestedModel(input.model);
    const effort = requestedEffort(input.provider, input.effort);
    const catalog = await this.request("/v1/harnesses", { method: "GET" });
    if (!Array.isArray(catalog.data)) throw protocolError();
    const harness = catalog.data.map(object).find((h) => h.id === this.harnesses[input.provider]);
    if (!harness || harness.ready === false || harness.available === false) {
      throw new OmnigentError("OMNIGENT_PROVIDER_UNAVAILABLE", "The requested provider harness is unavailable; no fallback is permitted");
    }
    const agentId = await this.providerAgentId(input.provider);
    const hostId = await this.onlineHostId();
    const metadata: Record<string, unknown> = {
      agent_id: agentId,
      host_id: hostId,
      workspace: input.workspacePath,
      labels: { "c2c.controlled": "true" },
    };
    if (input.branchName) metadata.git = { branch_name: input.branchName };
    if (input.title) metadata.title = input.title.slice(0, 200);
    if (model) metadata.model_override = model;
    if (effort) metadata.reasoning_effort = effort;
    const created = await this.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metadata),
    });
    const taskId = omnigentId(created.id);
    if (created.agent_id !== undefined && omnigentId(created.agent_id) !== agentId) {
      throw new OmnigentError("OMNIGENT_PROVIDER_MISMATCH", "Created session agent does not match the requested provider agent");
    }
    const provider = this.bindSession(taskId, null, input.provider, agentId, undefined, {
      modelRequested: model ?? null,
      effortRequested: effort ?? null,
    }).provider;
    const view = await this.taskStatus(taskId, false);
    if (view.status === "failed") throw new OmnigentError("OMNIGENT_PROVIDER_UNAVAILABLE", "The requested provider session failed to start; no fallback is permitted");
    await this.postMessage(taskId, text);
    return {
      taskId,
      provider,
      title: typeof created.title === "string" ? created.title : null,
      status: "submitted",
      harness: view.harness,
      branch: typeof created.git_branch === "string" ? created.git_branch : input.branchName ?? null,
      workspacePath: typeof created.workspace === "string" ? created.workspace : input.workspacePath,
      runnerOnline: null,
      reportedModel: view.reportedModel,
      modelRequested: model ?? null,
      modelEffective: view.modelEffective,
      effortRequested: effort ?? null,
      effortEffective: view.effortEffective,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cachedTokens: null,
      totalTokens: null,
      costUsd: null,
      latencyMs: null,
      timeToFirstTokenMs: null,
      attemptCount: null,
      startedAt: null,
      completedAt: null,
      totalCostUsd: null,
      usageByModel: null,
      error: null,
    };
  }

  async followUp(
    taskId: string,
    instruction: string,
    provider?: OmnigentProvider,
    controls: { model?: string; effort?: OmnigentEffort; speedProfile?: OmnigentSpeedProfile } = {}
  ): Promise<OmnigentTaskView> {
    const text = sanitizeOmnigentInstruction(instruction);
    rejectSpeedProfile(controls.speedProfile);
    requestedModel(controls.model);
    const view = await this.taskStatus(taskId, false, provider);
    const binding = this.readBinding(taskId);
    if (!binding) throw protocolError();
    this.assertContinuationControls(binding, controls.model, controls.effort, controls.speedProfile);
    await this.postMessage(omnigentId(taskId), text);
    this.setCancellation(taskId);
    if (view.underlyingStatus !== undefined) {
      view.status = view.underlyingStatus;
      delete view.underlyingStatus;
    }
    return view;
  }

  async cancel(taskId: string, hard = false): Promise<void> {
    await this.taskStatus(taskId, false);
    for (const type of hard ? ["interrupt", "stop_session"] : ["interrupt"]) {
      const ack = await this.request(`/v1/sessions/${omnigentId(taskId)}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, data: {} }),
      });
      if (ack.queued !== false) throw protocolError();
    }
    this.setCancellation(taskId, {
      confirmed: true,
      hard,
      confirmedAt: new Date().toISOString(),
    });
  }

  private async collectOutput(taskId: string): Promise<string> {
    const page = await this.request(`/v1/sessions/${omnigentId(taskId)}/items?limit=200&order=asc`, { method: "GET" });
    if (!Array.isArray(page.data)) throw protocolError();
    const parts: string[] = [];
    let bytes = 0;
    for (const raw of page.data) {
      const item = object(raw);
      if (item.type !== "message" || item.role !== "assistant" || item.status !== "completed") continue;
      if (!Array.isArray(item.content)) continue;
      for (const rawBlock of item.content) {
        const block = object(rawBlock);
        if (block.type !== "output_text" && block.type !== "text") continue;
        if (typeof block.text !== "string") continue;
        bytes += Buffer.byteLength(block.text);
        if (bytes > MAX_OUTPUT_BYTES) break;
        parts.push(block.text);
      }
    }
    const sanitized = sanitizeExecutionOutput(parts.join("\n"));
    return sanitized.allowed ? sanitized.text : "[Omnigent output withheld by C2C sanitization]";
  }

  async taskStatus(
    taskId: string,
    includeOutput = false,
    requested?: OmnigentProvider
  ): Promise<OmnigentTaskView> {
    const snapshot = await this.request(`/v1/sessions/${omnigentId(taskId)}`, { method: "GET" });
    if (omnigentId(snapshot.id) !== taskId) throw protocolError();
    const rawError = object(snapshot.last_task_error ?? {});
    const underlyingStatus = typeof snapshot.status === "string" ? snapshot.status.slice(0, 64) : "unknown";
    const modelRequested = optionalModel(snapshot.model_override);
    const llmModel = optionalModel(snapshot.llm_model);
    const reportedModel = optionalModel(snapshot.reported_model);
    if (llmModel !== null && reportedModel !== null && llmModel !== reportedModel) throw protocolError();
    const modelEffective = reportedModel ?? llmModel;
    const effortRequested = optionalEffort(snapshot.reasoning_effort);
    const effortEffective = optionalEffort(snapshot.effective_reasoning_effort);
    const perModelUsage = usageByModel(snapshot.usage_by_model);
    const costUsd = optionalCost(snapshot.total_cost_usd);
    const attemptCount = optionalInteger(snapshot.attempt_count, 1_000_000);
    if (attemptCount === 0) throw protocolError();
    const view: OmnigentTaskView = {
      taskId: omnigentId(snapshot.id),
      title: typeof snapshot.title === "string" ? snapshot.title : null,
      status: underlyingStatus,
      harness: typeof snapshot.harness === "string" ? snapshot.harness : null,
      branch: typeof snapshot.git_branch === "string" ? snapshot.git_branch : null,
      workspacePath: typeof snapshot.workspace === "string" ? snapshot.workspace : null,
      runnerOnline: typeof snapshot.runner_online === "boolean" ? snapshot.runner_online : null,
      reportedModel: modelEffective,
      modelRequested,
      modelEffective,
      effortRequested,
      effortEffective,
      inputTokens: sumComplete(perModelUsage, "inputTokens"),
      outputTokens: sumComplete(perModelUsage, "outputTokens"),
      reasoningTokens: sumComplete(perModelUsage, "reasoningTokens"),
      cachedTokens: sumComplete(perModelUsage, "cachedTokens"),
      totalTokens: sumComplete(perModelUsage, "totalTokens"),
      costUsd,
      latencyMs: optionalInteger(snapshot.latency_ms, MAX_LATENCY_MS),
      timeToFirstTokenMs: optionalInteger(snapshot.time_to_first_token_ms, MAX_LATENCY_MS),
      attemptCount,
      startedAt: optionalTimestamp(snapshot.started_at),
      completedAt: optionalTimestamp(snapshot.completed_at),
      totalCostUsd: costUsd,
      usageByModel: perModelUsage,
      error: rawError.code || rawError.message
        ? { code: String(rawError.code ?? "UNKNOWN"), message: String(rawError.message ?? "") }
        : null,
    };
    const binding = this.bindSession(taskId, view.harness, requested, undefined, snapshot.agent_id);
    if ((binding.modelRequested !== undefined && binding.modelRequested !== modelRequested) ||
        (binding.effortRequested !== undefined && binding.effortRequested !== effortRequested) ||
        (binding.modelEffective !== undefined && modelEffective !== null && binding.modelEffective !== modelEffective)) {
      throw new OmnigentError(
        "OMNIGENT_CONTROL_MISMATCH",
        "Session model or effort no longer matches its immutable C2C binding"
      );
    }
    if (binding.modelRequested === undefined || binding.effortRequested === undefined ||
        (binding.modelEffective === undefined && modelEffective !== null)) {
      const enriched: SessionBinding = {
        ...binding,
        modelRequested: binding.modelRequested ?? modelRequested,
        effortRequested: binding.effortRequested ?? effortRequested,
        ...(binding.modelEffective === undefined && modelEffective !== null ? { modelEffective } : {}),
      };
      this.writeBinding(enriched);
    }
    view.provider = binding.provider;
    if (binding.cancellation?.confirmed) {
      view.status = "cancelled";
      view.underlyingStatus = underlyingStatus;
    }
    if (includeOutput && (underlyingStatus === "idle" || underlyingStatus === "failed")) {
      view.output = await this.collectOutput(taskId);
    }
    return view;
  }

  async listSessions(limit: number): Promise<Record<string, unknown>[]> {
    const listed = await this.request(`/v1/sessions?limit=${Math.max(1, Math.min(50, limit))}`, { method: "GET" });
    if (!Array.isArray(listed.data)) throw protocolError();
    return listed.data.map((raw) => {
      const session = object(raw);
      return {
        taskId: typeof session.id === "string" ? session.id : null,
        title: session.title ?? null,
        status: session.status ?? null,
        harness: session.harness ?? null,
        branch: typeof session.git_branch === "string" ? session.git_branch : null,
        updatedAt: session.updated_at ?? null,
      };
    });
  }
}

export type { OmnigentClientOptions };
