import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";

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
  /**
   * Bounded settle budget (ms) for a transient -32010 on the governed lane:
   * the runtime's own status must report idle within this window or the task
   * fails closed with SESSION_BUSY. Default 30s.
   */
  busySettleMs?: number;
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
  /**
   * EXPLICIT opt-in for the official app-server child's standalone account
   * resolution (ZCODE_PROTOCOL_STANDALONE_ACCOUNT_RUNTIME=1). When enabled,
   * the child resolves billing entitlements from ZCode's OWN shared
   * credential store in-process — Z2C still never reads, decrypts, or relays
   * credential material. Default false keeps the desktop-host contract:
   * fail-closed account overlay, no START/INDIVIDUAL providers admitted.
   */
  standaloneAccountRuntime: boolean;
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

// ── sanitized provider-config source diagnostic (startup audit evidence) ───

export type BuiltinProviderConfigSource = "explicit-env" | "cli-sibling" | "unset";

export type BuiltinProviderConfigStatus =
  | "ok"
  | "missing"
  | "invalidJSON"
  | "readFailure"
  | "protectedPathUnread"
  | "oversized"
  | "runtimeFallbackUnobserved"
  | "diagnosticError";

/** Read ceiling for the provider config; a legit builtin config is far smaller. */
export const ZCODE_BUILTIN_CONFIG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Sanitized diagnostic of the ZCODE_BUILTIN_PROVIDER_CONFIG_FILE the spawned
 * child ACTUALLY receives. Evidence only: the resolved config path (itself
 * non-sensitive), a content digest, and access-mode declaration counts —
 * never file contents and never any other environment value. The counts are
 * `null` when no file was observed, and the literal `"unknown"` when a file
 * was observed but does not match the known schema (never a fake 0).
 */
export interface BuiltinProviderConfigDiagnostic {
  source: BuiltinProviderConfigSource;
  resolvedPath: string | null;
  sha256: string | null;
  startPlanDeclarations: number | "unknown" | null;
  individualPlanDeclarations: number | "unknown" | null;
  status: BuiltinProviderConfigStatus;
}

/** Basenames that are never legitimate provider-config locations. */
const PROTECTED_BASENAMES = new Set([
  ".env",
  "security.json",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
]);

/**
 * Account-material guard: a path that looks like ZCode account/credential/
 * secret storage is never opened for this diagnostic, whatever the env claims.
 * Lexical only — callers must ALSO refuse when the REAL path (after symlink /
 * junction / reparse resolution) is protected, and when the file itself is a
 * link alias.
 */
export function isProtectedAccountPath(path: string): boolean {
  const segments = path.toLowerCase().split(/[\\/]/);
  if (segments.includes(".zcode")) return true;
  const base = segments[segments.length - 1] ?? "";
  const stem = base.replace(/\.[a-z0-9]+$/i, "");
  if (/auth|credential|token|secret|cookie|account/.test(stem)) return true;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (PROTECTED_BASENAMES.has(base)) return true;
  return /\.(pem|key|pfx|p12)$/.test(base);
}

interface PlanDeclarationCounts {
  startPlanDeclarations: number | "unknown";
  individualPlanDeclarations: number | "unknown";
}

const UNKNOWN_COUNTS: PlanDeclarationCounts = {
  startPlanDeclarations: "unknown",
  individualPlanDeclarations: "unknown",
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Counts plan declarations ONLY where the runtime itself models them: a rule
 * in the known `config.providerConfigRules` schema (providerRules /
 * templateRules) whose access block is exactly
 * `{ type: "zhipu-account", mode: <plan> }`. Free-text carriers — provider
 * names, template names, descriptions, URLs, unrelated fields — are never
 * counted. Any shape that is not the known schema reports "unknown" instead
 * of a possibly-wrong 0.
 */
export function countPlanDeclarations(parsed: unknown): PlanDeclarationCounts {
  if (!isPlainObject(parsed) || !isPlainObject(parsed.config) || !isPlainObject(parsed.config.providerConfigRules)) {
    return UNKNOWN_COUNTS;
  }
  const containers = parsed.config.providerConfigRules;
  let startPlan = 0;
  let individualPlan = 0;
  for (const key of ["providerRules", "templateRules"] as const) {
    const container = containers[key];
    if (container === undefined) continue;
    if (!Array.isArray(container)) return UNKNOWN_COUNTS;
    for (const rule of container) {
      const access = isPlainObject(rule) && isPlainObject(rule.config) ? rule.config.access : undefined;
      if (!isPlainObject(access) || access.type !== "zhipu-account") continue;
      if (access.mode === "start-plan") startPlan += 1;
      else if (access.mode === "individual-coding-plan") individualPlan += 1;
    }
  }
  return { startPlanDeclarations: startPlan, individualPlanDeclarations: individualPlan };
}

/**
 * Injectable filesystem surface (metadata only, plus the final content read).
 * Every failure is reported as a status — the diagnostic never throws, so the
 * startup audit path can never break service startup.
 */
export interface ProviderConfigDiagnosticIo {
  fileExists?: (p: string) => boolean;
  readFile?: (p: string) => string;
  /** Metadata WITHOUT following links (symlink/reparse flag + size). */
  lstat?: (p: string) => { isSymbolicLink: boolean; size: number };
  /** Fully resolved real path (all symlink/junction/reparse points resolved). */
  realpath?: (p: string) => string;
}

function isMissing(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

function sameRealPath(a: string, b: string): boolean {
  // Case-insensitive on purpose (Windows realpath casing differs); a short-name
  // (8.3) or casing-alias mismatch must fail closed, not pass.
  return a.replace(/[\\/]+/g, "/").toLowerCase() === b.replace(/[\\/]+/g, "/").toLowerCase();
}

/**
 * Build the diagnostic from the env ACTUALLY handed to the child:
 *  - `rawEnvValue`: ZCODE_BUILTIN_PROVIDER_CONFIG_FILE before the spawn-env
 *    fallback ran (trimmed non-empty ⇒ "explicit-env");
 *  - `spawnEnvValue`: the value in the child env (fallback-filled ⇒
 *    "cli-sibling");
 *  - neither ⇒ "unset" + runtimeFallbackUnobserved. Candidate files are NEVER
 *    inspected on that path — an unobserved fallback is not an observed load.
 *
 * Before any content read the path must survive, in order: the protected-name
 * guard (lexical), existence, a link/reparse check on the file itself, the
 * size ceiling, and a real-path check that refuses both link aliases and
 * protected real locations. Failure states (missing / invalidJSON /
 * readFailure / protectedPathUnread / oversized / diagnosticError) carry NO
 * file content. I/O is injectable for deterministic tests.
 */
export function builtinProviderConfigDiagnostic(
  rawEnvValue: string | undefined,
  spawnEnvValue: string | undefined,
  io: ProviderConfigDiagnosticIo = {},
): BuiltinProviderConfigDiagnostic {
  const fileExists = io.fileExists ?? existsSync;
  const readFile = io.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const lstat =
    io.lstat ??
    ((p: string) => {
      const s = lstatSync(p);
      return { isSymbolicLink: s.isSymbolicLink(), size: s.size };
    });

  const realpath = io.realpath ?? ((p: string) => realpathSync(p));
  const explicit = rawEnvValue?.trim();
  let source: BuiltinProviderConfigSource;
  let configPath: string;
  if (explicit) {
    source = "explicit-env";
    configPath = resolve(explicit);
  } else if (spawnEnvValue?.trim()) {
    source = "cli-sibling";
    configPath = resolve(spawnEnvValue.trim());
  } else {
    return {
      source: "unset",
      resolvedPath: null,
      sha256: null,
      startPlanDeclarations: null,
      individualPlanDeclarations: null,
      status: "runtimeFallbackUnobserved",
    };
  }
  const evidence = {
    source,
    resolvedPath: configPath,
    sha256: null as string | null,
    startPlanDeclarations: null as number | "unknown" | null,
    individualPlanDeclarations: null as number | "unknown" | null,
  };
  try {
    // Guard order: a protected name is never even stat'ed, an alias is never
    // followed to its content, and an oversized file is never read.
    if (isProtectedAccountPath(configPath)) return { ...evidence, status: "protectedPathUnread" };
    if (!fileExists(configPath)) return { ...evidence, status: "missing" };
    let meta: { isSymbolicLink: boolean; size: number };
    try {
      meta = lstat(configPath);
    } catch (err) {
      return { ...evidence, status: isMissing(err) ? "missing" : "readFailure" };
    }
    if (meta.isSymbolicLink) return { ...evidence, status: "protectedPathUnread" };
    if (meta.size > ZCODE_BUILTIN_CONFIG_MAX_BYTES) return { ...evidence, status: "oversized" };
    let realPath: string;
    try {
      realPath = realpath(configPath);
    } catch {
      return { ...evidence, status: "readFailure" };
    }
    if (!sameRealPath(realPath, configPath)) {
      // Reached through a symlink / junction / reparse point: refuse the alias.
      return { ...evidence, status: "protectedPathUnread" };
    }
    if (isProtectedAccountPath(realPath)) {
      // The REAL location is account/credential storage.
      return { ...evidence, status: "protectedPathUnread" };
    }
    let raw: string;
    try {
      raw = readFile(configPath);
    } catch {
      return { ...evidence, status: "readFailure" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ...evidence, status: "invalidJSON" };
    }
    const counts = countPlanDeclarations(parsed);
    return {
      ...evidence,
      status: "ok",
      sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
      startPlanDeclarations: counts.startPlanDeclarations,
      individualPlanDeclarations: counts.individualPlanDeclarations,
    };
  } catch {
    // Belt-and-braces: startup audit evidence must never break service
    // startup; an unexpected failure is itself the reported status.
    return { ...evidence, status: "diagnosticError" };
  }
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
    requestedModelId: process.env.Z2C_REQUESTED_MODEL ?? "GLM-5.3",
    requestedThoughtLevel: process.env.Z2C_REQUESTED_THOUGHT_LEVEL ?? "max",
    requestedProviderId: process.env.Z2C_REQUESTED_PROVIDER?.trim() || null,
    providerMode: normalizeProviderMode(process.env.Z2C_PROVIDER ?? "official"),
    standaloneAccountRuntime: normalizeStandaloneAccountRuntime(
      process.env.Z2C_STANDALONE_ACCOUNT_RUNTIME,
    ),
  };
}

/** Fail-closed: only "1"/"true" enables standalone account resolution. */
function normalizeStandaloneAccountRuntime(v: string | undefined): boolean {
  const raw = v?.trim().toLowerCase();
  return raw === "1" || raw === "true";
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
