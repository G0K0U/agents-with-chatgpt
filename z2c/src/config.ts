import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Machine-local configuration. Contains NO secrets:
 * the Z2C bearer token is generated into the state directory on first run,
 * and ZCode owns its own model credentials natively (the official standalone
 * app-server resolves them in-process; Z2C never reads, decrypts, or relays
 * ZCode credential material of any kind).
 */
export interface Z2cConfig {
  zcodeCliPath: string;
  expectedZcodeVersionPrefix: string;
  stateDir: string;
  host: string;
  port: number;
  maxInstructionChars: number;
  maxOutputChars: number;
  sendTimeoutMs: number;
  queue: { maxQueuedPerWorkspace: number };
  /**
   * EXPLICITLY user-owned API key for the legacy headless direct-provider
   * lane only. This is NOT ZCode credential material: it never reads or
   * derives from ZCode's credential store, and the official path ignores it.
   */
  modelApiKey: string | null;
  modelBaseUrl: string;
  modelId: string;
  /** Governed native model identity requested for new sessions (fail-closed if unavailable). */
  requestedModelId: string;
  /** Governed native thought level requested for new sessions (fail-closed if unsupported). */
  requestedThoughtLevel: string;
  /**
   * Optional explicit provider constraint. Null = ZCode resolves the native
   * provider and Z2C attests the observed identity. Set = enforced exactly
   * (fail-closed if the runtime cannot offer it). Never defaulted to a
   * historical provider id.
   */
  requestedProviderId: string | null;
  /**
   * Execution backend. Default and production path: "official" (open-source
   * standalone app-server, native auth). Legacy lanes are EXPLICIT opt-in
   * only — a failed official initialization never silently downgrades.
   */
  providerMode: "official" | "desktop-legacy" | "headless";
}

export function localAppData(env: NodeJS.ProcessEnv = process.env): string {
  return env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
}

export function isJsScript(filePath: string): boolean {
  return /\.[c|m]?js$/i.test(filePath);
}

export function resolveCliSpawn(
  cliPath: string,
  extraArgs: string[] = [],
  nodePath: string = process.execPath,
): { command: string; args: string[] } {
  if (isJsScript(cliPath)) {
    return { command: nodePath, args: [cliPath, ...extraArgs] };
  }
  return { command: cliPath, args: extraArgs };
}

/**
 * Supported relative layouts inside a ZCode installation root.
 * Current 0.16.9 layout: resources/glm/zcode.cjs.
 * Older / legacy layouts preserved for backward compatibility.
 */
export const ZCODE_CLI_RELATIVE_LAYOUTS = [
  join("resources", "glm", "zcode.cjs"),
  join("resources", "app.asar.unpacked", "apps", "zcode-cli", "packages", "cli", "dist", "zcode.cjs"),
  join("resources", "app", "apps", "zcode-cli", "packages", "cli", "dist", "zcode.cjs"),
  join("resources", "app", "zcode.cjs"),
  join("resources", "zcode.cjs"),
  join("resources", "glm", "zcode.js"),
  join("bin", "zcode.cmd"),
  join("bin", "zcode.exe"),
  join("bin", "zcode"),
];

export function resolveZcodeCliPath(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (p: string) => boolean = existsSync,
): string {
  if (env.Z2C_ZCODE_CLI?.trim()) {
    return resolve(env.Z2C_ZCODE_CLI.trim());
  }

  const appData = localAppData(env);
  const home = homedir();
  const userProfile = env.USERPROFILE;

  const candidateRoots: string[] = [];

  if (process.platform === "win32") {
    // 1. Per-user installation roots
    candidateRoots.push(join(appData, "Programs", "ZCode"));
    if (userProfile && userProfile !== home) {
      candidateRoots.push(join(userProfile, "AppData", "Local", "Programs", "ZCode"));
    }
    candidateRoots.push(join(home, "AppData", "Local", "Programs", "ZCode"));

    // 2. Machine-wide installation roots
    if (env.ProgramFiles) {
      candidateRoots.push(join(env.ProgramFiles, "ZCode"));
    }
    candidateRoots.push("C:\\Program Files\\ZCode");
    if (env["ProgramFiles(x86)"]) {
      candidateRoots.push(join(env["ProgramFiles(x86)"], "ZCode"));
    }
    candidateRoots.push("C:\\Program Files (x86)\\ZCode");
  } else if (process.platform === "darwin") {
    candidateRoots.push(join(home, "Applications", "ZCode.app", "Contents"));
    candidateRoots.push("/Applications/ZCode.app/Contents");
  } else {
    candidateRoots.push(join(home, ".local", "share", "ZCode"));
    candidateRoots.push("/opt/ZCode");
    candidateRoots.push("/usr/share/zcode");
    candidateRoots.push("/usr/lib/zcode");
  }

  if (env.ZCODE_HOME) {
    candidateRoots.unshift(resolve(env.ZCODE_HOME));
  }

  const seen = new Set<string>();
  const uniqueRoots: string[] = [];
  for (const r of candidateRoots) {
    if (r && !seen.has(r)) {
      seen.add(r);
      uniqueRoots.push(r);
    }
  }

  for (const root of uniqueRoots) {
    for (const rel of ZCODE_CLI_RELATIVE_LAYOUTS) {
      const candidate = join(root, rel);
      if (fileExists(candidate)) {
        return candidate;
      }
    }
  }

  return join(appData, "Programs", "ZCode", "resources", "glm", "zcode.cjs");
}

/**
 * Resolves the path to the bundled ZCode built-in provider configuration file.
 *
 * In ZCode 0.16.9+, `zcode app-server --stdio` requires `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`
 * to locate its built-in provider configuration.
 *
 * If an explicit override is supplied via `env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` and exists,
 * that override is returned.
 * Otherwise, walks from `zcodeCliPath` (e.g. `resources/glm/zcode.cjs`) to the packaged
 * sibling layout `resources/config/provider/zcode-builtin.json`.
 * Returns null if not found (fails closed/naturally; no hardcoded paths).
 */
export function resolveZcodeBuiltinProviderConfigFile(
  zcodeCliPath?: string | null,
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (p: string) => boolean = existsSync,
): string | null {
  const explicit = env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim();
  if (explicit) {
    const candidate = resolve(explicit);
    return fileExists(candidate) ? candidate : null;
  }

  const cli = zcodeCliPath?.trim();
  if (!cli) {
    return null;
  }

  const cliDir = dirname(resolve(cli));
  // Packaged 0.16.9 sibling layout: resources/glm/zcode.cjs -> resources/config/provider/zcode-builtin.json
  const candidate = resolve(cliDir, "..", "config", "provider", "zcode-builtin.json");
  if (fileExists(candidate)) {
    return candidate;
  }

  // Fallback for direct resources layout (e.g. resources/zcode.cjs -> resources/config/provider/zcode-builtin.json)
  const altCandidate = resolve(cliDir, "config", "provider", "zcode-builtin.json");
  if (fileExists(altCandidate)) {
    return altCandidate;
  }

  return null;
}

export function loadConfig(): Z2cConfig {
  return {
    zcodeCliPath: resolveZcodeCliPath(),
    expectedZcodeVersionPrefix: process.env.Z2C_EXPECTED_VERSION ?? "0.16.",
    stateDir: process.env.Z2C_STATE_DIR ?? join(localAppData(), "z2c"),
    host: "127.0.0.1",
    // Z2C-owned fixed loopback port, distinct from the Quanta service (8765).
    port: Number(process.env.Z2C_PORT ?? 8766),
    maxInstructionChars: 20_000,
    maxOutputChars: 16_000,
    sendTimeoutMs: 30_000,
    queue: { maxQueuedPerWorkspace: 20 },
    modelApiKey: process.env.Z2C_MODEL_API_KEY ?? readUserEnvFromRegistry("Z2C_MODEL_API_KEY") ?? null,
    modelBaseUrl: process.env.Z2C_MODEL_BASE_URL ?? "https://open.bigmodel.cn/api/anthropic",
    modelId: process.env.Z2C_MODEL_ID ?? "GLM-5.3",
    requestedModelId: process.env.Z2C_REQUESTED_MODEL ?? "GLM-5.3-Flash",
    requestedThoughtLevel: process.env.Z2C_REQUESTED_THOUGHT_LEVEL ?? "max",
    requestedProviderId: process.env.Z2C_REQUESTED_PROVIDER?.trim() || null,
    providerMode: normalizeProviderMode(process.env.Z2C_PROVIDER ?? "official"),
  };
}

/**
 * Legacy lanes are explicit opt-in. "desktop" remains accepted as an alias of
 * "desktop-legacy" for existing deployments; anything unrecognized resolves
 * to the official path (never to a legacy fallback).
 */
function normalizeProviderMode(v: string): "official" | "desktop-legacy" | "headless" {
  const m = v.trim().toLowerCase();
  if (m === "desktop-legacy" || m === "desktop") return "desktop-legacy";
  if (m === "headless") return "headless";
  return "official";
}

/**
 * Windows registry hydration: a User-scope variable set after this process tree
 * started is not visible via process.env, so read it from HKCU\Environment.
 * The value stays in memory only — it is never logged, echoed, or persisted.
 * (Used solely for the EXPLICITLY user-owned Z2C_MODEL_API_KEY legacy lane.)
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
