/**
 * A2C → native Z2C workspace projection — the ONE projection helper for the
 * whole native lane.
 *
 * The A2C workspace registry authorizes the PUBLIC workspace id (12-hex,
 * principal-scoped). The Z2C companion's grant registry defines the NATIVE
 * workspace id its tools actually accept ("ws_…", keyed by canonical root).
 * The semantic lane (zcode_session_*) has always resolved the native id
 * through ZcodeSessionClient.ensureGrant (zcode_workspace_list matched by
 * canonical path, provisioned when missing); the native lane reuses exactly
 * that authoritative path here — no string heuristics, no hardcoded ids.
 *
 * Direction of trust: an A2C-authorized workspace id is projected INTO the
 * native namespace before any upstream call, and every workspace namespace
 * (and canonical root) returned by upstream is validated BACK against that
 * projection before anything is released. Both directions fail closed.
 */
import { ZcodeSessionClient } from "./zcode-session-client.js";

export class ZcodeWorkspaceProjectionError extends Error {
  constructor(
    public readonly code:
      | "ZCODE_WORKSPACE_PROJECTION_FAILED"
      | "ZCODE_WORKSPACE_PROJECTION_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "ZcodeWorkspaceProjectionError";
  }
}

/**
 * Project an authorized A2C workspace onto its native Z2C grant id.
 *
 * Reuses the semantic lane's authoritative mapping (ensureGrant: match the
 * grant registry by canonical root, provision a mirror grant when the local
 * operator's A2C registry already authorizes it — never a caller-driven
 * self-authorization). The grant registry is the single source of truth for
 * the native id; nothing here guesses one.
 */
export async function projectNativeWorkspace(
  client: ZcodeSessionClient,
  input: { workspaceId: string; canonicalPath: string; write?: boolean },
): Promise<{ nativeWorkspaceId: string; canonicalPath: string }> {
  const { workspaceId, canonicalPath } = input;
  if (typeof workspaceId !== "string" || !workspaceId.trim()) {
    throw new ZcodeWorkspaceProjectionError(
      "ZCODE_WORKSPACE_PROJECTION_FAILED",
      "native workspace projection requires the authorized A2C workspace id",
    );
  }
  if (typeof canonicalPath !== "string" || !canonicalPath.trim()) {
    throw new ZcodeWorkspaceProjectionError(
      "ZCODE_WORKSPACE_PROJECTION_FAILED",
      `native workspace projection requires the registered canonical root for workspace ${workspaceId}`,
    );
  }
  // ensureGrant is the semantic lane's authoritative resolver — the same
  // function zcode_session_create/read/send bind workspaces through.
  const grant = await client.ensureGrant(canonicalPath, input.write === true);
  if (!grant || typeof grant.workspace_id !== "string" || !grant.workspace_id) {
    throw new ZcodeWorkspaceProjectionError(
      "ZCODE_WORKSPACE_PROJECTION_FAILED",
      `the Z2C grant registry returned no usable workspace id for ${workspaceId}`,
    );
  }
  return { nativeWorkspaceId: grant.workspace_id, canonicalPath };
}

/**
 * Fail-closed namespace check for anything upstream returns: the returned
 * workspace id must be the projected native id of the authorized A2C
 * workspace — never another workspace's, never the raw public id echoed back.
 */
export function assertProjectedNamespace(input: {
  nativeWorkspaceId: string;
  returnedWorkspaceId: unknown;
  context: string;
}): void {
  if (input.returnedWorkspaceId !== input.nativeWorkspaceId) {
    throw new ZcodeWorkspaceProjectionError(
      "ZCODE_WORKSPACE_PROJECTION_MISMATCH",
      `${input.context}: returned workspace namespace does not match the authorized A2C workspace projection`,
    );
  }
}
