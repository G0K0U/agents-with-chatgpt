import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { ensureDir, getStateDir } from "../config/paths.js";
import {
  type BackendExecutionRequest,
  type BackendExecutionResult,
  type ExecutionBackend,
} from "./backend.js";

/**
 * AntigravityBackend operates with isolated HOME and workspace enforcement.
 *
 * Security controls:
 * - agy.exe runs under the logged-in Windows user's privileges with isolated HOME.
 * - Native Antigravity file tools are restricted to authorized workspace roots (allowNonWorkspaceAccess: false).
 * - Scoped execution uses Windows AppContainer (--sandbox); explicitly authorized full-access tasks use the host shell.
 * - Outbound network access via tools is blocked pre-execution when network=false.
 * - Deterministic C2C recursion protection via empty mcpServers configuration.
 */
export const ANTIGRAVITY_SECURITY_MODE = "TRUSTED_HOST" as const;

export type AntigravityFailureReason =
  | "SANDBOX_SETUP_REQUIRED"
  | "APPROVAL_REQUIRED"
  | "INVALID_ARGUMENTS"
  | "WORKSPACE_UNAVAILABLE"
  | "AUTH_ERROR"
  | "MODEL_UNAVAILABLE"
  | "SESSION_START_FAILED"
  | "PROTOCOL_ERROR"
  | "SPAWN_FAILED"
  | "CLI_EXIT_UNCLASSIFIED";

/** Only fixed labels cross the backend boundary; never serialize CLI diagnostics. */
export function projectAntigravityFailure(diagnostic: string): AntigravityFailureReason {
  const bounded = diagnostic.slice(-8192);
  if (/administrator privileges are required to set up sandboxing|one-time admin escalation/i.test(bounded)) return "SANDBOX_SETUP_REQUIRED";
  if (/waiting for user approval|requires? (?:user )?approval|confirmation required/i.test(bounded)) return "APPROVAL_REQUIRED";
  if (/flags provided but not defined|unknown flag|unknown option|invalid argument|requires an argument/i.test(bounded)) return "INVALID_ARGUMENTS";
  if (/workspace.*(?:does not exist|not accessible)|cwd.*(?:ENOENT|not found)|failed to open workspace/i.test(bounded)) return "WORKSPACE_UNAVAILABLE";
  if (/(?:not logged in|authentication failed|oauth.*failed|login required|please run.*(?:login|auth)|invalid credentials|unauthenticated|token has been revoked|unauthorized)/i.test(bounded)) return "AUTH_ERROR";
  if (/(?:model.*(?:not found|unavailable|unsupported|does not exist|not accessible)|unknown model|invalid model)/i.test(bounded)) return "MODEL_UNAVAILABLE";
  if (/(?:conversation.*(?:not found|does not exist|invalid)|session.*(?:not found|does not exist|failed to start)|failed to resume conversation)/i.test(bounded)) return "SESSION_START_FAILED";
  return "CLI_EXIT_UNCLASSIFIED";
}

/**
 * Maps failure reasons and exit codes to structured, sanitized error codes.
 * Exit code 2 with SANDBOX_SETUP_REQUIRED preserves ANTIGRAVITY_EXIT_ERROR for test parity.
 */
export function mapAntigravityErrorCode(reason: AntigravityFailureReason, exitCode?: number | null): string {
  switch (reason) {
    case "AUTH_ERROR":
      return "ANTIGRAVITY_AUTH_ERROR";
    case "MODEL_UNAVAILABLE":
      return "ANTIGRAVITY_MODEL_UNAVAILABLE";
    case "SESSION_START_FAILED":
      return "ANTIGRAVITY_SESSION_START_FAILED";
    case "WORKSPACE_UNAVAILABLE":
      return "ANTIGRAVITY_WORKSPACE_ERROR";
    case "PROTOCOL_ERROR":
      return "ANTIGRAVITY_PROTOCOL_ERROR";
    case "SPAWN_FAILED":
      return "SPAWN_FAILED";
    case "SANDBOX_SETUP_REQUIRED":
    case "APPROVAL_REQUIRED":
    case "INVALID_ARGUMENTS":
      return "ANTIGRAVITY_EXIT_ERROR";
    case "CLI_EXIT_UNCLASSIFIED":
    default:
      return "ANTIGRAVITY_PROCESS_EXIT";
  }
}

export interface AntigravityProviderStatus {
  status: "AVAILABLE" | "DEGRADED" | "UNAVAILABLE";
  cliInstalled: boolean;
  cliVersion: string | null;
  providerReachable: boolean;
  writeScopeGranularity: "workspace";
  subdirectoryPreventiveWriteScope: "unsupported";
  readOnlyNativeTools: "unsupported";
  networkPolicyCapability: "tool_prevention_and_interception";
  supportedModels: string[];
  activeSessionsCount: number;
  lastCanaryStatus?: {
    taskId: string;
    status: string;
    timestamp: string;
    exitCode: number | null;
  } | null;
}

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash-high";

export type AntigravityQuotaPoolId = "antigravity:gemini" | "antigravity:claude_gpt_shared";

export interface AntigravityModelDefinition {
  id: string;
  quotaPoolId: AntigravityQuotaPoolId;
  label?: string;
}

export const ANTIGRAVITY_MODEL_DEFINITIONS: Record<string, AntigravityModelDefinition> = {
  // Gemini models (dedicated pool: antigravity:gemini)
  "gemini-3.8-flash-high": { id: "gemini-3.8-flash-high", quotaPoolId: "antigravity:gemini", label: "Gemini 3.8 Flash High" },
  "gemini-3.8-flash-medium": { id: "gemini-3.8-flash-medium", quotaPoolId: "antigravity:gemini", label: "Gemini 3.8 Flash Medium" },
  "gemini-3.8-flash-low": { id: "gemini-3.8-flash-low", quotaPoolId: "antigravity:gemini", label: "Gemini 3.8 Flash Low" },
  "gemini-3.8-pro-high": { id: "gemini-3.8-pro-high", quotaPoolId: "antigravity:gemini", label: "Gemini 3.8 Pro High" },
  "gemini-3.7-flash-high": { id: "gemini-3.7-flash-high", quotaPoolId: "antigravity:gemini", label: "Gemini 3.7 Flash High" },
  "gemini-3.7-flash-medium": { id: "gemini-3.7-flash-medium", quotaPoolId: "antigravity:gemini", label: "Gemini 3.7 Flash Medium" },
  "gemini-3.7-flash-low": { id: "gemini-3.7-flash-low", quotaPoolId: "antigravity:gemini", label: "Gemini 3.7 Flash Low" },
  "gemini-3.6-flash-high": { id: "gemini-3.6-flash-high", quotaPoolId: "antigravity:gemini", label: "Gemini 3.6 Flash High" },
  "gemini-3.6-flash-medium": { id: "gemini-3.6-flash-medium", quotaPoolId: "antigravity:gemini", label: "Gemini 3.6 Flash Medium" },
  "gemini-3.6-flash-low": { id: "gemini-3.6-flash-low", quotaPoolId: "antigravity:gemini", label: "Gemini 3.6 Flash Low" },
  "gemini-3.1-pro-high": { id: "gemini-3.1-pro-high", quotaPoolId: "antigravity:gemini", label: "Gemini 3.1 Pro High" },
  "gemini-3.1-pro-low": { id: "gemini-3.1-pro-low", quotaPoolId: "antigravity:gemini", label: "Gemini 3.1 Pro Low" },

  // Claude & GPT models (shared pool: antigravity:claude_gpt_shared)
  "claude-sonnet-4-6": { id: "claude-sonnet-4-6", quotaPoolId: "antigravity:claude_gpt_shared", label: "Claude Sonnet 4.6" },
  "claude-opus-4-6-thinking": { id: "claude-opus-4-6-thinking", quotaPoolId: "antigravity:claude_gpt_shared", label: "Claude Opus 4.6 (Thinking)" },
  "gpt-oss-120b-medium": { id: "gpt-oss-120b-medium", quotaPoolId: "antigravity:claude_gpt_shared", label: "GPT OSS 120B Medium" },
};

export const KNOWN_ANTIGRAVITY_MODELS = new Set<string>(Object.keys(ANTIGRAVITY_MODEL_DEFINITIONS));
export const KNOWN_GEMINI_MODELS = KNOWN_ANTIGRAVITY_MODELS;

export function getAntigravityModelsForPool(poolId: AntigravityQuotaPoolId): string[] {
  return Object.values(ANTIGRAVITY_MODEL_DEFINITIONS)
    .filter((def) => def.quotaPoolId === poolId)
    .map((def) => def.id);
}

export function isWithinRoot(candidate: string, root: string): boolean {
  try {
    const normCandidate = path.resolve(candidate).toLowerCase();
    const normRoot = path.resolve(root).toLowerCase();
    if (normCandidate === normRoot) return true;
    const prefix = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep;
    return normCandidate.startsWith(prefix);
  } catch {
    return false;
  }
}

export function isWithinRoots(candidate: string, roots: string[]): boolean {
  return roots.some((root) => isWithinRoot(candidate, root));
}

/** Real path of an existing filesystem entry, or null when it does not exist. */
export function realPathIfExists(candidate: string): string | null {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return null;
  }
}

/**
 * Junction/symlink-aware scope containment for a candidate target.
 *
 * When the target exists, its REAL location (all junctions and symlinks
 * resolved) must be inside the allowed roots. When it does not exist yet,
 * the deepest existing ancestor is resolved instead — a junction in any
 * ancestor component must not smuggle the future write target outside the
 * scope. String-only containment (isWithinRoots) cannot see reparse points
 * and is therefore only used as a secondary check.
 */
export function realTargetWithinRoots(candidate: string, roots: string[]): boolean {
  const resolved = path.resolve(candidate);
  const real = realPathIfExists(resolved);
  if (real) return isWithinRoots(real, roots);
  let ancestor = path.dirname(resolved);
  for (;;) {
    const realAncestor = realPathIfExists(ancestor);
    if (realAncestor) return isWithinRoots(realAncestor, roots);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return false;
    ancestor = parent;
  }
}

export interface WriteScopePreflight {
  workspaceRoot: string;
  /** Real-path-resolved scope roots. Empty when writes are not allowed. */
  writableRoots: string[];
  writesAllowed: boolean;
  enforcement: "provider-workspace" | "none";
}

export type WriteScopePreflightResult =
  | { ok: true; preflight: WriteScopePreflight }
  | { ok: false; code: string; message: string };

/**
 * Pre-execution write-scope verification for the Antigravity provider.
 *
 * Runs BEFORE any agent process is spawned and fails closed. agy natively
 * enforces workspace-level containment (`allowNonWorkspaceAccess: false` +
 * `--add-dir` + AppContainer sandbox); C2C's stdout-event observation and
 * post-run audits are DETECTIVE layers, not preventive isolation. Honest
 * capability mapping, per the provider's real enforcement power:
 *
 * - writableRoots exactly equal to the (real) workspace root:
 *   the provider's native gate enforces it pre-execution → allowed.
 * - narrower sub-root scopes: agy would still receive the whole workspace,
 *   so sub-scope enforcement would be detective-only → REJECTED upfront
 *   (WRITE_SCOPE_UNSUPPORTED) instead of pretending.
 * - empty/missing writableRoots: rejected because native shell/file tools
 *   cannot preventively enforce read-only access.
 * - scope roots that vanish or resolve outside the workspace through a
 *   junction/symlink: rejected upfront.
 * Full-access execution retains this root validation and native file-tool gate,
 * but its explicitly authorized host shell is not AppContainer-isolated.
 */
export function verifyWriteScopePreflight(request: {
  workspaceRoot: string;
  writableRoots: string[];
}): WriteScopePreflightResult {
  const workspaceReal = realPathIfExists(request.workspaceRoot);
  if (!workspaceReal || !fs.statSync(workspaceReal).isDirectory()) {
    return { ok: false, code: "WORKSPACE_UNAVAILABLE", message: "The authorized workspace directory does not exist or is not readable" };
  }
  if (!request.writableRoots || request.writableRoots.length === 0) {
    return {
      ok: false,
      code: "READ_ONLY_UNSUPPORTED",
      message: "Native shell and file tools cannot preventively enforce read-only scope",
    };
  }
  const resolvedRoots: string[] = [];
  for (const root of request.writableRoots) {
    const rootReal = realPathIfExists(root);
    if (!rootReal || !fs.statSync(rootReal).isDirectory()) {
      return { ok: false, code: "WRITE_SCOPE_UNSUPPORTED", message: "A declared write scope does not exist at execution time" };
    }
    if (!isWithinRoots(rootReal, [workspaceReal])) {
      return { ok: false, code: "WRITE_SCOPE_UNSUPPORTED", message: "A declared write scope resolves outside the workspace through a real path, junction or symlink" };
    }
    if (!resolvedRoots.includes(rootReal)) resolvedRoots.push(rootReal);
  }
  const coversWorkspace = resolvedRoots.length === 1 && isWithinRoots(workspaceReal, [resolvedRoots[0]]);
  if (!coversWorkspace) {
    return {
      ok: false,
      code: "WRITE_SCOPE_UNSUPPORTED",
      message:
        "Antigravity can only preventively enforce workspace-level write scopes. " +
        "Narrower sub-directory scopes would be detective-only for this provider; " +
        "submit the task with write_scope covering the workspace root, or use the codex provider for sub-scope writes.",
    };
  }
  return {
    ok: true,
    preflight: { workspaceRoot: workspaceReal, writableRoots: resolvedRoots, writesAllowed: true, enforcement: "provider-workspace" },
  };
}

export function extractCandidatePathsFromCommand(cmd: string, workspaceRoot?: string): string[] {
  const candidates: string[] = [];
  // 1. Quoted paths with Windows drive letters: "C:\path\..." or 'C:\path\...'
  const quotedWin = cmd.match(/(["'])([A-Za-z]:\\[^"']+)\1/g);
  if (quotedWin) {
    for (const m of quotedWin) {
      candidates.push(m.slice(1, -1));
    }
  }
  // 2. Unquoted paths with Windows drive letters: C:\path\with_no_spaces
  const unquotedWin = cmd.match(/(?:^|[\s=,;()<>|])([A-Za-z]:\\[^\s"'<>|]+)/g);
  if (unquotedWin) {
    for (const m of unquotedWin) {
      const cleaned = m.trim().replace(/^[=,;()<>|\s]+/, "");
      if (cleaned && !candidates.includes(cleaned)) {
        candidates.push(cleaned);
      }
    }
  }
  // 3. Command parameters for file creation (e.g. -Path "...", Out-File "...")
  if (workspaceRoot) {
    const paramMatches = cmd.match(/(?:-Path|-LiteralPath|>|>>|Out-File|New-Item|Set-Content|Add-Content)\s+["']?([^"'\s<>|]+)["']?/gi);
    if (paramMatches) {
      for (const m of paramMatches) {
        const parts = m.split(/\s+/);
        const target = parts[parts.length - 1]?.replace(/["']/g, "");
        if (target && !/^[A-Za-z]:\\/.test(target) && !target.startsWith("-") && target.includes(".")) {
          candidates.push(path.resolve(workspaceRoot, target));
        }
      }
    }
  }
  return candidates;
}

export const ANTIGRAVITY_WRITE_TOOLS = new Set([
  "write_to_file",
  "replace_file_content",
  "edit_file",
  "write_file",
  "create_file",
  "save_file",
  "modify_file",
  "patch_file",
]);

export interface AntigravityToolScopeInput {
  toolName: string;
  parameters: Record<string, unknown>;
  workspaceRoot: string;
  /** Verified scope roots from the preflight. Empty = writes disabled. */
  allowedRoots: string[];
  writesAllowed: boolean;
}

export interface AntigravityToolScopeVerdict {
  /** Null when the tool call is allowed. */
  violation: string | null;
  category: "write-tool" | "read-path" | "command" | "allowed";
}

/**
 * Scope decision for ONE Antigravity tool-call event (pure; no I/O effects).
 *
 * This is the DETECTIVE layer over the provider's native workspace gate. A
 * violation fails the task — it NEVER deletes, truncates or rolls back the
 * referenced path. All containment checks are junction/symlink-aware via
 * realTargetWithinRoots.
 */
export function evaluateAntigravityToolScope(input: AntigravityToolScopeInput): AntigravityToolScopeVerdict {
  const { toolName, parameters: params, workspaceRoot, allowedRoots, writesAllowed } = input;

  const candidateWritePath = typeof params.TargetFile === "string" ? params.TargetFile
    : typeof params.target_file === "string" ? params.target_file
    : typeof params.path === "string" ? params.path
    : null;

  // 1. File write tools.
  if (ANTIGRAVITY_WRITE_TOOLS.has(toolName) || params.TargetFile || params.target_file) {
    if (!writesAllowed) {
      return { violation: candidateWritePath ?? "(no target path reported)", category: "write-tool" };
    }
    const targetCandidate = candidateWritePath ?? (typeof params.AbsolutePath === "string" ? params.AbsolutePath : null);
    if (targetCandidate) {
      const resolvedTarget = path.isAbsolute(targetCandidate)
        ? path.resolve(targetCandidate)
        : path.resolve(workspaceRoot, targetCandidate);
      if (!isWithinRoots(resolvedTarget, allowedRoots) || !realTargetWithinRoots(resolvedTarget, allowedRoots)) {
        return { violation: resolvedTarget, category: "write-tool" };
      }
    }
  }

  // 2. AbsolutePath pointing outside the workspace (e.g. read tools).
  if (typeof params.AbsolutePath === "string" && path.isAbsolute(params.AbsolutePath)) {
    const resolvedAbsolute = path.resolve(params.AbsolutePath);
    const outsideWorkspace =
      !isWithinRoot(resolvedAbsolute, workspaceRoot) ||
      (fs.existsSync(resolvedAbsolute) && !realTargetWithinRoots(resolvedAbsolute, [workspaceRoot]));
    if (outsideWorkspace) {
      return { violation: params.AbsolutePath, category: "read-path" };
    }
  }

  // 3. Write-shaped shell commands targeting paths outside scope.
  if (toolName === "run_command" && typeof params.CommandLine === "string") {
    const cmd = params.CommandLine;
    const isWriteCmd = cmd.includes("Set-Content") || cmd.includes("Out-File") || cmd.includes("New-Item") || cmd.includes(">") || cmd.includes("Add-Content");
    if (isWriteCmd) {
      if (!writesAllowed) {
        return { violation: "(write-shaped command under a no-write task)", category: "command" };
      }
      for (const candidate of extractCandidatePathsFromCommand(cmd, workspaceRoot)) {
        if (!isWithinRoots(candidate, allowedRoots) || !realTargetWithinRoots(candidate, allowedRoots)) {
          return { violation: candidate, category: "command" };
        }
      }
    }
  }

  return { violation: null, category: "allowed" };
}

export interface AntigravityBackendOptions {
  executablePath?: string;
  defaultModel?: string;
  stateDir?: string;
  sessionStartupTimeoutMs?: number;
}

interface ActiveProcess {
  child: ChildProcess;
  pid: number;
  cancelled: boolean;
}

export class AntigravityBackend implements ExecutionBackend {
  readonly provider = "gemini" as const;
  private readonly configuredExecutablePath?: string;
  private readonly defaultModel: string;
  private readonly baseStateDir?: string;
  private readonly sessionStartupTimeoutMs: number;
  private readonly activeProcesses = new Map<string, ActiveProcess>();
  private resolvedExecutablePath: string | null = null;
  private closed = false;
  private lastCanaryRecord: AntigravityProviderStatus["lastCanaryStatus"] = null;

  constructor(options: AntigravityBackendOptions = {}) {
    this.configuredExecutablePath = options.executablePath;
    this.defaultModel = options.defaultModel ?? DEFAULT_GEMINI_MODEL;
    this.baseStateDir = options.stateDir;
    this.sessionStartupTimeoutMs = options.sessionStartupTimeoutMs ?? 30_000;
  }

  async initialize(_workspaceRoot: string): Promise<void> {
    this.getExecutablePath();
  }

  async getProviderStatus(): Promise<AntigravityProviderStatus> {
    let cliInstalled = false;
    let cliVersion: string | null = null;
    let cliPath: string | null = null;
    let providerReachable = false;
    try {
      cliPath = this.getExecutablePath();
      cliInstalled = true;
      const ver = execSync(`"${cliPath}" --version`, {
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString().trim();
      if (ver) {
        cliVersion = /^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(ver) ? ver : null;
      }
    } catch {
      providerReachable = false;
    }

    // Installation is a local fact; only a successful session verifies reachability.
    providerReachable = cliInstalled && this.lastCanaryRecord?.status === "completed";
    const status = !cliInstalled ? "UNAVAILABLE" : providerReachable ? "AVAILABLE" : "DEGRADED";

    return {
      status,
      cliInstalled,
      cliVersion,
      providerReachable,
      writeScopeGranularity: "workspace",
      subdirectoryPreventiveWriteScope: "unsupported",
      readOnlyNativeTools: "unsupported",
      networkPolicyCapability: "tool_prevention_and_interception",
      supportedModels: Object.keys(ANTIGRAVITY_MODEL_DEFINITIONS),
      activeSessionsCount: this.activeProcesses.size,
      lastCanaryStatus: this.lastCanaryRecord,
    };
  }

  private readTranscriptModel(isolatedHome: string, conversationId: string): string | null {
    try {
      const transcriptFile = path.join(
        isolatedHome,
        ".gemini",
        "antigravity-cli",
        "brain",
        conversationId,
        ".system_generated",
        "logs",
        "transcript.jsonl"
      );
      if (!fs.existsSync(transcriptFile)) return null;
      const content = fs.readFileSync(transcriptFile, "utf8");
      const match = content.match(/Model Selection[`']?\s+from\s+None\s+to\s+([^.\r\n]+)/i);
      if (match && match[1]) {
        return match[1].trim();
      }
      return null;
    } catch {
      return null;
    }
  }

  getExecutablePath(): string {
    if (this.resolvedExecutablePath) return this.resolvedExecutablePath;
    if (this.configuredExecutablePath && fs.existsSync(this.configuredExecutablePath)) {
      this.resolvedExecutablePath = this.configuredExecutablePath;
      return this.resolvedExecutablePath;
    }

    // Standard installation path on Windows
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const defaultPath = path.join(localAppData, "agy", "bin", "agy.exe");
      if (fs.existsSync(defaultPath)) {
        this.resolvedExecutablePath = defaultPath;
        return this.resolvedExecutablePath;
      }
    }

    // Fallback: search PATH
    try {
      const whereOutput = execSync("where.exe agy.exe", { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
      const firstLine = whereOutput.split("\r\n")[0]?.split("\n")[0]?.trim();
      if (firstLine && fs.existsSync(firstLine)) {
        this.resolvedExecutablePath = firstLine;
        return this.resolvedExecutablePath;
      }
    } catch {
      // not found in PATH
    }

    throw new Error(
      "The Google Antigravity executable (agy.exe) could not be found. Please ensure Antigravity is installed."
    );
  }

  getIsolatedProviderDir(): string {
    const root = this.baseStateDir ?? getStateDir();
    return ensureDir(path.join(root, "providers", "antigravity"));
  }

  getIsolatedHomeDir(): string {
    const providerDir = this.getIsolatedProviderDir();
    return ensureDir(path.join(providerDir, "isolated_home"));
  }

  setupIsolatedConfig(networkEffective: boolean): { isolatedHome: string; env: NodeJS.ProcessEnv } {
    const isolatedHome = this.getIsolatedHomeDir();
    const geminiDir = ensureDir(path.join(isolatedHome, ".gemini"));
    const configDir = ensureDir(path.join(geminiDir, "config"));
    const cliDir = ensureDir(path.join(geminiDir, "antigravity-cli"));
    ensureDir(path.join(cliDir, "mcp"));

    // 1. Write empty mcp_config.json to deterministically prevent C2C MCP recursion
    const mcpConfigFile = path.join(configDir, "mcp_config.json");
    fs.writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: {} }, null, 2), "utf8");

    // 2. Configure Antigravity CLI settings (settings.json) in the isolated home.
    // In headless print mode, AGY requires toolPermission="always-proceed" because it cannot prompt a user.
    // Outbound network tooling is denied if network is not effective.
    const networkDenyTools = networkEffective
      ? []
      : [
          "read_url(*)",
          "read_url_content(*)",
          "open_browser_url(*)",
          "search_web(*)",
          "read_browser_page(*)",
          "browser_*(*)",
        ];
    const cliSettingsFile = path.join(cliDir, "settings.json");
    const cliSettings = {
      toolPermission: "always-proceed",
      allowNonWorkspaceAccess: false,
      permissions: {
        allow: [],
        deny: networkDenyTools,
      },
    };
    fs.writeFileSync(cliSettingsFile, JSON.stringify(cliSettings, null, 2), "utf8");

    // 3. Write shared config.json with matching globalPermissionGrants
    const configFile = path.join(configDir, "config.json");
    const sharedConfig = {
      userSettings: {
        globalPermissionGrants: {
          allow: [],
          deny: networkDenyTools,
        },
      },
    };
    fs.writeFileSync(configFile, JSON.stringify(sharedConfig, null, 2), "utf8");

    // 4. Prepare child environment: scrub all bridge, tunnel, and C2C secrets
    const env: NodeJS.ProcessEnv = { ...process.env };
    const SCRUB_PREFIXES = [
      /^c2c_/i,
      /^tunnel_/i,
      /^cloudflare_/i,
      /^bridge_/i,
    ];
    for (const key of Object.keys(env)) {
      if (SCRUB_PREFIXES.some((prefix) => prefix.test(key))) {
        delete env[key];
      }
    }
    delete env.C2C_SERVICE_TOKEN;
    delete env.C2C_JWT_SECRET;
    delete env.CLOUDFLARE_TUNNEL_TOKEN;
    delete env.TUNNEL_TOKEN;
    delete env.BRIDGE_AUTH_TOKEN;

    // Direct configuration paths to the isolated home
    env.USERPROFILE = isolatedHome;
    env.HOME = isolatedHome;
    const parsed = path.parse(isolatedHome);
    env.HOMEDRIVE = parsed.root.replace(/[\\/]$/, "");
    env.HOMEPATH = isolatedHome.slice(parsed.root.length - 1);

    return { isolatedHome, env };
  }

  async execute(request: BackendExecutionRequest): Promise<BackendExecutionResult> {
    const requestedModel = request.model ?? this.defaultModel;
    if (this.closed) {
      request.onLifecyclePhase?.("TERMINAL");
      return {
        status: "failed",
        provider: "gemini",
        providerRuntime: "antigravity-cli",
        providerModel: requestedModel,
        requestedProvider: "gemini",
        requestedModel: requestedModel,
        actualProvider: null,
        actualModel: "UNKNOWN",
        output: "",
        changedFiles: [],
        error: { code: "BACKEND_CLOSED", message: "Antigravity backend is shutting down" },
      };
    }

    const model = requestedModel;

    if (!KNOWN_GEMINI_MODELS.has(model)) {
      request.onLifecyclePhase?.("TERMINAL");
      return {
        status: "failed",
        provider: "gemini",
        providerRuntime: "antigravity-cli",
        providerModel: model,
        requestedProvider: "gemini",
        requestedModel: model,
        actualProvider: null,
        actualModel: "UNKNOWN",
        output: "",
        changedFiles: [],
        error: { code: "INVALID_MODEL", message: `Requested Gemini model "${model}" is not a recognized model identifier` },
      };
    }

    // Pre-execution write-scope verification (fail closed BEFORE spawning the
    // agent; no permission is ever widened to let a task run).
    const preflightResult = verifyWriteScopePreflight({
      workspaceRoot: request.workspaceRoot,
      writableRoots: request.writableRoots,
    });
    if (!preflightResult.ok) {
      request.onLifecyclePhase?.("TERMINAL");
      return {
        status: "failed",
        provider: "gemini",
        providerRuntime: "antigravity-cli",
        providerModel: model,
        requestedProvider: "gemini",
        requestedModel: model,
        actualProvider: null,
        actualModel: "UNKNOWN",
        output: "",
        changedFiles: [],
        error: { code: preflightResult.code, message: preflightResult.message },
      };
    }
    const preflight = preflightResult.preflight;
    let exePath: string;
    try {
      exePath = this.getExecutablePath();
    } catch (err) {
      request.onLifecyclePhase?.("TERMINAL");
      return {
        status: "failed",
        provider: "gemini",
        providerRuntime: "antigravity-cli",
        providerModel: model,
        requestedProvider: "gemini",
        requestedModel: model,
        actualProvider: null,
        actualModel: "UNKNOWN",
        output: "",
        changedFiles: [],
        error: {
          code: "SPAWN_FAILED",
          message: err instanceof Error ? err.message : "Antigravity CLI executable not found",
        },
      };
    }
    const { env } = this.setupIsolatedConfig(request.networkEffective);
    // Detective layers use exactly the verified roots. Never widen an empty
    // scope back to the workspace root.
    const allowedRoots = preflight.writableRoots;

    const timeoutSec = Math.max(10, Math.ceil(request.timeoutMs / 1000));
    const args: string[] = [
      "--add-dir",
      request.workspaceRoot,
      "--model",
      model,
      "--mode",
      "accept-edits",
      // Full-access mode is already explicitly authorized by the caller. Forcing
      // AppContainer here can stop headless run_command at an admin setup prompt.
      ...(request.fullAccess ? [] : ["--sandbox"]),
      "--disable-slash-commands",
      "--output-format",
      "stream-json",
      "--print-timeout",
      `${timeoutSec}s`,
    ];

    if (request.providerSessionId) {
      args.push("--conversation", request.providerSessionId);
    }

    args.push("--print", request.instruction);

    // Capture baseline files via git before execution
    const baselineFiles = this.captureWorkspaceFiles(request.workspaceRoot);

    const spawnStartedAt = Date.now();
    request.onLifecyclePhase?.("SPAWNING_PROVIDER");

    return new Promise<BackendExecutionResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(exePath, args, {
          cwd: request.workspaceRoot,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        request.onLifecyclePhase?.("TERMINAL");
        resolve({
          status: "failed",
          provider: "gemini",
          providerRuntime: "antigravity-cli",
          providerModel: model,
          requestedProvider: "gemini",
          requestedModel: model,
          actualProvider: null,
          actualModel: "UNKNOWN",
          output: "",
          changedFiles: [],
          error: {
            code: "SPAWN_FAILED",
            message: "Antigravity CLI could not start (reason=SPAWN_FAILED)",
          },
        });
        return;
      }

      const processStartedAt = Date.now();
      request.onLifecyclePhase?.("PROVIDER_STARTED");
      request.onLifecyclePhase?.("SESSION_ESTABLISHING");

      const pid = child.pid ?? 0;
      const activeRecord: ActiveProcess = { child, pid, cancelled: false };
      this.activeProcesses.set(request.taskId, activeRecord);

      let extractedConversationId: string | undefined;
      let sessionEstablished = false;
      let sessionEstablishedAt: number | null = null;
      let firstEventAt: number | null = null;
      let firstOutputAt: number | null = null;
      let observedModel: string | null = null;
      let finalResponse = "";
      let finalStatus: "completed" | "failed" | "cancelled" | "timed_out" = "completed";
      let failureError: { code: string; message: string } | undefined;
      let tokenUsage: BackendExecutionResult["tokenUsage"];
      const outputChunks: string[] = [];
      let diagnosticTail = "";
      let failureReason: AntigravityFailureReason = "CLI_EXIT_UNCLASSIFIED";
      const observeDiagnostic = (text: unknown) => {
        if (typeof text !== "string") return;
        diagnosticTail = (diagnosticTail + text.slice(-8192)).slice(-8192);
        const reason = projectAntigravityFailure(diagnosticTail);
        if (reason !== "CLI_EXIT_UNCLASSIFIED") failureReason = reason;
      };

      // 1. Overall task timeout
      let timer: NodeJS.Timeout | null = setTimeout(() => {
        timer = null;
        finalStatus = "timed_out";
        failureError = { code: "ANTIGRAVITY_TIMEOUT", message: "Task exceeded maximum allowed timeout" };
        this.terminateProcess(pid);
      }, request.timeoutMs);

      // 2. Bounded pre-session startup timeout
      const startupTimeoutMs = Math.min(this.sessionStartupTimeoutMs, request.timeoutMs);
      let startupTimer: NodeJS.Timeout | null = setTimeout(() => {
        startupTimer = null;
        if (!sessionEstablished && finalStatus === "completed") {
          finalStatus = "failed";
          failureReason = "SESSION_START_FAILED";
          failureError = {
            code: "ANTIGRAVITY_SESSION_START_FAILED",
            message: `Antigravity CLI failed to establish a session within bounded startup timeout (${startupTimeoutMs}ms)`,
          };
          this.terminateProcess(pid);
        }
      }, startupTimeoutMs);

      const markSessionEstablished = (convId: string) => {
        if (!sessionEstablished) {
          sessionEstablished = true;
          sessionEstablishedAt = Date.now();
          if (startupTimer) {
            clearTimeout(startupTimer);
            startupTimer = null;
          }
          request.onIdentity?.({ providerSessionId: convId });
          request.onLifecyclePhase?.("SESSION_ESTABLISHED");
        }
      };

      if (child.stdout) {
        const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        rl.on("line", (line) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          if (!firstEventAt) firstEventAt = Date.now();
          try {
            const ev = JSON.parse(trimmed);

            if (typeof ev.model === "string") observedModel = ev.model;

            // 1. Initial event inspection
            if (ev.event === "init" || ev.type === "init") {
              if (ev.conversation_id) {
                extractedConversationId = ev.conversation_id;
                markSessionEstablished(ev.conversation_id);
              }
              // RECURSION CHECK: Verify C2C tools are not exposed
              const rawTools: unknown = ev.init?.tools ?? ev.tools ?? [];
              const tools: string[] = Array.isArray(rawTools)
                ? rawTools.map((t) => (typeof t === "string" ? t : (t as { name?: string })?.name ?? ""))
                : [];
              const hasC2CTools = tools.some(
                (t) => t.toLowerCase().includes("c2c") || t === "submit_codex_task" || t === "workspace_info"
              );
              if (hasC2CTools) {
                finalStatus = "failed";
                failureReason = "PROTOCOL_ERROR";
                failureError = {
                  code: "C2C_RECURSION_DETECTED",
                  message: "Antigravity loaded Northbound C2C MCP tools. Aborting execution to prevent recursive loop.",
                };
                this.terminateProcess(pid);
                return;
              }
            }

            // 2. Step updates & tool calls
            if (ev.event === "step_update" || ev.type === "step_update") {
              const su = ev.step_update ?? ev;
              if (su.conversation_id) {
                if (!extractedConversationId) extractedConversationId = su.conversation_id;
                markSessionEstablished(su.conversation_id);
              }
              if (su.tool_name && su.tool_info) {
                if (!firstOutputAt) {
                  firstOutputAt = Date.now();
                  request.onLifecyclePhase?.("EXECUTING");
                }
                const toolNameLower = String(su.tool_name).toLowerCase();
                if (toolNameLower.includes("c2c") || toolNameLower === "submit_codex_task" || toolNameLower === "workspace_info") {
                  finalStatus = "failed";
                  failureReason = "PROTOCOL_ERROR";
                  failureError = {
                    code: "C2C_RECURSION_DETECTED",
                    message: `Antigravity attempted Northbound C2C MCP tool call: ${su.tool_name}. Aborting execution to prevent recursive loop.`,
                  };
                  this.terminateProcess(pid);
                  return;
                }
                if (!request.networkEffective && /^(read_url|read_url_content|open_browser_url|browser_|search_web|read_browser_page)/i.test(su.tool_name)) {
                  finalStatus = "failed";
                  failureError = {
                    code: "NETWORK_ACCESS_DENIED",
                    message: `Task network is disabled, but Antigravity attempted network tool call: ${su.tool_name}`,
                  };
                  this.terminateProcess(pid);
                  return;
                }

                // Workspace isolation & write scope enforcement. Detective
                // layer over the provider's native gate: a violation FAILS
                // the task and terminates the agent, but never deletes or
                // rolls back files — the scene is preserved for the owner.
                const params = (su.tool_info.parameters ?? {}) as Record<string, unknown>;
                const verdict = evaluateAntigravityToolScope({
                  toolName: String(su.tool_name),
                  parameters: params,
                  workspaceRoot: request.workspaceRoot,
                  allowedRoots,
                  writesAllowed: preflight.writesAllowed,
                });
                if (verdict.violation) {
                  finalStatus = "failed";
                  failureError = {
                    code: "WRITE_SCOPE_VIOLATION",
                    message:
                      verdict.category === "read-path"
                        ? `Antigravity attempted to access path outside authorized workspace: ${verdict.violation}. The task failed; the referenced file was left untouched.`
                        : `Antigravity attempted a ${verdict.category} outside authorized write scope: ${verdict.violation}. The task failed; no cleanup or rollback was attempted and existing files were left untouched.`,
                  };
                  this.terminateProcess(pid);
                  return;
                }

                request.onToolCall?.(su.tool_name, params);
              }
              if (su.text_delta) {
                if (!firstOutputAt) {
                  firstOutputAt = Date.now();
                  request.onLifecyclePhase?.("EXECUTING");
                }
                outputChunks.push(su.text_delta);
                request.onOutput?.(su.text_delta);
              }
            }

            // 3. Result event
            if (ev.event === "result" || ev.type === "result") {
              const res = ev.result ?? ev;
              if (typeof res?.model === "string") observedModel = res.model;
              if (res.conversation_id) {
                extractedConversationId = res.conversation_id;
                markSessionEstablished(res.conversation_id);
              } else if (res.status === "SUCCESS" || res.response) {
                sessionEstablished = true;
              }
              if (res.response) {
                finalResponse = res.response;
              }
              if (res.usage) {
                tokenUsage = {
                  inputTokens: res.usage.input_tokens,
                  outputTokens: res.usage.output_tokens,
                  thinkingTokens: res.usage.thinking_tokens,
                  cacheReadTokens: res.usage.cache_read_tokens,
                  totalTokens: res.usage.total_tokens,
                };
              }
              if (res.status === "ERROR") {
                observeDiagnostic(typeof res.error === "string" ? res.error : res.error?.message);
                finalStatus = "failed";
                const errCode = mapAntigravityErrorCode(failureReason);
                failureError = {
                  code: errCode === "ANTIGRAVITY_PROCESS_EXIT" ? "ANTIGRAVITY_EXECUTION_ERROR" : errCode,
                  message: `Antigravity task reported execution error (reason=${failureReason})`,
                };
              }
            }
          } catch {
            // Non-protocol stdout is diagnostic data, not agent output.
            observeDiagnostic(trimmed);
          }
        });
      }

      if (child.stderr) {
        child.stderr.on("data", (d) => {
          observeDiagnostic(d.toString());
        });
      }

      child.on("error", () => {
        finalStatus = "failed";
        failureError = { code: "SPAWN_FAILED", message: "Antigravity CLI could not start (reason=SPAWN_FAILED)" };
      });

      // close follows stdio drain; exit may precede the final result/diagnostic.
      child.on("close", (code) => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }
        this.activeProcesses.delete(request.taskId);
        request.onLifecyclePhase?.("TERMINAL");

        if (activeRecord.cancelled) {
          finalStatus = "cancelled";
          failureError = { code: "ANTIGRAVITY_CANCELLED", message: "Task was cancelled by user request" };
        } else if (finalStatus === "timed_out") {
          failureError = { code: "ANTIGRAVITY_TIMEOUT", message: "Task exceeded maximum allowed timeout" };
        } else if (code !== 0 && finalStatus === "completed") {
          finalStatus = "failed";
          if (!sessionEstablished && failureReason === "CLI_EXIT_UNCLASSIFIED") {
            failureReason = "SESSION_START_FAILED";
          }
          const errCode = mapAntigravityErrorCode(failureReason, code);
          const detail = failureReason === "SANDBOX_SETUP_REQUIRED"
            ? "reason=SANDBOX_SETUP_REQUIRED: sandboxing requires administrative setup"
            : failureReason === "AUTH_ERROR"
            ? "reason=AUTH_ERROR: authentication failed or credentials missing"
            : failureReason === "MODEL_UNAVAILABLE"
            ? "reason=MODEL_UNAVAILABLE: requested model could not be resolved or quota exhausted"
            : failureReason === "SESSION_START_FAILED"
            ? "reason=SESSION_START_FAILED: process terminated before session establishment"
            : failureReason === "WORKSPACE_UNAVAILABLE"
            ? "reason=WORKSPACE_UNAVAILABLE: target directory could not be opened"
            : `reason=${failureReason}`;

          failureError = {
            code: errCode,
            message: !sessionEstablished
              ? `Antigravity CLI process exited before establishing a session (exitCode=${code}, ${detail})`
              : `Antigravity CLI process exited with code ${code} (${detail})`,
          };
        }

        // Capture post-execution files
        const postFiles = this.captureWorkspaceFiles(request.workspaceRoot);
        const changedFiles = this.computeChangedFiles(baselineFiles, postFiles);

        // Post-run audit (DETECTIVE ONLY): flag changed files outside the
        // verified scope so the task fails and the record shows the violation.
        // Never delete or roll back — out-of-bounds writes stay on disk for
        // owner review, and pre-existing user files must never be touched.
        const allowedRoots = preflight.writableRoots;

        for (const file of changedFiles) {
          const absFile = path.isAbsolute(file) ? path.resolve(file) : path.resolve(request.workspaceRoot, file);
          const outsideScope = !preflight.writesAllowed
            ? true
            : !isWithinRoots(absFile, allowedRoots) || !realTargetWithinRoots(absFile, allowedRoots);
          if (outsideScope) {
            finalStatus = "failed";
            failureError = {
              code: "WRITE_SCOPE_VIOLATION",
              message: `Antigravity modified file outside authorized write scope: ${absFile}. The task failed; the file was left on disk untouched for owner review (no automatic rollback).`,
            };
          }
        }

        if (finalStatus === "completed" && !sessionEstablished) {
          finalStatus = "failed";
          failureError = { code: "ANTIGRAVITY_SESSION_START_FAILED", message: "Antigravity exited without session evidence" };
        }

        // Attempt reading model from session transcript if not exposed in stream
        if (!observedModel && extractedConversationId) {
          observedModel = this.readTranscriptModel(env.USERPROFILE ?? this.getIsolatedHomeDir(), extractedConversationId);
        }
        const actualModel = observedModel ?? "UNKNOWN";

        const now = Date.now();
        const phaseDurations: Record<string, number> = {
          spawnDurationMs: Math.max(0, processStartedAt - spawnStartedAt),
          startupDurationMs: firstEventAt ? Math.max(0, firstEventAt - processStartedAt) : 0,
          sessionHandshakeDurationMs: sessionEstablishedAt && firstEventAt ? Math.max(0, sessionEstablishedAt - firstEventAt) : 0,
          executionDurationMs: sessionEstablishedAt ? Math.max(0, now - sessionEstablishedAt) : 0,
          totalDurationMs: Math.max(0, now - spawnStartedAt),
        };

        this.lastCanaryRecord = {
          taskId: request.taskId,
          status: finalStatus,
          timestamp: new Date().toISOString(),
          exitCode: code,
        };

        const combinedOutput = finalStatus === "failed"
          ? failureError?.message ?? "Antigravity task failed"
          : finalResponse || outputChunks.join("\n");

        resolve({
          status: finalStatus,
          provider: "gemini",
          providerRuntime: "antigravity-cli",
          providerModel: model,
          requestedProvider: "gemini",
          requestedModel: model,
          actualProvider: sessionEstablished ? "antigravity" : null,
          actualModel,
          phaseDurations,
          providerSessionId: extractedConversationId,
          output: combinedOutput,
          changedFiles,
          tokenUsage,
          exitCode: code,
          error: failureError,
        });
      });
    });
  }

  async cancel(taskId: string): Promise<void> {
    const active = this.activeProcesses.get(taskId);
    if (!active) return;
    if (active.cancelled) return;
    active.cancelled = true;
    if (!active.child.killed && active.child.exitCode === null) {
      this.terminateProcess(active.pid);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [taskId, active] of this.activeProcesses.entries()) {
      active.cancelled = true;
      if (!active.child.killed && active.child.exitCode === null) {
        this.terminateProcess(active.pid);
      }
      this.activeProcesses.delete(taskId);
    }
  }

  private terminateProcess(pid: number): void {
    if (!pid || pid <= 0) return;
    if (process.platform === "win32") {
      try {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
      } catch {
        // process may have already exited
      }
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // process may have already exited
      }
    }
  }

  /**
   * Snapshot the workspace's git-visible state as `path -> content signature`.
   *
   * Parses `git status --porcelain=v1 -z -uall` (NUL-separated) instead of
   * naive `trim().slice(3)`: entry paths keep their positions, so modified
   * (` M`) entries, spaces, quotes and rename destinations are all handled.
   * The value is a content signature (sha256, or size:mtime for oversized
   * files) so that already-dirty files whose CONTENT changed during the task
   * are detected, not just newly-dirtied paths.
   */
  private captureWorkspaceFiles(root: string): Map<string, string> {
    let output = "";
    try {
      output = execSync("git status --porcelain=v1 -z -uall", {
        cwd: root,
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      }).toString();
    } catch {
      return new Map(); // non-git directory or git failure: empty baseline
    }
    const entries = parseGitStatusEntries(output);
    const signatures = new Map<string, string>();
    for (const relative of entries) {
      signatures.set(path.normalize(relative), fileContentSignature(path.resolve(root, relative)));
    }
    return signatures;
  }

  /**
   * Paths added, modified (including content changes to previously dirty
   * files), or DELETED between the two snapshots.
   */
  private computeChangedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
    return computeChangedFilesFromSignatures(before, after);
  }
}

/**
 * Parse `git status --porcelain=v1 -z -uall` output into entry paths.
 *
 * NUL-separated entries keep their exact offsets: XY status occupies bytes
 * 0-1, the path starts at byte 3 — no trimming, so ` M file.txt` (worktree
 * modification of an already-dirty file) yields "file.txt", not the mangled
 * "ile.txt" the old `trim().slice(3)` produced. With -z, rename/copy entries
 * carry the ORIGINAL path as the following NUL-separated field; we track the
 * destination and skip the origin. Paths arrive unquoted and raw.
 */
export function parseGitStatusEntries(output: string): string[] {
  const entries: string[] = [];
  const fields = output.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const statusXY = entry.slice(0, 2);
    const firstPath = entry.slice(3);
    if (/^R|^C/.test(statusXY)) i++; // skip the rename origin field
    entries.push(firstPath);
  }
  return entries;
}

/** Stable content signature used to detect changes to already-dirty files. */
export function fileContentSignature(absolutePath: string): string {
  try {
    const stat = fs.statSync(absolutePath);
    if (stat.isDirectory()) return "directory";
    // Oversized files: avoid hashing unbounded content; size+mtime is a
    // stable-enough change signal for the audit's purposes.
    if (stat.size > 16 * 1024 * 1024) return `size:${stat.size}:mtime:${stat.mtimeMs}`;
    const content = fs.readFileSync(absolutePath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return "deleted"; // listed by git but not readable/present → deletion state
  }
}

/**
 * Paths added, content-modified (including previously dirty files), or
 * DELETED between the two snapshots.
 */
export function computeChangedFilesFromSignatures(
  before: Map<string, string>,
  after: Map<string, string>
): string[] {
  const changed: string[] = [];
  for (const [file, signature] of after) {
    if (before.get(file) !== signature) changed.push(file);
  }
  for (const file of before.keys()) {
    if (!after.has(file)) changed.push(file);
  }
  return changed;
}
