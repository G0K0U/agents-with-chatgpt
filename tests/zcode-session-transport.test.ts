import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ZcodeSessionClient,
  ZcodeSessionError,
  type ZcodeSessionConfig,
  type ZcodeWorkspaceGrant,
} from "../src/execution/zcode-session-client.js";

const TEST_TOKEN = "z2cs_transport_test_token_abcdef123456";

interface ServerControl {
  handshakeCount: number;
  sendDispatchCount: number;
  createDispatchCount: number;
  setModelDispatchCount: number;
  setThoughtDispatchCount: number;
  readDispatchCount: number;
  authApiHits: number;
  disconnectOnSend: boolean;
  disconnectOnCreate: boolean;
  disconnectOnSetModel: boolean;
  disconnectOnSetThought: boolean;
  readFailuresRemaining: number;
  readUpstreamError: string | null;
  requireAuth: boolean;
  stallHandshake: boolean;
  handshakeDelayMs: number;
  workspaceListFails: boolean;
  workspaceListMalformed: boolean;
  workspaces: ZcodeWorkspaceGrant[];
}

describe("ZcodeSessionClient transport safety & single-flight", () => {
  let server: Server;
  let serverUrl: string;
  let apiBase: string;

  const control: ServerControl & { authFailuresCount: number } = {
    handshakeCount: 0,
    sendDispatchCount: 0,
    createDispatchCount: 0,
    setModelDispatchCount: 0,
    setThoughtDispatchCount: 0,
    readDispatchCount: 0,
    authApiHits: 0,
    authFailuresCount: 0,
    disconnectOnSend: false,
    disconnectOnCreate: false,
    disconnectOnSetModel: false,
    disconnectOnSetThought: false,
    readFailuresRemaining: 0,
    readUpstreamError: null,
    requireAuth: true,
    stallHandshake: false,
    handshakeDelayMs: 0,
    workspaceListFails: false,
    workspaceListMalformed: false,
    workspaces: [],
  };

  function resetControl() {
    control.handshakeCount = 0;
    control.sendDispatchCount = 0;
    control.createDispatchCount = 0;
    control.setModelDispatchCount = 0;
    control.setThoughtDispatchCount = 0;
    control.readDispatchCount = 0;
    control.authApiHits = 0;
    control.authFailuresCount = 0;
    control.disconnectOnSend = false;
    control.disconnectOnCreate = false;
    control.disconnectOnSetModel = false;
    control.disconnectOnSetThought = false;
    control.readFailuresRemaining = 0;
    control.readUpstreamError = null;
    control.requireAuth = true;
    control.stallHandshake = false;
    control.handshakeDelayMs = 0;
    control.workspaceListFails = false;
    control.workspaceListMalformed = false;
    control.workspaces = [];
  }

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        if (control.stallHandshake && req.url?.startsWith("/mcp")) {
          // Never respond to simulate stalled handshake
          return;
        }

        const auth = req.headers.authorization ?? "";
        if (control.requireAuth && auth !== `Bearer ${TEST_TOKEN}`) {
          control.authFailuresCount++;
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }

        // Workspace authorization REST API
        if (req.url?.startsWith("/api/workspaces/authorize")) {
          control.authApiHits++;
          let body = "";
          for await (const chunk of req) body += chunk;
          const parsed = JSON.parse(body || "{}") as { path?: string; write?: boolean };
          const grant: ZcodeWorkspaceGrant = {
            workspace_id: "ws_authorized_1",
            canonical_path: parsed.path ?? "c:\\test",
            display_name: "a2c-shared",
            permissions: { read: true, write: parsed.write ?? false },
          };
          control.workspaces.push(grant);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(grant));
          return;
        }

        if (req.url?.startsWith("/mcp")) {
          let body = "";
          for await (const chunk of req) body += chunk;
          const json = JSON.parse(body || "{}") as {
            id?: number | string;
            method?: string;
            params?: { name?: string; arguments?: Record<string, unknown> };
          };

          if (json.method === "initialize") {
            control.handshakeCount++;
            if (control.handshakeDelayMs) await new Promise((resolve) => setTimeout(resolve, control.handshakeDelayMs));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: json.id,
                result: {
                  protocolVersion: "2024-11-05",
                  capabilities: { tools: {} },
                  serverInfo: { name: "z2c-service", version: "0.1.0" },
                },
              }),
            );
            return;
          }

          if (json.method === "notifications/initialized") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({}));
            return;
          }

          if (json.method === "tools/call") {
            const toolName = json.params?.name;

            if (toolName === "zcode_session_send") {
              control.sendDispatchCount++;
              if (control.disconnectOnSend) {
                // Abrupt drop after dispatch accepted
                res.destroy();
                return;
              }
              res.writeHead(200, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: json.id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify({
                          state: { session_id: "sess_1", workspace_id: "ws_1" },
                          output: "done",
                          turn: "turn_1",
                        }),
                      },
                    ],
                  },
                }),
              );
              return;
            }

            if (toolName === "zcode_session_create") {
              control.createDispatchCount++;
              if (control.disconnectOnCreate) {
                res.destroy();
                return;
              }
              res.writeHead(200, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: json.id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify({
                          session_id: "sess_created_1",
                          workspace_id: "ws_1",
                          provider_id: "zai-api",
                          model_id: "GLM-5.3",
                          thought_level: "max",
                          collaboration_mode: "edit",
                          plan_enabled: false,
                          runtime_version: "0.16.9",
                          binding_source: "official-session-read",
                        }),
                      },
                    ],
                  },
                }),
              );
              return;
            }

            if (toolName === "zcode_session_set_model") {
              control.setModelDispatchCount++;
              if (control.disconnectOnSetModel) {
                res.destroy();
                return;
              }
              res.writeHead(200, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: json.id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify({
                          session_id: "sess_1",
                          workspace_id: "ws_1",
                          model_id: "GLM-5.3-New",
                        }),
                      },
                    ],
                  },
                }),
              );
              return;
            }

            if (toolName === "zcode_session_set_thought_level") {
              control.setThoughtDispatchCount++;
              if (control.disconnectOnSetThought) {
                res.destroy();
                return;
              }
              res.writeHead(200, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: json.id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify({
                          session_id: "sess_1",
                          workspace_id: "ws_1",
                          thought_level: "high",
                        }),
                      },
                    ],
                  },
                }),
              );
              return;
            }

            if (toolName === "zcode_session_read" || toolName === "zcode_runtime_capabilities") {
              control.readDispatchCount++;
              if (control.readFailuresRemaining > 0) {
                control.readFailuresRemaining--;
                res.destroy();
                return;
              }
              if (control.readUpstreamError) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: json.id,
                    result: {
                      isError: true,
                      content: [{ type: "text", text: control.readUpstreamError }],
                    },
                  }),
                );
                return;
              }
              res.writeHead(200, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: json.id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify({
                          session_id: "sess_1",
                          workspace_id: "ws_1",
                          provider_id: "zai-api",
                          model_id: "GLM-5.3",
                          thought_level: "max",
                          collaboration_mode: "edit",
                          plan_enabled: false,
                          runtime_version: "0.16.9",
                          binding_source: "official-session-read",
                        }),
                      },
                    ],
                  },
                }),
              );
              return;
            }

            if (toolName === "zcode_workspace_list") {
              if (control.workspaceListFails) {
                res.destroy();
                return;
              }
              res.writeHead(200, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: json.id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify(control.workspaceListMalformed ? { malformed: true } : { workspaces: control.workspaces }),
                      },
                    ],
                  },
                }),
              );
              return;
            }

            // Default mock response
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: json.id,
                result: { content: [{ type: "text", text: "{}" }] },
              }),
            );
            return;
          }
        }

        res.writeHead(404);
        res.end();
      })();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${addr.port}/mcp`;
    apiBase = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    resetControl();
  });

  function makeClient(overrides?: Partial<ZcodeSessionConfig>): ZcodeSessionClient {
    return new ZcodeSessionClient({
      url: serverUrl,
      apiBase,
      token: TEST_TOKEN,
      requestTimeoutMs: 5000,
      ...overrides,
    });
  }

  it("lost response after accepted-send dispatch count1", async () => {
    control.disconnectOnSend = true;
    const client = makeClient();

    let threw = false;
    try {
      await client.sendSession({
        workspace_id: "ws_1",
        session_id: "sess_1",
        instruction: "mutate workspace",
        timeout_ms: 10000,
      });
    } catch (err) {
      threw = true;
      assert(err instanceof ZcodeSessionError, "must be ZcodeSessionError");
      assert.equal(err.code, "ZCODE_SESSION_OUTCOME_UNKNOWN");
      assert(err.message.includes("Mutation dispatch outcome unknown"), "must state outcome unknown");
      assert(err.message.includes("Observe session"), "must require observation");
      assert(!err.message.includes(TEST_TOKEN), "token must be scrubbed");
    } finally {
      client.close();
    }

    assert.equal(threw, true, "sendSession must throw on lost response");
    assert.equal(control.sendDispatchCount, 1, "send dispatch count must be exactly 1 (no replay)");
  });

  it("create/set no replay", async () => {
    // 1. createSession no replay
    control.disconnectOnCreate = true;
    const client1 = makeClient();
    let createThrew = false;
    try {
      await client1.createSession({ workspace_id: "ws_1", access: "write" });
    } catch (err) {
      createThrew = true;
      assert(err instanceof ZcodeSessionError);
      assert.equal(err.code, "ZCODE_SESSION_OUTCOME_UNKNOWN");
    } finally {
      client1.close();
    }
    assert.equal(createThrew, true);
    assert.equal(control.createDispatchCount, 1, "create dispatch count must be exactly 1");

    // 2. setModel no replay
    control.disconnectOnSetModel = true;
    const client2 = makeClient();
    let setModelThrew = false;
    try {
      await client2.setModel({ workspace_id: "ws_1", session_id: "sess_1", model: "GLM-5.3-New" });
    } catch (err) {
      setModelThrew = true;
      assert(err instanceof ZcodeSessionError);
      assert.equal(err.code, "ZCODE_SESSION_OUTCOME_UNKNOWN");
    } finally {
      client2.close();
    }
    assert.equal(setModelThrew, true);
    assert.equal(control.setModelDispatchCount, 1, "setModel dispatch count must be exactly 1");

    // 3. setThoughtLevel no replay
    control.disconnectOnSetThought = true;
    const client3 = makeClient();
    let setThoughtThrew = false;
    try {
      await client3.setThoughtLevel({ workspace_id: "ws_1", session_id: "sess_1", thought_level: "high" });
    } catch (err) {
      setThoughtThrew = true;
      assert(err instanceof ZcodeSessionError);
      assert.equal(err.code, "ZCODE_SESSION_OUTCOME_UNKNOWN");
    } finally {
      client3.close();
    }
    assert.equal(setThoughtThrew, true);
    assert.equal(control.setThoughtDispatchCount, 1, "setThoughtLevel dispatch count must be exactly 1");
  });

  it("read reconnect once", async () => {
    control.readFailuresRemaining = 1; // 1st attempt disconnects, 2nd attempt succeeds
    const client = makeClient();
    try {
      const state = await client.readSession({ workspace_id: "ws_1", session_id: "sess_1" });
      assert.equal(state.session_id, "sess_1");
      assert.equal(control.readDispatchCount, 2, "read must retry once on transport disconnect");
    } finally {
      client.close();
    }

    // Verify when both fail, it does not retry a second time
    control.readDispatchCount = 0;
    control.readFailuresRemaining = 2; // both attempts disconnect
    const client2 = makeClient();
    let threw = false;
    try {
      await client2.readSession({ workspace_id: "ws_1", session_id: "sess_1" });
    } catch (err) {
      threw = true;
      assert(err instanceof ZcodeSessionError);
      assert.equal(err.code, "ZCODE_SESSION_UNAVAILABLE");
    } finally {
      client2.close();
    }
    assert.equal(threw, true);
    assert.equal(control.readDispatchCount, 2, "must attempt at most 2 times total (1 retry only)");
  });

  it("upstream/auth not retried", async () => {
    // Part A: Upstream tool error never retried
    control.readUpstreamError = "SESSION_NOT_FOUND: target session missing";
    const client1 = makeClient();
    let upstreamThrew = false;
    try {
      await client1.readSession({ workspace_id: "ws_1", session_id: "sess_missing" });
    } catch (err) {
      upstreamThrew = true;
      assert(err instanceof ZcodeSessionError);
      assert.equal(err.code, "ZCODE_SESSION_UPSTREAM");
      assert.equal(err.upstreamCode, "SESSION_NOT_FOUND");
    } finally {
      client1.close();
    }
    assert.equal(upstreamThrew, true);
    assert.equal(control.readDispatchCount, 1, "upstream error must never be retried");

    // Part B: Auth error (401) never retried
    const client2 = makeClient({ token: "invalid_secret_token" });
    let authThrew = false;
    try {
      await client2.readSession({ workspace_id: "ws_1", session_id: "sess_1" });
    } catch (err) {
      authThrew = true;
      assert(err instanceof ZcodeSessionError);
      assert.equal(err.code, "ZCODE_SESSION_UNAUTHORIZED");
    } finally {
      client2.close();
    }
    assert.equal(authThrew, true);
    assert.equal(control.authFailuresCount, 1, "rejected auth must fail immediately without retry");
  });

  it("concurrent read one handshake", async () => {
    const client = makeClient();
    try {
      const results = await Promise.all([
        client.readSession({ workspace_id: "ws_1", session_id: "sess_1" }),
        client.readSession({ workspace_id: "ws_1", session_id: "sess_1" }),
        client.readSession({ workspace_id: "ws_1", session_id: "sess_1" }),
        client.readSession({ workspace_id: "ws_1", session_id: "sess_1" }),
      ]);
      assert.equal(results.length, 4);
      assert.equal(control.handshakeCount, 1, "concurrent reads must share single in-flight handshake");
    } finally {
      client.close();
    }
  });

  it("bounded stalledhandshake", async () => {
    control.stallHandshake = true;
    const client = makeClient({ requestTimeoutMs: 150 });
    const start = Date.now();
    let timedOut = false;
    try {
      await client.readSession({ workspace_id: "ws_1", session_id: "sess_1" });
    } catch (err) {
      timedOut = true;
      assert(err instanceof ZcodeSessionError);
      assert.equal(err.code, "ZCODE_SESSION_TIMEOUT");
    } finally {
      client.close();
    }
    const elapsed = Date.now() - start;
    assert.equal(timedOut, true, "stalled handshake must time out");
    assert(elapsed < 2000, `handshake timeout must be bounded, took ${elapsed}ms`);
    assert.equal(client.activeSession, null, "timed-out client must be null");
  });

  it("late old failure cannot clobber newer", async () => {
    const client = makeClient();
    try {
      // Connect first session
      await client.readSession({ workspace_id: "ws_1", session_id: "sess_1" });
      const session1 = client.activeSession;
      assert(session1 !== null, "session1 must be active");

      // Replace with new session
      client.resetSession();
      await client.readSession({ workspace_id: "ws_1", session_id: "sess_1" });
      const session2 = client.activeSession;
      assert(session2 !== null, "session2 must be active");
      assert.notEqual(session1, session2, "session2 must be a replacement client");

      // Simulate a late error on session1 attempting to reset
      client.resetSession(session1);

      // Identity fence: session2 must still be intact and not clobbered
      assert.equal(client.activeSession, session2, "newer session must not be clobbered by late old failure");
    } finally {
      client.close();
    }
  });

  it("late old failure cannot cancel a replacement handshake before assignment", async () => {
    const client = makeClient();
    try {
      await client.readSession({ workspace_id: "ws_1", session_id: "sess_1" });
      const old = client.activeSession;
      assert(old);
      client.resetSession();
      control.handshakeDelayMs = 100;
      const replacement = client.readSession({ workspace_id: "ws_1", session_id: "sess_1" });
      const deadline = Date.now() + 1000;
      while (control.handshakeCount < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(control.handshakeCount, 2, "replacement handshake must be in flight");
      assert.equal(client.activeSession, null, "replacement has not yet been assigned");
      client.resetSession(old);
      assert.equal((await replacement).session_id, "sess_1");
      assert(client.activeSession, "replacement must survive stale failure");
      assert.equal(control.handshakeCount, 2, "no extra handshake should be needed");
    } finally {
      client.close();
    }
  });

  it("failed grant list no autoauthorize", async () => {
    control.workspaceListFails = true;
    const client = makeClient();
    let listFailed = false;
    try {
      await client.ensureGrant("c:\\ai\\project", false);
    } catch (err) {
      listFailed = true;
      assert(err instanceof ZcodeSessionError);
      assert.equal(err.code, "ZCODE_SESSION_UNAVAILABLE");
    } finally {
      client.close();
    }
    assert.equal(listFailed, true, "ensureGrant must fail if workspaceList fails");
    assert.equal(control.authApiHits, 0, "failed grant list MUST NOT invoke authorizeWorkspace");

    // Contrast: actual successful empty grant list DOES invoke authorizeWorkspace
    control.workspaceListFails = false;
    control.workspaces = [];
    const client2 = makeClient();
    try {
      const grant = await client2.ensureGrant("c:\\ai\\project", false);
      assert.equal(grant.workspace_id, "ws_authorized_1");
      assert.equal(control.authApiHits, 1, "successful empty grant list properly invokes authorizeWorkspace");
    } finally {
      client2.close();
    }
  });

  it("malformed successful grant list cannot create a new grant", async () => {
    control.workspaceListMalformed = true;
    const client = makeClient();
    try {
      await assert.rejects(client.ensureGrant("c:\\ai\\project", false), (err: unknown) =>
        err instanceof ZcodeSessionError && err.code === "ZCODE_SESSION_UPSTREAM");
      assert.equal(control.authApiHits, 0);
    } finally {
      client.close();
    }
  });
});
