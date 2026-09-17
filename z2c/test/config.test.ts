import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRegQueryOutput } from "../src/config.js";

describe("registry hydration parser", () => {
  it("parses HKCU reg query output", () => {
    const raw = [
      "",
      "HKEY_CURRENT_USER\\Environment",
      "    Path    REG_EXPAND_SZ    C:\\some\\path",
      "    Z2C_MODEL_API_KEY    REG_SZ    abc123secret    ",
      "",
    ].join("\n");
    assert.equal(parseRegQueryOutput(raw, "Z2C_MODEL_API_KEY"), "abc123secret");
  });
  it("handles EXPAND_SZ and surrounding whitespace", () => {
    const raw = "HKEY_CURRENT_USER\\Environment\n    Z2C_MODEL_API_KEY    REG_EXPAND_SZ      key-with  spaces  ";
    assert.equal(parseRegQueryOutput(raw, "Z2C_MODEL_API_KEY"), "key-with  spaces");
  });
  it("returns null when the variable is missing", () => {
    assert.equal(parseRegQueryOutput("HKEY_CURRENT_USER\\Environment\n    Path    REG_SZ    C:\\", "Z2C_MODEL_API_KEY"), null);
  });
  it("returns null for empty values", () => {
    assert.equal(parseRegQueryOutput("Z2C_MODEL_API_KEY    REG_SZ    ", "Z2C_MODEL_API_KEY"), null);
  });
  it("matches case-insensitively on type token", () => {
    assert.equal(parseRegQueryOutput("Z2C_MODEL_API_KEY    reg_sz    v", "Z2C_MODEL_API_KEY"), "v");
  });
});
