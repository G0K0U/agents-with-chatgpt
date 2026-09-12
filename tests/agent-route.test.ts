// R4 rationale: nonzero reserve exclusion is critical; only confirmed zero means exhausted.
import { describe, it, expect } from "vitest";
import {
  evaluateRoute,
  calculateHealthFromRemaining,
  evaluatePoolWindows,
  type AgentRouteTaskType,
  type AgentRouteRiskLevel,
  type AgentRoutePreferredProvider,
} from "../src/telemetry/routing.js";
import type { QuantaTelemetryReport } from "../src/telemetry/quanta.js";
import { KNOWN_ANTIGRAVITY_MODELS, getAntigravityModelsForPool } from "../src/execution/antigravity.js";

describe("Policy-Governed Agent Router (agent_route)", () => {
  function createMockTelemetry(overrides: {
    codex5h?: number | null;
    gemini5h?: number | null;
    claudeGpt5h?: number | null;
    glm5h?: number | null;
  } = {}): QuantaTelemetryReport {
    const codexRemaining = "codex5h" in overrides ? overrides.codex5h : 80;
    const geminiRemaining = "gemini5h" in overrides ? overrides.gemini5h : 85;
    const claudeGptRemaining = "claudeGpt5h" in overrides ? overrides.claudeGpt5h : 90;
    const glmRemaining = "glm5h" in overrides ? overrides.glm5h : 0;

    return {
      timestamp: new Date().toISOString(),
      quanta_available: true,
      server_url: "http://127.0.0.1:8765",
      providers: {
        codex: {
          status: "available",
          current_account: {
            account_index: 0,
            is_current: true,
            plan_type: "plus",
            five_hour_window: {
              label: "5h Window",
              status: codexRemaining !== null ? "known" : "unknown",
              used_percent: codexRemaining !== null ? 100 - codexRemaining : null,
              remaining_percent: codexRemaining,
              reset_at: 1788600000,
              resets_at: 1788600000,
              resets_at_iso: "2026-09-05T12:00:00.000Z",
            },
            weekly_window: {
              label: "Weekly Window",
              status: "known",
              used_percent: 30,
              remaining_percent: 70,
              reset_at: 1789000000,
              resets_at: 1789000000,
              resets_at_iso: "2026-09-10T12:00:00.000Z",
            },
          },
          stale_accounts: [],
        },
        antigravity: {
          status: "available",
          pools: {
            gemini: {
              quota_pool_id: "antigravity:gemini",
              description: "Gemini Models",
              shared: false,
              shared_models: getAntigravityModelsForPool("antigravity:gemini"),
              five_hour_window: {
                label: "Gemini 5h",
                status: geminiRemaining !== null ? "known" : "unknown",
                used_percent: geminiRemaining !== null ? 100 - geminiRemaining : null,
                remaining_percent: geminiRemaining,
                reset_at: 1788605000,
                resets_at: 1788605000,
                resets_at_iso: "2026-09-05T13:00:00.000Z",
              },
              weekly_window: {
                label: "Gemini Weekly",
                status: "known",
                used_percent: 10,
                remaining_percent: 90,
                reset_at: 1789120000,
                resets_at: 1789120000,
                resets_at_iso: "2026-09-11T12:00:00.000Z",
              },
            },
            claude_gpt_shared: {
              quota_pool_id: "antigravity:claude_gpt_shared",
              description: "Claude & GPT Shared",
              shared: true,
              shared_models: getAntigravityModelsForPool("antigravity:claude_gpt_shared"),
              note: "Claude and GPT share the exact same quota pool",
              five_hour_window: {
                label: "Claude/GPT 5h",
                status: claudeGptRemaining !== null ? "known" : "unknown",
                used_percent: claudeGptRemaining !== null ? 100 - claudeGptRemaining : null,
                remaining_percent: claudeGptRemaining,
                reset_at: 1788610000,
                resets_at: 1788610000,
                resets_at_iso: "2026-09-05T14:00:00.000Z",
              },
              weekly_window: {
                label: "Claude/GPT Weekly",
                status: "known",
                used_percent: 20,
                remaining_percent: 80,
                reset_at: 1789200000,
                resets_at: 1789200000,
                resets_at_iso: "2026-09-12T12:00:00.000Z",
              },
            },
          },
        },
        glm: {
          status: "available",
          five_hour_window: {
            label: "5h Window",
            status: glmRemaining !== null ? "known" : "unknown",
            used_percent: glmRemaining !== null ? 100 - glmRemaining : null,
            remaining_percent: glmRemaining,
            reset_at: 1788599000,
            resets_at: 1788599000,
            resets_at_iso: "2026-09-05T11:00:00.000Z",
          },
          weekly_window: {
            label: "Weekly Window",
            status: "known",
            used_percent: 50,
            remaining_percent: 50,
            reset_at: 1789000000,
            resets_at: 1789000000,
            resets_at_iso: "2026-09-10T12:00:00.000Z",
          },
        },
        deepseek: { status: "unconfigured", available: false },
        muse: { status: "unavailable", available: false },
      },
    };
  }

  it("routes fast edit and low-risk coding to Codex when healthy", () => {
    const telemetry = createMockTelemetry({ codex5h: 80 });
    const route = evaluateRoute(telemetry, { task_type: "fast_edit", risk_level: "low" });

    expect(route.recommended_provider).toBe("codex");
    expect(route.recommended_model).toBe("codex-native");
    expect(route.quota_pool_id).toBe("codex:primary");
    expect(route.estimated_pool_health).toBe("healthy");
    expect(route.fallback.provider).toBe("gemini");
  });

  it("routes to Claude Sonnet on Antigravity when Codex quota is exhausted and Claude pool is healthy", () => {
    const telemetry = createMockTelemetry({ codex5h: 2, gemini5h: 90, claudeGpt5h: 90 });
    const route = evaluateRoute(telemetry, { task_type: "coding", risk_level: "low" });

    expect(route.recommended_provider).toBe("gemini");
    expect(route.recommended_model).toBe("claude-sonnet-4-6");
    expect(route.quota_pool_id).toBe("antigravity:claude_gpt_shared");
    expect(route.reasoning).toContain("codex=critical");
  });

  it("routes to Gemini Flash when both Codex and Claude/GPT pools are exhausted", () => {
    const telemetry = createMockTelemetry({ codex5h: 2, gemini5h: 90, claudeGpt5h: 2 });
    const route = evaluateRoute(telemetry, { task_type: "coding", risk_level: "low" });

    expect(route.recommended_provider).toBe("gemini");
    expect(route.recommended_model).toBe("gemini-3.8-flash-high");
    expect(route.quota_pool_id).toBe("antigravity:gemini");
    expect(route.reasoning).toContain("codex=critical");
  });

  it("P0-B: uses limiting window - Codex with 5h=100% but weekly=1% is rated exhausted, NOT healthy", () => {
    const telemetry = createMockTelemetry({ codex5h: 100 });
    // Set weekly window to 1% remaining (99% used)
    telemetry.providers.codex.current_account!.weekly_window.used_percent = 99;
    telemetry.providers.codex.current_account!.weekly_window.remaining_percent = 1;

    const route = evaluateRoute(telemetry, { task_type: "coding", risk_level: "low" });

    // Must NOT recommend Codex as healthy!
    expect(route.recommended_provider).not.toBe("codex");
    expect(route.recommended_provider).toBe("gemini");
    expect(route.recommended_model).toBe("claude-sonnet-4-6");
    expect(route.quota_pool_id).toBe("antigravity:claude_gpt_shared");
    expect(route.quota_context.codex_5h_remaining_percent).toBe(100);
    expect(route.quota_context.codex_weekly_remaining_percent).toBe(1);
    expect(route.reasoning).toContain("codex=critical");
  });

  it("P0-B: quota_context includes all 8 dual-window fields", () => {
    const telemetry = createMockTelemetry({ codex5h: 100, gemini5h: 29, claudeGpt5h: 69, glm5h: 100 });
    const route = evaluateRoute(telemetry, { task_type: "coding", risk_level: "low" });

    expect(route.quota_context).toHaveProperty("codex_5h_remaining_percent");
    expect(route.quota_context).toHaveProperty("codex_weekly_remaining_percent");
    expect(route.quota_context).toHaveProperty("antigravity_gemini_5h_remaining_percent");
    expect(route.quota_context).toHaveProperty("antigravity_gemini_weekly_remaining_percent");
    expect(route.quota_context).toHaveProperty("antigravity_claude_gpt_shared_5h_remaining_percent");
    expect(route.quota_context).toHaveProperty("antigravity_claude_gpt_shared_weekly_remaining_percent");
    expect(route.quota_context).toHaveProperty("glm_5h_remaining_percent");
    expect(route.quota_context).toHaveProperty("glm_weekly_remaining_percent");
  });

  it("routes high-risk / architecture task to Claude Sonnet with shared pool warning", () => {
    const telemetry = createMockTelemetry({ claudeGpt5h: 75 });
    const route = evaluateRoute(telemetry, { task_type: "architecture", risk_level: "high" });

    expect(route.recommended_provider).toBe("gemini");
    expect(route.recommended_model).toBe("claude-sonnet-4-6");
    expect(route.quota_pool_id).toBe("antigravity:claude_gpt_shared");
    expect(route.reasoning).toContain("antigravity:claude_gpt_shared");
  });

  it("falls back from Claude to Gemini Pro when Claude/GPT pool is exhausted", () => {
    const telemetry = createMockTelemetry({ claudeGpt5h: 2, gemini5h: 80 });
    const route = evaluateRoute(telemetry, { task_type: "architecture", risk_level: "high" });

    expect(route.recommended_provider).toBe("gemini");
    expect(route.recommended_model).toBe("gemini-3.8-pro-high");
    expect(route.quota_pool_id).toBe("antigravity:gemini");
  });

  it.each([
    { status: "available" as const, remaining: 0, expected: "exhausted only for this observed unattributed route" },
    { status: "available" as const, remaining: null, expected: "unknown" },
    { status: "unavailable" as const, remaining: null, expected: "unavailable; quota exhaustion is not established" },
  ])("GLM plan attribution: $status with $remaining remaining", ({ status, remaining, expected }) => {
    // Synthetic generic telemetry only; no fixture attests a live Start Plan.
    const telemetry = createMockTelemetry({ glm5h: remaining });
    telemetry.providers.glm.status = status;
    telemetry.providers.glm.weekly_window = {
      ...telemetry.providers.glm.weekly_window,
      status: "unknown", used_percent: null, remaining_percent: null,
      reset_at: null, resets_at: null, resets_at_iso: null,
    };
    const route = evaluateRoute(telemetry, { task_type: "coding", risk_level: "low" });
    const note = route.reasoning.slice(route.reasoning.indexOf("[Note:"));
    expect(note).toContain(`Generic Quanta GLM route: ${expected}`);
    expect(note).toContain("connection_mode and quota_pool: UNATTRIBUTED");
    expect(note).toContain("weekly=unknown");
    expect(note).toContain("Outside that window, native ZCode Connection mode = Desktop-managed builtin:zai-start-plan with GLM-5.3-Flash");
    expect(note).toContain("quota evidence for this route remains separate");
    expect(note).toContain("does not establish exhaustion of all GLM pipelines");
    expect(note).not.toMatch(/any GLM-dependent pipeline should be deferred|(?:all|any) GLM.*(?:defer|must wait)|free-window quota is currently exhausted/i);
    expect(route.quota_context.glm_5h_remaining_percent).toBe(remaining);
    expect(route.quota_context.glm_weekly_remaining_percent).toBeNull();
    if (remaining === null) {
      expect(note).toContain("5h=unknown");
      expect(note).not.toContain("0%");
      expect(note).not.toContain("exhausted only");
    } else {
      expect(note).toContain("5h=0%");
    }
    expect(route.recommended_provider).toBe("codex");
  });

  it("respects preferred_provider if healthy", () => {
    const telemetry = createMockTelemetry({ gemini5h: 90 });
    const route = evaluateRoute(telemetry, {
      task_type: "coding",
      risk_level: "low",
      preferred_provider: "gemini",
    });

    expect(route.recommended_provider).toBe("gemini");
    expect(route.recommended_model).toBe("gemini-3.8-flash-high");
  });

  it("P0-2 regression: every routing candidate and fallback exists in Antigravity execution allowlist", () => {
    const taskTypes: AgentRouteTaskType[] = ["coding", "review", "architecture", "fast_edit", "audit"];
    const riskLevels: AgentRouteRiskLevel[] = ["low", "medium", "high"];
    const preferredProviders: (AgentRoutePreferredProvider | undefined)[] = [undefined, "codex", "gemini"];
    const telemetryVariants = [
      createMockTelemetry({ codex5h: 80, gemini5h: 80, claudeGpt5h: 80 }),
      createMockTelemetry({ codex5h: 2, gemini5h: 80, claudeGpt5h: 80 }),
      createMockTelemetry({ codex5h: 80, gemini5h: 2, claudeGpt5h: 2 }),
      createMockTelemetry({ codex5h: 2, gemini5h: 2, claudeGpt5h: 2 }),
      createMockTelemetry({ codex5h: null, gemini5h: null, claudeGpt5h: null }),
    ];

    for (const telemetry of telemetryVariants) {
      for (const task_type of taskTypes) {
        for (const risk_level of riskLevels) {
          for (const preferred_provider of preferredProviders) {
            const decision = evaluateRoute(telemetry, { task_type, risk_level, preferred_provider });

            if (decision.decision === "blocked") {
              expect(decision.recommended_provider).toBeNull();
              expect(decision.recommended_model).toBeNull();
              expect(decision.fallback).toBeNull();
              expect(decision.blocked_reason).toBeTruthy();
              continue;
            }

            if (decision.recommended_provider === "gemini") {
              expect(
                KNOWN_ANTIGRAVITY_MODELS.has(decision.recommended_model!),
                `Recommended model "${decision.recommended_model}" must exist in KNOWN_ANTIGRAVITY_MODELS`
              ).toBe(true);
            }

            if (decision.fallback?.provider === "gemini") {
              expect(
                KNOWN_ANTIGRAVITY_MODELS.has(decision.fallback.model),
                `Fallback model "${decision.fallback.model}" must exist in KNOWN_ANTIGRAVITY_MODELS`
              ).toBe(true);
            }
          }
        }
      }
    }

    // Stale models must NOT be in KNOWN_ANTIGRAVITY_MODELS
    expect(KNOWN_ANTIGRAVITY_MODELS.has("claude-opus-4-6")).toBe(false);
    expect(KNOWN_ANTIGRAVITY_MODELS.has("gpt-5.3-codex-high")).toBe(false);
  });

  it("P0-1 regression: route logic does not prefer a model because telemetry is missing", () => {
    // When Claude/GPT telemetry is null/unknown, architecture/high-risk does NOT prefer Claude Sonnet
    const unknownTelemetry = createMockTelemetry({ claudeGpt5h: null, gemini5h: 80, codex5h: 80 });
    const decision = evaluateRoute(unknownTelemetry, { task_type: "architecture", risk_level: "high" });

    // Should route to Gemini Pro rather than assuming Claude pool is healthy
    expect(decision.recommended_provider).toBe("gemini");
    expect(decision.recommended_model).toBe("gemini-3.8-pro-high");
    expect(decision.quota_pool_id).toBe("antigravity:gemini");
    expect(decision.estimated_pool_health).toBe("healthy");
  });

  it("R3: all pools exhausted yields decision=blocked with no forced recommendation", () => {
    const telemetry = createMockTelemetry({ codex5h: 1, gemini5h: 1, claudeGpt5h: 1 });
    const route = evaluateRoute(telemetry, { task_type: "coding", risk_level: "low" });
    expect(route.decision).toBe("blocked");
    expect(route.recommended_provider).toBeNull();
    expect(route.recommended_model).toBeNull();
    expect(route.quota_pool_id).toBeNull();
    expect(route.fallback).toBeNull();
    expect(route.blocked_reason).toContain("all_pools_ineligible");
  });

  it("R3: a KNOWN exhausted window is not masked by an unknown sibling window", () => {
    const weeklyExhausted = {
      label: "Weekly", status: "known" as const,
      used_percent: 100, remaining_percent: 0, reset_at: null, resets_at_iso: null,
    };
    const unknown5h = {
      label: "5h", status: "unknown" as const,
      used_percent: null, remaining_percent: null, reset_at: null, resets_at_iso: null,
    };
    // weekly exhausted + 5h unknown -> exhausted (not "unknown", not "healthy")
    const result = evaluatePoolWindows(unknown5h, weeklyExhausted, true);
    expect(result.health).toBe("exhausted");
    expect(result.isExhausted).toBe(true);
    // mirrored: 5h exhausted + weekly unknown
    const mirrored = evaluatePoolWindows({ ...weeklyExhausted, label: "5h" }, { ...unknown5h, label: "Weekly" }, true);
    expect(mirrored.health).toBe("exhausted");
  });

  it("R3: not_applicable windows are ignored, unknown windows cap health at unknown", () => {
    const notApplicable = {
      label: "5h", status: "not_applicable" as const,
      used_percent: null, remaining_percent: null, reset_at: null, resets_at_iso: null,
    };
    const weeklyHealthy = {
      label: "Weekly", status: "known" as const,
      used_percent: 20, remaining_percent: 80, reset_at: null, resets_at_iso: null,
    };
    const singleWindow = evaluatePoolWindows(notApplicable, weeklyHealthy, true);
    expect(singleWindow.health).toBe("healthy"); // weekly-only plan shape is routable on real data
    expect(singleWindow.effectiveRemaining).toBe(80);

    const unknownWeekly = {
      label: "Weekly", status: "unknown" as const,
      used_percent: null, remaining_percent: null, reset_at: null, resets_at_iso: null,
    };
    const known5h = {
      label: "5h", status: "known" as const,
      used_percent: 10, remaining_percent: 90, reset_at: null, resets_at_iso: null,
    };
    const capped = evaluatePoolWindows(known5h, unknownWeekly, true);
    expect(capped.health).toBe("unknown"); // cannot confirm healthy with a missing window
    expect(capped.effectiveRemaining).toBe(90);
  });

  describe("P0-B: 5-tier health calculation policy", () => {
    it("classifies remaining percentage into the 5 exact tiers", () => {
      // <= 2% -> exhausted
      expect(calculateHealthFromRemaining(0, true)).toBe("exhausted");
      expect(calculateHealthFromRemaining(1, true)).toBe("critical");
      expect(calculateHealthFromRemaining(2, true)).toBe("critical");

      // <= 10% -> critical
      expect(calculateHealthFromRemaining(3, true)).toBe("critical");
      expect(calculateHealthFromRemaining(10, true)).toBe("critical");

      // <= 25% -> low
      expect(calculateHealthFromRemaining(11, true)).toBe("low");
      expect(calculateHealthFromRemaining(25, true)).toBe("low");

      // <= 50% -> moderate
      expect(calculateHealthFromRemaining(26, true)).toBe("moderate");
      expect(calculateHealthFromRemaining(50, true)).toBe("moderate");

      // > 50% -> healthy
      expect(calculateHealthFromRemaining(51, true)).toBe("healthy");
      expect(calculateHealthFromRemaining(100, true)).toBe("healthy");

      // edge cases
      expect(calculateHealthFromRemaining(null, true)).toBe("unknown");
      expect(calculateHealthFromRemaining(100, false)).toBe("unavailable");
    });

    it("evaluatePoolWindows takes minimum of known 5h and weekly windows", () => {
      const win5h = {
        label: "5h",
        status: "known" as const,
        used_percent: 0,
        remaining_percent: 100,
        reset_at: null,
        resets_at_iso: null,
      };
      const winWeekly = {
        label: "Weekly",
        status: "known" as const,
        used_percent: 99,
        remaining_percent: 1,
        reset_at: null,
        resets_at_iso: null,
      };

      const result = evaluatePoolWindows(win5h, winWeekly, true);
      expect(result.effectiveRemaining).toBe(1);
      expect(result.health).toBe("critical");
      expect(result.isExhausted).toBe(false);
      expect(result.isHealthy).toBe(false);
    });
  });
});
