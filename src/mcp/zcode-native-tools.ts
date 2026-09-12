/**
 * ChatGPT-facing NATIVE ZCode (Z2C desktop-managed) tools.
 *
 * Distinct from the zcode_* scheduled-queue tools: this surface forwards
 * governed operations to the independent, already-working Z2C control plane
 * (desktop-spawned agent, Desktop-managed auth, realtime FIFO).
 * It is a thin proxy — C2C adds only principal workspace authorization
 * (resolveWorkspace — the C2C registry is authoritative), the shared product
 * queue pause/freeze and writer-slot gate, credential gating, returned-task
 * binding verification, namespace validation, and token scrubbing. No
 * fallback to the scheduled queue exists in either direction.
 *
 * Mutation ordering: submit/resume run resolveWorkspace → shared queue/writer
 * gate BEFORE any upstream side effect; execution identity is then proven by
 * the task/session binding Z2C observed at admission (exact session/read).
 * Cancel remains available while submissions are frozen, but verifies the task
 * workspace with a read-only scoped get BEFORE forwarding the mutation.
 */
import { z } from "zod";
import { nativeSelfTest } from "../execution/zcode-native-self-test.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  ZcodeNativeClient,
  ZcodeNativeError,
  ZCODE_IDEMPOTENCY_KEY,
  loadZcodeNativeConfig,
} from "../execution/zcode-native.js";
import { safeOutput } from "./zcode-tools.js";
import type { CodexTaskManager } from "../execution/tasks.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export interface ZcodeNativeToolDeps {
  requireScope: (authInfo: AuthInfo | undefined, scope: string) => ToolResult | null;
  resolveWorkspace: (
    requestedId: string,
    authInfo: AuthInfo | undefined,
    sessionId?: string
  ) => unknown;
  /** Shared product queue pause/freeze + writer-slot gate; throws before dispatch. */
  taskGate: (workspaceId: string, authInfo: AuthInfo | undefined, write: boolean) => void;
  writerManagerFor: (workspaceId: string, authInfo: AuthInfo | undefined) => Pick<CodexTaskManager, "submitNative" | "resumeNative" | "getNative" | "cancelNative" | "outputNative">;
  nativeAdmissionSnapshot?: (workspaceId: string, authInfo: AuthInfo | undefined) => { queue: string; writer: string };
  ok: (data: unknown) => ToolResult;
  fail: (code: string, message: string) => ToolResult;
  mapError: (error: unknown) => ToolResult;
  untrustedNote: string;
}

let cachedClient: ZcodeNativeClient | null = null;

/** Lazily build the governed client from the fixed local configuration. */
export function zcodeNativeClient(): ZcodeNativeClient {
  cachedClient ??= new ZcodeNativeClient(loadZcodeNativeConfig());
  return cachedClient;
}

/** Test seam: forget the cached client so a new configuration takes effect. */
export function resetZcodeNativeClientForTests(): void {
  cachedClient = null;
}

const workspaceIdField = z
  .string()
  .min(3)
  .max(64)
  .describe("Governed native workspace id enabled for Z2C forwarding via ZCODE_NATIVE_ALLOWED_WORKSPACES");
const instructionField = z
  .string()
  .min(1)
  .max(20000)
  .describe("Bounded instruction for the native ZCode Desktop agent (max 20000 chars, no credentials)");
const taskIdField = z.string().regex(/^z2c_[A-Za-z0-9_-]{1,100}$/);

export function registerZcodeNativeTools(server: McpServer, deps: ZcodeNativeToolDeps): void {
  const { requireScope, resolveWorkspace, fail, mapError } = deps;
  const ok = (data: unknown): ToolResult => deps.ok(safeOutput(data));

  const mapErr = (error: unknown): ToolResult => {
    if (error instanceof ZcodeNativeError) {
      return fail(error.code, error.upstreamCode ? `[${error.upstreamCode}] ${error.message}` : error.message);
    }
    const maybeCoded = error as { code?: string };
    if (typeof maybeCoded?.code === "string" && maybeCoded.code.startsWith("ZCODE_")) {
      return fail(maybeCoded.code, (error as Error).message);
    }
    return mapError(error);
  };

  const resolveAuthorized = (
    workspaceId: string,
    authInfo: AuthInfo | undefined,
    sessionId?: string,
  ): unknown => {
    // C2C's workspace registry + principal authorization are authoritative;
    // this must succeed before any upstream interaction.
    return resolveWorkspace(workspaceId, authInfo, sessionId);
  };

  server.registerTool("zcode_native_read_session", {
    title: "Read native ZCode session",
    description: "Read and attest the exact native session workspace, Desktop-managed provider and GLM model binding. Fails closed on any mismatch. No scheduled-queue scheduling.",
    inputSchema: { workspace_id: workspaceIdField, session_id: z.string().regex(/^sess_[0-9a-f-]{36}$/i) },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => {
    const denied = requireScope(extra.authInfo, "execution.read");
    if (denied) return denied;
    try {
      const workspace = resolveWorkspace(args.workspace_id, extra.authInfo, extra.sessionId) as { root?: string };
      if (!workspace?.root) throw new ZcodeNativeError("ZCODE_NATIVE_NAMESPACE_MISMATCH", "Authorized workspace path unavailable");
      return ok(await zcodeNativeClient().readSession({ ...args, expected_workspace_path: workspace.root }));
    } catch (err) { return mapErr(err); }
  });

  server.registerTool("zcode_native_self_test", {
    title: "Native ZCode protocol self-test",
    description: "Run a fixed server-owned readonly plan probe to verify native durable idempotency, exact Desktop GLM binding, replay, conflict, and unchanged C2C queue/writer state. Creates one native task and cancels it only when execution.cancel is authorized. Returns bounded evidence only.",
    inputSchema: { workspace_id: workspaceIdField },
    annotations: { readOnlyHint: false },
  }, async (args, extra) => {
    // This surface never sends authorization errors or upstream messages back as evidence.
    try {
      if (!extra.authInfo || requireScope(extra.authInfo, "execution.submit")) throw new Error("unauthorized");
      const workspace = resolveAuthorized(args.workspace_id, extra.authInfo, extra.sessionId) as { root?: string } | undefined;
      deps.taskGate(args.workspace_id, extra.authInfo, false);
      if (!deps.nativeAdmissionSnapshot) throw new Error("snapshot unavailable");
      const manager = deps.writerManagerFor(args.workspace_id, extra.authInfo);
      const canCancel = !requireScope(extra.authInfo, "execution.cancel");
      const evidence = await nativeSelfTest(args.workspace_id, {
        providerStatus: id => zcodeNativeClient().providerStatus(id),
        submitNative: input => manager.submitNative(input, () => deps.taskGate(args.workspace_id, extra.authInfo, false)),
        snapshot: () => deps.nativeAdmissionSnapshot!(args.workspace_id, extra.authInfo),
        ...(canCancel ? { cancel: (input: { workspace_id: string; task_id: string }) => manager.cancelNative(input, true) } : {}),
        // Layered proofs: read the admitted task back and attest the exact
        // native session in its authorized workspace.
        getTask: input => manager.getNative(input),
        ...(workspace?.root ? { readSession: (input: { workspace_id: string; session_id: string }) =>
          zcodeNativeClient().readSession({ ...input, expected_workspace_path: workspace.root }) } : {}),
      });
      return { ...ok(evidence), ...(evidence.overall === "FAIL" ? { isError: true } : {}) };
    } catch {
      return { ...ok({ overall: "FAIL" }), isError: true };
    }
  });

  server.registerTool(
    "zcode_native_status",
    {
      title: "Native ZCode status",
      description:
        "Health and Desktop GLM binding identity of the independent Z2C control plane, scoped to the " +
        "authorized workspace_id. Reports the binding observed via Z2C's native exact-session read " +
        "for the workspace's current session; UNKNOWN when no observable session exists. Status is " +
        "informational and never blocks task creation — admission identity is proven per task. " +
        "Read-only; no fallback.",
      inputSchema: { workspace_id: workspaceIdField },
      annotations: { readOnlyHint: true },
    },
    async (args, extra) => {
      const denied = requireScope(extra.authInfo, "execution.read");
      if (denied) return denied;
      try {
        resolveAuthorized(args.workspace_id, extra.authInfo, extra.sessionId);
        return ok(await zcodeNativeClient().status(args.workspace_id));
      } catch (err) {
        return mapErr(err);
      }
    },
  );

  server.registerTool(
    "zcode_native_submit_task",
    {
      title: "Submit native ZCode task",
      description:
        "Dispatch a realtime native ZCode task through Z2C in an authorized governed " +
        "workspace enabled via ZCODE_NATIVE_ALLOWED_WORKSPACES. Honors the shared workspace " +
        "queue pause/freeze and writer slot. Z2C admits the task only after observing " +
        "the sanctioned Desktop-managed binding (builtin:zai-start-plan/GLM-5.3-Flash) on the " +
        "exact created session, and the returned task " +
        "binding is re-verified here — fails closed, never falls back to the scheduled queue. " +
        deps.untrustedNote,
      inputSchema: {
        workspace_id: workspaceIdField,
        instruction: instructionField,
        idempotency_key: z.string().regex(ZCODE_IDEMPOTENCY_KEY).optional(),
        write_scope: z.enum(["workspace", "readonly"]).optional().describe("Default: workspace"),
        mode: z.enum(["plan", "build", "edit"]).optional().describe("Default: build"),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, extra) => {
      const denied = requireScope(extra.authInfo, "execution.submit");
      if (denied) return denied;
      try {
        resolveAuthorized(args.workspace_id, extra.authInfo, extra.sessionId);
        deps.taskGate(args.workspace_id, extra.authInfo, (args.write_scope ?? "workspace") === "workspace");
        return ok(await deps.writerManagerFor(args.workspace_id, extra.authInfo).submitNative(args));
      } catch (err) {
        return mapErr(err);
      }
    },
  );

  server.registerTool(
    "zcode_native_get_task",
    {
      title: "Get native ZCode task",
      description:
        "Bounded native task metadata from Z2C (stable z2c_* task id, sess_* session id, status, " +
        "timestamps) for an authorized workspace.",
      inputSchema: {
        workspace_id: workspaceIdField,
        task_id: taskIdField,
      },
      annotations: { readOnlyHint: true },
    },
    async (args, extra) => {
      const denied = requireScope(extra.authInfo, "execution.read");
      if (denied) return denied;
      try {
        resolveAuthorized(args.workspace_id, extra.authInfo, extra.sessionId);
        return ok(await deps.writerManagerFor(args.workspace_id, extra.authInfo).getNative(args));
      } catch (err) {
        return mapErr(err);
      }
    },
  );

  server.registerTool(
    "zcode_native_cancel_task",
    {
      title: "Cancel native ZCode task",
      description:
        "Cancel a queued/running native ZCode task (interrupts the real ZCode session). Workspace membership " +
        "is verified with a read-only scoped lookup before the mutation; cancellation stays " +
        "available while new submissions are paused/frozen.",
      inputSchema: {
        workspace_id: workspaceIdField,
        task_id: taskIdField,
      },
      annotations: { readOnlyHint: false },
    },
    async (args, extra) => {
      const denied = requireScope(extra.authInfo, "execution.cancel");
      if (denied) return denied;
      try {
        resolveAuthorized(args.workspace_id, extra.authInfo, extra.sessionId);
        return ok(await deps.writerManagerFor(args.workspace_id, extra.authInfo).cancelNative(args));
      } catch (err) {
        return mapErr(err);
      }
    },
  );

  server.registerTool(
    "zcode_native_execution_output",
    {
      title: "Native ZCode execution output",
      description:
        "Bounded final assistant output of a completed native task, for independent audit of the " +
        "actual GLM result. The authorized workspace and upstream task/output namespace are verified; only projected " +
        "safe fields are returned, size-bounded and credential-scrubbed.",
      inputSchema: {
        workspace_id: workspaceIdField,
        task_id: taskIdField,
        output_id: z.string().min(3).max(128),
      },
      annotations: { readOnlyHint: true },
    },
    async (args, extra) => {
      const denied = requireScope(extra.authInfo, "execution.read");
      if (denied) return denied;
      try {
        resolveAuthorized(args.workspace_id, extra.authInfo, extra.sessionId);
        return ok(await deps.writerManagerFor(args.workspace_id, extra.authInfo).outputNative(args));
      } catch (err) {
        return mapErr(err);
      }
    },
  );

  server.registerTool(
    "zcode_native_resume_session",
    {
      title: "Resume native ZCode session",
      description:
        "Continue an existing native sess_* ZCode session with a fresh instruction, preserving its " +
        "context immediately when idle; rejects paused/busy work without scheduled-queue scheduling. Exact session read precedes send. Same principal authorization, shared queue/writer gate, and Desktop GLM identity " +
        "rules as submit. " +
        deps.untrustedNote,
      inputSchema: {
        workspace_id: workspaceIdField,
        session_id: z.string().regex(/^sess_[0-9a-f-]{36}$/i),
        instruction: instructionField,
      },
      annotations: { readOnlyHint: false },
    },
    async (args, extra) => {
      const denied = requireScope(extra.authInfo, "execution.submit");
      if (denied) return denied;
      try {
        resolveAuthorized(args.workspace_id, extra.authInfo, extra.sessionId);
        deps.taskGate(args.workspace_id, extra.authInfo, true);
        return ok(await deps.writerManagerFor(args.workspace_id, extra.authInfo).resumeNative(args));
      } catch (err) {
        return mapErr(err);
      }
    },
  );
}
