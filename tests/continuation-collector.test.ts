import fs from "node:fs";
import path from "node:path";
import { afterEach, it, expect } from "vitest";
import { collectContinuationAudit } from "../src/execution/continuation-collector.js";
import { continuationDirectory, type ApprovedManifest } from "../src/execution/continuation.js";
import { ENGINEERING_AI_WORKSPACE_ID, ENGINEERING_AI_ONEDRIVE_FOLDER } from "../src/execution/audit-mirror.js";
import { Workspace } from "../src/workspace/manager.js";
import { makeTmpDir, cleanup, write } from "./helpers.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });
function fixture() {
  const root = makeTmpDir("collector"); roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  write(workspaceRoot, "docs/audit-loop-state.md", "local status history\n");
  write(workspaceRoot, "docs/audit-execution-timeline.md", "local timeline history\n");
  const workspace = new Workspace(workspaceRoot);
  Object.defineProperty(workspace, "id", { value: ENGINEERING_AI_WORKSPACE_ID });
  const mirror = path.join(root, ENGINEERING_AI_ONEDRIVE_FOLDER);
  write(mirror, "Desktop/Startup/engineering-ai-audit-status.md", "unique external status history\n");
  write(mirror, "Desktop/Startup/engineering-ai-audit-timeline.md", "unique external timeline history\n");
  const state = path.join(root, "state"); fs.mkdirSync(state);
  const manifest = { ownerId: "owner", workspaceId: workspace.id } as ApprovedManifest;
  return { root, workspaceRoot, workspace, mirror, state, manifest };
}
it("serializes canonical history, idempotent events and fixed mirror hashes", async () => {
  const f = fixture();
  const run = () => collectContinuationAudit(f.workspace, f.state, f.manifest, { state: "WAITING_REVIEW" }, "checkpoint-1", () => true, f.mirror);
  const first = await run() as any; expect(first.state).toBe("MIRRORED");
  const before = fs.readFileSync(path.join(f.workspaceRoot, "docs/audit-loop-state.md"), "utf8");
  await run();
  expect(fs.readFileSync(path.join(f.workspaceRoot, "docs/audit-loop-state.md"), "utf8")).toBe(before);
  expect(before).toContain("local status history");
  const archiveDir = continuationDirectory(f.state, f.workspace.id);
  expect(fs.readdirSync(archiveDir).filter(n => n.startsWith("history-")).some(n => fs.readFileSync(path.join(archiveDir, n), "utf8").includes("unique external status history"))).toBe(true);
  expect(first.evidence.every((e: any) => e.sha256 === e.targetSha256 && e.success)).toBe(true);
});
it("does not bypass mirror authorization or a conflicting writer", async () => {
  const f = fixture();
  await expect(collectContinuationAudit(f.workspace, f.state, f.manifest, {}, "checkpoint", () => false, f.mirror)).rejects.toThrow("audit_mirror.write");
  const dir = continuationDirectory(f.state, f.workspace.id); write(dir, "collector.lock", "existing owner");
  await expect(collectContinuationAudit(f.workspace, f.state, f.manifest, {}, "checkpoint", () => true, f.mirror)).rejects.toThrow();
  expect(fs.readFileSync(path.join(f.workspaceRoot, "docs/audit-loop-state.md"), "utf8")).toBe("local status history\n");
});
it("retains original histories when a mirror target is unsafe", async () => {
  const f = fixture();
  fs.renameSync(path.join(f.mirror, "Desktop/Startup"), path.join(f.mirror, "Desktop/Retained"));
  await expect(collectContinuationAudit(f.workspace, f.state, f.manifest, {}, "checkpoint", () => true, f.mirror)).rejects.toThrow();
  expect(fs.readFileSync(path.join(f.workspaceRoot, "docs/audit-loop-state.md"), "utf8")).toBe("local status history\n");
});
