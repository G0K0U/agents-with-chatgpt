import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Workspace } from "../workspace/manager.js";
import { writeSecureJson } from "../config/paths.js";
import { continuationDirectory, type ApprovedManifest } from "./continuation.js";
import { ENGINEERING_AI_WORKSPACE_ID, ENGINEERING_AI_AUDIT_STATUS_LEDGER_RELATIVE_PATH,
  ENGINEERING_AI_AUDIT_TIMELINE_LEDGER_RELATIVE_PATH, ENGINEERING_AI_AUDIT_MIRROR_FILENAMES,
  resolveEngineeringAiAuditMirrorTarget, writeEngineeringAiAuditMirror, MAX_AUDIT_MIRROR_BYTES } from "./audit-mirror.js";

/**
 * Operator-configured OneDrive mirror root (C2C_ONEDRIVE_AUDIT_ROOT). Empty by
 * default: the external mirror is disabled unless the operator opts in, and no
 * machine-local path ships in the product.
 */
const FIXED_ROOT = process.env.C2C_ONEDRIVE_AUDIT_ROOT?.trim() ?? "";
/** Invoked only under the manager's idle-writer reservation. No product task can start during collection. */
export async function collectContinuationAudit(workspace: Workspace, stateDir: string, manifest: ApprovedManifest,
  snapshot: unknown, eventId: string, authorize: (owner: string, workspace: string, scope: string) => boolean,
  oneDriveRoot = FIXED_ROOT): Promise<unknown> {
  if (!ENGINEERING_AI_WORKSPACE_ID || workspace.id !== ENGINEERING_AI_WORKSPACE_ID) return { state: "NOT_APPLICABLE", fragment: snapshot };
  if (!oneDriveRoot) return { state: "NOT_APPLICABLE", fragment: snapshot };
  if (!authorize(manifest.ownerId, workspace.id, "audit_mirror.write")) throw new Error("audit_mirror.write authorization required");
  const dir = continuationDirectory(stateDir, workspace.id);
  const lock = path.join(dir, "collector.lock");
  const fd = fs.openSync(lock, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, eventId }));
    const evidence = [];
    const safeId = createHash("sha256").update(eventId).digest("hex");
    const marker = `<!-- c2c-continuation:${safeId} -->`;
    const current = snapshot as Record<string, unknown>;
    const compact = { planId: current.planId, state: current.state, health: current.health, review: current.review,
      independentAcceptance: current.independentAcceptance, nextEligible: current.nextEligible, error: current.error,
      challenge: current.challenge, generatedAt: current.generatedAt, loadedControllerSha256: current.loadedControllerSha256,
      nodes: Object.fromEntries(Object.entries((current.nodes ?? {}) as Record<string, { taskIds: string[]; state: string; evidence?: any }>).map(([id, node]) => [id, {
        state: node.state, taskIds: node.taskIds, actualModel: node.evidence?.actualModel,
        sourceHash: node.evidence?.stableVerification?.sourceHash, stableVerification: node.evidence?.stableVerification?.passed,
        historicalStatus: node.evidence?.status, historicalError: node.evidence?.error,
      }])), protectedEvidence: "continuation state.json and collector-evidence.json" };
    const block = `${marker}\n\n## Continuation checkpoint ${new Date().toISOString()}\n\n\`\`\`json\n${JSON.stringify(compact, null, 2)}\n\`\`\`\n`;
    for (let i = 0; i < ENGINEERING_AI_AUDIT_MIRROR_FILENAMES.length; i++) {
      const requestedPath = `Desktop/Startup/${ENGINEERING_AI_AUDIT_MIRROR_FILENAMES[i]}`;
      const target = resolveEngineeringAiAuditMirrorTarget({ oneDriveRoot, requestedPath });
      const ledger = workspace.resolve(i === 0 ? ENGINEERING_AI_AUDIT_STATUS_LEDGER_RELATIVE_PATH : ENGINEERING_AI_AUDIT_TIMELINE_LEDGER_RELATIVE_PATH).abs;
      for (const file of [ledger, target.target]) {
        if (fs.existsSync(file)) {
          const st = fs.lstatSync(file);
          if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_AUDIT_MIRROR_BYTES) throw new Error("Audit history cannot be safely preserved");
        }
      }
      const local = fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8") : "";
      const external = fs.existsSync(target.target) ? fs.readFileSync(target.target, "utf8") : "";
      // Preserve both histories before any replacement, including divergent OneDrive history.
      const historyId = createHash("sha256").update(local + "\0" + external).digest("hex");
      const archive = path.join(dir, `history-${i}-${historyId}.json`);
      if (!fs.existsSync(archive)) writeSecureJson(archive, { eventId, local, external, localHash: createHash("sha256").update(local).digest("hex"), externalHash: createHash("sha256").update(external).digest("hex") });
      const begin = "<!-- c2c-latest-snapshot-begin -->", end = "<!-- c2c-latest-snapshot-end -->";
      const previousEnd = local.indexOf(end);
      const historicalLocal = local.startsWith(begin) && previousEnd >= 0 ? local.slice(previousEnd + end.length).replace(/^\n/, "") : local;
      const content = local.includes(marker) ? local : i === 0 ? `${begin}\n${block}${end}\n${historicalLocal}` : `${local}\n${block}`;
      if (Buffer.byteLength(content) > MAX_AUDIT_MIRROR_BYTES) throw new Error("Audit ledger full; retained fragment requires history rotation review");
      if (content !== local) {
        const temp = `${ledger}.${randomUUID()}.tmp`;
        fs.writeFileSync(temp, content, { flag: "wx", mode: 0o600 });
        fs.renameSync(temp, ledger);
      }
      if (!authorize(manifest.ownerId, workspace.id, "audit_mirror.write")) throw new Error("Mirror authorization revoked");
      const result = await writeEngineeringAiAuditMirror({ stateDir, oneDriveRoot, requestedPath, source: "engineering_ai_ledger", ledgerWorkspace: workspace, recordWorkspaceId: workspace.id, ownerId: manifest.ownerId });
      evidence.push(result);
      writeSecureJson(path.join(dir, "collector-evidence.json"), { eventId, evidence });
      if (!result.success) throw new Error("Audit mirror failed; evidence retained");
    }
    return { state: "MIRRORED", eventId, evidence };
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
