import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentPlane, AgentPlaneError } from "../src/session-plane/plane.js";
import { AgentPlaneStore } from "../src/session-plane/store.js";
import { loadZcodeSessionOwnership } from "../src/execution/zcode-session-ownership.js";
import type { ZcodeSessionClient, ZcodeDiscoveredSession } from "../src/execution/zcode-session-client.js";
import { saveExecutionOutput } from "../src/execution/output.js";

/**
 * Provider-neutral shared session/activity plane: projection, canonical-root
 * boundary, observe-vs-control authorization, redaction, pagination, and
 * restart durability.
 */

const WS_A = "f:\workspaces\engineering-ai";
const WS_B = "f:\workspaces\other-project";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "agent-plane-"));
}

interface Auth {
  clientId?: string;
  extra?: { authorizedWorkspaceIds?: string[] };
}
const local = undefined;
const clientA: Auth = { clientId: "client-A", extra: { authorizedWorkspaceIds: ["wsA", "wsB"] } };
const clientB: Auth = { clientId: "client-B", extra: { authorizedWorkspaceIds: ["wsB"] } };

const DISCOVERY: ZcodeDiscoveredSession[] = [
  {
    session_id: "sess_aaaaaaaa-1111-1111-1111-111111111111",
    workspace_id: "ws_grant_a",
    workspace_path: WS_A,
    status: "idle",
    title: "a2c zcode session",
    updated_at: "2026-09-22T01:00:00.000Z",
    controlled_by_z2c: true,
    owner_client_id: null,
    access_mode: "write",
    runtime_origin: "z2c",
  },
  {
    session_id: "sess_bbbbbbbb-2222-2222-2222-222222222222",
    workspace_id: "ws_grant_a",
    workspace_path: WS_A,
    status: "idle",
    title: "desktop session",
    updated_at: "2026-09-22T01:05:00.000Z",
    controlled_by_z2c: false,
    owner_client_id: null,
    access_mode: null,
    runtime_origin: "external",
  },
  {
    session_id: "sess_cccccccc-3333-3333-3333-333333333333",
    workspace_id: "ws_grant_escape",
    workspace_path: "d:\\elsewhere\\secret",
    status: "idle",
    title: "outside every approved root",
    updated_at: "2026-09-22T01:06:00.000Z",
    controlled_by_z2c: false,
    owner_client_id: null,
    access_mode: null,
    runtime_origin: "external",
  },
];

function fakeZcode(overrides: Partial<{ messages: Record<string, Array<Record<string, unknown>>> }> = {}): ZcodeSessionClient {
  return {
    discoverSessions: async () => ({ sessions: DISCOVERY }),
    observeSession: async () => ({
      session_id: DISCOVERY[0].session_id,
      workspace_id: "ws_grant_a",
      provider_id: "zai-api",
      model_id: "GLM-5.3-Flash",
      thought_level: "max",
      collaboration_mode: "edit",
      plan_enabled: null,
      runtime_version: "0.16.9",
      binding_source: "official-session-read",
    }),
    observeSessionMessages: async (input: { session_id: string }) => ({
      messages: overrides.messages?.[input.session_id] ?? [
        { info: { role: "user" }, parts: [{ type: "text", text: "list the files" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "there are 3 files" }, { type: "tool", state: { status: "completed" } }] },
        { info: { role: "assistant" }, parts: [{ type: "thinking", text: "PRIVATE CHAIN OF THOUGHT" }] },
        { info: { role: "system" }, parts: [{ type: "text", text: "SYSTEM PROMPT LEAK" }] },
      ],
    }),
  } as unknown as ZcodeSessionClient;
}

interface Harness {
  dir: string;
  plane: AgentPlane;
}

function build(): Harness {
  const dir = tmp();
  const ownership = loadZcodeSessionOwnership(dir);
  ownership.record({
    sessionId: "sess_aaaaaaaa-1111-1111-1111-111111111111",
    workspaceId: "wsA",
    clientId: "client-A",
    access: "write",
  });
  const plane = new AgentPlane({
    stateDir: dir,
    workspaces: () => [
      { workspaceId: "wsA", canonicalPath: WS_A },
      { workspaceId: "wsB", canonicalPath: WS_B },
    ],
    zcodeClient: fakeZcode(),
    ownership,
  });
  return { dir, plane };
}

function writeTask(dir: string, workspaceId: string, record: Record<string, unknown>): string {
  mkdirSync(join(dir, "tasks", workspaceId), { recursive: true });
  const file = join(dir, "tasks", workspaceId, `${record.taskId as string}.json`);
  writeFileSync(file, JSON.stringify(record));
  return file;
}

const CODEX_TASK = {
  taskId: "c2c_codextask01",
  workspaceId: "wsB",
  ownerId: "client-A",
  sessionId: "c2cs_codexsession01",
  instruction: "fix the flaky test",
  instructionHash: "hash",
  provider: "codex",
  providerModel: "gpt-6-astra",
  threadId: "thread_123",
  status: "completed",
  submittedAt: "2026-09-22T02:00:00.000Z",
  completedAt: "2026-09-22T02:01:00.000Z",
  changedFiles: ["src/a.ts"],
  outputIds: [1],
  outputAvailable: true,
  network: false,
  networkRequested: false,
  networkEffective: false,
  actionEvidence: { turnCompleted: true, changedFiles: 1, finalOutputCaptured: true },
  verification: { status: "passed", exitCode: 0, completedAt: "2026-09-22T02:01:30.000Z", outputId: 2 },
};

const GEMINI_TASK = {
  taskId: "c2c_geminiprov1",
  workspaceId: "wsB",
  ownerId: "client-A",
  sessionId: "c2cs_geminisession1",
  instruction: "draft the api notes with password: hunter2 inside",
  instructionHash: "hash2",
  provider: "gemini",
  providerModel: "gemini-3.8-flash-high",
  providerSessionId: "conv_8842",
  status: "failed",
  submittedAt: "2026-09-22T02:02:00.000Z",
  completedAt: "2026-09-22T02:03:00.000Z",
  changedFiles: [],
  outputIds: [2],
  network: false,
  error: { code: "ANTIGRAVITY_SESSION_START_FAILED", message: "stale conversation" },
};

describe("shared plane projection", () => {
  let h: Harness;
  beforeEach(() => {
    h = build();
    writeTask(h.dir, "wsB", CODEX_TASK);
    writeTask(h.dir, "wsB", GEMINI_TASK);
    saveExecutionOutput("wsB", { command: "codex:final-assistant-message", raw: "ALL TESTS PASS now", taskId: CODEX_TASK.taskId, sessionId: CODEX_TASK.sessionId }, h.dir);
    saveExecutionOutput("wsB", { command: "gemini:final-assistant-message", raw: "DRAFT COMPLETE: api notes ready", taskId: GEMINI_TASK.taskId, sessionId: GEMINI_TASK.sessionId }, h.dir);
  });

  it("projects zcode sessions with origin/owner/controller and denies root escapes", async () => {
    const { sessions } = await h.plane.listSessions(local, { provider: "zcode" });
    const ids = sessions.map((s) => s.sessionId);
    assert.ok(ids.includes("sess_aaaaaaaa-1111-1111-1111-111111111111"));
    assert.ok(ids.includes("sess_bbbbbbbb-2222-2222-2222-222222222222"));
    // d:\elsewhere is outside every A2C-authorized workspace → never projected.
    assert.ok(!ids.includes("sess_cccccccc-3333-3333-3333-333333333333"));
    const a2c = sessions.find((s) => s.sessionId === "sess_aaaaaaaa-1111-1111-1111-111111111111")!;
    assert.equal(a2c.origin, "a2c");
    assert.equal(a2c.ownerClientId, "client-A");
    assert.ok(a2c.controllers.includes("client-A") && a2c.controllers.includes("local"));
    const desktop = sessions.find((s) => s.sessionId === "sess_bbbbbbbb-2222-2222-2222-222222222222")!;
    assert.equal(desktop.origin, "desktop");
    assert.equal(desktop.ownerClientId, null);
    assert.deepEqual(desktop.controllers, ["local"]);
  });

  it("projects codex and gemini A2C sessions from durable task records", async () => {
    const { sessions } = await h.plane.listSessions(local, { origin: "a2c" });
    const codex = sessions.find((s) => s.sessionId === "c2cs_codexsession01");
    assert.ok(codex);
    assert.equal(codex!.provider, "codex");
    assert.equal(codex!.providerSessionId, "thread_123");
    assert.equal(codex!.status, "completed");
    assert.deepEqual(codex!.taskIds, ["c2c_codextask01"]);
    assert.equal(codex!.changedFilesCount, 1);
    assert.equal(codex!.verificationStatus, "passed");
    assert.deepEqual(codex!.lastAssistantOutput, { workspaceId: "wsB", outputId: 1 });
    const gemini = sessions.find((s) => s.sessionId === "c2cs_geminisession1");
    assert.ok(gemini);
    assert.equal(gemini!.provider, "gemini");
    assert.equal(gemini!.providerSessionId, "conv_8842");
    assert.equal(gemini!.status, "failed");
    assert.equal(gemini!.model, "gemini-3.8-flash-high");
    assert.deepEqual(gemini!.lastAssistantOutput, { workspaceId: "wsB", outputId: 2 });
    // Final output projection: the captured gemini assistant body is served
    // through the sanitized output reader with a resolvable reference.
    const geminiMsgs = await h.plane.sessionMessages(local, "c2cs_geminisession1");
    const geminiOut = geminiMsgs.messages.find((m) => m.role === "assistant");
    assert.equal(geminiOut?.text, "DRAFT COMPLETE: api notes ready");
    assert.deepEqual(geminiOut?.outputRef, { workspaceId: "wsB", outputId: 2 });
  });

  it("agent_task_read exposes actionEvidence and verification metadata", () => {
    const view = h.plane.readTask(local, "wsB", "c2c_codextask01");
    assert.equal(view.provider, "codex");
    assert.deepEqual(view.actionEvidence, { turnCompleted: true, changedFiles: 1, finalOutputCaptured: true });
    assert.equal(view.verification?.status, "passed");
    assert.equal(view.instructionPreview, "fix the flaky test");
  });

  it("redacts secrets and masks local paths in every projected text", async () => {
    const view = h.plane.readTask(local, "wsB", "c2c_geminiprov1");
    assert.ok(!view.instructionPreview!.includes("hunter2"));
    assert.ok(view.instructionPreview!.includes("[REDACTED]"));
    const secretTask = { ...CODEX_TASK, taskId: "c2c_secretx0001", sessionId: "c2cs_secretviewer01", instruction: "use key sk-abcDEF1234567890123456 and read F:\\ai-startup\\secret.env" };
    writeTask(h.dir, "wsB", secretTask);
    await h.plane.sync(true);
    const { sessions } = await h.plane.listSessions(local, {});
    const secret = sessions.find((s) => s.taskIds.includes("c2c_secretx0001"))!;
    assert.ok(!secret.lastUserInstruction!.includes("sk-abcDEF1234567890123456"));
    assert.ok(!secret.lastUserInstruction!.includes("secret.env"));
  });

  it("projects only visible user/assistant text messages for zcode (no CoT, no tool internals, no system)", async () => {
    const result = await h.plane.sessionMessages(local, "sess_aaaaaaaa-1111-1111-1111-111111111111");
    assert.equal(result.provider, "zcode");
    const text = JSON.stringify(result.messages);
    assert.ok(result.messages.some((m) => m.role === "user" && m.text === "list the files"));
    assert.ok(result.messages.some((m) => m.role === "assistant" && m.text.includes("there are 3 files")));
    assert.ok(!text.includes("PRIVATE CHAIN OF THOUGHT"));
    assert.ok(!text.includes("SYSTEM PROMPT LEAK"));
    assert.ok(!text.includes("tool"));
  });

  it("zcode live messages never leak credentials", async () => {
    const plane = new AgentPlane({
      stateDir: h.dir,
      workspaces: () => [{ workspaceId: "wsA", canonicalPath: WS_A }],
      zcodeClient: fakeZcode({
        messages: {
          "sess_aaaaaaaa-1111-1111-1111-111111111111": [
            { info: { role: "assistant" }, parts: [{ type: "text", text: "password: hunter2 and sk-abcDEF1234567890123456" }] },
          ],
        },
      }),
      ownership: loadZcodeSessionOwnership(h.dir),
    });
    const result = await plane.sessionMessages(local, "sess_aaaaaaaa-1111-1111-1111-111111111111");
    const text = JSON.stringify(result.messages);
    assert.ok(!text.includes("hunter2"));
    assert.ok(!text.includes("sk-abcDEF1234567890123456"));
    assert.ok(text.includes("[REDACTED]"));
  });

  it("serves captured assistant output for codex/gemini sessions with references", async () => {
    const result = await h.plane.sessionMessages(local, "c2cs_codexsession01");
    assert.equal(result.provider, "codex");
    assert.equal(result.messages[0].role, "user");
    assert.equal(result.messages[0].text, "fix the flaky test");
    const assistant = result.messages.find((m) => m.role === "assistant")!;
    assert.equal(assistant.text, "ALL TESTS PASS now");
    assert.deepEqual(assistant.outputRef, { workspaceId: "wsB", outputId: 1 });
  });

  it("restricted output bodies are never returned, only a restricted marker", async () => {
    const secretTask = {
      ...CODEX_TASK,
      taskId: "c2c_restricted01",
      sessionId: "c2cs_restricted001",
      outputIds: [3],
    };
    writeTask(h.dir, "wsB", secretTask);
    // Output id 2 is a hard-rejected private key body → never readable.
    saveExecutionOutput("wsB", { command: "codex:final-assistant-message", raw: "-----BEGIN RSA PRIVATE KEY-----\nnope\n-----END RSA PRIVATE KEY-----", taskId: secretTask.taskId, sessionId: "c2cs_restricted001" }, h.dir);
    const result = await h.plane.sessionMessages(local, "c2cs_restricted001");
    const assistant = result.messages.find((m) => m.role === "assistant")!;
    assert.equal(assistant.restricted, true);
    assert.equal(assistant.text, "");
  });
});

describe("shared plane authorization (observe ≠ control)", () => {
  let h: Harness;
  beforeEach(() => {
    h = build();
    writeTask(h.dir, "wsB", CODEX_TASK);
  });

  it("local operator observes all authorized workspaces", async () => {
    const { sessions } = await h.plane.listSessions(local, {});
    assert.ok(sessions.some((s) => s.provider === "zcode"));
    assert.ok(sessions.some((s) => s.provider === "codex"));
  });

  it("workspace-authorized observer reads another client's native/a2c session but cannot control it", async () => {
    // client-B is authorized only for wsB; the desktop zcode session is wsA.
    await assert.rejects(
      () => h.plane.readSession(clientB as never, "sess_bbbbbbbb-2222-2222-2222-222222222222"),
      (err: AgentPlaneError) => err.code === "AGENT_PLANE_SESSION_NOT_VISIBLE",
    );
    // Same-workspace observer: client-A sees the desktop session (observe) but
    // is not a controller of it.
    const desktop = await h.plane.readSession(clientA as never, "sess_bbbbbbbb-2222-2222-2222-222222222222");
    assert.equal(desktop.origin, "desktop");
    assert.equal(h.plane.callerCanControl(clientA as never, desktop), false);
    const localView = await h.plane.readSession(local, "sess_bbbbbbbb-2222-2222-2222-222222222222");
    assert.equal(h.plane.callerCanControl(local, localView), true);
  });

  it("cross-client observation of an a2c-owned session works; control stays with the owner", async () => {
    const { sessions } = await h.plane.listSessions(clientA as never, { provider: "codex" });
    const codex = sessions.find((s) => s.sessionId === "c2cs_codexsession01")!;
    assert.ok(codex, "same-workspace observer sees the codex session");
    assert.equal(h.plane.callerCanControl(clientA as never, codex), true);
  });

  it("foreign workspace / client denials are indistinguishable from unknown ids", async () => {
    // client-B cannot see the zcode wsA session; the denial must not reveal existence.
    await assert.rejects(
      () => h.plane.readSession(clientB as never, "sess_aaaaaaaa-1111-1111-1111-111111111111"),
      (err: AgentPlaneError) => err.code === "AGENT_PLANE_SESSION_NOT_VISIBLE",
    );
    await assert.rejects(
      () => h.plane.readSession(clientB as never, "sess_ffffffff-ffff-ffff-ffff-ffffffffffff"),
      (err: AgentPlaneError) => err.code === "AGENT_PLANE_SESSION_NOT_VISIBLE",
    );
    assert.throws(
      () => h.plane.readTask(clientB as never, "wsA", "c2c_codextask01"),
      (err: AgentPlaneError) => err.code === "AGENT_PLANE_WORKSPACE_FORBIDDEN",
    );
    assert.throws(
      () => h.plane.readOutput(clientB as never, "wsA", 1),
      (err: AgentPlaneError) => err.code === "AGENT_PLANE_WORKSPACE_FORBIDDEN",
    );
  });

  it("activity is workspace-filtered per caller", async () => {
    await h.plane.sync(true);
    const all = await h.plane.listActivity(local, {});
    assert.ok(all.events.length >= 3);
    const onlyB = await h.plane.listActivity(clientB as never, {});
    assert.ok(onlyB.events.every((e) => e.workspaceId === "wsB"));
    assert.ok(onlyB.events.some((e) => e.taskId === "c2c_codextask01"));
    assert.ok(!onlyB.events.some((e) => e.provider === "zcode"));
  });
});

describe("shared plane bounds and durability", () => {
  it("paginates sessions with bounded limits and cursors", async () => {
    const h = build();
    try {
      for (let i = 0; i < 7; i++) {
        writeTask(h.dir, "wsB", {
          ...CODEX_TASK,
          taskId: `c2c_page_task${String(i).padStart(2, "0")}`,
          sessionId: `c2cs_page_session${String(i).padStart(2, "0")}`,
          submittedAt: `2026-09-22T0${i}:00:00.000Z`,
        });
      }
      const page1 = await h.plane.listSessions(local, { limit: 3 });
      assert.equal(page1.sessions.length, 3);
      assert.ok(page1.nextCursor);
      const page2 = await h.plane.listSessions(local, { limit: 3, cursor: page1.nextCursor! });
      assert.equal(page2.sessions.length, 3);
      const seen = new Set([...page1.sessions, ...page2.sessions].map((s) => s.sessionId));
      assert.equal(seen.size, 6);
      const page3 = await h.plane.listSessions(local, { limit: 3, cursor: page2.nextCursor! });
      assert.ok(page3.sessions.length >= 1);
      // Invalid cursors are not errors.
      const bad = await h.plane.listSessions(local, { limit: 3, cursor: "!!!not-a-cursor!!!" });
      assert.equal(bad.sessions.length, 3);
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it("caps activity page size even when asked for more", async () => {
    const h = build();
    try {
      await h.plane.sync(true);
      const big = await h.plane.listActivity(local, { limit: 10_000 });
      assert.ok(big.events.length <= 100);
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it("activity keys dedupe across syncs and restarts (no duplicate history)", async () => {
    const h = build();
    const catalog = () => [{ workspaceId: "wsA", canonicalPath: WS_A }, { workspaceId: "wsB", canonicalPath: WS_B }];
    try {
      await h.plane.sync(true);
      const first = await h.plane.listActivity(local, {});
      await h.plane.sync(true);
      await h.plane.sync(true);
      const second = await h.plane.listActivity(local, {});
      assert.equal(second.events.length, first.events.length);
      // New store instance = restart: persisted key index prevents duplicates.
      const plane2 = new AgentPlane({
        stateDir: h.dir,
        workspaces: catalog,
        zcodeClient: fakeZcode(),
        ownership: loadZcodeSessionOwnership(h.dir),
      });
      await plane2.sync(true);
      const afterRestart = await plane2.listActivity(local, {});
      assert.equal(afterRestart.events.length, first.events.length);
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it("session projection survives a restart (durable store)", async () => {
    const h = build();
    try {
      await h.plane.sync(true);
      const plane2 = new AgentPlane({
        stateDir: h.dir,
        workspaces: () => [{ workspaceId: "wsA", canonicalPath: WS_A }],
        zcodeClient: fakeZcode(),
        ownership: loadZcodeSessionOwnership(h.dir),
      });
      const { sessions } = await plane2.listSessions(local, { provider: "zcode" });
      assert.ok(sessions.some((s) => s.sessionId === "sess_aaaaaaaa-1111-1111-1111-111111111111"));
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it("store enforces record caps", () => {
    const dir = tmp();
    try {
      const store = new AgentPlaneStore(dir);
      const now = new Date().toISOString();
      store.saveSessions(
        Array.from({ length: 5010 }, (_, i) => ({
          sessionId: `c2cs_${String(i).padStart(16, "0")}`,
          provider: "codex" as const,
          origin: "a2c" as const,
          workspaceId: "wsB",
          canonicalRoot: WS_B,
          nativeSessionId: null,
          providerSessionId: null,
          ownerClientId: "client-A",
          controllers: ["client-A"],
          model: null,
          thoughtLevel: null,
          status: "completed",
          title: null,
          createdAt: now,
          updatedAt: now,
          taskIds: [],
          lastUserInstruction: null,
          lastAssistantOutput: null,
          changedFilesCount: 0,
          verificationStatus: null,
          observedAt: now,
        })),
      );
      assert.ok(store.loadSessions().length <= 5000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
