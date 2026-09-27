/**
 * F04 regressions: the supervisor's raw HTTP liveness probe must settle
 * BOUNDEDLY for every peer behavior, using real loopback sockets:
 *   A. accept → close without an HTTP response  → bounded failure (never hangs)
 *   B. accept → partial status prefix → close   → bounded failure (never a
 *      false positive for an incomplete response)
 *   C. accept → stall forever                   → bounded failure via the
 *      independent total deadline (guards byte-trickle keepalives)
 * plus the happy paths and exactly-once settlement.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import net from "node:net";
import { createServer, type AddressInfo, type Server } from "node:http";
import { httpProbe } from "../src/supervisor/supervisor.js";

let servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
    server.closeAllConnections?.();
  }
});

function listenRaw(handler: (socket: net.Socket) => void): Promise<{ port: number; server: Server }> {
  return new Promise((resolve) => {
    const server = net.createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as AddressInfo).port, server }));
  });
}

function listenHttp(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<{ port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as AddressInfo).port }));
  });
}

/** Guard: the test itself fails if the probe is left pending. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  return Promise.race([
    promise.finally(() => { if (timer) clearTimeout(timer); }),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: probe did not settle within ${ms}ms`)), ms);
    }),
  ]);
}

describe("httpProbe terminal-event settlement (real loopback sockets)", () => {
  it("case A: peer accepts and closes with no response — settles as a bounded failure", async () => {
    const { port } = await listenRaw((socket) => { socket.end(); });
    const started = Date.now();
    const result = await withTimeout(httpProbe(`http://127.0.0.1:${port}/health`, 4_000), 8_000, "case A");
    expect(result).toEqual({ ok: false, status: 0 });
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("case B: incomplete HTTP prefix then close — fails, never a false positive", async () => {
    const { port } = await listenRaw((socket) => {
      socket.write("HTTP/1.1 20");
      socket.end();
    });
    const result = await withTimeout(httpProbe(`http://127.0.0.1:${port}/health`, 4_000), 8_000, "case B");
    expect(result).toEqual({ ok: false, status: 0 });
  });

  it("case C: peer accepts and stalls — the independent total deadline settles the probe", async () => {
    const { port } = await listenRaw((socket) => {
      // Hold the socket open and trickle a byte every 250ms so the socket's
      // IDLE timeout alone would never fire; only the total deadline ends it.
      socket.setNoDelay(true);
      const trickle = setInterval(() => { socket.write("x"); }, 250);
      socket.on("close", () => clearInterval(trickle));
      socket.on("error", () => clearInterval(trickle));
    });
    const started = Date.now();
    const result = await withTimeout(httpProbe(`http://127.0.0.1:${port}/health`, 1_200), 6_000, "case C");
    expect(result).toEqual({ ok: false, status: 0 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("settles from a complete status line and maps <500 to ok", async () => {
    const { port } = await listenHttp((_req, res) => {
      res.statusCode = 401;
      res.end("unauthorized");
    });
    const result = await withTimeout(httpProbe(`http://127.0.0.1:${port}/mcp`, 4_000), 8_000, "status line");
    expect(result).toEqual({ ok: true, status: 401 });
  });

  it("maps a 5xx status line to a failed probe without hanging", async () => {
    const { port } = await listenHttp((_req, res) => {
      res.statusCode = 503;
      res.end("nope");
    });
    const result = await withTimeout(httpProbe(`http://127.0.0.1:${port}/health`, 4_000), 8_000, "5xx");
    expect(result).toEqual({ ok: false, status: 503 });
  });

  it("connection refused settles immediately as a failure", async () => {
    // Port 1 on loopback is never listening in this environment; if it ever
    // is, the probe still settles (bounded) — the assertion is settlement.
    const result = await withTimeout(httpProbe("http://127.0.0.1:1/health", 2_000), 8_000, "refused");
    expect(result.ok).toBe(false);
  });

  it("resolves exactly once when error and close race", async () => {
    const { port } = await listenRaw((socket) => {
      socket.on("data", () => { socket.destroy(); });
    });
    const probe = httpProbe(`http://127.0.0.1:${port}/health`, 4_000);
    const settled = await withTimeout(probe, 8_000, "race");
    expect(settled.ok).toBe(false);
    // Let the total-deadline window elapse: no unhandled rejection or second
    // settlement may surface.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
