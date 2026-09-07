/**
 * Tunnel abstraction. Business logic never talks to a specific vendor;
 * it only sees this interface. V1 ships a Cloudflare Quick Tunnel provider,
 * but ngrok / Tailscale / custom providers can be added without touching
 * the bridge.
 */
export interface TunnelStatus {
  running: boolean;
  url: string | null;
  provider: string;
  detail?: string;
  /** The origin port that the provider most recently reconciled. */
  originPort?: number | null;
  /** Fixed public hostname for named providers. */
  hostname?: string | null;
  /** Cloudflare tunnel UUID, when the provider is named. */
  tunnelId?: string | null;
  /** Machine-local, bridge-owned ingress configuration. */
  configFile?: string | null;
  /** Exact executable and argv used to launch the provider, without secrets. */
  executable?: string | null;
  argv?: string[];
}

export interface TunnelDoctorReport {
  provider: string;
  binaryFound: boolean;
  binaryPath: string | null;
  running: boolean;
  url: string | null;
  problems: string[];
  originPort?: number | null;
  hostname?: string | null;
  tunnelId?: string | null;
  configFile?: string | null;
  executable?: string | null;
  argv?: string[];
}

export interface TunnelProvider {
  readonly name: string;
  /** Start the tunnel for a local port; resolves with the public URL. */
  start(localPort: number): Promise<string>;
  stop(): Promise<void>;
  restart(localPort: number): Promise<string>;
  status(): TunnelStatus;
  getPublicUrl(): string | null;
  doctor(): Promise<TunnelDoctorReport>;
}
