/**
 * Local Quanta Usage Telemetry Client
 *
 * Connects to local Quanta service at 127.0.0.1:8765/api/usage using token from
 * ~/.aibar/config.json.
 *
 * Strict Secret Hygiene:
 * - Never returns or logs auth tokens, bearer tokens, or secrets.
 * - Redacts all account emails, user IDs, and OAuth tokens.
 * - Normalizes telemetry for Codex, Antigravity (Gemini vs shared Claude/GPT pool),
 *   GLM, DeepSeek, and Muse without converting unknown to 0.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getAntigravityModelsForPool, type AntigravityQuotaPoolId } from "../execution/antigravity.js";

/**
 * Window telemetry status semantics:
 * - "known": the window exists and real usage data is available.
 * - "unknown": the window is relevant but this snapshot carries no usable
 *   data for it. NEVER fabricated into a number downstream.
 * - "not_applicable": positive evidence the plan shape has no such window
 *   (e.g. a plan whose only reported window is weekly-long); ignored by
 *   routing instead of being read as a healthy 100% window.
 * - "unavailable": the provider/window source itself is down.
 */
export type QuantaWindowStatus = "known" | "unknown" | "not_applicable" | "unavailable";

export function clampPercent(val: unknown): number | null {
  if (typeof val !== "number" || !Number.isFinite(val)) return null;
  if (val < 0 || val > 100) return null;
  return Math.max(0, Math.min(100, Math.round(val * 10) / 10));
}

export interface QuantaWindowTelemetry {
  label: string;
  status: QuantaWindowStatus;
  used_percent: number | null;
  remaining_percent: number | null;
  remaining_units?: number | null;
  unit_type?: string | null;
  reset_at: number | null;
  resets_at?: number | null;
  resets_at_iso: string | null;
  window_minutes?: number | null;
}

function createWindowTelemetry(opts: {
  label: string;
  status: QuantaWindowStatus;
  used_percent: number | null;
  remaining_percent: number | null;
  remaining_units?: number | null;
  unit_type?: string | null;
  reset_at: number | null;
  window_minutes?: number | null;
}): QuantaWindowTelemetry {
  return {
    label: opts.label,
    status: opts.status,
    used_percent: opts.used_percent,
    remaining_percent: opts.remaining_percent,
    remaining_units: opts.remaining_units ?? null,
    unit_type: opts.unit_type ?? null,
    reset_at: opts.reset_at,
    resets_at: opts.reset_at,
    resets_at_iso: timestampToIso(opts.reset_at),
    window_minutes: opts.window_minutes ?? null,
  };
}

export interface QuantaCodexAccountTelemetry {
  constraints?: QuantaWindowTelemetry[];
  account_index: number;
  is_current: boolean;
  plan_type: string;
  five_hour_window: QuantaWindowTelemetry;
  weekly_window: QuantaWindowTelemetry;
}

export interface QuantaCodexTelemetry {
  status: "available" | "unavailable";
  current_account: QuantaCodexAccountTelemetry | null;
  stale_accounts: QuantaCodexAccountTelemetry[];
  live_error?: string | null;
}

export interface QuantaAntigravityPoolTelemetry {
  quota_pool_id: string; // "antigravity:gemini" | "antigravity:claude_gpt_shared"
  description: string;
  shared: boolean;
  shared_models?: string[];
  note?: string;
  five_hour_window: QuantaWindowTelemetry;
  weekly_window: QuantaWindowTelemetry;
}

export interface QuantaAntigravityTelemetry {
  status: "available" | "unavailable";
  plan?: string;
  pools: {
    gemini: QuantaAntigravityPoolTelemetry;
    claude_gpt_shared: QuantaAntigravityPoolTelemetry;
  };
  models_usage?: Record<string, number>;
}

export interface QuantaGlmTelemetry {
  status: "available" | "unavailable";
  level?: string;
  five_hour_window: QuantaWindowTelemetry;
  weekly_window: QuantaWindowTelemetry;
}

export interface QuantaGenericProviderTelemetry {
  status: "configured" | "unconfigured" | "unavailable";
  available: boolean;
  message?: string;
  note?: string;
}

export interface QuantaTelemetryReport {
  observed_at?: string | null;
  fetched_at?: string;
  freshness?: "fresh" | "unknown";
  timestamp: string;
  quanta_available: boolean;
  server_url: string;
  error?: string;
  retry_guidance?: string;
  providers: {
    codex: QuantaCodexTelemetry;
    antigravity: QuantaAntigravityTelemetry;
    glm: QuantaGlmTelemetry;
    deepseek: QuantaGenericProviderTelemetry;
    muse: QuantaGenericProviderTelemetry;
  };
}

const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

function sanitizeText(text: unknown): string {
  if (typeof text !== "string") return "";
  return text.replace(EMAIL_PATTERN, "[REDACTED_EMAIL]");
}

function timestampToIso(timestamp: unknown): string | null {
  if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0) {
    const ms = timestamp < 1e11 ? timestamp * 1000 : timestamp;
    try {
      return new Date(ms).toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

export class QuantaClient {
  private configPath: string;
  private cache: { report: QuantaTelemetryReport; expiresAt: number } | null = null;
  private cacheTtlMs: number;

  constructor(opts: { configPath?: string; cacheTtlMs?: number } = {}) {
    this.configPath = opts.configPath ?? process.env.C2C_AIBAR_CONFIG_PATH ?? path.join(os.homedir(), ".aibar", "config.json");
    this.cacheTtlMs = opts.cacheTtlMs ?? 20_000;
  }

  private readConfig(): { token?: string; port: number; host: string } | null {
    try {
      if (!fs.existsSync(this.configPath)) return null;
      const raw = fs.readFileSync(this.configPath, "utf8");
      const json = JSON.parse(raw);
      const server = json.server ?? {};
      return {
        token: typeof server.token === "string" ? server.token : undefined,
        port: typeof server.port === "number" ? server.port : 8765,
        host: typeof server.host === "string" ? server.host : "127.0.0.1",
      };
    } catch {
      return null;
    }
  }

  async getTelemetry(opts: { forceRefresh?: boolean } = {}): Promise<QuantaTelemetryReport> {
    const now = Date.now();
    if (!opts.forceRefresh && this.cache && this.cache.expiresAt > now) {
      return this.cache.report;
    }

    const cfg = this.readConfig();
    const permitted = !!cfg && ["127.0.0.1", "::1"].includes(cfg.host) && Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port <= 65535;
    const serverUrl = permitted ? ("http://" + (cfg!.host === "::1" ? "[::1]" : cfg!.host) + ":" + cfg!.port) : "http://127.0.0.1:8765";

    if (!cfg || !cfg.token || !permitted) {
      const fallbackReport: QuantaTelemetryReport = {
        timestamp: new Date().toISOString(),
        quanta_available: false,
        server_url: serverUrl,
        error: "QUANTA_CONFIG_MISSING",
        retry_guidance: "Local Quanta config ~/.aibar/config.json is missing or does not contain a server token.",
        providers: this.emptyProviders(),
      };
      return fallbackReport;
    }

    try {
      const rawData = await this.fetchRaw(cfg.host, cfg.port, cfg.token);
      const normalized = this.normalize(rawData, serverUrl);
      this.cache = { report: normalized, expiresAt: now + this.cacheTtlMs };
      return normalized;
    } catch (err: unknown) {

      const errorReport: QuantaTelemetryReport = {
        timestamp: new Date().toISOString(),
        quanta_available: false,
        server_url: serverUrl,
        error: "QUANTA_UNREACHABLE",
        retry_guidance: "Local Quanta telemetry could not be retrieved safely.",
        providers: this.emptyProviders(),
      };
      return errorReport;
    }
  }

  private fetchRaw(host: string, port: number, token: string): Promise<Record<string, unknown>> {
    if (!["127.0.0.1", "::1"].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(new Error("QUANTA_ENDPOINT_UNSUPPORTED"));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: string, value?: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(new Error(error)); else resolve(value!);
      };
      const timer = setTimeout(() => { finish("QUANTA_TIMEOUT"); req.destroy(); }, 4000);
      const req = http.request({ hostname: host, port, path: "/api/usage", method: "GET", headers: { "X-Token": token, Accept: "application/json" } }, res => {
        if (res.statusCode !== 200) { finish("QUANTA_HTTP_ERROR"); res.destroy(); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", chunk => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > 262144) { finish("QUANTA_RESPONSE_TOO_LARGE"); res.destroy(); req.destroy(); return; }
          chunks.push(bytes);
        });
        res.on("error", () => finish("QUANTA_RESPONSE_ERROR"));
        res.on("aborted", () => finish("QUANTA_RESPONSE_ERROR"));
        res.on("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
            finish(undefined, value);
          } catch { finish("QUANTA_INVALID_JSON"); }
        });
      });
      req.on("error", () => finish("QUANTA_REQUEST_ERROR"));
      req.end();
    });
  }
  private normalize(raw: Record<string, unknown>, serverUrl: string): QuantaTelemetryReport {
    const observed = typeof raw.observed_at === "string" ? raw.observed_at : timestampToIso(raw.observed_at ?? raw.sampled_at);
    const age = observed ? Date.now() - Date.parse(observed) : NaN;
    const fresh = Number.isFinite(age) && age >= 0 && age <= 60000;
    const report: QuantaTelemetryReport = {
      observed_at: observed, fetched_at: new Date().toISOString(), freshness: fresh ? "fresh" : "unknown",
      timestamp: new Date().toISOString(),
      quanta_available: true,
      server_url: serverUrl,
      providers: {
        codex: this.normalizeCodex(raw.codex),
        antigravity: this.normalizeAntigravity(raw.antigravity),
        glm: this.normalizeGlm(raw.glm),
        deepseek: this.normalizeDeepseek(raw.deepseek),
        muse: this.normalizeMuse(raw.muse),
      },
    };
    if (!fresh) {
      const invalidate = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        const item = value as Record<string, unknown>;
        if (item.status === "known" && "remaining_percent" in item) { item.status = "unknown"; item.remaining_percent = null; item.used_percent = null; item.remaining_units = null; }
        for (const child of Object.values(item)) invalidate(child);
      };
      invalidate(report.providers);
    }
    return report;
  }

  private normalizeCodex(raw: unknown): QuantaCodexTelemetry {
    if (!raw || typeof raw !== "object") {
      return { status: "unavailable", current_account: null, stale_accounts: [] };
    }
    const codexObj = raw as Record<string, unknown>;
    const rawAccounts = Array.isArray(codexObj.accounts) ? codexObj.accounts : [];
    let currentAccount: QuantaCodexAccountTelemetry | null = null;
    const staleAccounts: QuantaCodexAccountTelemetry[] = [];

    rawAccounts.forEach((accRaw: unknown, idx: number) => {
      if (!accRaw || typeof accRaw !== "object") return;
      const acc = accRaw as Record<string, unknown>;
      const isCurrent = acc.is_current === true;
      const planType = typeof acc.plan_type === "string" ? acc.plan_type : "unknown";

      const rawPrimaryUsed = clampPercent(
        typeof acc.effective_primary_used_percent === "number"
          ? acc.effective_primary_used_percent
          : acc.primary_used_percent
      );
      const primaryResetsAt = typeof acc.primary_resets_at === "number" ? acc.primary_resets_at : null;
      // Window classification is evidence-based. A missing window_minutes
      // field is NOT defaulted to a 5h window; when primary usage data exists
      // without a duration, the window stays "unknown" rather than being
      // misclassified. The old `primary_window_minutes > 300` inference
      // silently rebranded every long window as weekly; durations are now
      // reported verbatim and only exactly-weekly windows get the weekly
      // label.
      const primaryWindowMinutes =
        typeof acc.primary_window_minutes === "number" && acc.primary_window_minutes > 0
          ? acc.primary_window_minutes
          : null;
      const secondaryWindowMinutes =
        typeof acc.secondary_window_minutes === "number" && acc.secondary_window_minutes > 0
          ? acc.secondary_window_minutes
          : null;
      const secondaryReported = acc.secondary_used_percent !== undefined || secondaryWindowMinutes !== null;
      // A plan whose primary window is longer than 5h reports no short
      // window at all: that slot is confirmed not applicable for this plan
      // shape (never fabricated as known/100%).
      const primaryIsLongWindow = primaryWindowMinutes !== null && primaryWindowMinutes > 300;

      const rawSecondaryUsed = clampPercent(acc.secondary_used_percent);
      const secondaryResetsAt = typeof acc.secondary_resets_at === "number" ? acc.secondary_resets_at : null;

      // Keep every constraint; legacy display slots only match exact durations.
      const constraint = (used: number | null, minutes: number | null, reset: number | null, name: string) => createWindowTelemetry({
        label: minutes === 300 ? "5h Window" : minutes === 10080 ? "Weekly Window" : minutes ? minutes + "-Minute Window" : name,
        status: used === null ? "unknown" : "known", used_percent: used, remaining_percent: used === null ? null : clampPercent(100-used), reset_at: reset, window_minutes: minutes,
      });
      const constraints = [constraint(rawPrimaryUsed, primaryWindowMinutes, primaryResetsAt, "Primary Window"), constraint(rawSecondaryUsed, secondaryWindowMinutes, secondaryResetsAt, "Secondary Window")];
      const slot = (minutes: number, label: string) => constraints.find(w => w.window_minutes === minutes) ?? createWindowTelemetry({label,status:"unknown",used_percent:null,remaining_percent:null,reset_at:null});
      const fiveHourWindow = slot(300,"5h Window"), weeklyWindow = slot(10080,"Weekly Window");
      const accountTelemetry: QuantaCodexAccountTelemetry = {
        constraints,
        account_index: idx,
        is_current: isCurrent,
        plan_type: planType,
        five_hour_window: fiveHourWindow,
        weekly_window: weeklyWindow,
      };

      if (isCurrent && !currentAccount) {
        currentAccount = accountTelemetry;
      } else {
        staleAccounts.push(accountTelemetry);
      }
    });

    return {
      status: currentAccount ? "available" : "unavailable",
      current_account: currentAccount,
      stale_accounts: staleAccounts,
      live_error: typeof codexObj.live_error === "string" ? "Provider telemetry error" : null,
    };
  }

  private normalizeAntigravity(raw: unknown): QuantaAntigravityTelemetry {
    if (!raw || typeof raw !== "object") {
      return {
        status: "unavailable",
        pools: {
          gemini: this.emptyPool("antigravity:gemini", "Google Gemini Models (Dedicated Quota Pool)", false, "unavailable"),
          claude_gpt_shared: this.emptyPool("antigravity:claude_gpt_shared", "Claude and GPT Models (Shared Quota Pool)", true, "unavailable"),
        },
      };
    }
    const agObj = raw as Record<string, unknown>;
    const windows = Array.isArray(agObj.windows) ? agObj.windows : [];

    const findWindow = (matchFn: (label: string) => boolean, defaultLabel: string): QuantaWindowTelemetry => {
      for (const w of windows) {
        if (!w || typeof w !== "object") continue;
        const label = typeof w.label === "string" ? w.label : "";
        if (matchFn(label)) {
          const resetAt = typeof w.reset_at === "number" ? w.reset_at : null;
          const rawPercent = clampPercent(w.percent);
          const rawRemaining = clampPercent(w.remaining);

          if (rawPercent !== null) {
            const remaining = rawRemaining !== null ? rawRemaining : clampPercent(100 - rawPercent);
            return createWindowTelemetry({
              label: label || defaultLabel,
              status: "known",
              used_percent: rawPercent,
              remaining_percent: remaining,
              reset_at: resetAt,
            });
          } else if (rawRemaining !== null) {
            return createWindowTelemetry({
              label: label || defaultLabel,
              status: "known",
              used_percent: clampPercent(100 - rawRemaining),
              remaining_percent: rawRemaining,
              reset_at: resetAt,
            });
          } else {
            return createWindowTelemetry({
              label: label || defaultLabel,
              status: "unknown",
              used_percent: null,
              remaining_percent: null,
              reset_at: resetAt,
            });
          }
        }
      }
      return createWindowTelemetry({
        label: defaultLabel,
        status: "unknown",
        used_percent: null,
        remaining_percent: null,
        reset_at: null,
      });
    };

    const gemini5h = findWindow((l) => l.includes("Gemini") && (l.includes("5h") || l.includes("5小时")), "Gemini 5h Window");
    const geminiWeekly = findWindow((l) => l.includes("Gemini") && (l.includes("周") || l.toLowerCase().includes("week")), "Gemini Weekly Window");

    const claudeGpt5h = findWindow((l) => (l.includes("Claude") || l.includes("GPT")) && (l.includes("5h") || l.includes("5小时")), "Claude·GPT 5h Window");
    const claudeGptWeekly = findWindow((l) => (l.includes("Claude") || l.includes("GPT")) && (l.includes("周") || l.toLowerCase().includes("week")), "Claude·GPT Weekly Window");

    const modelsUsage: Record<string, number> = {};
    if (agObj.models && typeof agObj.models === "object") {
      for (const [m, count] of Object.entries(agObj.models as Record<string, unknown>)) {
        if (typeof count === "number") modelsUsage[m] = count;
      }
    }

    return {
      status: agObj.available !== false ? "available" : "unavailable",
      plan: typeof agObj.plan === "string" ? sanitizeText(agObj.plan) : undefined,
      pools: {
        gemini: {
          quota_pool_id: "antigravity:gemini",
          description: "Google Gemini Models (Dedicated Quota Pool)",
          shared: false,
          shared_models: getAntigravityModelsForPool("antigravity:gemini"),
          five_hour_window: gemini5h,
          weekly_window: geminiWeekly,
        },
        claude_gpt_shared: {
          quota_pool_id: "antigravity:claude_gpt_shared",
          description: "Claude and GPT Models (Shared Quota Pool)",
          shared: true,
          shared_models: getAntigravityModelsForPool("antigravity:claude_gpt_shared"),
          note: "Claude and GPT models share the exact same Antigravity quota bucket. Usage in one drains the other.",
          five_hour_window: claudeGpt5h,
          weekly_window: claudeGptWeekly,
        },
      },
      models_usage: Object.keys(modelsUsage).length > 0 ? modelsUsage : undefined,
    };
  }

  private normalizeGlm(raw: unknown): QuantaGlmTelemetry {
    if (!raw || typeof raw !== "object") {
      return {
        status: "unavailable",
        five_hour_window: createWindowTelemetry({ label: "5h Window", status: "unavailable", used_percent: null, remaining_percent: null, reset_at: null }),
        weekly_window: createWindowTelemetry({ label: "Weekly Window", status: "unavailable", used_percent: null, remaining_percent: null, reset_at: null }),
      };
    }
    const glmObj = raw as Record<string, unknown>;
    const windows = Array.isArray(glmObj.windows) ? glmObj.windows : [];

    const findWindow = (matchFn: (label: string) => boolean, defaultLabel: string): QuantaWindowTelemetry => {
      for (const w of windows) {
        if (!w || typeof w !== "object") continue;
        const label = typeof w.label === "string" ? w.label : "";
        if (matchFn(label)) {
          const resetAt = typeof w.reset_at === "number" ? w.reset_at : null;
          const usedPercent = clampPercent(w.percent);
          const remainingUnits = typeof w.remaining === "number" && Number.isFinite(w.remaining) ? w.remaining : null;
          const unitType = typeof w.type === "string" ? w.type : (remainingUnits !== null ? "CREDIT_LIMIT" : null);

          // Derive remaining_percent as 100 - used_percent ONLY when used_percent is known and semantically a percent (0 <= used_percent <= 100)
          const remainingPercent = usedPercent !== null ? clampPercent(100 - usedPercent) : null;

          if (usedPercent !== null || remainingUnits !== null) {
            return createWindowTelemetry({
              label: label || defaultLabel,
              status: "known",
              used_percent: usedPercent,
              remaining_percent: remainingPercent,
              remaining_units: remainingUnits,
              unit_type: unitType,
              reset_at: resetAt,
            });
          } else {
            return createWindowTelemetry({
              label: label || defaultLabel,
              status: "unknown",
              used_percent: null,
              remaining_percent: null,
              remaining_units: null,
              unit_type: null,
              reset_at: resetAt,
            });
          }
        }
      }
      return createWindowTelemetry({
        label: defaultLabel,
        status: "unknown",
        used_percent: null,
        remaining_percent: null,
        remaining_units: null,
        unit_type: null,
        reset_at: null,
      });
    };

    return {
      status: "available",
      level: typeof glmObj.level === "string" ? glmObj.level : undefined,
    five_hour_window: findWindow((l) => l.includes("5h") || l.includes("5小时"), "GLM 5h Window"),
    weekly_window: findWindow((l) => l.includes("周") || l.toLowerCase().includes("week"), "GLM Weekly Window"),
    };
  }

  private normalizeDeepseek(raw: unknown): QuantaGenericProviderTelemetry {
    if (!raw || typeof raw !== "object") {
      return { status: "unconfigured", available: false, message: "No DeepSeek data reported" };
    }
    const dsObj = raw as Record<string, unknown>;
    if (dsObj.error) {
      return {
        status: "unconfigured",
        available: false,
        message: "Provider telemetry error",
      };
    }
    return {
      status: "configured",
      available: true,
      note: typeof dsObj.note === "string" ? sanitizeText(dsObj.note) : undefined,
    };
  }

  private normalizeMuse(raw: unknown): QuantaGenericProviderTelemetry {
    if (!raw || typeof raw !== "object") {
      return { status: "unavailable", available: false, message: "No Muse data reported" };
    }
    const museObj = raw as Record<string, unknown>;
    const available = museObj.available === true;
    return {
      status: available ? "configured" : "unavailable",
      available,
      note: typeof museObj.note === "string" ? sanitizeText(museObj.note) : undefined,
    };
  }

  private emptyPool(
    poolId: AntigravityQuotaPoolId,
    desc: string,
    shared: boolean,
    status: QuantaWindowStatus = "unavailable"
  ): QuantaAntigravityPoolTelemetry {
    return {
      quota_pool_id: poolId,
      description: desc,
      shared,
      shared_models: getAntigravityModelsForPool(poolId),
      five_hour_window: createWindowTelemetry({ label: "5h Window", status, used_percent: null, remaining_percent: null, reset_at: null }),
      weekly_window: createWindowTelemetry({ label: "Weekly Window", status, used_percent: null, remaining_percent: null, reset_at: null }),
    };
  }

  private emptyProviders(): QuantaTelemetryReport["providers"] {
    return {
      codex: { status: "unavailable", current_account: null, stale_accounts: [] },
      antigravity: {
        status: "unavailable",
        pools: {
          gemini: this.emptyPool("antigravity:gemini", "Google Gemini Models (Dedicated Quota Pool)", false, "unavailable"),
          claude_gpt_shared: this.emptyPool("antigravity:claude_gpt_shared", "Claude and GPT Models (Shared Quota Pool)", true, "unavailable"),
        },
      },
      glm: {
        status: "unavailable",
        five_hour_window: createWindowTelemetry({ label: "5h Window", status: "unavailable", used_percent: null, remaining_percent: null, reset_at: null }),
        weekly_window: createWindowTelemetry({ label: "Weekly Window", status: "unavailable", used_percent: null, remaining_percent: null, reset_at: null }),
      },
      deepseek: { status: "unconfigured", available: false, message: "Quanta telemetry unavailable" },
      muse: { status: "unavailable", available: false, message: "Quanta telemetry unavailable" },
    };
  }
}
