/** Narrow client for the locally evaluated Omnigent Sessions API. No admin API. */
export class OmnigentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OmnigentError";
  }
}

export const DEFAULT_OMNIGENT_URL = "http://127.0.0.1:6767";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;

export function protocolError(): OmnigentError {
  return new OmnigentError("OMNIGENT_PROTOCOL_ERROR", "Omnigent returned an unexpected or malformed response");
}

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw protocolError();
  return value as Record<string, unknown>;
}

/** Only opaque ids from the evaluated protocol; never URLs, paths or credentials. */
export function omnigentId(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[a-z]{1,16}_)?(?:[a-f0-9]{8,64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(value)) {
    throw protocolError();
  }
  return value;
}

export function loopbackUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
    return url.origin;
  } catch {
    throw new OmnigentError("OMNIGENT_CONFIG_INVALID", "Omnigent requires an HTTP loopback origin without credentials or a path");
  }
}

export interface OmnigentClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

export class OmnigentClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OmnigentClientOptions = {}) {
    this.baseUrl = loopbackUrl(options.baseUrl ?? process.env.C2C_OMNIGENT_URL ?? DEFAULT_OMNIGENT_URL);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = Math.max(10, Math.min(30_000, options.requestTimeoutMs ?? 10_000));
  }

  private async response(route: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    try {
      const response = await this.fetcher(`${this.baseUrl}/v1/${route}`, {
        ...init, signal, redirect: "error", credentials: "omit",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new OmnigentError("OMNIGENT_UNAVAILABLE", "Omnigent or its Codex runner is unavailable or refused the request");
      }
      return response;
    } catch (error) {
      if (error instanceof OmnigentError) throw error;
      // Never propagate fetch errors, server bodies, addresses or auth headers.
      throw new OmnigentError("OMNIGENT_UNAVAILABLE", "Omnigent could not be reached within the local request limit");
    }
  }

  private async json(route: string, body?: object | FormData): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const multipart = body instanceof FormData;
      const response = await this.response(route, {
        method: body ? "POST" : "GET",
        headers: { Accept: "application/json", ...(!multipart && body ? { "Content-Type": "application/json" } : {}) },
        body: multipart ? body : body ? JSON.stringify(body) : undefined,
      }, controller.signal);
      if (!/^application\/json\b/i.test(response.headers.get("content-type") ?? "") || !response.body) throw protocolError();
      if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) throw protocolError();
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw protocolError();
        chunks.push(chunk.value);
      }
      return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
    } catch (error) {
      if (error instanceof OmnigentError) throw error;
      if (controller.signal.aborted) throw new OmnigentError("OMNIGENT_UNAVAILABLE", "Omnigent exceeded the local request limit");
      throw protocolError();
    } finally {
      clearTimeout(timer);
      controller.abort();
      await reader?.cancel().catch(() => undefined);
    }
  }

  create(bundle: Uint8Array, metadata: object): Promise<Record<string, unknown>> {
    const form = new FormData();
    form.set("metadata", JSON.stringify(metadata));
    form.set("bundle", new Blob([new Uint8Array(bundle)], { type: "application/gzip" }), "c2c-codex.tar.gz");
    return this.json("sessions", form);
  }

  snapshot(id: string): Promise<Record<string, unknown>> {
    return this.json(`sessions/${omnigentId(id)}?include_items=false`);
  }

  items(id: string, after?: string): Promise<Record<string, unknown>> {
    return this.json(`sessions/${omnigentId(id)}/items?limit=200&order=asc${after ? `&after=${omnigentId(after)}` : ""}`);
  }

  async submit(id: string, instruction: string): Promise<string | undefined> {
    const ack = await this.json(`sessions/${omnigentId(id)}/events`, {
      type: "message", data: { role: "user", content: [{ type: "input_text", text: instruction }] },
    });
    if (ack.queued !== true || ack.denied !== undefined) throw protocolError();
    return ack.item_id === undefined ? undefined : omnigentId(ack.item_id);
  }

  async interrupt(id: string, hard = false): Promise<void> {
    const ack = await this.json(`sessions/${omnigentId(id)}/events`, {
      type: hard ? "stop_session" : "interrupt", data: {},
    });
    if (ack.queued !== false || Object.keys(ack).some((key) => key !== "queued")) throw protocolError();
  }

  /** Open before submission: this API has no SSE replay. */
  async stream(id: string, signal: AbortSignal): Promise<AsyncGenerator<Record<string, unknown>>> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    const timer = setTimeout(abort, this.timeoutMs);
    let response: Response;
    try {
      response = await this.response(`sessions/${omnigentId(id)}/stream`, {
        headers: { Accept: "text/event-stream" },
      }, controller.signal);
      if (!/^text\/event-stream\b/i.test(response.headers.get("content-type") ?? "") || !response.body) throw protocolError();
    } catch (error) {
      signal.removeEventListener("abort", abort);
      controller.abort();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const reader = response.body!.getReader();
    return (async function* () {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffer = "";
      let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) throw protocolError(); // EOF/idle is not successful completion.
          bytes += part.value.byteLength;
          if (bytes > MAX_STREAM_BYTES) throw protocolError();
          buffer += decoder.decode(part.value, { stream: true });
          if (buffer.length > MAX_RESPONSE_BYTES) throw protocolError();
          for (;;) {
            const separator = /\r?\n\r?\n/.exec(buffer);
            if (!separator) break;
            const frame = buffer.slice(0, separator.index);
            buffer = buffer.slice(separator.index + separator[0].length);
            const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
            if (!data) continue; // Heartbeats and SSE comments.
            if (data === "[DONE]") throw protocolError(); // Require a typed terminal event first.
            const event = object(JSON.parse(data));
            if (typeof event.type !== "string") throw protocolError();
            yield event;
          }
        }
      } catch (error) {
        if (error instanceof OmnigentError) throw error;
        throw protocolError();
      } finally {
        controller.abort();
        signal.removeEventListener("abort", abort);
        await reader.cancel().catch(() => undefined);
      }
    })();
  }
}
