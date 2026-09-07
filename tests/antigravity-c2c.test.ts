import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { AntigravityBackend, projectAntigravityFailure } from "../src/execution/antigravity.js";
import type { BackendExecutionRequest } from "../src/execution/backend.js";
import { CodexTaskManager } from "../src/execution/tasks.js";
import { createMcpServer } from "../src/mcp/server.js";
import { Workspace } from "../src/workspace/manager.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(), execSync: vi.fn(() => Buffer.from("")) };
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
    networkRequested: false, networkEffective: false, fullAccess: true, runTests: false,
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
      if (sandbox && tool === "shell") {
        process.stderr.write("Administrator privileges are required to set up sandboxing", () => { process.exitCode = 2; });
      } else {
        process.stdout.write(JSON.stringify({type:"result", result:{status:"SUCCESS", response:"fixture completed"}})+"\\n");
      }
    `;
    const child = actual.spawn(process.execPath, ["-e", script, JSON.stringify({ sandbox: argv.includes("--sandbox"), tool })], options);
    child.on("close", code => childExits.push(code));
    return child;
  }) as typeof spawn);
}

function manualChild() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 0 });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
  return child;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(spawn).mockReset();
  childExits.length = 0;
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    if (!path.basename(resolved).startsWith("c2c-g3-test-") || path.dirname(resolved) !== path.resolve(os.tmpdir())) throw new Error("Unsafe fixture cleanup");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe("G3 Antigravity full-workspace contract", () => {
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

  it("requires successful session evidence beyond CLI version and rejects empty success", async () => {
    const { backend, request } = fixture();
    vi.mocked(execSync).mockReturnValue(Buffer.from("1.2.3"));
    expect(await backend.getProviderStatus()).toMatchObject({ status: "DEGRADED", cliInstalled: true, cliVersion: "1.2.3", providerReachable: false });
    let child = manualChild();
    let pending = backend.execute(request);
    child.emit("close", 0);
    expect(await pending).toMatchObject({ status: "failed", actualProvider: null });
    expect((await backend.getProviderStatus()).providerReachable).toBe(false);
    child = manualChild();
    pending = backend.execute(request);
    child.stdout.write(JSON.stringify({ type: "result", result: { status: "SUCCESS", response: "ok" } }) + "\n");
    child.emit("close", 0);
    expect((await pending).status).toBe("completed");
    expect(await backend.getProviderStatus()).toMatchObject({ status: "AVAILABLE", providerReachable: true });
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
    vi.stubEnv("C2C_ORCHESTRATOR", "legacy");
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
        instruction: "Review the workspace without edits", write_scope: [root], network: false, run_tests: false });
      let result = manager.get(submitted.taskId);
      for (let i = 0; i < 200 && ["queued", "running"].includes(result.status); i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
        result = manager.get(submitted.taskId);
      }
      expect(result).toMatchObject({ status: "completed", provider: "gemini" });
      expect(execute).toHaveBeenCalledOnce();
      // Absolute write scopes retain the submitted spelling; Workspace may expand
      // a Windows short path (for example RUNNER~1) when canonicalizing its root.
      expect(execute.mock.calls[0][0]).toMatchObject({ workspaceRoot: workspace.root, writableRoots: [path.resolve(root)], fullAccess: true, networkEffective: false });
      expect(codexFactory).not.toHaveBeenCalled();
      expect(childExits).toEqual([0]);
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

  it("does not bypass narrow-scope preflight even in full-access mode", async () => {
    const { backend, request, root } = fixture();
    const sub = path.join(root, "src");
    fs.mkdirSync(sub);
    expect(await backend.execute({ ...request, writeScope: ["src"], writableRoots: [sub] })).toMatchObject({ error: { code: "WRITE_SCOPE_UNSUPPORTED" } });
    expect(spawn).not.toHaveBeenCalled();
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
    const result = await backend.execute({ ...request, writeScope: ["src"], writableRoots: [sub] });
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
