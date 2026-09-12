/**
 * Omnigent internal-control library tests.
 *
 * Omnigent is DEPRECATED as a public MCP surface: the current product
 * architecture dispatches through direct governed providers (Antigravity /
 * Gemini and ZCode Desktop / GLM), and the MCP server no longer registers
 * any omnigent_* tool. The OmnigentControl library is retained as legacy
 * internal code, so its security-relevant behaviour — provider pinning,
 * session-binding truthfulness, sensitive-input rejection and cancellation
 * protocol honesty — is still tested here, directly against the library.
 * MCP-layer concerns (scope checks, workspace authorization, output
 * redaction) belong to the active tool surface and are covered by the
 * active MCP integration tests.
 */
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

describe("Omnigent internal control (deprecated legacy library)", () => {
  let root: string;
  let state: string;
  let server: ReturnType<typeof createMcpServer>;
  let workspace: Workspace;
  let control: OmnigentControl;
  let calls: string[];
  let events: string[];
  let harness: string;
  let catalog: Record<string, unknown>[];
  let snapshot: Record<string, unknown>;
  let output: string;
  let ambiguousCancelEvent: string | null;
  let refuseMessage: boolean;
  let fetcher: typeof fetch;

  beforeEach(() => {
    root = makeTmpDir("omnigent-control");
    state = path.join(root, "state");
    workspace = new Workspace(root);
    calls = []; events = []; harness = "codex"; snapshot = {}; output = "done";
    ambiguousCancelEvent = null; refuseMessage = false;
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
        return json({ queued: event.type === "message" ? !refuseMessage : event.type === ambiguousCancelEvent });
      }
      if (route === `/v1/sessions/${ID}/items`) return json({ data: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: output }] }] });
      if (route === "/v1/sessions") return json({ data: [{ id: ID, harness, title: output }] });
      throw new Error("Unexpected fake route");
    }) as typeof fetch;
    vi.stubGlobal("fetch", fetcher);
    vi.stubEnv("C2C_OMNIGENT_GLM_HARNESS", "acp:glm-5-3-flash");
    control = new OmnigentControl({ stateDir: state, fetch: fetcher });
    server = createMcpServer({ workspace, logger: nullLogger, stateDir: state });
  });
  afterEach(async () => {
    await server.close();
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
    cleanup(root);
  });

  it("registers no omnigent_ tools on the current 28-tool MCP surface", () => {
    const tools = Object.keys((server as any)._registeredTools);
    expect(tools).toHaveLength(28);
    expect(tools.filter((name) => name.startsWith("omnigent_"))).toEqual([]);
  });

  it.each(["acp:glm-5-3-flash", "acp:custom-glm"])("discovers the configured GLM harness %s and truthful readiness", async (glm) => {
    vi.stubEnv("C2C_OMNIGENT_GLM_HARNESS", glm);
    control = new OmnigentControl({ stateDir: state, fetch: fetcher });
    catalog = [{ id: "codex", ready: true }, { id: glm }, { id: "acp:omp", ready: true }];
    const result = await control.status();
    expect((result.harnesses as any[]).map((h) => h.id)).toEqual(["codex", glm]);
    expect(result.providers.codex).toMatchObject({ discovered: true, ready: true });
    expect(result.providers.glm).toMatchObject({ harness: glm, discovered: true, ready: null });
    catalog = [];
    expect((await control.status()).providers.glm).toMatchObject({ discovered: false, ready: false });
  });

  it.each(["codex", "glm"])("pins %s and derives continuation provider after restart", async (provider) => {
    const first = await control.submitTask({ provider, workspacePath: root, instruction: "Inspect this project" });
    expect(first).toMatchObject({ provider, status: "submitted" });
    expect(first.harness).toBe({ codex: "codex", glm: "acp:glm-5-3-flash" }[provider]);
    control = new OmnigentControl({ stateDir: state, fetch: fetcher });
    const continued = await control.followUp(ID, "Continue");
    expect(continued).toMatchObject({ provider, harness: first.harness });
    expect((await control.followUp(ID, "Check tests")).provider).toBe(provider);
    expect((await control.taskStatus(ID, false)).provider).toBe(provider);
    expect(events).toEqual(["message", "message", "message"]);
  });

  it("rejects continuation provider mismatches before dispatch", async () => {
    await control.submitTask({ provider: "glm", workspacePath: root, instruction: "Inspect" });
    await expect(control.followUp(ID, "Continue", "codex"))
      .rejects.toMatchObject({ code: "OMNIGENT_PROVIDER_MISMATCH" });
    expect(events).toEqual(["message"]);
  });

  it("rejects a changed remote harness against the persisted binding", async () => {
    await control.submitTask({ provider: "codex", workspacePath: root, instruction: "Inspect" });
    control = new OmnigentControl({ stateDir: state, fetch: fetcher }); harness = "antigravity";
    await expect(control.followUp(ID, "Continue"))
      .rejects.toMatchObject({ code: "OMNIGENT_PROVIDER_MISMATCH" });
    expect(events).toEqual(["message"]);
  });

  it("keeps a GLM session binding across configuration changes", async () => {
    await control.submitTask({ provider: "glm", workspacePath: root, instruction: "Inspect" });
    control = new OmnigentControl({ stateDir: state, fetch: fetcher });
    vi.stubEnv("C2C_OMNIGENT_GLM_HARNESS", "acp:new-glm");
    const view = await control.followUp(ID, "Continue", "glm");
    expect(view).toMatchObject({ provider: "glm", harness: "acp:glm-5-3-flash" });
  });

  it("accepts a generic ACP snapshot only for the same persisted GLM agent", async () => {
    await control.submitTask({ provider: "glm", workspacePath: root, instruction: "Inspect" });
    control = new OmnigentControl({ stateDir: state, fetch: fetcher }); harness = "acp";
    const view = await control.followUp(ID, "Continue");
    expect(view).toMatchObject({ provider: "glm", harness: "acp" });
    expect(events).toEqual(["message", "message"]);
  });

  it.each([
    ["missing", undefined],
    ["different", "e".repeat(32)],
    ["malformed", "not-an-omnigent-id"],
  ])("rejects a generic ACP snapshot with a %s agent id", async (_case, agentId) => {
    await control.submitTask({ provider: "glm", workspacePath: root, instruction: "Inspect" });
    control = new OmnigentControl({ stateDir: state, fetch: fetcher }); harness = "acp"; snapshot = { agent_id: agentId };
    await expect(control.followUp(ID, "Continue"))
      .rejects.toMatchObject({ code: "OMNIGENT_PROVIDER_MISMATCH" });
    expect(events).toEqual(["message"]);
  });

  it("rejects a concrete incompatible ACP harness for a persisted GLM agent", async () => {
    await control.submitTask({ provider: "glm", workspacePath: root, instruction: "Inspect" });
    control = new OmnigentControl({ stateDir: state, fetch: fetcher }); harness = "acp:wrong-glm";
    await expect(control.followUp(ID, "Continue"))
      .rejects.toMatchObject({ code: "OMNIGENT_PROVIDER_MISMATCH" });
    expect(events).toEqual(["message"]);
  });

  it.each(["codex"])("does not normalize generic ACP snapshots for %s", async (provider) => {
    await control.submitTask({ provider, workspacePath: root, instruction: "Inspect" });
    control = new OmnigentControl({ stateDir: state, fetch: fetcher }); harness = "acp";
    await expect(control.followUp(ID, "Continue"))
      .rejects.toMatchObject({ code: "OMNIGENT_PROVIDER_MISMATCH" });
    expect(events).toEqual(["message"]);
  });

  it("binds a new GLM session before its harness is populated", async () => {
    harness = "acp:glm-5-3-flash";
    snapshot = { harness: null };
    expect(await control.submitTask({ provider: "glm", workspacePath: root, instruction: "Inspect" }))
      .toMatchObject({ provider: "glm", status: "submitted" });
    expect(events).toEqual(["message"]);

    control = new OmnigentControl({ stateDir: state, fetch: fetcher });
    snapshot = {};
    expect(await control.taskStatus(ID, false))
      .toMatchObject({ provider: "glm", harness: "acp:glm-5-3-flash" });
  });

  it.each(["codex", "glm"])("fails unavailable %s without fallback or session creation", async (provider) => {
    catalog = [];
    await expect(control.submitTask({ provider, workspacePath: root, instruction: "Inspect" }))
      .rejects.toMatchObject({ code: "OMNIGENT_PROVIDER_UNAVAILABLE" });
    expect(calls).toEqual(["GET /v1/harnesses"]); expect(events).toEqual([]);
  });

  it.each([
    [{ status: "failed" }, "OMNIGENT_PROVIDER_UNAVAILABLE"],
    [{ harness: "antigravity" }, "OMNIGENT_PROVIDER_MISMATCH"],
    [{ harness: "unknown" }, "OMNIGENT_PROVIDER_MISMATCH"],
  ])("rejects failed, substituted or unknown sessions before dispatch: %j", async (override, code) => {
    snapshot = override as Record<string, unknown>;
    await expect(control.submitTask({ provider: "codex", workspacePath: root, instruction: "Inspect" }))
      .rejects.toMatchObject({ code });
    expect(events).toEqual([]);
  });

  it.each(["token=short", "cookie=private", "api_key=private", "-----BEGIN PRIVATE KEY-----"])(
    "rejects credential-like instruction %j on direct submissions",
    async (instruction) => {
      await expect(control.submitTask({ provider: "codex", workspacePath: root, instruction }))
        .rejects.toMatchObject({ code: "SENSITIVE_TASK_INPUT" });
      await expect(control.followUp(ID, instruction))
        .rejects.toMatchObject({ code: "SENSITIVE_TASK_INPUT" });
      expect(calls).toEqual([]);
    }
  );

  it.each([false, true])("cancel hard=%s sends the documented events without switching providers", async (hard) => {
    harness = "codex";
    await control.cancel(ID, hard);
    expect(events).toEqual(hard ? ["interrupt", "stop_session"] : ["interrupt"]);
    expect(await control.taskStatus(ID, false))
      .toMatchObject({ status: "cancelled", provider: "codex", harness: "codex" });
  });

  it("persists graceful cancellation truth across control restarts", async () => {
    await control.cancel(ID, false);
    control = new OmnigentControl({ stateDir: state, fetch: fetcher });
    expect(await control.taskStatus(ID, false))
      .toMatchObject({ status: "cancelled", provider: "codex" });
  });

  it("does not claim successful cancellation on an ambiguous first acknowledgement", async () => {
    ambiguousCancelEvent = "interrupt";
    await expect(control.cancel(ID, true)).rejects.toMatchObject({ code: "OMNIGENT_PROTOCOL_ERROR" });
    expect(events).toEqual(["interrupt"]);
    expect(await control.taskStatus(ID, false))
      .toMatchObject({ status: "idle" });
  });

  it("does not confirm hard cancellation when stop_session acknowledgement is ambiguous", async () => {
    ambiguousCancelEvent = "stop_session";
    await expect(control.cancel(ID, true)).rejects.toMatchObject({ code: "OMNIGENT_PROTOCOL_ERROR" });
    expect(events).toEqual(["interrupt", "stop_session"]);
    expect(await control.taskStatus(ID, false))
      .toMatchObject({ status: "idle" });
  });

  it("clears confirmed cancellation only after a follow-up message is accepted", async () => {
    await control.cancel(ID, false);
    refuseMessage = true;
    await expect(control.followUp(ID, "Continue"))
      .rejects.toMatchObject({ code: "OMNIGENT_PROTOCOL_ERROR" });
    expect(await control.taskStatus(ID, false))
      .toMatchObject({ status: "cancelled" });

    refuseMessage = false;
    expect(await control.followUp(ID, "Continue"))
      .toMatchObject({ status: "idle" });
    expect(await control.taskStatus(ID, false))
      .toMatchObject({ status: "idle" });
  });

  it("withholds raw backend failures", async () => {
    vi.stubGlobal("fetch", async () => new Response("token=private-value", { status: 503 }));
    control = new OmnigentControl({ stateDir: state });
    await expect(control.status()).rejects.toMatchObject({ code: "OMNIGENT_REQUEST_FAILED" });
  });

  it("sanitizes direct control submissions too", async () => {
    await expect(control.followUp(ID, "token=private")).rejects.toMatchObject({ code: "SENSITIVE_TASK_INPUT" });
    expect(calls).toEqual([]);
  });
});
