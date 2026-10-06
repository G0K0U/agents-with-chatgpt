import { it, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, symlinkSync, rmSync, mkdirSync } from "node:fs";

import { join, resolve, sep } from "node:path";
import { permitsDevelopmentOperation } from "../src/providers/zcode/permissions.js";
import { ZcodeProtocol } from "../src/providers/zcode/protocol.js";
import type { ProviderSendOptions } from "../src/providers/types.js";
const root = mkdtempSync(join(process.cwd(), "z2c-permissions-"));
const ownedDirs = [root];
after(() => {
  for (const dir of ownedDirs) {
    if (!resolve(dir).startsWith(resolve(process.cwd()) + sep)) throw new Error("test cleanup outside workspace");
    rmSync(dir, { recursive: true, force: true });
  }
});
const grants = new Map([["write", { workspacePath: root, write: true }], ["read", { workspacePath: root, write: false }]]);
const localGrants = new Map<string, NonNullable<ProviderSendOptions["executionGrant"]>>([
  ["write", { workspacePath: root, write: true, mode: "machine-local-development" }],
  ["read", { workspacePath: root, write: false, mode: "machine-local-development" }],
]);
function request(toolName: string, input: unknown, sessionId = "write") {
  return { requestId: "request", sessionId, toolCallId: "tool", toolName, input, riskLevel: "medium", options: [{ optionId: "allow_once", kind: "allow_once", response: { decision: "allow" } }] };
}
it("admits machine-local cross-repo files and development shells only for write tasks", () => {
  const outside = mkdtempSync(join(process.cwd(), "z2c-local-"));
  ownedDirs.push(outside);
  for (const tool of ["Read", "Write", "Edit"]) {
    for (const file_path of [join(outside, "source.ts"), "../" + outside.split(sep).at(-1) + "/source.ts", "src/relative.ts"]) {
      assert.equal(permitsDevelopmentOperation(request(tool, { file_path }), localGrants), true);
      if (tool !== "Read") assert.equal(permitsDevelopmentOperation(request(tool, { file_path }, "read"), localGrants), false);
    }
  }
  for (const command of ['cd /d "F:/AI Startup/upstream/zcode-oss" && pnpm typecheck', 'powershell -NoProfile -Command "Set-Location ../other; npm run build"', 'cmd /c "git -C ../other status"', 'node scripts/check.mjs --verbose', 'pnpm exec tsc --noEmit']) {
    assert.equal(permitsDevelopmentOperation(request("Bash", { command }), localGrants), true);
    assert.equal(permitsDevelopmentOperation(request("Bash", { command }, "read"), localGrants), false);
  }
});
it("redacts allowed machine-local payloads from responses and audit events", () => {
  class Transport extends EventEmitter { sent: unknown[] = []; write(v: unknown) { this.sent.push(v); } }
  const transport = new Transport();
  const protocol = new ZcodeProtocol(transport, p => permitsDevelopmentOperation(p, localGrants));
  const audit: unknown[] = [];
  protocol.on("permission-decision", event => audit.push(event));
  transport.emit("message", { id: 1, method: "interaction/requestPermission", params: request("Write", { file_path: "source.ts", content: "SECRET_SENTINEL" }) });
  assert.deepEqual(transport.sent, [{ id: 1, result: { decision: "allow" } }]);
  // Full-record deepEqual keeps the redaction proof strict: only sanitized
  // correlation identifiers, never provider input.
  assert.deepEqual(audit, [{
    allowed: true,
    reason: null,
    source: "policy",
    correlation: { sessionId: "write", requestId: "request", toolCallId: "tool", toolName: "Write", riskLevel: "medium" },
    at: (audit[0] as { at: string }).at,
  }]);
  assert.equal(JSON.stringify([transport.sent, audit, protocol.notifications]).includes("SECRET_SENTINEL"), false);
});
it("admits bounded development operations only for the active write grant", () => {
  for (const command of ["node --version", "pnpm --version", "pnpm test", "pnpm build", "pnpm typecheck", "git status", "git diff", "node scripts/check.mjs"]) {
    assert.equal(permitsDevelopmentOperation(request("Bash", { command }), grants), true, command);
    assert.equal(permitsDevelopmentOperation(request("Bash", { command }, "read"), grants), false);
  }
  for (const tool of ["Read", "Write", "Edit"]) {
    assert.equal(permitsDevelopmentOperation(request(tool, { file_path: join(root, "src/new.ts") }), grants), true);
    assert.equal(permitsDevelopmentOperation(request(tool, { file_path: join(root, "src/new.ts") }, "read"), grants), tool === "Read");
  }
});
it("denies missing grants, unknown tools/options, credentials, escapes, and shell bypasses", () => {
  for (const p of [request("Bash", { command: "node --version" }, "other"), request("ExitPlanMode", {}), request("Read", { file_path: "../outside" }), request("Write", { file_path: ".env" }), request("Read", { file_path: ".ssh/id_rsa" }), request("Bash", { command: "node scripts/*.js" }), request("Bash", { command: "node ~/outside.js" }), request("Bash", { command: "node -e 'process.env'" }), request("Bash", { command: "pnpm test; whoami" }), request("Bash", { command: "node --version", dangerouslyDisableSandbox: true }), { ...request("Bash", { command: "node --version" }), options: [{ optionId: "always" }] }]) {
    assert.equal(permitsDevelopmentOperation(p, grants), false);
  }
  const outside = mkdtempSync(join(process.cwd(), "z2c-outside-"));
  ownedDirs.push(outside);
  symlinkSync(outside, join(root, "escape"), "junction");
  assert.equal(permitsDevelopmentOperation(request("Write", { file_path: join(root, "escape/new/file") }), grants), false);
  mkdirSync(join(root, ".ssh"));
  symlinkSync(join(root, ".ssh"), join(root, "alias"), "junction");
  assert.equal(permitsDevelopmentOperation(request("Read", { file_path: join(root, "alias/id_rsa") }), grants), false);
});
it("answers allow-once without reflecting secret inputs; unattended input stays rejected", () => {
  class Transport extends EventEmitter { sent: unknown[] = []; write(v: unknown) { this.sent.push(v); } }
  const transport = new Transport();
  const protocol = new ZcodeProtocol(transport, p => permitsDevelopmentOperation(p, grants));
  transport.emit("message", { id: 1, method: "interaction/requestPermission", params: request("Bash", { command: "node --version" }) });
  assert.deepEqual(transport.sent[0], { id: 1, result: { decision: "allow" } });
  transport.emit("message", { id: 2, method: "interaction/requestPermission", params: request("Unknown", { secret: "SECRET_SENTINEL" }) });
  assert.deepEqual(transport.sent[1], { id: 2, result: { decision: "deny" } });
  transport.emit("message", { id: 3, method: "interaction/requestUserInput", params: { secret: "SECRET_SENTINEL" } });
  assert.equal(JSON.stringify(transport.sent).includes("SECRET_SENTINEL"), false);
  assert.equal(protocol.unanswerableClientRequests.length, 1);
  grants.delete("write");
  transport.emit("message", { id: 4, method: "interaction/requestPermission", params: request("Bash", { command: "node --version" }) });
  assert.deepEqual(transport.sent[3], { id: 4, result: { decision: "deny" } });
});
