import test from "node:test";
import assert from "node:assert/strict";
import { DesktopTurnRouting } from "../scripts/desktop-turn-routing.mjs";

test("Desktop turn permissions are exclusive, bounded and never take credentials", () => {
  const router = new DesktopTurnRouting();
  const client = {}, other = {};
  const sessionId = "sess_00000000-0000-0000-0000-000000000001";
  const permission = { id: "server-1", method: "interaction/requestPermission", params: { sessionId } };
  assert.equal(router.route(permission, 1), undefined);
  assert.equal(router.claim(client, sessionId, 100, 1), true);
  assert.equal(router.claim(other, sessionId, 100, 2), false);
  assert.equal(router.route({ ...permission, method: "interaction/requestProviderRuntimeHeaders" }, 2), undefined);
  assert.equal(router.route(permission, 2), client);
  assert.equal(router.response(other, "server-1", 3), false);
  assert.equal(router.response(client, "server-1", 3), true);
  assert.equal(router.route(permission, 102), null);
  assert.equal(router.claim(other, sessionId, 100, 103), true);
  router.disconnect(other);
  assert.equal(router.route(permission, 104), null);
  assert.equal(router.claim(client, sessionId, 900001, 105), false);
  assert.equal(router.claim(client, sessionId, 100, 105), true);
  assert.equal(router.route(permission, 106), client);
  router.release(client, sessionId);
  assert.equal(router.response(client, "server-1", 107), false);
  assert.equal(router.route(permission, 107), null);
});
