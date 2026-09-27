import { describe, expect, it } from "vitest";
import { fullAccessDevelopmentEnabled } from "../src/config/development.js";

describe("local full-access deployment opt-in", () => {
  it.each([undefined, "", "false", "1", "TRUE"])("stays restricted for %s", value => {
    expect(fullAccessDevelopmentEnabled({ C2C_FULL_ACCESS_DEVELOPMENT: value })).toBe(false);
  });
  it("requires the explicit local flag", () => {
    expect(fullAccessDevelopmentEnabled({ C2C_FULL_ACCESS_DEVELOPMENT: "true" })).toBe(true);
  });
});
