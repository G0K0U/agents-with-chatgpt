import type { ZcodeDiscoveredSession } from "../../execution/zcode-session-client.js";
import type { AgentSessionRecord, AgentSessionOrigin } from "../types.js";
import type { AppendableActivityEvent } from "../store.js";

/**
 * ZCode adapter: projects the Z2C local-operator discovery surface (native
 * session/list, canonical-root filtered in Z2C) plus A2C ownership records
 * into shared plane session records.
 *
 * Origin semantics:
 *   a2c     — an A2C ownership record exists (session created via A2C)
 *   native  — created through the Z2C lane outside A2C (local/paired client)
 *   desktop — external runtime origin (Desktop/manual), observe-only
 *
 * Canonical-root boundary: a discovered session is projected ONLY when its Z2C
 * grant path maps to an A2C-authorized workspace (equal to or containing the
 * grant root — the Z1 full-access parent binding). Everything else is denied.
 */

function normRoot(path: string): string {
  return path.replace(/[\\/]+$/, "").toLowerCase();
}

function isInside(parent: string, child: string): boolean {
  const p = normRoot(parent);
  const c = normRoot(child);
  return c === p || c.startsWith(`${p}\\`) || c.startsWith(`${p}/`);
}

/** Map a Z2C grant path to the most specific A2C-authorized workspace, failing closed on ambiguity. */
export function a2cWorkspaceForZcodeGrant(
  grantPath: string,
  workspaces: Array<{ workspaceId: string; canonicalPath: string }>,
): { workspaceId: string; canonicalPath: string } | null {
  if (!grantPath || typeof grantPath !== "string" || !Array.isArray(workspaces) || workspaces.length === 0) {
    return null;
  }
  const matching = workspaces.filter(
    (w) => isInside(grantPath, w.canonicalPath) || isInside(w.canonicalPath, grantPath),
  );
  if (matching.length === 0) return null;
  if (matching.length === 1) return matching[0];

  // Exact matches take precedence
  const exact = matching.filter((w) => normRoot(w.canonicalPath) === normRoot(grantPath));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    const ids = new Set(exact.map((w) => w.workspaceId));
    if (ids.size > 1) return null; // Ambiguous exact matches -> fail closed!
    return exact[0];
  }

  // When grantPath is a common parent of multiple distinct sibling workspaces
  // and multiple distinct workspaces are inside it without an exact match:
  const insideGrant = matching.filter((w) => isInside(grantPath, w.canonicalPath));
  const distinctInsideIds = new Set(insideGrant.map((w) => w.workspaceId));
  if (distinctInsideIds.size > 1) {
    return null; // Ambiguous: grant path encompasses multiple distinct workspaces -> fail closed!
  }

  // Sort by specificity (length of canonicalPath descending)
  matching.sort((a, b) => normRoot(b.canonicalPath).length - normRoot(a.canonicalPath).length);
  const bestLength = normRoot(matching[0].canonicalPath).length;
  const top = matching.filter((w) => normRoot(w.canonicalPath).length === bestLength);
  const topIds = new Set(top.map((w) => w.workspaceId));
  if (topIds.size > 1) return null; // Tied for specificity -> fail closed!

  return matching[0];
}

export interface ZcodeOwnershipProjection {
  clientId: string;
  delegatedControllers: string[];
}

export function projectZcodeDiscovery(input: {
  discovered: ZcodeDiscoveredSession[];
  workspaces: Array<{ workspaceId: string; canonicalPath: string }>;
  ownershipRecord: (sessionId: string) => ZcodeOwnershipProjection | undefined;
  previous: Map<string, AgentSessionRecord>;
  observedAt: string;
}): { records: AgentSessionRecord[]; events: AppendableActivityEvent[] } {
  const { discovered, workspaces, ownershipRecord, previous, observedAt } = input;
  const records: AgentSessionRecord[] = [];
  const events: AppendableActivityEvent[] = [];

  for (const entry of discovered) {
    const workspace = a2cWorkspaceForZcodeGrant(entry.workspace_path, workspaces);
    // Canonical-root boundary: no A2C-authorized workspace mapping → no projection.
    if (!workspace) continue;

    const owned = ownershipRecord(entry.session_id);
    let origin: AgentSessionOrigin;
    let ownerClientId: string | null;
    let controllers: string[];
    if (owned) {
      origin = "a2c";
      ownerClientId = owned.clientId;
      controllers = [...new Set([owned.clientId, "local", ...owned.delegatedControllers])];
    } else if (entry.runtime_origin === "z2c") {
      origin = "native";
      ownerClientId = entry.owner_client_id;
      controllers = ["local"];
    } else {
      origin = "desktop";
      ownerClientId = null;
      controllers = ["local"];
    }

    const prior = previous.get(entry.session_id);
    const updatedAt = entry.updated_at ?? prior?.updatedAt ?? observedAt;
    const record: AgentSessionRecord = {
      sessionId: entry.session_id,
      provider: "zcode",
      origin,
      workspaceId: workspace.workspaceId,
      canonicalRoot: workspace.canonicalPath,
      nativeSessionId: entry.session_id,
      providerSessionId: entry.session_id,
      ownerClientId,
      controllers,
      // Discovery does not carry model/thought; preserve prior enrichment.
      model: prior?.model ?? null,
      thoughtLevel: prior?.thoughtLevel ?? null,
      status: entry.status || prior?.status || "unknown",
      title: entry.title ?? prior?.title ?? null,
      createdAt: prior?.createdAt ?? updatedAt,
      updatedAt,
      taskIds: prior?.taskIds ?? [],
      lastUserInstruction: prior?.lastUserInstruction ?? null,
      lastAssistantOutput: prior?.lastAssistantOutput ?? null,
      changedFilesCount: prior?.changedFilesCount ?? 0,
      verificationStatus: prior?.verificationStatus ?? null,
      zcodeWorkspaceId: entry.workspace_id,
      observedAt,
    };
    records.push(record);

    if (!prior) {
      events.push({
        key: `zcode:session:${entry.session_id}:discovered`,
        at: observedAt,
        type: origin === "a2c" ? "session.created" : "session.discovered",
        provider: "zcode",
        workspaceId: workspace.workspaceId,
        sessionId: entry.session_id,
        taskId: null,
        summary: `zcode ${origin} session discovered (${entry.status || "unknown"})`,
        outputRef: null,
      });
    } else if (prior.status !== record.status) {
      events.push({
        key: `zcode:session:${entry.session_id}:${record.status}:${observedAt}`,
        at: observedAt,
        type: "session.updated",
        provider: "zcode",
        workspaceId: workspace.workspaceId,
        sessionId: entry.session_id,
        taskId: null,
        summary: `zcode session status ${prior.status} → ${record.status}`,
        outputRef: prior.lastAssistantOutput ?? null,
      });
    }
  }

  return { records, events };
}
