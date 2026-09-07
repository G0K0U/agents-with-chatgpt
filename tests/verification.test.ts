import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "../src/workspace/manager.js";
import {
  BRIDGE_VERIFICATION_SCRIPT,
  cleanupVerificationRuntime,
  materializeVerificationProfile,
  prepareVerificationRuntime,
  resolveBridgeVerificationLaunch,
  resolveDefaultVerificationProfile,
  summarizeVerification,
  type VerificationProfile,
} from "../src/execution/verification.js";
import { cleanup, isolateStateDir, makeTmpDir, makeGitRepo } from "./helpers.js";

describe("typed bridge verification profiles", () => {
  let root: string;

  afterEach(() => {
    if (root) cleanup(root);
  });

  it("resolves the bridge test profile to the bridge-owned in-process verifier", () => {
    const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const workspace = new Workspace(bridgeRoot);
    const profile = resolveDefaultVerificationProfile(workspace);
    const nodeExecutable = fs.realpathSync.native(path.resolve(process.execPath));

    expect(profile).toMatchObject({
      id: "c2c-bridge-in-process",
      executable: nodeExecutable,
      argv: [
        BRIDGE_VERIFICATION_SCRIPT,
        "--workspace",
        "{workspace}",
        "--runtime",
        "{verification_root}",
      ],
      cwd: "verification",
      network: false,
      sandbox: "workspaceWrite",
    });
    expect(profile?.executable).not.toBe("pnpm");
    expect(path.isAbsolute(profile?.executable ?? "")).toBe(true);
    expect(fs.existsSync(profile?.executable ?? "")).toBe(true);
    expect(path.isAbsolute(profile?.argv[0] ?? "")).toBe(true);
    expect(profile?.argv.some((arg) => /(?:pnpm|corepack|vitest|vite|esbuild|git|powershell|cmd\.exe)/i.test(arg))).toBe(false);
  });

  it("fails closed when the bridge Node resolution input is unavailable", () => {
    const missingNode = path.join(process.cwd(), ".c2c-missing-node.exe");
    expect(resolveBridgeVerificationLaunch({ nodeExecutable: missingNode })).toBeNull();
    expect(resolveBridgeVerificationLaunch({ nodeExecutable: process.execPath })).toMatchObject({
      executable: fs.realpathSync.native(path.resolve(process.execPath)),
      argv: [BRIDGE_VERIFICATION_SCRIPT, "--workspace", "{workspace}", "--runtime", "{verification_root}"],
      strategy: "node-bridge-script",
    });
  });

  it("materializes only bridge-owned paths and a network-disabled sandbox", () => {
    isolateStateDir();
    root = makeTmpDir("verification-ws");
    makeGitRepo(root);
    const workspace = new Workspace(root);
    const c2cRoot = makeTmpDir("verification-runtime");
    const runtime = prepareVerificationRuntime(c2cRoot, "c2c_abcdef12");
    const profile: VerificationProfile = {
      id: "python-pytest",
      workspaceId: workspace.id,
      executable: "node",
      argv: ["--eval", "process.exit(0)", "{workspace}"],
      cwd: "verification",
      timeoutMs: 5_000,
      network: false,
      sandbox: "workspaceWrite",
      summaryKind: "generic",
    };
    const materialized = materializeVerificationProfile(profile, workspace, runtime);

    expect(materialized.cwd).toBe(runtime.root);
    expect(materialized.argv).toContain(workspace.root);
    expect(materialized.sandboxPolicy).toEqual(expect.objectContaining({ type: "workspaceWrite", networkAccess: false }));
    expect((materialized.sandboxPolicy as { writableRoots?: string[] }).writableRoots).toEqual([runtime.root]);
    expect(materialized.env).toEqual(expect.objectContaining({
      COREPACK_ENABLE_NETWORK: "0",
      COREPACK_DEFAULT_TO_LATEST: "0",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    }));
    expect(materialized.commandLabel).not.toContain(workspace.root);
    expect(materialized.commandLabel).toContain("workspace:/");
    expect(fs.existsSync(runtime.root)).toBe(true);

    cleanupVerificationRuntime(c2cRoot, runtime);
    expect(fs.existsSync(runtime.root)).toBe(false);
    cleanup(c2cRoot);
  });

  it("summarizes pytest results without treating failures as success", () => {
    const profile: VerificationProfile = {
      id: "python-pytest",
      workspaceId: "1a2b3c4d5e6f",
      executable: "uv",
      argv: ["run", "pytest"],
      cwd: "workspace",
      timeoutMs: 5_000,
      network: false,
      sandbox: "readOnly",
      summaryKind: "pytest",
    };
    expect(summarizeVerification(profile, { exitCode: 0, stdout: "361 passed, 1 skipped\n", stderr: "" })).toBe(
      "361 passed, 1 skipped"
    );
    expect(summarizeVerification(profile, { exitCode: 1, stdout: "2 failed, 359 passed\n", stderr: "" })).toBe(
      "2 failed, 359 passed"
    );
  });

  it("rejects an unsupported profile placeholder", () => {
    isolateStateDir();
    root = makeTmpDir("verification-invalid");
    makeGitRepo(root);
    const workspace = new Workspace(root);
    const runtimeRoot = makeTmpDir("verification-invalid-runtime");
    const runtime = prepareVerificationRuntime(runtimeRoot, "c2c_abcdef12");
    const profile: VerificationProfile = {
      id: "bad-profile",
      workspaceId: workspace.id,
      executable: "node",
      argv: ["{arbitrary_command}"],
      cwd: "verification",
      timeoutMs: 5_000,
      network: false,
      sandbox: "workspaceWrite",
      summaryKind: "generic",
    };
    expect(() => materializeVerificationProfile(profile, workspace, runtime)).toThrow(/unsupported placeholder/i);
    cleanupVerificationRuntime(runtimeRoot, runtime);
    cleanup(runtimeRoot);
  });

  it("rejects mutation of the bridge-owned registered verifier argv", () => {
    isolateStateDir();
    const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const workspace = new Workspace(bridgeRoot);
    const runtimeRoot = makeTmpDir("verification-immutable");
    const runtime = prepareVerificationRuntime(runtimeRoot, "c2c_abcdef12");
    const registered = resolveDefaultVerificationProfile(workspace);
    if (!registered) throw new Error("The bridge verification profile is not registered");
    const mutated = {
      ...registered,
      argv: [...registered.argv, "--unexpected"],
    } as VerificationProfile;

    expect(() => materializeVerificationProfile(mutated, workspace, runtime)).toThrow(/bridge-owned/i);
    cleanupVerificationRuntime(runtimeRoot, runtime);
    cleanup(runtimeRoot);
  });

  it("rejects a verification runtime inside the workspace", () => {
    isolateStateDir();
    root = makeTmpDir("verification-inside-workspace");
    makeGitRepo(root);
    const workspace = new Workspace(root);
    const runtime = prepareVerificationRuntime(root, "c2c_abcdef12");
    const profile: VerificationProfile = {
      id: "python-pytest",
      workspaceId: workspace.id,
      executable: "node",
      argv: ["--version"],
      cwd: "verification",
      timeoutMs: 5_000,
      network: false,
      sandbox: "workspaceWrite",
      summaryKind: "generic",
    };
    expect(() => materializeVerificationProfile(profile, workspace, runtime)).toThrow(/outside the connected workspace/i);
    cleanupVerificationRuntime(root, runtime);
  });

  it("rejects a profile that attempts to enable network access", () => {
    isolateStateDir();
    root = makeTmpDir("verification-network");
    makeGitRepo(root);
    const workspace = new Workspace(root);
    const runtimeRoot = makeTmpDir("verification-network-runtime");
    const runtime = prepareVerificationRuntime(runtimeRoot, "c2c_abcdef12");
    const profile = {
      id: "network-profile",
      workspaceId: workspace.id,
      executable: "node",
      argv: ["--version"],
      cwd: "verification",
      timeoutMs: 5_000,
      network: true,
      sandbox: "readOnly",
      summaryKind: "generic",
    } as unknown as VerificationProfile;
    expect(() => materializeVerificationProfile(profile, workspace, runtime)).toThrow(/network/i);
    cleanupVerificationRuntime(runtimeRoot, runtime);
    cleanup(runtimeRoot);
  });
});
