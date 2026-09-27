import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { TaskEngine } from "../src/core/tasks/engine.js";
import { Persistence } from "../src/core/tasks/persistence.js";
import { WorkspaceRegistry } from "../src/core/workspaces/registry.js";
import { FileAuditLog } from "../src/util/log.js";
import { ZcodeOfficialProvider } from "../src/providers/zcode/official.js";

const SECRET = "z2c-security-probe-secret-4f7a9";

describe("credential hygiene (P0.2 invariants)", () => {
  it("config no longer exposes any ZCode credential-store reader", async () => {
    const configModule = await import("../src/config.js");
    for (const key of Object.keys(configModule)) {
      assert.match(
        key,
        /^(loadConfig|parseRegQueryOutput|localAppData|isJsScript|resolveCliSpawn|ZCODE_CLI_RELATIVE_LAYOUTS|resolveZcodeCliPath|resolveZcodeBuiltinProviderConfigFile)$/,
        `unexpected export: ${key}`,
      );
    }
  });

  it("source tripwire: Z2C source never references ZCode credential material", () => {
    const files = [
      "src/config.ts",
      "src/index.ts",
      "src/providers/types.ts",
      "src/providers/zcode/official.ts",
      "src/providers/zcode/protocol.ts",
      "src/providers/zcode/process.ts",
      "src/providers/zcode/client.ts",
      "src/core/tasks/engine.ts",
    ];
    const forbidden = [/credentials\.json/i, /oauth:zai/i, /oauth:bigmodel/i, /zcodejwttoken/i, /\.zcode[/\\]v2/];
    for (const rel of files) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      for (const pattern of forbidden) {
        assert.equal(pattern.test(src), false, `${rel} references forbidden credential material ${pattern}`);
      }
    }
  });

  it("official provider child env contains no provider auth material even when the parent env does", async () => {
    process.env.Z2C_MODEL_API_KEY = SECRET;
    const stateDir = mkdtempSync(join(tmpdir(), "z2c-sec-"));
    const workspace = mkdtempSync(join(tmpdir(), "z2c-sec-ws-"));
    process.env.FAKE_APP_SERVER_LOG = join(stateDir, "log.jsonl");
    const cfg = { ...loadConfig(), stateDir, zcodeCliPath: join(process.cwd(), "test", "fixtures", "fake-app-server.mjs") };
    const provider = new ZcodeOfficialProvider(cfg);
    try {
      await provider.start();
      const sid = await provider.createSession({ workspacePath: workspace, workspaceKey: workspace }, { readonly: true });
      const handle = await provider.send({ sessionId: sid, instruction: "probe", inputId: "z2c-sec-1", timeoutMs: 15000 });
      await handle.completion;
      const log = readFileSync(process.env.FAKE_APP_SERVER_LOG, "utf8");
      assert.equal(log.includes(SECRET), false, "secret leaked into child-visible state");
    } finally {
      delete process.env.Z2C_MODEL_API_KEY;
      delete process.env.FAKE_APP_SERVER_LOG;
      await provider.stop();
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("audit logs never contain provider auth material", async () => {
    process.env.Z2C_MODEL_API_KEY = SECRET;
    process.env.FAKE_APP_SERVER_PROVIDER_ID = "builtin:zai-coding-plan";
    const dir = mkdtempSync(join(tmpdir(), "z2c-audit-"));
    const cfg = {
      ...loadConfig(),
      stateDir: dir,
      zcodeCliPath: join(process.cwd(), "test", "fixtures", "fake-app-server.mjs"),
      requestedProviderId: "builtin:zai-coding-plan",
      requestedModelId: "GLM-5.3-Flash",
      requestedThoughtLevel: "max",
    };
    const provider = new ZcodeOfficialProvider(cfg);
    try {
      // Harness mirrors core.test.ts; the secret lives ONLY in the parent env.
      const store = new Persistence(dir);
      const workspaces = WorkspaceRegistry.fromList([]);
      mkdirSync(join(dir, "ws0"), { recursive: true });
      workspaces.register("z2c-test", join(dir, "ws0"), "test");
      store.data.workspaces = workspaces.toList();
      store.save();
      const audit = new FileAuditLog(join(dir, "audit"));
      const engine = new TaskEngine(cfg, provider, workspaces, store, audit);
      await provider.start();
      const view = await engine.submitTask({ workspace_id: "z2c-test", instruction: "audit hygiene probe", write_scope: "workspace" });
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const t = engine.getTask(undefined, view.task_id);
        if (["completed", "failed"].includes(t.status)) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const auditFiles = readdirSync(join(dir, "audit"));
      for (const f of auditFiles) {
        const content = readFileSync(join(dir, "audit", f), "utf8");
        assert.equal(content.includes(SECRET), false, `audit log ${f} contains provider auth material`);
      }
      const state = readFileSync(join(dir, "state.json"), "utf8");
      assert.equal(state.includes(SECRET), false, "durable task state contains provider auth material");
    } finally {
      await provider.stop();
      delete process.env.Z2C_MODEL_API_KEY;
      delete process.env.FAKE_APP_SERVER_PROVIDER_ID;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("provider selection policy (P1: official default, explicit legacy only)", () => {
  it("defaults to the official provider", () => {
    const previous = process.env.Z2C_PROVIDER;
    delete process.env.Z2C_PROVIDER;
    try {
      assert.equal(loadConfig().providerMode, "official");
    } finally {
      if (previous !== undefined) process.env.Z2C_PROVIDER = previous;
    }
  });

  it("never silently falls back to a legacy lane (unknown values resolve to official)", () => {
    const cases: Array<[string, string]> = [
      ["desktop", "desktop-legacy"], // explicit alias
      ["desktop-legacy", "desktop-legacy"], // explicit opt-in
      ["headless", "headless"], // explicit opt-in
      ["official", "official"],
      ["auto", "official"], // legacy value from Phase 1 → official, never legacy
      ["garbage", "official"],
      ["", "official"],
    ];
    const previous = process.env.Z2C_PROVIDER;
    try {
      for (const [value, expected] of cases) {
        process.env.Z2C_PROVIDER = value;
        assert.equal(loadConfig().providerMode, expected, `Z2C_PROVIDER=${value}`);
      }
    } finally {
      if (previous !== undefined) process.env.Z2C_PROVIDER = previous;
      else delete process.env.Z2C_PROVIDER;
    }
  });

  it("requested provider stays an explicit constraint (null unless configured)", () => {
    const previous = process.env.Z2C_REQUESTED_PROVIDER;
    delete process.env.Z2C_REQUESTED_PROVIDER;
    try {
      assert.equal(loadConfig().requestedProviderId, null);
      process.env.Z2C_REQUESTED_PROVIDER = "zai-api";
      assert.equal(loadConfig().requestedProviderId, "zai-api");
    } finally {
      if (previous !== undefined) process.env.Z2C_REQUESTED_PROVIDER = previous;
    }
  });
});
