import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { writeSecureJson } from "../config/paths.js";
import { acquireStateLock } from "./orchestrator-core.js";

const id = z.string().regex(/^[A-Za-z0-9_:-]{1,180}$/);
const eventSchema = z.object({ run_id: id, task_id: id, audit_id: id }).strict();
export type WakeEvent = z.infer<typeof eventSchema>;
export type WakeStatus = "wake_requested" | "wake_submitted" | "wake_failed";

/** Read only the explicitly selected workspace and owner. Never writes orchestrator state. */
export function pendingWakes(stateDir: string, workspace: string, owner: string): WakeEvent[] {
  return scanPendingWakes(stateDir, workspace, owner);
}

/**
 * Owner-agnostic pending wake events for the loopback sidecar: the browser
 * extension serves the human's configured ChatGPT conversation, so a waiting
 * audit from ANY principal's run in this workspace must wake it. Read-only.
 */
export function pendingWakeEvents(stateDir: string, workspace: string): WakeEvent[] {
  return scanPendingWakes(stateDir, workspace, undefined);
}

function scanPendingWakes(stateDir: string, workspace: string, owner?: string): WakeEvent[] {
  z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).parse(workspace);
  const dir = path.join(stateDir, "orchestrator", workspace);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^[A-Za-z0-9_-]+\.json$/.test(f)).flatMap(file => {
    const run = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    if (run.version !== 1 || run.workspaceId !== workspace || (owner !== undefined && run.ownerId !== owner)
      || run.state !== "WAITING_AUDIT" || run.paused || run.runId !== file.slice(0, -5)) return [];
    return run.audits.filter((a: any) => a.type === "audit.required" && !a.verdict && a.taskId === run.taskId)
      .map((a: any) => eventSchema.parse({ run_id: run.runId, task_id: a.taskId, audit_id: a.id }));
  });
}

export function localWakeSecret(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "credential.json");
  try { fs.writeFileSync(file, JSON.stringify({ secret: randomBytes(32).toString("hex") }), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return z.string().regex(/^[a-f0-9]{64}$/).parse(JSON.parse(fs.readFileSync(file, "utf8")).secret);
}

/**
 * A wake reservation is not forever: an extension that requested an event but
 * never acknowledged it (crashed browser, closed tab, lost network) must not
 * wedge the event permanently. After REOFFER_MS the reservation expires and
 * the event is offered again with a refreshed durable reservation; the
 * extension re-delivering to the same configured conversation is idempotent,
 * while a genuinely delivered wake acks and leaves the terminal state.
 */
const WAKE_REOFFER_MS = 10 * 60_000;

interface WakeReceipt { status: WakeStatus; at: number }

/** Dedicated listener: never mount on the public MCP/bridge server. */
export async function startChatWake(options: {
  dir: string; secret: string; pending: () => WakeEvent[]; port?: number;
  /** Injectable clock + reoffer window for tests. */
  now?: () => number; reofferMs?: number;
}) {
  const now = options.now ?? Date.now;
  const reofferMs = options.reofferMs ?? WAKE_REOFFER_MS;
  fs.mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  const unlock = acquireStateLock(path.join(options.dir, "service.lock"));
  const receiptFile = path.join(options.dir, "receipts.json");
  const receipts: Record<string, WakeReceipt> = {};
  if (fs.existsSync(receiptFile)) {
    const raw = JSON.parse(fs.readFileSync(receiptFile, "utf8")) as Record<string, unknown>;
    // Legacy shape (bare status strings) is normalized; bare wake_requested
    // reservations have no timestamp and are immediately re-offerable.
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string") receipts[k] = { status: v as WakeStatus, at: 0 };
      else if (v && typeof v === "object" && typeof (v as WakeReceipt).status === "string") {
        receipts[k] = { status: (v as WakeReceipt).status, at: typeof (v as WakeReceipt).at === "number" ? (v as WakeReceipt).at : 0 };
      }
    }
  }
  const key = (event: WakeEvent) => JSON.stringify(event);
  const save = () => writeSecureJson(receiptFile, receipts, { durable: true });
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const reply = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    try {
      if (req.headers.host !== `127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`) return reply(403, {});
      const supplied = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${options.secret}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(401, {});
      // No CORS: web pages cannot access this service. Extension host permission is required.
      if (req.method === "POST" && req.url === "/wake/next") {
        const expired = (r: WakeReceipt | undefined) =>
          !r || (r.status === "wake_requested" && now() - r.at > reofferMs);
        const event = options.pending().map(e => eventSchema.parse(e)).find(e => expired(receipts[key(e)]));
        if (!event) return reply(200, { event: null });
        // Durable (re-)reservation before browser side effects.
        receipts[key(event)] = { status: "wake_requested", at: now() }; save();
        return reply(200, { event });
      }
      if (req.method === "POST" && req.url === "/wake/ack") {
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 2048) return reply(413, {}); }
        const ack = z.object({ event: eventSchema, status: z.enum(["wake_submitted", "wake_failed"]) }).strict().parse(JSON.parse(body));
        const previous = receipts[key(ack.event)];
        if (!previous || (previous.status !== "wake_requested" && previous.status !== ack.status)) return reply(409, {});
        receipts[key(ack.event)] = { status: ack.status, at: now() }; save();
        return reply(200, { status: ack.status });
      }
      reply(404, {});
    } catch { reply(400, { error: "Wake request rejected" }); }
  });
  server.requestTimeout = 5000;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 47831, "127.0.0.1", resolve); });
  } catch (error) { unlock(); throw error; }
  return { port: (server.address() as import("node:net").AddressInfo).port,
    close: () => new Promise<void>((resolve, reject) => server.close(error => { unlock(); error ? reject(error) : resolve(); })) };
}
