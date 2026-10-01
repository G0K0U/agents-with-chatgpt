import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ModelCatalogService,
  resolveModelSelection,
  resolveCodexExecutionSelection,
  bridgeCodexPreference,
  normalizeModelToken,
  type CodexModelListPage,
} from "../src/execution/model-catalog.js";
import { TaskError } from "../src/execution/tasks.js";
import { nullLogger } from "../src/logger/index.js";
import { isolateStateDir } from "./helpers.js";

function fakeCodexClient(pages: CodexModelListPage[], opts: { failAfterInit?: boolean; userAgent?: string } = {}) {
  return {
    initializeResult: { userAgent: opts.userAgent ?? "codex-with-chatgpt-c2c/9.9.9 (test)" },
    initialize: async () => {
      if (opts.failAfterInit) throw new Error("boom after init");
      return { userAgent: opts.userAgent ?? "codex-with-chatgpt-c2c/9.9.9 (test)" };
    },
    request: async (_method: string, params?: unknown) => {
      if (_method === "model/list") {
        const cursor = (params as { cursor?: string } | undefined)?.cursor;
        const index = cursor ? Number.parseInt(cursor, 10) : 0;
        return pages[index] ?? { data: [], nextCursor: null };
      }
      return {};
    },
    close: async () => undefined,
  } as never;
}

const codexEntry = (id: string, efforts: string[], extra: Record<string, unknown> = {}) => ({
  id,
  displayName: id.toUpperCase(),
  isDefault: extra.isDefault === true,
  hidden: false,
  defaultReasoningEffort: efforts[0] ?? null,
  supportedReasoningEfforts: efforts.map((effort) => ({ reasoningEffort: effort, description: `desc ${effort}` })),
  inputModalities: ["text"],
  additionalSpeedTiers: [],
  ...extra,
});

describe("DSH first-class model catalog", () => {
  it("projects exact local capabilities and resolves GSQ with high effort", async () => {
    const generation = "dsh-test-generation";
    const service = new ModelCatalogService({
      workspaceRoot: process.cwd(),
      dshHealth: async () => ({ adapter: "dsh-a2c-native-session-adapter", version: "0.2.0",
        generation, hostPid: 1, dshVersion: "2.0.13-beta.1", harnessVersion: "0.1.6-alpha.2",
        capabilities: { selectedTask: true, modelSelectionScope: "transactional-global-lease" } }),
      dshModelCatalog: async () => ({ generation, default: { provider: "qqz-kvmem",
        model: "Bonsai2-CRACK-PQ2.ninfer" }, groups: [{ id: "qqz-kvmem", name: "Local",
        models: [{ id: "Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf", name: "GSQ",
          slot: "a", backend: "kvmem", profile: "vision:fast", contextWindow: 131072,
          inputModalities: ["text", "image"], multimodalEvidence: "configured mmproj file and vision profiles",
          reasoning: { efforts: ["low", "medium", "high"].map((id) => ({ id })) } },
        { id: "Bonsai2-CRACK-PQ2.ninfer", name: "CRACK", slot: "b", backend: "ninfer",
          profile: "text:fast", contextWindow: 262144, inputModalities: ["text"],
          reasoning: { efforts: ["low", "medium", "high"].map((id) => ({ id })) } }] }] }),
    });
    const catalog = await service.get(["dsh"]);
    const section = catalog.agents[0]!;
    expect(section.agent).toBe("dsh");
    expect(section.capabilities?.modelSelectionScope).toBe("transactional-global-lease");
    const gsq = section.models.find((entry) => entry.model_id.includes("GSQ"))!;
    expect(gsq.input_modalities).toEqual(["text", "image"]);
    expect(gsq.context_window).toBe(131072);
    expect(gsq.model_selection_scope).toBe("transactional-global-lease");
    expect(resolveModelSelection(catalog, { agent: "dsh", model: gsq.model_id, effort: "high" }).selection)
      .toMatchObject({ agent: "dsh", model_id: gsq.model_id, effort: "high" });
  });
});

function codexService(pages: CodexModelListPage[], opts: ConstructorParameters<typeof ModelCatalogService>[0] = {}) {
  return new ModelCatalogService({
    logger: nullLogger,
    workspaceRoot: process.cwd(),
    codexExecutableResolver: () => "C:\\fake\\codex.exe",
    codexClientFactory: () => fakeCodexClient(pages, { userAgent: "codex-with-chatgpt-c2c/0.153.0 (test)" }),
    ...opts,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("model catalog discovery", () => {
  it("lists codex models from model/list with pagination and honest metadata", async () => {
    isolateStateDir();
    const service = codexService([
      { data: [codexEntry("gpt-6-astra", ["low", "medium", "high", "xhigh", "max", "ultra"], { isDefault: true, defaultReasoningEffort: "medium" })], nextCursor: "1" },
      { data: [codexEntry("gpt-5.6-sol", ["low", "medium", "high"], {})], nextCursor: null },
    ]);
    const catalog = await service.get(["codex"]);
    const section = catalog.agents.find((s) => s.agent === "codex")!;
    expect(section.completeness).toBe("complete");
    expect(section.models.map((m) => m.model_id)).toEqual(["gpt-6-astra", "gpt-5.6-sol"]);
    const astra = section.models[0];
    expect(astra.supported_efforts.map((e) => e.effort)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(astra.default_effort).toBe("medium");
    expect(astra.is_default).toBe(true);
    expect(section.runtime_version).toBe("0.153.0");
    expect(catalog.freshness).toBe("fresh");
  });

  it("does not include gpt-6-sol when the account catalog does not advertise it", async () => {
    isolateStateDir();
    const service = codexService([{ data: [codexEntry("gpt-6-astra", ["max"], { isDefault: true })], nextCursor: null }]);
    const catalog = await service.get(["codex"]);
    const ids = catalog.agents[0].models.map((m) => m.model_id);
    expect(ids).not.toContain("gpt-6-sol");
    expect(ids).toContain("gpt-6-astra");
  });

  it("serves explicitly stale data when a forced refresh fails, and never re-stamps it as fresh", async () => {
    isolateStateDir();
    let failing = false;
    const service = new ModelCatalogService({
      logger: nullLogger,
      workspaceRoot: process.cwd(),
      codexExecutableResolver: () => "C:\\fake\\codex.exe",
      codexClientFactory: () => {
        if (failing) throw new Error("probe transport broke");
        return fakeCodexClient([{ data: [codexEntry("gpt-6-astra", ["max"], { isDefault: true })], nextCursor: null }]);
      },
    });
    const fresh = await service.get(["codex"]);
    expect(fresh.freshness).toBe("fresh");
    failing = true;
    const stale = await service.get(["codex"], { forceRefresh: true });
    expect(stale.freshness).toBe("stale");
    const section = stale.agents.find((s) => s.agent === "codex")!;
    expect(section.served_from_stale_cache).toBe(true);
    expect(section.error).toContain("probe transport broke");
    // The stale models are still shown for display, with their ORIGINAL observation time.
    expect(section.models.map((m) => m.model_id)).toEqual(["gpt-6-astra"]);
    expect(section.observed_at).toBe(fresh.agents[0].observed_at);
  });

  it("keeps one agent failing from masking another", async () => {
    isolateStateDir();
    const service = new ModelCatalogService({
      logger: nullLogger,
      workspaceRoot: process.cwd(),
      codexExecutableResolver: () => "C:\\fake\\codex.exe",
      codexClientFactory: () => fakeCodexClient([{ data: [codexEntry("gpt-6-astra", ["max"], { isDefault: true })], nextCursor: null }]),
      zcodeModelCatalog: async () => {
        throw new Error("z2c unreachable");
      },
    });
    const catalog = await service.get(["codex", "zcode"]);
    const codex = catalog.agents.find((s) => s.agent === "codex")!;
    const zcode = catalog.agents.find((s) => s.agent === "zcode")!;
    expect(codex.completeness).toBe("complete");
    expect(zcode.completeness).toBe("unknown");
    expect(zcode.error).toContain("z2c unreachable");
    expect(codex.models.length).toBe(1);
  });

  it("maps the real z2c tool DTO: per-model reasoning, no provider inference, partial completeness", async () => {
    isolateStateDir();
    // Fixture copied from the z2c-service tool's actual output shape
    // (see the z2c phase3 tests): per-model reasoning_levels, observed
    // identity only, session-scoped current selection.
    const service = new ModelCatalogService({
      logger: nullLogger,
      workspaceRoot: process.cwd(),
      zcodeModelCatalog: async () => ({
        z2c_protocol_version: "1",
        provider: "zcode-official",
        provider_status: "healthy",
        zcode_runtime_version: "0.16.9",
        evidence_source: "session-settings-observed",
        observed_session_id: "sess_observed",
        attempts: [{ session_id: "sess_recent…", outcome: "session-not-active", error: "ZCode Protocol error -32004: Session is not active" }],
        candidates_considered: 2,
        configured_identity: { modelId: "GLM-5.3-Flash", thoughtLevel: "max", providerId: null },
        runtime_settings: {
          source_session_id: "sess_observed",
          observed_at: "2026-09-26T00:00:00.000Z",
          current: { provider_id: "zai-api", model_id: "GLM-5.3-Flash", thought_level: "max" },
          current_model_thought_levels: ["high", "max"],
          models: [
            { provider_id: "zai-api", model_id: "GLM-5.3-Flash", label: "GLM-5.3-Flash", reasoning_levels: ["medium", "max"], reasoning_default_level: "max" },
            { provider_id: "zai-api", model_id: "GLM-5.3", label: "GLM-5.3", reasoning_levels: ["medium", "high"], reasoning_default_level: "medium" },
            // No provider identity observed: stays null, never inherited.
            { provider_id: null, model_id: "mystery-model", label: null, reasoning_levels: [], reasoning_default_level: null },
          ],
        },
      }),
    });
    const catalog = await service.get(["zcode"]);
    const section = catalog.agents[0];
    // A single session's view is never an account-wide complete catalog.
    expect(section.completeness).toBe("partial");
    expect(section.evidence_source).toBe("session-settings-observed");
    expect(section.observation?.candidates_considered).toBe(2);
    expect(section.observation?.attempts?.[0]?.outcome).toBe("session-not-active");
    expect(section.current_selection).toEqual({ provider_id: "zai-api", model_id: "GLM-5.3-Flash", thought_level: "max" });
    expect(section.configured_identity).toEqual({ modelId: "GLM-5.3-Flash", thoughtLevel: "max", providerId: null });
    // Section observation time comes from the SOURCE, not the fetch.
    expect(section.observed_at).toBe("2026-09-26T00:00:00.000Z");
    const flash = section.models[0];
    expect(flash).toMatchObject({ provider_id: "zai-api", model_id: "GLM-5.3-Flash", default_effort: "max" });
    expect(flash.supported_efforts.map((e) => e.effort)).toEqual(["medium", "max"]);
    // Different models keep DIFFERENT effort lists.
    expect(section.models[1].supported_efforts.map((e) => e.effort)).toEqual(["medium", "high"]);
    // Missing provider identity is NOT inherited from the current selection.
    expect(section.models[2].provider_id).toBeNull();
    // No account-default model evidence exists from one session observation.
    expect(section.models.every((m) => m.is_default === false)).toBe(true);
    // Both thought-level spellings normalize at the boundary (string[] here).
    expect(section.current_selection?.thought_level).toBe("max");
  });

  it("surfaces a structured gap (never models=[] with error=null) when no session evidence exists", async () => {
    isolateStateDir();
    const service = new ModelCatalogService({
      logger: nullLogger,
      workspaceRoot: process.cwd(),
      zcodeModelCatalog: async () => ({
        z2c_protocol_version: "1",
        provider: "zcode-official",
        provider_status: "healthy",
        zcode_runtime_version: "0.16.9",
        evidence_source: "all-candidates-unreadable",
        observed_session_id: null,
        attempts: [
          { session_id: "sess_a…", outcome: "session-not-active", error: "ZCode Protocol error -32004: Session is not active" },
          { session_id: "sess_b…", outcome: "session-not-active", error: "ZCode Protocol error -32004: Session is not active" },
        ],
        candidates_considered: 2,
        configured_identity: { modelId: "GLM-5.3-Flash", thoughtLevel: "max", providerId: null },
        runtime_settings: null,
      }),
    });
    const catalog = await service.get(["zcode"]);
    const section = catalog.agents[0];
    expect(section.completeness).toBe("unknown");
    expect(section.error).toContain("evidence_source: all-candidates-unreadable");
    expect(section.error).toContain("session-not-active");
    expect(section.models).toEqual([]);
  });

  it("legacy z2c payloads (old field shape) map honestly without fabricating evidence", async () => {
    isolateStateDir();
    const service = new ModelCatalogService({
      logger: nullLogger,
      workspaceRoot: process.cwd(),
      zcodeModelCatalog: async () => ({
        z2c_protocol_version: "1",
        provider: "zcode-official",
        provider_status: "healthy",
        zcode_runtime_version: "0.16.9",
        runtime_settings: {
          model: {
            current: { providerId: "zai-api", modelId: "GLM-5.3-Flash" },
            available: [
              { ref: { providerId: "zai-api", modelId: "GLM-5.3-Flash" } },
              { modelId: "mystery-model" },
            ],
          },
          thoughtLevel: { current: "max", available: [{ value: "high" }, { value: "max" }] },
        },
      }),
    });
    const catalog = await service.get(["zcode"]);
    const section = catalog.agents[0];
    // The legacy payload predates the models contract: no models are
    // fabricated from it, and the gap is explained instead of error=null.
    expect(section.models).toEqual([]);
    expect(section.completeness).toBe("unknown");
    expect(section.error).toContain("models contract");
    // Session thought levels never leak in as per-model efforts.
    expect(section.models.every((m) => m.supported_efforts.length === 0)).toBe(true);
  });
});

describe("model resolution (no inference)", () => {
  const service = () => codexService([{ data: [
    codexEntry("gpt-6-astra", ["low", "medium", "high", "xhigh", "max", "ultra"], { isDefault: true, defaultReasoningEffort: "medium", displayName: "GPT-6-Astra" }),
    codexEntry("gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max", "ultra"], { displayName: "GPT-5.6-Sol" }),
    codexEntry("gpt-5.5", ["low", "medium", "high", "xhigh"], { upgrade: "gpt-5.6-sol", upgradeInfo: { model: "gpt-5.6-sol", retirementAt: 1792004400, migrationMarkdown: "GPT-5.5 retires" } }),
  ], nextCursor: null }]);

  it("resolves exact protocol id, case-insensitive id, and display name", async () => {
    const catalog = await service().get(["codex"]);
    for (const query of ["gpt-6-astra", "GPT-6-ASTRA", "GPT-6-Astra"]) {
      const result = resolveModelSelection(catalog, { agent: "codex", model: query });
      expect(result.status).toBe("matched");
      expect(result.selection?.model_id).toBe("gpt-6-astra");
    }
  });

  it("resolves 'GPT 6 Astra' through separator normalization while keeping version digits", async () => {
    expect(normalizeModelToken("GPT 6 Astra")).toBe("gpt-6-astra");
    expect(normalizeModelToken("gpt-5.6  sol")).toBe("gpt-5.6-sol");
    const catalog = await service().get(["codex"]);
    const result = resolveModelSelection(catalog, { agent: "codex", model: "gpt 5.6 sol" });
    expect(result.status).toBe("matched");
    expect(result.selection?.model_id).toBe("gpt-5.6-sol");
  });

  it("returns not_found for a model the account does not list, without silently substituting", async () => {
    const catalog = await service().get(["codex"]);
    const result = resolveModelSelection(catalog, { agent: "codex", model: "gpt-6-sol" });
    expect(result.status).toBe("not_found");
    expect(result.selection).toBeNull();
    expect(result.candidates.map((c) => c.model_id)).toContain("gpt-6-astra");
  });

  it("resolves gpt-6-sol / max and gpt-5.6-sol / max independently without substitution", async () => {
    isolateStateDir();
    const runtime0157Service = codexService([
      {
        data: [
          codexEntry("gpt-6-sol", ["low", "medium", "high", "xhigh", "max", "ultra"], { displayName: "GPT-6-Sol" }),
          codexEntry("gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max", "ultra"], { displayName: "GPT-5.6-Sol" }),
        ],
        nextCursor: null,
      },
    ]);
    const catalog = await runtime0157Service.get(["codex"]);

    const res6 = resolveModelSelection(catalog, { agent: "codex", model: "gpt-6-sol", effort: "max" });
    expect(res6.status).toBe("matched");
    expect(res6.selection?.model_id).toBe("gpt-6-sol");
    expect(res6.selection?.effort).toBe("max");

    const res56 = resolveModelSelection(catalog, { agent: "codex", model: "gpt-5.6-sol", effort: "max" });
    expect(res56.status).toBe("matched");
    expect(res56.selection?.model_id).toBe("gpt-5.6-sol");
    expect(res56.selection?.effort).toBe("max");

    // They must not alias to each other
    expect(res6.selection?.model_id).not.toBe(res56.selection?.model_id);
  });

  it("returns ambiguous instead of guessing when a query matches several entries", async () => {
    const catalog = await service().get(["codex"]);
    const result = resolveModelSelection(catalog, { agent: "codex", model: "sol" });
    // "sol" matches both gpt-5.6-sol by normalized suffix rules? No — matching is
    // exact/normalized-equality only, so a bare "sol" finds nothing; the point is
    // it must not guess.
    expect(["ambiguous", "not_found"]).toContain(result.status);
    expect(result.selection).toBeNull();
  });

  it("treats max and ultra as distinct efforts and rejects unsupported ones", async () => {
    const catalog = await service().get(["codex"]);
    const max = resolveModelSelection(catalog, { agent: "codex", model: "gpt-6-astra", effort: "max" });
    expect(max.status).toBe("matched");
    expect(max.selection?.effort).toBe("max");
    const ultra = resolveModelSelection(catalog, { agent: "codex", model: "gpt-5.5", effort: "max" });
    expect(ultra.status).toBe("not_found");
    expect(ultra.reason).toContain("max");
    expect(ultra.selection).toBeNull();
  });

  it("falls back to the catalog default only when no model is requested", async () => {
    const catalog = await service().get(["codex"]);
    const result = resolveModelSelection(catalog, { agent: "codex" });
    expect(result.status).toBe("matched");
    expect(result.selection?.model_id).toBe("gpt-6-astra");
    expect(result.selection?.effort).toBe("medium");
  });

  it("reports unavailable when the requested agent section failed", async () => {
    isolateStateDir();
    const broken = new ModelCatalogService({
      logger: nullLogger,
      workspaceRoot: process.cwd(),
      codexExecutableResolver: () => "C:\\fake\\codex.exe",
      codexClientFactory: () => fakeCodexClient([], { failAfterInit: true }),
    });
    const catalog = await broken.get(["codex"]);
    const result = resolveModelSelection(catalog, { agent: "codex", model: "gpt-6-astra" });
    expect(result.status).toBe("unavailable");
    expect(result.selection).toBeNull();
  });

  it("never reports not_found from a healthy-but-evidence-free section", async () => {
    isolateStateDir();
    const service = new ModelCatalogService({
      logger: nullLogger,
      workspaceRoot: process.cwd(),
      zcodeModelCatalog: async () => ({
        provider: "zcode-official",
        provider_status: "healthy",
        evidence_source: "no-candidates",
        attempts: [],
        candidates_considered: 0,
        runtime_settings: null,
      }),
    });
    const catalog = await service.get(["zcode"]);
    const result = resolveModelSelection(catalog, { agent: "zcode", model: "GLM-5.3-Flash" });
    expect(result.status).toBe("unavailable");
    expect(result.selection).toBeNull();
    expect(result.reason).toContain("evidence_source: no-candidates");
  });

  it("absence on a partial catalog is unverified, on a complete catalog it is not_found", async () => {
    isolateStateDir();
    const codex = codexService([{ data: [codexEntry("gpt-6-astra", ["max"], { isDefault: true })], nextCursor: null }]);
    const codexCatalog = await codex.get(["codex"]);
    expect(resolveModelSelection(codexCatalog, { agent: "codex", model: "gpt-6-sol" }).status).toBe("not_found");

    const zcode = new ModelCatalogService({
      logger: nullLogger,
      workspaceRoot: process.cwd(),
      zcodeModelCatalog: async () => ({
        provider: "zcode-official",
        provider_status: "healthy",
        evidence_source: "session-settings-observed",
        runtime_settings: {
          source_session_id: "sess_1",
          observed_at: "2026-09-26T00:00:00.000Z",
          current: { provider_id: "zai-api", model_id: "GLM-5.3-Flash", thought_level: "max" },
          models: [{ provider_id: "zai-api", model_id: "GLM-5.3-Flash", reasoning_levels: ["max"], reasoning_default_level: "max" }],
        },
      }),
    });
    const zcodeCatalog = await zcode.get(["zcode"]);
    const result = resolveModelSelection(zcodeCatalog, { agent: "zcode", model: "some-other-glm" });
    // A single-session view cannot prove the model does not exist.
    expect(result.status).toBe("unverified");
    expect(result.selection).toBeNull();
  });

  it("unknown effort capability is unverified, distinct from known-unsupported", async () => {
    const service = codexService([{ data: [
      codexEntry("gpt-6-astra", ["low", "medium", "high", "xhigh", "max", "ultra"], { isDefault: true, defaultReasoningEffort: "medium" }),
      codexEntry("opaque-model", []), // advertises no reasoning efforts at all
    ], nextCursor: null }]);
    const catalog = await service.get(["codex"]);
    const result = resolveModelSelection(catalog, { agent: "codex", model: "opaque-model", effort: "max" });
    expect(result.status).toBe("unverified");
    expect(result.reason).toContain("effort capability is unknown");
    expect(result.selection).toBeNull();
  });

  it("an all-agent query with any empty or partial section never answers not_found", async () => {
    isolateStateDir();
    // codex complete + zcode evidence-free: an all-agent absence query cannot
    // ignore the zcode evidence gap.
    const service = new ModelCatalogService({
      logger: nullLogger,
      workspaceRoot: process.cwd(),
      codexExecutableResolver: () => "C:\\fake\\codex.exe",
      codexClientFactory: () => fakeCodexClient([{ data: [codexEntry("gpt-6-astra", ["max"], { isDefault: true })], nextCursor: null }]),
      zcodeModelCatalog: async () => ({
        provider: "zcode-official",
        provider_status: "healthy",
        evidence_source: "no-candidates",
        attempts: [],
        candidates_considered: 0,
        runtime_settings: null,
      }),
    });
    const catalog = await service.get(["codex", "zcode"]);
    const result = resolveModelSelection(catalog, { model: "totally-unknown-model" });
    expect(result.status).toBe("unverified");
    expect(result.reason).toContain("partial");
  });

  it("an explicitly scoped agent query is not blocked by an unrelated agent failure", async () => {
    isolateStateDir();
    const service = new ModelCatalogService({
      logger: nullLogger,
      workspaceRoot: process.cwd(),
      codexExecutableResolver: () => "C:\\fake\\codex.exe",
      codexClientFactory: () => fakeCodexClient([{ data: [codexEntry("gpt-6-astra", ["max"], { isDefault: true })], nextCursor: null }]),
      zcodeModelCatalog: async () => { throw new Error("z2c unreachable"); },
    });
    const catalog = await service.get(["codex", "zcode"]);
    // Scoped to codex: the zcode failure must not downgrade the conclusion.
    const result = resolveModelSelection(catalog, { agent: "codex", model: "gpt-6-sol" });
    expect(result.status).toBe("not_found");
  });

  it("same-name entries across providers are ambiguous until provider_id disambiguates", async () => {
    isolateStateDir();
    const service = new ModelCatalogService({
      logger: nullLogger,
      workspaceRoot: process.cwd(),
      zcodeModelCatalog: async () => ({
        provider: "zcode-official",
        provider_status: "healthy",
        evidence_source: "session-settings-observed",
        runtime_settings: {
          source_session_id: "sess_1",
          observed_at: "2026-09-26T00:00:00.000Z",
          current: { provider_id: "zai-api", model_id: "GLM-5.3-Flash", thought_level: "max" },
          models: [
            { provider_id: "zai-api", model_id: "GLM-5.3-Flash", reasoning_levels: ["max"], reasoning_default_level: "max" },
            { provider_id: "other-route", model_id: "GLM-5.3-Flash", reasoning_levels: ["high"], reasoning_default_level: "high" },
          ],
        },
      }),
    });
    const catalog = await service.get(["zcode"]);
    const ambiguous = resolveModelSelection(catalog, { agent: "zcode", model: "GLM-5.3-Flash" });
    expect(ambiguous.status).toBe("ambiguous");
    expect(ambiguous.selection).toBeNull();
    expect(ambiguous.candidates).toHaveLength(2);
    const disambiguated = resolveModelSelection(catalog, { agent: "zcode", provider_id: "other-route", model: "GLM-5.3-Flash" });
    expect(disambiguated.status).toBe("matched");
    expect(disambiguated.selection).toMatchObject({ provider_id: "other-route", effort: "high" });
  });

  it("a combined name whose base matches multiple entries stays ambiguous within the provider constraint", async () => {
    isolateStateDir();
    const service = new ModelCatalogService({
      logger: nullLogger,
      workspaceRoot: process.cwd(),
      zcodeModelCatalog: async () => ({
        provider: "zcode-official",
        provider_status: "healthy",
        evidence_source: "session-settings-observed",
        runtime_settings: {
          source_session_id: "sess_1",
          observed_at: "2026-09-26T00:00:00.000Z",
          current: null,
          models: [
            // Neither id case-matches the split base "glm-flash"; both only
            // meet it at the separator-normalized tier (tier 4). Different
            // provider routes: a provider constraint can disambiguate them.
            { provider_id: "zai-api", model_id: "GLM_Flash", reasoning_levels: ["medium", "max"], reasoning_default_level: "max" },
            { provider_id: "other-route", model_id: "GLM__Flash", reasoning_levels: ["medium", "high", "max"], reasoning_default_level: "medium" },
          ],
        },
      }),
    });
    const catalog = await service.get(["zcode"]);
    // "GLM Flash Max" splits to base "glm-flash" + "max"; both ids normalize
    // to the same base → the ambiguity is PRESERVED (never guessed).
    const ambiguous = resolveModelSelection(catalog, { agent: "zcode", model: "GLM Flash Max" });
    expect(ambiguous.status).toBe("ambiguous");
    expect(ambiguous.selection).toBeNull();
    expect(ambiguous.reason).toContain("glm-flash");
    // An explicit provider constraint collapses the base to one entry.
    const disambiguated = resolveModelSelection(catalog, { agent: "zcode", provider_id: "other-route", model: "GLM Flash Max" });
    expect(disambiguated.status).toBe("matched");
    expect(disambiguated.selection).toMatchObject({ provider_id: "other-route", model_id: "GLM__Flash", effort: "max" });
  });

  it("provider constraints apply to candidates as well as matches", async () => {
    const service = new ModelCatalogService({
      logger: nullLogger,
      workspaceRoot: process.cwd(),
      zcodeModelCatalog: async () => ({
        provider: "zcode-official",
        provider_status: "healthy",
        evidence_source: "session-settings-observed",
        runtime_settings: {
          source_session_id: "sess_1",
          observed_at: "2026-09-26T00:00:00.000Z",
          current: { provider_id: "zai-api", model_id: "GLM-5.3-Flash", thought_level: "max" },
          models: [
            { provider_id: "zai-api", model_id: "GLM-5.3-Flash", reasoning_levels: ["max"], reasoning_default_level: "max" },
            { provider_id: "other-route", model_id: "other-flash", reasoning_levels: ["max"], reasoning_default_level: "max" },
          ],
        },
      }),
    });
    const catalog = await service.get(["zcode"]);
    // Constrained request that cannot be satisfied: candidates must not
    // substitute entries from another provider route.
    const result = resolveModelSelection(catalog, { agent: "zcode", provider_id: "zai-api", model: "unknown-glm" });
    expect(result.status).toBe("unverified");
    expect(result.candidates.every((candidate) => candidate.provider_id === "zai-api")).toBe(true);
    // The constrained match itself still works.
    const constrained = resolveModelSelection(catalog, { agent: "zcode", provider_id: "zai-api", model: "GLM-5.3-Flash" });
    expect(constrained.status).toBe("matched");
    expect(constrained.selection?.model_id).toBe("GLM-5.3-Flash");
  });

  it("an exact protocol id beats another entry's display name at a lower tier", async () => {
    const service = codexService([{ data: [
      codexEntry("gpt-dup", ["max"], { displayName: "The Duplicate" }),
      codexEntry("other-model", ["max"], { displayName: "gpt-dup" }), // display collides with A's exact id
    ], nextCursor: null }]);
    const catalog = await service.get(["codex"]);
    const result = resolveModelSelection(catalog, { agent: "codex", model: "gpt-dup" });
    expect(result.status).toBe("matched");
    expect(result.selection?.model_id).toBe("gpt-dup");
  });

  it("resolves the combined form 'GPT-6 Astra Max' to astra/max", async () => {
    const catalog = await service().get(["codex"]);
    const result = resolveModelSelection(catalog, { agent: "codex", model: "GPT-6 Astra Max" });
    expect(result.status).toBe("matched");
    expect(result.selection).toMatchObject({ model_id: "gpt-6-astra", effort: "max" });
  });

  it("a combined name whose effort the model does not support is rejected", async () => {
    const catalog = await service().get(["codex"]);
    const result = resolveModelSelection(catalog, { agent: "codex", model: "GPT-5.5 Max" });
    expect(result.status).toBe("not_found");
    expect(result.selection).toBeNull();
    expect(result.reason).toContain("not supported");
  });

  it("a combined name conflicting with an explicit effort returns a selection conflict, not a silent pick", async () => {
    const catalog = await service().get(["codex"]);
    const result = resolveModelSelection(catalog, { agent: "codex", model: "GPT-6 Astra Max", effort: "low" });
    expect(result.status).toBe("ambiguous");
    expect(result.selection).toBeNull();
    expect(result.reason).toContain("selection conflict");
  });

  it("a real model id ending in -max wins at the exact tier and is never split", async () => {
    const service = codexService([{ data: [
      codexEntry("gpt-fake-max", ["medium"], { displayName: "GPT Fake Max" }),
      codexEntry("gpt-fake", ["medium", "max"], { displayName: "GPT Fake" }),
    ], nextCursor: null }]);
    const catalog = await service.get(["codex"]);
    const result = resolveModelSelection(catalog, { agent: "codex", model: "gpt-fake-max" });
    expect(result.status).toBe("matched");
    expect(result.selection?.model_id).toBe("gpt-fake-max");
  });

  it("a combined name on a stale catalog is unverified", async () => {
    let failing = false;
    const service = new ModelCatalogService({
      logger: nullLogger,
      workspaceRoot: process.cwd(),
      ttlMs: 10,
      codexExecutableResolver: () => "C:\\fake\\codex.exe",
      codexClientFactory: () => {
        if (failing) throw new Error("probe transport broke");
        return fakeCodexClient([{ data: [codexEntry("gpt-6-astra", ["medium", "max"], { isDefault: true, defaultReasoningEffort: "medium", displayName: "GPT-6-Astra" })], nextCursor: null }]);
      },
    });
    const fresh = await service.get(["codex"]);
    expect(fresh.freshness).toBe("fresh");
    failing = true;
    await new Promise((resolve) => setTimeout(resolve, 40));
    const result = resolveModelSelection(await service.get(["codex"]), { agent: "codex", model: "GPT-6 Astra Max" });
    expect(result.status).toBe("unverified");
  });
});

describe("execution selection wiring", () => {
  const makeService = () => codexService([{ data: [
    codexEntry("gpt-6-astra", ["low", "medium", "high", "xhigh", "max", "ultra"], { isDefault: true, defaultReasoningEffort: "medium" }),
    codexEntry("gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max", "ultra"]),
    codexEntry("gpt-5.5", ["low", "medium", "high", "xhigh"]),
  ], nextCursor: null }]);

  it("confirms an explicit model/effort against the live catalog", async () => {
    const selection = await resolveCodexExecutionSelection(makeService(), { model: "gpt-6-astra", effort: "max" }, null);
    expect(selection).toMatchObject({ model: "gpt-6-astra", effort: "max", binding_source: "explicit-task", catalog_confirmed: true });
  });

  it("rejects a model the account does not list with MODEL_NOT_LISTED (no silent substitution)", async () => {
    await expect(resolveCodexExecutionSelection(makeService(), { model: "gpt-6-sol", effort: "max" }, null))
      .rejects.toMatchObject({ code: "MODEL_NOT_LISTED" });
  });

  it("rejects an unsupported effort with UNSUPPORTED_EFFORT (distinct from MODEL_NOT_LISTED)", async () => {
    await expect(resolveCodexExecutionSelection(makeService(), { model: "gpt-5.5", effort: "max" }, null))
      .rejects.toMatchObject({ code: "UNSUPPORTED_EFFORT" });
    await expect(resolveCodexExecutionSelection(makeService(), { model: "gpt-5.5", effort: "ultra" }, null))
      .rejects.toMatchObject({ code: "UNSUPPORTED_EFFORT" });
  });

  it("explicit model only resolves to that model's catalog default effort", async () => {
    const selection = await resolveCodexExecutionSelection(makeService(), { model: "gpt-6-astra" }, { model: "gpt-5.6-sol", effort: "max" });
    expect(selection).toMatchObject({ model: "gpt-6-astra", effort: "medium", binding_source: "explicit-task" });
  });

  it("explicit effort overrides the bridge preference effort (astra/max preference + low => astra/low)", async () => {
    const selection = await resolveCodexExecutionSelection(makeService(), { effort: "low" }, { model: "gpt-6-astra", effort: "max" });
    expect(selection).toMatchObject({ model: "gpt-6-astra", effort: "low", binding_source: "bridge-preference" });
  });

  it("explicit effort overrides the account default effort (astra/medium default + max => astra/max)", async () => {
    const selection = await resolveCodexExecutionSelection(makeService(), { effort: "max" }, null);
    expect(selection).toMatchObject({ model: "gpt-6-astra", effort: "max", binding_source: "account-default" });
  });

  it("explicit effort on an unsupported model effort fails closed with UNSUPPORTED_EFFORT (never dropped)", async () => {
    // gpt-5.5 does not advertise max; an explicit max must not fall back to its default.
    await expect(resolveCodexExecutionSelection(makeService(), { effort: "max" }, { model: "gpt-5.5" }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_EFFORT" });
  });

  it("execution selection fails closed on a stale catalog (MODEL_CATALOG_UNAVAILABLE), stale stays displayable", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2c-stale-"));
    try {
      let failing = false;
      const service = new ModelCatalogService({
        logger: nullLogger,
        workspaceRoot: process.cwd(),
        ttlMs: 10,
        codexExecutableResolver: () => "C:\\fake\\codex.exe",
        codexClientFactory: () => {
          if (failing) throw new Error("probe transport broke");
          return fakeCodexClient([{ data: [codexEntry("gpt-6-astra", ["low", "medium", "high", "xhigh", "max", "ultra"], { isDefault: true, defaultReasoningEffort: "medium" })], nextCursor: null }]);
        },
      });
      // Warm the cache, then let it expire and the refresh start failing.
      await service.get(["codex"]);
      failing = true;
      await new Promise((resolve) => setTimeout(resolve, 40));
      // Display path: the stale catalog is still served, explicitly marked.
      const stale = await service.get(["codex"]);
      expect(stale.freshness).toBe("stale");
      expect(stale.agents[0].served_from_stale_cache).toBe(true);
      // Resolver path on stale data: candidates may be shown but are unverified.
      const staleCatalog = stale;
      const resolved = resolveModelSelection(staleCatalog, { agent: "codex", model: "gpt-6-astra", effort: "max" });
      expect(resolved.status).toBe("unverified");
      // Execution paths fail closed instead of dispatching against stale data.
      await expect(resolveCodexExecutionSelection(service, { model: "gpt-6-astra", effort: "max" }, null))
        .rejects.toMatchObject({ code: "MODEL_CATALOG_UNAVAILABLE" });
      await expect(resolveCodexExecutionSelection(service, { effort: "low" }, { model: "gpt-6-astra", effort: "max" }))
        .rejects.toMatchObject({ code: "MODEL_CATALOG_UNAVAILABLE" });
      await expect(resolveCodexExecutionSelection(service, {}, { model: "gpt-6-astra", effort: "max" }))
        .rejects.toMatchObject({ code: "MODEL_CATALOG_UNAVAILABLE" });
      await expect(service.confirmCodexSelection("gpt-6-astra", "max"))
        .rejects.toMatchObject({ code: "MODEL_CATALOG_UNAVAILABLE" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the bridge preference only when it is currently listed (fresh)", async () => {
    const okPreference = await resolveCodexExecutionSelection(makeService(), {}, { model: "gpt-5.6-sol", effort: "high" });
    expect(okPreference).toMatchObject({ model: "gpt-5.6-sol", effort: "high", binding_source: "bridge-preference" });
    // Preference pinning only a model falls back to that model's catalog default effort.
    const modelOnly = await resolveCodexExecutionSelection(makeService(), {}, { model: "gpt-5.6-sol" });
    expect(modelOnly).toMatchObject({ model: "gpt-5.6-sol", effort: "low", binding_source: "bridge-preference" });
    await expect(resolveCodexExecutionSelection(makeService(), {}, { model: "gpt-6-sol", effort: "max" }))
      .rejects.toMatchObject({ code: "MODEL_NOT_LISTED" });
  });

  it("falls back to the account default (isDefault + its default effort) without a preference", async () => {
    const selection = await resolveCodexExecutionSelection(makeService(), {}, null);
    expect(selection).toMatchObject({ model: "gpt-6-astra", effort: "medium", binding_source: "account-default" });
  });

  it("fails closed when nothing can be determined and no catalog section exists", async () => {
    isolateStateDir();
    const broken = new ModelCatalogService({
      logger: nullLogger,
      workspaceRoot: process.cwd(),
      codexExecutableResolver: () => "C:\\fake\\codex.exe",
      codexClientFactory: () => fakeCodexClient([], { failAfterInit: true }),
    });
    await expect(resolveCodexExecutionSelection(broken, {}, null))
      .rejects.toMatchObject({ code: "MODEL_CATALOG_UNAVAILABLE" });
    await expect(resolveCodexExecutionSelection(null, {}, null))
      .rejects.toMatchObject({ code: "MODEL_CATALOG_UNAVAILABLE" });
  });

  it("keeps the bridge preference off unless explicitly configured", () => {
    expect(bridgeCodexPreference({})).toBeNull();
    expect(bridgeCodexPreference({ A2C_CODEX_PREFERRED_MODEL: "gpt-6-astra", A2C_CODEX_PREFERRED_EFFORT: "max" }))
      .toEqual({ model: "gpt-6-astra", effort: "max" });
  });

  it("reads the state preference file only when env vars are absent", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2c-pref-"));
    try {
      expect(bridgeCodexPreference({}, dir)).toBeNull();
      fs.writeFileSync(path.join(dir, "model-preferences.json"), JSON.stringify({ codex: { model: "gpt-6-astra", effort: "max" } }));
      expect(bridgeCodexPreference({}, dir)).toEqual({ model: "gpt-6-astra", effort: "max" });
      // Env wins over the state file; a malformed file never breaks admission.
      expect(bridgeCodexPreference({ A2C_CODEX_PREFERRED_MODEL: "gpt-5.6-sol" }, dir))
        .toEqual({ model: "gpt-5.6-sol", effort: undefined });
      fs.writeFileSync(path.join(dir, "model-preferences.json"), "{not json");
      expect(bridgeCodexPreference({}, dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unbounded model/effort identifiers before any catalog lookup", async () => {
    await expect(resolveCodexExecutionSelection(null, { model: "gpt-6-astra; rm -rf /" }, null))
      .rejects.toMatchObject({ code: "INVALID_TASK" });
    await expect(resolveCodexExecutionSelection(null, { model: "gpt-6-astra", effort: "no such effort" }, null))
      .rejects.toMatchObject({ code: "INVALID_TASK" });
  });

  it("resolves an explicit model-only selection to that model's catalog default effort (not null)", async () => {
    const selection = await resolveCodexExecutionSelection(makeService(), { model: "gpt-6-astra" }, null);
    expect(selection.effort).toBe("medium");
  });
});

describe("zcode cache identity and time fields", () => {
  interface ZcodeProviderState {
    childPid: number;
    calls: number;
    settings: Record<string, unknown> | null;
  }
  const zcodeService = (state: ZcodeProviderState, ttlMs?: number) => new ModelCatalogService({
    logger: nullLogger,
    workspaceRoot: process.cwd(),
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    zcodeModelCatalog: async () => {
      state.calls += 1;
      return {
        z2c_protocol_version: "1",
        provider: "zcode-official",
        provider_status: "healthy",
        zcode_runtime_version: "0.16.9",
        provider_child_pid: state.childPid,
        evidence_source: state.settings ? "session-settings-observed" : "no-candidates",
        attempts: [],
        candidates_considered: state.settings ? 1 : 0,
        configured_identity: { modelId: "GLM-5.3-Flash", thoughtLevel: "max", providerId: null },
        runtime_settings: state.settings,
      };
    },
  });
  const settingsFor = (label: string) => ({
    source_session_id: "sess_src",
    observed_at: "2026-09-26T00:00:00.000Z",
    current: { provider_id: "zai-api", model_id: "GLM-5.3-Flash", thought_level: "max" },
    current_model_thought_levels: ["high", "max"],
    models: [{ provider_id: "zai-api", model_id: "GLM-5.3-Flash", label, reasoning_levels: ["medium", "max"], reasoning_default_level: "max" }],
  });

  it("re-observes zcode on every request: a respawned runtime (new child pid) replaces the evidence", async () => {
    isolateStateDir();
    const state: ZcodeProviderState = { childPid: 100, calls: 0, settings: settingsFor("before") };
    const service = zcodeService(state);
    const first = await service.get(["zcode"]);
    expect(first.agents[0].identity_key).toContain("childPid:100");
    expect(state.calls).toBe(1);
    // Same runtime version but a respawned app-server child: the child pid is
    // only observable by querying the service, so zcode is re-observed on
    // EVERY request (conservative policy) and the new evidence replaces the
    // old — never mixed across generations.
    state.childPid = 101;
    state.settings = settingsFor("after");
    const second = await service.get(["zcode"]);
    expect(state.calls).toBe(2);
    expect(second.agents[0].identity_key).toContain("childPid:101");
    expect(second.agents[0].models[0].display_name).toBe("after");
  });

  it("distinguishes observed_at / fetched_at / served_at / actual expires_at", async () => {
    isolateStateDir();
    // Hermetic CODEX_HOME: the codex scope key includes auth/config mtimes,
    // and a background writer to the real home could otherwise invalidate the
    // cache mid-test (correct behavior, but flaky in a unit test).
    const fs = await import("node:fs");
    const path = await import("node:path");
    const home = fs.mkdtempSync(path.join(process.env.TEMP ?? "/tmp", "codex-home-"));
    fs.writeFileSync(path.join(home, "auth.json"), "{}");
    fs.writeFileSync(path.join(home, "config.toml"), "");
    // codex exercises the TTL-cache path (its identity signals are locally
    // checkable): a cache hit moves served_at while observed_at / fetched_at /
    // expires_at stay fixed — no validity re-extension.
    const service = new ModelCatalogService({
      logger: nullLogger,
      workspaceRoot: process.cwd(),
      env: { CODEX_HOME: home } as NodeJS.ProcessEnv,
      codexExecutableResolver: () => "C:\\fake\\codex.exe",
      codexClientFactory: () => fakeCodexClient([{ data: [codexEntry("gpt-6-astra", ["max"], { isDefault: true })], nextCursor: null }]),
    });
    const first = await service.get(["codex"]);
    const firstSection = first.agents[0];
    expect(firstSection.fetched_at).toBeTruthy();
    expect(firstSection.expires_at).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await service.get(["codex"]);
    const secondSection = second.agents[0];
    expect(secondSection.observed_at).toBe(firstSection.observed_at);
    expect(secondSection.fetched_at).toBe(firstSection.fetched_at);
    expect(secondSection.expires_at).toBe(firstSection.expires_at);
    expect(secondSection.served_at).not.toBe(firstSection.served_at);
    // Top-level expiry is the real section expiry, not now+ttl.
    expect(second.expires_at).toBe(firstSection.expires_at);
    fs.rmSync(home, { recursive: true, force: true });
    // zcode, by contrast, is re-observed per request and carries NO cache
    // validity beyond the response that served it.
    const state: { childPid: number; calls: number; settings: Record<string, unknown> | null } = { childPid: 100, calls: 0, settings: null };
    const zcodeOnly = new ModelCatalogService({
      logger: nullLogger,
      workspaceRoot: process.cwd(),
      zcodeModelCatalog: async () => {
        state.calls += 1;
        return {
          provider: "zcode-official",
          provider_status: "healthy",
          zcode_runtime_version: "0.16.9",
          provider_child_pid: state.childPid,
          evidence_source: "no-candidates",
          attempts: [],
          candidates_considered: 0,
          runtime_settings: null,
        };
      },
    });
    const z1 = await zcodeOnly.get(["zcode"]);
    const z2 = await zcodeOnly.get(["zcode"]);
    expect(state.calls).toBe(2);
    expect(z2.agents[0].expires_at).toBe(z2.agents[0].served_at);
  });

  it("single-flight shares one observation; an identity generation switch replaces (never mixes) evidence", async () => {
    isolateStateDir();
    const state: ZcodeProviderState = { childPid: 100, calls: 0, settings: settingsFor("generation-A") };
    let releaseFetch: (() => void) | null = null;
    const service = new ModelCatalogService({
      logger: nullLogger,
      workspaceRoot: process.cwd(),
      zcodeModelCatalog: () => {
        state.calls += 1;
        // Capture BOTH identity signals at call time: the payload belongs to
        // the generation that was live when the observation started.
        const pidAtCall = state.childPid;
        const settingsAtCall = state.settings;
        return new Promise((resolve) => {
          releaseFetch = () => resolve({
            z2c_protocol_version: "1",
            provider_status: "healthy",
            zcode_runtime_version: "0.16.9",
            provider_child_pid: pidAtCall,
            evidence_source: settingsAtCall ? "session-settings-observed" : "no-candidates",
            runtime_settings: settingsAtCall,
          });
        });
      },
    });
    const pending = service.get(["zcode"]);
    state.childPid = 101; // generation switch while the fetch is in flight
    state.settings = settingsFor("generation-B");
    releaseFetch?.(); // resolves the in-flight call with generation-A data
    const first = await pending;
    // The response honestly carries the generation it came from.
    expect(first.agents[0].identity_key).toContain("childPid:100");
    expect(first.agents[0].models[0].display_name).toBe("generation-A");
    // zcode is re-observed on every request: the next observation runs under
    // the new generation — entries are never stitched across generations.
    const pending2 = service.get(["zcode"]);
    releaseFetch?.(); // the second call captured generation-B at its own start
    const second = await pending2;
    expect(state.calls).toBe(2);
    expect(second.agents[0].identity_key).toContain("childPid:101");
    expect(second.agents[0].models[0].display_name).toBe("generation-B");
  });
});

describe("zcode observation error sanitization (Blocker 3)", () => {
  it("sanitizes synthetic credentials in observation attempts through the full mapper chain", async () => {
    const service = new ModelCatalogService({
      logger: nullLogger,
      workspaceRoot: process.cwd(),
      zcodeModelCatalog: async () => ({
        z2c_protocol_version: "1",
        provider_status: "healthy",
        zcode_runtime_version: "0.16.9",
        evidence_source: "all-candidates-unreadable",
        attempts: [
          {
            session_id: "sess_err",
            outcome: "permission",
            error: "HTTP 401: X-API-Key: SYNTHETIC_KEY_123, Cookie: sid=SYNTHETIC_COOKIE_123, Authorization: Basic U1lOVEhFVElDX09OTFk=, client_secret=SYNTHETIC_ONLY",
          },
        ],
        candidates_considered: 1,
        candidates_attempted: 1,
        candidates_observed: 0,
      }),
    });
    const catalog = await service.get(["zcode"]);
    const zcode = catalog.agents.find((s) => s.agent === "zcode")!;
    expect(zcode.error).not.toContain("SYNTHETIC_KEY_123");
    expect(zcode.error).not.toContain("SYNTHETIC_COOKIE_123");
    expect(zcode.error).not.toContain("U1lOVEhFVElDX09OTFk=");
    expect(zcode.error).not.toContain("SYNTHETIC_ONLY");

    const attemptError = zcode.observation?.attempts[0]?.error;
    expect(attemptError).toBeDefined();
    // Verify attempt error is sanitized
    expect(attemptError).not.toContain("SYNTHETIC_KEY_123");
    expect(attemptError).not.toContain("SYNTHETIC_COOKIE_123");
    expect(attemptError).not.toContain("U1lOVEhFVElDX09OTFk=");
    expect(attemptError).not.toContain("SYNTHETIC_ONLY");
  });

  it("sanitizes synthetic credentials when zcodeModelCatalog itself throws an error (other path)", async () => {
    const service = new ModelCatalogService({
      logger: nullLogger,
      workspaceRoot: process.cwd(),
      zcodeModelCatalog: async () => {
        throw new Error("HTTP 401 with Authorization: Basic U1lOVEhFVElDX09OTFk=, client_secret=SYNTHETIC_ONLY, X-API-Key: SYNTHETIC_KEY_123");
      },
    });
    const catalog = await service.get(["zcode"]);
    const zcode = catalog.agents.find((s) => s.agent === "zcode")!;
    expect(zcode.error).toBeDefined();
    expect(zcode.error).not.toContain("U1lOVEhFVElDX09OTFk=");
    expect(zcode.error).not.toContain("SYNTHETIC_ONLY");
    expect(zcode.error).not.toContain("SYNTHETIC_KEY_123");
  });
});
