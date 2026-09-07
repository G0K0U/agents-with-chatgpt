import { probePublicMcp } from "../tunnel/probe.js";
import type { SharedBridgeObservation } from "./daemon.js";

/** Only authenticated, current owner information supplies shared tunnel truth.
 * Missing per-request workspace tunnel files never choose a provider. */
export async function diagnoseSharedTunnel(
  observation: Extract<SharedBridgeObservation, { state: "healthy" }>,
  probe = probePublicMcp,
) {
  if (!observation.shared || !observation.adminInfo) throw new Error("Shared admin proof required");
  const info = observation.adminInfo;
  const publicUrl = info.publicUrl;
  const publicProbe = publicUrl ? await probe(publicUrl, 8000).catch(() => null) : null;
  const ok = Boolean(publicUrl && info.tunnel.running && publicProbe?.ok);
  return { publicUrl, publicProbe, report: { ok, detail: ok ? publicUrl! :
    info.tunnel.provider === "cloudflare-named" ? "NAMED_TUNNEL_DOWN" : "PUBLIC_TUNNEL_DOWN" } };
}
