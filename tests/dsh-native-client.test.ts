import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { DshNativeClient, DshNativeError } from "../src/execution/dsh-native-client.js";

/**
 * Honest degradation of the DSH native adapter transport. The DSH host is an
 * EXTERNAL dependency (DeepSeek Harness running the d2c session-controller
 * adapter on a loopback RPC endpoint): A2C never starts it and never fakes
 * health — every unavailability cause keeps code D2C_UNAVAILABLE while naming
 * the exact external dependency and the remediation, credential-free and
 * path-free.
 */

const TOKEN = "a".repeat(64);

function clientWith(readToken: () => string, fetchImpl: typeof fetch): DshNativeClient {
  return new DshNativeClient({ endpoint: "http://127.0.0.1:43190/rpc", readToken, fetchImpl });
}

describe("DSH native client: distinct, actionable unavailability causes", () => {
  it("missing credential names the provisioning dependency (host never started)", async () => {
    const client = clientWith(() => { throw new Error("ENOENT"); }, (() => {
      throw new Error("must not reach the network without a credential");
    }) as typeof fetch);
    await assert.rejects(() => client.health(), (err: DshNativeError) => {
      assert.equal(err.code, "D2C_UNAVAILABLE");
      assert.match(err.message, /credential is unavailable/);
      assert.match(err.message, /DSH host/);
      return true;
    });
  });

  it("malformed credential asks for re-provisioning and never echoes material", async () => {
    const material = "definitely-not-hex-token-material";
    const client = clientWith(() => material, (() => {
      throw new Error("must not reach the network with an invalid credential");
    }) as typeof fetch);
    await assert.rejects(() => client.health(), (err: DshNativeError) => {
      assert.equal(err.code, "D2C_UNAVAILABLE");
      assert.match(err.message, /credential is invalid/);
      assert.match(err.message, /re-provision/);
      assert.ok(!err.message.includes(material), "credential material must never leak into errors");
      return true;
    });
  });

  it("host not running: names the external DSH host as the dependency A2C cannot start", async () => {
    const fetchImpl = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    const client = clientWith(() => TOKEN, fetchImpl);
    await assert.rejects(() => client.health(), (err: DshNativeError) => {
      assert.equal(err.code, "D2C_UNAVAILABLE");
      assert.match(err.message, /unreachable/);
      assert.match(err.message, /DSH host/);
      assert.match(err.message, /A2C cannot start it/);
      return true;
    });
  });

  it("a reachable host with a wrong identity still fails closed as D2C_IDENTITY_MISMATCH", async () => {
    const response = new Response(JSON.stringify({
      ok: true,
      data: { adapter: "some-other-adapter", version: "0", generation: "g", hostPid: 1,
        dshVersion: "0", harnessVersion: "0", capabilities: {} },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const client = clientWith(() => TOKEN, (async () => response) as typeof fetch);
    await assert.rejects(() => client.health(), (err: DshNativeError) => {
      assert.equal(err.code, "D2C_IDENTITY_MISMATCH");
      return true;
    });
  });
});
