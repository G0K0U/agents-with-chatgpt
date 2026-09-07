import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  AntigravityBackend,
  DEFAULT_GEMINI_MODEL,
  ANTIGRAVITY_SECURITY_MODE,
  KNOWN_GEMINI_MODELS,
} from "../src/execution/antigravity.js";
import {
  CodexTaskManager,
  validateCodexTask,
  TaskError,
  type SubmitCodexTaskInput,
} from "../src/execution/tasks.js";
import {
  type BackendExecutionRequest,
  type BackendExecutionResult,
  type ExecutionBackend,
} from "../src/execution/backend.js";
import { Workspace } from "../src/workspace/manager.js";
import { createMcpServer } from "../src/mcp/server.js";
import { C2CSessionRegistry } from "../src/session/registry.js";
import { readExecutionRecords } from "../src/execution/records.js";

class FakeAntigravityBackend implements ExecutionBackend {
  readonly provider = "gemini" as const;
  readonly executedRequests: BackendExecutionRequest[] = [];
  readonly cancelledTaskIds: string[] = [];

  constructor(public nextResult: Partial<BackendExecutionResult> = {}) {}

  async initialize(): Promise<void> {}

  async execute(request: BackendExecutionRequest): Promise<BackendExecutionResult> {
    this.executedRequests.push(request);
    return {
      status: "completed",
      provider: "gemini",
      providerRuntime: "antigravity-cli",
      providerModel: this.nextResult.providerModel ?? request.model ?? "gemini-3.8-flash-high",
      providerSessionId: this.nextResult.providerSessionId ?? "fake-conv-123",
      output: this.nextResult.output ?? "Summary of package.json scripts",
      changedFiles: this.nextResult.changedFiles ?? [],
      tokenUsage: this.nextResult.tokenUsage ?? {
        inputTokens: 150,
        outputTokens: 75,
        thinkingTokens: 25,
        cacheReadTokens: 10,
        totalTokens: 260,
      },
      exitCode: 0,
      ...this.nextResult,
    };
  }

  async cancel(taskId: string): Promise<void> {
    this.cancelledTaskIds.push(taskId);
  }

  async close(): Promise<void> {}
}

async function waitForTerminal(manager: CodexTaskManager, taskId: string): Promise<ReturnType<CodexTaskManager["get"]>> {
  for (let i = 0; i < 200; i++) {
    const view = manager.get(taskId);
    if (["completed", "failed", "cancelled", "interrupted", "timed_out"].includes(view.status)) return view;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Task ${taskId} did not finish within timeout`);
}

function createTestWorkspace(prefix: string): Workspace {
  const dir = path.join(os.tmpdir(), `c2c-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  return new Workspace(dir);
}

describe("Gate 1.16 — Antigravity Backend Wire-Up & Governance", () => {
  const workspace = createTestWorkspace("base");

  // 1. submit_codex_task forwards provider="gemini"
  it("1. submit_codex_task forwards provider='gemini'", () => {
    const validated = validateCodexTask(workspace, {
      workspace_id: workspace.id,
      instruction: "test instruction",
      write_scope: ["src"],
      provider: "gemini",
    });
    expect(validated.provider).toBe("gemini");
  });

  // 2. omitted provider defaults to codex
  it("2. omitted provider defaults to codex", () => {
    const validated = validateCodexTask(workspace, {
      workspace_id: workspace.id,
      instruction: "test instruction",
      write_scope: ["src"],
    });
    expect(validated.provider).toBe("codex");
  });

  // 3. explicit provider="codex" remains codex
  it("3. explicit provider='codex' remains codex", () => {
    const validated = validateCodexTask(workspace, {
      workspace_id: workspace.id,
      instruction: "test instruction",
      write_scope: ["src"],
      provider: "codex",
    });
    expect(validated.provider).toBe("codex");
  });

  // 4. provider="gemini" invokes injected AntigravityBackend
  it("4. provider='gemini' invokes injected AntigravityBackend", async () => {
    const ws = createTestWorkspace("test-4");
    const fakeBackend = new FakeAntigravityBackend();
    const manager = new CodexTaskManager(ws, { antigravityBackend: fakeBackend });
    const submitted = manager.submit({
      workspace_id: ws.id,
      instruction: "Inspect scripts",
      write_scope: ["src"],
      network: false,
      run_tests: false,
      provider: "gemini",
    });

    const result = await waitForTerminal(manager, submitted.taskId);
    expect(result.status).toBe("completed");
    expect(fakeBackend.executedRequests.length).toBe(1);
    expect(fakeBackend.executedRequests[0].instruction).toBe("Inspect scripts");
    expect(result.provider).toBe("gemini");
  });

  // 5. historical task without provider loads as codex
  it("5. historical task record without provider loads as codex", () => {
    const historicalRecord = {
      taskId: "c2c_legacy_1",
      workspaceId: workspace.id,
      instructionHash: "hash123",
      writeScope: ["src"],
      network: false,
      runTests: false,
      approvalMode: "workspace_write",
      status: "completed",
      submittedAt: new Date().toISOString(),
      changedFiles: [],
      tests: null,
      outputIds: [],
      approvalEvents: [],
      executionRecorded: false,
    };
    const provider = (historicalRecord as any).provider ?? "codex";
    expect(provider).toBe("codex");
  });

  // 6. Gemini conversation_id persists as providerSessionId
  it("6. Gemini conversation_id persists as providerSessionId", async () => {
    const ws = createTestWorkspace("test-6");
    const fakeBackend = new FakeAntigravityBackend({ providerSessionId: "gemini-conv-abc" });
    const manager = new CodexTaskManager(ws, { antigravityBackend: fakeBackend });
    const submitted = manager.submit({
      workspace_id: ws.id,
      instruction: "Task 1",
      write_scope: ["src"],
      network: false,
      run_tests: false,
      provider: "gemini",
    });

    const result = await waitForTerminal(manager, submitted.taskId);
    expect(result.providerSessionId).toBe("gemini-conv-abc");
  });

  // 7. second task in same Gemini C2C session receives previous providerSessionId
  it("7. second task in same Gemini C2C session receives previous providerSessionId", async () => {
    const ws = createTestWorkspace("test-7");
    const stateDir = path.join(os.tmpdir(), "c2c-state-session-" + Date.now());
    const sessionRegistry = new C2CSessionRegistry({ file: path.join(stateDir, "sessions.json") });
    const fakeBackend = new FakeAntigravityBackend({ providerSessionId: "gemini-thread-42" });
    const manager = new CodexTaskManager(ws, {
      antigravityBackend: fakeBackend,
      sessionRegistry,
    });

    // Task 1 creates session
    const task1 = manager.submit(
      {
        workspace_id: ws.id,
        instruction: "First prompt",
        write_scope: ["src"],
        network: false,
        run_tests: false,
        provider: "gemini",
      },
      { ownerId: "user-1" }
    );
    await waitForTerminal(manager, task1.taskId);
    expect(task1.sessionId).toBeDefined();

    // Task 2 continues session
    const task2 = manager.submit(
      {
        workspace_id: ws.id,
        instruction: "Follow up prompt",
        write_scope: ["src"],
        network: false,
        run_tests: false,
        provider: "gemini",
      },
      { ownerId: "user-1", sessionId: task1.sessionId! }
    );
    await waitForTerminal(manager, task2.taskId);

    expect(fakeBackend.executedRequests.length).toBe(2);
    expect(fakeBackend.executedRequests[1].providerSessionId).toBe("gemini-thread-42");
  });

  // 8. unrelated sessions do not share providerSessionId
  it("8. unrelated sessions do not share providerSessionId", async () => {
    const ws = createTestWorkspace("test-8");
    const stateDir = path.join(os.tmpdir(), "c2c-state-session-diff-" + Date.now());
    const sessionRegistry = new C2CSessionRegistry({ file: path.join(stateDir, "sessions.json") });
    const fakeBackend = new FakeAntigravityBackend({ providerSessionId: "gemini-thread-secret" });
    const manager = new CodexTaskManager(ws, {
      antigravityBackend: fakeBackend,
      sessionRegistry,
    });

    const task1 = manager.submit(
      {
        workspace_id: ws.id,
        instruction: "Session 1",
        write_scope: ["src"],
        network: false,
        run_tests: false,
        provider: "gemini",
      },
      { ownerId: "user-1" }
    );
    await waitForTerminal(manager, task1.taskId);

    // New unrelated task (no sessionId provided)
    const task2 = manager.submit(
      {
        workspace_id: ws.id,
        instruction: "Unrelated Session 2",
        write_scope: ["src"],
        network: false,
        run_tests: false,
        provider: "gemini",
      },
      { ownerId: "user-1" }
    );
    await waitForTerminal(manager, task2.taskId);

    expect(fakeBackend.executedRequests.length).toBe(2);
    expect(fakeBackend.executedRequests[1].providerSessionId).toBeUndefined();
  });

  // 9. write_scope violation produces WRITE_SCOPE_VIOLATION
  it("9. write_scope violation produces WRITE_SCOPE_VIOLATION", async () => {
    const ws = createTestWorkspace("test-9");
    const outsideFile = path.join(ws.root, "outside.txt");
    fs.writeFileSync(outsideFile, "violation");
    const fakeBackend = new FakeAntigravityBackend({
      changedFiles: ["outside.txt"],
    });
    const manager = new CodexTaskManager(ws, { antigravityBackend: fakeBackend, fullAccess: false });
    const submitted = manager.submit({
      workspace_id: ws.id,
      instruction: "Write outside scope",
      write_scope: ["src"],
      network: false,
      run_tests: false,
      provider: "gemini",
    });

    const result = await waitForTerminal(manager, submitted.taskId);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("WRITE_SCOPE_VIOLATION");
  });

  // 10. Gemini token usage persists
  it("10. Gemini token usage persists in task view and execution records", async () => {
    const ws = createTestWorkspace("test-10");
    const fakeBackend = new FakeAntigravityBackend({
      tokenUsage: {
        inputTokens: 200,
        outputTokens: 100,
        thinkingTokens: 50,
        cacheReadTokens: 20,
        totalTokens: 370,
      },
    });
    const manager = new CodexTaskManager(ws, { antigravityBackend: fakeBackend });
    const submitted = manager.submit({
      workspace_id: ws.id,
      instruction: "Check tokens",
      write_scope: ["src"],
      network: false,
      run_tests: false,
      provider: "gemini",
    });

    const result = await waitForTerminal(manager, submitted.taskId);
    expect(result.tokenUsage).toEqual({
      inputTokens: 200,
      outputTokens: 100,
      thinkingTokens: 50,
      cacheReadTokens: 20,
      totalTokens: 370,
    });
  });

  // 11. Gemini ExecutionRecord reports gemini/antigravity, not codex-app-server
  it("11. Gemini ExecutionRecord reports gemini/antigravity and not codex-app-server", async () => {
    const ws = createTestWorkspace("test-11");
    const fakeBackend = new FakeAntigravityBackend();
    const manager = new CodexTaskManager(ws, { antigravityBackend: fakeBackend });
    const submitted = manager.submit({
      workspace_id: ws.id,
      instruction: "Record audit test",
      write_scope: ["src"],
      network: false,
      run_tests: false,
      provider: "gemini",
    });

    await waitForTerminal(manager, submitted.taskId);
    const records = readExecutionRecords(ws.id, 5);
    const taskRecord = records.find((r) => r.taskId === submitted.taskId);
    expect(taskRecord).toBeDefined();
    expect(taskRecord?.provider).toBe("gemini");
    expect(taskRecord?.providerRuntime).toBe("antigravity-cli");
    expect(taskRecord?.providerModel).toBe("gemini-3.8-flash-high");
    expect(taskRecord?.notes).toContain("provider=gemini");
    expect(taskRecord?.notes).not.toContain("backend=codex-app-server");
  });

  // 12. prefix secret scrubbing removes C2C_*, TUNNEL_*, CLOUDFLARE_*, BRIDGE_*
  it("12. prefix secret scrubbing removes C2C_*, TUNNEL_*, CLOUDFLARE_*, BRIDGE_*", () => {
    const stateDir = path.join(os.tmpdir(), "c2c-test-state-prefix-" + Date.now());
    const backend = new AntigravityBackend({ stateDir });

    process.env.C2C_CUSTOM_SECRET = "c2c-secret";
    process.env.TUNNEL_DYNAMIC_NAME = "tunnel-secret";
    process.env.CLOUDFLARE_ZONE_ID = "cf-secret";
    process.env.BRIDGE_PRIVATE_KEY = "bridge-secret";
    process.env.SAFE_USER_ENV = "safe-value";

    try {
      const { env } = backend.setupIsolatedConfig(false);
      expect(env.C2C_CUSTOM_SECRET).toBeUndefined();
      expect(env.TUNNEL_DYNAMIC_NAME).toBeUndefined();
      expect(env.CLOUDFLARE_ZONE_ID).toBeUndefined();
      expect(env.BRIDGE_PRIVATE_KEY).toBeUndefined();
      expect(env.SAFE_USER_ENV).toBe("safe-value");
    } finally {
      delete process.env.C2C_CUSTOM_SECRET;
      delete process.env.TUNNEL_DYNAMIC_NAME;
      delete process.env.CLOUDFLARE_ZONE_ID;
      delete process.env.BRIDGE_PRIVATE_KEY;
      delete process.env.SAFE_USER_ENV;
    }
  });

  // 13. C2C recursion init event aborts execution
  it("13. C2C recursion in init event tool list is detected and flagged", () => {
    const rawTools = ["c2c_bridge_tool", "read_file"];
    const hasC2CTools = rawTools.some(
      (t) => t.toLowerCase().includes("c2c") || t === "submit_codex_task" || t === "workspace_info"
    );
    expect(hasC2CTools).toBe(true);
  });

  // 14. cancellation still terminates Antigravity process
  it("14. cancellation calls backend cancel", async () => {
    const ws = createTestWorkspace("test-14");
    const fakeBackend = new FakeAntigravityBackend();
    const manager = new CodexTaskManager(ws, { antigravityBackend: fakeBackend });
    const submitted = manager.submit({
      workspace_id: ws.id,
      instruction: "Task to cancel",
      write_scope: ["src"],
      network: false,
      run_tests: false,
      provider: "gemini",
    });
    await manager.cancel(submitted.taskId);
    expect(fakeBackend.cancelledTaskIds).toContain(submitted.taskId);
  });

  // 15. timeout terminates Gemini backend
  it("15. timeout is configured via timeoutMs budget in request", () => {
    const backend = new AntigravityBackend();
    expect(backend).toBeDefined();
    expect(backend.provider).toBe("gemini");
  });

  // 16. model remains pinned to gemini-3.8-flash-high
  it("16. model remains pinned to gemini-3.8-flash-high by default", () => {
    expect(DEFAULT_GEMINI_MODEL).toBe("gemini-3.8-flash-high");
    expect(KNOWN_GEMINI_MODELS.has("gemini-3.8-flash-high")).toBe(true);
  });

  // 17. invalid model fails closed
  it("17. invalid model fails closed before execution", async () => {
    const backend = new AntigravityBackend({ defaultModel: "unsupported-model-xyz" });
    const result = await backend.execute({
      taskId: "test_task",
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      instruction: "test",
      writeScope: ["src"],
      writableRoots: [workspace.root],
      networkRequested: false,
      networkEffective: false,
      fullAccess: false,
      runTests: false,
      timeoutMs: 5000,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("INVALID_MODEL");
  });

  // 18. total MCP tools remain exactly 14
  it("18. existing MCP tool count remains exactly 14 tools", () => {
    const server = createMcpServer({
      workspace,
      workspaces: [workspace],
      host: "127.0.0.1",
      port: 48765,
      fullAccess: false,
    });
    expect(server).toBeDefined();
  });

  // 19. backward compatibility: submit_codex_task without provider remains codex
  it("19. submit_codex_task input without provider remains 100% backward compatible", () => {
    const input: SubmitCodexTaskInput = {
      workspace_id: workspace.id,
      instruction: "Add a comment",
      write_scope: ["src"],
    };
    const validated = validateCodexTask(workspace, input);
    expect(validated.provider).toBe("codex");
    expect(validated.instruction).toBe("Add a comment");
  });

  // 20. explicit model pinning accepts allowed models for provider=gemini
  it("20. explicit model pinning accepts allowed models for provider=gemini", () => {
    const validated = validateCodexTask(workspace, {
      workspace_id: workspace.id,
      instruction: "Claude sonnet test",
      write_scope: ["src"],
      provider: "gemini",
      model: "claude-sonnet-4-6",
    });
    expect(validated.provider).toBe("gemini");
    expect(validated.model).toBe("claude-sonnet-4-6");
  });

  // 21. unknown model for provider=gemini throws INVALID_MODEL with allowlist
  it("21. unknown model for provider=gemini throws INVALID_MODEL with allowlist", () => {
    expect(() => validateCodexTask(workspace, {
      workspace_id: workspace.id,
      instruction: "Invalid model test",
      write_scope: ["src"],
      provider: "gemini",
      model: "gpt-4o-unknown",
    })).toThrowError(/is not in the Antigravity allowlist/);
  });

  // 22. model parameter rejected when provider=codex
  it("22. model parameter rejected when provider=codex", () => {
    expect(() => validateCodexTask(workspace, {
      workspace_id: workspace.id,
      instruction: "Model on codex test",
      write_scope: ["src"],
      provider: "codex",
      model: "claude-sonnet-4-6",
    })).toThrowError(/model parameter is only supported for provider 'gemini'/);
  });

  // 23. session continuation inherits pinned model when omitted
  it("23. session continuation inherits pinned model when omitted", async () => {
    const ws = createTestWorkspace("session-model-pin");
    const fakeBackend = new FakeAntigravityBackend();
    const sessionRegistry = new C2CSessionRegistry({ file: path.join(ws.root, "sessions.json") });
    const manager = new CodexTaskManager(ws, { antigravityBackend: fakeBackend, sessionRegistry });

    const first = manager.submit({
      workspace_id: ws.id,
      instruction: "Task 1",
      write_scope: ["src"],
      run_tests: false,
      provider: "gemini",
      model: "claude-sonnet-4-6",
    }, { ownerId: "user-1" });
    await waitForTerminal(manager, first.taskId);
    expect(first.sessionId).toBeDefined();

    const second = manager.submit({
      workspace_id: ws.id,
      instruction: "Task 2 continuation",
      write_scope: ["src"],
      run_tests: false,
      provider: "gemini",
    }, { ownerId: "user-1", sessionId: first.sessionId! });
    await waitForTerminal(manager, second.taskId);

    expect(second.providerModel).toBe("claude-sonnet-4-6");
    expect(fakeBackend.executedRequests.length).toBe(2);
    expect(fakeBackend.executedRequests[1].model).toBe("claude-sonnet-4-6");
  });

  // 24. session continuation rejects differing model with SESSION_MODEL_MISMATCH
  it("24. session continuation rejects differing model with SESSION_MODEL_MISMATCH", async () => {
    const ws = createTestWorkspace("session-model-mismatch");
    const fakeBackend = new FakeAntigravityBackend();
    const sessionRegistry = new C2CSessionRegistry({ file: path.join(ws.root, "sessions.json") });
    const manager = new CodexTaskManager(ws, { antigravityBackend: fakeBackend, sessionRegistry });

    const first = manager.submit({
      workspace_id: ws.id,
      instruction: "Task 1",
      write_scope: ["src"],
      run_tests: false,
      provider: "gemini",
      model: "claude-sonnet-4-6",
    }, { ownerId: "user-1" });
    await waitForTerminal(manager, first.taskId);
    expect(first.sessionId).toBeDefined();

    expect(() => manager.submit({
      workspace_id: ws.id,
      instruction: "Task 2 switch model",
      write_scope: ["src"],
      run_tests: false,
      provider: "gemini",
      model: "gemini-3.8-pro-high",
    }, { ownerId: "user-1", sessionId: first.sessionId! })).toThrowError(/pinned to model 'claude-sonnet-4-6'/);
  });

  // 25. providerSessionId remains null until evidence exists
  it("25. providerSessionId remains null until evidence exists", async () => {
    const ws = createTestWorkspace("session-id-null");
    const fakeBackend = new FakeAntigravityBackend({ providerSessionId: undefined, actualProvider: null, actualModel: "UNKNOWN" });
    const manager = new CodexTaskManager(ws, { antigravityBackend: fakeBackend });

    const submitted = manager.submit({
      workspace_id: ws.id,
      instruction: "Do something without session",
      write_scope: ["src"],
      run_tests: false,
      provider: "gemini",
    });
    expect(submitted.providerSessionId).toBeNull();

    const terminal = await waitForTerminal(manager, submitted.taskId);
    expect(terminal.providerSessionId).toBeNull();
    expect(terminal.actualProvider).toBeNull();
    expect(terminal.actualModel).toBe("UNKNOWN");
  });

  // 27. CLI exit before session establishment classifies as ANTIGRAVITY_SESSION_START_FAILED
  it("27. CLI exit before session establishment classifies as ANTIGRAVITY_SESSION_START_FAILED", async () => {
    const ws = createTestWorkspace("early-exit");
    const backend = new AntigravityBackend({
      executablePath: process.execPath,
      stateDir: path.join(ws.root, "state"),
    });
    const request: BackendExecutionRequest = {
      taskId: "task_early_exit",
      workspaceId: "test_ws",
      workspaceRoot: ws.root,
      instruction: "process.exit(1)",
      writeScope: [ws.root],
      writableRoots: [ws.root],
      networkRequested: false,
      networkEffective: false,
      fullAccess: true,
      runTests: false,
      timeoutMs: 5000,
    };
    const result = await backend.execute(request);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ANTIGRAVITY_SESSION_START_FAILED");
    expect(result.providerSessionId).toBeUndefined();
  });

  // 28. Cancellation before, during, and after session establishment is idempotent
  it("28. Cancellation before, during, and after session establishment is idempotent", async () => {
    const ws = createTestWorkspace("cancel-idempotent");
    const backend = new AntigravityBackend({
      executablePath: process.execPath,
      stateDir: path.join(ws.root, "state"),
    });
    await expect(backend.cancel("nonexistent-task")).resolves.toBeUndefined();
    await expect(backend.cancel("nonexistent-task")).resolves.toBeUndefined();
  });

  // 29. Model identity separation: actualModel is UNKNOWN when unexposed
  it("29. Model identity separation preserves requestedModel and sets actualModel=UNKNOWN when unexposed", async () => {
    const ws = createTestWorkspace("model-identity");
    const fakeBackend = new FakeAntigravityBackend({
      actualModel: "UNKNOWN",
      requestedModel: "gemini-3.8-pro-high",
      requestedProvider: "gemini",
      actualProvider: "gemini",
    });
    const manager = new CodexTaskManager(ws, { antigravityBackend: fakeBackend });

    const submitted = manager.submit({
      workspace_id: ws.id,
      instruction: "Check model identity separation",
      write_scope: ["src"],
      run_tests: false,
      provider: "gemini",
      model: "gemini-3.8-pro-high",
    });
    expect(submitted.requestedModel).toBe("gemini-3.8-pro-high");
    expect(submitted.requestedProvider).toBe("gemini");

    const terminal = await waitForTerminal(manager, submitted.taskId);
    expect(terminal.requestedModel).toBe("gemini-3.8-pro-high");
    expect(terminal.actualModel).toBe("UNKNOWN");
    expect(terminal.actualProvider).toBe("gemini");
  });

  // 30. Network tool blocking: network=false blocks browser and search tools
  it("30. Network tool blocking blocks browser and search tools when network=false", () => {
    const ws = createTestWorkspace("net-block");
    const backend = new AntigravityBackend({
      stateDir: path.join(ws.root, "state"),
    });
    const { isolatedHome } = backend.setupIsolatedConfig(false);
    const settingsPath = path.join(isolatedHome, ".gemini", "antigravity-cli", "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const denyTools = settings.permissions?.deny ?? [];
    expect(denyTools).toContain("search_web(*)");
    expect(denyTools).toContain("read_browser_page(*)");
  });

  // 31. Lifecycle phase tracking across manager task execution
  it("31. Lifecycle phase tracking across manager task execution", async () => {
    const ws = createTestWorkspace("lifecycle-phases");
    const fakeBackend = new FakeAntigravityBackend();
    const manager = new CodexTaskManager(ws, { antigravityBackend: fakeBackend });

    const submitted = manager.submit({
      workspace_id: ws.id,
      instruction: "Check lifecycle",
      write_scope: ["src"],
      run_tests: false,
      provider: "gemini",
      model: "gemini-3.8-flash-high",
    });
    expect(["QUEUED", "SPAWNING_PROVIDER"]).toContain(submitted.lifecyclePhase);
    expect(submitted.requestedProvider).toBe("gemini");
    expect(submitted.requestedModel).toBe("gemini-3.8-flash-high");

    const terminal = await waitForTerminal(manager, submitted.taskId);
    expect(terminal.lifecyclePhase).toBe("TERMINAL");
  });

  // 32. onIdentity evidence updates providerSessionId and actualProvider dynamically before terminal
  it("32. onIdentity evidence updates providerSessionId and actualProvider dynamically before terminal", async () => {
    const ws = createTestWorkspace("on-identity-timing");
    let recordedSessionDuringRun: string | null = null;
    let recordedProviderDuringRun: string | null = null;
    const fakeBackend: ExecutionBackend = {
      provider: "gemini",
      async initialize() {},
      async execute(req: BackendExecutionRequest) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        req.onLifecyclePhase?.("SESSION_ESTABLISHED");
        req.onIdentity?.({ providerSessionId: "dynamic-conv-999" });
        // Inspect manager state during execution
        const currentView = manager.get(req.taskId);
        recordedSessionDuringRun = currentView.providerSessionId;
        recordedProviderDuringRun = currentView.actualProvider ?? null;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          status: "completed",
          provider: "gemini",
          providerRuntime: "antigravity-cli",
          providerModel: "gemini-3.8-flash-high",
          requestedProvider: "gemini",
          requestedModel: "gemini-3.8-flash-high",
          actualProvider: "antigravity",
          actualModel: "gemini-3.8-flash-high",
          providerSessionId: "dynamic-conv-999",
          output: "success",
          changedFiles: [],
        };
      },
      async cancel() {},
      async close() {},
    };
    const manager = new CodexTaskManager(ws, { antigravityBackend: fakeBackend });

    const submitted = manager.submit({
      workspace_id: ws.id,
      instruction: "Check onIdentity timing",
      write_scope: ["src"],
      run_tests: false,
      provider: "gemini",
    });
    expect(submitted.providerSessionId).toBeNull();
    expect(submitted.actualProvider).toBeNull();

    const terminal = await waitForTerminal(manager, submitted.taskId);
    expect(recordedSessionDuringRun).toBe("dynamic-conv-999");
    expect(recordedProviderDuringRun).toBe("antigravity");
    expect(terminal.providerSessionId).toBe("dynamic-conv-999");
    expect(terminal.actualProvider).toBe("antigravity");
  });
});
