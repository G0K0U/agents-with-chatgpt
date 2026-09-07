import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import readline from "node:readline";
import { IgnoreRules } from "./ignore.js";
import { canonicalizeWorkspaceRoot, stableWorkspaceId } from "./identity.js";
import { readJsonIfExists } from "../config/paths.js";

export type WorkspaceErrorCode =
  | "INVALID_PATH"
  | "PATH_OUTSIDE_WORKSPACE"
  | "ACCESS_DENIED_SENSITIVE_FILE"
  | "FILE_NOT_FOUND"
  | "NOT_A_FILE"
  | "NOT_A_DIRECTORY"
  | "BINARY_FILE"
  | "FILE_TOO_LARGE";

export class WorkspaceError extends Error {
  constructor(
    public code: WorkspaceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export interface ReadFileResult {
  path: string;
  sizeBytes: number;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  remainingLines: number;
  nextStartLine: number | null;
  content: string;
}

export interface DirEntry {
  path: string;
  type: "file" | "dir";
  sizeBytes?: number;
}

export interface ListDirectoryResult {
  path: string;
  entries: DirEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface ProjectConfig {
  name?: string;
  maxIterations?: number;
}

const DEFAULT_MAX_LINES = 400;
const HARD_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 256 * 1024;

export class Workspace {
  readonly root: string;
  readonly id: string;
  readonly name: string;
  readonly ignoreRules: IgnoreRules;
  readonly projectConfig: ProjectConfig;

  constructor(rootInput: string) {
    let real: string;
    try {
      real = canonicalizeWorkspaceRoot(rootInput);
    } catch {
      throw new WorkspaceError("FILE_NOT_FOUND", `Workspace root does not exist: ${rootInput}`);
    }
    this.root = real;
    this.id = stableWorkspaceId(real);
    this.ignoreRules = new IgnoreRules(real);
    this.projectConfig = readJsonIfExists<ProjectConfig>(path.join(real, ".c2c.json")) ?? {};
    this.name = this.projectConfig.name ?? path.basename(real);
  }

  private contains(candidate: string): boolean {
    const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
    const r = caseInsensitive ? this.root.toLowerCase() : this.root;
    const c = caseInsensitive ? candidate.toLowerCase() : candidate;
    return c === r || c.startsWith(r + path.sep);
  }

  /**
   * Canonicalize a path by realpath-ing its deepest existing ancestor.
   * Defends against symlink escapes even for not-yet-existing leaf segments.
   */
  private canonicalize(abs: string): string {
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

  /**
   * Resolve an untrusted path to a canonical absolute path inside the workspace.
   * Throws PATH_OUTSIDE_WORKSPACE or ACCESS_DENIED_SENSITIVE_FILE.
   */
  resolve(requested: string, opts: { allowSensitive?: boolean } = {}): { abs: string; rel: string } {
    if (typeof requested !== "string" || requested.includes("\0")) {
      throw new WorkspaceError("INVALID_PATH", "Invalid path");
    }
    let p = requested.trim();
    if (p === "" || p === "/") p = ".";
    // Normalize separators so Windows-style input behaves identically everywhere.
    p = p.replace(/\\/g, "/");
    // Strip a "workspace:/" alias prefix if the model echoes it back.
    p = p.replace(/^workspace:\/*/i, "");
    if (p === "") p = ".";

    const abs = path.resolve(this.root, p);
    const canonical = this.canonicalize(abs);
    if (!this.contains(canonical)) {
      throw new WorkspaceError(
        "PATH_OUTSIDE_WORKSPACE",
        `Path resolves outside the connected workspace: ${requested}`
      );
    }
    const rel = path.relative(this.root, canonical).split(path.sep).join("/");
    if (rel.startsWith("..")) {
      throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", `Path resolves outside the connected workspace: ${requested}`);
    }
    if (!opts.allowSensitive && rel !== "" && this.ignoreRules.isSensitive(rel)) {
      throw new WorkspaceError(
        "ACCESS_DENIED_SENSITIVE_FILE",
        `ACCESS_DENIED_SENSITIVE_FILE: '${rel}' matches the sensitive-file policy and cannot be read.`
      );
    }
    return { abs: canonical, rel };
  }

  private async isBinary(abs: string): Promise<boolean> {
    const fd = await fs.promises.open(abs, "r");
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0) return true;
      }
      return false;
    } finally {
      await fd.close();
    }
  }

  async readFile(
    requested: string,
    opts: { startLine?: number; endLine?: number; maxLines?: number; maxBytes?: number } = {}
  ): Promise<ReadFileResult> {
    const { abs, rel } = this.resolve(requested);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(abs);
    } catch {
      throw new WorkspaceError("FILE_NOT_FOUND", `File not found: ${rel}`);
    }
    if (!stat.isFile()) {
      throw new WorkspaceError("NOT_A_FILE", `Not a regular file: ${rel}`);
    }
    if (await this.isBinary(abs)) {
      throw new WorkspaceError("BINARY_FILE", `Binary file (${stat.size} bytes): ${rel}. Content is not returned.`);
    }

    const startLine = Math.max(1, Math.floor(opts.startLine ?? 1));
    const maxLines = Math.min(HARD_MAX_LINES, Math.max(1, Math.floor(opts.maxLines ?? DEFAULT_MAX_LINES)));
    const endLimit = opts.endLine
      ? Math.min(Math.floor(opts.endLine), startLine + HARD_MAX_LINES - 1)
      : startLine + maxLines - 1;
    const maxBytes = Math.min(1024 * 1024, Math.max(1024, Math.floor(opts.maxBytes ?? DEFAULT_MAX_BYTES)));

    const lines: string[] = [];
    let totalLines = 0;
    let collectedBytes = 0;
    let byteTruncated = false;
    let actualEnd = startLine - 1;

    const stream = fs.createReadStream(abs, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      totalLines++;
      if (totalLines >= startLine && totalLines <= endLimit && !byteTruncated) {
        const cost = Buffer.byteLength(line, "utf8") + 1;
        if (collectedBytes + cost > maxBytes && lines.length > 0) {
          byteTruncated = true;
        } else {
          lines.push(line);
          collectedBytes += cost;
          actualEnd = totalLines;
        }
      }
    }
    rl.close();

    const remaining = Math.max(0, totalLines - actualEnd);
    return {
      path: rel,
      sizeBytes: stat.size,
      totalLines,
      startLine: Math.min(startLine, Math.max(totalLines, 1)),
      endLine: actualEnd,
      truncated: remaining > 0,
      remainingLines: remaining,
      nextStartLine: remaining > 0 ? actualEnd + 1 : null,
      content: lines.join("\n"),
    };
  }

  async listDirectory(
    requested: string,
    opts: { depth?: number; limit?: number; offset?: number } = {}
  ): Promise<ListDirectoryResult> {
    const { abs, rel } = this.resolve(requested);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(abs);
    } catch {
      throw new WorkspaceError("FILE_NOT_FOUND", `Directory not found: ${rel || "."}`);
    }
    if (!stat.isDirectory()) {
      throw new WorkspaceError("NOT_A_DIRECTORY", `Not a directory: ${rel}`);
    }
    const depth = Math.min(4, Math.max(1, Math.floor(opts.depth ?? 1)));
    const limit = Math.min(1000, Math.max(1, Math.floor(opts.limit ?? 200)));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));

    const all: DirEntry[] = [];
    const walk = async (dirAbs: string, dirRel: string, level: number): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1;
        const bd = b.isDirectory() ? 0 : 1;
        return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
      });
      for (const entry of entries) {
        const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
        if (this.ignoreRules.isHidden(childRel) || this.ignoreRules.isHidden(childRel + "/")) continue;
        if (entry.isDirectory()) {
          all.push({ path: childRel + "/", type: "dir" });
          if (level < depth) await walk(path.join(dirAbs, entry.name), childRel, level + 1);
        } else if (entry.isFile()) {
          let size: number | undefined;
          try {
            size = (await fs.promises.stat(path.join(dirAbs, entry.name))).size;
          } catch {
            size = undefined;
          }
          all.push({ path: childRel, type: "file", sizeBytes: size });
        }
        if (all.length >= offset + limit + 2000) return; // hard cap for huge trees
      }
    };
    await walk(abs, rel, 1);

    const page = all.slice(offset, offset + limit);
    return {
      path: rel || ".",
      entries: page,
      total: all.length,
      offset,
      limit,
      hasMore: offset + page.length < all.length,
    };
  }

  /** Lightweight project detection for workspace_info. */
  detectProject(): {
    projectType: string;
    languages: string[];
    frameworks: string[];
    packageManager: string | null;
    packageManagers: string[];
    manifests: string[];
    scripts: Record<string, string>;
  } {
    const has = (f: string): boolean => fs.existsSync(path.join(this.root, f));
    const languages = new Set<string>();
    const frameworks = new Set<string>();
    const packageManagers = new Set<string>();
    const manifests: string[] = [];
    let projectType = "unknown";
    let packageManager: string | null = null;
    let scripts: Record<string, string> = {};

    if (has("package.json")) {
      manifests.push("package.json");
      projectType = "node";
      languages.add("JavaScript");
      const pkg = readJsonIfExists<{
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      }>(path.join(this.root, "package.json"));
      scripts = pkg?.scripts ?? {};
      const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
      const known: Record<string, string> = {
        next: "Next.js",
        react: "React",
        vue: "Vue",
        svelte: "Svelte",
        express: "Express",
        fastify: "Fastify",
        "@nestjs/core": "NestJS",
        electron: "Electron",
        vitest: "Vitest",
        jest: "Jest",
      };
      for (const [dep, label] of Object.entries(known)) {
        if (deps[dep]) frameworks.add(label);
      }
      if (has("pnpm-lock.yaml")) packageManagers.add("pnpm");
      else if (has("yarn.lock")) packageManagers.add("yarn");
      else if (has("bun.lockb") || has("bun.lock")) packageManagers.add("bun");
      else if (has("package-lock.json")) packageManagers.add("npm");
    }
    if (has("tsconfig.json")) {
      manifests.push("tsconfig.json");
      languages.add("TypeScript");
    }
    if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) {
      if (has("pyproject.toml")) manifests.push("pyproject.toml");
      if (has("uv.lock")) {
        manifests.push("uv.lock");
        packageManagers.add("uv");
      }
      if (has("requirements.txt")) manifests.push("requirements.txt");
      if (has("setup.py")) manifests.push("setup.py");
      languages.add("Python");
      if (projectType === "unknown") projectType = "python";
    }
    if (has("Makefile")) {
      manifests.push("Makefile");
      scripts.test ??= "make test";
    }
    if (has("apps/web/package.json")) {
      manifests.push("apps/web/package.json");
      const webPackage = readJsonIfExists<{
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      }>(path.join(this.root, "apps/web/package.json"));
      if (has("apps/web/pnpm-lock.yaml")) {
        manifests.push("apps/web/pnpm-lock.yaml");
        packageManagers.add("pnpm");
      }
      languages.add("JavaScript");
      if (has("apps/web/tsconfig.json")) {
        manifests.push("apps/web/tsconfig.json");
        languages.add("TypeScript");
      }
      const webDeps = { ...(webPackage?.dependencies ?? {}), ...(webPackage?.devDependencies ?? {}) };
      if (webDeps.react) frameworks.add("React");
      if (webDeps.next) frameworks.add("Next.js");
      for (const [name, command] of Object.entries(webPackage?.scripts ?? {})) {
        scripts[`apps/web:${name}`] = command;
      }
    }
    if (has("Cargo.toml")) {
      languages.add("Rust");
      if (projectType === "unknown") projectType = "rust";
    }
    if (has("go.mod")) {
      languages.add("Go");
      if (projectType === "unknown") projectType = "go";
    }
    if (has("Package.swift")) {
      languages.add("Swift");
      if (projectType === "unknown") projectType = "swift";
    }
    packageManager = packageManagers.size > 0 ? [...packageManagers][0] : null;
    return {
      projectType,
      languages: [...languages],
      frameworks: [...frameworks],
      packageManager,
      packageManagers: [...packageManagers],
      manifests: [...new Set(manifests)],
      scripts,
    };
  }
}
