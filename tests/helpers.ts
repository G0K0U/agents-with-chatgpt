import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function testTmpRoot(): string {
  const configured = process.env.C2C_TEST_TMP_ROOT;
  return configured && configured.trim() !== ""
    ? path.resolve(configured)
    : path.join(projectRoot, ".tooling", "test-tmp");
}

/**
 * Temp dirs live inside the repo (.tooling/test-tmp) so tests also run in
 * sandboxed environments where the system temp dir is not writable.
 */
export function makeTmpDir(name: string): string {
  const dir = path.join(testTmpRoot(), `${name}-${randomBytes(4).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(dir);
}

export function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

export function write(dir: string, rel: string, content: string): string {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_AUTHOR_NAME: "c2c-test",
  GIT_AUTHOR_EMAIL: "test@c2c.local",
  GIT_COMMITTER_NAME: "c2c-test",
  GIT_COMMITTER_EMAIL: "test@c2c.local",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

export function git(dir: string, ...args: string[]): string {
  // Fixture Git must never discover a parent repository or follow a gitfile/link.
  const root = fs.realpathSync.native(testTmpRoot());
  const resolved = fs.realpathSync.native(dir);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || fs.lstatSync(dir).isSymbolicLink()) {
    throw new Error("Unsafe Git fixture path");
  }
  const metadata = path.join(resolved, ".git");
  if (fs.existsSync(metadata)) {
    if (!fs.lstatSync(metadata).isDirectory() || fs.lstatSync(metadata).isSymbolicLink()) throw new Error("Unsafe Git fixture metadata");
  } else if (args[0] !== "init") {
    throw new Error("Git fixture must own its repository");
  }
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: GIT_ENV });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

export function makeGitRepo(dir: string): void {
  git(dir, "init", "-b", "main");
  write(dir, "hello.txt", "Hello from Codex with ChatGPT!\n");
  write(dir, "src/index.ts", "export const answer = 42;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "initial commit");
}

/** Point the persistent state dir at an isolated temp location. */
export function isolateStateDir(): string {
  const dir = makeTmpDir("state");
  process.env.C2C_STATE_DIR = dir;
  return dir;
}

export function pkceVerifierAndChallenge(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
