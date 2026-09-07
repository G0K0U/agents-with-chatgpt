import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { C2CSessionRegistry } from "../session/registry.js";
import { canonicalizeWorkspaceRoot, stableWorkspaceId } from "../workspace/identity.js";
import { Workspace } from "../workspace/manager.js";
import {
  appendExecutionRecord,
  readExecutionRecords,
  type ExecutionRecord,
} from "./records.js";
import {
  readExecutionOutput,
  listExecutionOutputs,
  saveExecutionOutput,
} from "./output.js";
import {
  readWorkspaceQueuePauseState,
  writeWorkspaceQueuePauseState,
  workspaceQueueStateFile,
} from "./queue-state.js";
import {
  acquireWorkspaceSlot,
  readWorkspaceSlot,
  reconcileWorkspaceSlot,
} from "./slot.js";
import { CodexTaskManager } from "./tasks.js";
import {
  BRIDGE_REPOSITORY_ROOT,
  BRIDGE_VERIFICATION_SCRIPT,
  materializeVerificationProfile,
  resolveBridgeVerificationLaunch,
  resolveDefaultVerificationProfile,
} from "./verification.js";

/**
 * This is the command line contract for the registered C2C verifier. It is
 * intentionally a tiny fixed vector: the bridge supplies the two paths and
 * the script rejects every other shape before touching state.
 */
export const REGISTERED_VERIFICATION_PROFILE_ID = "c2c-bridge-in-process";
export const REGISTERED_VERIFICATION_ARGV = [
  "--workspace",
  "{workspace}",
  "--runtime",
  "{verification_root}",
] as const;

export interface RegisteredVerificationArgs {
  workspaceRoot: string;
  runtimeRoot: string;
}

export interface RegisteredVerificationCheck {
  id: string;
  status: "passed";
}

export interface RegisteredVerificationResult {
  ok: true;
  profileId: typeof REGISTERED_VERIFICATION_PROFILE_ID;
  workspaceId: string;
  executionMode: "in-process";
  nestedToolchain: false;
  checks: RegisteredVerificationCheck[];
  policy: {
    executable: "bridge-node";
    argv: ["bridge:/dist/execution/registered-verification.js", "--workspace", "workspace:/", "--runtime", "c2c-runtime:/verification"];
    network: false;
    sandbox: "workspaceWrite";
    writableRoots: ["c2c-runtime:/verification"];
    shell: false;
    childProcessSpawning: false;
  };
}

export class RegisteredVerificationError extends Error {
  constructor(
    message: string,
    readonly checks: RegisteredVerificationCheck[] = [],
  ) {
    super(message);
    this.name = "RegisteredVerificationError";
  }
}

const TASK_ID = "c2c_abcdef123456";
const GHOST_TASK_ID = "c2c_deadbeef123456";
const OTHER_OUTPUT_WORKSPACE_ID = "abcdef123456";
const TERMINAL_TIMESTAMP = "2026-09-02T00:00:00.000Z";
const WATCHED_WORKSPACE_FILES = [
  "package.json",
  "src/execution/registered-verification.ts",
  "src/execution/verification.ts",
  "dist/execution/registered-verification.js",
] as const;

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function within(candidate: string, root: string): boolean {
  const relative = path.relative(pathKey(root), pathKey(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/[\r\n\t]+/g, " ")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>]+/g, "[local-path]")
    .slice(0, 500);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function canonicalDirectory(input: string, label: string): string {
  assert(typeof input === "string" && input.length > 0 && path.isAbsolute(input), `${label} must be absolute`);
  const requested = path.resolve(input);
  const stat = fs.lstatSync(requested);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), `${label} must be a regular directory`);
  const real = fs.realpathSync.native(requested);
  assert(samePath(real, requested), `${label} must not be a reparse-point alias`);
  return real;
}

function canonicalRegularFile(input: string, label: string): string {
  const requested = path.resolve(input);
  const stat = fs.lstatSync(requested);
  assert(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular file`);
  const real = fs.realpathSync.native(requested);
  assert(samePath(real, requested), `${label} must not be a reparse-point alias`);
  return real;
}

function assertBridgeEntrypoint(): void {
  const current = canonicalRegularFile(fileURLToPath(import.meta.url), "registered verifier");
  assert(samePath(current, BRIDGE_VERIFICATION_SCRIPT), "registered verifier is not the bridge-owned built script");
  assert(within(current, BRIDGE_REPOSITORY_ROOT), "registered verifier escaped the bridge repository");
}

/** Parse only the fixed flags emitted by the registered bridge profile. */
export function parseRegisteredVerificationArgs(argv: readonly string[]): RegisteredVerificationArgs {
  if (argv.length !== REGISTERED_VERIFICATION_ARGV.length) {
    throw new Error("registered verification received an unexpected argv length");
  }
  if (argv[0] !== "--workspace" || argv[2] !== "--runtime") {
    throw new Error("registered verification received an unsupported argv shape");
  }
  const workspaceRoot = argv[1];
  const runtimeRoot = argv[3];
  if (
    typeof workspaceRoot !== "string" ||
    typeof runtimeRoot !== "string" ||
    !path.isAbsolute(workspaceRoot) ||
    !path.isAbsolute(runtimeRoot) ||
    workspaceRoot.includes("\0") ||
    runtimeRoot.includes("\0")
  ) {
    throw new Error("registered verification paths must be absolute and valid");
  }
  return { workspaceRoot, runtimeRoot };
}

function setRuntimeStateRoot(runtimeRoot: string): string {
  const stateRoot = path.join(runtimeRoot, "state");
  ensureDir(stateRoot);
  const canonicalState = canonicalDirectory(stateRoot, "verification state root");
  assert(within(canonicalState, runtimeRoot), "verification state escaped the allowed runtime root");
  return canonicalState;
}

function assertRegularBridgeFile(file: string): void {
  const canonical = canonicalRegularFile(file, "built bridge runtime file");
  assert(within(canonical, BRIDGE_REPOSITORY_ROOT), "built runtime file escaped the bridge repository");
}

async function checkBuiltRuntimeImportable(): Promise<void> {
  const modules: Array<{ relativePath: string; exports: string[] }> = [
    { relativePath: "dist/execution/records.js", exports: ["appendExecutionRecord", "readExecutionRecords"] },
    { relativePath: "dist/execution/output.js", exports: ["saveExecutionOutput", "readExecutionOutput"] },
    { relativePath: "dist/execution/queue-state.js", exports: ["readWorkspaceQueuePauseState", "writeWorkspaceQueuePauseState"] },
    { relativePath: "dist/execution/slot.js", exports: ["acquireWorkspaceSlot", "reconcileWorkspaceSlot"] },
    { relativePath: "dist/execution/tasks.js", exports: ["CodexTaskManager"] },
    { relativePath: "dist/execution/pool.js", exports: ["CodexTaskManagerPool"] },
    { relativePath: "dist/execution/verification.js", exports: ["resolveDefaultVerificationProfile", "materializeVerificationProfile"] },
    { relativePath: "dist/session/registry.js", exports: ["C2CSessionRegistry"] },
    { relativePath: "dist/workspace/manager.js", exports: ["Workspace"] },
    { relativePath: "dist/mcp/server.js", exports: ["createMcpServer"] },
  ];
  assertRegularBridgeFile(BRIDGE_VERIFICATION_SCRIPT);
  for (const module of modules) {
    const file = path.join(BRIDGE_REPOSITORY_ROOT, module.relativePath);
    assertRegularBridgeFile(file);
    const namespace = await import(pathToFileURL(file).href) as Record<string, unknown>;
    for (const exportName of module.exports) {
      assert(typeof namespace[exportName] !== "undefined", `${module.relativePath} is missing ${exportName}`);
    }
  }
}

function workspaceSnapshot(workspaceRoot: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const relativePath of WATCHED_WORKSPACE_FILES) {
    const file = path.join(workspaceRoot, relativePath);
    try {
      const stat = fs.lstatSync(file);
      assert(stat.isFile() && !stat.isSymbolicLink(), `watched workspace path is not a regular file: ${relativePath}`);
      result.set(relativePath, `${stat.size}:${stat.mtimeMs}`);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        result.set(relativePath, "missing");
        continue;
      }
      throw error;
    }
  }
  return result;
}

function assertWorkspaceSnapshotUnchanged(before: Map<string, string>, workspaceRoot: string): void {
  const after = workspaceSnapshot(workspaceRoot);
  for (const [relativePath, value] of before) {
    assert(after.get(relativePath) === value, `registered verification modified workspace path: ${relativePath}`);
  }
}

function assertRuntimeTreeContained(runtimeRoot: string): void {
  const pending = [runtimeRoot];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      const stat = fs.lstatSync(child);
      assert(!stat.isSymbolicLink(), "verification runtime contains a reparse point");
      const canonical = fs.realpathSync.native(child);
      assert(within(canonical, runtimeRoot), "verification runtime escaped the allowed runtime root");
      if (stat.isDirectory()) pending.push(canonical);
    }
  }
}

function taskFile(workspaceId: string, taskId: string, stateDir: string): string {
  return path.join(stateDir, "tasks", workspaceId, `${taskId}.json`);
}

function syntheticTerminalTask(workspace: Workspace, sessionId: string): Record<string, unknown> {
  return {
    taskId: TASK_ID,
    workspaceId: workspace.id,
    ownerId: "registered-verification",
    sessionId,
    instruction: "verify terminal task reconciliation in process",
    instructionHash: "registered-verification-hash",
    writeScope: ["tests"],
    queuePosition: 1,
    fullAccess: false,
    networkRequested: false,
    networkEffective: false,
    networkReported: false,
    network: false,
    runTests: false,
    approvalMode: "workspace_write",
    status: "running",
    submittedAt: TERMINAL_TIMESTAMP,
    startedAt: TERMINAL_TIMESTAMP,
    changedFiles: [],
    tests: null,
    outputIds: [],
    approvalEvents: [],
    executionRecorded: false,
  };
}

async function checkTerminalReconciliation(workspace: Workspace, stateDir: string): Promise<void> {
  const sessions = new C2CSessionRegistry({ stateDir });
  const session = sessions.create({
    ownerId: "registered-verification",
    workspaceId: workspace.id,
    title: "registered verification",
    goalSummary: "verify terminal task reconciliation in process",
  });
  const file = taskFile(workspace.id, TASK_ID, stateDir);
  writeSecureJson(file, syntheticTerminalTask(workspace, session.id));
  appendExecutionRecord(workspace.id, {
    taskId: TASK_ID,
    workspaceId: workspace.id,
    ownerId: "registered-verification",
    sessionId: session.id,
    taskStatus: "failed",
    iteration: 1,
    changedFiles: ["tests/registered-verification.fixture"],
    tests: "terminal reconciliation checked",
    exitStatus: "blocked",
    timestamp: TERMINAL_TIMESTAMP,
    network: false,
  } satisfies ExecutionRecord, stateDir);
  acquireWorkspaceSlot(workspace.id, TASK_ID, stateDir);

  let manager: CodexTaskManager | null = null;
  try {
    manager = new CodexTaskManager(workspace, {
      stateDir,
      sessionRegistry: sessions,
      appServerFactory: () => {
        throw new Error("registered verification must not start an App Server");
      },
    });
    const repaired = manager.get(TASK_ID);
    assert(repaired.status === "failed", "terminal execution did not reconcile task status");
    assert(repaired.exitStatus === "blocked", "terminal execution lost its blocked exit status");
    assert(repaired.executionSummaryAvailable, "terminal task did not retain its execution summary truth");
    assert(readWorkspaceSlot(workspace.id, stateDir) === null, "terminal reconciliation did not release the workspace slot");
    const repairedSession = sessions.getOwned(session.id, "registered-verification", workspace.id);
    assert(repairedSession.lastTaskId === TASK_ID && repairedSession.currentState === "failed", "session truth did not follow the reconciled task");
    const records = readExecutionRecords(workspace.id, 100, stateDir).filter((record) => record.taskId === TASK_ID);
    assert(records.length === 1, "terminal reconciliation duplicated the execution record");
    const persisted = readJsonIfExists<Record<string, unknown>>(file);
    assert(persisted?.status === "failed" && persisted.executionRecorded === true, "reconciled task was not durably terminal");
  } finally {
    await manager?.close();
  }
}

function checkGhostLockCleanup(workspace: Workspace, stateDir: string): void {
  acquireWorkspaceSlot(workspace.id, GHOST_TASK_ID, stateDir);
  const result = reconcileWorkspaceSlot(workspace.id, () => null, stateDir);
  assert(result.cleared && result.reason === "missing_task", "missing-task ghost lock was not reconciled");
  assert(readWorkspaceSlot(workspace.id, stateDir) === null, "missing-task ghost lock remains after reconciliation");
}

async function checkQueueState(workspace: Workspace, stateDir: string): Promise<void> {
  const file = workspaceQueueStateFile(workspace.id, stateDir);
  fs.writeFileSync(file, "{ invalid queue state", { encoding: "utf8", mode: 0o600 });
  const invalid = readWorkspaceQueuePauseState(workspace.id, stateDir);
  assert(invalid.paused && invalid.reason === "invalid_state", "invalid queue state did not fail closed as paused");

  writeWorkspaceQueuePauseState(workspace.id, true, stateDir);
  const sessions = new C2CSessionRegistry({ stateDir });
  const manager = new CodexTaskManager(workspace, {
    stateDir,
    sessionRegistry: sessions,
    appServerFactory: () => {
      throw new Error("paused queue verification must not start an App Server");
    },
  });
  try {
    const loaded = manager.getQueueState();
    assert(loaded.paused && loaded.state === "paused", "persisted queue pause was not loaded by a new manager");
  } finally {
    await manager.close();
  }

  const resumed = writeWorkspaceQueuePauseState(workspace.id, false, stateDir);
  assert(!resumed.paused && readWorkspaceQueuePauseState(workspace.id, stateDir).paused === false, "queue resume state was not persisted");
}

function checkOutputNamespace(workspace: Workspace, stateDir: string): void {
  const primary = saveExecutionOutput(workspace.id, {
    command: "registered verification primary namespace",
    raw: "primary namespace output",
    exitCode: 0,
    taskId: TASK_ID,
    ownerId: "registered-verification",
  }, stateDir);
  const other = saveExecutionOutput(OTHER_OUTPUT_WORKSPACE_ID, {
    command: "registered verification other namespace",
    raw: "other namespace output",
    exitCode: 0,
    taskId: TASK_ID,
    ownerId: "registered-verification",
  }, stateDir);
  assert(primary.id === 1 && other.id === 1, "execution output ids are not isolated per workspace");
  const primaryRead = readExecutionOutput(workspace.id, primary.id, stateDir);
  const otherRead = readExecutionOutput(OTHER_OUTPUT_WORKSPACE_ID, other.id, stateDir);
  assert(primaryRead.ok && primaryRead.text === "primary namespace output", "primary output namespace was contaminated");
  assert(otherRead.ok && otherRead.text === "other namespace output", "secondary output namespace was contaminated");
  assert(listExecutionOutputs(workspace.id, 20, stateDir).length === 1 && listExecutionOutputs(OTHER_OUTPUT_WORKSPACE_ID, 20, stateDir).length === 1, "output indexes crossed workspace namespaces");
}

function checkVerificationPolicy(workspace: Workspace, runtimeRoot: string): RegisteredVerificationResult["policy"] {
  const profile = resolveDefaultVerificationProfile(workspace);
  assert(profile !== null, "the bridge verification profile is not registered");
  assert(profile.id === REGISTERED_VERIFICATION_PROFILE_ID, "the wrong bridge verification profile is registered");
  const launch = resolveBridgeVerificationLaunch();
  assert(launch !== null, "the bridge Node executable is unavailable");
  assert(profile.executable === launch.executable, "verification executable is not the bridge Node executable");
  assert(profile.argv.length === 5 && profile.argv[0] === BRIDGE_VERIFICATION_SCRIPT, "verification argv is not bridge-owned");
  assert(profile.argv[1] === "--workspace" && profile.argv[2] === "{workspace}", "verification workspace argument is not fixed");
  assert(profile.argv[3] === "--runtime" && profile.argv[4] === "{verification_root}", "verification runtime argument is not fixed");
  assert(profile.network === false && profile.sandbox === "workspaceWrite" && profile.cwd === "verification", "verification policy is not restricted");
  assert(!profile.argv.some((arg) => /(?:pnpm|corepack|vitest|vite|esbuild|git|npm|yarn|bun|powershell|cmd\.exe)/i.test(arg)), "verification argv contains a nested toolchain or shell");
  assert(!profile.argv.some((arg) => /[&|<>`;$\r\n]/.test(arg)), "verification argv contains shell syntax");
  const materialized = materializeVerificationProfile(profile, workspace, {
    root: runtimeRoot,
    temp: runtimeRoot,
    pytestTemp: runtimeRoot,
    cache: runtimeRoot,
    env: {},
  });
  assert(materialized.executable === launch.executable, "materialized executable changed the bridge-owned runtime");
  assert(materialized.argv[0] === BRIDGE_VERIFICATION_SCRIPT, "materialized verifier path changed");
  assert(materialized.argv[1] === "--workspace" && materialized.argv[2] === workspace.root, "materialized workspace path changed");
  assert(materialized.argv[3] === "--runtime" && materialized.argv[4] === runtimeRoot, "materialized runtime path changed");
  assert(materialized.cwd === runtimeRoot && materialized.cwdAlias === "c2c-runtime:/verification", "verification cwd escaped the runtime");
  assert(materialized.network === false && materialized.sandboxPolicy.networkAccess === false, "verification network policy was not false");
  assert(materialized.sandboxPolicy.type === "workspaceWrite", "verification sandbox type changed");
  assert(JSON.stringify(materialized.sandboxPolicy.writableRoots) === JSON.stringify([runtimeRoot]), "verification writable root changed");
  return {
    executable: "bridge-node",
    argv: [
      "bridge:/dist/execution/registered-verification.js",
      "--workspace",
      "workspace:/",
      "--runtime",
      "c2c-runtime:/verification",
    ],
    network: false,
    sandbox: "workspaceWrite",
    writableRoots: ["c2c-runtime:/verification"],
    shell: false,
    childProcessSpawning: false,
  };
}

function addCheck(checks: RegisteredVerificationCheck[], id: string): void {
  checks.push({ id, status: "passed" });
}

/**
 * Run deterministic, bridge-owned verification without starting a nested
 * toolchain. Every stateful API receives the verifier's private runtime state
 * root explicitly; no mutable process environment selects a second domain.
 */
export async function runRegisteredVerification(
  input: RegisteredVerificationArgs,
): Promise<RegisteredVerificationResult> {
  const checks: RegisteredVerificationCheck[] = [];
  try {
    const runtimeRoot = canonicalDirectory(input.runtimeRoot, "verification runtime root");
    const workspaceRoot = canonicalizeWorkspaceRoot(input.workspaceRoot);
    assert(!within(runtimeRoot, workspaceRoot), "verification runtime must remain outside the workspace");
    const stateRoot = setRuntimeStateRoot(runtimeRoot);
    assert(within(stateRoot, runtimeRoot), "verification state root escaped the runtime");

    const beforeWorkspace = workspaceSnapshot(workspaceRoot);
    const workspace = new Workspace(workspaceRoot);
    assert(samePath(workspace.root, BRIDGE_REPOSITORY_ROOT), "verification workspace identity is not the C2C bridge repository");
    assert(workspace.id === stableWorkspaceId(BRIDGE_REPOSITORY_ROOT), "verification workspace id does not match its canonical root");
    const packageJson = readJsonIfExists<{ name?: unknown }>(path.join(workspace.root, "package.json"));
    assert(packageJson?.name === "codex-with-chatgpt", "verification workspace package identity is unexpected");
    addCheck(checks, "workspace-identity");

    await checkBuiltRuntimeImportable();
    addCheck(checks, "built-runtime-importable");

    const policy = checkVerificationPolicy(workspace, runtimeRoot);
    addCheck(checks, "registered-policy-immutable");

    await checkTerminalReconciliation(workspace, stateRoot);
    addCheck(checks, "terminal-task-execution-reconciliation");

    checkGhostLockCleanup(workspace, stateRoot);
    addCheck(checks, "missing-task-ghost-lock-cleanup");

    await checkQueueState(workspace, stateRoot);
    addCheck(checks, "queue-state-fail-closed-and-load");

    checkOutputNamespace(workspace, stateRoot);
    addCheck(checks, "output-namespace-isolation");

    assertWorkspaceSnapshotUnchanged(beforeWorkspace, workspaceRoot);
    assertRuntimeTreeContained(runtimeRoot);
    addCheck(checks, "runtime-writes-contained");

    return {
      ok: true,
      profileId: REGISTERED_VERIFICATION_PROFILE_ID,
      workspaceId: workspace.id,
      executionMode: "in-process",
      nestedToolchain: false,
      checks,
      policy,
    };
  } catch (error) {
    throw new RegisteredVerificationError(safeErrorMessage(error), checks);
  }
}

async function main(): Promise<void> {
  try {
    assertBridgeEntrypoint();
    const args = parseRegisteredVerificationArgs(process.argv.slice(2));
    const result = await runRegisteredVerification(args);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const failure = error instanceof RegisteredVerificationError ? error : null;
    process.stderr.write(`${JSON.stringify({
      ok: false,
      profileId: REGISTERED_VERIFICATION_PROFILE_ID,
      checks: failure?.checks ?? [],
      error: safeErrorMessage(error),
    })}\n`);
    process.exitCode = 1;
  }
}

const runningAsMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return samePath(fileURLToPath(import.meta.url), process.argv[1]);
  } catch {
    return false;
  }
})();

if (runningAsMain) void main();
