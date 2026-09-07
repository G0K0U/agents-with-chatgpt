import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Workspace } from "../workspace/manager.js";
import { ensureDir } from "../config/paths.js";

/**
 * A verification profile is bridge-owned policy.  It is deliberately not a
 * public MCP input: ChatGPT can request verification with run_tests=true, but
 * it cannot choose an executable, argv, cwd, sandbox, or network policy.
 */
export type VerificationSandbox = "readOnly" | "workspaceWrite";
export type VerificationSummaryKind = "pytest" | "generic";

export interface VerificationProfile {
  readonly id: string;
  readonly workspaceId: string;
  /** Executable basename or a bridge-resolved absolute runtime path. Never shell text. */
  readonly executable: string;
  /** argv vector. The only supported substitutions are bridge-owned tokens. */
  readonly argv: readonly string[];
  /** The only cwd choices a registered profile may use. */
  readonly cwd: "workspace" | "verification";
  readonly timeoutMs: number;
  readonly network: false;
  readonly sandbox: VerificationSandbox;
  readonly summaryKind: VerificationSummaryKind;
}

export interface VerificationRuntime {
  /** Per-task directory under the C2C-owned runtime root. */
  readonly root: string;
  readonly temp: string;
  readonly pytestTemp: string;
  readonly cache: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface MaterializedVerification {
  readonly profileId: string;
  readonly workspaceId: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly cwdAlias: "workspace:/" | "c2c-runtime:/verification";
  readonly timeoutMs: number;
  readonly network: false;
  readonly sandbox: VerificationSandbox;
  readonly sandboxPolicy: Readonly<Record<string, unknown>>;
  readonly env: Readonly<Record<string, string>>;
  readonly commandLabel: string;
  readonly argvHash: string;
  readonly summaryKind: VerificationSummaryKind;
  readonly runtime: VerificationRuntime;
}

export interface VerificationAudit {
  profileId: string;
  workspaceId: string;
  executable: string;
  argvHash: string;
  cwd: "workspace:/" | "c2c-runtime:/verification";
  startedAt: string;
  completedAt?: string;
  exitCode: number | null;
  network: false;
  sandbox: VerificationSandbox;
  status: "running" | "passed" | "failed" | "timed_out" | "cancelled";
  outputId?: number;
}

export interface VerificationCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const TASK_ID_PATTERN = /^c2c_[0-9a-f]{8,32}$/;
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const EXECUTABLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PLACEHOLDERS = new Set([
  "workspace",
  "verification_root",
  "verification_temp",
  "verification_pytest_temp",
  "verification_cache",
]);
/** Operator-configured Engineering AI workspace id; empty = feature disabled (see audit-mirror.ts). */
const ENGINEERING_AI_WORKSPACE_ID = process.env.C2C_ENGINEERING_AI_WORKSPACE_ID?.trim() ?? "";
export const BRIDGE_REPOSITORY_ROOT = canonicalize(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
);
/** The only executable script allowed by the bridge verification profile. */
export const BRIDGE_VERIFICATION_SCRIPT = path.join(
  BRIDGE_REPOSITORY_ROOT,
  "dist",
  "execution",
  "registered-verification.js"
);

function existingRegularFile(candidate: string): string | null {
  const requested = path.resolve(candidate);
  try {
    const stat = fs.lstatSync(requested);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return fs.realpathSync.native(requested);
  } catch {
    return null;
  }
}

function resolveNodeExecutable(): string | null {
  return existingRegularFile(process.execPath);
}

export interface VerificationExecutableLaunch {
  executable: string;
  argv: string[];
  strategy: "node-bridge-script";
}

/**
 * Resolve the registered bridge verifier to an executable image plus a
 * bridge-owned argv vector. The verifier performs its checks in-process, so
 * the restricted command/exec path never launches pnpm, Vitest, Vite, esbuild,
 * git, or a shell.
 */
export function resolveBridgeVerificationLaunch(options: { nodeExecutable?: string } = {}): VerificationExecutableLaunch | null {
  const nodeExecutable = options.nodeExecutable
    ? existingRegularFile(options.nodeExecutable)
    : resolveNodeExecutable();
  if (!nodeExecutable) return null;
  return {
    executable: nodeExecutable,
    argv: [BRIDGE_VERIFICATION_SCRIPT, "--workspace", "{workspace}", "--runtime", "{verification_root}"],
    strategy: "node-bridge-script",
  };
}

function isBridgeNodeExecutable(candidate: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  const nodeExecutable = resolveNodeExecutable();
  return nodeExecutable !== null && existingRegularFile(candidate) === nodeExecutable;
}

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function canonicalize(abs: string): string {
  let current = abs;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return suffix.length > 0 ? path.join(real, ...suffix) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return abs;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function assertProfile(profile: VerificationProfile): void {
  if (!PROFILE_ID_PATTERN.test(profile.id)) throw new Error("Invalid verification profile id");
  if (!/^[0-9a-f]{12}$/.test(profile.workspaceId)) throw new Error("Invalid verification profile workspace id");
  if (!EXECUTABLE_PATTERN.test(profile.executable) && !isBridgeNodeExecutable(profile.executable)) {
    throw new Error("Invalid verification profile executable");
  }
  if (!Array.isArray(profile.argv) || profile.argv.length === 0 || profile.argv.length > 32) {
    throw new Error("Invalid verification profile argv");
  }
  if (!Number.isInteger(profile.timeoutMs) || profile.timeoutMs < 1_000 || profile.timeoutMs > 30 * 60_000) {
    throw new Error("Invalid verification profile timeout");
  }
  if (profile.network !== false) throw new Error("Verification profiles cannot enable network access");
  if (profile.cwd !== "workspace" && profile.cwd !== "verification") throw new Error("Invalid verification profile cwd");
  if (profile.sandbox !== "readOnly" && profile.sandbox !== "workspaceWrite") {
    throw new Error("Invalid verification profile sandbox");
  }
  if (profile.summaryKind !== "pytest" && profile.summaryKind !== "generic") {
    throw new Error("Invalid verification profile summary kind");
  }
  for (const arg of profile.argv) {
    if (typeof arg !== "string" || arg.length > 4_096 || arg.length === 0) {
      throw new Error("Invalid verification profile argument");
    }
    const placeholders = [...arg.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
    if (placeholders.some((placeholder) => !PLACEHOLDERS.has(placeholder))) {
      throw new Error("Verification profile contains an unsupported placeholder");
    }
  }
  if (profile.id === "c2c-bridge-in-process") {
    const launch = resolveBridgeVerificationLaunch();
    if (!launch || profile.executable !== launch.executable) {
      throw new Error("The registered bridge verification executable is not the current absolute Node runtime");
    }
    if (
      profile.argv.length !== launch.argv.length ||
      profile.argv.some((arg, index) => arg !== launch.argv[index])
    ) {
      throw new Error("The registered bridge verification argv is not bridge-owned");
    }
    if (profile.cwd !== "verification" || profile.sandbox !== "workspaceWrite" || profile.network !== false) {
      throw new Error("The registered bridge verification policy is invalid");
    }
  }
}

/**
 * The current installed workspace is registered locally, without consulting
 * a workspace-controlled config file.  This prevents a task from editing a
 * project config and thereby granting itself a new executable or argv.
 */
export function resolveDefaultVerificationProfile(workspace: Workspace): VerificationProfile | null {
  if (canonicalize(workspace.root) === BRIDGE_REPOSITORY_ROOT && fs.existsSync(path.join(workspace.root, "package.json"))) {
    const launch = resolveBridgeVerificationLaunch();
    if (!launch) return null;
    return {
      id: "c2c-bridge-in-process",
      workspaceId: workspace.id,
      executable: launch.executable,
      argv: launch.argv,
      cwd: "verification",
      timeoutMs: 5 * 60_000,
      network: false,
      sandbox: "workspaceWrite",
      summaryKind: "generic",
    };
  }
  if (workspace.id !== ENGINEERING_AI_WORKSPACE_ID) return null;
  const required = ["pyproject.toml", "uv.lock", "Makefile", "apps/web/package.json", "apps/web/pnpm-lock.yaml"];
  if (required.some((entry) => !fs.existsSync(path.join(workspace.root, entry)))) return null;
  return {
    id: "python-pytest",
    workspaceId: workspace.id,
    executable: "uv",
    argv: [
      "run",
      "--offline",
      "--no-sync",
      "--no-cache",
      "--project",
      "{workspace}",
      "pytest",
      "--config-file",
      "{workspace}/pyproject.toml",
      "-q",
      "-p",
      "no:cacheprovider",
      "-p",
      "no:tmpdir",
      "--maxfail=1",
      "-k",
      "default_registry_contains_no_generic_executor or planner_rejects_forbidden_tool_proposals",
      "{workspace}/tests/test_no_generic_cli.py",
    ],
    // Keep the Windows writable-root set to one C2C-owned directory. The
    // repository is passed as an explicit read target, so verification state
    // cannot be created in the repository and the sandbox avoids the
    // unsupported workspace-cwd/external-writable-root split.
    cwd: "verification",
    timeoutMs: 15 * 60_000,
    network: false,
    // This is still the official unelevated workspace-write sandbox, but its
    // only writable root is the task-specific C2C runtime directory. The
    // workspace remains outside the agent's write scope and is read-only from
    // the verifier's point of view.
    sandbox: "workspaceWrite",
    summaryKind: "pytest",
  };
}

/** Prepare a task-specific verification directory under the C2C runtime. */
export function prepareVerificationRuntime(runtimeRoot: string, taskId: string): VerificationRuntime {
  if (!TASK_ID_PATTERN.test(taskId)) throw new Error("Invalid task id for verification runtime");
  const parent = fs.realpathSync.native(path.resolve(runtimeRoot));
  const requested = path.join(parent, "verification", taskId);
  if (!within(canonicalize(requested), parent)) throw new Error("Verification runtime escaped C2C runtime root");
  const root = ensureDir(requested);
  const canonicalRoot = fs.realpathSync.native(root);
  if (!within(canonicalRoot, parent)) throw new Error("Verification runtime escaped C2C runtime root");

  const temp = ensureDir(path.join(canonicalRoot, "tmp"));
  const pytestTemp = ensureDir(path.join(temp, "pytest"));
  const cache = ensureDir(path.join(canonicalRoot, "cache"));
  for (const child of [temp, pytestTemp, cache]) {
    if (!within(fs.realpathSync.native(child), canonicalRoot)) {
      throw new Error("Verification runtime child escaped C2C runtime root");
    }
  }
  return {
    root: canonicalRoot,
    temp: fs.realpathSync.native(temp),
    pytestTemp: fs.realpathSync.native(pytestTemp),
    cache: fs.realpathSync.native(cache),
    env: {
      TEMP: fs.realpathSync.native(temp),
      TMP: fs.realpathSync.native(temp),
      TMPDIR: fs.realpathSync.native(temp),
      UV_CACHE_DIR: fs.realpathSync.native(cache),
      C2C_TEST_TMP_ROOT: fs.realpathSync.native(temp),
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONPYCACHEPREFIX: fs.realpathSync.native(cache),
      C2C_VERIFICATION_RUNTIME: fs.realpathSync.native(root),
      // Keep every registered verification environment explicitly offline. A
      // bridge-owned profile may not turn a missing local dependency into a
      // network download.
      COREPACK_ENABLE_NETWORK: "0",
      COREPACK_DEFAULT_TO_LATEST: "0",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    },
  };
}

/** Remove only the validated per-task verification directory. */
export function cleanupVerificationRuntime(runtimeRoot: string, runtime: VerificationRuntime): void {
  const parent = fs.realpathSync.native(path.resolve(runtimeRoot));
  const candidate = path.resolve(runtime.root);
  if (!within(candidate, parent) || path.basename(candidate) === "" || !TASK_ID_PATTERN.test(path.basename(candidate))) return;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(candidate);
  } catch {
    return;
  }
  // Never recursively follow a reparse point during cleanup.
  if (stat.isSymbolicLink()) return;
  fs.rmSync(candidate, { recursive: true, force: true });
}

function substitute(value: string, workspaceRoot: string, runtime: VerificationRuntime): string {
  return value.replace(/\{([^{}]+)\}/g, (_match, token: string) => {
    switch (token) {
      case "workspace":
        return workspaceRoot;
      case "verification_root":
        return runtime.root;
      case "verification_temp":
        return runtime.temp;
      case "verification_pytest_temp":
        return runtime.pytestTemp;
      case "verification_cache":
        return runtime.cache;
      default:
        throw new Error("Verification profile contains an unsupported placeholder");
    }
  });
}

export function materializeVerificationProfile(
  profile: VerificationProfile,
  workspace: Workspace,
  runtime: VerificationRuntime
): MaterializedVerification {
  assertProfile(profile);
  if (profile.workspaceId !== workspace.id) throw new Error("Verification profile is not registered for this workspace");
  const canonicalWorkspace = fs.realpathSync.native(path.resolve(workspace.root));
  const canonicalRuntimeRoot = fs.realpathSync.native(path.resolve(runtime.root));
  if (within(canonicalRuntimeRoot, canonicalWorkspace)) {
    throw new Error("Verification runtime must remain outside the connected workspace");
  }
  for (const runtimePath of [runtime.temp, runtime.pytestTemp, runtime.cache]) {
    if (!within(fs.realpathSync.native(path.resolve(runtimePath)), canonicalRuntimeRoot)) {
      throw new Error("Verification runtime path escaped its C2C runtime root");
    }
  }
  const argv = profile.argv.map((arg) => substitute(arg, workspace.root, runtime));
  const cwd = profile.cwd === "workspace" ? workspace.root : runtime.root;
  const cwdAlias = profile.cwd === "workspace" ? "workspace:/" : "c2c-runtime:/verification";
  const sandboxPolicy = profile.sandbox === "readOnly"
    ? { type: "readOnly", networkAccess: false }
    : {
        type: "workspaceWrite",
        writableRoots: [runtime.root],
        networkAccess: false,
        // The task-specific TEMP/TMP values intentionally point inside the
        // same sole writable C2C runtime root. Excluding them would make
        // pytest's own isolated temp directory inaccessible to the sandbox.
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: true,
      };
  const hashInput = JSON.stringify({
    executable: profile.executable,
    argv,
    cwd: cwdAlias,
    sandbox: sandboxPolicy,
    network: false,
  });
  const commandLabel = [profile.executable, ...profile.argv.map((arg) =>
    arg.replaceAll("{workspace}/", "workspace:/")
      .replaceAll("{workspace}", "workspace:/")
      .replaceAll(BRIDGE_VERIFICATION_SCRIPT, "bridge:/dist/execution/registered-verification.js")
      .replaceAll("{verification_root}", "c2c-runtime:/verification")
      .replaceAll("{verification_temp}", "c2c-runtime:/verification/tmp")
      .replaceAll("{verification_pytest_temp}", "c2c-runtime:/verification/tmp/pytest")
      .replaceAll("{verification_cache}", "c2c-runtime:/verification/cache")
  )].join(" ");
  return {
    profileId: profile.id,
    workspaceId: workspace.id,
    executable: profile.executable,
    argv,
    cwd,
    cwdAlias,
    timeoutMs: profile.timeoutMs,
    network: false,
    sandbox: profile.sandbox,
    sandboxPolicy,
    env: runtime.env,
    commandLabel,
    argvHash: createHash("sha256").update(hashInput).digest("hex"),
    summaryKind: profile.summaryKind,
    runtime,
  };
}

function pluralize(count: number, word: string): string {
  return `${count} ${word === "error" && count !== 1 ? "errors" : word}`;
}

/** Extract a bounded, human-readable pytest summary without trusting output. */
export function summarizeVerification(profile: VerificationProfile, result: VerificationCommandResult): string {
  const output = `${result.stdout}\n${result.stderr}`.slice(-256 * 1024);
  if (profile.summaryKind === "pytest") {
    const counts = new Map<string, number>();
    const pattern = /\b(\d+)\s+(failed|passed|skipped|error|errors|xfailed|xpassed|deselected)\b/gi;
    for (const match of output.matchAll(pattern)) {
      const label = match[2].toLowerCase() === "errors" ? "error" : match[2].toLowerCase();
      counts.set(label, (counts.get(label) ?? 0) + Number(match[1]));
    }
    const order = ["failed", "error", "passed", "skipped", "xfailed", "xpassed", "deselected"];
    const summary = order
      .filter((label) => counts.has(label))
      .map((label) => pluralize(counts.get(label)!, label))
      .join(", ");
    if (summary) return summary;
  }
  return result.exitCode === 0 ? "verification passed" : `verification failed (exit code ${result.exitCode ?? "unknown"})`;
}
