/**
 * Public endpoint verification is deliberately separate from tunnel-process
 * readiness. cloudflared can register a connection while the DNS route or
 * origin is still wrong; only an unauthenticated bridge MCP response proves
 * that the public hostname reaches this bridge.
 */

export interface PublicProbeResult {
  ok: boolean;
  url: string;
  status: number | null;
  checkedAt: string;
  detail?: string;
}

export type PublicFetch = typeof fetch;

function mcpEndpoint(publicBaseUrl: string): string {
  const parsed = new URL(publicBaseUrl.trim());
  if (parsed.protocol !== "https:") {
    throw new Error("Public tunnel URL must use HTTPS");
  }
  parsed.pathname = parsed.pathname.replace(/\/mcp\/?$/i, "").replace(/\/+$/, "") + "/mcp";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A C2C public MCP endpoint must answer 401 without a bearer token. Treating
 * arbitrary 2xx/4xx responses as success would allow a Cloudflare error page,
 * another service, or a stale route to be reported as a working connector.
 */
export async function probePublicMcp(
  publicBaseUrl: string,
  timeoutMs = 8_000,
  fetchImpl: PublicFetch = fetch
): Promise<PublicProbeResult> {
  const endpoint = mcpEndpoint(publicBaseUrl);
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    const ok = response.status === 401;
    return {
      ok,
      url: endpoint,
      status: response.status,
      checkedAt,
      detail: ok
        ? "public MCP returned the expected unauthenticated 401"
        : `public MCP returned HTTP ${response.status}; expected 401`,
    };
  } catch (error) {
    return {
      ok: false,
      url: endpoint,
      status: null,
      checkedAt,
      detail: errorMessage(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Wait for DNS/edge propagation, while remaining strict about the response. */
export async function waitForPublicMcp(
  publicBaseUrl: string,
  opts: {
    timeoutMs?: number;
    attemptTimeoutMs?: number;
    intervalMs?: number;
    fetchImpl?: PublicFetch;
  } = {}
): Promise<PublicProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? 8_000;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let last = await probePublicMcp(
    publicBaseUrl,
    Math.min(attemptTimeoutMs, Math.max(1, timeoutMs)),
    opts.fetchImpl
  );
  while (last.ok === false && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(1, deadline - Date.now()))));
    const remaining = Math.max(1, deadline - Date.now());
    last = await probePublicMcp(publicBaseUrl, Math.min(attemptTimeoutMs, remaining), opts.fetchImpl);
  }
  return last;
}

