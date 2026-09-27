import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { DesktopZCodeProvider } from "../src/providers/zcode/desktop.js";
import { loadConfig } from "../src/config.js";

const PROXY = join(process.cwd(), "scripts", "desktop-agent-proxy.mjs");
const FAKE_AGENT = join(process.cwd(), "test", "fixtures", "fake-agent.mjs");

interface Harness {
  proc: ChildProcess;
  stateDir: string;
  workspace: string;
  port: number;
  token: string;
  childStdin: NodeJS.WritableStream;
  desktopOut: EventEmitter;
}

async function startProxy(into?: { stateDir?: string; workspace?: string }): Promise<Harness> {
  const stateDir = into?.stateDir ?? mkdtempSync(join(tmpdir(), "z2c-dsk-"));
  const workspace = into?.workspace ?? mkdtempSync(join(tmpdir(), "z2c-ws-"));
  const proc = spawn(process.execPath, [PROXY, "--stdio"], {
    cwd: workspace,
    env: {
      ...process.env,
      Z2C_STATE_DIR: stateDir,
      Z2C_ZCODE_CLI: FAKE_AGENT,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const desktopOut = new EventEmitter();
  let buf = "";
  proc.stdout!.setEncoding("utf8");
  proc.stdout!.on("data", (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) desktopOut.emit("line", line);
    }
  });
  proc.stderr!.on("data", () => {});

  // wait for registration state file
  const agentDir = join(stateDir, "desktop-agents");
  let reg: { port: number; token: string; pid: number; workspace: string } | null = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const files = (await import("node:fs")).readdirSync(agentDir).filter((f) => f.startsWith("agent-") && f.endsWith(".json"));
      if (files.length === 1) {
        reg = JSON.parse(readFileSync(join(agentDir, files[0]!), "utf8"));
        break;
      }
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(reg, "proxy did not publish registration");
  assert.equal(reg.workspace, workspace);
  return { proc, stateDir, workspace, port: reg.port, token: reg.token, childStdin: proc.stdin!, desktopOut };
}

function connectZ2c(port: number, token: string): Promise<{
  socket: ReturnType<typeof createConnection>;
  events: EventEmitter;
}> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.write(token + "\n");
      resolve({ socket, events: wire(socket) });
    });
    socket.once("error", reject);
  });
}

function wire(socket: ReturnType<typeof createConnection>): EventEmitter {
  const events = new EventEmitter();
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { events.emit("message", JSON.parse(line)); } catch { events.emit("malformed", line); }
    }
  });
  return events;
}

describe("desktop-agent-proxy multiplexer", () => {
  let h: Harness;
  before(async () => { h = await startProxy(); });
  after(async () => {
    h.proc.kill();
    await new Promise((r) => setTimeout(r, 300));
    rmSync(h.stateDir, { recursive: true, force: true });
    rmSync(h.workspace, { recursive: true, force: true });
  });

  it("publishes a registration state file", () => {
    const agentDir = join(h.stateDir, "desktop-agents");
    assert.ok(existsSync(agentDir));
  });

  it("rejects a wrong token and closes the connection", async () => {
    const { socket, events } = await connectZ2c(h.port, "wrong-token");
    const err = await new Promise<any>((resolve) => events.once("message", resolve));
    assert.match(JSON.stringify(err), /unauthorized/);
    socket.destroy();
  });

  it("routes z2c requests to the child and responses back to the z2c client", async () => {
    const { socket, events } = await connectZ2c(h.port, h.token);
    const p = new Promise<any>((resolve) => events.once("message", resolve));
    socket.write(JSON.stringify({ id: "z2c-1", method: "session/list", params: { x: 1 } }) + "\n");
    const resp = await p;
    assert.equal(resp.id, "z2c-1");
    assert.ok(Array.isArray(resp.result?.sessions), "session/list result routed back to z2c client");
    socket.destroy();
  });

  it("fans notifications out to z2c while keeping the desktop pipe working", async () => {
    const { socket, events } = await connectZ2c(h.port, h.token);
    const notif = new Promise<any>((resolve) => events.once("message", resolve));
    // desktop sends a request that the fake child answers, then triggers a notification
    const desktopResp = new Promise<string>((resolve) => h.desktopOut.once("line", resolve));
    h.childStdin.write(JSON.stringify({ id: "server-1", method: "session/stop", params: { sessionId: "sess_x" } }) + "\n");
    const dl = await desktopResp;
    assert.match(dl, /"id":"server-1"/);
    h.childStdin.write(JSON.stringify({ method: "fake/notify", params: { hello: 1 } }) + "\n");
    const n = await notif;
    assert.equal(n.method, "state.updated");
    socket.destroy();
  });

  it("routes desktop (server-N) traffic to the desktop pipe, not to z2c", async () => {
    const { socket, events } = await connectZ2c(h.port, h.token);
    let gotMessage = false;
    events.on("message", () => { gotMessage = true; });
    const desktopResp = new Promise<string>((resolve) => h.desktopOut.once("line", resolve));
    h.childStdin.write(JSON.stringify({ id: "server-2", method: "workspace/readState", params: { a: 1 } }) + "\n");
    const dl = await desktopResp;
    assert.match(dl, /"id":"server-2"/);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(gotMessage, false, "z2c client must not receive desktop-routed responses");
    socket.destroy();
  });
});

describe("DesktopZCodeProvider over proxy", () => {
  let h: Harness;
  before(async () => { h = await startProxy(); });
  after(async () => {
    h.proc.kill();
    await new Promise((r) => setTimeout(r, 300));
    rmSync(h.stateDir, { recursive: true, force: true });
    rmSync(h.workspace, { recursive: true, force: true });
  });

  function makeProvider(): DesktopZCodeProvider {
    const cfg = { ...loadConfig(), stateDir: h.stateDir };
    return new DesktopZCodeProvider(cfg as never);
  }

  it("detects availability by workspace key", () => {
    const p = makeProvider();
    assert.equal(p.isDesktopAgentAvailable(h.workspace.toUpperCase()), true);
    assert.equal(p.isDesktopAgentAvailable("F:\\elsewhere"), false);
  });

  it("start() succeeds when a desktop agent exists", async () => {
    const p = makeProvider();
    await p.start();
    assert.equal(p.status, "healthy");
    await p.stop();
  });

  it("start() fails closed when no desktop agent exists", async () => {
    const p = makeProvider();
    const cfg = { ...loadConfig(), stateDir: mkdtempSync(join(tmpdir(), "z2c-empty-")) };
    const p2 = new DesktopZCodeProvider(cfg as never);
    await assert.rejects(p2.start(), /no Desktop-spawned agent/);
  });

  it("createSession returns a sess_ id and send/output round-trip works", async () => {
    const p = makeProvider();
    await p.start();
    const ws = { workspacePath: h.workspace, workspaceKey: h.workspace };
    const sessionId = await p.createSession(ws);
    assert.match(sessionId, /^sess_/);
    const handle = await p.send({ sessionId, instruction: "hello", inputId: "t1", timeoutMs: 5000 });
    assert.equal(handle.sessionId, sessionId);
    const result = await handle.completion;
    assert.equal(result.status, "completed");
    const output = await p.readAssistantOutput(sessionId, 1000);
    assert.match(output, /FAKE_OK:hello/);
    await p.stop();
  });

  it("readSessionBinding observes the exact session via session/read and proves workspace association", async () => {
    const p = makeProvider();
    await p.start();
    const ws = { workspacePath: h.workspace, workspaceKey: h.workspace };
    const sessionId = await p.createSession(ws);
    const binding = await p.readSessionBinding(sessionId, ws);
    assert.deepEqual(binding, {
      provider_id: "builtin:zai-coding-plan",
      model_id: "GLM-5.3",
      source: "desktop-session-read",
    });
    // A session whose workspace association does not match stays unknown.
    assert.equal(
      await p.readSessionBinding(sessionId, { workspacePath: "F:\\elsewhere", workspaceKey: "F:\\elsewhere" }),
      null,
    );
    // A non-resident session cannot be read: the exact-session read fails.
    await assert.rejects(
      p.readSessionBinding("sess_00000000-0000-0000-0000-000000000000", ws),
      /not active/,
    );
    await p.stop();
  });

  it("updateSessionModel switches model and thought level on the SAME session and re-observes the binding", async () => {
    const p = makeProvider();
    await p.start();
    try {
      const ws = { workspacePath: h.workspace, workspaceKey: h.workspace };
      const sessionId = await p.createSession(ws);
      const result = await p.updateSessionModel!(ws, sessionId, { modelId: "GLM-5.3-Flash", thoughtLevel: "max" });
      // Same native session id preserved; binding re-observed from the session itself.
      assert.equal(result.model_id, "GLM-5.3-Flash");
      assert.equal(result.provider_id, "builtin:zai-coding-plan");
      assert.equal(result.thoughtLevel, "max");
      const binding = await p.readSessionBinding(sessionId, ws);
      assert.equal(binding?.model_id, "GLM-5.3-Flash");
    } finally { await p.stop(); }
  });

  it("updateSessionModel fails closed on an unsupported model and leaves the session unchanged", async () => {
    const p = makeProvider();
    await p.start();
    try {
      const ws = { workspacePath: h.workspace, workspaceKey: h.workspace };
      const sessionId = await p.createSession(ws);
      await assert.rejects(
        p.updateSessionModel!(ws, sessionId, { modelId: "not-a-model" }),
        /Unsupported model/,
      );
      const binding = await p.readSessionBinding(sessionId, ws);
      assert.equal(binding?.model_id, "GLM-5.3");
    } finally { await p.stop(); }
  });

  it("uses the Desktop-registered key for a canonicalized filesystem path without pushing model credentials", async () => {
    const p = makeProvider();
    await p.start();
    try {
      const ws = { workspacePath: h.workspace.toLowerCase(), workspaceKey: h.workspace.toLowerCase() };
      const sessionId = await p.createSession(ws);
      const binding = await p.readSessionBinding(sessionId, ws);
      assert.equal(binding?.provider_id, "builtin:zai-coding-plan");
      assert.equal(binding?.model_id, "GLM-5.3");
      assert.equal((await p.listSessions(ws)).find(s => s.sessionId === sessionId)?.workspacePath, h.workspace);
      await p.resumeSession(ws, sessionId);
      await assert.rejects(p.createSession({ ...ws, workspacePath: join(h.workspace, "other") }), /does not match/);
      assert.equal(await p.readSessionBinding(sessionId, { ...ws, workspacePath: join(h.workspace, "other") }), null);
    } finally { await p.stop(); }
  });

  it("stopSession issues session/stop over the mux", async () => {
    const p = makeProvider();
    await p.start();
    const ws = { workspacePath: h.workspace, workspaceKey: h.workspace };
    const sessionId = await p.createSession(ws);
    await p.stopSession(sessionId); // must not throw
    await p.stop();
  });

  it("reattaches to a freshly registered agent after the connected one dies", async () => {
    const p = makeProvider();
    await p.start();
    const ws = { workspacePath: h.workspace, workspaceKey: h.workspace };
    await p.createSession(ws);
    assert.equal(p.status, "healthy");

    // The desktop agent dies mid-connection (proxy process killed hard, so its
    // exit unlink does not run — exactly the stale-registration case).
    h.proc.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(p.isDesktopAgentAvailable(h.workspace), false);

    // A fresh agent (restart) re-registers for the SAME workspace and must
    // supersede the dead registration without a Z2C process restart.
    const h2 = await startProxy({ stateDir: h.stateDir, workspace: h.workspace });
    try {
      // The registration wait in startProxy can race with the stale file left
      // by the killed proxy, so require the file to carry the NEW proxy pid.
      const regFile = join(h.stateDir, "desktop-agents", `agent-${
        createHash("sha1").update(h.workspace.toLowerCase()).digest("hex").slice(0, 16)
      }.json`);
      const deadline = Date.now() + 15000;
      let fresh: { pid: number; port: number } | null = null;
      while (Date.now() < deadline) {
        try {
          const reg = JSON.parse(readFileSync(regFile, "utf8")) as { pid: number; port: number };
          if (reg.pid === h2.proc!.pid) { fresh = reg; break; }
        } catch { /* not yet */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(fresh, "fresh proxy did not republish its registration");
      assert.notEqual(fresh.port, h.port, "fresh agent must publish a new control port");
      assert.equal(p.status, "unreachable");
      const sessionId = await p.createSession(ws);
      assert.match(sessionId, /^sess_/);
      assert.equal(p.status, "healthy");
    } finally {
      h2.proc.kill();
      await new Promise((r) => setTimeout(r, 300));
    }
    await p.stop();
  });
});
