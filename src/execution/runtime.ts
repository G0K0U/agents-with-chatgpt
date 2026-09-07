import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir } from "../config/paths.js";

/**
 * Runtime files used by the fixed Codex App Server child must not be created
 * in the connected workspace.  The workspace id is computed locally by
 * Workspace; it is never taken from an unvalidated remote path.
 */
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{12}$/;
// The original `runtime/workspaces` namespace was created while the Windows
// packaged and unpackaged state paths could alias one another.  Keep it
// untouched as recoverable legacy evidence and allocate all new runtime state
// in a bridge-owned namespace that cannot reuse those old directory entries.
export const CODEX_RUNTIME_NAMESPACE = "workspaces-v2";

export interface CodexRuntimeEnvironment {
  root: string;
  serenaHome: string;
  serenaProjectData: string;
  env: NodeJS.ProcessEnv;
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" || process.platform === "darwin"
    ? resolved.toLowerCase()
    : resolved;
}

function within(candidate: string, root: string): boolean {
  // Windows realpath preserves the spelling returned by the filesystem for
  // each component. A legitimate normal file can therefore differ in case
  // from the already-canonicalized runtime root; containment is still
  // checked on the same case-insensitive path model as Windows itself.
  const relative = path.relative(pathKey(root), pathKey(candidate));
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

function yamlSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function writeSecureText(file: string, content: string): void {
  ensureDir(path.dirname(file));
  // Runtime paths are bridge-owned. Never follow a pre-existing link/reparse
  // point here, otherwise a local filesystem mutation could redirect Serena's
  // state back into the connected workspace (or another user directory).
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error("C2C runtime configuration path is a symbolic link");
    if (stat.isDirectory()) throw new Error("C2C runtime configuration path is a directory");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      // The file is allowed not to exist yet.
    } else {
      throw error;
    }
  }
  fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort on platforms without chmod semantics
  }
}

/**
 * Prepare the C2C-owned runtime environment for one workspace.
 *
 * Serena officially supports SERENA_HOME and
 * project_serena_folder_location.  A per-workspace config keeps both its
 * global state and its project metadata under the C2C state directory.  The
 * external project directory is created before Serena starts so Serena's
 * fallback to <workspace>/.serena cannot select an old in-project directory.
 */
export function prepareCodexRuntime(
  workspaceRoot: string,
  workspaceId: string,
  stateDir?: string
): CodexRuntimeEnvironment {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new Error("Invalid workspace id for C2C runtime state");
  }

  const canonicalWorkspace = fs.realpathSync.native(path.resolve(workspaceRoot));
  const stateRoot = path.resolve(getStateDir(stateDir));
  const canonicalStateRoot = fs.realpathSync.native(ensureDir(stateRoot));
  const requestedRoot = path.resolve(stateRoot, "runtime", CODEX_RUNTIME_NAMESPACE, workspaceId);
  // Check the intended path before creating anything. This also catches a
  // state directory that is a symlink into the workspace.
  const intendedRoot = canonicalize(requestedRoot);
  if (!within(intendedRoot, canonicalStateRoot)) {
    throw new Error("C2C runtime state escaped its canonical state directory");
  }
  if (within(intendedRoot, canonicalWorkspace)) {
    throw new Error("C2C runtime state must be outside the connected workspace");
  }
  const root = ensureDir(requestedRoot);
  const canonicalRoot = fs.realpathSync.native(root);
  if (!within(canonicalRoot, canonicalStateRoot)) {
    throw new Error("C2C runtime state escaped its canonical state directory");
  }
  if (within(canonicalRoot, canonicalWorkspace)) {
    throw new Error("C2C runtime state must be outside the connected workspace");
  }

  const serenaHomePath = path.join(canonicalRoot, "serena");
  const serenaHome = ensureDir(serenaHomePath);
  const canonicalSerenaHome = fs.realpathSync.native(serenaHome);
  if (!within(canonicalSerenaHome, canonicalRoot) || within(canonicalSerenaHome, canonicalWorkspace)) {
    throw new Error("C2C Serena runtime path escaped its external runtime root");
  }
  const serenaProjectDataPath = path.join(canonicalSerenaHome, "projects", workspaceId, ".serena");
  const serenaProjectData = ensureDir(serenaProjectDataPath);
  const canonicalSerenaProjectData = fs.realpathSync.native(serenaProjectData);
  if (!within(canonicalSerenaProjectData, canonicalRoot) || within(canonicalSerenaProjectData, canonicalWorkspace)) {
    throw new Error("C2C Serena project data escaped its external runtime root");
  }
  const serenaConfigPath = path.join(canonicalSerenaHome, "serena_config.yml");
  const canonicalConfigParent = fs.realpathSync.native(path.dirname(serenaConfigPath));
  if (!within(canonicalConfigParent, canonicalRoot) || within(canonicalConfigParent, canonicalWorkspace)) {
    throw new Error("C2C Serena configuration escaped its external runtime root");
  }
  try {
    const canonicalConfig = fs.realpathSync.native(serenaConfigPath);
    if (!within(canonicalConfig, canonicalRoot) || within(canonicalConfig, canonicalWorkspace)) {
      throw new Error("C2C Serena configuration escaped its external runtime root");
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
      throw error;
    }
  }
  const serenaConfig = [
    "# Managed by codex-with-chatgpt for this C2C workspace.",
    "# Serena project data must remain outside the connected workspace.",
    `project_serena_folder_location: ${yamlSingleQuote(canonicalSerenaProjectData)}`,
    "trusted_project_path_patterns: []",
    "projects: []",
    "web_dashboard: false",
    "web_dashboard_open_on_launch: false",
    "gui_log_window: false",
    "",
  ].join("\n");
  writeSecureText(serenaConfigPath, serenaConfig);

  return {
    root: canonicalRoot,
    serenaHome: canonicalSerenaHome,
    serenaProjectData: canonicalSerenaProjectData,
    env: {
      SERENA_HOME: canonicalSerenaHome,
    },
  };
}
