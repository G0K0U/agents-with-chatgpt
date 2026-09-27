import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ZcodeProtocol } from "../src/providers/zcode/protocol.js";

class FakeProc extends EventEmitter {
  written: unknown[] = [];
  write(msg: unknown): void {
    this.written.push(msg);
  }
}

describe("ZcodeProtocol", () => {
  it("correlates responses to requests", async () => {
    const proc = new FakeProc();
    const proto = new ZcodeProtocol(proc as never);
    const p = proto.request<{ hello: string }>("session/list", {}, 5000);
    const sent = proc.written.at(-1) as { id: number };
    proc.emit("message", { id: sent.id, result: { hello: "world" } });
    assert.deepEqual(await p, { hello: "world" });
  });

  it("rejects with ZcodeProtocolError on error responses", async () => {
    const proc = new FakeProc();
    const proto = new ZcodeProtocol(proc as never);
    const p = proto.request("session/stop", {}, 5000);
    const sent = proc.written.at(-1) as { id: number };
    proc.emit("message", { id: sent.id, error: { code: -32601, message: "Method not found" } });
    await assert.rejects(p, (e: unknown) => (e as { isMethodNotFound: boolean }).isMethodNotFound === true);
  });

  it("rejects pending requests when the child exits", async () => {
    const proc = new FakeProc();
    const proto = new ZcodeProtocol(proc as never);
    const p = proto.request("session/send", {}, 5000);
    proc.emit("exit", 1);
    await assert.rejects(p, /exited/);
  });

  it("times out requests", async () => {
    const proc = new FakeProc();
    const proto = new ZcodeProtocol(proc as never);
    await assert.rejects(proto.request("x/y", {}, 50), /timeout/);
  });

  it("answers runtime preferences and rejects other client requests (fail closed)", async () => {
    const proc = new FakeProc();
    const proto = new ZcodeProtocol(proc as never);
    proc.emit("message", { id: "server-1", method: "session/requestRuntimePreferences", params: {} });
    proc.emit("message", { id: "server-2", method: "interaction/requestAuth", params: {} });
    const answers = proc.written as Array<{ id: string; result?: unknown; error?: { code: number } }>;
    const pref = answers.find((w) => w.id === "server-1");
    assert.ok(pref?.result && typeof (pref.result as Record<string, unknown>).memoryEnabled === "boolean");
    const rej = answers.find((w) => w.id === "server-2");
    assert.equal(rej?.error?.code, -32601);
    assert.equal(proto.unanswerableClientRequests.length, 1);
  });

  it("records notifications and surfaces malformed messages", () => {
    const proc = new FakeProc();
    const proto = new ZcodeProtocol(proc as never);
    let malformed: string | null = null;
    proto.on("malformed", (l: string) => (malformed = l));
    proc.emit("message", { method: "state.updated", params: { a: 1 } });
    proc.emit("message", { method: "state.updated" }); // missing params? still notification
    proc.emit("message", "not-json-object");
    assert.equal(proto.notifications.length, 2);
    assert.equal(proto.notifications[0]!.method, "state.updated");
    assert.notEqual(malformed, null);
  });

  it("methodExists distinguishes method-not-found from invalid-params", async () => {
    const proc = new FakeProc();
    const proto = new ZcodeProtocol(proc as never);
    // simulate -32602 for present method: respond with error after request
    proc.on("write", () => {});
    const pPresent = proto.methodExists("session/create", {}, 1000);
    const sent = proc.written.at(-1) as { id: number };
    proc.emit("message", { id: sent.id, error: { code: -32602, message: "Invalid params" } });
    assert.equal(await pPresent, true);

    const pMissing = proto.methodExists("bogus/method", {}, 1000);
    const sent2 = proc.written.at(-1) as { id: number };
    proc.emit("message", { id: sent2.id, error: { code: -32601, message: "Method not found" } });
    assert.equal(await pMissing, false);
  });
});
