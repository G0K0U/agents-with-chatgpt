import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { createMcpServer } from "../src/mcp/server.js";
import { OmnigentControl } from "../src/execution/omnigent-control.js";
import { Workspace } from "../src/workspace/manager.js";
import { nullLogger } from "../src/logger/index.js";
import { makeTmpDir, cleanup } from "./helpers.js";

const ID = "a".repeat(32);
const json = (value: unknown) => new Response(JSON.stringify(value));
const names = ["omnigent_status", "omnigent_submit_task", "omnigent_get_task", "omnigent_followup_task", "omnigent_cancel_task", "omnigent_list_tasks"];

describe("Omnigent full-control MCP surface", () => {
  let root: string;
  let state: string;
  let server: ReturnType<typeof createMcpServer>;
  let workspace: Workspace;
  let calls: string[];
  let events: string[];
  let harness: string;
  let catalog: Record<string, unknown>[];
  let snapshot: Record<string, unknown>;
  let output: string;
  let ambiguousCancelEvent: string | null;
  let refuseMessage: boolean;
  let cancellationSeenDuringEvents: boolean[];
  let fetcher: typeof fetch;

  const start = () => createMcpServer({ workspace, stateDir: state, logger: nullLogger });
  const invoke = async (name: string, args: Record<string, unknown> = {}, authInfo?: unknown) => {
    const tool = (server as any)._registeredTools[name];
    // Parse the actual registered schema so MCP defaults are exercised too.
    const result = await tool.handler(tool.inputSchema.parse(args), { authInfo });
    return { ...JSON.parse(result.content[0].text), isError: result.isError === true };
  };
  beforeEach(() => {
    root = makeTmpDir("omnigent-control");
    state = path.join(root, "state");
    workspace = new Workspace(root);
    calls = []; events = []; harness = "codex"; snapshot = {}; output = "done";
    ambiguousCancelEvent = null; refuseMessage = false; cancellationSeenDuringEvents = [];
    catalog = ["codex", "antigravity-native", "acp:glm-5-3-flash"].map((id) => ({ id, ready: true, capabilities: {} }));
    fetcher = vi.fn(async (url, init) => {
      const route = new URL(String(url)).pathname;
      calls.push(`${init?.method} ${route}`);
      if (route === "/health") return json({ status: "ok" });
      if (route === "/v1/hosts") return json({ hosts: [{ host_id: "b".repeat(32), status: "online" }] });
      if (route === "/v1/harnesses") return json({ data: catalog });
      if (route === "/v1/sessions" && init?.method === "POST") {
        if (init.body instanceof FormData) {
          const bundle = init.body.get("bundle") as Blob;
          const yaml = gunzipSync(Buffer.from(await bundle.arrayBuffer())).subarray(512).toString();
          harness = JSON.parse(yaml.match(/harness: ("[^"\n]+")/)![1]);
          return json({ agent_id: "c".repeat(32), session_id: "d".repeat(32) });
        }
        return json({ id: ID, workspace: root });
      }
      if (route === `/v1/sessions/${ID}`) return json({
        id: ID,
        harness,
        status: "idle",
        workspace: root,
        agent_id: "c".repeat(32),
        ...snapshot,
      });
      if (route === `/v1/sessions/${ID}/events`) {
        const event = JSON.parse(init!.body as string);
        events.push(event.type);
        const bindingFile = path.join(state, "omnigent", "control-sessions", `${ID}.json`);
        cancellationSeenDuringEvents.push(fs.existsSync(bindingFile) &&
          JSON.parse(fs.readFileSync(bindingFile, "utf8")).cancellation !== undefined);
        return json({ queued: event.type === "message" ? !refuseMessage : event.type === ambiguousCancelEvent });
      }
      if (route === `/v1/sessions/${ID}/items`) return json({ data: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: output }] }] });
      if (route === "/v1/sessions") return json({ data: [{ id: ID, harness, title: output }] });
      throw new Error("Unexpected fake route");
    }) as typeof fetch;
    vi.stubGlobal("fetch", fetcher);
    vi.stubEnv("C2C_OMNIGENT_GLM_HARNESS", "acp:glm-5-3-flash");
    server = start();
  });
  afterEach(async () => {
    await server.close();
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
    cleanup(root);
  });

  it("registers exactly thirty-three tools including all six control tools and the native self-test", () => {
    expect(Object.keys((server as any)._registeredTools)).toHaveLength(33);
    expect(Object.keys((server as any)._registeredTools)).toEqual(expect.arrayContaining(names));
  });

  it.each(["acp:glm-5-3-flash", "acp:custom-glm"])("discovers the configured GLM harness %s and truthful readiness", async (glm) => {
    vi.stubEnv("C2C_OMNIGENT_GLM_HARNESS", glm);
    catalog = [{ id: "codex", ready: true }, { id: glm }, { id: "acp:omp", ready: true }];
    const result = await invoke("omnigent_status");
    expect(result.harnesses.map((h: any) => h.id)).toEqual(["codex", glm]);
    expect(result.providers.codex).toMatchObject({ discovered: true, ready: true });
    expect(result.providers.glm).toMatchObject({ harness: glm, discovered: true, ready: null });
    catalog = [];
    expect((await invoke("omnigent_status")).providers.glm).toMatchObject({ discovered: false, ready: false });
  });

  it.skip("reports the configured Gemini harness in status", async () => {
    expect((await invoke("omnigent_status")).providers.gemini.harness).toBe("antigravity-native");

    await server.close();
    vi.stubEnv("C2C_OMNIGENT_GEMINI_HARNESS", "antigravity");
    catalog = [...catalog, { id: "antigravity", ready: true, capabilities: {} }];
    server = start();
    expect((await invoke("omnigent_status")).providers.gemini.harness).toBe("antigravity");
  });

  it.skip("rejects an invalid Gemini harness override", async () => {
    await server.close();
    vi.stubEnv("C2C_OMNIGENT_GEMINI_HARNESS", "invalid-harness");
    server = start();
    expect(await invoke("omnigent_status")).toMatchObject({ error: "OMNIGENT_CONFIG_INVALID", isError: true });
  });

  it.each(["codex", "glm"])("pins %s and derives continuation provider after restart", async (provider) => {
    const first = await invoke("omnigent_submit_task", { provider, instruction: "Inspect this project" });
    expect(first).toMatchObject({ provider, status: "submitted", isError: false });
    expect(first.harness).toBe({ codex: "codex", glm: "acp:glm-5-3-flash" }[provider]);
    await server.close(); server = start();
    const continued = await invoke("omnigent_submit_task", { session_id: ID, instruction: "Continue" });
    expect(continued).toMatchObject({ provider, harness: first.harness, continued: true, isError: false });
    expect((await invoke("omnigent_followup_task", { task_id: ID, instruction: "Check tests" })).provider).toBe(provider);
    expect((await invoke("omnigent_get_task", { task_id: ID })).provider).toBe(provider);
    expect(events).toEqual(["message", "message", "message"]);
  });

  it("rejects continuation provider mismatches before dispatch", async () => {
    await invoke("omnigent_submit_task", { provider: "glm", instruction: "Inspect" });
    expect(await invoke("omnigent_submit_task", { provider: "codex", session_id: ID, instruction: "Continue" }))
      .toMatchObject({ error: "OMNIGENT_PROVIDER_MISMATCH", isError: true });
    expect(events).toEqual(["message"]);
  });

  it("rejects a changed remote harness against the persisted binding", async () => {
    await invoke("omnigent_submit_task", { instruction: "Inspect" });
    await server.close(); server = start(); harness = "antigravity";
    expect(await invoke("omnigent_followup_task", { task_id: ID, instruction: "Continue" }))
      .toMatchObject({ error: "OMNIGENT_PROVIDER_MISMATCH", isError: true });
    expect(events).toEqual(["message"]);
  });

  it("keeps a GLM session binding across configuration changes", async () => {
    await invoke("omnigent_submit_task", { provider: "glm", instruction: "Inspect" });
    await server.close(); vi.stubEnv("C2C_OMNIGENT_GLM_HARNESS", "acp:new-glm"); server = start();
    expect(await invoke("omnigent_submit_task", { provider: "glm", session_id: ID, instruction: "Continue" }))
      .toMatchObject({ provider: "glm", harness: "acp:glm-5-3-flash", isError: false });
  });

  it("accepts a generic ACP snapshot only for the same persisted GLM agent", async () => {
    await invoke("omnigent_submit_task", { provider: "glm", instruction: "Inspect" });
    await server.close(); server = start(); harness = "acp";
    expect(await invoke("omnigent_followup_task", { task_id: ID, instruction: "Continue" }))
      .toMatchObject({ provider: "glm", harness: "acp", isError: false });
    expect(events).toEqual(["message", "message"]);
  });

  it.each([
    ["missing", undefined],
    ["different", "e".repeat(32)],
    ["malformed", "not-an-omnigent-id"],
  ])("rejects a generic ACP snapshot with a %s agent id", async (_case, agentId) => {
    await invoke("omnigent_submit_task", { provider: "glm", instruction: "Inspect" });
    await server.close(); server = start(); harness = "acp"; snapshot = { agent_id: agentId };
    expect(await invoke("omnigent_followup_task", { task_id: ID, instruction: "Continue" }))
      .toMatchObject({ error: "OMNIGENT_PROVIDER_MISMATCH", isError: true });
    expect(events).toEqual(["message"]);
  });

  it("rejects a concrete incompatible ACP harness for a persisted GLM agent", async () => {
    await invoke("omnigent_submit_task", { provider: "glm", instruction: "Inspect" });
    await server.close(); server = start(); harness = "acp:wrong-glm";
    expect(await invoke("omnigent_followup_task", { task_id: ID, instruction: "Continue" }))
      .toMatchObject({ error: "OMNIGENT_PROVIDER_MISMATCH", isError: true });
    expect(events).toEqual(["message"]);
  });

  it.each(["codex"])("does not normalize generic ACP snapshots for %s", async (provider) => {
    await invoke("omnigent_submit_task", { provider, instruction: "Inspect" });
    await server.close(); server = start(); harness = "acp";
    expect(await invoke("omnigent_followup_task", { task_id: ID, instruction: "Continue" }))
      .toMatchObject({ error: "OMNIGENT_PROVIDER_MISMATCH", isError: true });
    expect(events).toEqual(["message"]);
  });

  it("binds a new GLM session before its harness is populated", async () => {
    harness = "acp:glm-5-3-flash";
    snapshot = { harness: null };
    expect(await invoke("omnigent_submit_task", { provider: "glm", instruction: "Inspect" }))
      .toMatchObject({ provider: "glm", harness: null, status: "submitted", isError: false });
    expect(events).toEqual(["message"]);

    await server.close();
    snapshot = {};
    server = start();
    expect(await invoke("omnigent_get_task", { task_id: ID, include_output: false }))
      .toMatchObject({ provider: "glm", harness: "acp:glm-5-3-flash", isError: false });
  });

  it.each(["codex", "glm"])("fails unavailable %s without fallback or session creation", async (provider) => {
    catalog = [];
    expect(await invoke("omnigent_submit_task", { provider, instruction: "Inspect" }))
      .toMatchObject({ error: "OMNIGENT_PROVIDER_UNAVAILABLE", isError: true });
    expect(calls).toEqual(["GET /v1/harnesses"]); expect(events).toEqual([]);
  });

  it.each([
    [{ status: "failed" }, "OMNIGENT_PROVIDER_UNAVAILABLE"],
    [{ harness: "antigravity" }, "OMNIGENT_PROVIDER_MISMATCH"],
    [{ harness: "unknown" }, "OMNIGENT_PROVIDER_MISMATCH"],
  ])("rejects failed, substituted or unknown sessions before dispatch: %j", async (override, code) => {
    snapshot = override as Record<string, unknown>;
    expect(await invoke("omnigent_submit_task", { instruction: "Inspect" }))
      .toMatchObject({ error: code });
    expect(events).toEqual([]);
  });

  it.each(names)("enforces scope before any backend call: %s", async (name) => {
    const result = await invoke(name, { task_id: ID, instruction: "Inspect" }, { clientId: "test", scopes: [] });
    expect(result).toMatchObject({ error: "INSUFFICIENT_SCOPE", isError: true }); expect(calls).toEqual([]);
  });

  it("enforces workspace authorization on submit", async () => {
    expect(await invoke("omnigent_submit_task", { instruction: "Inspect" }, {
      clientId: "test", scopes: ["execution.submit"], extra: { authorizedWorkspaceIds: [] },
    })).toMatchObject({ error: "WORKSPACE_NOT_AUTHORIZED", isError: true });
    expect(calls).toEqual([]);
  });

  it.each(["omnigent_submit_task", "omnigent_followup_task"])("rejects credential-like instructions on %s", async (name) => {
    for (const instruction of ["Use token=short", "cookie=private", "api_key=private", "-----BEGIN PRIVATE KEY-----"]) {
      expect(await invoke(name, { task_id: ID, instruction })).toMatchObject({ error: "SENSITIVE_TASK_INPUT", isError: true });
    }
    expect(calls).toEqual([]);
  });

  it("redacts paths, output, error details and list titles", async () => {
    output = 'C:\\private\\file.txt /home/private/file "F:\\Private Folder\\hidden.txt" token=private-value api_key=private-key';
    snapshot = { title: output, last_task_error: { code: "FAILED", message: output } };
    const submitted = await invoke("omnigent_submit_task", { instruction: "Inspect" });
    expect(submitted.workspacePath).toBe("[local-path]");
    const read = await invoke("omnigent_get_task", { task_id: ID, max_chars: 200 });
    const listed = await invoke("omnigent_list_tasks", { limit: 1 });
    for (const result of [read, listed]) {
      expect(JSON.stringify(result)).not.toMatch(/private-value|private-key|file\.txt|hidden\.txt|\/home\/private/);
      expect(JSON.stringify(result)).toContain("[REDACTED]");
    }
    output = "x".repeat(1000);
    expect((await invoke("omnigent_get_task", { task_id: ID, max_chars: 200 })).output).toHaveLength(200);
    expect((await invoke("omnigent_get_task", { task_id: ID, include_output: false })).output).toBeNull();
    output = "-----BEGIN PRIVATE KEY-----\nprivate material";
    expect((await invoke("omnigent_get_task", { task_id: ID })).output).not.toContain("private material");
  });

  it.each([false, true])("cancel hard=%s sends the documented events without switching providers", async (hard) => {
    harness = "codex";
    expect(await invoke("omnigent_cancel_task", { task_id: ID, hard })).toMatchObject({ cancelled: true, hard, isError: false });
    expect(events).toEqual(hard ? ["interrupt", "stop_session"] : ["interrupt"]);
    expect(cancellationSeenDuringEvents).toEqual(events.map(() => false));
    expect(await invoke("omnigent_get_task", { task_id: ID, include_output: false }))
      .toMatchObject({ status: "cancelled", underlyingStatus: "idle", provider: "codex", harness: "codex" });
  });

  it("persists graceful cancellation truth across control restarts", async () => {
    expect(await invoke("omnigent_cancel_task", { task_id: ID })).toMatchObject({ status: "cancelled", cancelled: true });
    await server.close(); server = start();
    expect(await invoke("omnigent_get_task", { task_id: ID, include_output: false }))
      .toMatchObject({ status: "cancelled", underlyingStatus: "idle", provider: "codex" });
  });

  it("does not claim successful cancellation on an ambiguous first acknowledgement", async () => {
    ambiguousCancelEvent = "interrupt";
    expect(await invoke("omnigent_cancel_task", { task_id: ID, hard: true })).toMatchObject({ error: "OMNIGENT_PROTOCOL_ERROR", isError: true });
    expect(events).toEqual(["interrupt"]);
    expect(await invoke("omnigent_get_task", { task_id: ID, include_output: false }))
      .toMatchObject({ status: "idle", underlyingStatus: null });
  });

  it("does not confirm hard cancellation when stop_session acknowledgement is ambiguous", async () => {
    ambiguousCancelEvent = "stop_session";
    expect(await invoke("omnigent_cancel_task", { task_id: ID, hard: true }))
      .toMatchObject({ error: "OMNIGENT_PROTOCOL_ERROR", isError: true });
    expect(events).toEqual(["interrupt", "stop_session"]);
    expect(cancellationSeenDuringEvents).toEqual([false, false]);
    expect(await invoke("omnigent_get_task", { task_id: ID, include_output: false }))
      .toMatchObject({ status: "idle", underlyingStatus: null });
  });

  it("clears confirmed cancellation only after a follow-up message is accepted", async () => {
    await invoke("omnigent_cancel_task", { task_id: ID });
    refuseMessage = true;
    expect(await invoke("omnigent_followup_task", { task_id: ID, instruction: "Continue" }))
      .toMatchObject({ error: "OMNIGENT_PROTOCOL_ERROR", isError: true });
    expect(await invoke("omnigent_get_task", { task_id: ID, include_output: false }))
      .toMatchObject({ status: "cancelled", underlyingStatus: "idle" });

    refuseMessage = false;
    expect(await invoke("omnigent_followup_task", { task_id: ID, instruction: "Continue" }))
      .toMatchObject({ status: "submitted", isError: false });
    expect(await invoke("omnigent_get_task", { task_id: ID, include_output: false }))
      .toMatchObject({ status: "idle", underlyingStatus: null });
  });

  it("withholds raw backend failures", async () => {
    vi.stubGlobal("fetch", async () => new Response("token=private-value", { status: 503 }));
    const result = await invoke("omnigent_status");
    expect(result).toMatchObject({ error: "OMNIGENT_REQUEST_FAILED", isError: true });
    expect(JSON.stringify(result)).not.toContain("private-value");
  });

  it("sanitizes direct control submissions too", async () => {
    const control = new OmnigentControl({ stateDir: state, fetch: fetcher });
    await expect(control.followUp(ID, "token=private")).rejects.toMatchObject({ code: "SENSITIVE_TASK_INPUT" });
    expect(calls).toEqual([]);
  });
});
