import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  builtinProviderConfigDiagnostic,
  countPlanDeclarations,
  isProtectedAccountPath,
  ZCODE_BUILTIN_CONFIG_MAX_BYTES,
} from "../src/config.js";
import { FileAuditLog } from "../src/util/log.js";

/** Deterministic fixture config: contains a sensitive field on purpose. */
const SECRET = "SK-SUPER-SECRET-VALUE-123";

/**
 * Known-schema fixture (zcode-builtin.json layout): exactly ONE start-plan and
 * TWO individual-coding-plan declarations, surrounded by decoys that must
 * never count — plan tokens in provider/template names, descriptions, URLs,
 * groups, model-rule properties, and a rule whose access.mode matches but
 * whose access.type is not zhipu-account.
 */
const KNOWN_SCHEMA_CONFIG = JSON.stringify(
  {
    schemaVersion: 1,
    revision: 7,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "account:zai-start-plan",
            providerName: "start-plan showcase (free text, not a declaration)",
            config: {
              group: "start-plan group (free text, not a declaration)",
              access: { type: "zhipu-account", mode: "start-plan", accountType: "team" },
              apiKey: SECRET,
            },
          },
          {
            providerId: "account:zai-individual-coding-plan",
            config: { access: { type: "zhipu-account", mode: "individual-coding-plan" } },
          },
          {
            providerId: "account:bigmodel-individual-coding-plan",
            config: { access: { type: "zhipu-account", mode: "individual-coding-plan" } },
          },
          {
            // Exact mode match but access.type is not zhipu-account: NOT a
            // declaration.
            providerId: "account:api-key-rule-with-plan-shaped-mode",
            config: { access: { type: "api-key", mode: "start-plan" } },
          },
        ],
        templateRules: [
          {
            templateId: "decoy-template",
            templateNameMap: {
              "zh-CN": "start-plan 模板介绍（自由文本，非声明）",
              "en-US": "description mentions individual-coding-plan",
            },
            config: { access: { type: "api-key", apiKeyManagementUrl: "https://example.com/start-plan-docs" } },
          },
        ],
      },
      modelConfigRules: {
        modelRules: [{ modelMatch: ".*", config: { properties: { note: "start-plan" } } }],
      },
    },
  },
  null,
  2,
);
const KNOWN_SCHEMA_SHA = createHash("sha256").update(KNOWN_SCHEMA_CONFIG, "utf8").digest("hex");

/** Known schema in shape, but every plan token lives in free text / wrong type. */
const FAKE_DECLARATIONS_ONLY = JSON.stringify({
  config: {
    providerConfigRules: {
      providerRules: [
        { providerId: "p1", config: { access: { type: "api-key", mode: "start-plan" } } },
        {
          providerId: "p2",
          providerName: "the individual-coding-plan provider",
          config: { access: { type: "zhipu-account", mode: "api-key" } },
        },
      ],
      templateRules: [
        {
          templateId: "t1",
          templateNameMap: { "en-US": "start-plan and individual-coding-plan promo" },
          config: { access: { type: "api-key", apiKeyManagementUrl: "https://x/start-plan" } },
        },
      ],
    },
  },
});

function makeFixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "z2c-cfgdiag-"));
}

describe("builtin provider config diagnostic", () => {
  it("reports explicit-env source with digest and exact-schema declaration counts", () => {
    const dir = makeFixtureDir();
    try {
      const cfgPath = join(dir, "zcode-builtin.json");
      writeFileSync(cfgPath, KNOWN_SCHEMA_CONFIG);
      const d = builtinProviderConfigDiagnostic(cfgPath, cfgPath);
      assert.equal(d.source, "explicit-env");
      assert.equal(d.resolvedPath, cfgPath);
      assert.equal(d.status, "ok");
      assert.equal(d.sha256, KNOWN_SCHEMA_SHA);
      assert.equal(d.startPlanDeclarations, 1);
      assert.equal(d.individualPlanDeclarations, 2);
      // The diagnostic never carries configuration values.
      assert.ok(!JSON.stringify(d).includes(SECRET));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports cli-sibling source when only the spawn-env fallback filled the value", () => {
    const dir = makeFixtureDir();
    try {
      const cfgPath = join(dir, "zcode-builtin.json");
      writeFileSync(cfgPath, KNOWN_SCHEMA_CONFIG);
      const d = builtinProviderConfigDiagnostic(undefined, cfgPath);
      assert.equal(d.source, "cli-sibling");
      assert.equal(d.resolvedPath, cfgPath);
      assert.equal(d.status, "ok");
      assert.equal(d.sha256, KNOWN_SCHEMA_SHA);
      assert.equal(d.startPlanDeclarations, 1);
      assert.equal(d.individualPlanDeclarations, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports unset + runtimeFallbackUnobserved without inspecting candidates", () => {
    const probed: string[] = [];
    const d = builtinProviderConfigDiagnostic(undefined, undefined, {
      fileExists: (p) => {
        probed.push(p);
        return true;
      },
      readFile: () => {
        throw new Error("must not read candidate files when unset");
      },
    });
    assert.equal(d.source, "unset");
    assert.equal(d.status, "runtimeFallbackUnobserved");
    assert.equal(d.resolvedPath, null);
    assert.equal(d.sha256, null);
    assert.equal(d.startPlanDeclarations, null);
    assert.equal(d.individualPlanDeclarations, null);
    assert.deepEqual(probed, []);
    // Blank/whitespace env values are treated as unset as well.
    const blank = builtinProviderConfigDiagnostic("   ", "  ");
    assert.equal(blank.source, "unset");
    assert.equal(blank.status, "runtimeFallbackUnobserved");
  });

  it("reports missing, invalidJSON, and readFailure without file contents", () => {
    const dir = makeFixtureDir();
    try {
      const missingPath = join(dir, "absent-zcode-builtin.json");
      const missing = builtinProviderConfigDiagnostic(missingPath, missingPath);
      assert.equal(missing.source, "explicit-env");
      assert.equal(missing.status, "missing");
      assert.equal(missing.sha256, null);

      const siblingMissing = builtinProviderConfigDiagnostic(undefined, missingPath);
      assert.equal(siblingMissing.source, "cli-sibling");
      assert.equal(siblingMissing.status, "missing");

      const badPath = join(dir, "zcode-builtin.json");
      writeFileSync(badPath, "{not-json{{");
      const bad = builtinProviderConfigDiagnostic(badPath, badPath);
      assert.equal(bad.status, "invalidJSON");
      assert.equal(bad.sha256, null);
      assert.equal(bad.startPlanDeclarations, null);
      assert.ok(!JSON.stringify(bad).includes("not-json"));

      const existingPath = join(dir, "zcode-builtin.json");
      writeFileSync(existingPath, KNOWN_SCHEMA_CONFIG);
      const failed = builtinProviderConfigDiagnostic(undefined, existingPath, {
        readFile: () => {
          throw new Error("EACCES simulated");
        },
      });
      assert.equal(failed.source, "cli-sibling");
      assert.equal(failed.status, "readFailure");
      assert.equal(failed.sha256, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never opens a protected account path for the diagnostic", () => {
    const dir = makeFixtureDir();
    try {
      for (const name of ["auth.json", ".env", "security.json", ".npmrc", "id_rsa.key", "token-store.json"]) {
        const p = join(dir, name);
        writeFileSync(p, '{"secret":"' + SECRET + '"}');
        let reads = 0;
        const d = builtinProviderConfigDiagnostic(p, p, {
          readFile: () => {
            reads += 1;
            return "{}";
          },
        });
        assert.equal(d.status, "protectedPathUnread", name);
        assert.equal(d.sha256, null, name);
        assert.equal(reads, 0, name);
      }
      const authPath = join(dir, "auth.json");
      assert.ok(isProtectedAccountPath(join(dir, ".zcode", "anything.json")));
      assert.ok(isProtectedAccountPath(join(dir, ".env.local")));
      assert.ok(!isProtectedAccountPath(join(dir, "config", "provider", "zcode-builtin.json")));
      assert.ok(!isProtectedAccountPath(authPath.replace("auth", "provider")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("audit log records the startup event but never the sensitive config values", () => {
    const dir = makeFixtureDir();
    try {
      const cfgPath = join(dir, "zcode-builtin.json");
      writeFileSync(cfgPath, KNOWN_SCHEMA_CONFIG);
      const stateDir = join(dir, "audit");
      const audit = new FileAuditLog(stateDir);
      const d = builtinProviderConfigDiagnostic(cfgPath, cfgPath);
      audit.record("info", "provider.configSource", { ...d });
      const logged = readFileSync(join(stateDir, "audit.log"), "utf8");
      assert.ok(logged.includes("provider.configSource"));
      assert.ok(logged.includes("explicit-env"));
      // Paths appear JSON-escaped in the log line (backslashes doubled).
      assert.ok(logged.includes(JSON.stringify(cfgPath).slice(1, -1)));
      assert.ok(logged.includes("startPlanDeclarations"));
      // Sensitive values from the config file never reach the audit log.
      assert.ok(!logged.includes(SECRET));
      assert.ok(!logged.includes(KNOWN_SCHEMA_CONFIG));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("plan declaration counting (schema-strict)", () => {
  it("never counts fake declaration strings in free-text fields", () => {
    const parsed = JSON.parse(FAKE_DECLARATIONS_ONLY);
    const counts = countPlanDeclarations(parsed);
    assert.equal(counts.startPlanDeclarations, 0);
    assert.equal(counts.individualPlanDeclarations, 0);

    const dir = makeFixtureDir();
    try {
      const cfgPath = join(dir, "zcode-builtin.json");
      writeFileSync(cfgPath, FAKE_DECLARATIONS_ONLY);
      const d = builtinProviderConfigDiagnostic(cfgPath, cfgPath);
      assert.equal(d.status, "ok");
      assert.equal(d.startPlanDeclarations, 0);
      assert.equal(d.individualPlanDeclarations, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records unknown for nested shapes that are not the known schema", () => {
    // Arbitrary legacy/unrelated shapes must never produce a fake 0.
    for (const shape of [
      { providers: [{ id: "x", accessMode: "start-plan" }] },
      { config: { providerConfigRules: { providerRules: "not-an-array" } } },
      { config: { providerConfigRules: { providerRules: [], templateRules: 42 } } },
      { config: "no-rules-here" },
      ["array", "root"],
      null,
    ]) {
      const counts = countPlanDeclarations(shape);
      assert.equal(counts.startPlanDeclarations, "unknown", JSON.stringify(shape));
      assert.equal(counts.individualPlanDeclarations, "unknown", JSON.stringify(shape));
    }

    const dir = makeFixtureDir();
    try {
      const cfgPath = join(dir, "zcode-builtin.json");
      const legacy = JSON.stringify({ providers: [{ id: "x", accessMode: "start-plan" }] });
      writeFileSync(cfgPath, legacy);
      const d = builtinProviderConfigDiagnostic(cfgPath, cfgPath);
      assert.equal(d.status, "ok");
      assert.equal(d.sha256, createHash("sha256").update(legacy, "utf8").digest("hex"));
      assert.equal(d.startPlanDeclarations, "unknown");
      assert.equal(d.individualPlanDeclarations, "unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts a known empty schema as zero, and counts declarations in templateRules too", () => {
    assert.deepEqual(countPlanDeclarations({ config: { providerConfigRules: {} } }), {
      startPlanDeclarations: 0,
      individualPlanDeclarations: 0,
    });
    const withTemplate = countPlanDeclarations({
      config: {
        providerConfigRules: {
          templateRules: [{ templateId: "t", config: { access: { type: "zhipu-account", mode: "start-plan" } } }],
        },
      },
    });
    assert.equal(withTemplate.startPlanDeclarations, 1);
    assert.equal(withTemplate.individualPlanDeclarations, 0);
  });
});

describe("path safety guards", () => {
  it("refuses a symlinked file before reading it", () => {
    const dir = makeFixtureDir();
    try {
      const cfgPath = join(dir, "zcode-builtin.json");
      writeFileSync(cfgPath, KNOWN_SCHEMA_CONFIG);
      let reads = 0;
      const d = builtinProviderConfigDiagnostic(cfgPath, cfgPath, {
        lstat: () => ({ isSymbolicLink: true, size: KNOWN_SCHEMA_CONFIG.length }),
        readFile: () => {
          reads += 1;
          return KNOWN_SCHEMA_CONFIG;
        },
      });
      assert.equal(d.status, "protectedPathUnread");
      assert.equal(d.sha256, null);
      assert.equal(reads, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an alias whose real path is protected, and any link traversal", () => {
    const dir = makeFixtureDir();
    try {
      const cfgPath = join(dir, "zcode-builtin.json");
      writeFileSync(cfgPath, KNOWN_SCHEMA_CONFIG);
      let reads = 0;
      const readFile = () => {
        reads += 1;
        return KNOWN_SCHEMA_CONFIG;
      };
      // Alias resolves INTO account storage.
      const intoProtected = builtinProviderConfigDiagnostic(cfgPath, cfgPath, {
        realpath: () => join(dir, ".zcode", "auth.json"),
        readFile,
      });
      assert.equal(intoProtected.status, "protectedPathUnread");
      // Alias resolves to an unprotected location: still refused (link escape).
      const elsewhere = builtinProviderConfigDiagnostic(cfgPath, cfgPath, {
        realpath: () => join(dir, "elsewhere", "zcode-builtin.json"),
        readFile,
      });
      assert.equal(elsewhere.status, "protectedPathUnread");
      assert.equal(reads, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a real junction/symlink directory alias pointing into a protected location", () => {
    const dir = makeFixtureDir();
    try {
      const protectedDir = join(dir, ".zcode");
      mkdirSync(protectedDir, { recursive: true });
      writeFileSync(join(protectedDir, "zcode-builtin.json"), KNOWN_SCHEMA_CONFIG);
      const aliasRoot = join(dir, "alias-root");
      try {
        symlinkSync(protectedDir, aliasRoot, process.platform === "win32" ? "junction" : "dir");
      } catch {
        return; // link creation unsupported here; injected tests prove the guard
      }
      let reads = 0;
      const d = builtinProviderConfigDiagnostic(undefined, join(aliasRoot, "zcode-builtin.json"), {
        readFile: () => {
          reads += 1;
          return KNOWN_SCHEMA_CONFIG;
        },
      });
      assert.equal(d.status, "protectedPathUnread");
      assert.equal(d.sha256, null);
      assert.equal(reads, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects files over the size ceiling before reading", () => {
    const dir = makeFixtureDir();
    try {
      const cfgPath = join(dir, "zcode-builtin.json");
      writeFileSync(cfgPath, KNOWN_SCHEMA_CONFIG);
      let reads = 0;
      const readFile = () => {
        reads += 1;
        return KNOWN_SCHEMA_CONFIG;
      };
      const oversized = builtinProviderConfigDiagnostic(cfgPath, cfgPath, {
        lstat: () => ({ isSymbolicLink: false, size: ZCODE_BUILTIN_CONFIG_MAX_BYTES + 1 }),
        readFile,
      });
      assert.equal(oversized.status, "oversized");
      assert.equal(oversized.sha256, null);
      assert.equal(oversized.startPlanDeclarations, null);
      assert.equal(reads, 0);

      // At exactly the ceiling the file is still read.
      const atLimit = builtinProviderConfigDiagnostic(cfgPath, cfgPath, {
        lstat: () => ({ isSymbolicLink: false, size: ZCODE_BUILTIN_CONFIG_MAX_BYTES }),
        readFile,
      });
      assert.equal(atLimit.status, "ok");

      // End-to-end: a real over-ceiling file is refused before parse.
      writeFileSync(cfgPath, Buffer.alloc(ZCODE_BUILTIN_CONFIG_MAX_BYTES + 1, 0x20));
      const real = builtinProviderConfigDiagnostic(cfgPath, cfgPath);
      assert.equal(real.status, "oversized");
      assert.equal(real.sha256, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports I/O anomalies as statuses and never throws into service startup", () => {
    const dir = makeFixtureDir();
    try {
      const cfgPath = join(dir, "zcode-builtin.json");
      writeFileSync(cfgPath, KNOWN_SCHEMA_CONFIG);
      const EACCES = Object.assign(new Error("EACCES simulated"), { code: "EACCES" });
      const ENOENT = Object.assign(new Error("ENOENT simulated"), { code: "ENOENT" });

      const lstatFailure = builtinProviderConfigDiagnostic(cfgPath, cfgPath, {
        lstat: () => {
          throw EACCES;
        },
      });
      assert.equal(lstatFailure.status, "readFailure");

      const lstatRace = builtinProviderConfigDiagnostic(cfgPath, cfgPath, {
        lstat: () => {
          throw ENOENT;
        },
      });
      assert.equal(lstatRace.status, "missing");

      const realpathFailure = builtinProviderConfigDiagnostic(cfgPath, cfgPath, {
        realpath: () => {
          throw EACCES;
        },
      });
      assert.equal(realpathFailure.status, "readFailure");

      // Any unexpected failure anywhere becomes a status, never an exception.
      const anyFailure = builtinProviderConfigDiagnostic(cfgPath, cfgPath, {
        fileExists: () => {
          throw new Error("boom");
        },
      });
      assert.equal(anyFailure.status, "diagnosticError");
      assert.equal(anyFailure.source, "explicit-env");
      assert.equal(anyFailure.sha256, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
