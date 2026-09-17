import fs from "node:fs";
import path from "node:path";
import { canonicalizeWorkspaceRoot, stableWorkspaceId } from "../workspace/identity.js";
import { writeSecureJson, ensureDir } from "../config/paths.js";
import type { Workspace } from "../workspace/manager.js";
import {
  assertVerificationProfile,
  resolveDefaultVerificationProfile,
  type VerificationProfile,
} from "./verification.js";

/**
 * Trusted LOCAL OPERATOR verification registry (F01).
 *
 * A verification profile is what turns run_tests=true into a real, workspace-
 * appropriate test command. The bridge-owned defaults only cover the C2C
 * bridge repository itself and the operator-configured Engineering AI
 * workspace; every OTHER workspace previously resolved to null and every
 * run_tests=true task failed closed with NO_VERIFICATION_PROFILE.
 *
 * This registry lets the local operator register one profile per workspace
 * WITHOUT ever letting task input define executable code:
 *
 *  - Profiles live in the C2C state directory (outside every target
 *    repository), mode 0600, written only by operator-invoked CLI commands.
 *  - A task's sandbox never includes the state directory, and the profile is
 *    re-validated on EVERY read, so a task cannot mutate a profile and then
 *    gain execution capability.
 *  - The record binds the canonical workspace identity (stableWorkspaceId of
 *    the registered root); it resolves for that workspace only.
 *  - Executable policy: a plain basename (PATH-resolved, no shell), the
 *    bridge Node runtime, or an absolute path to an existing regular file
 *    that is not a shell-dependent script. Shell-dependent extensions
 *    (.cmd/.bat/.ps1/...) are rejected; argv is a structured vector and is
 *    never interpreted by a shell.
 *  - Network is always false; timeout and sandbox are explicit.
 *
 * Built-in defaults keep precedence rules simple: an operator registration,
 * when present and valid, is used; otherwise resolveDefaultVerificationProfile
 * applies as before.
 */

export const OPERATOR_VERIFICATION_SCHEMA = 1 as const;

export interface OperatorVerificationRecord {
  schema: typeof OPERATOR_VERIFICATION_SCHEMA;
  /** stableWorkspaceId of the registered workspace root. */
  workspaceId: string;
  /** Canonical workspace root recorded at registration time. */
  workspaceRoot: string;
  id: string;
  executable: string;
  argv: string[];
  cwd: "workspace" | "verification";
  timeoutMs: number;
  network: false;
  sandbox: "readOnly" | "workspaceWrite";
  summaryKind: "pytest" | "generic";
  registeredAt: string;
  updatedAt: string;
}

export class OperatorVerificationError extends Error {
  constructor(message: string, readonly code: "INVALID_RECORD" | "NOT_REGISTERED" | "WORKSPACE_MISMATCH") {
    super(message);
    this.name = "OperatorVerificationError";
  }
}

export function operatorVerificationDir(stateDir?: string): string {
  const base = stateDir ?? process.env.C2C_STATE_DIR ?? "";
  if (!base) throw new Error("C2C state directory is not available");
  return path.join(base, "verification-profiles");
}

export function operatorVerificationFile(workspaceId: string, stateDir?: string): string {
  if (!/^[0-9a-f]{12}$/.test(workspaceId)) throw new Error("Invalid workspace id");
  return path.join(operatorVerificationDir(stateDir), `${workspaceId}.json`);
}

function parseRecord(value: unknown): OperatorVerificationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OperatorVerificationError("operator verification record is not an object", "INVALID_RECORD");
  }
  const row = value as Partial<OperatorVerificationRecord>;
  if (row.schema !== OPERATOR_VERIFICATION_SCHEMA ||
      typeof row.workspaceId !== "string" || !/^[0-9a-f]{12}$/.test(row.workspaceId) ||
      typeof row.workspaceRoot !== "string" || !path.isAbsolute(row.workspaceRoot) ||
      typeof row.id !== "string" || row.id.length === 0 ||
      !Array.isArray(row.argv) || row.argv.some((arg) => typeof arg !== "string") ||
      (row.cwd !== "workspace" && row.cwd !== "verification") ||
      typeof row.timeoutMs !== "number" || !Number.isInteger(row.timeoutMs) ||
      row.network !== false ||
      (row.sandbox !== "readOnly" && row.sandbox !== "workspaceWrite") ||
      (row.summaryKind !== "pytest" && row.summaryKind !== "generic") ||
      typeof row.registeredAt !== "string" || typeof row.updatedAt !== "string") {
    throw new OperatorVerificationError("operator verification record has an invalid shape", "INVALID_RECORD");
  }
  return row as OperatorVerificationRecord;
}

/**
 * Read + fully validate the operator profile for one workspace. Throws (never
 * returns a weakened profile) when the record is missing, tampered with, or
 * no longer matches the workspace identity.
 */
export function readOperatorVerificationProfile(
  workspaceId: string,
  stateDir?: string,
): OperatorVerificationRecord {
  const file = operatorVerificationFile(workspaceId, stateDir);
  if (!fs.existsSync(file)) {
    throw new OperatorVerificationError(`no operator verification profile is registered for workspace ${workspaceId}`, "NOT_REGISTERED");
  }
  // A file that exists but cannot be parsed is TAMPERING, not absence: it
  // must fail closed loudly instead of silently degrading to "not
  // registered" (which would fall back to a weaker default profile).
  const raw = fs.readFileSync(file, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new OperatorVerificationError("operator verification record is not valid JSON", "INVALID_RECORD");
  }
  const record = parseRecord(value);
  // Identity binding: the record resolves only for the exact canonical root
  // it was registered against.
  if (stableWorkspaceId(record.workspaceRoot) !== record.workspaceId) {
    throw new OperatorVerificationError("operator verification record workspace identity mismatch", "WORKSPACE_MISMATCH");
  }
  // Full policy validation on every read: a tampered record fails closed
  // instead of executing.
  try {
    assertVerificationProfile(toVerificationProfile(record));
  } catch (error) {
    throw new OperatorVerificationError(
      `operator verification record failed policy validation: ${error instanceof Error ? error.message : String(error)}`,
      "INVALID_RECORD",
    );
  }
  return record;
}

export function toVerificationProfile(record: OperatorVerificationRecord): VerificationProfile {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    executable: record.executable,
    argv: record.argv,
    cwd: record.cwd,
    timeoutMs: record.timeoutMs,
    network: false,
    sandbox: record.sandbox,
    summaryKind: record.summaryKind,
  };
}

export interface RegisterOperatorVerificationInput {
  workspaceRoot: string;
  id?: string;
  executable: string;
  argv: readonly string[];
  cwd: "workspace" | "verification";
  timeoutMs: number;
  sandbox: "readOnly" | "workspaceWrite";
  summaryKind: "pytest" | "generic";
}

/**
 * Register or replace the operator profile for a workspace. Registration is
 * the operator's trust decision: the record is validated here (executable
 * exists, is not a shell script; argv bounded; timeout bounded) so that a
 * later task can only ever run exactly what was registered.
 */
export function registerOperatorVerificationProfile(
  input: RegisterOperatorVerificationInput,
  stateDir?: string,
): OperatorVerificationRecord {
  const root = canonicalizeWorkspaceRoot(input.workspaceRoot);
  const workspaceId = stableWorkspaceId(root);
  const record: OperatorVerificationRecord = {
    schema: OPERATOR_VERIFICATION_SCHEMA,
    workspaceId,
    workspaceRoot: root,
    id: input.id ?? "operator",
    executable: input.executable,
    argv: [...input.argv],
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    network: false,
    sandbox: input.sandbox,
    summaryKind: input.summaryKind,
    registeredAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  assertVerificationProfile(toVerificationProfile(record));
  const file = operatorVerificationFile(workspaceId, stateDir);
  ensureDir(path.dirname(file));
  // Preserve first-registration time across updates. A TAMPERED record is
  // never silently overwritten: the operator must remove it explicitly first.
  try {
    record.registeredAt = readOperatorVerificationProfile(workspaceId, stateDir).registeredAt;
  } catch (error) {
    if (!(error instanceof OperatorVerificationError) || error.code !== "NOT_REGISTERED") throw error;
  }
  writeSecureJson(file, record);
  return record;
}

export function removeOperatorVerificationProfile(workspaceId: string, stateDir?: string): boolean {
  const file = operatorVerificationFile(workspaceId, stateDir);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

/** All operator registrations with their validity (list view, never throws). */
export function listOperatorVerificationProfiles(stateDir?: string): Array<{
  record: OperatorVerificationRecord | null;
  file: string;
  error: string | null;
}> {
  const dir = operatorVerificationDir(stateDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ record: OperatorVerificationRecord | null; file: string; error: string | null }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(dir, entry.name);
    try {
      const raw = fs.readFileSync(file, "utf8");
      out.push({ record: parseRecord(JSON.parse(raw)), file, error: null });
    } catch (error) {
      out.push({ record: null, file, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Resolution chain for run_tests: the trusted operator registration first,
 * then the bridge-owned defaults (C2C bridge repository self-check, operator-
 * configured Engineering AI profile). Returns null when nothing is
 * registered — the task then fails closed with NO_VERIFICATION_PROFILE.
 */
export function resolveVerificationProfile(
  workspace: Workspace,
  stateDir?: string,
): VerificationProfile | null {
  try {
    const record = readOperatorVerificationProfile(workspace.id, stateDir);
    if (canonicalizeWorkspaceRoot(workspace.root) !== record.workspaceRoot) {
      throw new OperatorVerificationError("operator verification record does not match the connected workspace root", "WORKSPACE_MISMATCH");
    }
    return toVerificationProfile(record);
  } catch (error) {
    if (error instanceof OperatorVerificationError && error.code === "NOT_REGISTERED") {
      return resolveDefaultVerificationProfile(workspace);
    }
    throw error;
  }
}
