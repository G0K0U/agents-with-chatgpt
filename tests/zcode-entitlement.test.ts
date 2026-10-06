import { describe, expect, it, vi } from "vitest";
import { nativeRequestFingerprint, nativeResumeFingerprint } from "../src/execution/zcode-native.js";
import { entitlementPlan, requireSupportedEntitlement, unobservedEntitlement } from "../src/execution/zcode-entitlement.js";
import { OrchestratorCore, orchestratorStepSchema } from "../src/execution/orchestrator-core.js";
import { requestFingerprint } from "../z2c/src/core/tasks/idempotency.js";
import { cleanup, makeTmpDir } from "./helpers.js";

describe("ZCode billing entitlement contract", () => {
  it("preserves DEFAULT behavior and rejects unselectable plans without echoing input", () => {
    expect(requireSupportedEntitlement(undefined)).toBe("DEFAULT");
    expect(requireSupportedEntitlement("DEFAULT")).toBe("DEFAULT");
    for (const plan of ["START", "INDIVIDUAL"]) {
      expect(() => requireSupportedEntitlement(plan)).toThrow(/cannot be selected and attested/);
    }
    expect(() => entitlementPlan("secret-account@example.com")).toThrow("entitlement_plan must be DEFAULT, START or INDIVIDUAL");
    expect(unobservedEntitlement()).toEqual({ requested: "DEFAULT", observed: null, access_mode: null, source: "unavailable" });
  });

  it("unlocks non-DEFAULT plans only on an explicit runtime entitlement-selection capability", () => {
    for (const plan of ["START", "INDIVIDUAL"] as const) {
      // Old runtimes / absent capability stay fail-closed (same error code).
      expect(() => requireSupportedEntitlement(plan, null)).toThrow(/cannot be selected and attested/);
      expect(() => requireSupportedEntitlement(plan, { entitlementSelection: false })).toThrow(/cannot be selected and attested/);
      // The patched runtime's own advertisement unlocks the plan.
      expect(requireSupportedEntitlement(plan, { entitlementSelection: true })).toBe(plan);
    }
  });

  it("separates plans consistently across A2C/Z2C submit and resume while preserving old DEFAULT hashes", () => {
    const base = { workspace_id: "ws", instruction: "Reply OK", model_id: "GLM-5.3-Flash", thought_level: "max" };
    const hashes = [undefined, "DEFAULT", "START", "INDIVIDUAL"].map(entitlement_plan => {
      const input = { ...base, entitlement_plan: entitlement_plan as "DEFAULT" | "START" | "INDIVIDUAL" | undefined };
      expect(nativeRequestFingerprint(input)).toBe(requestFingerprint(input));
      const resume = { workspace_id: "ws", instruction: "OK", session_id: "sess_00000000-0000-0000-0000-000000000001", entitlement_plan: input.entitlement_plan };
      expect(nativeResumeFingerprint(resume)).toBe(requestFingerprint({ ...resume, resume_session_id: resume.session_id }));
      return nativeRequestFingerprint(input);
    });
    expect(hashes[0]).toBe(hashes[1]);
    expect(new Set(hashes).size).toBe(3);
  });

  it("persists and forwards the exact orchestrator entitlement independently of model/effort", async () => {
    const dir = makeTmpDir("entitlement-orchestrator");
    const submit = vi.fn(() => ({ taskId: "task", status: "queued" as const, outputIds: [] }));
    try {
      const core = new OrchestratorCore(dir, "ws", { submit: vi.fn(), get: vi.fn() }, {
        lanes: { zcode: { submit, get: () => ({ taskId: "task", status: "queued", outputIds: [] }) } },
      });
      const run = await core.create("run", "owner", [{ agent: "zcode", instruction: "OK", write_scope: ["src"], model: "GLM-5.3-Flash", effort: "max", entitlement_plan: "START" }]);
      expect(run.steps[0].entitlement_plan).toBe("START");
      expect(submit.mock.calls[0]?.[0]).toMatchObject({ entitlement_plan: "START", model: "GLM-5.3-Flash", effort: "max" });
      expect(orchestratorStepSchema.safeParse({ agent: "codex", instruction: "OK", write_scope: ["src"], entitlement_plan: "START" }).success).toBe(false);
    } finally { cleanup(dir); }
  });
});
