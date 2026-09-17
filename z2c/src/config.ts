import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Machine-local configuration. Contains NO secrets:
 * the Z2C bearer token is generated into the state directory on first run,
 * and ZCode owns its own model credentials (read at app-server spawn time
 * from ZCode's own credential store and passed only via child env).
 */
export interface Z2cConfig {
  zcodeCliPath: string;
  zcodeCredentialStorePath: string;
  zcodeCredentialKey: string;
  runtimeApiKeyEnv: string;
  expectedZcodeVersionPrefix: string;
  stateDir: string;
  host: string;
  port: number;
  maxInstructionChars: number;
  maxOutputChars: number;
  sendTimeoutMs: number;
  queue: { maxQueuedPerWorkspace: number };
  /** Optional user-owned API key for a direct model provider (headless auth path). */
  modelApiKey: string | null;
  modelBaseUrl: string;
  modelId: string;
  /** Execution backend: desktop (Coding-Plan via running Desktop) | headless (explicit API key) | auto. */
  providerMode: "desktop" | "headless" | "auto";
}

const DEFAULT_CLI = resolve(
  homedir(),
  "AppData/Local/Programs/ZCode/resources/glm/zcode.cjs",
);

export function loadConfig(): Z2cConfig {
  const localAppData =
    process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return {
    zcodeCliPath: process.env.Z2C_ZCODE_CLI ?? DEFAULT_CLI,
    zcodeCredentialStorePath:
      process.env.Z2C_ZCODE_CREDENTIALS ?? join(homedir(), ".zcode", "v2", "credentials.json"),
    zcodeCredentialKey: process.env.Z2C_CREDENTIAL_KEY ?? "oauth:zai:access_token",
    runtimeApiKeyEnv: "ZCODE_RUNTIME_API_KEY",
    expectedZcodeVersionPrefix: process.env.Z2C_EXPECTED_VERSION ?? "0.16.",
    stateDir: process.env.Z2C_STATE_DIR ?? join(localAppData, "z2c"),
    host: "127.0.0.1",
    // Z2C-owned fixed loopback port, distinct from the Quanta service (8765).
    port: Number(process.env.Z2C_PORT ?? 8766),
    maxInstructionChars: 20_000,
    maxOutputChars: 16_000,
    sendTimeoutMs: 30_000,
    queue: { maxQueuedPerWorkspace: 20 },
    modelApiKey:
      process.env.Z2C_MODEL_API_KEY ?? readUserEnvFromRegistry("Z2C_MODEL_API_KEY") ?? null,
    modelBaseUrl: process.env.Z2C_MODEL_BASE_URL ?? "https://open.bigmodel.cn/api/anthropic",
    modelId: process.env.Z2C_MODEL_ID ?? "GLM-5.3",
    providerMode: normalizeProviderMode(process.env.Z2C_PROVIDER ?? "auto"),
  };
}

function normalizeProviderMode(v: string): "desktop" | "headless" | "auto" {
  const m = v.trim().toLowerCase();
  if (m === "desktop" || m === "headless" || m === "auto") return m;
  return "auto";
}

/**
 * Windows registry hydration: a User-scope variable set after this process tree
 * started is not visible via process.env, so read it from HKCU\Environment.
 * The value stays in memory only — it is never logged, echoed, or persisted.
 */
export function parseRegQueryOutput(raw: string, name: string): string | null {
  const match = raw.match(new RegExp(`${name}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.*)`, "i"));
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : null;
}

function readUserEnvFromRegistry(name: string): string | null {
  if (process.platform !== "win32") return null;
  try {
    const raw = execFileSync(
      "reg.exe",
      ["query", "HKCU\\Environment", "/v", name],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 },
    );
    return parseRegQueryOutput(raw, name);
  } catch {
    return null;
  }
}

/** Read the model access token from ZCode's own credential store. Never logged, never persisted. */
export function readZcodeRuntimeToken(cfg: Z2cConfig): string {
  const store = JSON.parse(readFileSync(cfg.zcodeCredentialStorePath, "utf8")) as Record<string, string>;
  const token = store[cfg.zcodeCredentialKey];
  if (!token || typeof token !== "string" || token.length < 10) {
    throw new Error(
      `ZCode credential store has no usable entry for "${cfg.zcodeCredentialKey}". ` +
        `Open ZCode Desktop and ensure you are signed in.`,
    );
  }
  return token;
}
