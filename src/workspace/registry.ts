import fs from "node:fs";
import path from "node:path";
import { canonicalizeWorkspaceRoot, stableWorkspaceId } from "./identity.js";
import { Workspace } from "./manager.js";
import { getStateDir, writeSecureJson } from "../config/paths.js";

export type WorkspaceRegistryErrorCode =
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_NOT_AUTHORIZED"
  | "WORKSPACE_REQUIRED"
  | "WORKSPACE_REGISTRY_INVALID"
  | "WORKSPACE_ROOT_INVALID";

export class WorkspaceRegistryError extends Error {
  constructor(public readonly code: WorkspaceRegistryErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceRegistryError";
  }
}

export interface RegisteredWorkspace {
  id: string;
  name: string;
  canonicalPath: string;
  enabled: boolean;
  createdAt: string;
}

export interface AuthorizedWorkspaceMetadata {
  id: string;
  name: string;
  enabled: boolean;
}

interface PersistedWorkspaceRegistry {
  version: 1;
  workspaces: RegisteredWorkspace[];
}

const ID_PATTERN = /^[0-9a-f]{12}$/;
const MAX_NAME_LENGTH = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRegistryFile(file: string): Partial<PersistedWorkspaceRegistry> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PersistedWorkspaceRegistry>;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new WorkspaceRegistryError("WORKSPACE_REGISTRY_INVALID", "Workspace registry cannot be read");
  }
}

function normalizedName(name: string): string {
  const value = name.trim().replace(/[\r\n\t]+/g, " ").slice(0, MAX_NAME_LENGTH);
  if (!value) throw new WorkspaceRegistryError("WORKSPACE_REGISTRY_INVALID", "Workspace name cannot be empty");
  return value;
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}

function validateRecord(value: unknown): RegisteredWorkspace {
  if (!isRecord(value)) throw new WorkspaceRegistryError("WORKSPACE_REGISTRY_INVALID", "Invalid workspace registry entry");
  const { id, name, canonicalPath, enabled, createdAt } = value;
  if (
    typeof id !== "string" ||
    !ID_PATTERN.test(id) ||
    typeof name !== "string" ||
    typeof canonicalPath !== "string" ||
    !path.isAbsolute(canonicalPath) ||
    typeof enabled !== "boolean" ||
    typeof createdAt !== "string"
  ) {
    throw new WorkspaceRegistryError("WORKSPACE_REGISTRY_INVALID", "Invalid workspace registry entry");
  }
  return {
    id,
    name: normalizedName(name),
    canonicalPath: path.resolve(canonicalPath),
    enabled,
    createdAt,
  };
}

/**
 * Persistent, bridge-owned workspace registry. There is intentionally no
 * remote registration API: registerTrusted is called only during local
 * bootstrap/configuration.
 */
export class WorkspaceRegistry {
  readonly file: string;
  private readonly records = new Map<string, RegisteredWorkspace>();
  private readonly ephemeral: boolean;

  constructor(opts: { file?: string; initial?: RegisteredWorkspace[]; stateDir?: string } = {}) {
    this.file = opts.file ?? path.join(getStateDir(opts.stateDir), "workspaces.json");
    this.ephemeral = opts.initial !== undefined;
    if (opts.initial) {
      for (const entry of opts.initial) this.addValidated(entry);
      return;
    }
    this.load();
  }

  private addValidated(entry: RegisteredWorkspace): void {
    if (this.records.has(entry.id)) {
      throw new WorkspaceRegistryError("WORKSPACE_REGISTRY_INVALID", `Duplicate workspace id: ${entry.id}`);
    }
    if ([...this.records.values()].some((existing) => pathKey(existing.canonicalPath) === pathKey(entry.canonicalPath))) {
      throw new WorkspaceRegistryError("WORKSPACE_REGISTRY_INVALID", "Duplicate workspace root in registry");
    }
    this.records.set(entry.id, { ...entry });
  }

  private load(): void {
    const data = readRegistryFile(this.file);
    if (!data) return;
    if (data.version !== undefined && data.version !== 1) {
      throw new WorkspaceRegistryError("WORKSPACE_REGISTRY_INVALID", "Unsupported workspace registry version");
    }
    if (!Array.isArray(data.workspaces)) {
      throw new WorkspaceRegistryError("WORKSPACE_REGISTRY_INVALID", "Workspace registry must contain workspaces");
    }
    let changed = false;
    for (const raw of data.workspaces) {
      const entry = validateRecord(raw);
      // A configured symlink/junction is canonicalized on load. The id is
      // checked against the canonical target so a root cannot be spoofed.
      try {
        const canonical = canonicalizeWorkspaceRoot(entry.canonicalPath);
        if (stableWorkspaceId(canonical) !== entry.id) {
          throw new WorkspaceRegistryError("WORKSPACE_REGISTRY_INVALID", "Workspace root identity does not match its stable id");
        }
        if (canonical !== entry.canonicalPath) {
          entry.canonicalPath = canonical;
          changed = true;
        }
      } catch (error) {
        if (error instanceof WorkspaceRegistryError) throw error;
        if (stableWorkspaceId(entry.canonicalPath) !== entry.id) {
          throw new WorkspaceRegistryError("WORKSPACE_REGISTRY_INVALID", "Workspace root identity does not match its stable id");
        }
        // Keep a missing root in the registry so it can be reported as a
        // deterministic WORKSPACE_NOT_FOUND. It is never selected silently.
      }
      this.addValidated(entry);
    }
    if (changed) this.save();
  }

  private save(): void {
    if (this.ephemeral) return;
    const state: PersistedWorkspaceRegistry = {
      version: 1,
      workspaces: [...this.records.values()].map((entry) => ({ ...entry })),
    };
    writeSecureJson(this.file, state);
  }

  /** Local-only trusted registration used by the bootstrap process. */
  registerTrusted(input: { name: string; canonicalPath: string; id?: string; enabled?: boolean }): RegisteredWorkspace {
    let canonicalPath: string;
    try {
      canonicalPath = canonicalizeWorkspaceRoot(input.canonicalPath);
    } catch (error) {
      throw new WorkspaceRegistryError(
        "WORKSPACE_ROOT_INVALID",
        error instanceof Error ? error.message : "Workspace root is invalid"
      );
    }
    const id = stableWorkspaceId(canonicalPath);
    if (input.id !== undefined && input.id !== id) {
      throw new WorkspaceRegistryError("WORKSPACE_REGISTRY_INVALID", "Requested workspace id does not match its canonical root");
    }
    const existing = this.records.get(id);
    if (existing) {
      if (pathKey(existing.canonicalPath) !== pathKey(canonicalPath)) {
        throw new WorkspaceRegistryError("WORKSPACE_REGISTRY_INVALID", "Workspace id is already bound to another root");
      }
      const updated = { ...existing, name: normalizedName(input.name), enabled: input.enabled ?? existing.enabled };
      this.records.set(id, updated);
      this.save();
      return { ...updated };
    }
    if ([...this.records.values()].some((entry) => pathKey(entry.canonicalPath) === pathKey(canonicalPath))) {
      throw new WorkspaceRegistryError("WORKSPACE_REGISTRY_INVALID", "Workspace root is already registered under another id");
    }
    const entry: RegisteredWorkspace = {
      id,
      name: normalizedName(input.name),
      canonicalPath,
      enabled: input.enabled ?? true,
      createdAt: new Date().toISOString(),
    };
    this.records.set(id, entry);
    this.save();
    return { ...entry };
  }

  /** Idempotent local bootstrap for a pre-authorized set of workspaces. */
  bootstrap(entries: Array<{ name: string; canonicalPath: string; id?: string; enabled?: boolean }>): RegisteredWorkspace[] {
    return entries.map((entry) => this.registerTrusted(entry));
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  get(id: string): RegisteredWorkspace {
    const entry = this.records.get(id);
    if (!entry) throw new WorkspaceRegistryError("WORKSPACE_NOT_FOUND", "Unknown workspace");
    return { ...entry };
  }

  getWorkspace(id: string): Workspace {
    const entry = this.get(id);
    if (!entry.enabled) throw new WorkspaceRegistryError("WORKSPACE_NOT_FOUND", "Workspace is disabled");
    let workspace: Workspace;
    try {
      workspace = new Workspace(entry.canonicalPath);
    } catch {
      throw new WorkspaceRegistryError("WORKSPACE_NOT_FOUND", "Workspace root is unavailable");
    }
    if (workspace.id !== entry.id || pathKey(workspace.root) !== pathKey(entry.canonicalPath)) {
      throw new WorkspaceRegistryError("WORKSPACE_REGISTRY_INVALID", "Workspace root identity changed");
    }
    return workspace;
  }

  listMetadata(): AuthorizedWorkspaceMetadata[] {
    return [...this.records.values()].map(({ id, name, enabled }) => ({ id, name, enabled }));
  }

  enabledIds(): string[] {
    return [...this.records.values()].filter((entry) => entry.enabled).map((entry) => entry.id);
  }

  metadataFor(ids: Iterable<string>): AuthorizedWorkspaceMetadata[] {
    const allowed = new Set(ids);
    return this.listMetadata().filter((entry) => allowed.has(entry.id));
  }

  /** A remote workspace id is valid only if it exists and is enabled. */
  assertExists(id: string): void {
    const entry = this.records.get(id);
    if (!entry || !entry.enabled) throw new WorkspaceRegistryError("WORKSPACE_NOT_FOUND", "Unknown workspace");
  }
}

/** Sanitize a record for MCP responses; canonicalPath never crosses this boundary. */
export function publicWorkspaceMetadata(entry: RegisteredWorkspace): AuthorizedWorkspaceMetadata {
  return { id: entry.id, name: entry.name, enabled: entry.enabled };
}
