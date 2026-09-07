import fs from "node:fs";
import { describe, it, expect } from "vitest";
import {
  connectorAction,
  connectorNameFor,
  DEFAULT_CONNECTOR_NAME,
  endpointFile,
  mcpUrlFromPublic,
  normalizePublicUrl,
  readLastEndpoint,
  reclaimUserMessage,
  writeLastEndpoint,
} from "../src/config/endpoint.js";
import { cleanup, makeTmpDir } from "./helpers.js";

describe("connectorAction", () => {
  it("creates on the first successful URL", () => {
    expect(connectorAction(null, "https://a.trycloudflare.com/mcp")).toBe("create");
  });

  it("is a no-op when the URL is unchanged", () => {
    expect(connectorAction("https://a.trycloudflare.com/mcp", "https://a.trycloudflare.com/mcp/")).toBe("none");
  });

  it("updates when the old address was reclaimed", () => {
    expect(connectorAction("https://old.trycloudflare.com/mcp", "https://new.trycloudflare.com/mcp")).toBe("update");
    expect(reclaimUserMessage("Codex with ChatGPT")).toContain("删除");
    expect(reclaimUserMessage("Codex with ChatGPT")).not.toContain("Reconnect");
  });

  it("does nothing without a next URL", () => {
    expect(connectorAction("https://a.trycloudflare.com/mcp", null)).toBe("none");
  });
});

describe("connectorNameFor", () => {
  it("keeps a stored name for the same workspace", () => {
    expect(
      connectorNameFor({
        workspaceName: "EchoMind",
        workspaceId: "abc123abc123",
        previousName: "Codex with ChatGPT",
        hadEndpointBefore: true,
      })
    ).toBe(DEFAULT_CONNECTOR_NAME);
  });

  it("keeps the legacy title when this workspace was used before the name field existed", () => {
    expect(
      connectorNameFor({
        workspaceName: "EchoMind",
        workspaceId: "abc123abc123",
        hadEndpointBefore: true,
      })
    ).toBe(DEFAULT_CONNECTOR_NAME);
  });

  it("gives a new workspace its own connector title", () => {
    expect(
      connectorNameFor({
        workspaceName: "Landing",
        workspaceId: "def456def456",
        hadEndpointBefore: false,
      })
    ).toBe("Codex with ChatGPT · Landing");
  });
});

describe("mcpUrlFromPublic", () => {
  it("appends /mcp and folds case/slash variants", () => {
    expect(mcpUrlFromPublic("https://A.trycloudflare.com/")).toBe("https://a.trycloudflare.com/mcp");
    expect(mcpUrlFromPublic("https://a.trycloudflare.com/mcp")).toBe("https://a.trycloudflare.com/mcp");
    expect(normalizePublicUrl("https://A.trycloudflare.com/")).toBe("https://a.trycloudflare.com");
  });
});

describe("endpoint stateDir handling", () => {
  it("reads and writes endpoint records in explicit stateDir", () => {
    const dir = makeTmpDir("custom-endpoint-state");
    try {
      const saved = writeLastEndpoint(
        { workspaceId: "ws123", port: 5000, publicUrl: "https://foo.example", mcpUrl: "https://foo.example/mcp" },
        dir
      );
      expect(saved.workspaceId).toBe("ws123");
      const read = readLastEndpoint("ws123", dir);
      expect(read).toMatchObject({ workspaceId: "ws123", port: 5000, publicUrl: "https://foo.example" });
      expect(fs.existsSync(endpointFile("ws123", dir))).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});

