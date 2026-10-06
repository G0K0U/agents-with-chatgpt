import { describe, it, expect } from "vitest";
import path from "node:path";
import { antigravityBrowserTools } from "../src/execution/browser-tools.js";

describe("Antigravity browser tool wiring", () => {
  it("exposes only the pinned isolated browser for online tasks", () => {
    const config = antigravityBrowserTools(true, path.resolve("artifacts/browser-proof")) as { browser: { command: string; args: string[] } };
    expect(Object.keys(config)).toEqual(["browser"]);
    expect(config.browser.command).toBe(process.execPath);
    expect(config.browser.args).toEqual(expect.arrayContaining(["--headless", "--isolated", "--no-webmcp", "--block-service-workers"]));
    expect(config.browser.args).not.toContain("--extension");
    expect(config.browser.args).not.toContain("--allow-unrestricted-file-access");
    expect(config.browser.args).not.toContain("--no-sandbox");
    expect(config.browser.args).not.toContain("--storage-state");
    expect(JSON.stringify(config)).not.toContain("/mcp");
    expect(config.browser.args.at(0)).toMatch(/playwright.*mcp.*cli\.js/);
  });
  it("keeps browser tools absent offline", () => {
    expect(antigravityBrowserTools(false, "unused")).toEqual({});
  });
});
