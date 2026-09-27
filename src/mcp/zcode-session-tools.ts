/**
 * ChatGPT-facing SEMANTIC ZCode (Z2C) session tools — the Phase-3 surface,
 * integrated into the A2C public MCP gateway.
 *
 * These tools forward to the Z2C local service (loopback, "z2c-service") —
 * the completed Phase-3 semantic implementation. A2C does not reimplement
 * session control; it adds the A2C security context before any forwarding:
 *
 *   ChatGPT → A2C OAuth/pairing → resolveWorkspace (A2C registry is
 *   authoritative) → session ownership (per OAuth client) → Z2C semantic
 *   handler → owned workspace/session → ZCode Desktop.
 *
 * Workspace binding: the A2C workspace's canonical root is mapped to the Z2C
 * companion's grant registry (mirrored only for workspaces already authorized
 * here — never a ChatGPT self-authorization). Session identity is attested by
 * the Z2C service from the exact session's own state and returned sanitized.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  ZcodeSessionError,
  ZcodeSessionClient,
  loadZcodeSessionConfig,
  type ZcodeWorkspaceGrant,
} from "../execution/zcode-session-client.js";
import {
  loadZcodeSessionOwnership,
  zcodeSessionClientId,
  ZcodeSessionOwnershipError,
} from "../execution/zcode-session-ownership.js";
import { safeOutput } from "./zcode-tools.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export interface ZcodeSessionToolDeps {
  requireScope: (authInfo: AuthInfo | undefined, scope: string) => ToolResult | null;
  resolveWorkspace: (requestedId: string, authInfo: AuthInfo | undefined, sessionId?: string) => unknown;
  /** Registered A2C workspaces visible to this principal (id + canonical root). */
  visibleWorkspaces: (authInfo: AuthInfo | undefined) => Array<{ workspaceId: string; canonicalPath: string }>;
  stateDir?: string;
  /**
   * Z1 multi-root full-access boundary: when the deployment is a full-access
   * lane, ZCode sessions bind to this APPROVED PARENT ROOT instead of the
   * single creating project root, so the agent
   * can work across sibling projects while staying fenced inside the approved
   * boundary. Undefined = legacy single-root binding. Fail-closed: an A2C
   * workspace root OUTSIDE this boundary never uses it.
   */
  fullAccessRoot?: string;
  ok: (data: unknown) => ToolResult;
  fail: (code: string, message: string) => ToolResult;
  mapError: (error: unknown) => ToolResult;
  untrustedNote: string;
}

let cachedClient: ZcodeSessionClient | null = null;
let cachedOwnershipDir: string | null = null;
let cachedOwnership: ReturnType<typeof loadZcodeSessionOwnership> | null = null;

export function zcodeSessionClient(): ZcodeSessionClient {
  cachedClient ??= new ZcodeSessionClient(loadZcodeSessionConfig());
  return cachedClient;
}

export function resetZcodeSessionClientForTests(): void {
  cachedClient = null;
}

function ownershipFor(stateDir: string | undefined): ReturnType<typeof loadZcodeSessionOwnership> {
  // Without a state directory, ownership is enforced in-process only (memory)
  // — enforcement never degrades, only cross-restart durability is lost.
  if (!stateDir) {
    memoryOwnership ??= loadZcodeSessionOwnership("");
    return memoryOwnership;
  }
  if (!cachedOwnership || cachedOwnershipDir !== stateDir) {
    cachedOwnershipDir = stateDir;
    cachedOwnership = loadZcodeSessionOwnership(stateDir);
  }
  return cachedOwnership;
}
let memoryOwnership: ReturnType<typeof loadZcodeSessionOwnership> | null = null;

/** Test seam. */
export function resetZcodeSessionOwnershipForTests(): void {
  cachedOwnership = null;
  cachedOwnershipDir = null;
}

const workspaceIdField = z.string().min(3).max(128).describe("A2C authorized workspace id");
const sessionIdField = z.string().regex(/^sess_[0-9a-f-]{36}$/i).describe("Z2C-owned native session id (sess_…)");
const instructionField = z
  .string()
  .min(1)
  .max(20000)
  .describe("Bounded instruction for the ZCode agent (max 20000 chars, no credentials)");

export function registerZcodeSessionTools(server: McpServer, deps: ZcodeSessionToolDeps): void {
  const { requireScope, resolveWorkspace, fail, mapError } = deps;
  const ok = (data: unknown): ToolResult => deps.ok(safeOutput(data));
  const ownership = () => ownershipFor(deps.stateDir);

  const mapErr = (error: unknown): ToolResult => {
    if (error instanceof ZcodeSessionOwnershipError) return fail(error.code, error.message);
    if (error instanceof ZcodeSessionError) {
      return fail(error.code, error.upstreamCode ? `[${error.upstreamCode}] ${error.message}` : error.message);
    }
    const maybeCoded = error as { code?: string };
    if (typeof maybeCoded?.code === "string" && maybeCoded.code.startsWith("ZCODE_")) {
      return fail(maybeCoded.code, (error as Error).message);
    }
    return mapError(error);
  };

  /**
   * A2C-authoritative workspace resolution + Z2C grant mapping. Returns the
   * Z2C-side workspace id to forward. The A2C workspace registry and the
   * caller's authorization are checked BEFORE any Z2C interaction.
   */
  const resolveZcodeWorkspace = async (
    workspaceId: string,
    authInfo: AuthInfo | undefined,
    write: boolean,
  ): Promise<{ zcodeWorkspaceId: string; canonicalPath: string }> => {
    const workspace = resolveWorkspace(workspaceId, authInfo) as { root?: string; canonicalPath?: string };
    const canonicalPath = (workspace?.canonicalPath ?? workspace?.root) as string | undefined;
    if (!canonicalPath) {
      throw new ZcodeSessionError("ZCODE_SESSION_WORKSPACE_FORBIDDEN", "Authorized workspace path unavailable");
    }
    // The caller must be authorized for exactly this workspace in A2C.
    const visible = deps.visibleWorkspaces(authInfo).find(
      (w) => w.workspaceId === workspaceId || w.canonicalPath.replace(/[\\/]+$/, "").toLowerCase() === canonicalPath.replace(/[\\/]+$/, "").toLowerCase(),
    );
    if (!visible) {
      throw new ZcodeSessionError("ZCODE_SESSION_WORKSPACE_FORBIDDEN", "workspace is not authorized for this client");
    }
    // Z1 multi-root full-access: on a full-access lane, bind the ZCode session
    // to the APPROVED PARENT ROOT (not the single project root) so the agent
    // can work across sibling projects while staying fenced inside the
    // approved boundary. Fail-closed: the A2C workspace root must lie INSIDE
    // the approved parent, otherwise the legacy per-workspace binding applies.
    let bindingRoot = canonicalPath;
    if (deps.fullAccessRoot) {
      const normRoot = deps.fullAccessRoot.replace(/[\\/]+$/, "").toLowerCase();
      const normPath = canonicalPath.replace(/[\\/]+$/, "").toLowerCase();
      const inside = normPath === normRoot || normPath.startsWith(normRoot + "\\") || normPath.startsWith(normRoot + "/");
      if (inside) bindingRoot = deps.fullAccessRoot;
    }
    const grant = await zcodeSessionClient().ensureGrant(bindingRoot, write);
    return { zcodeWorkspaceId: grant.workspace_id, canonicalPath: bindingRoot };
  };

  server.registerTool("zcode_runtime_capabilities", {
    title: "ZCode runtime capabilities",
    description:
      "Z2C protocol version, ZCode provider health, and detected ZCode runtime version for the governed Z2C lane. Read-only.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async (_args, extra) => {
    const denied = requireScope(extra.authInfo, "execution.read");
    if (denied) return denied;
    try {
      return ok(await zcodeSessionClient().runtimeCapabilities());
    } catch (err) { return mapErr(err); }
  });

  server.registerTool("zcode_workspace_list", {
    title: "List Z2C-authorized workspaces",
    description:
      "Workspaces the local user authorized in the Z2C companion, intersected with the workspaces THIS client is authorized for in A2C. Read-only.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async (_args, extra) => {
    const denied = requireScope(extra.authInfo, "workspace.read");
    if (denied) return denied;
    try {
      const visible = new Map(deps.visibleWorkspaces(extra.authInfo).map((w) => [w.canonicalPath.replace(/[\\/]+$/, "").toLowerCase(), w.workspaceId]));
      const { workspaces } = await zcodeSessionClient().workspaceList();
      const listed = (workspaces as ZcodeWorkspaceGrant[])
        .filter((g) => typeof g.canonical_path === "string" && visible.has(g.canonical_path.replace(/[\\/]+$/, "").toLowerCase()))
        .map((g) => ({
          workspace_id: g.workspace_id,
          a2c_workspace_id: visible.get(g.canonical_path!.replace(/[\\/]+$/, "").toLowerCase()),
          display_name: g.display_name ?? null,
          permissions: g.permissions ?? { read: true, write: false },
        }));
      return ok({ workspaces: listed });
    } catch (err) { return mapErr(err); }
  });

  server.registerTool("zcode_session_create", {
    title: "Create ZCode session",
    description:
      "Create a native ZCode session in an authorized workspace via the Z2C lane (ZCode Desktop, GLM). " +
      "access=readonly establishes plan mode via the v4 CAS path; identity (provider/model/thought) is resolved by ZCode " +
      "and attested from the exact session. " + deps.untrustedNote,
    inputSchema: {
      workspace_id: workspaceIdField,
      access: z.enum(["readonly", "write"]).describe("readonly = plan-governed (no workspace mutation); write = edit lane"),
      model: z.string().max(64).optional().describe("Requested native model (attested post-create)"),
      thought_level: z.string().max(20).optional().describe("Requested reasoning depth (attested post-create)"),
      provider: z.string().max(64).optional().describe("Optional explicit provider constraint"),
    },
    annotations: { readOnlyHint: false },
  }, async (args, extra) => {
    const denied = requireScope(extra.authInfo, "execution.submit");
    if (denied) return denied;
    try {
      const access = args.access;
      const { zcodeWorkspaceId } = await resolveZcodeWorkspace(args.workspace_id, extra.authInfo, access === "write");
      const state = await zcodeSessionClient().createSession({
        workspace_id: zcodeWorkspaceId,
        access,
        ...(args.model ? { model: args.model } : {}),
        ...(args.thought_level ? { thought_level: args.thought_level } : {}),
        ...(args.provider ? { provider: args.provider } : {}),
      });
      ownershipFor(deps.stateDir).record({
        sessionId: state.session_id,
        workspaceId: args.workspace_id,
        clientId: zcodeSessionClientId(extra.authInfo),
        access,
      });
      return ok({ ...state, a2c_workspace_id: args.workspace_id });
    } catch (err) { return mapErr(err); }
  });

  server.registerTool("zcode_session_read", {
    title: "Read ZCode session",
    description:
      "Sanitized authoritative state of a Z2C session you own in an authorized workspace (workspace/provider/model/thought/mode/runtime).",
    inputSchema: { workspace_id: workspaceIdField, session_id: sessionIdField },
    annotations: { readOnlyHint: true },
  }, async (args, extra) => {
    const denied = requireScope(extra.authInfo, "execution.read");
    if (denied) return denied;
    try {
      const { zcodeWorkspaceId } = await resolveZcodeWorkspace(args.workspace_id, extra.authInfo, false);
      // OBSERVE path: owner-scoped live read, gated by the observe capability.
      ownership().assertCanObserve(extra.authInfo, args.session_id, args.workspace_id);
      const state = await zcodeSessionClient().readSession({ workspace_id: zcodeWorkspaceId, session_id: args.session_id });
      ownership().touch(args.session_id);
      return ok({ ...state, a2c_workspace_id: args.workspace_id });
    } catch (err) { return mapErr(err); }
  });

  server.registerTool("zcode_session_send", {
    title: "Send instruction to ZCode session",
    description:
      "Send one instruction to a Z2C session you own and wait for the bounded final assistant output plus re-attested state. " +
      "Readonly (plan) sessions cannot mutate the workspace — the ZCode agent enforces this. " + deps.untrustedNote,
    inputSchema: {
      workspace_id: workspaceIdField,
      session_id: sessionIdField,
      instruction: instructionField,
      timeout_ms: z.number().int().min(10000).max(900000).optional(),
    },
    annotations: { readOnlyHint: false },
  }, async (args, extra) => {
    const denied = requireScope(extra.authInfo, "execution.submit");
    if (denied) return denied;
    try {
      // CONTROL path: owner, local operator, or explicitly delegated controller.
      const owned = ownership().assertCanControl(extra.authInfo, args.session_id, args.workspace_id);
      const { zcodeWorkspaceId } = await resolveZcodeWorkspace(args.workspace_id, extra.authInfo, false);
      const result = await zcodeSessionClient().sendSession({
        workspace_id: zcodeWorkspaceId,
        session_id: args.session_id,
        instruction: args.instruction,
        timeout_ms: args.timeout_ms,
      });
      ownership().touch(args.session_id);
      void owned;
      return ok({ ...result, a2c_workspace_id: args.workspace_id });
    } catch (err) { return mapErr(err); }
  });

  server.registerTool("zcode_session_set_model", {
    title: "Set ZCode session model",
    description:
      "Switch the native model of a Z2C session you own (same session id preserved). The switch must be " +
      "re-observed on the exact session or it fails closed. " + deps.untrustedNote,
    inputSchema: { workspace_id: workspaceIdField, session_id: sessionIdField, model: z.string().min(1).max(64) },
    annotations: { readOnlyHint: false },
  }, async (args, extra) => {
    const denied = requireScope(extra.authInfo, "execution.submit");
    if (denied) return denied;
    try {
      (void await resolveZcodeWorkspace(args.workspace_id, extra.authInfo, false));
      // CONTROL path: model/thought switches mutate the session.
      ownership().assertCanControl(extra.authInfo, args.session_id, args.workspace_id);
      const { zcodeWorkspaceId } = await resolveZcodeWorkspace(args.workspace_id, extra.authInfo, false);
      const state = await zcodeSessionClient().setModel({ workspace_id: zcodeWorkspaceId, session_id: args.session_id, model: args.model });
      return ok({ ...state, a2c_workspace_id: args.workspace_id });
    } catch (err) { return mapErr(err); }
  });

  server.registerTool("zcode_session_set_thought_level", {
    title: "Set ZCode session thought level",
    description:
      "Switch the reasoning depth of a Z2C session you own; the switch must be re-observed on the exact session or it fails closed. " + deps.untrustedNote,
    inputSchema: { workspace_id: workspaceIdField, session_id: sessionIdField, thought_level: z.string().min(1).max(20) },
    annotations: { readOnlyHint: false },
  }, async (args, extra) => {
    const denied = requireScope(extra.authInfo, "execution.submit");
    if (denied) return denied;
    try {
      (void await resolveZcodeWorkspace(args.workspace_id, extra.authInfo, false));
      // CONTROL path: model/thought switches mutate the session.
      ownership().assertCanControl(extra.authInfo, args.session_id, args.workspace_id);
      const { zcodeWorkspaceId } = await resolveZcodeWorkspace(args.workspace_id, extra.authInfo, false);
      const state = await zcodeSessionClient().setThoughtLevel({ workspace_id: zcodeWorkspaceId, session_id: args.session_id, thought_level: args.thought_level });
      return ok({ ...state, a2c_workspace_id: args.workspace_id });
    } catch (err) { return mapErr(err); }
  });
}
