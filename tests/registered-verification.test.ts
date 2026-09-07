import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  parseRegisteredVerificationArgs,
  REGISTERED_VERIFICATION_PROFILE_ID,
} from "../src/execution/registered-verification.js";

describe("registered bridge verification command contract", () => {
  it("accepts only the bridge-owned workspace/runtime argument vector", () => {
    const workspaceRoot = path.resolve("/tmp/c2c-portable-root");
    const runtimeRoot = path.resolve("C:/c2c-runtime/verification/task");

    expect(parseRegisteredVerificationArgs([
      "--workspace",
      workspaceRoot,
      "--runtime",
      runtimeRoot,
    ])).toEqual({ workspaceRoot, runtimeRoot });
  });

  it("rejects extra flags, reordered flags, and relative paths", () => {
    expect(() => parseRegisteredVerificationArgs([
      "--workspace",
      path.resolve("/tmp/c2c-portable-root"),
      "--runtime",
      path.resolve("C:/c2c-runtime/verification/task"),
      "--shell",
    ])).toThrow(/argv length/i);

    expect(() => parseRegisteredVerificationArgs([
      "--runtime",
      path.resolve("C:/c2c-runtime/verification/task"),
      "--workspace",
      path.resolve("/tmp/c2c-portable-root"),
    ])).toThrow(/unsupported argv shape/i);

    expect(() => parseRegisteredVerificationArgs([
      "--workspace",
      "relative-workspace",
      "--runtime",
      path.resolve("C:/c2c-runtime/verification/task"),
    ])).toThrow(/absolute/i);
  });

  it("keeps the registered profile identity explicit", () => {
    expect(REGISTERED_VERIFICATION_PROFILE_ID).toBe("c2c-bridge-in-process");
  });
});
