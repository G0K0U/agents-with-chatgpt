import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { verificationFingerprint } from "./continuation-evidence.js";

export interface SourceGate {
  version: 1; profile: "web-source-v1"; passed: boolean; before: string | null; after: string | null;
  startedAt: string; completedAt: string;
  checks: Array<{ id: string; argv: string[]; exitCode: number | null; outputHash: string; tests?: number }>;
}
export function sourceGatePassed(gate: SourceGate | undefined, finalHash: string | null): boolean {
  return Boolean(gate?.version === 1 && gate.profile === "web-source-v1" && gate.passed && finalHash &&
    gate.before === finalHash && gate.after === finalHash && gate.checks.length === 2 &&
    gate.checks[0].id === "web-typecheck" && gate.checks[1].id === "web-contracts" &&
    gate.checks.every(c => c.exitCode === 0) && (gate.checks[1].tests ?? 0) > 0);
}
function execute(cwd: string, argv: string[]): Promise<{ exitCode: number | null; output: string }> {
  return new Promise(resolve => {
    // Fixed installed argv; no shell, package scripts, worker command or JSON is executed.
    const child = spawn(process.execPath, argv, { cwd, windowsHide: true, shell: false,
      env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", settled = false;
    const finish = (exitCode: number | null) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ exitCode, output }); };
    const timer = setTimeout(() => { child.kill(); finish(null); }, 120_000);
    child.stdout.on("data", chunk => { output += chunk; if (output.length > 1024 * 1024) { child.kill(); finish(null); } });
    // stderr (warnings included) is retained separately from structured reporter stdout.
    child.stderr.on("data", () => {});
    child.once("error", () => finish(null)); child.once("close", code => finish(code));
  });
}
export async function verifyWebSource(root: string): Promise<SourceGate> {
  const before = verificationFingerprint(root), startedAt = new Date().toISOString();
  const gate: SourceGate = { version: 1, profile: "web-source-v1", passed: false, before, after: null, startedAt, completedAt: startedAt, checks: [] };
  try {
    if (!before) return gate;
    const cwd = path.join(root, "apps/web");
    const require = createRequire(path.join(cwd, "package.json"));
    const tsc = require.resolve("typescript/bin/tsc");
    const reporter = new URL(`./continuation-reporter${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url).href;
    const vectors = [
      { id: "web-typecheck", argv: [tsc, "--noEmit", "--incremental", "false"] },
      { id: "web-contracts", argv: ["--experimental-strip-types", "--test", `--test-reporter=${reporter}`, "lib/theme.test.ts", "lib/provenance-model.test.ts", "lib/admin-contract.test.ts"] },
    ];
    for (const vector of vectors) {
      if (verificationFingerprint(root) !== before) break;
      const result = await execute(cwd, vector.argv);
      let tests: number | undefined;
      if (vector.id === "web-contracts" && result.exitCode === 0) {
        try {
          const counts = JSON.parse(result.output.trim());
          if (Number.isInteger(counts.tests) && counts.tests > 0 && counts.passed === counts.tests && counts.failed === 0 && counts.cancelled === 0 && counts.skipped === 0 && counts.todo === 0) tests = counts.tests;
        } catch { /* Printed fake summaries and malformed reports are never evidence. */ }
      }
      gate.checks.push({ ...vector, exitCode: result.exitCode, tests, outputHash: createHash("sha256").update(result.output).digest("hex") });
      if (verificationFingerprint(root) !== before) break;
    }
  } catch { /* Missing installed profile stays failed; never install dependencies. */ }
  gate.after = verificationFingerprint(root); gate.completedAt = new Date().toISOString();
  gate.passed = gate.before === gate.after && gate.checks.length === 2 && gate.checks.every(c => c.exitCode === 0) && (gate.checks[1].tests ?? 0) > 0;
  return gate;
}
