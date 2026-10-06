import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, execSync, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  AntigravityBackend,
  projectAntigravityFailure,
  canonicalizeAntigravityModel,
  extractAntigravityFailureDetails,
  parseAntigravityDuration,
  resolveAntigravityModelEvidence,
} from "../src/execution/antigravity.js";
import type { BackendExecutionRequest } from "../src/execution/backend.js";
import { CodexTaskManager } from "../src/execution/tasks.js";
import type { VerificationProfile } from "../src/execution/verification.js";
import { createMcpServer } from "../src/mcp/server.js";
import { Workspace } from "../src/workspace/manager.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const file = vi.fn();
  Object.defineProperty(file, Symbol.for("nodejs.util.promisify.custom"), { value: vi.fn() });
  return { ...actual, spawn: vi.fn(), execFile: file, execSync: vi.fn(() => Buffer.from("")) };
});
const roots: string[] = [];
const childExits: (number | null)[] = [];
function fixture(name = "codex-with-chatgpt") {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-g3-test-"));
  roots.push(parent);
  const root = path.join(parent, "My Projects", name);
  fs.mkdirSync(root, { recursive: true });
  const backend = new AntigravityBackend({ executablePath: process.execPath, stateDir: path.join(parent, "state") });
  const request: BackendExecutionRequest = {
    taskId: "c2c_g3_fixture", workspaceId: "fixture", workspaceRoot: root,
    instruction: 'Review "src/execution/tasks.ts" without edits', writeScope: [root], writableRoots: [root],
    networkRequested: true, networkEffective: true, fullAccess: true, runTests: false,
    model: "gemini-3.8-flash-high", timeoutMs: 5000,
  };
  return { root, parent, backend, request };
}

// Offline executable contract: a shell step under forced sandbox waits for
// administrator setup. Native file tools do not initialize the shell sandbox.
async function installContractChild(tool: "shell" | "native-file") {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(spawn).mockImplementation(((exe, args, options) => {
    expect(exe).toBe(process.execPath); // no provider executable or fallback
    expect(options?.shell).toBeUndefined();
    const argv = args as string[];
    expect(argv[argv.indexOf("--add-dir") + 1]).toBe(options?.cwd);
    expect(argv[argv.indexOf("--model") + 1]).toBe("gemini-3.8-flash-high");
    expect(argv).toContain("--disable-slash-commands");
    const script = `
      const { sandbox, tool } = JSON.parse(process.argv[1]);
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => { input += chunk; });
      process.stdin.on("end", () => {
        const lines = input.trim().split(/\\r?\\n/).filter(l => l.trim().length > 0);
        if (lines.length !== 1) {
          process.stderr.write("Expected exactly one NDJSON event, got " + lines.length);
          process.exit(1);
        }
        let ev;
        try {
          ev = JSON.parse(lines[0]);
        } catch (err) {
          process.stderr.write("Invalid JSON: " + err.message);
          process.exit(1);
        }
        if (ev.event !== "user" || !ev.message || typeof ev.message.content !== "string") {
          process.stderr.write("Invalid user event structure");
          process.exit(1);
        }
        if (!ev.message.content.includes("Review")) {
          process.stderr.write("Instruction validation failed");
          process.exit(1);
        }
        if (sandbox && tool === "shell") {
          process.stderr.write("Administrator privileges are required to set up sandboxing", () => { process.exitCode = 2; });
        } else {
          process.stdout.write(JSON.stringify({ type: "result", result: { status: "SUCCESS", response: "fixture completed" } }) + "\\n");
        }
      });
    `;
    const child = actual.spawn(process.execPath, ["-e", script, JSON.stringify({ sandbox: argv.includes("--sandbox"), tool })], options);
    child.on("close", code => childExits.push(code));
    return child;
  }) as typeof spawn);
}

function manualChild() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 0 });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
  return child;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(spawn).mockReset();
  vi.mocked(promisify(execFile)).mockReset();
  childExits.length = 0;
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    if (!path.basename(resolved).startsWith("c2c-g3-test-") || path.dirname(resolved) !== path.resolve(os.tmpdir())) throw new Error("Unsafe fixture cleanup");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe("G3 Antigravity full-workspace contract", () => {
  it.each([
    { model: "claude-opus-5-5-low", listing: "claude-opus-5-5-low\tLow\nclaude-opus-5-5-high\tHigh", code: "EFFORT_POLICY_VIOLATION" },
    { model: "claude-opus-5-5-high", listing: "gemini-3.8-flash-high\tHigh", code: "HIGHEST_EFFORT_UNVERIFIED" },
    { model: "claude-opus-5-5-high", listing: null, code: "HIGHEST_EFFORT_UNVERIFIED" },
  ])("does not launch Opus inference when its live highest-effort contract fails: $code / $model", async ({ model, listing, code }) => {
    const { backend, request } = fixture();
    const query = vi.mocked(promisify(execFile));
    if (listing === null) query.mockRejectedValue(new Error("synthetic-private-account-diagnostic"));
    else query.mockResolvedValue({ stdout: listing, stderr: "" });
    const result = await backend.execute({ ...request, model });
    expect(query).toHaveBeenCalledWith(process.execPath, ["models"], expect.objectContaining({ timeout: 15000, windowsHide: true }));
    expect(result).toMatchObject({ status: "failed", actualProvider: null, actualModel: "UNKNOWN", error: { code } });
    expect(JSON.stringify(result)).not.toContain("synthetic-private-account-diagnostic");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("launches the exact live Opus high model and preserves observed identity", async () => {
    const { backend, request } = fixture();
    const model = "claude-opus-5-5-high";
    vi.mocked(promisify(execFile)).mockResolvedValue({ stdout: `${model}\tClaude Opus 5.5 High`, stderr: "" });
    const child = manualChild();
    const pending = backend.execute({ ...request, model });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const argv = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe(model);
    child.stdout.write(JSON.stringify({ type: "init", session_id: "opus-contract-session", model }) + "\n");
    child.stdout.write(JSON.stringify({ type: "result", result: { status: "SUCCESS", response: "fixture completed" } }) + "\n");
    child.emit("close", 0);
    expect(await pending).toMatchObject({ status: "completed", requestedModel: model, actualProvider: "antigravity", actualModel: model });
  });
  it("uses the constructor startup timeout while the child remains pre-session", async () => {
    const { parent, request } = fixture();
    const backend = new AntigravityBackend({ executablePath: process.execPath, stateDir: path.join(parent, "timeout-state"), sessionStartupTimeoutMs: 50 });
    const child = manualChild();
    vi.useFakeTimers();
    try {
      const pending = backend.execute({ ...request, timeoutMs: 5000 });
      await vi.advanceTimersByTimeAsync(49);
      await vi.advanceTimersByTimeAsync(1);
      child.emit("close", null);
      const result = await pending;
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("ANTIGRAVITY_SESSION_START_FAILED");
      expect(result.error?.message).toContain("(50ms)");
      expect(result.actualProvider).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports on-demand callable without a live process; only real task evidence degrades; rejects empty success", async () => {
    const { backend, request } = fixture();
    vi.mocked(execSync).mockReturnValue(Buffer.from("1.2.3"));
    // On-demand truth: zero active sessions is NORMAL, never degraded (G3).
    expect(await backend.getProviderStatus()).toMatchObject({ status: "AVAILABLE", readiness: "READY_ON_DEMAND", cliInstalled: true, cliVersion: "1.2.3", providerReachable: true, activeSessionsCount: 0 });
    let child = manualChild();
    let pending = backend.execute(request);
    child.emit("close", 0);
    expect(await pending).toMatchObject({ status: "failed", actualProvider: null });
    // The failed real attempt is durable evidence of a non-callable lane.
    const degraded = await backend.getProviderStatus();
    expect(degraded).toMatchObject({ status: "DEGRADED", readiness: "FAILED", providerReachable: false });
    expect(degraded.notCallableReason).toMatch(/failed/i);
    child = manualChild();
    pending = backend.execute(request);
    child.stdout.write(JSON.stringify({ type: "result", result: { status: "SUCCESS", response: "ok" } }) + "\n");
    child.emit("close", 0);
    expect((await pending).status).toBe("completed");
    expect(await backend.getProviderStatus()).toMatchObject({ status: "AVAILABLE", readiness: "READY_ON_DEMAND", providerReachable: true });
    vi.mocked(execSync).mockReturnValue(Buffer.from(process.execPath));
    const status = await backend.getProviderStatus();
    expect(status.cliVersion).toBeNull();
    expect(JSON.stringify(status)).not.toContain(process.execPath);
    expect(status).not.toHaveProperty("cliPath");
  });

  it.each(["missing", "rejected", "path"])("workspace_info projects private status safely: %s", async (mode) => {
    const { root } = fixture();
    const workspace = new Workspace(root);
    const privatePath = "C:\\private-machine\\agy.exe";
    const manager = {
      getQueueState: () => ({}),
      getAntigravityStatus: mode === "missing" ? undefined : async () => {
        if (mode === "rejected") throw new Error(privatePath);
        return { status: "DEGRADED", cliInstalled: true, cliPath: privatePath, cliVersion: privatePath, providerReachable: false, activeSessionsCount: 0, lastCanaryStatus: { taskId: privatePath } };
      },
    };
    const server = createMcpServer({ workspace, workspaces: [workspace], taskManager: manager as unknown as CodexTaskManager, host: "127.0.0.1", port: 48765, fullAccess: false });
    const result = await (server as any)._registeredTools.workspace_info.handler({}, { requestId: "fixture" });
    const data = JSON.parse(result.content[0].text);
    expect(data.antigravity.providerReachable).toBe(false);
    expect(data.antigravity.status).toBe(mode === "path" ? "DEGRADED" : "UNAVAILABLE");
    expect(data.antigravity).not.toHaveProperty("cliPath");
    expect(data.antigravity.cliVersion).toBeNull();
    expect(JSON.stringify(result)).not.toContain("private-machine");
    await server.close();
  });

  it("C2C full-access root with spaces reaches the shell contract without sandbox initialization", async () => {
    const { backend, request } = fixture();
    await installContractChild("shell");
    const result = await backend.execute(request);
    expect(result).toMatchObject({ status: "completed", provider: "gemini", providerModel: request.model, exitCode: 0 });
    expect(childExits).toEqual([0]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.calls[0][1]).not.toContain("--sandbox");
  });

  it("C2C manager submits provider=gemini with the full workspace to the real backend contract", async () => {
    const { backend, root, parent } = fixture();
    await installContractChild("shell");
    const execute = vi.spyOn(backend, "execute");
    const codexFactory = vi.fn(() => { throw new Error("Provider fallback is forbidden"); });
    const workspace = new Workspace(root);
    const manager = new CodexTaskManager(workspace, {
      stateDir: path.join(parent, "manager-state"), fullAccess: true,
      antigravityBackend: backend, appServerFactory: codexFactory,
    });
    try {
      const submitted = manager.submit({ workspace_id: workspace.id, provider: "gemini", model: "gemini-3.8-flash-high",
        instruction: "Review the workspace without edits", write_scope: [root], network: true, run_tests: false });
      let result = manager.get(submitted.taskId);
      for (let i = 0; i < 200 && ["queued", "running"].includes(result.status); i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
        result = manager.get(submitted.taskId);
      }
      expect(result.status, `task failed: ${JSON.stringify(result.error)}`).toBe("completed");
      expect(result).toMatchObject({ status: "completed", provider: "gemini" });
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0][0]).toMatchObject({ workspaceRoot: root, writableRoots: [root], fullAccess: true, networkEffective: true });
      expect(codexFactory).not.toHaveBeenCalled();
      expect(childExits).toEqual([0]);
    } finally {
      await manager.close();
    }
  });

  it.each([
    { exitCode: 0, expectedStatus: "completed", expectedVerificationStatus: "passed", stdout: "verifier passed\n" },
    { exitCode: 1, expectedStatus: "failed", expectedVerificationStatus: "failed", stdout: "verifier failed\n" },
  ])("executes trusted verification exactly once for successful gemini turn with run_tests=true (exitCode: $exitCode)", async ({ exitCode, expectedStatus, expectedVerificationStatus, stdout }) => {
    const { backend, root, parent } = fixture();
    vi.spyOn(backend, "execute").mockResolvedValue({
      status: "completed",
      provider: "gemini",
      providerRuntime: "antigravity-cli",
      providerModel: "gemini-3.8-flash-high",
      actualProvider: "antigravity",
      actualModel: "gemini-3.8-flash-high",
      changedFiles: [],
      output: JSON.stringify({ type: "result", result: { status: "SUCCESS", response: "fixture completed" } }),
    } as any);

    const execRequests: any[] = [];
    let appServerClosed = false;
    const fakeClient = {
      initialize: vi.fn(async () => {}),
      request: vi.fn(async (method: string, params: any) => {
        if (method === "command/exec") {
          execRequests.push(params);
          return { exitCode, stdout, stderr: "" };
        }
        throw new Error(`Unexpected AppServer method: ${method}`);
      }),
      setNotificationHandler: vi.fn(),
      setRequestHandler: vi.fn(),
      close: vi.fn(async () => {
        appServerClosed = true;
      }),
    };
    const codexFactory = vi.fn((opts) => {
      expect(opts.networkAccess).toBe(false);
      return fakeClient as any;
    });

    const workspace = new Workspace(root);
    const trustedProfile: VerificationProfile = {
      id: "trusted-verifier",
      workspaceId: workspace.id,
      executable: "node",
      argv: ["--version"],
      cwd: "workspace",
      timeoutMs: 5_000,
      network: false,
      sandbox: "readOnly",
      summaryKind: "generic",
    };

    const manager = new CodexTaskManager(workspace, {
      stateDir: path.join(parent, "manager-state"),
      fullAccess: true,
      antigravityBackend: backend,
      appServerFactory: codexFactory,
      verificationProfileResolver: () => trustedProfile,
    });

    try {
      const submitted = manager.submit({
        workspace_id: workspace.id,
        provider: "gemini",
        model: "gemini-3.8-flash-high",
        instruction: "Implement feature and verify",
        write_scope: [root],
        network: true,
        run_tests: true,
      });

      let result = manager.get(submitted.taskId);
      for (let i = 0; i < 200 && ["queued", "running"].includes(result.status); i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
        result = manager.get(submitted.taskId);
      }

      expect(result.status).toBe(expectedStatus);
      expect(result.provider).toBe("gemini");
      expect(execRequests).toHaveLength(1);
      expect(execRequests[0]).toMatchObject({
        command: ["node", "--version"],
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      });
      expect(codexFactory).toHaveBeenCalledTimes(1);
      expect(appServerClosed).toBe(true);
      expect(result.verification).toMatchObject({
        status: expectedVerificationStatus,
        exitCode,
        network: false,
        profileId: "trusted-verifier",
      });
      if (exitCode === 0) {
        expect(result.tests).toBe("verification passed");
        expect(result.exitStatus).toBe("ok");
      } else {
        expect(result.error?.code).toBe("VERIFICATION_EXECUTION_FAILED");
        expect(result.exitStatus).toBe("failed");
      }
      expect(result.actionEvidence).toMatchObject({
        turnCompleted: true,
      });
    } finally {
      await manager.close();
    }
  });

  it("fails with VERIFICATION_TIMEOUT when gemini verification exceeds timeout", async () => {
    const { backend, root, parent } = fixture();
    vi.spyOn(backend, "execute").mockResolvedValue({
      status: "completed",
      provider: "gemini",
      providerRuntime: "antigravity-cli",
      providerModel: "gemini-3.8-flash-high",
      actualProvider: "antigravity",
      actualModel: "gemini-3.8-flash-high",
      changedFiles: [],
      output: JSON.stringify({ type: "result", result: { status: "SUCCESS", response: "fixture completed" } }),
    } as any);

    const fakeClient = {
      initialize: vi.fn(async () => {}),
      request: vi.fn(async (method: string) => {
        if (method === "command/exec") {
          return new Promise(() => {}); // never resolves
        }
        throw new Error(`Unexpected AppServer method: ${method}`);
      }),
      setNotificationHandler: vi.fn(),
      setRequestHandler: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const codexFactory = vi.fn(() => fakeClient as any);

    const workspace = new Workspace(root);
    const trustedProfile: VerificationProfile = {
      id: "trusted-verifier",
      workspaceId: workspace.id,
      executable: "node",
      argv: ["--version"],
      cwd: "workspace",
      timeoutMs: 1_000,
      network: false,
      sandbox: "readOnly",
      summaryKind: "generic",
    };

    const manager = new CodexTaskManager(workspace, {
      stateDir: path.join(parent, "manager-state"),
      fullAccess: true,
      antigravityBackend: backend,
      appServerFactory: codexFactory,
      verificationProfileResolver: () => trustedProfile,
      verificationTimeoutMs: 100,
    });

    try {
      const submitted = manager.submit({
        workspace_id: workspace.id,
        provider: "gemini",
        model: "gemini-3.8-flash-high",
        instruction: "Implement feature and verify",
        write_scope: [root],
        network: true,
        run_tests: true,
      });

      let result = manager.get(submitted.taskId);
      for (let i = 0; i < 200 && ["queued", "running"].includes(result.status); i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
        result = manager.get(submitted.taskId);
      }

      expect(result.status).toBe("failed");
      expect(result.exitStatus).toBe("timeout");
      expect(result.error?.code).toBe("VERIFICATION_TIMEOUT");
      expect(result.verification).toMatchObject({
        status: "timed_out",
        network: false,
      });
      expect(result.tests).toBe("verification timed out");
    } finally {
      await manager.close();
    }
  });

  it("does not execute verification when gemini turn fails", async () => {
    const { backend, root, parent } = fixture();
    vi.spyOn(backend, "execute").mockResolvedValue({
      status: "failed",
      provider: "gemini",
      providerRuntime: "antigravity-cli",
      providerModel: "gemini-3.8-flash-high",
      actualProvider: null,
      actualModel: "UNKNOWN",
      changedFiles: [],
      error: { code: "ANTIGRAVITY_SESSION_START_FAILED", message: "Gemini execution failed" },
      output: "",
    } as any);

    const codexFactory = vi.fn(() => {
      throw new Error("Codex factory should not be called when gemini turn fails");
    });

    const workspace = new Workspace(root);
    const trustedProfile: VerificationProfile = {
      id: "trusted-verifier",
      workspaceId: workspace.id,
      executable: "node",
      argv: ["--version"],
      cwd: "workspace",
      timeoutMs: 5_000,
      network: false,
      sandbox: "readOnly",
      summaryKind: "generic",
    };

    const manager = new CodexTaskManager(workspace, {
      stateDir: path.join(parent, "manager-state"),
      fullAccess: true,
      antigravityBackend: backend,
      appServerFactory: codexFactory,
      verificationProfileResolver: () => trustedProfile,
    });

    try {
      const submitted = manager.submit({
        workspace_id: workspace.id,
        provider: "gemini",
        model: "gemini-3.8-flash-high",
        instruction: "Implement feature and verify",
        write_scope: [root],
        network: true,
        run_tests: true,
      });

      let result = manager.get(submitted.taskId);
      for (let i = 0; i < 200 && ["queued", "running"].includes(result.status); i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
        result = manager.get(submitted.taskId);
      }

      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("ANTIGRAVITY_SESSION_START_FAILED");
      expect(codexFactory).not.toHaveBeenCalled();
      expect(result.verification).toBeNull();
    } finally {
      await manager.close();
    }
  });

  it("reproduces exit 2 for a scoped shell and safely reports sandbox setup", async () => {
    const { backend, request } = fixture();
    await installContractChild("shell");
    const result = await backend.execute({ ...request, fullAccess: false });
    expect(result).toMatchObject({ status: "failed", provider: "gemini", exitCode: 2, error: { code: "ANTIGRAVITY_EXIT_ERROR" } });
    expect(result.error?.message).toContain("reason=SANDBOX_SETUP_REQUIRED");
    expect(childExits).toEqual([2]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("Engineering AI native-file contract remains compatible (fullAccess=%s)", async fullAccess => {
    const { backend, request } = fixture("engineering-ai");
    await installContractChild("native-file");
    expect(await backend.execute({ ...request, fullAccess })).toMatchObject({ status: "completed", exitCode: 0, provider: "gemini" });
    expect(childExits).toEqual([0]);
  });

  it("does not bypass narrow-scope preflight in restricted mode", async () => {
    const { backend, request, root } = fixture();
    const sub = path.join(root, "src");
    fs.mkdirSync(sub);
    expect(await backend.execute({ ...request, fullAccess: false, writeScope: ["src"], writableRoots: [sub] })).toMatchObject({ error: { code: "WRITE_SCOPE_UNSUPPORTED" } });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("accepts external absolute scopes only in full-access development mode", async () => {
    await installContractChild("native-file");
    const { backend, request, parent } = fixture();
    const outside = path.join(parent, "external");
    fs.mkdirSync(outside);
    const scoped = { ...request, writeScope: [outside], writableRoots: [outside] };
    expect(await backend.execute({ ...scoped, fullAccess: false })).toMatchObject({ error: { code: "WRITE_SCOPE_UNSUPPORTED" } });
    expect(spawn).not.toHaveBeenCalled();
    expect(await backend.execute(scoped)).toMatchObject({ status: "completed", provider: "gemini" });
  });

  it("drains diagnostics after exit and never serializes synthetic credentials", async () => {
    const { backend, request } = fixture();
    const child = manualChild();
    const onOutput = vi.fn();
    const pending = backend.execute({ ...request, onOutput });
    let settled = false;
    void pending.then(() => { settled = true; });
    child.emit("exit", 2);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.stdout.write("password=fixture-secret-stdout\n");
    child.stderr.write("x".repeat(20000) + "\nAdministrator privileges are required to set up sandboxing; token=fixture-secret-stderr");
    child.stdout.end(); child.stderr.end(); child.emit("close", 2);
    const result = await pending;
    expect(result.error?.message).toContain("reason=SANDBOX_SETUP_REQUIRED");
    expect(JSON.stringify(result)).not.toMatch(/fixture-secret|password=|token=|x{20}/);
    expect(onOutput).not.toHaveBeenCalled();
    expect(result.output.length).toBeLessThan(200);
  });

  it("projects structured result errors without copying arbitrary error fields", async () => {
    const { backend, request } = fixture();
    const child = manualChild();
    const pending = backend.execute(request);
    child.stdout.end(JSON.stringify({ type: "result", result: { status: "ERROR", error: { message: "Step is WAITING for user approval", token: "fixture-secret" }, response: "fixture-secret" } }) + "\n");
    child.emit("close", 2);
    const result = await pending;
    expect(result.error?.message).toContain("reason=APPROVAL_REQUIRED");
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });

  it("handles asynchronous spawn errors without raw OS diagnostics or fallback", async () => {
    const { backend, request } = fixture();
    const child = manualChild();
    const pending = backend.execute(request);
    child.emit("error", new Error("fixture-secret local path"));
    child.emit("close", -2);
    const result = await pending;
    expect(result.error?.code).toBe("SPAWN_FAILED");
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("keeps exit 2 unclassified without explicit evidence; fixed diagnostic labels only", () => {
    expect(projectAntigravityFailure("exit code 2 token=fixture-secret")).toBe("CLI_EXIT_UNCLASSIFIED");
    expect(projectAntigravityFailure("unknown flag: --private=fixture-secret")).toBe("INVALID_ARGUMENTS");
    expect(projectAntigravityFailure("workspace does not exist: private-path")).toBe("WORKSPACE_UNAVAILABLE");
  });

  it("classifies real-world quota wording without misreading auth errors", () => {
    expect(projectAntigravityFailure("quota exhausted for today, resets in 5h 30m")).toBe("QUOTA_EXHAUSTED");
    expect(projectAntigravityFailure("You have reached your usage limit")).toBe("QUOTA_EXHAUSTED");
    expect(projectAntigravityFailure("Account usage limit exceeded, please retry later")).toBe("QUOTA_EXHAUSTED");
    expect(projectAntigravityFailure("insufficient_quota: You exceeded your current quota")).toBe("QUOTA_EXHAUSTED");
    expect(projectAntigravityFailure("HTTP 429: too many requests")).toBe("RATE_LIMITED");
    expect(projectAntigravityFailure("fatal error: panic: runtime error")).toBe("CRASH");
    // Auth evidence wins even when the message also mentions quota/limits.
    expect(projectAntigravityFailure("authentication failed: usage limit exceeded")).toBe("AUTH_ERROR");
    expect(projectAntigravityFailure("unauthorized: quota exhausted")).toBe("AUTH_ERROR");
    // Model identity dominates a combined model+quota sentence (test parity).
    expect(projectAntigravityFailure("model gemini-unknown not found or quota exhausted")).toBe("MODEL_UNAVAILABLE");
  });

  it("model evidence comes from real artifacts; unknown effort stays null, never a status string", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-g3-test-"));
    roots.push(parent);
    // Protocol echo of a base model id keeps the decimal version and leaves effort unset.
    expect(resolveAntigravityModelEvidence({ protocolModel: "gemini-3.8-flash", isolatedHome: parent }))
      .toMatchObject({ modelId: "gemini-3.8-flash", effort: null, effortStatus: "unverified" });
    expect(resolveAntigravityModelEvidence({ protocolModel: "gemini-3.8-flash-high", isolatedHome: parent }))
      .toMatchObject({ modelId: "gemini-3.8-flash-high", effort: "high", effortStatus: "verified" });
    // CLI log lines: full label keeps the decimal version; a base-model line must not invent effort.
    const logDir = path.join(parent, ".gemini", "antigravity-cli", "log");
    fs.mkdirSync(logDir, { recursive: true });
    const fullLabelLog = path.join(logDir, "cli-1.log");
    fs.writeFileSync(fullLabelLog, 'Propagating selected model override to backend: label="Gemini 3.8 Flash High"\n');
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(fullLabelLog, stale, stale);
    fs.writeFileSync(path.join(logDir, "cli-2.log"), 'Print mode: starting (model="gemini-3.8-flash")\n');
    // Recent logs without exact conversation ownership are not evidence.
    expect(resolveAntigravityModelEvidence({ isolatedHome: parent })).toBeNull();
    expect(resolveAntigravityModelEvidence({ isolatedHome: parent, startedAt: Date.now() - 120_000, protocolModel: null })).toBeNull();
    const conversationId = "12345678-1234-1234-1234-123456789abc";
    fs.writeFileSync(path.join(logDir, "cli-3.log"), `${conversationId} Print mode: starting (model="gemini-3.8-flash")\n`);
    expect(resolveAntigravityModelEvidence({ isolatedHome: parent, conversationId }))
      .toMatchObject({ modelId: "gemini-3.8-flash", effort: null, effortStatus: "unverified", evidenceSource: "cli_log" });
  });

  it("isolated config serializes only policy and scrubs synthetic bridge credentials", () => {
    const { backend, parent } = fixture();
    vi.stubEnv("C2C_SERVICE_TOKEN", "fixture-secret-c2c");
    vi.stubEnv("BRIDGE_AUTH_TOKEN", "fixture-secret-bridge");
    const { env, isolatedHome } = backend.setupIsolatedConfig(false);
    expect(env.C2C_SERVICE_TOKEN).toBeUndefined();
    expect(env.BRIDGE_AUTH_TOKEN).toBeUndefined();
    for (const file of ["config/mcp_config.json", "config/config.json", "antigravity-cli/settings.json"]) {
      expect(fs.readFileSync(path.join(isolatedHome, ".gemini", file), "utf8")).not.toContain("fixture-secret");
    }
    expect(isolatedHome.startsWith(parent)).toBe(true);
  });

  it("sanitizes auth failures and maps to ANTIGRAVITY_AUTH_ERROR without leaking tokens", async () => {
    const { backend, request } = fixture();
    const child = manualChild();
    const pending = backend.execute(request);
    child.stderr.write("Error: authentication failed: oauth token has been revoked; token=fixture-secret-token");
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 1);
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ANTIGRAVITY_AUTH_ERROR");
    expect(result.error?.message).toContain("reason=AUTH_ERROR");
    expect(JSON.stringify(result)).not.toContain("fixture-secret-token");
  });

  it("sanitizes model unavailable failures and maps to ANTIGRAVITY_MODEL_UNAVAILABLE", async () => {
    const { backend, request } = fixture();
    const child = manualChild();
    const pending = backend.execute(request);
    child.stderr.write("Error: model gemini-unknown not found or quota exhausted; token=fixture-secret-model");
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 1);
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ANTIGRAVITY_MODEL_UNAVAILABLE");
    expect(result.error?.message).toContain("reason=MODEL_UNAVAILABLE");
    expect(JSON.stringify(result)).not.toContain("fixture-secret-model");
  });

  it("sanitizes workspace directory errors and maps to ANTIGRAVITY_WORKSPACE_ERROR", async () => {
    const { backend, request } = fixture();
    const child = manualChild();
    const pending = backend.execute(request);
    child.stderr.write("Error: failed to open workspace directory: workspace does not exist; token=fixture-secret-ws");
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 1);
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ANTIGRAVITY_WORKSPACE_ERROR");
    expect(result.error?.message).toContain("reason=WORKSPACE_UNAVAILABLE");
    expect(JSON.stringify(result)).not.toContain("fixture-secret-ws");
  });

  it("non-destructive detective path scope leaves unauthorized files untouched", async () => {
    const { backend, request, root } = fixture();
    const sub = path.join(root, "src");
    fs.mkdirSync(sub);
    const secretFile = path.join(root, "sensitive.txt");
    fs.writeFileSync(secretFile, "original confidential content", "utf-8");

    // Sub-directory scope is rejected upfront by preflight
    const result = await backend.execute({ ...request, fullAccess: false, writeScope: ["src"], writableRoots: [sub] });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("WRITE_SCOPE_UNSUPPORTED");
    expect(result.actualProvider).toBeNull();
    expect(result.actualModel).toBe("UNKNOWN");
    expect(result.requestedProvider).toBe("gemini");
    expect(result.requestedModel).toBe("gemini-3.8-flash-high");

    // Verify secretFile is completely untouched
    expect(fs.existsSync(secretFile)).toBe(true);
    expect(fs.readFileSync(secretFile, "utf-8")).toBe("original confidential content");
  });

  it("uses the spawned isolated home for scratch scope without adding scratch to changedFiles", async () => {
    const { backend, request } = fixture();
    const child = manualChild();
    const pending = backend.execute(request);
    const options = vi.mocked(spawn).mock.calls[0][2];
    const home = options?.env?.USERPROFILE;
    expect(home).toBe(backend.getIsolatedHomeDir());
    const target = path.join(home!, ".gemini", "antigravity-cli", "brain", "session", "scratch", "result.txt");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "provider scratch");
    for (const [tool_name, parameters] of [
      ["read_file", { AbsolutePath: target }],
      ["write_to_file", { TargetFile: target }],
      ["run_command", { CommandLine: `Set-Content -Path "${target}" -Value fixture` }],
    ]) {
      child.stdout.write(JSON.stringify({ type: "step_update", step_update: { tool_name, tool_info: { parameters } } }) + "\n");
    }
    child.stdout.write(JSON.stringify({ type: "result", result: { status: "SUCCESS", response: "fixture completed" } }) + "\n");
    child.emit("close", 0);
    const result = await pending;
    expect(result.status).toBe("completed");
    expect(result.changedFiles).toEqual([]);
  });

  it("aborts execution when Antigravity attempts Northbound C2C MCP tool call during step_update", async () => {
    const { backend, request } = fixture();
    const child = manualChild();
    const pending = backend.execute(request);
    child.stdout.write(JSON.stringify({
      type: "step_update",
      step_update: {
        tool_name: "submit_codex_task",
        tool_info: { parameters: {} },
      },
    }) + "\n");
    child.emit("close", 1);
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("C2C_RECURSION_DETECTED");
    expect(result.error?.message).toContain("Aborting execution to prevent recursive loop");
  });
});


describe("owner full-access permission contract", () => {
  it("blocks offline full access before launching or modifying native configuration", async () => {
    const { backend, request, parent } = fixture();
    const result = await backend.execute({ ...request, networkRequested: false, networkEffective: false });
    expect(result.error?.code).toBe("NETWORK_POLICY_UNSUPPORTED");
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(parent, "state", "providers"))).toBe(false);
  });

  it.each([true, false])("native permission settings follow owner selection (%s)", fullAccess => {
    const { backend } = fixture();
    const { isolatedHome } = backend.setupIsolatedConfig(false, fullAccess);
    const settings = JSON.parse(fs.readFileSync(path.join(isolatedHome, ".gemini", "antigravity-cli", "settings.json"), "utf8"));
    expect(settings.allowNonWorkspaceAccess).toBe(fullAccess);
    expect(settings.permissions.deny).toContain("search_web(*)");
  });

  it.each([true, false])("external fixture read/write preserves evidence (fullAccess=%s)", async fullAccess => {
    const { backend, request, parent } = fixture();
    const target = path.join(parent, "external-fixture.txt");
    fs.writeFileSync(target, "before");
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(spawn).mockImplementation(((exe, args, options) => {
      const argv = args as string[];
      expect(argv.includes("--dangerously-skip-permissions")).toBe(fullAccess);
      expect(argv.includes("--sandbox")).toBe(!fullAccess);
      // Real local child filesystem IO; simulated provider stream, no model call.
      const script = `
        const fs = require('node:fs'); const target = process.argv[1];
        fs.writeFileSync(target, fs.readFileSync(target, 'utf8') + '-after');
        process.stdout.write(JSON.stringify({type:'step_update',step_update:{tool_name:'read_file',tool_info:{parameters:{AbsolutePath:target}}}})+'\\n');
        process.stdout.write(JSON.stringify({type:'step_update',step_update:{tool_name:'write_to_file',tool_info:{parameters:{TargetFile:target}}}})+'\\n');
        process.stdout.write(JSON.stringify({type:'result',result:{status:'SUCCESS',response:'fixture'}})+'\\n');
      `;
      return actual.spawn(process.execPath, ["-e", script, target], options);
    }) as typeof spawn);
    // Avoid signalling an OS process in a detective-error test; the fixture exits itself.
    vi.spyOn(backend as any, "terminateProcess").mockImplementation(() => {});
    const result = await backend.execute({ ...request, fullAccess, networkRequested: fullAccess, networkEffective: fullAccess });
    expect(result.status).toBe(fullAccess ? "completed" : "failed");
    if (!fullAccess) expect(result.error?.code).toBe("WRITE_SCOPE_VIOLATION");
    expect(fs.readFileSync(target, "utf8")).toBe("before-after");
  });
});

describe("AGY stream-input bootstrap lifecycle and regression safety", () => {
  it("regression: absent or null child.stdin fails closed with ANTIGRAVITY_SESSION_START_FAILED", async () => {
    const { backend, request } = fixture();
    const child = manualChild();
    (child as any).stdin = null;
    const pending = backend.execute(request);
    child.emit("close", 1);
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ANTIGRAVITY_SESSION_START_FAILED");
  });

  it("regression: stdin write error before init causes bounded safe failure without leaking diagnostics", async () => {
    const { backend, request } = fixture();
    const child = manualChild();
    const pending = backend.execute(request);
    child.stdin.emit("error", new Error("EPIPE secret-path-token"));
    child.emit("close", 1);
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ANTIGRAVITY_SESSION_START_FAILED");
    expect(JSON.stringify(result)).not.toContain("secret-path-token");
  });

  it("regression: stdin write error after init fails closed and session id alone is not ignored", async () => {
    const { backend, request } = fixture();
    const child = manualChild();
    const pending = backend.execute(request);
    child.stdout.write(JSON.stringify({ event: "init", conversation_id: "conv-session-123" }) + "\n");
    child.stdin.emit("error", new Error("EPIPE after init secret-data"));
    child.emit("close", 1);
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ANTIGRAVITY_SESSION_START_FAILED");
    expect(JSON.stringify(result)).not.toContain("secret-data");
  });

  it("regression: writes exactly one user event and closes stdin (EOF)", async () => {
    const { backend, request } = fixture();
    const child = manualChild();
    const receivedChunks: string[] = [];
    let stdinEnded = false;
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk: string) => {
      receivedChunks.push(chunk);
    });
    child.stdin.on("end", () => {
      stdinEnded = true;
      child.stdout.write(JSON.stringify({ type: "result", result: { status: "SUCCESS", response: "done" } }) + "\n");
      child.emit("close", 0);
    });
    const result = await backend.execute(request);
    expect(result.status).toBe("completed");
    expect(stdinEnded).toBe(true);
    const fullInput = receivedChunks.join("");
    const lines = fullInput.trim().split(/\r?\n/).filter(l => l.trim().length > 0);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toEqual({
      event: "user",
      message: { content: request.instruction },
    });
  });

  it("regression: retains continuation argv and stream-json flags when resuming conversation", async () => {
    const { backend, request } = fixture();
    const child = manualChild();
    const pending = backend.execute({ ...request, providerSessionId: "session-continuation-789" });
    child.stdout.write(JSON.stringify({ type: "result", result: { status: "SUCCESS", response: "resumed" } }) + "\n");
    child.emit("close", 0);
    const result = await pending;
    expect(result.status).toBe("completed");
    expect(spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("--conversation");
    expect(spawnArgs[spawnArgs.indexOf("--conversation") + 1]).toBe("session-continuation-789");
    expect(spawnArgs).toContain("--input-format");
    expect(spawnArgs[spawnArgs.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(spawnArgs).toContain("--output-format");
    expect(spawnArgs[spawnArgs.indexOf("--output-format") + 1]).toBe("stream-json");
  });

  it("regression: late stdin error after result is absorbed safely without failing task", async () => {
    const { backend, request } = fixture();
    const child = manualChild();
    const pending = backend.execute(request);
    child.stdout.write(JSON.stringify({ type: "result", result: { status: "SUCCESS", response: "all good" } }) + "\n");
    child.stdin.emit("error", new Error("Late EPIPE"));
    child.emit("close", 0);
    const result = await pending;
    expect(result.status).toBe("completed");
    expect(result.output).toBe("all good");
  });

  it("regression: unknown terminal status fails closed rather than invent success", async () => {
    const { backend, request } = fixture();
    const child = manualChild();
    const pending = backend.execute(request);
    child.stdout.write(JSON.stringify({ type: "result", result: { status: "MYSTERY_STATUS" } }) + "\n");
    child.emit("close", 0);
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ANTIGRAVITY_EXECUTION_ERROR");
    expect(result.error?.message).toBe("Antigravity task reported unknown terminal status");
  });

  it("regression: unknown terminal status does not leak malicious long status string or secrets", async () => {
    const { backend, request } = fixture();
    const child = manualChild();
    const pending = backend.execute(request);
    const maliciousStatus = "SECRET_TOKEN_" + "A".repeat(5000) + "_CONFIDENTIAL_KEY_12345";
    child.stdout.write(JSON.stringify({ type: "result", result: { status: maliciousStatus } }) + "\n");
    child.emit("close", 0);
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ANTIGRAVITY_EXECUTION_ERROR");
    expect(result.error?.message).toBe("Antigravity task reported unknown terminal status");
    expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN");
    expect(JSON.stringify(result)).not.toContain("CONFIDENTIAL_KEY");
    expect(JSON.stringify(result)).not.toContain("AAAA");
  });

  it("regression: late stdin error after close for failed/no-result process does not re-terminate PID or mutate result", async () => {
    const { backend, request } = fixture();
    const child = manualChild();
    const terminateSpy = vi.spyOn(backend as any, "terminateProcess");
    const pending = backend.execute(request);
    child.emit("close", 1);
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ANTIGRAVITY_SESSION_START_FAILED");
    const terminateCalls = terminateSpy.mock.calls.length;

    // Multiple late stdin error events after child close
    child.stdin.emit("error", new Error("Late EPIPE 1"));
    child.stdin.emit("error", new Error("Late EPIPE 2"));

    // No throw, no additional terminateProcess calls, no mutation of result
    expect(terminateSpy).toHaveBeenCalledTimes(terminateCalls);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ANTIGRAVITY_SESSION_START_FAILED");
  });

  it("regression: asynchronous spawn error safely handled with SPAWN_FAILED", async () => {
    const { backend, request } = fixture();
    const child = manualChild();
    const pending = backend.execute(request);
    child.emit("error", new Error("spawn ENOENT confidential-path"));
    child.emit("close", -1);
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("SPAWN_FAILED");
    expect(JSON.stringify(result)).not.toContain("confidential-path");
  });
});
