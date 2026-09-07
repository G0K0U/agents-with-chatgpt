import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startBridge } from "../src/bridge/server.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "../src/tunnel/provider.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

class BadPublicTunnel implements TunnelProvider {
  readonly name = "test-named";
  startCalls = 0;
  stopCalls = 0;

  async start(_localPort: number): Promise<string> {
    this.startCalls += 1;
    return "https://c2c.example.com";
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  async restart(localPort: number): Promise<string> {
    await this.stop();
    return this.start(localPort);
  }

  status(): TunnelStatus {
    return { running: this.startCalls > this.stopCalls, url: "https://c2c.example.com", provider: this.name };
  }

  getPublicUrl(): string | null {
    return "https://c2c.example.com";
  }

  async doctor(): Promise<TunnelDoctorReport> {
    return {
      provider: this.name,
      binaryFound: true,
      binaryPath: "test-tunnel",
      running: this.startCalls > this.stopCalls,
      url: this.getPublicUrl(),
      problems: [],
    };
  }
}

describe("registered public tunnel gate", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) cleanup(dirs.pop()!);
    delete process.env.C2C_STATE_DIR;
  });

  it("does not report tunnel success when the public MCP endpoint is a 502", async () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const root = makeTmpDir("tunnel-gate-ws");
    dirs.push(root);
    write(root, "hello.txt", "tunnel gate\n");
    const tunnel = new BadPublicTunnel();
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("tunnel-gate-auth"), "store.json"),
      tunnelProvider: tunnel,
      publicFetch: async () => new Response(null, { status: 502 }),
      publicProbeTimeoutMs: 10,
      publicProbeAttemptTimeoutMs: 10,
      publicProbeIntervalMs: 1,
    });
    try {
      const response = await fetch(`${bridge.localBaseUrl()}/admin/tunnel/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.adminToken}` },
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: "tunnel_failed" });
      expect(tunnel.startCalls).toBe(1);
      expect(tunnel.stopCalls).toBe(1);

      const info = await fetch(`${bridge.localBaseUrl()}/admin/info`, {
        headers: { authorization: `Bearer ${bridge.adminToken}` },
      });
      expect(await info.json()).toMatchObject({ publicUrl: null, publicProbe: { ok: false, status: 502 } });
    } finally {
      await bridge.close();
    }
  });
});

