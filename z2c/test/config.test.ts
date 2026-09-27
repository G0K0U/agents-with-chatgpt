import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRegQueryOutput,
  loadConfig,
  resolveZcodeCliPath,
  resolveZcodeBuiltinProviderConfigFile,
  resolveCliSpawn,
  isJsScript,
  localAppData,
} from "../src/config.js";
import { ZcodeOfficialProvider } from "../src/providers/zcode/official.js";

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

describe("ZCode CLI resolution and spawning", () => {
  it("resolves current 0.16.9 installed layout under local app data", () => {
    const mockAppData = "C:\\MockApp\\Local";
    const expected = join(mockAppData, "Programs", "ZCode", "resources", "glm", "zcode.cjs");
    const mockExists = (p: string) => p.toLowerCase() === expected.toLowerCase();
    const resolved = resolveZcodeCliPath({ LOCALAPPDATA: mockAppData }, mockExists);
    assert.equal(resolved, expected);
  });

  it("resolves current 0.16.9 on the real machine when installed", () => {
    const cfg = loadConfig();
    assert.ok(existsSync(cfg.zcodeCliPath), `Resolved CLI path should exist: ${cfg.zcodeCliPath}`);
    assert.match(cfg.zcodeCliPath, /resources[\\/]glm[\\/]zcode\.cjs$/i);
  });

  it("resolves legacy supported layouts when current layout is absent", () => {
    const mockAppData = "C:\\MockApp\\Local";
    const legacyPath = join(mockAppData, "Programs", "ZCode", "resources", "zcode.cjs");
    const mockExists = (p: string) => p.toLowerCase() === legacyPath.toLowerCase();
    const resolved = resolveZcodeCliPath({ LOCALAPPDATA: mockAppData }, mockExists);
    assert.equal(resolved, legacyPath);

    // Also verify unpacked asar legacy layout
    const unpackedPath = join(mockAppData, "Programs", "ZCode", "resources", "app.asar.unpacked", "apps", "zcode-cli", "packages", "cli", "dist", "zcode.cjs");
    const mockExistsUnpacked = (p: string) => p.toLowerCase() === unpackedPath.toLowerCase();
    const resolvedUnpacked = resolveZcodeCliPath({ LOCALAPPDATA: mockAppData }, mockExistsUnpacked);
    assert.equal(resolvedUnpacked, unpackedPath);
  });

  it("fails closed when CLI is missing", async () => {
    const mockAppData = "C:\\Nonexistent\\AppData";
    const mockExists = () => false;
    const resolved = resolveZcodeCliPath({ LOCALAPPDATA: mockAppData }, mockExists);
    const expectedFallback = join(mockAppData, "Programs", "ZCode", "resources", "glm", "zcode.cjs");
    assert.equal(resolved, expectedFallback);

    // Verify official provider start fails closed
    const nonExistentPath = join(tmpdir(), "definitely-missing-zcode-cli.cjs");
    const provider = new ZcodeOfficialProvider({
      ...loadConfig(),
      zcodeCliPath: nonExistentPath,
    });
    await assert.rejects(
      async () => provider.start(),
      /cannot execute ZCode CLI at/,
    );
    assert.equal(provider.status, "unreachable");
  });

  it("resolves and handles paths containing spaces correctly", () => {
    const mockAppData = "C:\\Users\\Sample User\\AppData\\Local";
    const expected = join(mockAppData, "Programs", "ZCode", "resources", "glm", "zcode.cjs");
    const mockExists = (p: string) => p.toLowerCase() === expected.toLowerCase();
    const resolved = resolveZcodeCliPath({ LOCALAPPDATA: mockAppData }, mockExists);
    assert.equal(resolved, expected);
    assert.ok(resolved.includes("Sample User"));

    // Spawning a JS/CJS CLI with spaces must use node and keep path as a single arg
    const spawnJs = resolveCliSpawn("C:\\Program Files\\ZCode App\\resources\\glm\\zcode.cjs", ["app-server", "--stdio"]);
    assert.equal(spawnJs.command, process.execPath);
    assert.deepEqual(spawnJs.args, [
      "C:\\Program Files\\ZCode App\\resources\\glm\\zcode.cjs",
      "app-server",
      "--stdio",
    ]);

    // Spawning a binary CLI with spaces must invoke binary directly
    const spawnBin = resolveCliSpawn("C:\\Program Files\\ZCode App\\bin\\zcode.exe", ["app-server", "--stdio"]);
    assert.equal(spawnBin.command, "C:\\Program Files\\ZCode App\\bin\\zcode.exe");
    assert.deepEqual(spawnBin.args, ["app-server", "--stdio"]);
  });

  it("executes CLI in path with spaces via detectVersion", () => {
    const dirWithSpaces = mkdtempSync(join(tmpdir(), "z2c test path with spaces-"));
    const scriptPath = join(dirWithSpaces, "zcode.cjs");
    try {
      writeFileSync(scriptPath, "console.log('0.16.9');\n", "utf8");
      const provider = new ZcodeOfficialProvider({
        ...loadConfig(),
        zcodeCliPath: scriptPath,
      });
      const version = provider.detectVersion();
      assert.equal(version, "0.16.9");
    } finally {
      rmSync(dirWithSpaces, { recursive: true, force: true });
    }
  });

  it("respects explicit Z2C_ZCODE_CLI override", () => {
    const explicit = "D:\\custom\\zcode\\zcode.cjs";
    const resolved = resolveZcodeCliPath({ Z2C_ZCODE_CLI: explicit });
    assert.equal(resolved, explicit);
  });
});

describe("ZCode builtin provider config resolution", () => {
  it("detects packaged 0.16.9 sibling layout from resources/glm/zcode.cjs", () => {
    const mockCli = "C:\\MockApp\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs";
    const expectedConfig = "C:\\MockApp\\Local\\Programs\\ZCode\\resources\\config\\provider\\zcode-builtin.json";
    const mockExists = (p: string) => p.toLowerCase() === expectedConfig.toLowerCase();
    const resolved = resolveZcodeBuiltinProviderConfigFile(mockCli, {}, mockExists);
    assert.equal(resolved, expectedConfig);
  });

  it("resolves packaged 0.16.9 builtin config on the real machine when installed", () => {
    const cfg = loadConfig();
    const resolved = resolveZcodeBuiltinProviderConfigFile(cfg.zcodeCliPath);
    if (existsSync(cfg.zcodeCliPath)) {
      assert.ok(resolved, "Built-in provider config should resolve on real installation");
      assert.ok(existsSync(resolved!), `Resolved config should exist: ${resolved}`);
      // The real install may expose either the classic packaged sibling layout
      // or a newer v2 runtime endpoint layout; both must end in the config file.
      assert.match(resolved!, /zcode-builtin\.json$/i);
    }
  });

  it("respects explicit override precedence over packaged sibling layout", () => {
    const mockCli = "C:\\MockApp\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs";
    const explicitOverride = "D:\\custom\\config\\provider\\zcode-builtin.json";
    const mockExists = (p: string) =>
      p.toLowerCase() === explicitOverride.toLowerCase() ||
      p.toLowerCase().includes("resources\\config\\provider\\zcode-builtin.json");
    const resolved = resolveZcodeBuiltinProviderConfigFile(
      mockCli,
      { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: explicitOverride },
      mockExists,
    );
    assert.equal(resolved, explicitOverride);
  });

  it("returns null when file is missing (leaves env unset / fails naturally)", () => {
    const mockCli = "C:\\MockApp\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs";
    const mockExists = () => false;
    const resolvedMissing = resolveZcodeBuiltinProviderConfigFile(mockCli, {}, mockExists);
    assert.equal(resolvedMissing, null);

    // Explicit override pointing to missing file also returns null
    const explicitMissing = "D:\\nonexistent\\zcode-builtin.json";
    const resolvedExplicitMissing = resolveZcodeBuiltinProviderConfigFile(
      mockCli,
      { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: explicitMissing },
      mockExists,
    );
    assert.equal(resolvedExplicitMissing, null);

    // Empty or missing CLI path returns null
    assert.equal(resolveZcodeBuiltinProviderConfigFile(null, {}, mockExists), null);
    assert.equal(resolveZcodeBuiltinProviderConfigFile("", {}, mockExists), null);
  });

  it("resolves packaged 0.16.9 layout with path containing spaces", () => {
    const mockCli = "C:\\Program Files\\ZCode App\\resources\\glm\\zcode.cjs";
    const expectedConfig = "C:\\Program Files\\ZCode App\\resources\\config\\provider\\zcode-builtin.json";
    const mockExists = (p: string) => p.toLowerCase() === expectedConfig.toLowerCase();
    const resolved = resolveZcodeBuiltinProviderConfigFile(mockCli, {}, mockExists);
    assert.equal(resolved, expectedConfig);
    assert.ok(resolved?.includes("Program Files"));
    assert.ok(resolved?.includes("ZCode App"));
  });

  it("resolves packaged layout on disk in directory with spaces", () => {
    const dirWithSpaces = mkdtempSync(join(tmpdir(), "z2c test builtin spaces-"));
    try {
      const glmDir = join(dirWithSpaces, "resources", "glm");
      const configDir = join(dirWithSpaces, "resources", "config", "provider");
      mkdirSync(glmDir, { recursive: true });
      mkdirSync(configDir, { recursive: true });
      const cliPath = join(glmDir, "zcode.cjs");
      const configPath = join(configDir, "zcode-builtin.json");
      writeFileSync(cliPath, "console.log('0.16.9');\n", "utf8");
      writeFileSync(configPath, '{"providers":[]}\n', "utf8");

      // The explicit sibling layout must win even when the parent process
      // carries an inherited ZCODE_BUILTIN_PROVIDER_CONFIG_FILE (e.g. a
      // ZCode Desktop developer shell). Save/restore the inherited value.
      const inherited = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
      delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
      try {
        const resolved = resolveZcodeBuiltinProviderConfigFile(cliPath);
        assert.equal(resolved, configPath);
        assert.ok(existsSync(resolved!));
      } finally {
        if (inherited === undefined) delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
        else process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = inherited;
      }
    } finally {
      rmSync(dirWithSpaces, { recursive: true, force: true });
    }
  });
});
