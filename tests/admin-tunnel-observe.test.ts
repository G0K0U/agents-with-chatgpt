import { describe, expect, it, vi } from "vitest";
import { startBridge } from "../src/bridge/server.js";
import type { TunnelProvider, TunnelStatus } from "../src/tunnel/provider.js";
import { cleanup, makeTmpDir } from "./helpers.js";

describe("local admin external tunnel observation", () => {
  it("refreshes a stale external route through an authenticated read without starting a process", async () => {
    const workspaceRoot = makeTmpDir("external-observe-workspace");
    const stateDir = makeTmpDir("external-observe-state");
    let fresh = false;
    const status = (): TunnelStatus => ({ provider: "cloudflare-named", management: "external",
      running: fresh, reachable: fresh ? true : null, url: fresh ? "https://fixed.example" : null,
      hostname: "fixed.example", originPort: 48765, ownsProcess: false, canControlProcess: false });
    const start = vi.fn(async () => { throw new Error("external process must not be started"); });
    const doctor = vi.fn(async () => {
      fresh = true;
      return { provider: "cloudflare-named", binaryFound: false, binaryPath: null,
        running: true, url: "https://fixed.example", problems: [], management: "external" as const,
        reachable: true, ownsProcess: false, canControlProcess: false };
    });
    const tunnel: TunnelProvider = { name: "cloudflare-named", status,
      getPublicUrl: () => status().url, start, doctor, stop: async () => {},
      restart: start };
    const bridge = await startBridge({ workspaceRoot, stateDir, port: 0,
      persistRuntime: false, zcodeCoordinator: false, tunnelProvider: tunnel });
    try {
      const headers = { authorization: `Bearer ${bridge.adminToken}` };
      const first = await fetch(`${bridge.localBaseUrl()}/admin/info`, { headers });
      expect(first.status).toBe(200);
      expect((await first.json()).tunnel).toMatchObject({ management: "external", running: false, reachable: null });
      expect(doctor).not.toHaveBeenCalled();

      const denied = await fetch(`${bridge.localBaseUrl()}/admin/info?observe=1`);
      expect(denied.status).toBe(404);
      expect(doctor).not.toHaveBeenCalled();

      const refreshed = await fetch(`${bridge.localBaseUrl()}/admin/info?observe=1`, { headers });
      expect(refreshed.status).toBe(200);
      expect((await refreshed.json()).tunnel).toMatchObject({ management: "external", running: true,
        reachable: true, ownsProcess: false, canControlProcess: false });
      expect(doctor).toHaveBeenCalledTimes(1);
      expect(doctor).toHaveBeenCalledWith(bridge.port);
      expect(start).not.toHaveBeenCalled();
    } finally {
      await bridge.close();
      cleanup(workspaceRoot);
      cleanup(stateDir);
    }
  });
});
