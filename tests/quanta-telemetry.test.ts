import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { QuantaClient, clampPercent } from "../src/telemetry/quanta.js";

describe("Quanta Usage Telemetry Client & Normalization", () => {
  let mockServer: http.Server;
  let mockPort: number;
  let tempDir: string;
  let configPath: string;

  const baselinePayload = {
    observed_at: new Date().toISOString(),
    observed_at_scope: "all_providers",
    machine: "DESKTOP-TEST",
    generated_at: 1788597000,
    codex: {
      provider: "codex",
      accounts: [
        {
          email: "user-secret@example.com",
          plan_type: "plus",
          primary_used_percent: 85,
          effective_primary_used_percent: 85,
          primary_resets_at: 1788600000,
          primary_window_minutes: 300,
          secondary_used_percent: 40,
          secondary_resets_at: 1789000000,
          secondary_window_minutes: 10080,
          is_current: true,
          label: "user-secret@example.com",
        },
        {
          email: "stale-account@example.com",
          plan_type: "pro",
          primary_used_percent: 10,
          effective_primary_used_percent: 10,
          primary_resets_at: 1788600000,
          primary_window_minutes: 300,
          secondary_used_percent: 10,
          secondary_resets_at: 1789000000,
          secondary_window_minutes: 10080,
          is_current: false,
          label: "stale-account@example.com",
        },
      ],
    },
    antigravity: {
      label: "Antigravity",
      available: true,
      plan: "Ultra Pro",
      email: "personal-google@gmail.com",
      windows: [
        {
          label: "Gemini 5h窗口",
          percent: 15,
          remaining: 85,
          reset_at: 1788605000,
        },
        {
          label: "Gemini 周窗口",
          percent: 10,
          remaining: 90,
          reset_at: 1789120000,
        },
        {
          label: "Claude·GPT 5h窗口",
          percent: 25,
          remaining: 75,
          reset_at: 1788610000,
        },
        {
          label: "Claude·GPT 周窗口",
          percent: 20,
          remaining: 80,
          reset_at: 1789200000,
        },
      ],
      models: {
        "gemini-3.8-flash-high": 12,
        "claude-sonnet-4-6": 5,
      },
    },
    glm: {
      level: "VIP",
      windows: [
        {
          label: "5h窗口",
          percent: 100,
          reset_at: 1788599000,
        },
        {
          label: "周窗口",
          percent: 45,
          reset_at: 1789000000,
        },
      ],
    },
    deepseek: {
      error: "未配置 DeepSeek API key (config.json -> deepseek.api_key)",
    },
    muse: {
      label: "Muse Code",
      available: false,
      note: "WSL not running",
    },
  };

  let samplePayload = structuredClone(baselinePayload);

  beforeEach(async () => {
    samplePayload = structuredClone(baselinePayload);
    samplePayload.observed_at = new Date().toISOString();
    samplePayload.codex.accounts[0].primary_used_percent = 85;
    samplePayload.codex.accounts[0].effective_primary_used_percent = 85;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quanta-test-"));

    await new Promise<void>((resolve, reject) => {
      mockServer = http.createServer((req, res) => {
        const pathname = req.url?.split("?")[0];
        if (pathname === "/api/usage" && req.headers["x-token"] === "valid-secret-token") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(samplePayload));
        } else if (req.headers["x-token"] !== "valid-secret-token") {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "UNAUTHORIZED" }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockServer.once("error", reject);
      mockServer.listen(0, "127.0.0.1", () => {
        const addr = mockServer.address();
        mockPort = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });

    configPath = path.join(tempDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        server: {
          host: "127.0.0.1",
          port: mockPort,
          token: "valid-secret-token",
        },
      })
    );
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("successfully fetches and normalizes Quanta telemetry", async () => {
    const client = new QuantaClient({ configPath });
    const report = await client.getTelemetry();

    expect(report.quanta_available).toBe(true);
    expect(report.server_url).toBe("http://127.0.0.1:" + mockPort);

    // Codex normalization
    expect(report.providers.codex.status).toBe("available");
    expect(report.providers.codex.current_account).toBeDefined();
    expect(report.providers.codex.current_account?.is_current).toBe(true);
    expect(report.providers.codex.current_account?.plan_type).toBe("plus");
    expect(report.providers.codex.current_account?.five_hour_window.used_percent).toBe(85);
    expect(report.providers.codex.current_account?.five_hour_window.remaining_percent).toBe(15);
    expect(report.providers.codex.stale_accounts).toHaveLength(1);
    expect(report.providers.codex.stale_accounts[0].is_current).toBe(false);

    // Antigravity normalization
    expect(report.providers.antigravity.status).toBe("available");
    expect(report.providers.antigravity.pools.gemini.quota_pool_id).toBe("antigravity:gemini");
    expect(report.providers.antigravity.pools.gemini.five_hour_window.remaining_percent).toBe(85);
    expect(report.providers.antigravity.pools.claude_gpt_shared.quota_pool_id).toBe("antigravity:claude_gpt_shared");
    expect(report.providers.antigravity.pools.claude_gpt_shared.shared).toBe(true);
    expect(report.providers.antigravity.pools.claude_gpt_shared.five_hour_window.remaining_percent).toBe(75);
    expect(report.providers.antigravity.pools.claude_gpt_shared.note).toContain("share the exact same");

    // GLM normalization
    expect(report.providers.glm.status).toBe("available");
    expect(report.providers.glm.five_hour_window.used_percent).toBe(100);
    expect(report.providers.glm.five_hour_window.remaining_percent).toBe(0);

    // DeepSeek & Muse (unconfigured/unavailable, not zeroed)
    expect(report.providers.deepseek.status).toBe("unconfigured");
    expect(report.providers.deepseek.available).toBe(false);
    expect(report.providers.muse.status).toBe("unavailable");
    expect(report.providers.muse.available).toBe(false);
  });

  it("strictly redacts account emails and sensitive tokens from telemetry report", async () => {
    const client = new QuantaClient({ configPath });
    const report = await client.getTelemetry();
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain("user-secret@example.com");
    expect(serialized).not.toContain("stale-account@example.com");
    expect(serialized).not.toContain("personal-google@gmail.com");
    expect(serialized).not.toContain("valid-secret-token");
  });

  it("caches telemetry and supports forceRefresh", async () => {
    const client = new QuantaClient({ configPath, cacheTtlMs: 5000 });
    const report1 = await client.getTelemetry();

    // Mutate payload on mock server
    samplePayload.codex.accounts[0].primary_used_percent = 99;
    samplePayload.codex.accounts[0].effective_primary_used_percent = 99;

    // Cached fetch returns old value
    const report2 = await client.getTelemetry();
    expect(report2.providers.codex.current_account?.five_hour_window.used_percent).toBe(85);

    // Force refresh returns updated value
    const report3 = await client.getTelemetry({ forceRefresh: true });
    expect(report3.providers.codex.current_account?.five_hour_window.used_percent).toBe(99);
  });

  it("handles unreachable Quanta server gracefully without throwing", async () => {
    // Close our own endpoint; a fixed port could belong to a user service.
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        server: {
          host: "127.0.0.1",
          port: mockPort,
          token: "dummy",
        },
      })
    );
    const client = new QuantaClient({ configPath });
    const report = await client.getTelemetry({ forceRefresh: true });

    expect(report.quanta_available).toBe(false);
    expect(report.error).toBe("QUANTA_UNREACHABLE");
    expect(report.retry_guidance).toBe("Local Quanta telemetry could not be retrieved safely.");
  });

  it("generated time alone leaves freshness unknown and quota unavailable", async () => {
    delete (samplePayload as any).observed_at;
    samplePayload.generated_at = Date.now();
    const report = await new QuantaClient({ configPath }).getTelemetry();
    expect(report.freshness).toBe("unknown");
    expect(report.providers.codex.current_account?.constraints?.[0].remaining_percent).toBeNull();
    expect(report.providers.codex.current_account?.five_hour_window.status).toBe("unknown");
  });

  describe("P0-1: Truth semantics for unknown/missing telemetry", () => {
    it("missing Codex usage != 0 (represented as null with status unknown)", async () => {
      const origPrimary = samplePayload.codex.accounts[0].primary_used_percent;
      const origEffective = samplePayload.codex.accounts[0].effective_primary_used_percent;
      delete (samplePayload.codex.accounts[0] as any).primary_used_percent;
      delete (samplePayload.codex.accounts[0] as any).effective_primary_used_percent;

      try {
        const client = new QuantaClient({ configPath });
        const report = await client.getTelemetry({ forceRefresh: true });
        const win = report.providers.codex.current_account?.five_hour_window;
        expect(win).toBeDefined();
        expect(win?.used_percent).toBeNull();
        expect(win?.used_percent).not.toBe(0);
        expect(win?.remaining_percent).toBeNull();
        expect(win?.remaining_percent).not.toBe(100);
        expect(win?.status).toBe("unknown");
      } finally {
        samplePayload.codex.accounts[0].primary_used_percent = origPrimary;
        samplePayload.codex.accounts[0].effective_primary_used_percent = origEffective;
      }
    });

    it("missing Gemini window != 100% remaining (represented as null with status unknown)", async () => {
      const origWindows = samplePayload.antigravity.windows;
      samplePayload.antigravity.windows = origWindows.filter((w) => !w.label.includes("Gemini"));

      try {
        const client = new QuantaClient({ configPath });
        const report = await client.getTelemetry({ forceRefresh: true });
        const pool = report.providers.antigravity.pools.gemini;
        expect(pool.five_hour_window.remaining_percent).toBeNull();
        expect(pool.five_hour_window.remaining_percent).not.toBe(100);
        expect(pool.five_hour_window.used_percent).toBeNull();
        expect(pool.five_hour_window.used_percent).not.toBe(0);
        expect(pool.five_hour_window.status).toBe("unknown");
      } finally {
        samplePayload.antigravity.windows = origWindows;
      }
    });

    it("missing Claude/GPT window != 100% remaining (represented as null with status unknown)", async () => {
      const origWindows = samplePayload.antigravity.windows;
      samplePayload.antigravity.windows = origWindows.filter((w) => !w.label.includes("Claude") && !w.label.includes("GPT"));

      try {
        const client = new QuantaClient({ configPath });
        const report = await client.getTelemetry({ forceRefresh: true });
        const pool = report.providers.antigravity.pools.claude_gpt_shared;
        expect(pool.five_hour_window.remaining_percent).toBeNull();
        expect(pool.five_hour_window.remaining_percent).not.toBe(100);
        expect(pool.five_hour_window.used_percent).toBeNull();
        expect(pool.five_hour_window.used_percent).not.toBe(0);
        expect(pool.five_hour_window.status).toBe("unknown");
      } finally {
        samplePayload.antigravity.windows = origWindows;
      }
    });

    it("missing GLM usage != 0 (represented as null with status unknown)", async () => {
      const origWindows = samplePayload.glm.windows;
      samplePayload.glm.windows = [];

      try {
        const client = new QuantaClient({ configPath });
        const report = await client.getTelemetry({ forceRefresh: true });
        const win = report.providers.glm.five_hour_window;
        expect(win.used_percent).toBeNull();
        expect(win.used_percent).not.toBe(0);
        expect(win.remaining_percent).toBeNull();
        expect(win.remaining_percent).not.toBe(0);
        expect(win.status).toBe("unknown");
      } finally {
        samplePayload.glm.windows = origWindows;
      }
    });

    it("real reported zero remains zero", async () => {
      samplePayload.codex.accounts[0].primary_used_percent = 0;
      samplePayload.codex.accounts[0].effective_primary_used_percent = 0;
      const gemWin = samplePayload.antigravity.windows.find((w) => w.label.includes("Gemini 5h"));
      if (gemWin) {
        gemWin.percent = 0;
        gemWin.remaining = 100;
      }
      const glmWin = samplePayload.glm.windows.find((w) => w.label.includes("5h"));
      if (glmWin) {
        glmWin.percent = 0;
      }

      const client = new QuantaClient({ configPath });
      const report = await client.getTelemetry({ forceRefresh: true });

      expect(report.providers.codex.current_account?.five_hour_window.used_percent).toBe(0);
      expect(report.providers.codex.current_account?.five_hour_window.remaining_percent).toBe(100);
      expect(report.providers.codex.current_account?.five_hour_window.status).toBe("known");

      expect(report.providers.antigravity.pools.gemini.five_hour_window.used_percent).toBe(0);
      expect(report.providers.antigravity.pools.gemini.five_hour_window.remaining_percent).toBe(100);
      expect(report.providers.antigravity.pools.gemini.five_hour_window.status).toBe("known");

      expect(report.providers.glm.five_hour_window.used_percent).toBe(0);
      expect(report.providers.glm.five_hour_window.remaining_percent).toBe(100);
      expect(report.providers.glm.five_hour_window.status).toBe("known");
    });

    it("real reported 100 remains 100", async () => {
      samplePayload.codex.accounts[0].primary_used_percent = 100;
      samplePayload.codex.accounts[0].effective_primary_used_percent = 100;
      const gemWin = samplePayload.antigravity.windows.find((w) => w.label.includes("Gemini 5h"));
      if (gemWin) {
        gemWin.percent = 100;
        gemWin.remaining = 0;
      }
      const glmWin = samplePayload.glm.windows.find((w) => w.label.includes("5h"));
      if (glmWin) {
        glmWin.percent = 100;
      }

      const client = new QuantaClient({ configPath });
      const report = await client.getTelemetry({ forceRefresh: true });

      expect(report.providers.codex.current_account?.five_hour_window.used_percent).toBe(100);
      expect(report.providers.codex.current_account?.five_hour_window.remaining_percent).toBe(0);
      expect(report.providers.codex.current_account?.five_hour_window.status).toBe("known");

      expect(report.providers.antigravity.pools.gemini.five_hour_window.used_percent).toBe(100);
      expect(report.providers.antigravity.pools.gemini.five_hour_window.remaining_percent).toBe(0);
      expect(report.providers.antigravity.pools.gemini.five_hour_window.status).toBe("known");

      expect(report.providers.glm.five_hour_window.used_percent).toBe(100);
      expect(report.providers.glm.five_hour_window.remaining_percent).toBe(0);
      expect(report.providers.glm.five_hour_window.status).toBe("known");
    });

    it("shared_models uses canonical Antigravity models and excludes stale IDs", async () => {
      const client = new QuantaClient({ configPath });
      const report = await client.getTelemetry();
      const sharedModels = report.providers.antigravity.pools.claude_gpt_shared.shared_models;

      expect(sharedModels).toBeDefined();
      expect(sharedModels).toContain("claude-sonnet-4-6");
      expect(sharedModels).toContain("claude-opus-4-6-thinking");
      expect(sharedModels).toContain("gpt-oss-120b-medium");
      expect(sharedModels).not.toContain("claude-opus-4-6");
      expect(sharedModels).not.toContain("gpt-5.3-codex-high");
    });
  });

  describe("R3: Codex window classification is evidence-based (no fabricated windows)", () => {
    it("single long-window plan (10080min): absent 5h remains unknown, never fabricated as known/100%", async () => {
      const acc = samplePayload.codex.accounts[0];
      const original = { ...acc };
      try {
        acc.primary_used_percent = 40;
        acc.effective_primary_used_percent = 40;
        acc.primary_window_minutes = 10080;
        delete acc.secondary_used_percent;
        delete acc.secondary_resets_at;
        delete acc.secondary_window_minutes;
        const client = new QuantaClient({ configPath });
        const report = await client.getTelemetry({ forceRefresh: true });
        const current = report.providers.codex.current_account!;
        expect(current.five_hour_window.status).toBe("unknown");
        expect(current.five_hour_window.remaining_percent).toBeNull();
        expect(current.weekly_window.status).toBe("known");
        expect(current.weekly_window.remaining_percent).toBe(60);
        expect(current.weekly_window.window_minutes).toBe(10080);
      } finally {
        Object.assign(acc, original);
      }
    });

    it("non-weekly long window (720min) is labeled by its true duration, not rebranded weekly", async () => {
      const acc = samplePayload.codex.accounts[0];
      const original = { ...acc };
      try {
        acc.primary_used_percent = 10;
        acc.effective_primary_used_percent = 10;
        acc.primary_window_minutes = 720;
        delete acc.secondary_used_percent;
        delete acc.secondary_window_minutes;
        const client = new QuantaClient({ configPath });
        const report = await client.getTelemetry({ forceRefresh: true });
        const current = report.providers.codex.current_account!;
        expect(current.five_hour_window.status).toBe("unknown");
        expect(current.weekly_window.status).toBe("unknown");
        expect(current.weekly_window.remaining_percent).toBeNull();
        expect(current.constraints).toHaveLength(2);
        expect(current.constraints?.[0]).toMatchObject({label:"720-Minute Window",window_minutes:720,remaining_percent:90});
        expect(current.constraints?.[1].status).toBe("unknown");
      } finally {
        Object.assign(acc, original);
      }
    });

    it("missing window data stays unknown: no invented 100% window", async () => {
      const acc = samplePayload.codex.accounts[0];
      const original = { ...acc };
      try {
        delete acc.primary_used_percent;
        delete acc.effective_primary_used_percent;
        delete acc.primary_window_minutes;
        delete acc.secondary_used_percent;
        delete acc.secondary_window_minutes;
        const client = new QuantaClient({ configPath });
        const report = await client.getTelemetry({ forceRefresh: true });
        const current = report.providers.codex.current_account!;
        expect(current.five_hour_window.status).toBe("unknown");
        expect(current.five_hour_window.remaining_percent).toBeNull();
        expect(current.weekly_window.status).toBe("unknown");
        expect(current.weekly_window.remaining_percent).toBeNull();
      } finally {
        Object.assign(acc, original);
      }
    });
  });

  describe("P0-A: GLM unit semantics and percentage clamping", () => {
    it("clampPercent strictly enforces 0 <= val <= 100", () => {
      expect(clampPercent(0)).toBe(0);
      expect(clampPercent(50)).toBe(50);
      expect(clampPercent(100)).toBe(100);
      expect(clampPercent(-1)).toBeNull();
      expect(clampPercent(101)).toBeNull();
      expect(clampPercent(2000)).toBeNull();
      expect(clampPercent(3496)).toBeNull();
      expect(clampPercent(null)).toBeNull();
      expect(clampPercent(undefined)).toBeNull();
      expect(clampPercent("50")).toBeNull();
      expect(clampPercent(NaN)).toBeNull();
      expect(clampPercent(Infinity)).toBeNull();
    });

    it("normalizes GLM unit semantics: remaining_units and unit_type distinct from percentages", async () => {
      // Simulate real Quanta raw GLM payload
      samplePayload.glm = {
        level: "lite",
        windows: [
          {
            label: "5h窗口",
            type: "CREDIT_LIMIT",
            percent: 0,
            used: 0,
            quota: 2000,
            remaining: 2000,
            reset_at: null,
          },
          {
            label: "周窗口",
            type: "CREDIT_LIMIT",
            percent: 65,
            used: 6503,
            quota: 10000,
            remaining: 3496,
            reset_at: 1789025352,
          },
        ],
      } as any;

      const client = new QuantaClient({ configPath });
      const report = await client.getTelemetry({ forceRefresh: true });
      const glm = report.providers.glm;

      // 5h window checks
      expect(glm.five_hour_window.used_percent).toBe(0);
      expect(glm.five_hour_window.remaining_percent).toBe(100);
      expect(glm.five_hour_window.remaining_units).toBe(2000);
      expect(glm.five_hour_window.unit_type).toBe("CREDIT_LIMIT");
      expect(glm.five_hour_window.status).toBe("known");

      // Weekly window checks
      expect(glm.weekly_window.used_percent).toBe(65);
      expect(glm.weekly_window.remaining_percent).toBe(35);
      expect(glm.weekly_window.remaining_units).toBe(3496);
      expect(glm.weekly_window.unit_type).toBe("CREDIT_LIMIT");
      expect(glm.weekly_window.status).toBe("known");

      // Verify that no percentage value is > 100
      expect(glm.five_hour_window.remaining_percent).toBeLessThanOrEqual(100);
      expect(glm.weekly_window.remaining_percent).toBeLessThanOrEqual(100);
    });
  });

  describe("Section VII: Targeted Freshness & Timestamp Semantics (Scenarios A-H)", () => {
    it("does not borrow Codex's sample time for Gemini or GLM", async () => {
      delete (samplePayload as any).observed_at;
      delete (samplePayload as any).observed_at_scope;
      (samplePayload.codex.accounts[0] as any).snapshot_at = new Date(Date.now() - 5000).toISOString();
      const report = await new QuantaClient({ configPath }).getTelemetry({ forceRefresh: true });
      expect(report.providers.codex.current_account?.five_hour_window.remaining_percent).toBe(15);
      expect(report.providers.antigravity.pools.gemini.five_hour_window.remaining_percent).toBeNull();
      expect(report.providers.glm.five_hour_window.remaining_percent).toBeNull();
    });

    it("does not override an explicitly stale provider with fresh global evidence", async () => {
      samplePayload.observed_at = new Date(Date.now() - 5000).toISOString();
      (samplePayload.glm as any).observed_at = new Date(Date.now() - 61000).toISOString();
      const report = await new QuantaClient({ configPath }).getTelemetry({ forceRefresh: true });
      expect(report.providers.codex.current_account?.five_hour_window.status).toBe("known");
      expect(report.providers.glm.five_hour_window.status).toBe("unknown");
    });

    it("uses the current Codex account's time even when it is not accounts[0]", async () => {
      delete (samplePayload as any).observed_at;
      delete (samplePayload as any).observed_at_scope;
      samplePayload.codex.accounts[0].is_current = false;
      (samplePayload.codex.accounts[0] as any).snapshot_at = new Date(Date.now() - 61000).toISOString();
      samplePayload.codex.accounts[1].is_current = true;
      (samplePayload.codex.accounts[1] as any).snapshot_at = new Date(Date.now() - 5000).toISOString();
      const report = await new QuantaClient({ configPath }).getTelemetry({ forceRefresh: true });
      expect(report.providers.codex.current_account?.account_index).toBe(1);
      expect(report.providers.codex.current_account?.five_hour_window.status).toBe("known");
      expect(report.observed_at).toBe((samplePayload.codex.accounts[1] as any).snapshot_at);
    });

    it.each([59_000, 61_000])("applies the 60-second boundary independently at age %i", async (age) => {
      delete (samplePayload as any).observed_at;
      delete (samplePayload as any).observed_at_scope;
      (samplePayload.codex.accounts[0] as any).snapshot_at = new Date(Date.now() - age).toISOString();
      const report = await new QuantaClient({ configPath }).getTelemetry({ forceRefresh: true });
      expect(report.providers.codex.current_account?.five_hour_window.status).toBe(age < 60_000 ? "known" : "unknown");
      expect(report.providers.antigravity.pools.gemini.five_hour_window.status).toBe("unknown");
    });

    it.each(["not-a-time", new Date(Date.now() + 60_000).toISOString()])("rejects invalid or future provider time %s", async (value) => {
      delete (samplePayload as any).observed_at;
      delete (samplePayload as any).observed_at_scope;
      (samplePayload.glm as any).observed_at = value;
      const report = await new QuantaClient({ configPath }).getTelemetry({ forceRefresh: true });
      expect(report.providers.glm.five_hour_window.status).toBe("unknown");
      expect(report.providers.glm.observed_at).toBe(value === "not-a-time" ? null : value);
    });

    it("rejects an impossible calendar date even if Date.parse normalizes it to now", async () => {
      delete (samplePayload as any).observed_at;
      delete (samplePayload as any).observed_at_scope;
      (samplePayload.glm as any).observed_at = "2026-02-30T12:00:00Z";
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-02T12:00:05Z"));
      try {
        const report = await new QuantaClient({ configPath }).getTelemetry({ forceRefresh: true });
        expect(report.providers.glm.observed_at).toBeNull();
        expect(report.providers.glm.five_hour_window.status).toBe("unknown");
      } finally {
        clock.mockRestore();
      }
    });

    it("does not use updated_at as a quota sample timestamp", async () => {
      delete (samplePayload as any).observed_at;
      delete (samplePayload as any).observed_at_scope;
      (samplePayload.glm as any).updated_at = new Date().toISOString();
      const report = await new QuantaClient({ configPath }).getTelemetry({ forceRefresh: true });
      expect(report.providers.glm.five_hour_window.status).toBe("unknown");
    });

    it("rechecks cached sample age and never refreshes it after a failed forced request", async () => {
      samplePayload.observed_at = new Date(Date.now() - 5_000).toISOString();
      const client = new QuantaClient({ configPath, cacheTtlMs: 120_000 });
      const first = await client.getTelemetry();
      expect(first.providers.codex.current_account?.five_hour_window.status).toBe("known");
      fs.writeFileSync(configPath, JSON.stringify({ server: { host: "127.0.0.1", port: mockPort, token: "wrong-token" } }));
      const future = Date.now() + 61_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(future);
      try {
        const failed = await client.getTelemetry({ forceRefresh: true });
        expect(failed.error).toBe("QUANTA_AUTH_FAILED");
        const cached = await client.getTelemetry();
        expect(cached.providers.codex.current_account?.five_hour_window.status).toBe("unknown");
        expect(cached.fetched_at).toBe(first.fetched_at);
      } finally {
        clock.mockRestore();
      }
    });

    it("Scenario A: fresh snapshot (observed_at = now - 5s, used_percent = 35) -> freshness=fresh, status=known, remaining=65", async () => {
      samplePayload.observed_at = new Date(Date.now() - 5000).toISOString();
      samplePayload.codex.accounts[0].primary_used_percent = 35;
      samplePayload.codex.accounts[0].effective_primary_used_percent = 35;

      const client = new QuantaClient({ configPath });
      const report = await client.getTelemetry({ forceRefresh: true });

      expect(report.freshness).toBe("fresh");
      const win = report.providers.codex.current_account?.five_hour_window;
      expect(win?.status).toBe("known");
      expect(win?.used_percent).toBe(35);
      expect(win?.remaining_percent).toBe(65);
    });

    it("Scenario B: stale snapshot (observed_at = now - 10m) -> freshness=unknown, status=unknown, percent=null", async () => {
      samplePayload.observed_at = new Date(Date.now() - 600000).toISOString();
      samplePayload.codex.accounts[0].primary_used_percent = 35;
      samplePayload.codex.accounts[0].effective_primary_used_percent = 35;

      const client = new QuantaClient({ configPath });
      const report = await client.getTelemetry({ forceRefresh: true });

      expect(report.freshness).toBe("unknown");
      const win = report.providers.codex.current_account?.five_hour_window;
      expect(win?.status).toBe("unknown");
      expect(win?.used_percent).toBeNull();
      expect(win?.remaining_percent).toBeNull();
    });

    it("Scenario C: missing timestamp -> freshness=unknown, percent=null", async () => {
      delete (samplePayload as any).observed_at;
      delete (samplePayload as any).sampled_at;
      delete (samplePayload as any).generated_at;

      const client = new QuantaClient({ configPath });
      const report = await client.getTelemetry({ forceRefresh: true });

      expect(report.freshness).toBe("unknown");
      expect(report.observed_at).toBeNull();
      const win = report.providers.codex.current_account?.five_hour_window;
      expect(win?.status).toBe("unknown");
      expect(win?.used_percent).toBeNull();
      expect(win?.remaining_percent).toBeNull();
    });

    it("Scenario D: future timestamp / clock error -> freshness=unknown, status=unknown, percent=null", async () => {
      samplePayload.observed_at = new Date(Date.now() + 600000).toISOString();
      samplePayload.codex.accounts[0].primary_used_percent = 35;
      samplePayload.codex.accounts[0].effective_primary_used_percent = 35;

      const client = new QuantaClient({ configPath });
      const report = await client.getTelemetry({ forceRefresh: true });

      expect(report.freshness).toBe("unknown");
      const win = report.providers.codex.current_account?.five_hour_window;
      expect(win?.status).toBe("unknown");
      expect(win?.used_percent).toBeNull();
      expect(win?.remaining_percent).toBeNull();
    });

    it("Scenario E: reset time only does not make snapshot fresh -> freshness=unknown, percent=null", async () => {
      delete (samplePayload as any).observed_at;
      delete (samplePayload as any).sampled_at;
      delete (samplePayload as any).generated_at;
      samplePayload.codex.accounts[0].primary_resets_at = Math.floor(Date.now() / 1000) + 3600;
      samplePayload.codex.accounts[0].primary_used_percent = 35;
      samplePayload.codex.accounts[0].effective_primary_used_percent = 35;

      const client = new QuantaClient({ configPath });
      const report = await client.getTelemetry({ forceRefresh: true });

      expect(report.freshness).toBe("unknown");
      const win = report.providers.codex.current_account?.five_hour_window;
      expect(win?.status).toBe("unknown");
      expect(win?.used_percent).toBeNull();
      expect(win?.remaining_percent).toBeNull();
      expect(win?.reset_at).toBeDefined();
    });

    it("Scenario F: provider no percent on fresh snapshot -> status=unknown, remaining_percent=null (never fabricated)", async () => {
      samplePayload.observed_at = new Date(Date.now() - 5000).toISOString();
      delete (samplePayload.codex.accounts[0] as any).primary_used_percent;
      delete (samplePayload.codex.accounts[0] as any).effective_primary_used_percent;

      const client = new QuantaClient({ configPath });
      const report = await client.getTelemetry({ forceRefresh: true });

      expect(report.freshness).toBe("fresh");
      const win = report.providers.codex.current_account?.five_hour_window;
      expect(win?.status).toBe("unknown");
      expect(win?.used_percent).toBeNull();
      expect(win?.remaining_percent).toBeNull();
    });

    it("Scenario G: GLM CREDIT_LIMIT units without percentage -> remaining_units=val, remaining_percent=null", async () => {
      samplePayload.observed_at = new Date(Date.now() - 5000).toISOString();
      samplePayload.glm = {
        level: "lite",
        windows: [
          {
            label: "5h窗口",
            type: "CREDIT_LIMIT",
            percent: null,
            used: 120,
            quota: 2000,
            remaining: 1880,
            reset_at: 1788599000,
          },
        ],
      } as any;

      const client = new QuantaClient({ configPath });
      const report = await client.getTelemetry({ forceRefresh: true });

      expect(report.freshness).toBe("fresh");
      const win = report.providers.glm.five_hour_window;
      expect(win.status).toBe("known");
      expect(win.used_percent).toBeNull();
      expect(win.remaining_percent).toBeNull();
      expect(win.remaining_units).toBe(1880);
      expect(win.unit_type).toBe("CREDIT_LIMIT");
    });

    it("Scenario H: mixed provider age -> stale provider invalidated as unknown, fresh provider preserved", async () => {
      delete (samplePayload as any).observed_at;
      const now = Date.now();
      (samplePayload.codex.accounts[0] as any).snapshot_at = new Date(now - 5000).toISOString();
      samplePayload.codex.accounts[0].primary_used_percent = 35;
      samplePayload.codex.accounts[0].effective_primary_used_percent = 35;

      (samplePayload.glm as any).observed_at = new Date(now - 600000).toISOString();

      const client = new QuantaClient({ configPath });
      const report = await client.getTelemetry({ forceRefresh: true });

      expect(report.freshness).toBe("fresh");

      const codexWin = report.providers.codex.current_account?.five_hour_window;
      expect(codexWin?.status).toBe("known");
      expect(codexWin?.used_percent).toBe(35);
      expect(codexWin?.remaining_percent).toBe(65);

      const glmWin = report.providers.glm.five_hour_window;
      expect(glmWin.status).toBe("unknown");
      expect(glmWin.used_percent).toBeNull();
      expect(glmWin.remaining_percent).toBeNull();
    });
  });
});
