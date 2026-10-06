import { afterEach, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { registerOrchestratorTools } from "../src/mcp/orchestrator-tools.js";
import { OrchestratorCore } from "../src/execution/orchestrator-core.js";
import type { CodexTaskView } from "../src/execution/tasks.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(cleanup); });
it("registers six narrow tools with scope, workspace and owner enforcement", async () => {
  const dir = makeTmpDir("orchestrator-tools"); dirs.push(dir);
  const task = { taskId: "fixture", status: "completed", outputIds: [1] } as CodexTaskView;
  const core = new OrchestratorCore(dir, "ws", { submit: () => task, get: () => task });
  type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
  const handlers = new Map<string, (a: unknown, e: { authInfo?: AuthInfo }) => Promise<Result>>();
  const server = { registerTool: (name: string, _schema: unknown, handler: typeof handlers extends Map<string, infer H> ? H : never) => {
    handlers.set(name, handler);
  } } as unknown as McpServer;
  const ok = (value: unknown): Result => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  registerOrchestratorTools(server, {
    resolve: (ws) => { if (ws !== "ws") throw new Error("workspace denied"); return core; },
    requireScope: (auth, scope) => auth?.scopes.includes(scope) ? null : { ...ok("scope denied"), isError: true },
    ok, mapError: e => ({ ...ok(String(e)), isError: true }),
  });
  expect([...handlers.keys()]).toEqual(["orchestrator_run_create", "orchestrator_run_read", "orchestrator_run_pause",
    "orchestrator_run_resume", "orchestrator_audit_claim", "orchestrator_audit_submit"]);
  const auth = { clientId: "owner", scopes: ["execution.read", "execution.submit"] } as AuthInfo;
  const call = (name: string, args: unknown, principal = auth) => handlers.get(name)!(args, { authInfo: principal });
  const identity = { workspace_id: "ws", run_id: "run" };
  const create = { ...identity, steps: [{ instruction: "Explicit task", write_scope: ["src"] }] };
  expect((await call("orchestrator_run_create", create, { ...auth, scopes: ["execution.read"] })).isError).toBe(true);
  expect((await call("orchestrator_run_create", { ...create, planner: "automatic" })).isError).toBe(true);
  expect((await call("orchestrator_run_create", create)).isError).toBeUndefined();
  expect((await call("orchestrator_run_read", { ...identity, workspace_id: "other" })).isError).toBe(true);
  expect((await call("orchestrator_run_read", identity, { ...auth, clientId: "other" })).isError).toBe(true);
  const audit_id = core.read("run", "owner").audits[0].id;
  expect((await call("orchestrator_audit_claim", { ...identity, audit_id })).isError).toBeUndefined();
  expect((await call("orchestrator_audit_submit", { ...identity, audit_id, verdict: "PASS" })).isError).toBeUndefined();
  expect(core.read("run", "owner").state).toBe("COMPLETE");
});
