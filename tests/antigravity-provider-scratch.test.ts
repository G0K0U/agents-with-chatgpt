import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AntigravityBackend, evaluateAntigravityToolScope } from "../src/execution/antigravity.js";

const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-provider-scratch-"));
  fixtures.push(dir);
  const workspaceRoot = path.join(dir, "workspace");
  fs.mkdirSync(workspaceRoot);
  const stateDir = path.join(dir, "AppData", "Local", "codex-with-chatgpt");
  const backend = new AntigravityBackend({ stateDir });
  const { isolatedHome } = backend.setupIsolatedConfig(false);
  const brain = path.join(isolatedHome, ".gemini", "antigravity-cli", "brain");
  const generated = path.join(isolatedHome, ".gemini", "antigravity-cli", ".system_generated");
  const input = { workspaceRoot, allowedRoots: [workspaceRoot], writesAllowed: true, providerOwnedRoots: [brain, generated] };
  return { dir, stateDir, isolatedHome, brain, generated, input };
}

const calls = (target: string) => [
  { toolName: "read_file", parameters: { AbsolutePath: target } },
  { toolName: "write_to_file", parameters: { TargetFile: target } },
  { toolName: "write_file", parameters: { AbsolutePath: target } },
  { toolName: "run_command", parameters: { CommandLine: `Set-Content -Path "${target}" -Value fixture` } },
];

describe("Antigravity provider-owned scratch containment", () => {
  it("allows reads, writes and command writes in explicit scratch roots, including future files", () => {
    const { brain, generated, input } = fixture();
    for (const root of [path.join(brain, "session", "scratch"), path.join(brain, "session", ".system_generated"), generated]) {
      const target = path.join(root, "future", "result.txt");
      for (const call of calls(target)) expect(evaluateAntigravityToolScope({ ...input, ...call }).violation).toBeNull();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "fixture");
      for (const call of calls(target)) expect(evaluateAntigravityToolScope({ ...input, ...call }).violation).toBeNull();
    }
  });

  it("keeps AppData siblings, credentials, runtime and workspace siblings fenced", () => {
    const { dir, stateDir, isolatedHome, brain, input } = fixture();
    const targets = [
      path.join(dir, "AppData", "Local", "other-app", "file.txt"),
      ...["auth", "tunnel", "runtime", "endpoints", "OAuth", ".cloudflared"].map(name => path.join(stateDir, name, "file.txt")),
      path.join(isolatedHome, ".gemini", "oauth_creds.json"),
      path.join(isolatedHome, ".gemini", "antigravity-cli", "settings.json"),
      path.join(brain + "-sibling", "file.txt"),
      path.join(dir, "workspace-sibling", "file.txt"),
    ];
    for (const target of targets) for (const call of calls(target)) {
      expect(evaluateAntigravityToolScope({ ...input, ...call }).violation).not.toBeNull();
    }
    const target = path.join(input.workspaceRoot, "outside-scope.txt");
    expect(evaluateAntigravityToolScope({ ...input, allowedRoots: [path.join(input.workspaceRoot, "src")], ...calls(target)[1] }).violation).not.toBeNull();
    expect(evaluateAntigravityToolScope({ ...input, providerOwnedRoots: [], ...calls(path.join(brain, "file.txt"))[0] }).violation).not.toBeNull();
  });

  it("denies existing, future and dangling junction/symlink escapes", (ctx) => {
    const { dir, brain, input } = fixture();
    fs.mkdirSync(brain, { recursive: true });
    const outside = path.join(dir, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "existing.txt"), "untouched");
    const link = path.join(brain, "escape");
    try {
      fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        ctx.skip(); // Host/temp volume cannot create junctions or symlinks.
        return;
      }
      throw error;
    }
    for (const name of ["existing.txt", "future/nested.txt"]) for (const call of calls(path.join(link, name))) {
      expect(evaluateAntigravityToolScope({ ...input, ...call }).violation).not.toBeNull();
    }
    fs.unlinkSync(path.join(outside, "existing.txt"));
    fs.rmdirSync(outside);
    for (const call of calls(path.join(link, "future.txt"))) {
      expect(evaluateAntigravityToolScope({ ...input, ...call }).violation).not.toBeNull();
    }
    fs.unlinkSync(link);
  });
});
