export const TUNNEL_PROTOCOLS = ["auto", "quic", "http2"] as const;
export type TunnelProtocol = (typeof TUNNEL_PROTOCOLS)[number];

export function resolveTunnelProtocol(env: NodeJS.ProcessEnv = process.env): TunnelProtocol | null {
  const raw = env.C2C_TUNNEL_PROTOCOL ?? env.A2C_TUNNEL_PROTOCOL;
  if (!raw || raw.trim() === "") {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "auto" || normalized === "quic" || normalized === "http2") {
    return normalized;
  }
  throw new Error("Invalid tunnel protocol: C2C_TUNNEL_PROTOCOL must be one of auto, quic, http2");
}

export function tunnelProtocolArgs(protocol: TunnelProtocol | null): string[] {
  if (protocol === null) {
    return [];
  }
  return ["--protocol", protocol];
}
