import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, cleanup } from "./helpers.js";
import { highestWorkerEffortRequired, requireHighestWorkerEffort, workerEffortPolicyFile, highestAdvertisedEffort, assertHighestGeminiModel, assertHighestAntigravityModel } from "../src/config/worker-effort-policy.js";

describe("operator worker effort policy", () => {
  it("persists idempotently and fails closed on malformed policy", () => {
    const dir = makeTmpDir("effort-policy");
    try {
      expect(highestWorkerEffortRequired(dir)).toBe(false);
      requireHighestWorkerEffort(dir);
      const file = workerEffortPolicyFile(dir);
      const before = fs.readFileSync(file, "utf8");
      expect(highestWorkerEffortRequired(dir)).toBe(true);
      requireHighestWorkerEffort(dir);
      expect(fs.readFileSync(file, "utf8")).toBe(before);
      expect(fs.existsSync(path.join(dir, "continuation.json"))).toBe(false);
      fs.writeFileSync(file, '{"schema":9,"glmAndGemini":"lowest"}');
      expect(() => highestWorkerEffortRequired(dir)).toThrow("WORKER_EFFORT_POLICY_INVALID");
    } finally { cleanup(dir); }
  });
  it("uses the live target levels and rejects unknown or empty catalogs", () => {
    expect(highestAdvertisedEffort(["low", "max", "high"])).toBe("max");
    expect(highestAdvertisedEffort(["low", "medium", "high"])).toBe("high");
    expect(highestAdvertisedEffort(["high", "ultra"])).toBe("ultra");
    expect(() => highestAdvertisedEffort([])).toThrow();
    expect(() => highestAdvertisedEffort(["high", "unknown"])).toThrow();
  });
  it("validates Gemini against its own live model family without fallback", () => {
    const listing = "Fetching available models...\ngemini-3.8-flash-high\tHigh\ngemini-3.8-flash-medium\tMedium\ngemini-3.1-pro-low\tLow\ngemini-3.1-pro-high\tHigh";
    expect(() => assertHighestGeminiModel("gemini-3.8-flash-high", listing)).not.toThrow();
    expect(() => assertHighestGeminiModel("gemini-3.8-flash-medium", listing)).toThrow("EFFORT_POLICY_VIOLATION");
    expect(() => assertHighestGeminiModel("gemini-3.1-pro-low", listing)).toThrow("EFFORT_POLICY_VIOLATION");
    expect(() => assertHighestGeminiModel("gemini-missing-high", listing)).toThrow("HIGHEST_EFFORT_UNVERIFIED");
  });
  it("validates Opus against its live family, not Gemini or the previous Opus generation", () => {
    const listing = "claude-opus-5-5-low\tClaude Opus 5.5 Low\nclaude-opus-5-5-medium\tClaude Opus 5.5 Medium\nclaude-opus-5-5-high\tClaude Opus 5.5 High\ngemini-3.8-flash-ultra\tUltra\nclaude-opus-4-6-thinking\tThinking";
    expect(() => assertHighestAntigravityModel("claude-opus-5-5-high", listing)).not.toThrow();
    expect(() => assertHighestAntigravityModel("claude-opus-5-5-medium", listing)).toThrow("EFFORT_POLICY_VIOLATION");
    expect(() => assertHighestAntigravityModel("claude-opus-5-5-low", listing)).toThrow("EFFORT_POLICY_VIOLATION");
    expect(() => assertHighestAntigravityModel("claude-opus-5-5-high", "gemini-3.8-flash-high\tHigh")).toThrow("HIGHEST_EFFORT_UNVERIFIED");
    expect(() => assertHighestAntigravityModel("claude-opus-5-5-high", "")).toThrow("HIGHEST_EFFORT_UNVERIFIED");
    expect(() => assertHighestAntigravityModel("claude-opus-5-5-high", listing + "\nclaude-opus-5-5-max\tMax")).toThrow("EFFORT_POLICY_VIOLATION");
  });
});
