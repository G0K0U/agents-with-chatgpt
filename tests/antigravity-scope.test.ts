/**
 * Round 3 — Antigravity write-scope enforcement negative tests.
 *
 * Self-contained temp fixtures only (no real user files, no real agy runs).
 * Properties under test:
 * - Pre-existing files at out-of-bounds targets SURVIVE read/write/command
 *   denial with an unchanged content hash (the old code unlinkSync'ed them).
 * - Both out-of-bounds categories: outside the workspace, and inside the
 *   workspace but outside the declared write scope.
 * - Junction/symlink escape attempts are denied via real-path resolution.
 * - Sub-scope tasks are rejected pre-execution (fail closed, no spawn).
 * - Git status parsing and content-signature change detection are correct
 *   for already-dirty files, spaces, and renames.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import {
  AntigravityBackend,
  evaluateAntigravityToolScope,
  verifyWriteScopePreflight,
  realTargetWithinRoots,
  realPathIfExists,
  extractCandidatePathsFromCommand,
  parseGitStatusEntries,
  fileContentSignature,
  computeChangedFilesFromSignatures,
} from "../src/execution/antigravity.js";

const cleanup: string[] = [];

/** Directory junction via mklink; requires an NTFS volume (skip otherwise). */
function junctionSupported(): boolean {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-r3-probe-"));
  try {
    fs.mkdirSync(probe, { recursive: true });
    execSync(`cmd /c mklink /J "${probe}-link" "${probe}"`, { stdio: "ignore" });
    fs.rmSync(`${probe}-link`, { force: true });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

function makeJunction(link: string, target: string): void {
  execSync(`cmd /c mklink /J "${link}" "${target}"`, { stdio: "ignore" });
}

/** Junction fixtures must live on an NTFS volume; tmpdir may not be one. */
function ntfsWorkspace(prefix: string): string {
  const dir = path.join(os.tmpdir(), `c2c-r3-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(dir, { recursive: true });
  cleanup.push(dir);
  return dir;
}

/** Isolated git config so temp-dir ownership checks never fail the fixture. */
function withIsolatedGitConfig<T>(fn: () => T): T {
  const gitConfig = path.join(makeTempDir("gitcfg"), "gitconfig");
  fs.writeFileSync(gitConfig, ["[safe]", "\tdirectory = *", ""].join("\n"));
  const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
  const prevSystem = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_SYSTEM = gitConfig;
  try {
    return fn();
  } finally {
    if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    if (prevSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = prevSystem;
  }
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `c2c-r3-${prefix}-`));
  cleanup.push(dir);
  return dir;
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function scopeInput(overrides: {
  toolName?: string;
  parameters?: Record<string, unknown>;
  workspaceRoot: string;
  allowedRoots?: string[];
  writesAllowed?: boolean;
}) {
  const canonicalRoot = realPathIfExists(overrides.workspaceRoot) ?? overrides.workspaceRoot;
  const canonicalAllowed = overrides.allowedRoots
    ? overrides.allowedRoots.map((r) => realPathIfExists(r) ?? r)
    : [canonicalRoot];
  return {
    toolName: overrides.toolName ?? "write_to_file",
    parameters: overrides.parameters ?? {},
    workspaceRoot: canonicalRoot,
    allowedRoots: canonicalAllowed,
    writesAllowed: overrides.writesAllowed ?? true,
  };
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("R3 P0-a: out-of-bounds denials never delete files", () => {
  it("category 1 — write tool targeting a PRE-EXISTING file outside the workspace leaves it intact", () => {
    const outsideDir = makeTempDir("outside");
    const sentinel = path.join(outsideDir, "keep.txt");
    fs.writeFileSync(sentinel, "precious user data\n");
    const beforeHash = sha256(sentinel);

    const workspace = makeTempDir("ws");
    const verdict = evaluateAntigravityToolScope(scopeInput({
      workspaceRoot: workspace,
      parameters: { TargetFile: sentinel, content: "overwrite attempt" },
    }));

    expect(verdict.violation).toBeTruthy();
    expect(verdict.category).toBe("write-tool");
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(sha256(sentinel)).toBe(beforeHash);
  });

  it("category 1 — read tool AbsolutePath outside the workspace leaves the file intact", () => {
    const outsideDir = makeTempDir("outside");
    const sentinel = path.join(outsideDir, "secret-config.json");
    fs.writeFileSync(sentinel, "{\"token\":\"do-not-delete\"}");
    const beforeHash = sha256(sentinel);

    const workspace = makeTempDir("ws");
    const verdict = evaluateAntigravityToolScope(scopeInput({
      toolName: "read_file",
      workspaceRoot: workspace,
      parameters: { AbsolutePath: sentinel },
    }));

    expect(verdict.violation).toBeTruthy();
    expect(verdict.category).toBe("read-path");
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(sha256(sentinel)).toBe(beforeHash);
  });

  it("category 1 — write-shaped run_command against an outside path leaves the file intact", () => {
    const outsideDir = makeTempDir("outside");
    const sentinel = path.join(outsideDir, "notes.txt");
    fs.writeFileSync(sentinel, "original");
    const beforeHash = sha256(sentinel);

    const workspace = makeTempDir("ws");
    const verdict = evaluateAntigravityToolScope(scopeInput({
      toolName: "run_command",
      workspaceRoot: workspace,
      parameters: { CommandLine: `Set-Content -Path "${sentinel}" -Value "clobber"` },
    }));

    expect(verdict.violation).toBeTruthy();
    expect(verdict.category).toBe("command");
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(sha256(sentinel)).toBe(beforeHash);
  });

  it("category 1 — write-shaped run_command against a POSIX outside path is denied (quoted and unquoted)", () => {
    const workspace = makeTempDir("ws");
    const verdictQuoted = evaluateAntigravityToolScope(scopeInput({
      toolName: "run_command",
      workspaceRoot: workspace,
      parameters: { CommandLine: 'Set-Content -Path "/outside/notes.txt" -Value "clobber"' },
    }));
    expect(verdictQuoted.violation).toBeTruthy();
    expect(verdictQuoted.category).toBe("command");

    const verdictUnquoted = evaluateAntigravityToolScope(scopeInput({
      toolName: "run_command",
      workspaceRoot: workspace,
      parameters: { CommandLine: 'echo "clobber" > /outside/notes.txt' },
    }));
    expect(verdictUnquoted.violation).toBeTruthy();
    expect(verdictUnquoted.category).toBe("command");
  });

  it("extracts candidate POSIX absolute paths from write commands safely", () => {
    const extracted = extractCandidatePathsFromCommand(
      'Set-Content -Path "/var/log/audit.log" -Value "test"; echo "hi" > /tmp/out.txt; cmd /c "echo foo"',
      "/home/user/ws"
    );
    expect(extracted).toContain("/var/log/audit.log");
    expect(extracted).toContain("/tmp/out.txt");
    expect(extracted).not.toContain("/c");
  });

  it("category 2 — write inside the workspace but outside the declared scope leaves the file intact", () => {
    const workspace = makeTempDir("ws");
    const srcDir = path.join(workspace, "src");
    fs.mkdirSync(srcDir);
    const docsFile = path.join(workspace, "docs", "important.md".replace("/", path.sep));
    fs.mkdirSync(path.dirname(docsFile), { recursive: true });
    fs.writeFileSync(docsFile, "# existing docs");
    const beforeHash = sha256(docsFile);

    const verdict = evaluateAntigravityToolScope(scopeInput({
      workspaceRoot: workspace,
      allowedRoots: [srcDir],
      parameters: { TargetFile: docsFile },
    }));

    expect(verdict.violation).toBeTruthy();
    expect(verdict.category).toBe("write-tool");
    expect(fs.existsSync(docsFile)).toBe(true);
    expect(sha256(docsFile)).toBe(beforeHash);
  });

  it("category 2 — no-write task denies every write attempt without widening to the workspace", () => {
    const workspace = makeTempDir("ws");
    const insideFile = path.join(workspace, "in-scope.txt");
    fs.writeFileSync(insideFile, "stable");
    const beforeHash = sha256(insideFile);

    const verdict = evaluateAntigravityToolScope(scopeInput({
      workspaceRoot: workspace,
      allowedRoots: [],
      writesAllowed: false,
      parameters: { TargetFile: insideFile },
    }));

    expect(verdict.violation).toBeTruthy();
    expect(fs.existsSync(insideFile)).toBe(true);
    expect(sha256(insideFile)).toBe(beforeHash);
  });

  it("junction escape — a junction inside scope pointing outside is denied and the target survives", (ctx) => {
    if (!junctionSupported()) ctx.skip();
    const outsideDir = ntfsWorkspace("outside");
    const sentinel = path.join(outsideDir, "junctioned.txt");
    fs.writeFileSync(sentinel, "via-junction");
    const beforeHash = sha256(sentinel);

    const workspace = ntfsWorkspace("ws");
    const sub = path.join(workspace, "sub");
    fs.mkdirSync(sub);
    const link = path.join(sub, "escape");
    makeJunction(link, outsideDir);

    // The link path itself string-resolves INSIDE scope; only real-path
    // resolution can see the escape.
    expect(path.resolve(link).toLowerCase().startsWith(path.resolve(sub).toLowerCase())).toBe(true);
    const verdict = evaluateAntigravityToolScope(scopeInput({
      workspaceRoot: workspace,
      allowedRoots: [sub],
      parameters: { TargetFile: link },
    }));

    expect(verdict.violation).toBeTruthy();
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(sha256(sentinel)).toBe(beforeHash);
    fs.rmSync(link, { force: true }); // remove the junction only
  });

  it("in-scope write is allowed (no false positives)", () => {
    const rawWorkspace = makeTempDir("ws");
    const workspace = realPathIfExists(rawWorkspace) ?? rawWorkspace;
    const target = path.join(workspace, "ok.txt");
    const verdict = evaluateAntigravityToolScope(scopeInput({
      workspaceRoot: workspace,
      parameters: { TargetFile: target },
    }));
    expect(verdict.violation).toBeNull();
    expect(verdict.category).toBe("allowed");
  });
});

describe("R3 P0-b: pre-execution write-scope verification fails closed", () => {
  it("workspace-root scope passes and reports provider-native enforcement", () => {
    const workspace = makeTempDir("ws");
    const result = verifyWriteScopePreflight({ workspaceRoot: workspace, writableRoots: [workspace] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preflight.writesAllowed).toBe(true);
      expect(result.preflight.enforcement).toBe("provider-workspace");
    }
  });

  it("empty scope is rejected because native tools cannot enforce read-only", () => {
    const workspace = makeTempDir("ws");
    const result = verifyWriteScopePreflight({ workspaceRoot: workspace, writableRoots: [] });
    // R4: native tools cannot enforce read-only; reject before launch.
    expect(result).toMatchObject({ok:false,code:"READ_ONLY_UNSUPPORTED"});
  });

  it("sub-directory scope is rejected upfront (detective-only for this provider)", () => {
    const workspace = makeTempDir("ws");
    const sub = path.join(workspace, "src");
    fs.mkdirSync(sub);
    const result = verifyWriteScopePreflight({ workspaceRoot: workspace, writableRoots: [sub] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("WRITE_SCOPE_UNSUPPORTED");
  });

  it("scope root that resolves outside the workspace through a junction is rejected", (ctx) => {
    if (!junctionSupported()) ctx.skip();
    const outsideDir = ntfsWorkspace("outside");
    const workspace = ntfsWorkspace("ws");
    const link = path.join(workspace, "escape");
    makeJunction(link, outsideDir);
    const result = verifyWriteScopePreflight({ workspaceRoot: workspace, writableRoots: [link] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("WRITE_SCOPE_UNSUPPORTED");
    fs.rmSync(link, { force: true });
  });

  it("nonexistent scope root is rejected", () => {
    const workspace = makeTempDir("ws");
    const ghost = path.join(workspace, "does-not-exist");
    const result = verifyWriteScopePreflight({ workspaceRoot: workspace, writableRoots: [ghost] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("WRITE_SCOPE_UNSUPPORTED");
  });

  it("real backend rejects sub-scope BEFORE spawning any process", async () => {
    const workspace = makeTempDir("ws");
    const sub = path.join(workspace, "src");
    fs.mkdirSync(sub);
    const sentinel = path.join(workspace, "outside-sub.txt");
    fs.writeFileSync(sentinel, "untouched");
    const beforeHash = sha256(sentinel);

    const backend = new AntigravityBackend({
      // A real, existing executable proves the rejection happens before spawn:
      // if the preflight failed to gate, this cmd.exe invocation would run.
      executablePath: process.platform === "win32" ? "C:\\Windows\\System32\\cmd.exe" : "/bin/true",
      stateDir: makeTempDir("state"),
    });
    const result = await backend.execute({
      taskId: "c2c_r3_preflight",
      workspaceId: "testws",
      workspaceRoot: workspace,
      instruction: "try to write",
      writeScope: ["src"],
      writableRoots: [sub],
      networkRequested: false,
      networkEffective: false,
      fullAccess: true,
      runTests: false,
      timeoutMs: 30_000,
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("WRITE_SCOPE_UNSUPPORTED");
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(sha256(sentinel)).toBe(beforeHash);
  });
});

describe("R3: git status parsing and content-signature change detection", () => {
  it("parses porcelain -z entries without the trim().slice(3) mangling", () => {
    const output = [
      "?? added file.txt",
      " M src/deep/a.ts",
      "M  src/normal.ts",
      "R  renamed-dest with space.txt",
      "old-name.txt",
      "?? tail.txt",
      "",
    ].join("\0");
    const entries = parseGitStatusEntries(output);
    expect(entries).toContain("added file.txt");
    expect(entries).toContain("src/deep/a.ts"); // old code produced "rc/deep/a.ts"
    expect(entries).toContain("src/normal.ts");
    expect(entries).toContain("renamed-dest with space.txt"); // rename destination tracked, origin skipped
    expect(entries).not.toContain("old-name.txt");
    expect(entries).toContain("tail.txt");
  });

  it("detects content changes to already-dirty files, not just new dirty paths", () => {
    const dir = makeTempDir("sig");
    const file = path.join(dir, "dirty.txt");
    fs.writeFileSync(file, "version-1");
    const sig1 = fileContentSignature(file);
    fs.writeFileSync(file, "version-2");
    const sig2 = fileContentSignature(file);
    expect(sig1).not.toBe(sig2);

    const before = new Map([["dirty.txt", sig1], ["stable.txt", "same"]]);
    const after = new Map([["dirty.txt", sig2], ["stable.txt", "same"]]);
    const changed = computeChangedFilesFromSignatures(before, after);
    expect(changed).toEqual(["dirty.txt"]);
  });

  it("detects deletions of previously present files", () => {
    const before = new Map([["gone.txt", "somehash"]]);
    const after = new Map<string, string>();
    expect(computeChangedFilesFromSignatures(before, after)).toEqual(["gone.txt"]);
  });

  it("captureWorkspaceFiles through the real backend parses a live dirty tree correctly", () => {
    const dir = makeTempDir("repo");
    withIsolatedGitConfig(() => {
      const run = (args: string) => {
        try {
          execSync(args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
        } catch (err) {
          const e = err as { status?: number; stderr?: Buffer; stdout?: Buffer; message?: string };
          throw new Error(`git fixture step failed: ${args}: status=${e.status} stderr=${String(e.stderr ?? "")} stdout=${String(e.stdout ?? "")} msg=${e.message}`);
        }
      };
      run("git init -q");
      fs.writeFileSync(path.join(dir, "tracked dirty.txt"), "base");
      run("git add -A");
      run("git -c user.name=t -c user.email=t@t commit -qm base");
      fs.appendFileSync(path.join(dir, "tracked dirty.txt"), " + task edit");
      fs.writeFileSync(path.join(dir, "untracked new file.txt"), "new");

      const backend = new AntigravityBackend({ stateDir: makeTempDir("state") });
      const capture = (backend as unknown as { captureWorkspaceFiles(root: string): Map<string, string> }).captureWorkspaceFiles.bind(backend);
      const before = capture(dir);
      expect(before.has(path.normalize("tracked dirty.txt"))).toBe(true); // old slice(3) mangled this name
      expect(before.has(path.normalize("untracked new file.txt"))).toBe(true);

      fs.appendFileSync(path.join(dir, "tracked dirty.txt"), " + more");
      const after = capture(dir);
      const changed = computeChangedFilesFromSignatures(before, after);
      expect(changed).toContain(path.normalize("tracked dirty.txt"));
      expect(changed).not.toContain(path.normalize("untracked new file.txt"));
    });
  });
});
