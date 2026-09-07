import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

export interface NativeModelEvidence { model: string; effort: string; timestamp: string; turnId: string | null; source: "native_turn_context"; sha256: string }
/** Read only matching native session metadata. Never infer a model from configuration defaults. */
export function observeNativeModel(threadId: string | undefined, startedAt: string, expectedTurnId?: string): NativeModelEvidence | null {
  if (!threadId || !/^[a-f0-9-]{36}$/.test(threadId)) return null;
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start) || !expectedTurnId) return null;
  for (const offset of [-1, 0, 1]) {
    const date = new Date(start + offset * 86400_000).toISOString().slice(0, 10).replaceAll("-", "/");
    const dir = path.join(root, date);
    try {
      if (path.resolve(fs.realpathSync.native(dir)).toLowerCase() !== path.resolve(dir).toLowerCase()) continue;
      for (const name of fs.readdirSync(dir).filter(n => n.endsWith(`${threadId}.jsonl`))) {
        const file = path.join(dir, name), stat = fs.lstatSync(file);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64 * 1024 * 1024) continue;
        let evidence: NativeModelEvidence | null = null;
        let sessionMatches = false;
        for (const line of fs.readFileSync(file, "utf8").split("\n")) {
          if (!/"type"\s*:\s*"(?:turn_context|session_meta)"/.test(line)) continue;
          try {
            const row = JSON.parse(line);
            if (row.type === "session_meta") { sessionMatches = row.payload?.id === threadId; continue; }
            const timestamp = Date.parse(row.timestamp);
            if (row.type === "turn_context" && row.payload?.turn_id === expectedTurnId &&
                (!row.payload.thread_id || row.payload.thread_id === threadId) &&
                Number.isFinite(timestamp) && timestamp >= start && timestamp <= Date.now() &&
                typeof row.payload?.model === "string" && typeof row.payload?.effort === "string") {
              evidence = { model: row.payload.model, effort: row.payload.effort, timestamp: row.timestamp,
                turnId: row.payload.turn_id ?? null, source: "native_turn_context", sha256: createHash("sha256").update(line).digest("hex") };
            }
          } catch { /* An incomplete native append is not proof. */ }
        }
        if (evidence && sessionMatches) return evidence;
      }
    } catch { /* Metadata unavailable remains unknown. */ }
  }
  return null;
}

/** Bounded source identity for stable checks; excludes generated outputs and audit reports. */
export function verificationFingerprint(root: string): string | null {
  const rows: Array<[string, string]> = [];
  let bytes = 0;
  const visit = (rel: string): void => {
    const abs = path.join(root, rel), stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink()) throw new Error("Unverifiable source link");
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        if (["node_modules", ".next", ".git", "dist", "build", ".cache", ".pytest_cache", "__pycache__", ".venv", "coverage", "test-results", "playwright-report"].includes(name) || /\.(tsbuildinfo|pyc)$/.test(name)) continue;
        visit(path.join(rel, name));
      }
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (rows.length > 25000 || bytes > 128 * 1024 * 1024) throw new Error("Source fingerprint bound exceeded");
      rows.push([rel.replaceAll("\\", "/"), createHash("sha256").update(fs.readFileSync(abs)).digest("hex")]);
    }
  };
  try {
    for (const rel of ["apps/web", "apps/api", "apps/runner", "packages", "scripts", "src", "tests", "package.json", "pnpm-lock.yaml", "uv.lock", "pyproject.toml", "tsconfig.json"]) if (fs.existsSync(path.join(root, rel))) visit(rel);
    return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  } catch { return null; }
}
