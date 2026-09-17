/**
 * Typed request-correlation layer for the ZCode Protocol.
 *
 * Wire shape (verified against ZCode 0.16.5, zod-validated):
 *   request:  { id: string|number, method: string, params: object }
 *   response: { id, result } | { id, error: { code, message, data? } }
 *   server→client requests also arrive as { id: "server-N", method, params }
 *   and MUST be answered or the server times out (15 s default).
 *   Notifications are { method, params } with no id.
 */
import { EventEmitter } from "node:events";
import { newRequestId } from "../../util/ids.js";
import type { ZcodeProcess } from "./process.js";

export interface ProtocolErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export class ZcodeProtocolError extends Error {
  constructor(public readonly error: ProtocolErrorShape) {
    super(`ZCode Protocol error ${error.code}: ${error.message}`);
    this.name = "ZcodeProtocolError";
  }
  get isMethodNotFound(): boolean {
    return this.error.code === -32601;
  }
  get isInvalidParams(): boolean {
    return this.error.code === -32602;
  }
}

export interface NotificationRecord {
  method: string;
  params: unknown;
  receivedAt: number;
}

export type ClientRequestPolicy = "answer" | "reject";

const RUNTIME_PREFERENCES_DEFAULTS = {
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
};

export interface ProtocolTransport {
  write(message: unknown): void;
  on(event: "message", listener: (msg: unknown) => void): unknown;
  on(event: "malformed", listener: (line: string) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
}

export class ZcodeProtocol extends EventEmitter {
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }
  >();
  private nextId = 1;
  readonly notifications: NotificationRecord[] = [];
  readonly unanswerableClientRequests: Array<{ id: string; method: string }> = [];

  constructor(private readonly process: ProtocolTransport) {
    super();
    process.on("message", (msg: unknown) => this.onMessage(msg));
    process.on("malformed", (line: string) => this.emit("malformed", line));
    process.on("exit", (code: number | null) => this.onExit(code));
  }

  private onExit(code: number | null): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`app-server exited (code=${code}) while request in flight`));
    }
    this.pending.clear();
    this.emit("exit", code);
  }

  private onMessage(msg: unknown): void {
    if (typeof msg !== "object" || msg === null) {
      this.emit("malformed", JSON.stringify(msg));
      return;
    }
    const m = msg as Record<string, unknown>;
    const id = m.id;
    const hasId = id !== undefined && id !== null;

    if (hasId && (m.result !== undefined || m.error !== undefined)) {
      // Response to one of our requests
      const key = String(id);
      const p = this.pending.get(key);
      if (!p) {
        this.emit("uncorrelated", msg);
        return;
      }
      this.pending.delete(key);
      clearTimeout(p.timer);
      if (m.error !== undefined) p.reject(new ZcodeProtocolError(m.error as ProtocolErrorShape));
      else p.resolve(m.result);
      return;
    }

    if (hasId && typeof m.method === "string") {
      // Server→client requests. Answer only what the bridge can answer safely:
      //  - session/requestRuntimePreferences: static safe defaults.
      //  - interaction/requestProviderRuntimeHeaders: confirms that provider auth
      //    headers are managed (ours come from the child's own env var); the
      //    bridge never supplies or relays credentials.
      // Everything else is rejected (fail closed) and recorded.
      if (m.method === "session/requestRuntimePreferences") {
        this.process.write({ id, result: RUNTIME_PREFERENCES_DEFAULTS });
        return;
      }
      if (m.method === "interaction/requestProviderRuntimeHeaders") {
        this.process.write({ id, result: { headersApplied: true } });
        return;
      }
      this.unanswerableClientRequests.push({ id: String(id), method: m.method });
      this.process.write({
        id,
        error: { code: -32601, message: `Z2C does not support client request: ${m.method}` },
      });
      this.emit("client-request-rejected", m.method);
      return;
    }

    if (typeof m.method === "string") {
      const rec: NotificationRecord = { method: m.method, params: m.params, receivedAt: Date.now() };
      this.notifications.push(rec);
      if (this.notifications.length > 5000) this.notifications.splice(0, 1000);
      this.emit("notification", rec);
      return;
    }

    this.emit("malformed", JSON.stringify(msg).slice(0, 400));
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    // Ids live in the "z2c" namespace: the desktop-agent proxy routes responses
    // by id prefix (desktop host uses "server-N").
    const key = `z2c-${this.nextId++}`;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(key, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
    });
    this.process.write({ id: key, method, params });
    return promise;
  }

  /** Probe whether a method exists without executing anything meaningful. */
  async methodExists(method: string, probeParams: unknown, timeoutMs: number): Promise<boolean> {
    try {
      await this.request(method, probeParams, timeoutMs);
      return true; // unexpectedly succeeded — still exists
    } catch (err) {
      if (err instanceof ZcodeProtocolError && err.isMethodNotFound) return false;
      // -32602 invalid params etc. prove the method is dispatched
      return true;
    }
  }
}

export function nextInputId(prefix = "z2c"): string {
  return `${prefix}-${newRequestId()}`;
}
