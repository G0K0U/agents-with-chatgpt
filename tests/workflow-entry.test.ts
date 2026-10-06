import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const fixtures: string[] = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("a2c-workflow-entry-")) throw new Error("Unsafe fixture cleanup");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

function run(scenario: string, action: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "a2c-workflow-entry-"));
  fixtures.push(root);
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, "bin"));
  fs.copyFileSync(path.resolve("scripts/engineering-ai-workflow.mjs"), path.join(root, "scripts/entry.mjs"));
  fs.writeFileSync(path.join(root, "bin/c2c.js"), `
    const fs = require('node:fs'); const path = require('node:path');
    const root = path.resolve(__dirname, '..'); const scenario = ${JSON.stringify(scenario)};
    const args = process.argv.slice(2); const command = args[0]; const sub = args[1];
    fs.appendFileSync(path.join(root, 'calls.log'), command + '/' + sub + '\\n');
    let data;
    if (command === 'supervisor' && sub === 'start') {
      data = {ok:false, pid:7654321, overall:'OFFLINE'};
      process.exitCode = 1;
    } else if (command === 'supervisor') {
      const file = path.join(root, 'status-count'); const n = Number(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 0) + 1;
      fs.writeFileSync(file, String(n));
      data = {ok:n > 1, running:true, pid:7654321, processStatus:scenario === 'unknown' ? 'unknown' : 'same', overall:n > 1 ? 'READY' : 'OFFLINE'};
      if (!data.ok) process.exitCode = 1;
    } else if (command === 'health') data = {READY:true, READY_STATE:'READY', RECONCILING:false};
    else if (command === 'dispatch-policy') data = {effectivePaused:scenario === 'paused', envOverride:{active:false}};
    else if (command === 'worker-effort-policy') data = {glmAndGemini:'highest'};
    else throw new Error('Unexpected operator mutation');
    process.stdout.write(JSON.stringify(data));
  `);
  let out: string;
  let exit = 0;
  try { out = execFileSync(process.execPath, [path.join(root, "scripts/entry.mjs"), action, "--json", "--wait-seconds", "4"], { cwd: os.tmpdir(), encoding: "utf8", windowsHide: true, timeout: 10000 }); }
  catch (e) { out = String((e as { stdout: string }).stdout); exit = (e as { status: number }).status; }
  return { data: JSON.parse(out), exit, calls: fs.readFileSync(path.join(root, "calls.log"), "utf8").trim().split("\n") };
}

describe("saved finite workflow operator entry", () => {
  it("waits after a cold start only when current same-process ownership is verified", () => {
    const result = run("same", "start");
    expect(result.exit).toBe(0);
    expect(result.data.readyForDotGate).toBe(true);
    expect(result.calls.filter(call => call === "supervisor/start")).toHaveLength(1);
    expect(result.calls.filter(call => call === "supervisor/status")).toHaveLength(2);
  });
  it("does not infer owner proof from a recorded PID or issue a duplicate start", () => {
    const result = run("unknown", "start");
    expect(result.exit).toBe(2);
    expect(result.data.error_code).toBe("SUPERVISOR_START_NOT_VERIFIED");
    expect(result.calls).toEqual(["supervisor/start", "supervisor/status"]);
  });
  it("status waits for a running supervisor's first readiness tick without starting it", () => {
    const result = run("same", "status");
    expect(result.exit).toBe(0);
    expect(result.data.readyForDotGate).toBe(true);
    expect(result.calls).not.toContain("supervisor/start");
    expect(result.calls.filter(call => call === "supervisor/status")).toHaveLength(2);
  });
  it("keeps operator pause fail-closed and never clears policy or creates tasks", () => {
    const result = run("paused", "status");
    expect(result.exit).toBe(2);
    expect(result.data.dispatch).toBe("PAUSED");
    expect(result.data.readyForDotGate).toBe(false);
    expect(result.calls.every(call => ["health/--workspace", "supervisor/status", "dispatch-policy/status", "worker-effort-policy/status"].includes(call))).toBe(true);
  });
});
