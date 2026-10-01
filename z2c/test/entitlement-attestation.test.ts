import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  entitlementAccessMode,
  entitlementFromAccessMode,
  isAttestedEntitlement,
  requireSupportedEntitlement,
  unobservedEntitlement,
} from "../src/providers/entitlement.js";
import { isAdmissibleObservedBinding } from "../src/authz/attestation.js";
import { parseEntitlementReadback, parseSessionSettingsCatalog } from "../src/providers/zcode/official.js";
import { publicView, type TaskRecord } from "../src/core/tasks/model.js";

/**
 * Regression: per-session START entitlement selection and exact-session
 * attestation. The runtime capability — not a version blanket — unlocks
 * START/INDIVIDUAL; admission requires the registry-backed readback for the
 * exact session; the retired start-plan route stays revoked without it.
 * DEFAULT flows are unchanged.
 */

const OFFICIAL_READ = { source: "official-session-read" };

describe("z2c entitlement capability gate", () => {
  it("keeps DEFAULT passing and non-DEFAULT fail-closed without support", () => {
    assert.equal(requireSupportedEntitlement(undefined), "DEFAULT");
    assert.equal(requireSupportedEntitlement("DEFAULT"), "DEFAULT");
    for (const plan of ["START", "INDIVIDUAL"] as const) {
      assert.throws(() => requireSupportedEntitlement(plan), /ENTITLEMENT_UNAVAILABLE|cannot be selected and attested/);
      assert.throws(() => requireSupportedEntitlement(plan, null), /cannot be selected and attested/);
      assert.throws(() => requireSupportedEntitlement(plan, { entitlementSelection: false }), /cannot be selected and attested/);
      assert.equal(requireSupportedEntitlement(plan, { entitlementSelection: true }), plan);
    }
  });

  it("maps semantic access modes and never invents plans from other strings", () => {
    assert.equal(entitlementAccessMode("START"), "start-plan");
    assert.equal(entitlementAccessMode("INDIVIDUAL"), "individual-coding-plan");
    assert.equal(entitlementAccessMode("DEFAULT"), null);
    assert.equal(entitlementFromAccessMode("start-plan"), "START");
    assert.equal(entitlementFromAccessMode("individual-coding-plan"), "INDIVIDUAL");
    assert.equal(entitlementFromAccessMode("builtin:zai-start-plan"), null);
    assert.equal(entitlementFromAccessMode(null), null);
  });

  it("classifies exact-session attestation strictly", () => {
    assert.equal(isAttestedEntitlement({ requested: "START", observed: "START", access_mode: "start-plan", source: "provider-registry" }, "START"), true);
    assert.equal(isAttestedEntitlement({ requested: "START", observed: "START", access_mode: "start-plan", source: "control-plane-reported" }, "START"), false);
    assert.equal(isAttestedEntitlement(unobservedEntitlement("START"), "START"), false);
    assert.equal(isAttestedEntitlement(null, "START"), false);
  });
});

describe("z2c route admissibility under entitlement attestation", () => {
  const advertised = [
    { providerId: "account:zai-start-plan", modelId: "GLM-5.3-Flash", reasoningLevels: ["max"], reasoningDefaultLevel: "max" },
  ];

  it("keeps the retired start-plan route revoked without attestation", () => {
    assert.equal(
      isAdmissibleObservedBinding({
        provider_id: "builtin:zai-start-plan",
        model_id: "GLM-5.3-Flash",
        ...OFFICIAL_READ,
        availableModels: advertised,
      }),
      false,
    );
  });

  it("admits a Start route only on a registry-attested start-plan readback", () => {
    assert.equal(
      isAdmissibleObservedBinding({
        provider_id: "account:zai-start-plan",
        model_id: "GLM-5.3-Flash",
        ...OFFICIAL_READ,
        availableModels: advertised,
        entitlement: { observed: "start-plan", source: "provider-registry" },
      }),
      true,
    );
    // Non-registry "evidence" proves nothing.
    assert.equal(
      isAdmissibleObservedBinding({
        provider_id: "account:zai-start-plan",
        model_id: "GLM-5.3-Flash",
        ...OFFICIAL_READ,
        availableModels: advertised,
        entitlement: { observed: "start-plan", source: "control-plane-reported" },
      }),
      false,
    );
    // Attested INDIVIDUAL does not open the Start route.
    assert.equal(
      isAdmissibleObservedBinding({
        provider_id: "account:zai-start-plan",
        model_id: "GLM-5.3-Flash",
        ...OFFICIAL_READ,
        availableModels: advertised,
        entitlement: { observed: "individual-coding-plan", source: "provider-registry" },
      }),
      false,
    );
  });

  it("keeps the pre-capability DEFAULT rules byte-identical", () => {
    assert.equal(
      isAdmissibleObservedBinding({
        provider_id: "zai-api",
        model_id: "GLM-5.3-Flash",
        ...OFFICIAL_READ,
        availableModels: advertised,
      }),
      false, // model not advertised on this route in the fixture
    );
    assert.equal(
      isAdmissibleObservedBinding({
        provider_id: "account:zai-start-plan",
        model_id: "GLM-5.3-Flash",
        ...OFFICIAL_READ,
        availableModels: advertised,
      }),
      false, // unattested unknown route stays inadmissible
    );
  });
});

describe("z2c readback normalization", () => {
  it("normalizes the runtime entitlement readback and collapses malformed payloads to unproven", () => {
    assert.deepEqual(
      parseEntitlementReadback({ requested: "start-plan", observed: { mode: "start-plan" }, source: "provider-registry" }),
      { requested: "START", observed: "START", access_mode: "start-plan", source: "provider-registry" },
    );
    assert.deepEqual(
      parseEntitlementReadback({ requested: "individual-coding-plan", observed: { mode: "individual-coding-plan" }, source: "provider-registry" }),
      { requested: "INDIVIDUAL", observed: "INDIVIDUAL", access_mode: "individual-coding-plan", source: "provider-registry" },
    );
    assert.deepEqual(
      parseEntitlementReadback(undefined),
      { requested: null, observed: null, access_mode: null, source: "unavailable" },
    );
    assert.deepEqual(
      parseEntitlementReadback({ requested: "builtin:zai-start-plan", observed: { mode: "weird" }, source: "provider-registry" }),
      { requested: null, observed: null, access_mode: "weird", source: "provider-registry" },
    );
  });

  it("passes per-model access mode through the catalog parser (both spellings)", () => {
    const snap = {
      settings: {
        model: {
          current: { providerId: "account:zai-start-plan", modelId: "GLM-5.3-Flash", accessMode: "start-plan" },
          available: [
            { providerId: "account:zai-start-plan", modelId: "GLM-5.3-Flash", accessMode: "start-plan" },
            { ref: { providerId: "zai-api", modelId: "GLM-5.3-Flash" }, accountAccess: { mode: "individual-coding-plan" } },
          ],
        },
        thoughtLevel: { available: [{ value: "max" }] },
      },
    } as unknown as Parameters<typeof parseSessionSettingsCatalog>[2];
    const catalog = parseSessionSettingsCatalog("sess_p", "2026-09-29T00:00:00.000Z", snap);
    assert.ok(catalog);
    assert.equal(catalog.current?.access_mode, "start-plan");
    assert.deepEqual(
      catalog.models.map((m) => m.access_mode),
      ["start-plan", "individual-coding-plan"],
    );
  });
});

describe("z2c public task view entitlement", () => {
  it("releases requested + observed evidence and never fabricates a plan", () => {
    const base: TaskRecord = {
      taskId: "z2c_test",
      workspaceId: "ws",
      zcodeSessionId: "sess_11111111-2222-3333-4444-555555555555",
      status: "queued",
      instruction: "ok",
      writeScope: "workspace",
      network: "default",
      mode: "build",
      createdAt: 0,
      startedAt: null,
      completedAt: null,
      exitStatus: null,
      outputId: null,
      resumeOfSessionId: null,
      entitlementPlan: "START",
      modelBinding: {
        provider_id: "account:zai-start-plan",
        model_id: "GLM-5.3-Flash",
        source: "official-session-read",
        entitlement: { requested: null, observed: "start-plan", source: "provider-registry" },
      },
    };
    const view = publicView(base);
    assert.deepEqual(view.entitlement, {
      requested: "START",
      observed: "START",
      access_mode: "start-plan",
      source: "provider-registry",
    });

    const unproven = publicView({ ...base, modelBinding: { ...base.modelBinding!, entitlement: null } });
    assert.deepEqual(unproven.entitlement, { requested: "START", observed: null, access_mode: null, source: "unavailable" });
  });
});

describe("individual account routes (2026-10-01 chat admission repair)", () => {
  const individualAdvertised = [
    { providerId: "account:zai-individual-coding-plan", modelId: "GLM-5.3", reasoningLevels: ["low", "high", "max"], reasoningDefaultLevel: "max" },
    { providerId: "account:zai-individual-coding-plan", modelId: "GLM-5.3-Flash", reasoningLevels: ["low", "high", "max"], reasoningDefaultLevel: "max" },
  ];

  it("admits both INDIVIDUAL models at max observed on the individual account route", () => {
    for (const modelId of ["GLM-5.3", "GLM-5.3-Flash"]) {
      assert.equal(
        isAdmissibleObservedBinding({
          provider_id: "account:zai-individual-coding-plan",
          model_id: modelId,
          ...OFFICIAL_READ,
          availableModels: individualAdvertised,
          entitlement: { observed: "individual-coding-plan", source: "provider-registry" },
        }),
        true,
      );
    }
  });

  it("keeps the individual account route inadmissible when the model is not advertised", () => {
    assert.equal(
      isAdmissibleObservedBinding({
        provider_id: "account:zai-individual-coding-plan",
        model_id: "GLM-5.3-Air",
        ...OFFICIAL_READ,
        availableModels: individualAdvertised,
        entitlement: { observed: "individual-coding-plan", source: "provider-registry" },
      }),
      false,
    );
  });

  it("does not open the start account route via an INDIVIDUAL attestation", () => {
    assert.equal(
      isAdmissibleObservedBinding({
        provider_id: "account:zai-start-plan",
        model_id: "GLM-5.3-Flash",
        ...OFFICIAL_READ,
        availableModels: [
          { providerId: "account:zai-start-plan", modelId: "GLM-5.3-Flash", reasoningLevels: ["max"], reasoningDefaultLevel: "max" },
        ],
        entitlement: { observed: "individual-coding-plan", source: "provider-registry" },
      }),
      false,
    );
  });
});
