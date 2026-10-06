import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import { CodexAppServerClient, resolveCodexExecutable } from "./app-server.js";
import { TaskError } from "./tasks.js";
import type { DshNativeCatalog, DshNativeIdentity } from "./dsh-native-client.js";

/**
 * Live, account-scoped model catalog for the three execution backends.
 *
 * Discovery is read-only: no model inference, no session create/send/resume,
 * no default-model mutation. Every section carries its own evidence level so a
 * failure in one agent never masks another. Entries describe what the upstream
 * surface advertised — "listed in the catalog" is not "inference-verified".
 */

export type CatalogAgent = "codex" | "antigravity" | "zcode" | "dsh";
export const CATALOG_AGENTS: readonly CatalogAgent[] = ["codex", "antigravity", "zcode", "dsh"];

export const CATALOG_SCHEMA_VERSION = 1 as const;
export const DEFAULT_CATALOG_TTL_MS = 5 * 60_000;
const MAX_LIST_PAGES = 10;
const MAX_MODELS_PER_AGENT = 200;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export interface CatalogEffort {
  effort: string;
  description: string | null;
}

export interface CatalogModelEntry {
  agent: CatalogAgent;
  provider_id: string | null;
  provider_label: string | null;
  model_id: string;
  display_name: string | null;
  supported_efforts: CatalogEffort[];
  default_effort: string | null;
  is_default: boolean;
  input_modalities: string[];
  service_tiers: string[];
  hidden: boolean;
  deprecation: { upgrade_to: string | null; retires_at: string | null; note: string | null } | null;
  evidence_source: string;
  observed_at: string;
  context_window?: number | null;
  backend?: string | null;
  profile?: string | null;
  slot?: string | null;
  model_selection_scope?: "transactional-global-lease" | null;
  effort_selection_scope?: "task-under-lease" | null;
  multimodal_evidence?: string | null;
}

export interface AgentCatalogSection {
  agent: CatalogAgent;
  source: string;
  runtime_version: string | null;
  auth_mode: string | null;
  completeness: "complete" | "partial" | "unknown";
  error: string | null;
  models: CatalogModelEntry[];
  observed_at: string | null;
  /** Set when a forced refresh failed and an older cache is shown on purpose. */
  served_from_stale_cache?: boolean;
  /** Non-sensitive source-identity signals used for cache scoping. */
  identity_key?: string | null;
  /** Real fetch-completion time of THIS section's evidence. */
  fetched_at?: string | null;
  /** When this response served the section (may be a cache hit). */
  served_at?: string | null;
  /** Actual expiry of THIS section's cache entry — never re-extended. */
  expires_at?: string | null;
  /** How this section's evidence was obtained (sanitized, from the source). */
  evidence_source?: string | null;
  /** Bounded observation diagnostics for session-scoped sources. */
  observation?: {
    attempts: Array<{ session_id: string | null; outcome: string; error?: string | null }>;
    candidates_considered: number | null;
    candidates_attempted: number | null;
    candidates_observed: number | null;
    observed_at: string | null;
  } | null;
  /** The observed session's own selection — evidence for that entry only. */
  current_selection?: { provider_id: string | null; model_id: string | null; thought_level: string | null } | null;
  /** Configured preference from the source; config evidence, never a verified entry. */
  configured_identity?: { modelId?: unknown; thoughtLevel?: unknown; providerId?: unknown } | null;
  capabilities?: Record<string, unknown> | null;
}

export interface ModelCatalog {
  schema_version: typeof CATALOG_SCHEMA_VERSION;
  catalog_revision: string;
  /** When this catalog response was assembled (NOT the per-section evidence time). */
  fetched_at: string;
  /** Same assembly instant, named explicitly for served-from-cache clarity. */
  served_at: string;
  /** Actual expiry: the earliest real section expiry, never re-extended. */
  expires_at: string;
  freshness: "fresh" | "stale";
  agents: AgentCatalogSection[];
}

export interface CatalogFetchOptions {
  forceRefresh?: boolean;
  /** Bounded identity scope so a cache is never shared across auth contexts. */
  workspaceRoot?: string;
  /**
   * Defaults to true (display/resolution may show explicitly stale data).
   * Execution authorization paths pass false: a failed refresh then fails
   * closed with MODEL_CATALOG_UNAVAILABLE instead of serving stale data.
   */
  allowStale?: boolean;
}

interface CacheEntry {
  scopeKey: string;
  section: AgentCatalogSection;
  fetchedAtMs: number;
  expiresAtMs: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeError(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  // Bounded, credential-free: redacts sensitive headers, tokens, keys, cookies, and local paths
  return raw
    .replace(/(?:authorization\s*:\s*)?bearer\s+[A-Za-z0-9._~+/=-]+/gi, "bearer [REDACTED]")
    .replace(/(?:authorization\s*:\s*)?basic\s+[A-Za-z0-9._~+/=-]+/gi, "basic [REDACTED]")
    .replace(/((?:x-)?api[-_]?key\s*[:=]?\s*)[^\s,;"'&{}]+/gi, "$1[REDACTED]")
    .replace(/(cookie\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(/(["']?[A-Za-z0-9_.-]*(?:secret|token|key|credential|password|code)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)[^\s,;"'&{}]+/gi, "$1[REDACTED]")
    .replace(/(["']?sid["']?\s*[:=]\s*["']?)[^\s,;"'&{}]+/gi, "$1[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED_KEY]")
    .replace(/[A-Za-z]:\\[^\s"']*/g, "[LOCAL_PATH]")
    .replace(/\/(?:home|Users)\/[^\s"']*/g, "[LOCAL_PATH]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function fileMtimeSafe(file: string): string {
  try {
    return String(fs.statSync(file).mtimeMs);
  } catch {
    return "absent";
  }
}

/** Lowercase, fold separators, keep digits/dots: "GPT 6 Astra" -> "gpt-6-astra". */
export function normalizeModelToken(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

interface CodexModelListEntry {
  id?: unknown;
  model?: unknown;
  displayName?: unknown;
  description?: unknown;
  hidden?: unknown;
  isDefault?: unknown;
  defaultReasoningEffort?: unknown;
  supportedReasoningEfforts?: unknown;
  inputModalities?: unknown;
  additionalSpeedTiers?: unknown;
  upgrade?: unknown;
  upgradeInfo?: { model?: unknown; retirementAt?: unknown; migrationMarkdown?: unknown } | null;
}

interface CodexModelListPage {
  data?: CodexModelListEntry[];
  nextCursor?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function mapCodexEntry(raw: CodexModelListEntry, observedAt: string): CatalogModelEntry | null {
  const modelId = asString(raw.id) ?? asString(raw.model);
  if (!modelId) return null;
  const efforts: CatalogEffort[] = [];
  if (Array.isArray(raw.supportedReasoningEfforts)) {
    for (const rawEffort of raw.supportedReasoningEfforts.slice(0, 12)) {
      const record = rawEffort as { reasoningEffort?: unknown; description?: unknown };
      const effort = asString(record?.reasoningEffort);
      if (effort) efforts.push({ effort, description: asString(record?.description) });
    }
  }
  const upgradeTo = asString(raw.upgradeInfo?.model) ?? asString(raw.upgrade);
  const retirementAt = typeof raw.upgradeInfo?.retirementAt === "number"
    ? new Date(raw.upgradeInfo.retirementAt * 1000).toISOString()
    : null;
  const deprecation = upgradeTo || retirementAt
    ? {
        upgrade_to: upgradeTo,
        retires_at: retirementAt,
        note: asString(raw.upgradeInfo?.migrationMarkdown),
      }
    : null;
  return {
    agent: "codex",
    provider_id: null,
    provider_label: null,
    model_id: modelId,
    display_name: asString(raw.displayName),
    supported_efforts: efforts,
    default_effort: asString(raw.defaultReasoningEffort),
    is_default: raw.isDefault === true,
    input_modalities: Array.isArray(raw.inputModalities)
      ? raw.inputModalities.filter((m): m is string => typeof m === "string").slice(0, 8)
      : [],
    service_tiers: Array.isArray(raw.additionalSpeedTiers)
      ? raw.additionalSpeedTiers.filter((m): m is string => typeof m === "string").slice(0, 8)
      : [],
    hidden: raw.hidden === true,
    deprecation,
    evidence_source: "codex-app-server:model/list",
    observed_at: observedAt,
  };
}

async function captureCommand(
  executable: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`exit code ${code}: ${stderr.slice(0, 200) || "no stderr"}`));
    });
  });
}

/** Fixed, bounded Antigravity CLI resolution: env override then the official install path. */
export function resolveAgyExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.A2C_AGY_EXECUTABLE;
  if (override && path.isAbsolute(override) && isRegularFileSafe(override)) return path.normalize(override);
  const localAppData = env.LOCALAPPDATA;
  if (localAppData) {
    const candidate = path.join(localAppData, "agy", "bin", "agy.exe");
    if (isRegularFileSafe(candidate)) return candidate;
  }
  return null;
}

function isRegularFileSafe(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function mapAgyModels(stdout: string, observedAt: string): CatalogModelEntry[] {
  const entries: CatalogModelEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line || line.includes("\t") === false) continue; // skip banner lines
    const [modelIdRaw, displayNameRaw] = line.split("\t");
    const modelId = modelIdRaw?.trim();
    if (!modelId || /\s/.test(modelId)) continue;
    // Effort is encoded in the Gemini model id suffix, not a separate flag.
    const effortMatch = /^(.*?)-(high|medium|low)$/.exec(modelId);
    const supportedEfforts: CatalogEffort[] = effortMatch
      ? [{ effort: effortMatch[2], description: null }]
      : [];
    entries.push({
      agent: "antigravity",
      provider_id: "antigravity",
      provider_label: "Antigravity",
      model_id: modelId,
      display_name: displayNameRaw?.trim() || null,
      supported_efforts: supportedEfforts,
      default_effort: null,
      is_default: false,
      input_modalities: ["text", "image"],
      service_tiers: [],
      hidden: false,
      deprecation: null,
      evidence_source: "agy-cli:models",
      observed_at: observedAt,
    });
    if (entries.length >= MAX_MODELS_PER_AGENT) break;
  }
  return entries;
}

/**
 * The full tool result the z2c-service returns for `zcode_model_catalog`
 * (metadata + observation diagnostics + the per-session catalog payload).
 */
export interface ZcodeModelCatalogToolResult {
  z2c_protocol_version?: unknown;
  provider?: unknown;
  provider_status?: unknown;
  detail?: unknown;
  zcode_runtime_version?: unknown;
  evidence_source?: unknown;
  observed_session_id?: unknown;
  attempts?: unknown;
  candidates_considered?: unknown;
  configured_identity?: unknown;
  runtime_settings?: ZcodeCatalogSnapshot["runtime_settings"];
  note?: unknown;
  observed_at?: unknown;
}

/**
 * Wire contract of the loopback z2c-service `zcode_model_catalog` tool
 * (see z2c/src/providers/zcode/official.ts for the producing side). All
 * fields are validated at runtime; no field is trusted on type alone.
 */
export interface ZcodeCatalogSnapshot {
  z2c_protocol_version?: unknown;
  provider?: unknown;
  provider_status?: unknown;
  detail?: unknown;
  zcode_runtime_version?: unknown;
  /** Non-sensitive identity signal: the app-server child process id. */
  provider_child_pid?: unknown;
  /** How the evidence was (or was not) obtained; drives the section error. */
  evidence_source?: unknown;
  observed_session_id?: unknown;
  attempts?: unknown;
  candidates_considered?: unknown;
  candidates_attempted?: unknown;
  candidates_observed?: unknown;
  configured_identity?: unknown;
  runtime_settings?: {
    source_session_id?: unknown;
    observed_at?: unknown;
    current?: { provider_id?: unknown; model_id?: unknown; thought_level?: unknown } | null;
    current_model_thought_levels?: unknown;
    models?: unknown;
  } | null;
}

const asStringArray = (value: unknown, max = 24): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value.slice(0, max)) {
    // Accept both `[{value}]` objects and already-normalized strings.
    const token = typeof entry === "string" ? entry : (entry as { value?: unknown } | null)?.value;
    if (typeof token === "string" && token.length > 0 && token.length <= 40) out.push(token);
  }
  return out;
};

/**
 * Non-sensitive identity signals for the zcode observation source: the
 * app-server child process id plus the protocol/runtime versions. The child
 * pid changes whenever the z2c service re-spawns its runtime, so the same
 * runtime version alone can never certify identity continuity. Null
 * components degrade to "unknown"; no credentials are ever read for this.
 */
function zcodeIdentityKey(snapshot: ZcodeCatalogSnapshot): string | null {
  const pid = typeof snapshot.provider_child_pid === "number" ? String(snapshot.provider_child_pid) : null;
  const protocol = asString(snapshot.z2c_protocol_version);
  const runtime = asString(snapshot.zcode_runtime_version);
  if (pid === null && protocol === null && runtime === null) return null;
  return `childPid:${pid ?? "unknown"}|proto:${protocol ?? "unknown"}|runtime:${runtime ?? "unknown"}`;
}

function zcodeGapReason(snapshot: ZcodeCatalogSnapshot): string {  const evidence = asString(snapshot.evidence_source) ?? "unknown";
  if (evidence === "configured") {
    return "no session observation was attempted for this principal; model availability is configured-unverified";
  }
  const settings = snapshot.runtime_settings ?? null;
  if (settings !== null && !Array.isArray(settings.models)) {
    return "runtime_settings did not carry the expected models contract (outdated or incompatible source); no model evidence is fabricated from legacy shapes";
  }
  const attempts = Array.isArray(snapshot.attempts) ? snapshot.attempts : [];
  const outcomes = attempts
    .map((attempt) => asString((attempt as { outcome?: unknown })?.outcome))
    .filter((outcome): outcome is string => outcome !== null);
  const base = `provider healthy but no readable native session produced settings (evidence_source: ${evidence}`;
  return outcomes.length > 0
    ? `${base}; candidate outcomes: ${outcomes.join(", ")})`
    : `${base})`;
}

function mapZcodeSnapshot(snapshot: ZcodeCatalogSnapshot, fetchedAt: string): { section: AgentCatalogSection } {
  const providerStatus = asString(snapshot.provider_status) ?? "unknown";
  const healthy = providerStatus === "healthy";
  const settings = snapshot.runtime_settings ?? null;
  const observedAt = asString(settings?.observed_at) ?? fetchedAt;
  const rawModels = Array.isArray(settings?.models) ? settings!.models! : [];
  const models: CatalogModelEntry[] = [];
  for (const raw of rawModels.slice(0, MAX_MODELS_PER_AGENT)) {
    const entry = raw as {
      provider_id?: unknown; model_id?: unknown; label?: unknown;
      reasoning_levels?: unknown; reasoning_default_level?: unknown;
    } | null;
    if (!entry) continue;
    const modelId = asString(entry.model_id);
    if (!modelId) continue;
    // Per-model reasoning evidence only: the session's own thought levels are
    // NEVER copied onto other models. provider_id stays null when the runtime
    // did not observe it — the current selection is not a substitute identity.
    const reasoningLevels = asStringArray(entry.reasoning_levels);
    models.push({
      agent: "zcode",
      provider_id: asString(entry.provider_id),
      provider_label: asString(entry.provider_id),
      model_id: modelId,
      display_name: asString(entry.label) ?? modelId,
      supported_efforts: reasoningLevels.map((level) => ({ effort: level, description: null })),
      default_effort: asString(entry.reasoning_default_level),
      is_default: false,
      input_modalities: ["text"],
      service_tiers: [],
      hidden: false,
      deprecation: null,
      evidence_source: "z2c-service:zcode_model_catalog",
      observed_at: observedAt,
    });
  }
  // A single session's view is never an account-wide catalog: even a fully
  // populated observation stays "partial".
  const completeness = models.length > 0 ? "partial" : "unknown";
  const current = (settings?.current ?? null) as
    | { provider_id?: unknown; model_id?: unknown; thought_level?: unknown }
    | null;
  const section: AgentCatalogSection = {
    agent: "zcode",
    source: "z2c-service:zcode_model_catalog",
    runtime_version: asString(snapshot.zcode_runtime_version),
    auth_mode: "zcode-native (never API-key)",
    completeness,
    error: healthy ? null : `provider status: ${providerStatus}`,
    models,
    observed_at: observedAt,
    identity_key: zcodeIdentityKey(snapshot),
    fetched_at: fetchedAt,
    served_at: fetchedAt,
    expires_at: null,
    evidence_source: asString(snapshot.evidence_source) ?? null,
    observation: {
      attempts: Array.isArray(snapshot.attempts)
        ? (snapshot.attempts as Array<Record<string, unknown>>).slice(0, 8).map((attempt) => ({
            session_id: asString(attempt.session_id),
            outcome: asString(attempt.outcome) ?? "unknown",
            error: attempt.error ? sanitizeError(attempt.error) : undefined,
          }))
        : [],
      candidates_considered: typeof snapshot.candidates_considered === "number" ? snapshot.candidates_considered : null,
      candidates_attempted: typeof snapshot.candidates_attempted === "number" ? snapshot.candidates_attempted : null,
      candidates_observed: typeof snapshot.candidates_observed === "number" ? snapshot.candidates_observed : null,
      observed_at: asString(settings?.observed_at),
    },
    current_selection: current ? {
      provider_id: asString(current.provider_id),
      model_id: asString(current.model_id),
      thought_level: asString(current.thought_level),
    } : null,
    configured_identity: (snapshot.configured_identity ?? null) as {
      modelId?: unknown; thoughtLevel?: unknown; providerId?: unknown;
    } | null,
  };
  // Observation failures must be explainable: an empty model list with
  // healthy provider always carries a structured gap reason.
  if (models.length === 0 && healthy) {
    section.error = zcodeGapReason(snapshot);
  }
  return { section };
}

export class ModelCatalogService {
  private readonly cache = new Map<CatalogAgent, CacheEntry>();
  private readonly inFlight = new Map<CatalogAgent, Promise<AgentCatalogSection>>();

  constructor(
    private readonly opts: {
      logger?: Logger;
      workspaceRoot: string;
      stateDir?: string;
      env?: NodeJS.ProcessEnv;
      ttlMs?: number;
      /** Injected Z2C semantic client; reuses the existing loopback transport. */
      zcodeModelCatalog?: () => Promise<ZcodeCatalogSnapshot>;
      dshModelCatalog?: () => Promise<DshNativeCatalog>;
      dshHealth?: () => Promise<DshNativeIdentity>;
      codexExecutableResolver?: () => string;
      /** Test seam; production constructs the official App Server client. */
      codexClientFactory?: () => Pick<CodexAppServerClient, "initialize" | "request" | "close"> & { initializeResult?: Record<string, unknown> | null };
    } = { workspaceRoot: process.cwd() }
  ) {}

  private get ttlMs(): number {
    return this.opts.ttlMs ?? DEFAULT_CATALOG_TTL_MS;
  }

  private codexScopeKey(executable: string): string {
    const env = { ...process.env, ...this.opts.env };
    const home = env.CODEX_HOME ?? path.join(env.USERPROFILE ?? env.HOME ?? "", ".codex");
    return [
      executable,
      fileMtimeSafe(executable),
      fileMtimeSafe(path.join(home, "auth.json")),
      fileMtimeSafe(path.join(home, "config.toml")),
    ].join("|");
  }

  private async fetchCodexSection(): Promise<AgentCatalogSection> {
    const observedAt = nowIso();
    let executable: string;
    try {
      executable = this.opts.codexExecutableResolver
        ? this.opts.codexExecutableResolver()
        : resolveCodexExecutable({ env: this.opts.env, stateDir: this.opts.stateDir });
    } catch (error) {
      return {
        agent: "codex",
        source: "codex-app-server:model/list",
        runtime_version: null,
        auth_mode: null,
        completeness: "unknown",
        error: sanitizeError(error),
        models: [],
        observed_at: observedAt,
      };
    }
    const client = this.opts.codexClientFactory
      ? this.opts.codexClientFactory()
      : new CodexAppServerClient(
          { workspaceRoot: this.opts.workspaceRoot, logger: this.opts.logger ?? nullLogger, stateDir: this.opts.stateDir, env: this.opts.env },
          { resolveExecutable: () => executable }
        );
    try {
      await client.initialize();
      const first = await client.request<CodexModelListPage>("model/list", {});
      const rawModels: CodexModelListEntry[] = Array.isArray(first?.data) ? [...first.data] : [];
      let cursor = typeof first?.nextCursor === "string" ? first.nextCursor : null;
      let partial = false;
      for (let page = 1; page < MAX_LIST_PAGES && cursor; page += 1) {
        try {
          const next = await client.request<CodexModelListPage>("model/list", { cursor });
          if (Array.isArray(next?.data)) rawModels.push(...next.data);
          cursor = typeof next?.nextCursor === "string" && next.nextCursor ? next.nextCursor : null;
        } catch {
          // Incomplete pagination must not claim the catalog is exhaustive.
          partial = true;
          break;
        }
      }
      const models = rawModels
        .slice(0, MAX_MODELS_PER_AGENT)
        .map((entry) => mapCodexEntry(entry, observedAt))
        .filter((entry): entry is CatalogModelEntry => entry !== null);
      const userAgent = asString(client.initializeResult?.userAgent);
      const versionMatch = userAgent ? /(\d+\.\d+\.\d+)/.exec(userAgent) : null;
      return {
        agent: "codex",
        source: "codex-app-server:model/list",
        runtime_version: versionMatch ? versionMatch[1] : null,
        auth_mode: "same executable/config/auth path as task execution",
        completeness: models.length > 0 && !partial ? "complete" : "partial",
        error: models.length > 0 ? null : "model/list returned no entries",
        models,
        observed_at: observedAt,
      };
    } catch (error) {
      return {
        agent: "codex",
        source: "codex-app-server:model/list",
        runtime_version: null,
        auth_mode: null,
        completeness: "unknown",
        error: sanitizeError(error),
        models: [],
        observed_at: observedAt,
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private async fetchAgySection(): Promise<AgentCatalogSection> {
    const observedAt = nowIso();
    const executable = resolveAgyExecutable(this.opts.env);
    if (!executable) {
      return {
        agent: "antigravity",
        source: "agy-cli:models",
        runtime_version: null,
        auth_mode: null,
        completeness: "unknown",
        error: "AGY CLI executable not found (A2C_AGY_EXECUTABLE or %LOCALAPPDATA%\\agy\\bin\\agy.exe)",
        models: [],
        observed_at: observedAt,
      };
    }
    try {
      const listing = await captureCommand(executable, ["models"], 20_000);
      const models = mapAgyModels(listing.stdout, observedAt);
      let version: string | null = null;
      try {
        const versionOut = await captureCommand(executable, ["--version"], 10_000);
        version = versionOut.stdout.trim().split(/\r?\n/)[0]?.slice(0, 60) || null;
      } catch {
        version = null;
      }
      return {
        agent: "antigravity",
        source: "agy-cli:models",
        runtime_version: version,
        auth_mode: "agy CLI account auth (same auth as task execution)",
        completeness: models.length > 0 ? "complete" : "partial",
        error: models.length > 0 ? null : "agy models returned no parseable entries",
        models,
        observed_at: observedAt,
      };
    } catch (error) {
      return {
        agent: "antigravity",
        source: "agy-cli:models",
        runtime_version: null,
        auth_mode: null,
        completeness: "unknown",
        error: sanitizeError(error),
        models: [],
        observed_at: observedAt,
      };
    }
  }

  private async fetchZcodeSection(): Promise<AgentCatalogSection> {
    const observedAt = nowIso();
    if (!this.opts.zcodeModelCatalog) {
      return {
        agent: "zcode",
        source: "z2c-service:zcode_model_catalog",
        runtime_version: null,
        auth_mode: null,
        completeness: "unknown",
        error: "Z2C semantic client is not wired into this bridge context",
        models: [],
        observed_at: observedAt,
      };
    }
    try {
      const snapshot = await this.opts.zcodeModelCatalog();
      const { section } = mapZcodeSnapshot(snapshot, observedAt);
      if (typeof snapshot.z2c_protocol_version === "string" || typeof snapshot.z2c_protocol_version === "number") {
        section.runtime_version = `z2c-protocol ${String(snapshot.z2c_protocol_version)}${
          section.runtime_version ? ` / ZCode ${section.runtime_version}` : ""
        }`;
      }
      return section;
    } catch (error) {
      return {
        agent: "zcode",
        source: "z2c-service:zcode_model_catalog",
        runtime_version: null,
        auth_mode: null,
        completeness: "unknown",
        error: sanitizeError(error),
        models: [],
        observed_at: observedAt,
      };
    }
  }

  private async fetchDshSection(): Promise<AgentCatalogSection> {
    const observedAt = nowIso();
    if (!this.opts.dshModelCatalog || !this.opts.dshHealth) {
      return { agent: "dsh", source: "dsh-native-adapter:models", runtime_version: null,
        auth_mode: null, completeness: "unknown", error: "DSH native adapter is not wired",
        models: [], observed_at: observedAt };
    }
    try {
      const [identity, catalog] = await Promise.all([this.opts.dshHealth(), this.opts.dshModelCatalog()]);
      if (identity.generation !== catalog.generation) throw new Error("DSH runtime generation changed during model discovery");
      const models: CatalogModelEntry[] = catalog.groups.flatMap((group) => group.models.map((model) => ({
        agent: "dsh" as const, provider_id: group.id, provider_label: group.name,
        model_id: model.id, display_name: model.name,
        supported_efforts: (model.reasoning?.efforts ?? []).map((item) => ({ effort: item.id, description: item.name ?? null })),
        default_effort: catalog.default.model === model.id ? catalog.default.reasoningEffort ?? null : null,
        is_default: catalog.default.provider === group.id && catalog.default.model === model.id,
        input_modalities: model.inputModalities ?? [], service_tiers: [], hidden: false,
        deprecation: null, evidence_source: model.multimodalEvidence
          ? `dsh-native-adapter:models; ${model.multimodalEvidence}` : "dsh-native-adapter:models",
        observed_at: observedAt, context_window: model.contextWindow ?? null,
        backend: model.backend ?? null, profile: model.profile ?? null, slot: model.slot ?? null,
        model_selection_scope: model.slot ? "transactional-global-lease" as const : null,
        effort_selection_scope: model.slot ? "task-under-lease" as const : null,
        multimodal_evidence: model.multimodalEvidence ?? null,
      })));
      return { agent: "dsh", source: "dsh-native-adapter:models", runtime_version: identity.dshVersion,
        auth_mode: "authenticated loopback native adapter", completeness: models.length ? "complete" : "partial",
        error: models.length ? null : "DSH catalog has no models", models, observed_at: observedAt,
        identity_key: identity.generation,
        capabilities: { ...identity.capabilities, selection_lease: identity.selectionLease ?? null } };
    } catch (error) {
      return { agent: "dsh", source: "dsh-native-adapter:models", runtime_version: null,
        auth_mode: null, completeness: "unknown", error: sanitizeError(error),
        models: [], observed_at: observedAt };
    }
  }

  private fetchSection(agent: CatalogAgent): Promise<AgentCatalogSection> {
    if (agent === "codex") return this.fetchCodexSection();
    if (agent === "antigravity") return this.fetchAgySection();
    if (agent === "dsh") return this.fetchDshSection();
    return this.fetchZcodeSection();
  }

  private scopeKey(agent: CatalogAgent, section: AgentCatalogSection): string {
    if (agent === "codex") {
      try {
        const executable = this.opts.codexExecutableResolver
          ? this.opts.codexExecutableResolver()
          : resolveCodexExecutable({ env: this.opts.env, stateDir: this.opts.stateDir });
        return this.codexScopeKey(executable);
      } catch {
        return "codex-unresolved";
      }
    }
    if (agent === "antigravity") {
      const executable = resolveAgyExecutable(this.opts.env);
      return executable ? `${executable}|${fileMtimeSafe(executable)}` : "agy-unresolved";
    }
    // The runtime version alone cannot certify identity continuity: the
    // identity key includes the app-server child pid (it changes on every
    // z2c service respawn). Without any identity signal the key degrades to
    // a legacy bucket whose TTL is the only conservative validity bound.
    return `${agent}|${section.identity_key ?? `legacy:${section.runtime_version ?? "unknown"}`}`;
  }

  /** One refresh per agent at a time; concurrent callers share the same promise. */
  private refreshSingleFlight(agent: CatalogAgent): Promise<AgentCatalogSection> {
    const existing = this.inFlight.get(agent);
    if (existing) return existing;
    const promise = this.fetchSection(agent)
      .then((section) => {
        const fetchedAtMs = Date.now();
        this.cache.set(agent, {
          scopeKey: this.scopeKey(agent, section),
          section,
          fetchedAtMs,
          expiresAtMs: fetchedAtMs + this.ttlMs,
        });
        return section;
      })
      .finally(() => {
        this.inFlight.delete(agent);
      });
    this.inFlight.set(agent, promise);
    return promise;
  }

  private cached(agent: CatalogAgent): CacheEntry | null {
    const entry = this.cache.get(agent);
    if (!entry) return null;
    // Auth/config drift invalidates the cache even before TTL expiry.
    if (entry.scopeKey !== this.scopeKey(agent, entry.section)) return null;
    return entry;
  }

  async get(agents: readonly CatalogAgent[], options: CatalogFetchOptions = {}): Promise<ModelCatalog> {
    const requested = agents.length > 0 ? agents : CATALOG_AGENTS;
    const sections: AgentCatalogSection[] = [];
    let anyStale = false;
    for (const agent of requested) {
      const cached = this.cached(agent);
      // ZCode has NO cache-validatable identity signal: the child pid (its
      // identity generation) can only be observed by querying the loopback
      // service, so a cache hit could silently serve a dead runtime's
      // evidence. Conservative policy: re-observe zcode on every request —
      // the observation is read-only, single-flight-deduplicated, and
      // budget-bounded. codex/agy keep TTL caching (their identity signals —
      // executable path/mtimes, auth/config mtimes — ARE locally checkable).
      const usable = cached && agent !== "zcode" && agent !== "dsh" && !options.forceRefresh && Date.now() < cached.expiresAtMs;
      if (usable) {
        // Served from cache: served_at is NOW, but fetched_at / expires_at
        // stay the cached entry's real times — a cache hit never re-extends
        // its own validity or re-stamps the evidence.
        sections.push({
          ...cached.section,
          fetched_at: new Date(cached.fetchedAtMs).toISOString(),
          served_at: nowIso(),
          expires_at: new Date(cached.expiresAtMs).toISOString(),
          served_from_stale_cache: undefined,
        });
        continue;
      }
      let section: AgentCatalogSection;
      try {
        section = await this.refreshSingleFlight(agent);
      } catch (error) {
        if (cached && options.allowStale !== false) {
          // Refresh failed: stale data may be DISPLAYED with an explicit stale
          // marker, but it is never a fresh execution authorization, and its
          // original expiry is shown unchanged (already past).
          anyStale = true;
          sections.push({
            ...cached.section,
            fetched_at: new Date(cached.fetchedAtMs).toISOString(),
            served_at: nowIso(),
            expires_at: new Date(cached.expiresAtMs).toISOString(),
            served_from_stale_cache: true,
            error: sanitizeError(error),
          });
          continue;
        }
        if (options.allowStale === false) {
          // Execution paths must run on a fresh live catalog: a failed refresh
          // fails closed instead of dispatching against stale data.
          throw new TaskError(
            "MODEL_CATALOG_UNAVAILABLE",
            `${agent} model catalog is not available fresh: ${sanitizeError(error)}`
          );
        }
        anyStale = true;
        sections.push({
          agent,
          source: agent === "codex" ? "codex-app-server:model/list" : agent === "antigravity" ? "agy-cli:models"
            : agent === "dsh" ? "dsh-native-adapter:models" : "z2c-service:zcode_model_catalog",
          runtime_version: null,
          auth_mode: null,
          completeness: "unknown",
          error: sanitizeError(error),
          models: [],
          observed_at: nowIso(),
          fetched_at: nowIso(),
          served_at: nowIso(),
          expires_at: null,
        });
        continue;
      }
      const refreshed = this.cache.get(agent);
      sections.push({
        ...section,
        fetched_at: refreshed ? new Date(refreshed.fetchedAtMs).toISOString() : nowIso(),
        served_at: nowIso(),
        // zcode evidence is never served from cache (re-observed per request),
        // so it carries no cache validity beyond this response.
        expires_at: agent === "zcode" || agent === "dsh" ? nowIso() : refreshed ? new Date(refreshed.expiresAtMs).toISOString() : new Date(Date.now() + this.ttlMs).toISOString(),
        served_from_stale_cache: undefined,
      });
    }
    const fetchedAt = nowIso();
    const revision = createHash("sha256")
      .update(JSON.stringify(sections.map((s) => [s.agent, s.completeness, s.models.map((m) => [m.model_id, m.provider_id, m.supported_efforts.map((e) => e.effort).join(","), m.is_default])])))
      .digest("hex")
      .slice(0, 16);
    // Actual expiry: the earliest real section expiry — never fabricated as
    // now+ttl when older evidence is being served.
    const expiryTimes = sections
      .map((section) => section.expires_at)
      .filter((value): value is string => typeof value === "string")
      .map((value) => Date.parse(value))
      .filter((value) => Number.isFinite(value));
    return {
      schema_version: CATALOG_SCHEMA_VERSION,
      catalog_revision: revision,
      fetched_at: fetchedAt,
      served_at: fetchedAt,
      expires_at: expiryTimes.length > 0
        ? new Date(Math.min(...expiryTimes)).toISOString()
        : new Date(Date.now() + this.ttlMs).toISOString(),
      freshness: anyStale ? "stale" : "fresh",
      agents: sections,
    };
  }

  /** Synchronous peek at the warm cache for sync tool output (never fetches). */
  peek(agent: CatalogAgent): AgentCatalogSection | null {
    const entry = this.cached(agent);
    if (!entry || Date.now() >= entry.expiresAtMs) return null;
    return entry.section;
  }

  modelsOf(catalog: ModelCatalog | null, agent: CatalogAgent): CatalogModelEntry[] {
    if (!catalog) return [];
    return catalog.agents.find((section) => section.agent === agent)?.models ?? [];
  }

  /**
   * Confirm a model/effort pair against a FRESH codex catalog.
   * Used by the task manager at dispatch time; callers fail closed on
   * `problem` instead of silently switching models. Stale cache is never
   * accepted here: a failed refresh yields MODEL_CATALOG_UNAVAILABLE.
   */
  async confirmCodexSelection(
    model: string,
    effort: string | null
  ): Promise<{ confirmed: boolean; revision: string | null; problem: string | null }> {
    const catalog = await this.get(["codex"], { allowStale: false });
    if (catalog.freshness !== "fresh") {
      return { confirmed: false, revision: catalog.catalog_revision, problem: "MODEL_CATALOG_UNAVAILABLE: catalog is not fresh" };
    }
    const section = catalog.agents.find((candidate) => candidate.agent === "codex") ?? null;
    if (!section || section.served_from_stale_cache) {
      return { confirmed: false, revision: catalog.catalog_revision, problem: "MODEL_CATALOG_UNAVAILABLE: codex catalog section missing or stale" };
    }
    if (section.models.length === 0) {
      return { confirmed: false, revision: catalog.catalog_revision, problem: `MODEL_CATALOG_UNAVAILABLE: ${section.error ?? "no models"}` };
    }
    const entry = section.models.find((candidate) => candidate.model_id === model);
    if (!entry) {
      const advertised = section.models.filter((candidate) => !candidate.hidden).map((candidate) => candidate.model_id).slice(0, 12);
      return {
        confirmed: false,
        revision: catalog.catalog_revision,
        problem: `MODEL_NOT_LISTED: "${model}" is not in the current codex catalog (advertised: ${advertised.join(", ") || "none"})`,
      };
    }
    if (effort && !effortSupported(entry, effort)) {
      return {
        confirmed: false,
        revision: catalog.catalog_revision,
        problem: `UNSUPPORTED_EFFORT: effort "${effort}" is not supported by "${model}" (supported: ${
          entry.supported_efforts.map((e) => e.effort).join(", ") || "none advertised"
        })`,
      };
    }
    return { confirmed: true, revision: catalog.catalog_revision, problem: null };
  }
}

// ── no-inference resolution ─────────────────────────────────────────────────

export interface ResolveRequest {
  agent?: CatalogAgent;
  provider_id?: string;
  model?: string;
  effort?: string;
  service_tier?: string;
}

export interface ResolveSelection {
  agent: CatalogAgent;
  provider_id: string | null;
  model_id: string;
  effort: string | null;
}

export interface ResolveResult {
  status: "matched" | "ambiguous" | "not_found" | "unverified" | "unavailable";
  reason: string;
  selection: ResolveSelection | null;
  candidates: Array<{ agent: CatalogAgent; provider_id: string | null; model_id: string; display_name: string | null; default_effort: string | null }>;
  catalog_revision: string | null;
  catalog_freshness: "fresh" | "stale" | null;
}

function candidatesOf(catalog: ModelCatalog, agent: CatalogAgent | undefined): Array<{ entry: CatalogModelEntry; section: AgentCatalogSection }> {
  const pairs: Array<{ entry: CatalogModelEntry; section: AgentCatalogSection }> = [];
  for (const section of catalog.agents) {
    if (agent && section.agent !== agent) continue;
    for (const entry of section.models) pairs.push({ entry, section });
  }
  return pairs;
}

function effortSupported(entry: CatalogModelEntry, effort: string): boolean {
  const normalized = normalizeModelToken(effort);
  return entry.supported_efforts.some((e) => normalizeModelToken(e.effort) === normalized);
}

function toCandidate(entry: CatalogModelEntry) {
  return {
    agent: entry.agent,
    provider_id: entry.provider_id,
    model_id: entry.model_id,
    display_name: entry.display_name,
    default_effort: entry.default_effort,
  };
}

/**
 * Deterministic, dictionary-free matching. Strict precedence tiers — the
 * first tier with any hit wins, and lower tiers are never mixed in:
 *   1. exact protocol model_id
 *   2. case-compatible protocol model_id
 *   3. exact display name
 *   4. separator-normalized model_id
 *   5. separator-normalized display name (incl. "(Effort)" parentheticals)
 * Multiple hits WITHIN one tier → ambiguous; across tiers → the higher tier
 * wins outright (an exact id beats another entry's display name).
 */
export function resolveModelSelection(catalog: ModelCatalog | null, request: ResolveRequest): ResolveResult {
  const base = {
    catalog_revision: catalog?.catalog_revision ?? null,
    catalog_freshness: catalog?.freshness ?? null,
  };
  if (!catalog) {
    return { status: "unavailable", reason: "No model catalog is available in this bridge context", selection: null, candidates: [], ...base };
  }
  const agent = request.agent;
  const relevantSections = catalog.agents.filter((section) => !agent || section.agent === agent);
  if (relevantSections.length === 0) {
    return { status: "not_found", reason: `Unknown agent: ${String(agent)}`, selection: null, candidates: [], ...base };
  }
  const pairs = candidatesOf(catalog, agent);
  if (relevantSections.every((section) => section.models.length === 0)) {
    // No catalog evidence at all — never reported as "the model does not
    // exist": the caller cannot distinguish absence from an evidence gap.
    return {
      status: "unavailable",
      reason: relevantSections
        .map((section) => `${section.agent}: ${section.error ?? `no catalog evidence (evidence_source: ${section.evidence_source ?? "unknown"})`}`)
        .join("; ")
        .slice(0, 400),
      selection: null,
      candidates: [],
      ...base,
    };
  }
  if (relevantSections.some((section) => section.served_from_stale_cache || catalog.freshness === "stale")) {
    // Stale catalogs are display-only; resolution still works but is not a
    // fresh authorization, so callers re-resolve before executing.
    const staleResult = resolveAgainstEntries(pairs, request, base, true);
    if (staleResult) return staleResult;
    return {
      status: "unverified",
      reason: "Catalog is stale; refresh with force_refresh before executing",
      selection: null,
      candidates: providerFilteredPairs(pairs, request).slice(0, 10).map(({ entry }) => toCandidate(entry)),
      ...base,
    };
  }
  const resolved = resolveAgainstEntries(pairs, request, base, false);
  if (resolved) return resolved;
  // No identity match anywhere in scope. A negative answer is only allowed
  // when the ENTIRE request scope is covered by complete evidence: any
  // empty or partial relevant section (e.g. a single-session zcode view,
  // or a failed agent in an all-agent query) leaves absence unprovable.
  // Explicitly-scoped agent queries are judged on that agent alone, so an
  // unrelated agent's failure never blocks a valid scoped conclusion.
  const exhaustive = relevantSections.every((section) => section.models.length > 0 && section.completeness === "complete");
  return exhaustive
    ? {
        status: "not_found",
        reason: request.model
          ? `No catalog entry matches "${request.model}"${agent ? ` for agent ${agent}` : ""}`
          : "No default model is marked in the catalog",
        selection: null,
        candidates: providerFilteredPairs(pairs, request).slice(0, 10).map(({ entry }) => toCandidate(entry)),
        ...base,
      }
    : {
        status: "unverified",
        reason: "Catalog evidence is partial (e.g. a single-session view); a missing match cannot be concluded as absence",
        selection: null,
        candidates: providerFilteredPairs(pairs, request).slice(0, 10).map(({ entry }) => toCandidate(entry)),
        ...base,
      };
}

function providerFilteredPairs(
  pairs: Array<{ entry: CatalogModelEntry; section: AgentCatalogSection }>,
  request: ResolveRequest
): Array<{ entry: CatalogModelEntry; section: AgentCatalogSection }> {
  if (!request.provider_id) return pairs;
  const wanted = normalizeModelToken(request.provider_id);
  // A provider constraint applies to the candidates too: entries from other
  // providers are never offered as substitutes for a constrained request.
  return pairs.filter(({ entry }) => entry.provider_id !== null && normalizeModelToken(entry.provider_id) === wanted);
}

type IdentityMatch =
  | { kind: "entry"; entry: CatalogModelEntry }
  | { kind: "ambiguous"; entries: CatalogModelEntry[] }
  | null;

function matchIdentity(pairs: Array<{ entry: CatalogModelEntry }>, query: string): IdentityMatch {
  const tiers: Array<(candidate: { entry: CatalogModelEntry }) => boolean> = [
    ({ entry }) => entry.model_id === query,
    ({ entry }) => entry.model_id.toLowerCase() === query.toLowerCase(),
    ({ entry }) => entry.display_name !== null && entry.display_name.toLowerCase() === query.toLowerCase(),
    ({ entry }) => normalizeModelToken(entry.model_id) === normalizeModelToken(query),
    ({ entry }) => entry.display_name !== null && displayBaseMatches(entry.display_name, query),
  ];
  for (const tier of tiers) {
    const hits = pairs.filter(tier).map((pair) => pair.entry);
    if (hits.length === 0) continue;
    if (hits.length === 1) return { kind: "entry", entry: hits[0] };
    return { kind: "ambiguous", entries: hits };
  }
  return null;
}

function resolveAgainstEntries(
  pairs: Array<{ entry: CatalogModelEntry; section: AgentCatalogSection }>,
  request: ResolveRequest,
  base: { catalog_revision: string | null; catalog_freshness: "fresh" | "stale" | null },
  stale: boolean
): ResolveResult | null {
  const filtered = providerFilteredPairs(pairs, request);
  if (filtered.length === 0 && request.provider_id) return null;
  if (!request.model) {
    const defaults = filtered.filter(({ entry }) => entry.is_default && !entry.hidden);
    if (defaults.length !== 1) return null;
    const { entry } = defaults[0];
    return finishMatch(entry, request.effort, "account default from live catalog", base, stale);
  }
  const query = request.model.trim();
  const identity = matchIdentity(filtered, query);
  if (identity === null) {
    // Only when the FULL query has no model-identity match may a trailing
    // effort token be considered. An identity match whose effort check fails
    // is a known-unsupported answer, never reinterpreted as a split name.
    return splitTrailingEffort(filtered, request, query, base, stale);
  }
  if (identity.kind === "ambiguous") {
    return {
      status: "ambiguous",
      reason: `"${query}" matches ${identity.entries.length} catalog entries at the same precedence; provide provider_id or the exact protocol model_id`,
      selection: null,
      candidates: identity.entries.slice(0, 10).map(toCandidate),
      ...base,
    };
  }
  const entry = identity.entry;
  const reason = stale
    ? "matched against a stale catalog; refresh before executing"
    : matchReason(query, entry);
  return finishMatch(entry, request.effort, reason, base, stale);
}

/**
 * Split a trailing effort token from an otherwise-unmatched query
 * ("GPT-6 Astra Max" → base "GPT-6 Astra" + effort "max"). The token
 * vocabulary is derived from the catalog's own advertised efforts — no
 * static model whitelist and no substring guessing. The base must match by
 * the same strict tiers, and the effort is validated against the matched
 * model. max and ultra are distinct tokens.
 */
function splitTrailingEffort(
  pairs: Array<{ entry: CatalogModelEntry; section: AgentCatalogSection }>,
  request: ResolveRequest,
  query: string,
  base: { catalog_revision: string | null; catalog_freshness: "fresh" | "stale" | null },
  stale: boolean
): ResolveResult | null {
  const effortTokens = new Set<string>();
  for (const { entry } of pairs) {
    for (const effort of entry.supported_efforts) {
      if (effort.effort) effortTokens.add(effort.effort.toLowerCase());
    }
  }
  if (effortTokens.size === 0) return null;
  const normalized = normalizeModelToken(query);
  const orderedTokens = [...effortTokens].sort((a, b) => b.length - a.length);
  for (const token of orderedTokens) {
    const suffix = `-${token}`;
    if (!normalized.endsWith(suffix)) continue;
    const baseQuery = normalized.slice(0, normalized.length - suffix.length);
    if (!baseQuery) continue;
    const identity = matchIdentity(pairs, baseQuery);
    if (identity === null) continue; // this token yields no base identity
    if (identity.kind === "ambiguous") {
      // The split base matched multiple entries: keep the ambiguity (with
      // the provider-constrained candidates) instead of guessing one model.
      return {
        status: "ambiguous",
        reason: `"${baseQuery}" (after removing the name-suffix effort "${token}") matches ${identity.entries.length} catalog entries; provide provider_id or the exact protocol model_id`,
        selection: null,
        candidates: identity.entries.slice(0, 10).map(toCandidate),
        ...base,
      };
    }
    if (request.effort !== undefined && request.effort.toLowerCase() !== token) {
      return {
        status: "ambiguous",
        reason: `selection conflict: explicit effort "${request.effort}" does not match the name-suffix effort "${token}" of "${identity.entry.model_id}"; drop one of the two`,
        selection: null,
        candidates: [toCandidate(identity.entry)],
        ...base,
      };
    }
    return finishMatch(identity.entry, token, "effort parsed from the model-name suffix", base, stale);
  }
  return null;
}

function matchReason(query: string, entry: CatalogModelEntry): string {
  if (entry.model_id === query) return "exact protocol model_id";
  if (entry.model_id.toLowerCase() === query.toLowerCase()) return "case-insensitive protocol model_id";
  if (entry.display_name && entry.display_name.toLowerCase() === query.toLowerCase()) return "exact display name";
  return "separator-normalized match";
}

/** "Gemini 3.8 Flash (High)" matches gemini-3.8-flash-high when the parenthetical effort lines up. */
function displayBaseMatches(displayName: string, query: string): boolean {
  const paren = /\(([^)]+)\)\s*$/.exec(displayName.trim());
  if (!paren) return normalizeModelToken(displayName) === normalizeModelToken(query);
  const base = displayName.slice(0, paren.index).trim();
  const parenEffort = normalizeModelToken(paren[1]);
  const normalizedQuery = normalizeModelToken(query);
  if (normalizeModelToken(base) === normalizedQuery) return true; // base name also acceptable
  return normalizedQuery === normalizeModelToken(`${base}-${parenEffort}`);
}

function finishMatch(
  entry: CatalogModelEntry,
  requestedEffort: string | undefined,
  reason: string,
  base: { catalog_revision: string | null; catalog_freshness: "fresh" | "stale" | null },
  stale: boolean
): ResolveResult {
  const effort = requestedEffort ?? entry.default_effort;
  if (stale) {
    // A stale catalog may DISPLAY a candidate but never authorizes execution:
    // every match on stale data is unverified, even with an explicit effort.
    return {
      status: "unverified",
      reason: "Catalog is stale; refresh with force_refresh before executing",
      selection: { agent: entry.agent, provider_id: entry.provider_id, model_id: entry.model_id, effort },
      candidates: [toCandidate(entry)],
      ...base,
    };
  }
  if (requestedEffort !== undefined) {
    if (entry.supported_efforts.length === 0) {
      // Capability evidence is missing: unknown is not known-unsupported, and
      // never silently downgraded to the default effort.
      return {
        status: "unverified",
        reason: `Model "${entry.model_id}" matched but advertises no reasoning efforts; effort capability is unknown, not known-unsupported`,
        selection: null,
        candidates: [toCandidate(entry)],
        ...base,
      };
    }
    if (!effortSupported(entry, requestedEffort)) {
      return {
        status: "not_found",
        reason: `Model "${entry.model_id}" exists but effort "${requestedEffort}" is not supported (supported: ${
          entry.supported_efforts.map((e) => e.effort).join(", ") || "none advertised"
        }); max and ultra are distinct efforts`,
        selection: null,
        candidates: [toCandidate(entry)],
        ...base,
      };
    }
  }
  return {
    status: "matched",
    reason,
    selection: { agent: entry.agent, provider_id: entry.provider_id, model_id: entry.model_id, effort },
    candidates: [toCandidate(entry)],
    ...base,
  };
}

// ── execution selection for the Codex lane ──────────────────────────────────

export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
export const EFFORT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/;

export interface ExecutionSelection {
  model: string;
  effort: string | null;
  binding_source: "explicit-task" | "bridge-preference" | "account-default" | "continuation-pin";
  catalog_revision: string | null;
  catalog_confirmed: boolean;
}

export interface CodexSelectionInput {
  model?: string;
  effort?: string;
}

export const DEFAULT_BRIDGE_CODEX_PREFERENCE: CodexSelectionInput = { model: "gpt-6-astra", effort: "max" };

function validateBoundedSelection(input: CodexSelectionInput): void {
  if (input.model !== undefined && !MODEL_ID_PATTERN.test(input.model)) {
    throw new TaskError("INVALID_TASK", `model must match ${MODEL_ID_PATTERN.source}`);
  }
  if (input.effort !== undefined && !EFFORT_PATTERN.test(input.effort)) {
    throw new TaskError("INVALID_TASK", `effort must match ${EFFORT_PATTERN.source}`);
  }
}

/**
 * Resolve the model/effort a Codex task will actually run with, against a
 * FRESH live catalog (a failed refresh fails closed with
 * MODEL_CATALOG_UNAVAILABLE; stale cache is display-only).
 *
 * Selection semantics:
 *   A) explicit model + effort → exact model + exact effort
 *   B) explicit model only     → exact model + that model's catalog default effort
 *   C) explicit effort only    → model via the normal priority (bridge
 *      preference > account default), then the EXPLICIT effort overrides the
 *      default; unsupported → UNSUPPORTED_EFFORT (never silently dropped)
 *   D) nothing supplied        → bridge preference > account default
 *
 * Every hop is validated against the fresh catalog; unknown models fail with
 * MODEL_NOT_LISTED instead of silently substituting. max and ultra are
 * distinct efforts and never auto-upgraded. The user's global
 * ~/.codex/config.toml is never read here.
 */
export async function resolveCodexExecutionSelection(
  service: ModelCatalogService | null,
  explicit: CodexSelectionInput,
  preference: CodexSelectionInput | null
): Promise<ExecutionSelection> {
  validateBoundedSelection(explicit);
  if (preference) validateBoundedSelection(preference);
  if (!service) {
    throw new TaskError(
      "MODEL_CATALOG_UNAVAILABLE",
      "No model catalog service is wired into this bridge context; a selection cannot be confirmed"
    );
  }
  const catalog = await service.get(["codex"], { allowStale: false });
  if (catalog.freshness !== "fresh") {
    throw new TaskError("MODEL_CATALOG_UNAVAILABLE", "Codex model catalog is not fresh");
  }
  const section = catalog.agents.find((candidate) => candidate.agent === "codex") ?? null;
  if (!section || section.served_from_stale_cache || section.models.length === 0) {
    throw new TaskError(
      "MODEL_CATALOG_UNAVAILABLE",
      `Codex model catalog is unavailable: ${section?.error ?? "no models"}`
    );
  }
  const revision = catalog.catalog_revision;

  const requireEntry = (model: string, source: string): CatalogModelEntry => {
    const entry = section.models.find((candidate) => candidate.model_id === model);
    if (!entry) {
      const advertised = section.models.filter((candidate) => !candidate.hidden).map((candidate) => candidate.model_id).slice(0, 12);
      throw new TaskError(
        "MODEL_NOT_LISTED",
        `"${model}" is not in the current codex catalog (${source}; advertised: ${advertised.join(", ") || "none"})`
      );
    }
    return entry;
  };
  const requireEffort = (entry: CatalogModelEntry, effort: string): void => {
    if (entry.supported_efforts.length === 0) {
      // Missing capability evidence is not known-unsupported: fail closed on
      // unavailable evidence rather than pretending the effort is rejected.
      throw new TaskError(
        "MODEL_CATALOG_UNAVAILABLE",
        `effort capability for "${entry.model_id}" is not advertised by the codex catalog; cannot confirm effort "${effort}"`
      );
    }
    if (!effortSupported(entry, effort)) {
      throw new TaskError(
        "UNSUPPORTED_EFFORT",
        `effort "${effort}" is not supported by "${entry.model_id}" (supported: ${
          entry.supported_efforts.map((e) => e.effort).join(", ") || "none advertised"
        }); max and ultra are distinct efforts`
      );
    }
  };

  // A/B) explicit model: exact model; explicit effort wins, otherwise the
  // model's own catalog default effort.
  if (explicit.model) {
    const entry = requireEntry(explicit.model, "explicit task selection");
    const effort = explicit.effort ?? entry.default_effort;
    if (effort) requireEffort(entry, effort);
    return {
      model: entry.model_id,
      effort: effort ?? null,
      binding_source: "explicit-task",
      catalog_revision: revision,
      catalog_confirmed: true,
    };
  }
  // C) explicit effort only: pick the model via the normal priority, then the
  // explicit effort OVERRIDES the default. It is never dropped.
  if (explicit.effort) {
    let modelId: string;
    let source: ExecutionSelection["binding_source"];
    if (preference?.model) {
      requireEntry(preference.model, "bridge preference");
      modelId = preference.model;
      source = "bridge-preference";
    } else {
      const defaults = section.models.filter((candidate) => candidate.is_default && !candidate.hidden);
      if (defaults.length !== 1) {
        throw new TaskError(
          "MODEL_CATALOG_UNAVAILABLE",
          "Explicit effort given but no bridge preference and no unique account default to attach it to"
        );
      }
      modelId = defaults[0].model_id;
      source = "account-default";
    }
    const entry = requireEntry(modelId, source);
    requireEffort(entry, explicit.effort);
    return {
      model: modelId,
      effort: explicit.effort,
      binding_source: source,
      catalog_revision: revision,
      catalog_confirmed: true,
    };
  }
  // D) nothing explicit: bridge preference (effort falls back to the model's
  // catalog default when the preference pins only a model), then account default.
  if (preference?.model) {
    const entry = requireEntry(preference.model, "bridge preference");
    const effort = preference.effort ?? entry.default_effort;
    if (effort) requireEffort(entry, effort);
    return {
      model: entry.model_id,
      effort: effort ?? null,
      binding_source: "bridge-preference",
      catalog_revision: revision,
      catalog_confirmed: true,
    };
  }
  const defaults = section.models.filter((candidate) => candidate.is_default && !candidate.hidden);
  if (defaults.length === 1) {
    const entry = defaults[0];
    return {
      model: entry.model_id,
      effort: entry.default_effort,
      binding_source: "account-default",
      catalog_revision: revision,
      catalog_confirmed: true,
    };
  }
  throw new TaskError(
    "MODEL_CATALOG_UNAVAILABLE",
    "No explicit model, no bridge preference, and no confirmed account default; fetch agent_model_catalog before submitting"
  );
}

/**
 * Read the optional bridge-local Codex preference. Priority: environment
 * variables, then the bridge-owned state preference file. The public
 * installer never creates the preference file, so fresh deployments resolve
 * to the verified account default; a machine-local deployment may opt into a
 * specific model/effort, which is still live-confirmed on every dispatch.
 */
export function bridgeCodexPreference(env: NodeJS.ProcessEnv = process.env, stateDir?: string): CodexSelectionInput | null {
  const model = env.A2C_CODEX_PREFERRED_MODEL?.trim();
  const effort = env.A2C_CODEX_PREFERRED_EFFORT?.trim();
  if (model || effort) return { model: model || undefined, effort: effort || undefined };
  if (stateDir) {
    try {
      const file = path.join(stateDir, "model-preferences.json");
      if (isRegularFileSafe(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
          codex?: { model?: unknown; effort?: unknown };
        };
        const codex = parsed?.codex;
        const prefModel = typeof codex?.model === "string" && codex.model.trim() ? codex.model.trim() : undefined;
        const prefEffort = typeof codex?.effort === "string" && codex.effort.trim() ? codex.effort.trim() : undefined;
        if (prefModel || prefEffort) return { model: prefModel, effort: prefEffort };
      }
    } catch {
      // A malformed preference file never breaks admission; fall through to
      // the account default.
    }
  }
  return null;
}
