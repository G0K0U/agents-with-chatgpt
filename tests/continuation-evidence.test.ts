import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { observeNativeModel, verificationFingerprint } from "../src/execution/continuation-evidence.js";
import { verifyWebSource, sourceGatePassed } from "../src/execution/continuation-verifier.js";
import { makeTmpDir, cleanup, write } from "./helpers.js";
const roots: string[] = [];
const oldHome = process.env.CODEX_HOME;
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome; });
function fixture() { const root = makeTmpDir("continuation-evidence"); roots.push(root); return root; }
it("binds exact current native turn and rejects old, future, malformed, wrong-thread and linked contexts", () => {
  const root = fixture(); process.env.CODEX_HOME = root;
  const thread = randomUUID(), turn = randomUUID(), start = Date.now() - 1000;
  const base = { type: "turn_context", timestamp: new Date(start + 1).toISOString(), payload: { turn_id: turn, thread_id: thread, model: "gpt-6-astra", effort: "high" } };
  const rel = `sessions/${new Date(start).toISOString().slice(0, 10).replaceAll("-", "/")}/rollout-${thread}.jsonl`;
  const read = () => observeNativeModel(thread, new Date(start).toISOString(), turn);
  const metadata = JSON.stringify({ type: "session_meta", payload: { id: thread } }) + "\n";
  for (const row of [{ ...base, timestamp: new Date(start - 1).toISOString() }, { ...base, timestamp: new Date(Date.now() + 60000).toISOString() }, { ...base, payload: { ...base.payload, turn_id: randomUUID() } }, { ...base, payload: { ...base.payload, thread_id: randomUUID() } }, { ...base, timestamp: "bad" }]) {
    write(root, rel, metadata + JSON.stringify(row)); expect(read()).toBeNull();
  }
  write(root, rel, metadata + JSON.stringify(base)); expect(read()?.model).toBe("gpt-6-astra");
  expect(observeNativeModel(thread, new Date(start).toISOString())).toBeNull();
  const dir = path.dirname(path.join(root, rel)), real = `${dir}-real`;
  fs.renameSync(dir, real); fs.symlinkSync(real, dir, "junction"); expect(read()).toBeNull();
});
it("fingerprints backend production inputs and consistently excludes caches", () => {
  const root = fixture(); write(root, "apps/api/main.py", "one"); const before = verificationFingerprint(root);
  write(root, "apps/api/__pycache__/main.pyc", "generated"); expect(verificationFingerprint(root)).toBe(before);
  write(root, "apps/api/main.py", "two"); expect(verificationFingerprint(root)).not.toBe(before);
});
function webFixture(text: string) {
  const root = fixture(); write(root, "apps/web/package.json", '{"type":"module"}');
  write(root, "apps/web/tsconfig.json", '{"compilerOptions":{"skipLibCheck":true,"types":[]},"files":["index.ts"]}');
  write(root, "apps/web/index.ts", "export const ok = 1;");
  for (const name of ["theme", "provenance-model", "admin-contract"]) write(root, `apps/web/lib/${name}.test.ts`, text);
  return root;
}
it("architecture gate: an actual failed test child cannot pass the source gate", async () => {
  const root = webFixture("import test from 'node:test'; import assert from 'node:assert/strict'; test('fails', () => assert.equal(1,2));");
  const gate = await verifyWebSource(root);
  expect(gate.checks[1].exitCode).toBe(1);
  expect(sourceGatePassed(gate, verificationFingerprint(root))).toBe(false);
}, 15000);
it.each(["console.log('tests passed')", "console.log(JSON.stringify({passed:true,tests:999,checks:[{exitCode:0}]}))"])("fake worker output cannot pass a real source gate: %s", async text => {
  const root = webFixture(text), gate = await verifyWebSource(root);
  expect(gate.checks).toHaveLength(2); expect(gate.checks.every(c => c.exitCode === 0)).toBe(true);
  expect(sourceGatePassed(gate, verificationFingerprint(root))).toBe(false);
}, 15000);
it("real fixed checks pass and source edits invalidate the bound gate", async () => {
  const root = webFixture("import test from 'node:test'; import assert from 'node:assert/strict'; test('actual assertion', () => assert.equal(1,1));");
  const gate = await verifyWebSource(root); expect(sourceGatePassed(gate, verificationFingerprint(root))).toBe(true);
  write(root, "apps/web/index.ts", "export const ok = 2;"); expect(sourceGatePassed(gate, verificationFingerprint(root))).toBe(false);
}, 15000);
it("source changing inside a check invalidates evidence", async () => {
  const root = webFixture("import fs from 'node:fs'; import test from 'node:test'; test('mutates', () => fs.writeFileSync('index.ts','export const changed = 1;'));");
  const gate = await verifyWebSource(root); expect(gate.before).not.toBe(gate.after); expect(gate.passed).toBe(false);
}, 15000);
