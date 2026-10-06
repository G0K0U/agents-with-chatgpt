import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { AgentPlane, AgentPlaneError } from "../src/session-plane/plane.js";
import { loadZcodeSessionOwnership } from "../src/execution/zcode-session-ownership.js";
import type { DshNativeClient } from "../src/execution/dsh-native-client.js";
import { makeTmpDir, cleanup } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) cleanup(dir); });

describe("DSH in the shared agent plane", () => {
  it("discovers native Desktop sessions cold and fences them to the authorized workspace", async () => {
    const root = makeTmpDir("dsh-plane-root");
    const state = makeTmpDir("dsh-plane-state");
    dirs.push(root, state);
    const sessionId = `session-d2c-${"a".repeat(32)}`;
    const taskId = `c2c_dsh_${"b".repeat(24)}`;
    mkdirSync(join(state, "d2c"), { recursive: true });
    writeFileSync(join(state, "d2c", "bindings.json"), JSON.stringify({ version: 1,
      bindings: [{ sessionId, workspaceId: "ws-a", canonicalRoot: root,
        ownerId: "client-A", generation: "gen-1", createdAt: "2026-09-27T00:00:00.000Z" }] }));
    mkdirSync(join(state, "tasks", "ws-a"), { recursive: true });
    writeFileSync(join(state, "tasks", "ws-a", `${taskId}.json`), JSON.stringify({
      taskId, workspaceId: "ws-a", sessionId, ownerId: "client-A", provider: "dsh",
      providerModel: "Bonsai2-CRACK-PQ2.ninfer", status: "completed",
      instruction: "Create the test file", submittedAt: "2026-09-27T00:01:00.000Z",
      completedAt: "2026-09-27T00:02:00.000Z", outputIds: [], outputAvailable: false,
      nativeEvidence: { terminalSeq: 9, terminalReason: "completed", toolCalls: 2, toolResults: 2 },
    }));
    let reads = 0;
    const client = {
      list: async () => ({ generation: "gen-1", items: [{ sessionId, cwd: root,
        origin: "desktop", updatedAt: "2026-09-27T00:02:00.000Z", running: false, blank: false }] }),
      read: async () => { reads++; return { generation: "gen-1", sessionId, cwd: root,
        origin: "desktop", createdAt: "2026-09-27T00:00:00.000Z", running: false,
        status: "cold", lastSeq: 9,
        selection: { provider: "qqz-kvmem", model: "Bonsai2-CRACK-PQ2.ninfer", reasoningEffort: "high" },
        messages: [{ seq: 1, at: "2026-09-27T00:01:00.000Z", role: "user",
          text: "Create the test file", requestId: null, model: null, provider: null },
        { seq: 8, at: "2026-09-27T00:02:00.000Z", role: "assistant",
          text: "The file is ready", requestId: null, model: "Bonsai2-CRACK-PQ2.ninfer", provider: "qqz-kvmem" }] }; },
    } as unknown as DshNativeClient;
    const plane = new AgentPlane({ stateDir: state,
      workspaces: () => [{ workspaceId: "ws-a", canonicalPath: root }],
      zcodeClient: null, dshClient: client, ownership: loadZcodeSessionOwnership(state) });
    const allowed = { clientId: "client-A", extra: { authorizedWorkspaceIds: ["ws-a"] } } as unknown as AuthInfo;
    const denied = { clientId: "client-B", extra: { authorizedWorkspaceIds: [] } } as unknown as AuthInfo;
    const listed = await plane.listSessions(allowed, { provider: "dsh" });
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0]?.provider, "dsh");
    assert.equal(listed.sessions[0]?.origin, "a2c");
    assert.equal(listed.sessions[0]?.ownerClientId, "client-A");
    assert.deepEqual(listed.sessions[0]?.taskIds, [taskId]);
    assert.equal(reads, 0, "cold listing must not activate or inspect a native Agent");
    assert.equal(plane.readTask(allowed, "ws-a", taskId).nativeEvidence?.terminalSeq, 9);
    const messages = await plane.sessionMessages(allowed, sessionId);
    assert.equal(messages.messages_readable, true);
    assert.equal(messages.messages.at(-1)?.text, "The file is ready");
    assert.ok(reads > 0);
    assert.equal((await plane.listSessions(denied, { provider: "dsh" })).sessions.length, 0);
    await assert.rejects(() => plane.readSession(denied, sessionId),
      (error: unknown) => error instanceof AgentPlaneError
        && error.code === "AGENT_PLANE_SESSION_NOT_VISIBLE");
  });
});
