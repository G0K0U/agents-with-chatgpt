#!/usr/bin/env node
/**
 * Z2C Desktop Agent Proxy.
 *
 * Spawned by ZCode Desktop in place of the bundled agent when the Desktop is
 * launched with:
 *   ZCODE_AGENT_SERVER_COMMAND = <node.exe>
 *   ZCODE_AGENT_SERVER_ARGS_JSON = ["<this file>", "--stdio"]
 *
 * Responsibilities:
 *  1. Spawn the REAL bundled `zcode app-server --stdio --surface desktop` child
 *     with the same cwd (workspace) so the Desktop host can drive it and mint
 *     its model auth exactly as it does for its own agents.
 *  2. Relay Desktop<->agent stdio bytes unchanged (pure transparency; the
 *     Desktop must not be able to tell the difference).
 *  3. Expose a SECOND localhost-only TCP control channel so Z2C can act as an
 *     additional protocol client on the same agent (multiplexed by request id:
 *     ids prefixed "z2c" are routed to Z2C, everything else stays with the
 *     Desktop; notifications without ids fan out to both).
 *
 * Security:
 *  - The control channel binds 127.0.0.1 and requires a per-instance random
 *    token, published only in a machine-local state file under
 *    %LOCALAPPDATA%\z2c\desktop-agents\.
 *  - The proxy never writes protocol payloads to disk or logs; only lifecycle
 *    events (spawn/exit/port) are logged.
 *  - If anything fails, the proxy degrades to a pure relay so the Desktop's
 *    own agent functionality is never broken by Z2C.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdirSync, appendFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { resolveCanonicalProfile, buildDesktopChildEnv } from "./desktop-profile.mjs";

const CANONICAL_PROFILE = resolveCanonicalProfile();
const DEFAULT_CLI = join(
  CANONICAL_PROFILE,
  "AppData",
  "Local",
  "Programs",
  "ZCode",
  "resources",
  "glm",
  "zcode.cjs",
);
const CLI = process.env.Z2C_ZCODE_CLI || DEFAULT_CLI;
const WORKSPACE = process.cwd();
const STATE_DIR =
  process.env.Z2C_STATE_DIR || join(process.env.LOCALAPPDATA || join(CANONICAL_PROFILE, "AppData", "Local"), "z2c");
const AGENT_DIR = join(STATE_DIR, "desktop-agents");
const workspaceHash = createHash("sha1").update(WORKSPACE.toLowerCase()).digest("hex").slice(0, 16);
const STATE_FILE = join(AGENT_DIR, `agent-${workspaceHash}.json`);
const LOG_FILE = join(AGENT_DIR, `agent-${workspaceHash}.log`);

function log(event, fields = {}) {
  try {
    mkdirSync(AGENT_DIR, { recursive: true });
    appendFileSync(
      LOG_FILE,
      JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + "\n",
    );
  } catch {
    /* lifecycle logging must never break the agent */
  }
}

function writeStateFile(value) {
  mkdirSync(AGENT_DIR, { recursive: true });
  // Atomic replacement requires the temporary file to live in the SAME
  // directory as the final destination: rename() across volumes (e.g.
  // os.tmpdir() on D: vs. the state dir on C:) fails with EXDEV and would
  // crash the proxy into a Desktop agent restart loop.
  const tmp = join(AGENT_DIR, `.${basename(STATE_FILE)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, STATE_FILE);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}

/** Parse one JSON line enough to route it: returns {id, isZ2cId} or null. */
function routeInfo(line) {
  try {
    const msg = JSON.parse(line);
    if (typeof msg?.id === "string") return { id: msg.id, z2c: msg.id.startsWith("z2c") };
    if (typeof msg?.id === "number") return { id: String(msg.id), z2c: false };
    return { id: null, z2c: false };
  } catch {
    return null;
  }
}

class FrameSplitter {
  constructor(onLine) {
    this.buffer = "";
    this.onLine = onLine;
  }
  push(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.onLine(line);
    }
  }
}

// ── Spawn the real agent child ────────────────────────────────────────────────
log("proxy.start", { pid: process.pid, workspace: WORKSPACE, cli: CLI });
const child = spawn(process.execPath, [CLI, "app-server", "--stdio", "--surface", "desktop"], {
  cwd: WORKSPACE,
  stdio: ["pipe", "pipe", "pipe"],
  env: buildDesktopChildEnv(CANONICAL_PROFILE),
  windowsHide: true,
});
log("child.spawn", { pid: child.pid });
child.on("exit", (code) => {
  log("child.exit", { code });
  try { if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE); } catch {}
  process.exit(code ?? 0);
});

// Desktop side of stdio. The Desktop speaks first only via the child's stdout.
const desktopOut = new FrameSplitter((line) => {
  // Desktop → child: forward unchanged (its requests carry ids like "server-N").
  child.stdin.write(line + "\n");
});
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => desktopOut.push(chunk));
process.stdin.on("end", () => child.stdin.end());

// Child → Desktop + Z2C fans.
const z2cClients = new Set(); // {socket, pendingIds:Set<string>}
function childLineRouter(line) {
  const info = routeInfo(line);
  let routedToZ2c = false;
  if (info) {
    if (info.id && info.z2c) {
      for (const c of z2cClients) {
        if (c.pendingIds.has(info.id)) {
          c.socket.write(line + "\n");
          c.pendingIds.delete(info.id);
          routedToZ2c = true;
        }
      }
    } else if (!info.id) {
      // notification: fan out to Desktop and any Z2C clients
      for (const c of z2cClients) c.socket.write(line + "\n");
    }
  }
  if (!routedToZ2c) process.stdout.write(line + "\n");
}
const childOut = new FrameSplitter((line) => {
  try { childLineRouter(line); } catch { process.stdout.write(line + "\n"); }
});
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => childOut.push(chunk));
child.stderr.setEncoding("utf8");
child.stderr.on("data", () => { /* discarded; never logged */ });

// ── Localhost control channel for Z2C ────────────────────────────────────────
const TOKEN = randomBytes(24).toString("hex");
let server = null;
let boundPort = null;
try {
  server = createServer((socket) => {
    const client = { socket, pendingIds: new Set(), authed: false };
    let authBuffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("close", () => z2cClients.delete(client));
    socket.on("data", (chunk) => {
      if (!client.authed) {
        authBuffer += chunk;
        const nl = authBuffer.indexOf("\n");
        if (nl < 0) return;
        const firstLine = authBuffer.slice(0, nl).trim();
        authBuffer = authBuffer.slice(nl + 1);
        const ok =
          Buffer.from(firstLine).length === Buffer.from(TOKEN).length &&
          timingSafeEqual(Buffer.from(firstLine), Buffer.from(TOKEN));
        if (!ok) {
          socket.write(JSON.stringify({ error: { code: -32000, message: "unauthorized" } }) + "\n");
          socket.destroy();
          return;
        }
        client.authed = true;
        z2cClients.add(client);
        if (authBuffer) socket.emit("data", authBuffer);
        return;
      }
      // Split frames; register z2c ids then forward unchanged to the child.
      const splitter = (client._splitter ??= new FrameSplitter((line) => {
        const info = routeInfo(line);
        if (info?.id && info.z2c) client.pendingIds.add(info.id);
        child.stdin.write(line + "\n");
      }));
      splitter.push(chunk);
    });
  });
  server.on("error", (err) => {
    log("control.server_error", { error: String(err && err.message).slice(0, 120) });
    server = null;
  });
  server.listen(0, "127.0.0.1", () => {
    boundPort = server.address().port;
    log("control.listening", { port: boundPort });
    publishState();
  });
} catch (err) {
  log("control.init_failed", { error: String(err && err.message).slice(0, 120) });
}

function publishState() {
  if (boundPort == null) return;
  try {
    writeStateFile({
      port: boundPort,
      token: TOKEN,
      pid: process.pid,
      workspace: WORKSPACE,
      zcodeCli: CLI,
      startedAt: Date.now(),
    });
  } catch (err) {
    // The registration file only enables Z2C discovery; a failed publish must
    // degrade to pure relay (documented fallback) instead of crashing the
    // agent and triggering a Desktop restart loop.
    log("control.publish_failed", { error: String(err && err.message).slice(0, 160) });
  }
}

process.on("exit", () => {
  try { if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE); } catch {}
});
process.on("SIGTERM", () => child.kill());
process.on("SIGINT", () => child.kill());

// Keep the relay alive even if the control channel dies: the child's stdio
// remains wired above regardless of server state.
