// Offline fake-clock tests for the model-catalog observation loop:
// shared deadline, per-call budget timeouts, late-success suppression,
// multi-candidate exhaustion, honest attempt records with sanitized errors,
// and zero session lifecycle operations. No real agent, no credentials.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import {
  observeZcodeCatalog,
  sanitizeObservationText,
  classifyObservationError,
  adaptZcodeProviderToCatalogPort,
  buildMcpServer,
  runAsPrincipal,
} from "../src/service/server.js";
import { ZcodeOfficialProvider } from "../src/providers/zcode/official.js";
import { ZcodeProtocol, type ProtocolTransport } from "../src/providers/zcode/protocol.js";
import type { AgentProvider } from "../src/providers/types.js";
import { loadConfig } from "../src/config.js";
import { SessionService } from "../src/service/sessions.js";
import { loadWorkspaceGrants } from "../src/authz/grants.js";
import { loadSessionOwnership } from "../src/authz/ownership.js";
import { loadOrCreateSecurity } from "../src/service/security.js";
import { loadPairing, LOCAL_PRINCIPAL } from "../src/authz/pairing.js";
import { FileAuditLog } from "../src/util/log.js";
import type { TaskEngine } from "../src/core/tasks/engine.js";

function fakeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

interface Harness {
  calls: Array<{ what: string; sessionId?: string; timeoutMs?: number; workspace?: unknown }>;
  lifecycleCalls: number;
  candidates: Array<{ sessionId: string; updatedAt?: number }>;
  readBehavior: (sessionId: string, timeoutMs?: number) => Promise<unknown>;
  clock: ReturnType<typeof fakeClock>;
  port: Parameters<typeof observeZcodeCatalog>[0];
}

function harness(
  overrides: Partial<Pick<Harness, "candidates" | "readBehavior">> = {},
  startBudget = 8000
): Harness & { options: Parameters<typeof observeZcodeCatalog>[1] } {
  const clock = fakeClock();
  const h: Harness = {
    calls: [],
    lifecycleCalls: 0,
    candidates: overrides.candidates ?? [
      { sessionId: "sess_a", updatedAt: 30 },
      { sessionId: "sess_b", updatedAt: 20 },
    ],
    readBehavior: overrides.readBehavior ?? (async () => null),
    clock,
    port: null as unknown as Parameters<typeof observeZcodeCatalog>[0],
  };
  const provider = {
    // REAL provider signature: listSessions(workspace?, opts?) — fakes must
    // not silently redefine it as listSessions(opts), which is exactly the
    // wiring bug under test.
    listSessions: async (workspace?: unknown, opts?: { timeoutMs?: number }) => {
      h.calls.push({ what: "list", workspace: workspace ?? null, timeoutMs: opts?.timeoutMs });
      if (workspace !== undefined) {
        throw new Error("WIRED WRONG: the timeout object was passed as the workspace parameter");
      }
      clock.advance(200);
      return h.candidates;
    },
    observeSessionSettings: async (sessionId: string, opts?: { timeoutMs?: number }) => {
      h.calls.push({ what: "read", sessionId, timeoutMs: opts?.timeoutMs });
      // Uniform read cost: every read consumes 200 fake-ms, so the shared
      // budget is actually consumed candidate by candidate.
      clock.advance(200);
      const result = await h.readBehavior(sessionId, opts?.timeoutMs);
      return result;
    },
    createSession: async () => { h.lifecycleCalls += 1; return "sess_should-not-exist"; },
    resumeSession: async () => { h.lifecycleCalls += 1; },
  };
  const port = adaptZcodeProviderToCatalogPort(provider)!;
  h.port = port;
  const options = { budgetMs: startBudget, maxCandidates: 5, now: clock.now };
  return { ...h, options };
}

describe("observeZcodeCatalog budget semantics", () => {
  it("stops before any read when session/list alone exhausts the budget", async () => {
    const clock = fakeClock();
    const calls: string[] = [];
    let lifecycleCalls = 0;
    const provider = {
      listSessions: async (workspace?: unknown, opts?: { timeoutMs?: number }) => {
        calls.push("list");
        assert.equal(workspace, undefined, "workspace must not be the timeout object");
        assert.ok((opts?.timeoutMs ?? 0) <= 700, "list must be bounded by the shared budget");
        clock.advance(900); // consumes the whole 700ms budget on its own
        return [{ sessionId: "sess_a", updatedAt: 1 }];
      },
      observeSessionSettings: async () => { calls.push("read"); return null; },
      createSession: async () => { lifecycleCalls += 1; return "sess_should-not-exist"; },
      resumeSession: async () => { lifecycleCalls += 1; },
    };
    const port = adaptZcodeProviderToCatalogPort(provider)!;
    const result = await observeZcodeCatalog(port, { budgetMs: 700, maxCandidates: 5, now: clock.now });
    assert.equal(result.evidenceSource, "observation-budget-exhausted");
    assert.deepEqual(result.attempts.map((a) => a.outcome), ["observation-budget-exhausted"]);
    assert.equal(calls.filter((c) => c === "read").length, 0);
    assert.equal(lifecycleCalls, 0);
  });

  it("passes the remaining shared budget as the per-call timeout for list and reads", async () => {
    const h = harness({
      readBehavior: async () => null, // both candidates empty → both attempted
    });
    const result = await observeZcodeCatalog(h.port, h.options);
    // list got the full budget (8000)…
    assert.equal(h.calls.find((c) => c.what === "list")?.timeoutMs, 8000);
    // …and each read got the remaining budget, not the default 20000.
    const reads = h.calls.filter((c) => c.what === "read");
    assert.equal(reads[0]?.timeoutMs, 7800); // after the list advanced 200ms
    assert.equal(reads[1]?.timeoutMs, 7600); // after candidate A's read advanced 200ms more
    assert.equal(result.candidatesAttempted, 2);
  });

  it("skips a timed-out read and still observes a later readable candidate", async () => {
    const h = harness({
      readBehavior: async (sessionId) => {
        if (sessionId === "sess_a") throw new Error("timeout waiting for session/read");
        return {
          source_session_id: sessionId,
          observed_at: "2026-09-26T00:00:00.000Z",
          current: { provider_id: "zai-api", model_id: "GLM-5.3-Flash", thought_level: "max" },
          models: [{ provider_id: "zai-api", model_id: "GLM-5.3-Flash", reasoning_levels: ["max"], reasoning_default_level: "max" }],
        };
      },
    });
    const result = await observeZcodeCatalog(h.port, h.options);
    assert.equal(result.evidenceSource, "session-settings-observed");
    assert.equal(result.observedSessionId, "sess_b");
    assert.deepEqual(result.attempts.map((a) => a.outcome), ["timeout", "observed"]);
    assert.equal(result.candidatesAttempted, 2);
    assert.equal(result.candidatesObserved, 1);
  });

  it("never publishes a late success after the budget deadline", async () => {
    let releaseSuccess: (value: unknown) => void = () => undefined;
    const h = harness({
      readBehavior: (sessionId) => {
        if (sessionId === "sess_a") {
          return new Promise((resolve, reject) => {
            releaseSuccess = () => resolve({
              source_session_id: sessionId,
              observed_at: "late",
              models: [{ provider_id: "zai-api", model_id: "GLM-5.3-Flash", reasoning_levels: ["max"] }],
            });
            setTimeout(() => reject(new Error("timeout waiting for session/read")), 5);
          });
        }
        return null;
      },
    });
    h.clock.advance(7000); // leave only 1000ms of budget before the first read
    const result = await observeZcodeCatalog(h.port, h.options);
    assert.notEqual(result.evidenceSource, "session-settings-observed");
    assert.equal(result.runtimeSettings, null);
    releaseSuccess({ ignored: true });
    assert.equal(result.runtimeSettings, null);
    assert.equal(h.lifecycleCalls, 0);
  });

  it("stops scanning once the multi-candidate budget is exhausted", async () => {
    const h = harness({
      candidates: [
        { sessionId: "sess_1", updatedAt: 50 },
        { sessionId: "sess_2", updatedAt: 40 },
        { sessionId: "sess_3", updatedAt: 30 },
        { sessionId: "sess_4", updatedAt: 20 },
        { sessionId: "sess_5", updatedAt: 10 },
      ],
      readBehavior: async () => null, // every read "costs" 200 fake-ms via the harness clock
    });
    const result = await observeZcodeCatalog(h.port, { ...h.options, budgetMs: 700 });
    assert.equal(result.evidenceSource, "observation-budget-exhausted");
    assert.ok(result.candidatesAttempted < 5, `attempted ${result.candidatesAttempted}`);
    const reads = h.calls.filter((c) => c.what === "read");
    assert.equal(reads.length, result.candidatesAttempted);
    for (const read of reads) {
      assert.ok((read.timeoutMs ?? 0) > 0 && (read.timeoutMs ?? 0) <= 700);
    }
    assert.equal(h.lifecycleCalls, 0);
  });

  it("records success, empty, skip and failure attempts with distinct outcomes and counts", async () => {
    const h = harness({
      candidates: [
        { sessionId: "sess_ok", updatedAt: 40 },
        { sessionId: "sess_empty", updatedAt: 30 },
        { sessionId: "sess_dead", updatedAt: 20 },
        { sessionId: "sess_ok2", updatedAt: 10 },
      ],
      readBehavior: async (sessionId) => {
        if (sessionId === "sess_dead") throw new Error("ZCode Protocol error -32004: Session is not active: sess_dead");
        if (sessionId === "sess_empty") return null;
        return {
          source_session_id: sessionId,
          observed_at: "2026-09-26T00:00:00.000Z",
          models: [{ provider_id: "zai-api", model_id: "GLM-5.3-Flash", reasoning_levels: ["max"] }],
        };
      },
    });
    const result = await observeZcodeCatalog(h.port, h.options);
    assert.deepEqual(result.attempts.map((a) => a.outcome), ["observed"]);
    assert.equal(result.candidatesConsidered, 4);
    assert.equal(result.candidatesAttempted, 1);
    assert.equal(result.candidatesObserved, 1);
  });
});

describe("business deadline (clock consumed inside the read) - Scenarios A to E", () => {
  // Scenario A: fake read advances clock past deadline inside call then resolves
  it("A: drops a success that resolves after the shared deadline and records terminal budget state", async () => {
    const clock = fakeClock();
    const provider = {
      listSessions: async (workspace?: unknown, opts?: { timeoutMs?: number }) => {
        assert.equal(workspace, undefined, "workspace must not be replaced by the timeout object");
        clock.advance(100);
        return [{ sessionId: "sess_a", updatedAt: 1 }];
      },
      observeSessionSettings: async (sessionId: string) => {
        clock.advance(8001); // consumes more than the 8000ms budget, then resolves
        return {
          source_session_id: sessionId,
          observed_at: "late",
          models: [{ provider_id: "zai-api", model_id: "GLM-5.3-Flash", reasoning_levels: ["max"] }],
        };
      },
      createSession: async () => { throw new Error("lifecycle op must not happen"); },
      resumeSession: async () => { throw new Error("lifecycle op must not happen"); },
    };
    const port = adaptZcodeProviderToCatalogPort(provider)!;
    const result = await observeZcodeCatalog(port, { budgetMs: 8000, maxCandidates: 5, now: clock.now });
    assert.equal(result.evidenceSource, "observation-budget-exhausted");
    assert.equal(result.runtimeSettings, null);
    assert.equal(result.observedSessionId, null);
    assert.equal(result.candidatesObserved, 0);
    assert.deepEqual(result.attempts.map((a) => a.outcome), ["observation-budget-exhausted"]);
  });

  // Scenario B: list returns when already timed out, and returns an empty list
  it("B: records observation-budget-exhausted when session/list returns empty list after deadline", async () => {
    const clock = fakeClock();
    const provider = {
      listSessions: async () => {
        clock.advance(8001); // list alone consumes full budget
        return []; // and returns empty list
      },
      observeSessionSettings: async () => { throw new Error("should not be called"); },
    };
    const port = adaptZcodeProviderToCatalogPort(provider)!;
    const result = await observeZcodeCatalog(port, { budgetMs: 8000, maxCandidates: 5, now: clock.now });
    assert.equal(result.evidenceSource, "observation-budget-exhausted");
    assert.equal(result.runtimeSettings, null);
    assert.equal(result.candidatesConsidered, 0);
    assert.deepEqual(result.attempts.map((a) => a.outcome), ["observation-budget-exhausted"]);
  });

  // Scenario C: last candidate read exhausts budget
  it("C: records observation-budget-exhausted when the last candidate read exhausts budget", async () => {
    const clock = fakeClock();
    const provider = {
      listSessions: async () => {
        clock.advance(100);
        return [
          { sessionId: "sess_1", updatedAt: 20 },
          { sessionId: "sess_2", updatedAt: 10 },
        ];
      },
      observeSessionSettings: async (sessionId: string) => {
        if (sessionId === "sess_1") {
          clock.advance(200);
          return null; // first candidate returns empty
        }
        // second (last) candidate read consumes remainder of budget
        clock.advance(7800);
        return null;
      },
    };
    const port = adaptZcodeProviderToCatalogPort(provider)!;
    const result = await observeZcodeCatalog(port, { budgetMs: 8000, maxCandidates: 5, now: clock.now });
    assert.equal(result.evidenceSource, "observation-budget-exhausted");
    assert.equal(result.runtimeSettings, null);
    assert.equal(result.candidatesAttempted, 2);
    assert.deepEqual(result.attempts.map((a) => a.outcome), ["session-settings-empty", "observation-budget-exhausted"]);
  });

  // Scenario D: read returns null when already timed out
  it("D: records observation-budget-exhausted when candidate read returns null after deadline", async () => {
    const clock = fakeClock();
    const provider = {
      listSessions: async () => {
        clock.advance(100);
        return [{ sessionId: "sess_a", updatedAt: 1 }];
      },
      observeSessionSettings: async () => {
        clock.advance(8001); // past the deadline, then "no settings"
        return null;
      },
    };
    const port = adaptZcodeProviderToCatalogPort(provider)!;
    const result = await observeZcodeCatalog(port, { budgetMs: 8000, maxCandidates: 5, now: clock.now });
    assert.equal(result.evidenceSource, "observation-budget-exhausted");
    assert.equal(result.runtimeSettings, null);
    assert.deepEqual(result.attempts.map((a) => a.outcome), ["observation-budget-exhausted"]);
  });

  // Scenario E: normal in-budget success works
  it("E: normal in-budget success publishes session-settings-observed", async () => {
    const clock = fakeClock();
    const provider = {
      listSessions: async () => {
        clock.advance(100);
        return [{ sessionId: "sess_ok", updatedAt: 1 }];
      },
      observeSessionSettings: async (sessionId: string) => {
        clock.advance(200);
        return {
          source_session_id: sessionId,
          observed_at: "2026-09-26T00:00:00.000Z",
          current: { provider_id: "zai-api", model_id: "GLM-5.3-Flash", thought_level: "max" },
          models: [{ provider_id: "zai-api", model_id: "GLM-5.3-Flash", reasoning_levels: ["max"] }],
        };
      },
    };
    const port = adaptZcodeProviderToCatalogPort(provider)!;
    const result = await observeZcodeCatalog(port, { budgetMs: 8000, maxCandidates: 5, now: clock.now });
    assert.equal(result.evidenceSource, "session-settings-observed");
    assert.equal(result.observedSessionId, "sess_ok");
    assert.equal(result.candidatesObserved, 1);
    assert.ok(result.runtimeSettings !== null);
    assert.deepEqual(result.attempts.map((a) => a.outcome), ["observed"]);
  });

  it("records observation-budget-exhausted when session/list advances clock past deadline and throws error", async () => {
    const clock = fakeClock();
    const provider = {
      listSessions: async () => {
        clock.advance(8001); // clock advanced past deadline
        throw new Error("timeout waiting for session/list");
      },
      observeSessionSettings: async () => { throw new Error("should not be called"); },
    };
    const port = adaptZcodeProviderToCatalogPort(provider)!;
    const result = await observeZcodeCatalog(port, { budgetMs: 8000, maxCandidates: 5, now: clock.now });
    assert.equal(result.evidenceSource, "observation-budget-exhausted");
    assert.equal(result.runtimeSettings, null);
    assert.equal(result.candidatesAttempted, 0);
    assert.equal(result.candidatesObserved, 0);
    assert.deepEqual(result.attempts.map((a) => a.outcome), ["observation-budget-exhausted"]);
  });

  it("records session-list-unavailable with sanitized diagnosis when session/list throws error within budget", async () => {
    const clock = fakeClock();
    const provider = {
      listSessions: async () => {
        clock.advance(100); // well within 8000ms budget
        throw new Error("connect ECONNREFUSED 127.0.0.1:8766 sk-secret12345678");
      },
      observeSessionSettings: async () => { throw new Error("should not be called"); },
    };
    const port = adaptZcodeProviderToCatalogPort(provider)!;
    const result = await observeZcodeCatalog(port, { budgetMs: 8000, maxCandidates: 5, now: clock.now });
    assert.equal(result.evidenceSource, "session-list-unavailable");
    assert.equal(result.runtimeSettings, null);
    assert.equal(result.candidatesAttempted, 0);
    assert.equal(result.candidatesObserved, 0);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].outcome, "list-sessions-failed");
    assert.ok(!result.attempts[0].error?.includes("sk-secret12345678"));
    assert.ok(result.attempts[0].error?.includes("[REDACTED_KEY]"));
  });
});

describe("protocol-level timeout and pending cleanup - Scenario F", () => {
  it("F: protocol-level timeout cleans up pending timer and late response is safely ignored", async () => {
    const writes: unknown[] = [];
    class MockTransport extends EventEmitter implements ProtocolTransport {
      write(msg: unknown): void {
        writes.push(msg);
      }
    }
    const transport = new MockTransport();
    const proto = new ZcodeProtocol(transport);

    // Issue a request with a very short timeout (20ms)
    let rejectedError: Error | null = null;
    try {
      await proto.request("session/read", { sessionId: "sess_fake" }, 20);
    } catch (err) {
      rejectedError = err as Error;
    }
    assert.ok(rejectedError !== null, "request must reject on timeout");
    assert.ok(rejectedError.message.includes("timeout waiting for session/read"));
    // Verify internal pending cleanup: pending map size must be 0
    const pendingMap = (proto as unknown as { pending: Map<string, unknown> }).pending;
    assert.equal(pendingMap.size, 0, "pending map entry must be deleted upon timeout");

    // The outgoing request key was recorded in writes[0].id
    const sentReq = writes[0] as { id: string };
    assert.ok(sentReq && sentReq.id, "outgoing request had an id");

    // Now simulate late arrival of the response from the agent for the timed-out request id
    // It must emit 'uncorrelated' and not throw or cause unhandled rejection
    let unhandled = false;
    const onUnhandled = () => { unhandled = true; };
    process.once("unhandledRejection", onUnhandled);
    let uncorrelatedReceived: unknown = null;
    proto.once("uncorrelated", (msg) => { uncorrelatedReceived = msg; });

    transport.emit("message", {
      id: sentReq.id,
      result: { settings: { model: { current: { modelId: "late" } } } },
    });

    await new Promise((r) => setTimeout(r, 10));
    process.removeListener("unhandledRejection", onUnhandled);
    assert.equal(unhandled, false, "late arrival must not cause unhandled rejection");
    assert.ok(uncorrelatedReceived !== null, "late message was emitted as uncorrelated");
  });
});

describe("provider wiring through the real ZcodeOfficialProvider (Blocker 1)", () => {
  it("MCP handler → adaptZcodeProviderToCatalogPort → observeZcodeCatalog → real provider.listSessions → fake protocol", async () => {
    const provider = new ZcodeOfficialProvider({ ...loadConfig(), zcodeCliPath: "C:\\nonexistent\\zcode.cjs" });
    const requests: Array<{ method: string; params: unknown; timeoutMs: number }> = [];
    // Fake protocol: records every request; answers session/list with one
    // VALID session and session/read with settings. Lifecycle methods must
    // never be requested.
    (provider as unknown as { protocol: unknown; proc: unknown }).protocol = {
      request: async (method: string, params: unknown, timeoutMs: number) => {
        requests.push({ method, params, timeoutMs });
        if (method === "session/list") {
          return { sessions: [{ sessionId: "sess_w", workspace: { workspacePath: "C:\\w" }, status: "idle", updatedAt: 5 }] };
        }
        if (method === "session/read") {
          return { settings: { model: { current: { providerId: "zai-api", modelId: "GLM-5.3-Flash" }, available: [] } } };
        }
        throw new Error("unexpected lifecycle request: " + method);
      },
    };
    (provider as unknown as { proc: unknown }).proc = { running: true };

    const tempDir = mkdtempSync(join(tmpdir(), "z2c-wire-"));
    const server = buildMcpServer({
      cfg: { host: "127.0.0.1", port: 0 },
      provider: provider as unknown as AgentProvider,
      engine: { submitTask: async () => ({}) } as unknown as TaskEngine,
      sessions: new SessionService({
        provider: provider as unknown as AgentProvider,
        grants: loadWorkspaceGrants(tempDir),
        ownership: loadSessionOwnership(tempDir),
        audit: new FileAuditLog(join(tempDir, "audit")),
      }),
      security: loadOrCreateSecurity(tempDir),
      pairing: loadPairing(tempDir),
      grants: loadWorkspaceGrants(tempDir),
      ownership: loadSessionOwnership(tempDir),
      audit: new FileAuditLog(join(tempDir, "audit")),
    });
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }> }>;
    })._registeredTools;

    const localResult = await runAsPrincipal(LOCAL_PRINCIPAL, () => registered["zcode_model_catalog"]!.handler({}));
    const payload = JSON.parse(localResult.content[0].text) as Record<string, unknown>;

    // Assertions required by Blocker 1:
    // 1. Valid session survived and was observed
    assert.equal(payload.evidence_source, "session-settings-observed");
    assert.equal(payload.observed_session_id, "sess_w");
    assert.equal(payload.candidates_considered, 1);
    assert.equal(payload.candidates_observed, 1);

    // 2. protocol.request received timeout within shared budget (8000ms), NOT default 20000ms
    const listReq = requests.find((r) => r.method === "session/list")!;
    assert.ok(listReq, "session/list request was recorded");
    assert.equal(listReq.timeoutMs, 8000, "timeoutMs for list must be shared budget (8000ms), not default 20000ms");
    assert.deepEqual(listReq.params, {});

    // 3. All protocol requests stayed within budget and only list/read were invoked (0 lifecycle ops)
    assert.ok(requests.every((r) => r.timeoutMs > 0 && r.timeoutMs <= 8000));
    assert.ok(requests.every((r) => ["session/list", "session/read"].includes(r.method)));
  });

  it("verifies direct miswiring passes timeout as workspace and fails session filtering", async () => {
    const provider = new ZcodeOfficialProvider({ ...loadConfig(), zcodeCliPath: "C:\\nonexistent\\zcode.cjs" });
    (provider as unknown as { protocol: unknown; proc: unknown }).protocol = {
      request: async (method: string, params: unknown, timeoutMs: number) => {
        if (method === "session/list") {
          return { sessions: [{ sessionId: "sess_w", workspace: { workspacePath: "C:\\w" }, status: "idle", updatedAt: 5 }] };
        }
        return {};
      },
    };
    (provider as unknown as { proc: unknown }).proc = { running: true };

    // When called incorrectly: passing { timeoutMs: 8000 } as 1st argument (the bug)
    // TypeScript/runtime treats it as workspace:
    const miswiredResult = await (provider.listSessions as unknown as (arg1: unknown) => Promise<unknown[]>)(
      { timeoutMs: 8000 }
    );
    // Because workspace was { timeoutMs: 8000 }, workspace.workspacePath is undefined,
    // so isWorkspaceMatch fails and drops the session!
    assert.equal(miswiredResult.length, 0, "miswired call drops valid sessions");

    // When called correctly via adapter:
    const port = adaptZcodeProviderToCatalogPort(provider)!;
    const adaptedResult = await port.listSessions({ timeoutMs: 8000 });
    assert.equal(adaptedResult.length, 1, "properly adapted call preserves valid sessions");
  });
});

describe("observation error sanitization and classification (Blocker 3)", () => {
  it("strips bearer tokens, token URL parameters, key material and local paths", () => {
    const dirty = "request failed: Authorization=Bearer abc.def.ghi-jkl?token=supersecret42&x=1 sk-abcdefghijklmnop1234 from C:\\Users\\Alice\\AppData\\secret.txt via /home/alice/.zcode/x";
    const clean = sanitizeObservationText(dirty);
    assert.ok(!clean.includes("abc.def.ghi"));
    assert.ok(!clean.includes("supersecret42"));
    assert.ok(!clean.includes("sk-abcdefghijklmnop"));
    assert.ok(!clean.includes("C:\\Users\\Alice"));
    assert.ok(!clean.includes("/home/alice"));
    assert.ok(clean.includes("bearer [REDACTED]") || clean.includes("[REDACTED_AUTH]") || clean.includes("[REDACTED]"));
    assert.ok(clean.includes("[REDACTED_KEY]") || clean.includes("[REDACTED]"));
    assert.ok(clean.includes("[LOCAL_PATH]"));
  });

  it("redacts header-style API keys, cookies, Basic auth and client_secret parameters individually (short inputs)", () => {
    // Each form is tested with a SHORT input so bounded truncation cannot hide a leak
    const forms: Array<[string, string]> = [
      ["X-API-Key: SYNTHETIC_KEY_123", "SYNTHETIC_KEY_123"],
      ["Cookie: sid=SYNTHETIC_COOKIE_123", "SYNTHETIC_COOKIE_123"],
      ["Authorization: Basic U1lOVEhFVElDX09OTFk=", "U1lOVEhFVElDX09OTFk="],
      ["client_secret=SYNTHETIC_ONLY", "SYNTHETIC_ONLY"],
      ["https://idp.example/token?client_secret=SYNTHETIC_ONLY&x=1", "SYNTHETIC_ONLY"],
      ["error: client_secret=SYNTHETIC_ONLY failed", "SYNTHETIC_ONLY"],
      ["Basic U1lOVEhFVElDX09OTFk=", "U1lOVEhFVElDX09OTFk="],
      ["x-api-key SYNTHETIC_KEY_123", "SYNTHETIC_KEY_123"],
      ['{"client_secret":"SYNTHETIC_ONLY"}', "SYNTHETIC_ONLY"],
    ];
    for (const [dirty, forbidden] of forms) {
      const clean = sanitizeObservationText(dirty);
      assert.ok(!clean.includes(forbidden), `leaked "${forbidden}" in: ${clean}`);
    }
  });

  it("classifies protocol timeouts, not-active sessions and transport failures distinctly", () => {
    assert.equal(classifyObservationError("timeout waiting for session/read"), "timeout");
    assert.equal(classifyObservationError("ZCode Protocol error -32004: Session is not active: sess_1"), "session-not-active");
    assert.equal(classifyObservationError("connect ECONNREFUSED 127.0.0.1:8766"), "transport");
    assert.equal(classifyObservationError("ZCode Protocol error -32601: method not found"), "protocol");
    assert.equal(classifyObservationError("401 unauthorized"), "permission");
  });

  it("full chain: upstream observation error containing synthetic secrets is sanitized in tool JSON", async () => {
    const provider = new ZcodeOfficialProvider({ ...loadConfig(), zcodeCliPath: "C:\\nonexistent\\zcode.cjs" });
    (provider as unknown as { protocol: unknown; proc: unknown }).protocol = {
      request: async (method: string) => {
        if (method === "session/list") {
          return { sessions: [{ sessionId: "sess_err", workspace: { workspacePath: "C:\\w" }, status: "idle", updatedAt: 5 }] };
        }
        if (method === "session/read") {
          throw new Error("HTTP 401: X-API-Key: SYNTHETIC_KEY_123, Cookie: sid=SYNTHETIC_COOKIE_123, client_secret=SYNTHETIC_ONLY failed");
        }
        throw new Error("unexpected method");
      },
    };
    (provider as unknown as { proc: unknown }).proc = { running: true };

    const tempDir = mkdtempSync(join(tmpdir(), "z2c-leak-"));
    const server = buildMcpServer({
      cfg: { host: "127.0.0.1", port: 0 },
      provider: provider as unknown as AgentProvider,
      engine: { submitTask: async () => ({}) } as unknown as TaskEngine,
      sessions: new SessionService({
        provider: provider as unknown as AgentProvider,
        grants: loadWorkspaceGrants(tempDir),
        ownership: loadSessionOwnership(tempDir),
        audit: new FileAuditLog(join(tempDir, "audit")),
      }),
      security: loadOrCreateSecurity(tempDir),
      pairing: loadPairing(tempDir),
      grants: loadWorkspaceGrants(tempDir),
      ownership: loadSessionOwnership(tempDir),
      audit: new FileAuditLog(join(tempDir, "audit")),
    });
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }> }>;
    })._registeredTools;

    const res = await runAsPrincipal(LOCAL_PRINCIPAL, () => registered["zcode_model_catalog"]!.handler({}));
    const rawJson = res.content[0].text;
    assert.ok(!rawJson.includes("SYNTHETIC_KEY_123"), "leaked SYNTHETIC_KEY_123 in tool JSON");
    assert.ok(!rawJson.includes("SYNTHETIC_COOKIE_123"), "leaked SYNTHETIC_COOKIE_123 in tool JSON");
    assert.ok(!rawJson.includes("SYNTHETIC_ONLY"), "leaked SYNTHETIC_ONLY in tool JSON");

    const payload = JSON.parse(rawJson) as Record<string, unknown>;
    assert.equal(payload.evidence_source, "all-candidates-unreadable");
    const attempts = payload.attempts as Array<{ session_id: string; outcome: string; error?: string }>;
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].outcome, "permission");
    assert.ok(attempts[0].error, "error message exists");
    assert.ok(!attempts[0].error.includes("SYNTHETIC_KEY_123"));
    assert.ok(!attempts[0].error.includes("SYNTHETIC_COOKIE_123"));
    assert.ok(!attempts[0].error.includes("SYNTHETIC_ONLY"));
  });
});
