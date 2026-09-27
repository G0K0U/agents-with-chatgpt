import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadZcodeSessionOwnership,
  zcodeSessionClientId,
  ZcodeSessionOwnershipError,
} from "../src/execution/zcode-session-ownership.js";

/**
 * zcode-session-ownership v2: observe vs control capability split with
 * backward-compatible v1 migration. Client ownership is preserved; the
 * original v1 behavior (assertCanAccess) must be unchanged.
 */

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "zcode-own-v2-"));
}

const authOf = (clientId: string | undefined) => (clientId ? ({ clientId, extra: {} } as never) : undefined);

describe("zcode-session-ownership v2 migration", () => {
  it("migrates a v1 file in memory and persists the v2 envelope on next write", () => {
    const dir = tmp();
    try {
      const file = join(dir, "zcode-session-ownership.json");
      writeFileSync(file, JSON.stringify({
        version: 1,
        sessions: [{
          sessionId: "sess_11111111-1111-1111-1111-111111111111",
          workspaceId: "ws_eng",
          clientId: "client-A",
          access: "write",
          createdAt: 1700000000000,
          lastUsedAt: 1700000001000,
        }],
      }));
      const ownership = loadZcodeSessionOwnership(dir);
      const record = ownership.sessionRecord("sess_11111111-1111-1111-1111-111111111111");
      assert.ok(record);
      assert.equal(record!.clientId, "client-A");
      assert.deepEqual(record!.capabilities, { observe: true, control: true });
      assert.deepEqual(record!.delegatedControllers, []);
      assert.equal(record!.origin, "a2c");
      // History preserved through migration.
      assert.equal(record!.createdAt, 1700000000000);
      // Any write persists v2 (touch counts).
      ownership.touch("sess_11111111-1111-1111-1111-111111111111");
      const onDisk = JSON.parse(readFileSync(file, "utf8")) as { version: number };
      assert.equal(onDisk.version, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the file untouched when only read (lazy migration, no history loss)", () => {
    const dir = tmp();
    try {
      const file = join(dir, "zcode-session-ownership.json");
      writeFileSync(file, JSON.stringify({ version: 1, sessions: [] }));
      const ownership = loadZcodeSessionOwnership(dir);
      assert.equal(ownership.sessionRecord("sess_22222222-2222-2222-2222-222222222222"), undefined);
      assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("new records are v2 with full owner capabilities and no delegations", () => {
    const dir = tmp();
    try {
      const ownership = loadZcodeSessionOwnership(dir);
      ownership.record({ sessionId: "sess_33333333-3333-3333-3333-333333333333", workspaceId: "ws_eng", clientId: "client-A", access: "readonly" });
      const file = join(dir, "zcode-session-ownership.json");
      assert.ok(existsSync(file));
      const onDisk = JSON.parse(readFileSync(file, "utf8")) as { version: number; sessions: Array<{ capabilities?: unknown }> };
      assert.equal(onDisk.version, 2);
      assert.deepEqual(onDisk.sessions[0].capabilities, { observe: true, control: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("observe vs control split", () => {
  let dir: string;
  let ownership: ReturnType<typeof loadZcodeSessionOwnership>;
  const SID = "sess_44444444-4444-4444-4444-444444444444";

  beforeEach(() => {
    dir = tmp();
    ownership = loadZcodeSessionOwnership(dir);
    ownership.record({ sessionId: SID, workspaceId: "ws_eng", clientId: "client-A", access: "write" });
  });

  it("owner can observe AND control its own session", () => {
    assert.equal(ownership.assertCanAccess(authOf("client-A"), SID, "ws_eng").sessionId, SID);
    assert.equal(ownership.assertCanControl(authOf("client-A"), SID, "ws_eng").sessionId, SID);
  });

  it("local operator can observe AND control every recorded session", () => {
    assert.equal(ownership.assertCanAccess(undefined, SID, "ws_eng").sessionId, SID);
    assert.equal(ownership.assertCanControl(undefined, SID, "ws_eng").sessionId, SID);
    assert.equal(zcodeSessionClientId(undefined), "local");
  });

  it("another client can do neither: no oracle, same denial for unknown and foreign", () => {
    for (const check of ["assertCanAccess", "assertCanControl"] as const) {
      assert.throws(
        () => ownership[check](authOf("client-B"), SID, "ws_eng"),
        (err: ZcodeSessionOwnershipError) => err.code === "ZCODE_SESSION_NOT_OWNED",
      );
      // Unknown sessions produce the identical denial (no existence oracle).
      assert.throws(
        () => ownership[check](authOf("client-B"), "sess_55555555-5555-5555-5555-555555555555", "ws_eng"),
        (err: ZcodeSessionOwnershipError) => err.code === "ZCODE_SESSION_NOT_OWNED",
      );
    }
  });

  it("workspace mismatch stays a distinct denial", () => {
    assert.throws(
      () => ownership.assertCanControl(authOf("client-A"), SID, "ws_other"),
      (err: ZcodeSessionOwnershipError) => err.code === "ZCODE_SESSION_WORKSPACE_MISMATCH",
    );
  });

  it("explicit delegation grants CONTROL but not ownership transfer", () => {
    ownership.delegateControl(SID, "client-A", "client-B");
    assert.equal(ownership.assertCanControl(authOf("client-B"), SID, "ws_eng").sessionId, SID);
    // Live observe path stays owner-scoped: delegation is control, not read ownership.
    assert.throws(
      () => ownership.assertCanAccess(authOf("client-B"), SID, "ws_eng"),
      (err: ZcodeSessionOwnershipError) => err.code === "ZCODE_SESSION_NOT_OWNED",
    );
    ownership.revokeDelegation(SID, "client-A", "client-B");
    assert.throws(
      () => ownership.assertCanControl(authOf("client-B"), SID, "ws_eng"),
      (err: ZcodeSessionOwnershipError) => err.code === "ZCODE_SESSION_NOT_OWNED",
    );
  });

  it("revoking the owner's control capability blocks control (even for the owner) but not owner-scoped reads", () => {
    const ownership2 = loadZcodeSessionOwnership(dir);
    const record = ownership2.sessionRecord(SID)!;
    record.capabilities.control = false;
    writeFileSync(join(dir, "zcode-session-ownership.json"), JSON.stringify({ version: 2, sessions: [record] }));
    assert.doesNotThrow(() => ownership2.assertCanAccess(authOf("client-A"), SID, "ws_eng"));
    assert.throws(
      () => ownership2.assertCanControl(authOf("client-A"), SID, "ws_eng"),
      (err: ZcodeSessionOwnershipError) => err.code === "ZCODE_SESSION_CONTROL_DENIED",
    );
    // Local operator keeps operator override only while capability is not revoked policy-wide;
    // capability revocation binds every principal.
    assert.throws(
      () => ownership2.assertCanControl(undefined, SID, "ws_eng"),
      (err: ZcodeSessionOwnershipError) => err.code === "ZCODE_SESSION_CONTROL_DENIED",
    );
  });

  it("revoking the observe capability blocks assertCanObserve (owner and local operator) but leaves control intact", () => {
    const ownership2 = loadZcodeSessionOwnership(dir);
    const record = ownership2.sessionRecord(SID)!;
    record.capabilities.observe = false;
    writeFileSync(join(dir, "zcode-session-ownership.json"), JSON.stringify({ version: 2, sessions: [record] }));
    for (const auth of [authOf("client-A"), undefined]) {
      assert.throws(
        () => ownership2.assertCanObserve(auth, SID, "ws_eng"),
        (err: ZcodeSessionOwnershipError) => err.code === "ZCODE_SESSION_OBSERVE_DENIED",
      );
    }
    // A foreign client is still denied earlier, with the no-oracle denial.
    assert.throws(
      () => ownership2.assertCanObserve(authOf("client-B"), SID, "ws_eng"),
      (err: ZcodeSessionOwnershipError) => err.code === "ZCODE_SESSION_NOT_OWNED",
    );
    // The observe revocation does not cascade into control: the owner can still steer.
    assert.doesNotThrow(() => ownership2.assertCanControl(authOf("client-A"), SID, "ws_eng"));
    // Raw owner-scoped resolution (assertCanAccess) is unchanged for the owner.
    assert.doesNotThrow(() => ownership2.assertCanAccess(authOf("client-A"), SID, "ws_eng"));
  });

  it("assertCanObserve is fail-closed with no existence oracle, mirroring control denials", () => {
    for (const check of ["assertCanObserve", "assertCanControl"] as const) {
      assert.throws(
        () => ownership[check](authOf("client-B"), SID, "ws_eng"),
        (err: ZcodeSessionOwnershipError) => err.code === "ZCODE_SESSION_NOT_OWNED",
      );
      assert.throws(
        () => ownership[check](authOf("client-B"), "sess_66666666-6666-6666-6666-666666666666", "ws_eng"),
        (err: ZcodeSessionOwnershipError) => err.code === "ZCODE_SESSION_NOT_OWNED",
      );
    }
  });

  it("delegation survives restart (durable v2 record)", () => {
    ownership.delegateControl(SID, "client-A", "client-B");
    const reloaded = loadZcodeSessionOwnership(dir);
    assert.equal(reloaded.assertCanControl(authOf("client-B"), SID, "ws_eng").sessionId, SID);
  });
});
