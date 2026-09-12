/**
 * Policy-Governed Agent Router
 *
 * Evaluates task type, risk level, and local Quanta usage telemetry to generate
 * optimal provider/model recommendations with fallback chains.
 */

import type { QuantaTelemetryReport, QuantaWindowTelemetry } from "./quanta.js";
import { DEFAULT_GEMINI_MODEL } from "../execution/antigravity.js";

export type AgentRouteTaskType = "coding" | "review" | "architecture" | "fast_edit" | "audit";
export type AgentRouteRiskLevel = "low" | "medium" | "high";
export type AgentRoutePreferredProvider = "codex" | "gemini";

export interface AgentRouteRequest {
  task_type: AgentRouteTaskType;
  risk_level?: AgentRouteRiskLevel;
  preferred_provider?: AgentRoutePreferredProvider;
}

export type PoolHealth = "healthy" | "moderate" | "low" | "critical" | "exhausted" | "unknown" | "unavailable";

export interface RouteFallback {
  provider: "codex" | "gemini";
  model: string;
  reason: string;
  /**
   * True when the fallback stays inside the same quota pool: it is a
   * model-tier alternative, NOT a quota failover — the shared pool's limit
   * still applies to it.
   */
  same_pool_model_alternative: boolean;
}

export interface AgentRouteDecision {
  /** "route" when an eligible pool exists; "blocked" when none does. */
  decision: "route" | "blocked";
  recommended_provider: "codex" | "gemini" | null;
  recommended_model: string | null;
  quota_pool_id: string | null;
  estimated_pool_health: PoolHealth;
  fallback: RouteFallback | null;
  reasoning: string;
  /** Set only when decision === "blocked". */
  blocked_reason: string | null;
  quota_context: {
    codex_5h_remaining_percent: number | null;
    codex_weekly_remaining_percent: number | null;
    antigravity_gemini_5h_remaining_percent: number | null;
    antigravity_gemini_weekly_remaining_percent: number | null;
    antigravity_claude_gpt_shared_5h_remaining_percent: number | null;
    antigravity_claude_gpt_shared_weekly_remaining_percent: number | null;
    glm_5h_remaining_percent: number | null;
    glm_weekly_remaining_percent: number | null;
  };
}

export function calculateHealthFromRemaining(rem: number | null, providerAvailable: boolean): PoolHealth {
  if (!providerAvailable) return "unavailable";
  if (rem === null) return "unknown";
  if (rem === 0) return "exhausted";
  if (rem <= 10) return "critical";
  if (rem <= 25) return "low";
  if (rem <= 50) return "moderate";
  return "healthy";
}

export interface WindowEvaluation {
  health: PoolHealth;
  effectiveRemaining: number | null;
  fiveHourRemaining: number | null;
  weeklyRemaining: number | null;
  isExhausted: boolean;
  isCriticalOrExhausted: boolean;
  isHealthy: boolean;
}

export function evaluatePoolWindows(
  fiveHourWindow: QuantaWindowTelemetry | undefined,
  weeklyWindow: QuantaWindowTelemetry | undefined,
  providerAvailable: boolean,
  constraints?: QuantaWindowTelemetry[]
): WindowEvaluation {
  if (!providerAvailable) {
    return {
      health: "unavailable",
      effectiveRemaining: null,
      fiveHourRemaining: null,
      weeklyRemaining: null,
      isExhausted: false,
      isCriticalOrExhausted: true,
      isHealthy: false,
    };
  }

  const asKnown = (w: QuantaWindowTelemetry | undefined): number | null =>
    w && w.status === "known" && typeof w.remaining_percent === "number" ? Number.isFinite(w.remaining_percent) && w.remaining_percent >= 0 && w.remaining_percent <= 100 ? w.remaining_percent : null : null;
  const h5 = asKnown(fiveHourWindow);
  const hWeekly = asKnown(weeklyWindow);

  // Slots that are relevant for health: "not_applicable" windows are absent
  // from this plan shape and never gate the decision; "unknown" slots cannot
  // be treated as healthy.
  const windows = constraints ?? [fiveHourWindow, weeklyWindow];
  const relevantUnknown =
    windows.some(
      (w) => w?.status !== "not_applicable" && asKnown(w) === null
    );

  const knownValues = windows.map(asKnown).filter((v): v is number => v !== null);
  const effective = knownValues.length > 0 ? Math.min(...knownValues) : null;

  let health: PoolHealth;
  if (knownValues.length === 0) {
    health = "unknown";
  } else if (knownValues.some((v) => v === 0)) {
    // A KNOWN exhausted window must never be masked by an unknown sibling.
    health = "exhausted";
  } else if (knownValues.some((v) => v <= 10)) {
    health = "critical"; // Reserve exclusion is not provider exhaustion.
  } else if (relevantUnknown) {
    // Real data exists but part of the picture is missing: cannot confirm
    // healthy. Report the conservative "unknown" instead of fabricating.
    health = "unknown";
  } else {
    health = calculateHealthFromRemaining(effective, true);
  }

  const isExhausted = health === "exhausted" || health === "unavailable";
  const isCriticalOrExhausted = isExhausted || health === "critical";
  // "healthy" (> 50%) or "moderate" (> 25%) are considered healthy/safe to route
  const isHealthy = health === "healthy" || health === "moderate";

  return {
    health,
    effectiveRemaining: effective,
    fiveHourRemaining: h5,
    weeklyRemaining: hWeekly,
    isExhausted,
    isCriticalOrExhausted,
    isHealthy,
  };
}

interface RouteCandidate {
  provider: "codex" | "gemini";
  model: string;
  poolId: string;
  health: PoolHealth;
  effectiveRemaining: number | null;
  /** Provider availability + quota eligibility rank; lower is better. */
  eligibilityRank: number;
  /** Task-profile affinity; lower is better. Only orders candidates — never bypasses eligibility. */
  profileScore: number;
}

const ELIGIBILITY_ORDER: PoolHealth[] = ["healthy", "moderate", "low"];
const ELIGIBILITY_RANK: Record<string, number> = { healthy: 0, moderate: 1, low: 2, unknown: 3 };

function isEligibleHealth(health: PoolHealth): boolean {
  // critical / exhausted / unavailable pools are ineligible for EVERY task
  // type, preference, and fallback position — no exceptions.
  return ELIGIBILITY_ORDER.includes(health);
}

function poolHealthRank(health: PoolHealth): number {
  return ELIGIBILITY_RANK[health] ?? 99;
}

function describeRemaining(rem: number | null): string {
  return rem !== null ? rem + "%" : "unknown";
}

/**
 * Policy-governed route evaluation.
 *
 * All candidates (every task type, caller preference, and fallback position)
 * pass through ONE eligibility filter: a pool is a candidate only when its
 * provider is available and its quota health is not critical/exhausted/
 * unavailable. Preference and task type only ORDER eligible candidates.
 * When no pool is eligible the decision is explicitly "blocked" — the router
 * never forces a recommendation against a dead or drained pool. A fallback
 * into the SAME quota pool is labeled as a model-tier alternative, not a
 * quota failover. GLM is telemetry-only here: it is not an auto-scheduled
 * target on this bridge (its exhaustion is surfaced as context; any future
 * GLM dispatch would go through the direct ZCode path, not this router).
 */
export function evaluateRoute(
  telemetry: QuantaTelemetryReport,
  req: AgentRouteRequest
): AgentRouteDecision {
  const taskType = req.task_type;
  const riskLevel = req.risk_level ?? "low";
  const preferred = req.preferred_provider;

  const codexAvailable = telemetry.providers?.codex?.status === "available";
  const codexAcc = telemetry.providers?.codex?.current_account;
  const codexInfo = evaluatePoolWindows(codexAcc?.five_hour_window, codexAcc?.weekly_window, codexAvailable, codexAcc?.constraints);

  const antigravityAvailable = telemetry.providers?.antigravity?.status === "available";
  const geminiPool = telemetry.providers?.antigravity?.pools?.gemini;
  const geminiInfo = evaluatePoolWindows(geminiPool?.five_hour_window, geminiPool?.weekly_window, antigravityAvailable);

  const claudeGptPool = telemetry.providers?.antigravity?.pools?.claude_gpt_shared;
  const claudeGptInfo = evaluatePoolWindows(claudeGptPool?.five_hour_window, claudeGptPool?.weekly_window, antigravityAvailable);

  const glmAvailable = telemetry.providers?.glm?.status === "available";
  const glmInfo = evaluatePoolWindows(telemetry.providers?.glm?.five_hour_window, telemetry.providers?.glm?.weekly_window, glmAvailable);

  const quotaContext = {
    codex_5h_remaining_percent: codexInfo.fiveHourRemaining,
    codex_weekly_remaining_percent: codexInfo.weeklyRemaining,
    antigravity_gemini_5h_remaining_percent: geminiInfo.fiveHourRemaining,
    antigravity_gemini_weekly_remaining_percent: geminiInfo.weeklyRemaining,
    antigravity_claude_gpt_shared_5h_remaining_percent: claudeGptInfo.fiveHourRemaining,
    antigravity_claude_gpt_shared_weekly_remaining_percent: claudeGptInfo.weeklyRemaining,
    glm_5h_remaining_percent: glmInfo.fiveHourRemaining,
    glm_weekly_remaining_percent: glmInfo.weeklyRemaining,
  };

  // Task-profile model choice per pool. These scores only rank candidates;
  // eligibility is applied uniformly afterwards.
  const profileFor = (provider: "codex" | "gemini", poolId: string): { score: number; model: string } => {
    if (provider === "codex") {
      return {
        score: taskType === "coding" || taskType === "fast_edit" ? 0 : taskType === "audit" ? 1 : 2,
        model: "codex-native",
      };
    }
    if (poolId === "antigravity:claude_gpt_shared") {
      const high = riskLevel === "high" || taskType === "architecture" || taskType === "review";
      // Original routing policy: when Codex is ineligible and the caller did
      // not express a preference, routine coding/fast_edit reroutes to the
      // shared Claude/GPT pool ahead of the dedicated Gemini pool.
      const codexReroute = !codexEligible && !preferred && (taskType === "coding" || taskType === "fast_edit");
      return {
        score: high ? 0 : codexReroute ? 0 : taskType === "audit" ? 2 : 1,
        model: "claude-sonnet-4-6",
      };
    }
    // dedicated Gemini pool
    if (taskType === "audit" || taskType === "fast_edit" || taskType === "coding") {
      return { score: taskType === "audit" ? 0 : 1, model: DEFAULT_GEMINI_MODEL };
    }
    return { score: 1, model: "gemini-3.8-pro-high" };
  };

  const candidates: RouteCandidate[] = [];
  const codexEligible = isEligibleHealth(codexInfo.health);
  const codexProfile = profileFor("codex", "codex:primary");
  candidates.push({
    provider: "codex", model: codexProfile.model, poolId: "codex:primary",
    health: codexInfo.health, effectiveRemaining: codexInfo.effectiveRemaining,
    eligibilityRank: poolHealthRank(codexInfo.health), profileScore: codexProfile.score,
  });
  const geminiProfile = profileFor("gemini", "antigravity:gemini");
  candidates.push({
    provider: "gemini", model: geminiProfile.model, poolId: "antigravity:gemini",
    health: geminiInfo.health, effectiveRemaining: geminiInfo.effectiveRemaining,
    eligibilityRank: poolHealthRank(geminiInfo.health), profileScore: geminiProfile.score,
  });
  const sharedProfile = profileFor("gemini", "antigravity:claude_gpt_shared");
  candidates.push({
    provider: "gemini", model: sharedProfile.model, poolId: "antigravity:claude_gpt_shared",
    health: claudeGptInfo.health, effectiveRemaining: claudeGptInfo.effectiveRemaining,
    eligibilityRank: poolHealthRank(claudeGptInfo.health), profileScore: sharedProfile.score,
  });

  const eligible = candidates.filter((candidate) => isEligibleHealth(candidate.health));
  const poolStates = "codex=" + codexInfo.health + " (limiting window " + describeRemaining(codexInfo.effectiveRemaining) + "), " +
    "antigravity:gemini=" + geminiInfo.health + " (" + describeRemaining(geminiInfo.effectiveRemaining) + "), " +
    "antigravity:claude_gpt_shared=" + claudeGptInfo.health + " (" + describeRemaining(claudeGptInfo.effectiveRemaining) + ")";

  if (eligible.length === 0) {
    return {
      decision: "blocked",
      recommended_provider: null,
      recommended_model: null,
      quota_pool_id: null,
      estimated_pool_health: candidates.every(c => c.health === "unavailable") ? "unavailable" : candidates.some(c => c.health === "critical" || c.health === "exhausted") ? "critical" : "unknown",
      fallback: null,
      reasoning: "No quota pool is currently eligible. Pool states: " + poolStates + ". Defer the task or wait for a quota window reset; no forced recommendation is made.",
      blocked_reason: "all_pools_ineligible: " + poolStates,
      quota_context: quotaContext,
    };
  }

  eligible.sort((a, b) => {
    const prefA = preferred && a.provider === preferred ? 0 : 1;
    const prefB = preferred && b.provider === preferred ? 0 : 1;
    if (prefA !== prefB) return prefA - prefB;
    // Pool-health eligibility dominates task-profile affinity: a pool with
    // verified headroom outranks a better-profiled pool whose quota state is
    // unknown. Preference never bypasses eligibility (already filtered).
    if (a.eligibilityRank !== b.eligibilityRank) return a.eligibilityRank - b.eligibilityRank;
    if (a.profileScore !== b.profileScore) return a.profileScore - b.profileScore;
    return 0;
  });

  const primary = eligible[0];
  // Fallback: a genuinely different quota pool first (real quota failover).
  // Only when no other pool is eligible may a same-pool model stand in, and
  // it is labeled as a model-tier alternative — switching models inside one
  // shared pool does NOT escape that pool's quota.
  const otherPool = eligible.find((c) => c.poolId !== primary.poolId);
  const samePoolAlternate = eligible.find((c) => c !== primary && c.poolId === primary.poolId);
  let fallback: RouteFallback | null = null;
  if (otherPool) {
    fallback = {
      provider: otherPool.provider,
      model: otherPool.model,
      reason: "Quota failover to " + otherPool.poolId + " (pool health: " + otherPool.health + ").",
      same_pool_model_alternative: false,
    };
  } else if (samePoolAlternate) {
    fallback = {
      provider: samePoolAlternate.provider,
      model: samePoolAlternate.model,
      reason: "Model-tier alternative inside the same quota pool (" + primary.poolId + ") — NOT a quota failover; the shared limit still applies.",
      same_pool_model_alternative: true,
    };
  }

  // GLM attribution note (always surfaced; GLM is telemetry-only on this
  // bridge — never an auto-scheduled route target, so its state must not be
  // over-claimed in either direction).
  const fmtWindow = (w: QuantaWindowTelemetry | undefined): string =>
    w && w.status === "known" && typeof w.remaining_percent === "number"
      ? w.remaining_percent + "%"
      : "unknown";
  const glmRaw = telemetry.providers?.glm;
  const glm5h = glmRaw?.five_hour_window;
  const glmVerdict =
    glmRaw?.status === "unavailable"
      ? "unavailable; quota exhaustion is not established"
      : glm5h && glm5h.status === "known" && glm5h.remaining_percent === 0
        ? "exhausted only for this observed unattributed route"
        : glm5h && glm5h.status === "known" && typeof glm5h.remaining_percent === "number"
          ? "known headroom on the observed unattributed route"
          : "unknown";
  const glmNote =
    "[Note: Generic Quanta GLM route: " + glmVerdict + ". Observed window telemetry: " +
    "5h=" + fmtWindow(glm5h) + ", weekly=" + fmtWindow(glmRaw?.weekly_window) +
    "; connection_mode and quota_pool: UNATTRIBUTED. Outside that window, native ZCode " +
    "Connection mode = Desktop-managed builtin:zai-start-plan with GLM-5.3-Flash " +
    "(observed 2026-09-12 through the live desktop-agent chain; quota evidence for this route " +
    "remains separate). This observation covers only this route and " +
    "does not establish exhaustion of all GLM pipelines.]";

  const reasoning =
    (preferred ? "Caller preferred " + preferred + ". " : "") +
    "Selected " + primary.provider + " (" + primary.model + ") on pool " + primary.poolId +
    " with health " + primary.health + " (limiting window " + describeRemaining(primary.effectiveRemaining) + " remaining). " +
    "Pool states: " + poolStates + ". " + glmNote;

  return {
    decision: "route",
    recommended_provider: primary.provider,
    recommended_model: primary.model,
    quota_pool_id: primary.poolId,
    estimated_pool_health: primary.health,
    fallback,
    reasoning,
    blocked_reason: null,
    quota_context: quotaContext,
  };
}
