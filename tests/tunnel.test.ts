import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { findBinary } from "../src/tunnel/detect.js";
import {
  CloudflaredQuickTunnel,
  parseQuickTunnelUrl,
  type CloudflaredQuickTunnelOptions,
} from "../src/tunnel/cloudflared.js";
import { resolveTunnelProtocol, tunnelProtocolArgs } from "../src/tunnel/protocol.js";
import {
  CloudflaredNamedTunnel,
  namedTunnelLaunchArgs,
  normalizeNamedTunnelHostname,
  reconcileNamedTunnelRuntime,
  renderNamedTunnelConfig,
} from "../src/tunnel/cloudflared-named.js";
import { hostnameSlug, parseZoneInput, suggestedNamedHostname } from "../src/tunnel/hostname.js";
import {
  chooseQuickTunnel,
  isBenignRouteError,
  parseCreatedTunnel,
  parseTunnelList,
  provisionNamedTunnel,
  type CloudflaredAccount,
} from "../src/tunnel/named-provision.js";
import {
  isNamedTunnelReady,
  namedTunnelConfigFile,
  namedTunnelRuntimeFile,
  needsTunnelChoice,
  readTunnelState,
} from "../src/tunnel/state.js";
import { probePublicMcp, waitForPublicMcp } from "../src/tunnel/probe.js";
import { writeSecureJson } from "../src/config/paths.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const stateDirs: string[] = [];
const previousStateDir = process.env.C2C_STATE_DIR;
const previousCloudflaredPath = process.env.C2C_CLOUDFLARED_PATH;
const QUICK_URL = "https://random-words-here-1234.trycloudflare.com";
type FetchImpl = NonNullable<CloudflaredQuickTunnelOptions["fetchImpl"]>;

class FakeCloudflaredProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

function setupTunnel(fetchImpl: FetchImpl, startTimeoutMs = 1_000) {
  const child = new FakeCloudflaredProcess();
  const spawnImpl = vi.fn(() => child as unknown as ChildProcess);
  const tunnel = new CloudflaredQuickTunnel(undefined, "cloudflared", {
    spawnImpl,
    fetchImpl,
    startTimeoutMs,
  });
  return { child, spawnImpl, tunnel };
}

function announceUrl(child: FakeCloudflaredProcess): void {
  child.stderr.write(`INF ${QUICK_URL}\n`);
}

function healthResponse(): Response {
  return new Response(JSON.stringify({ service: "c2c-bridge", status: "ok" }), { status: 200 });
}

afterEach(() => {
  vi.restoreAllMocks();
  while (stateDirs.length) cleanup(stateDirs.pop()!);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
  if (previousCloudflaredPath === undefined) delete process.env.C2C_CLOUDFLARED_PATH;
  else process.env.C2C_CLOUDFLARED_PATH = previousCloudflaredPath;
});

describe("findBinary", () => {
  it("uses C2C_CLOUDFLARED_PATH for an accessible cloudflared executable", () => {
    const dir = makeTmpDir("cloudflared-path");
    stateDirs.push(dir);
    const filename = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
    const configured = write(dir, filename, "placeholder");
    if (process.platform !== "win32") fs.chmodSync(configured, 0o755);
    process.env.C2C_CLOUDFLARED_PATH = configured;
    expect(findBinary("cloudflared")).toBe(configured);
  });
});

describe("parseQuickTunnelUrl", () => {
  it("extracts the URL from cloudflared banner output", () => {
    const line =
      "2026-08-28T10:00:00Z INF |  https://random-words-here-1234.trycloudflare.com                              |";
    expect(parseQuickTunnelUrl(line)).toBe(QUICK_URL);
  });

  it("ignores unrelated lines and non-Quick-Tunnel hosts", () => {
    expect(parseQuickTunnelUrl("INF Starting tunnel connection")).toBeNull();
    expect(parseQuickTunnelUrl("visit https://www.cloudflare.com for docs")).toBeNull();
    expect(parseQuickTunnelUrl("https://evil.example.com/trycloudflare.com")).toBeNull();
  });

  it("rejects Cloudflare's API host", () => {
    expect(parseQuickTunnelUrl("INF https://api.trycloudflare.com")).toBeNull();
  });
});

describe("CloudflaredQuickTunnel", () => {
  it("resolves only after the public health endpoint identifies the bridge", async () => {
    const fetchImpl = vi.fn(async () => healthResponse());
    const { child, spawnImpl, tunnel } = setupTunnel(fetchImpl);
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).resolves.toBe(QUICK_URL);
    expect(spawnImpl).toHaveBeenCalledWith(
      "cloudflared",
      ["tunnel", "--url", "http://127.0.0.1:3333", "--no-autoupdate"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    expect(fetchImpl).toHaveBeenCalledWith(`${QUICK_URL}/health`, {
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(tunnel.status()).toMatchObject({ running: true, url: QUICK_URL });
    await tunnel.stop();
  });

  it("keeps consuming cloudflared errors after the tunnel is ready", async () => {
    const { child, tunnel } = setupTunnel(async () => healthResponse());
    const starting = tunnel.start(3333);
    announceUrl(child);
    await expect(starting).resolves.toBe(QUICK_URL);

    child.stderr.write("ERR runtime connection error\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(tunnel.status().detail).toBe("ERR runtime connection error");
    await tunnel.stop();
  });

  it("does not accept an HTTP 200 response from another service", async () => {
    const { child, tunnel } = setupTunnel(
      async () =>
        new Response(JSON.stringify({ service: "cloudflare", status: "ok" }), { status: 200 }),
      20
    );
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).rejects.toThrow(/timed out/i);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("does not spawn twice or resolve a stopped pending start", async () => {
    const { child, spawnImpl, tunnel } = setupTunnel(() => new Promise<Response>(() => {}));
    const starting = tunnel.start(3333);
    announceUrl(child);
    await new Promise((resolve) => setImmediate(resolve));

    const concurrent = tunnel.start(3333);
    await tunnel.stop();
    await expect(starting).rejects.toThrow(/stopped/i);
    await expect(concurrent).rejects.toThrow(/stopped/i);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not resolve if cloudflared exits while the health probe is in flight", async () => {
    let resolveFetch!: (response: Response) => void;
    const { child, tunnel } = setupTunnel(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve))
    );
    const starting = tunnel.start(3333);
    announceUrl(child);
    await new Promise((resolve) => setImmediate(resolve));

    child.exitCode = 1;
    child.emit("exit", 1, null);
    resolveFetch(healthResponse());
    await expect(starting).rejects.toThrow(/exited/i);
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("rejects when spawning reports an asynchronous error", async () => {
    const { child, tunnel } = setupTunnel(async () => new Response(null));
    const starting = tunnel.start(3333);
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("error", new Error("spawn cloudflared ENOENT"));

    await expect(starting).rejects.toThrow(/ENOENT/i);
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("retries a non-ready health response before resolving", async () => {
    let calls = 0;
    const cancelBody = vi.fn(async () => undefined);
    const { child, tunnel } = setupTunnel(async () => {
      calls += 1;
      return calls === 1
        ? ({ ok: false, status: 503, body: { cancel: cancelBody } } as unknown as Response)
        : healthResponse();
    });
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).resolves.toBe(QUICK_URL);
    expect(calls).toBe(2);
    expect(cancelBody).toHaveBeenCalledTimes(1);
    await tunnel.stop();
  });
});

describe("normalizeNamedTunnelHostname", () => {
  it("normalizes a valid hostname", () => {
    expect(normalizeNamedTunnelHostname("Dev.GetRemi.xyz.")).toBe("dev.getremi.xyz");
  });

  it("rejects URLs and invalid hostnames", () => {
    expect(() => normalizeNamedTunnelHostname("https://dev.getremi.xyz")).toThrow(/invalid/i);
    expect(() => normalizeNamedTunnelHostname("localhost")).toThrow(/invalid/i);
  });
});

describe("named hostname helpers", () => {
  it("builds a stable c2c-<project>.<zone> hostname", () => {
    expect(suggestedNamedHostname("Example.COM", "My App", "abcdef123456")).toBe("c2c-my-app.example.com");
  });

  it("falls back to the workspace id when the name is not ASCII", () => {
    expect(hostnameSlug("回声", "abcdef123456")).toBe("c2c-ws-abcdef12");
  });

  it("parses a typed domain", () => {
    expect(parseZoneInput("https://Example.com/")).toBe("example.com");
    expect(parseZoneInput("not a domain")).toBeNull();
  });
});

describe("cloudflared output parsers", () => {
  it("reads a tunnel list table", () => {
    const output = `
ID                                   NAME          CREATED
11111111-1111-1111-1111-111111111111 c2c-abc123    2026-08-30
`;
    expect(parseTunnelList(output)).toEqual([
      { id: "11111111-1111-1111-1111-111111111111", name: "c2c-abc123" },
    ]);
  });

  it("reads created-tunnel output", () => {
    expect(
      parseCreatedTunnel(
        "Created tunnel c2c-abc with id 22222222-2222-2222-2222-222222222222",
        "c2c-abc"
      )
    ).toEqual({ id: "22222222-2222-2222-2222-222222222222", name: "c2c-abc" });
  });

  it("treats an existing DNS route as success", () => {
    expect(isBenignRouteError("Failed to add route: record already exists")).toBe(true);
  });
});

describe("named tunnel runtime reconciliation", () => {
  it("renders the current origin port atomically and never uses the quick-tunnel --url shortcut", () => {
    const first = renderNamedTunnelConfig({
      tunnelId: "33333333-3333-3333-3333-333333333333",
      credentialsFile: "C:\\Users\\<user>\\.cloudflared\\33333333-3333-3333-3333-333333333333.json",
      hostname: "c2c.example.com",
      localPort: 51092,
    });
    const second = renderNamedTunnelConfig({
      tunnelId: "33333333-3333-3333-3333-333333333333",
      credentialsFile: "C:\\Users\\<user>\\.cloudflared\\33333333-3333-3333-3333-333333333333.json",
      hostname: "c2c.example.com",
      localPort: 51093,
    });
    expect(first).toContain("http://127.0.0.1:51092");
    expect(second).toContain("http://127.0.0.1:51093");
    expect(second).not.toContain("51092");
    expect(second).not.toContain("token");

    const args = namedTunnelLaunchArgs(namedTunnelConfigFile("ws1"), "33333333-3333-3333-3333-333333333333");
    expect(args).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--config",
      namedTunnelConfigFile("ws1"),
      "run",
      "33333333-3333-3333-3333-333333333333",
    ]);
    expect(args).not.toContain("--url");
  });

  it("clears a dead launch record but does not claim that a live unknown process is safe", () => {
    const stateDir = isolateStateDir();
    stateDirs.push(stateDir);
    writeSecureJson(namedTunnelRuntimeFile("ghost"), {
      pid: 999_999_999,
      workspaceId: "ghost",
      tunnelName: "c2c-ghost",
      tunnelId: "33333333-3333-3333-3333-333333333333",
      hostname: "c2c.example.com",
      originPort: 51092,
      configFile: namedTunnelConfigFile("ghost"),
      startedAt: new Date().toISOString(),
    });
    expect(reconcileNamedTunnelRuntime("ghost").state).toBe("stale-cleared");
    expect(fs.existsSync(namedTunnelRuntimeFile("ghost"))).toBe(false);
  });
});

describe("public MCP verification", () => {
  it("accepts only the bridge's expected unauthenticated 401 and rejects Cloudflare 502", async () => {
    const bad = await probePublicMcp(
      "https://c2c.example.com",
      100,
      async () => new Response(null, { status: 502 })
    );
    expect(bad).toMatchObject({ ok: false, status: 502 });

    const good = await probePublicMcp(
      "https://c2c.example.com",
      100,
      async () => new Response(null, { status: 401 })
    );
    expect(good).toMatchObject({ ok: true, status: 401 });
  });

  it("waits for the edge to recover without turning an intermediate 502 into success", async () => {
    let attempts = 0;
    const result = await waitForPublicMcp("https://c2c.example.com", {
      timeoutMs: 100,
      attemptTimeoutMs: 50,
      intervalMs: 1,
      fetchImpl: async () => {
        attempts += 1;
        return new Response(null, { status: attempts === 1 ? 502 : 401 });
      },
    });
    expect(result).toMatchObject({ ok: true, status: 401 });
    expect(attempts).toBeGreaterThanOrEqual(2);
  });
});

describe("tunnel preference state", () => {
  it("asks once, then remembers a quick choice", () => {
    stateDirs.push(isolateStateDir());
    const unset = readTunnelState("ws1");
    expect(needsTunnelChoice(unset)).toBe(true);
    const saved = chooseQuickTunnel("ws1");
    expect(saved.preference).toBe("quick");
    expect(needsTunnelChoice(readTunnelState("ws1"))).toBe(false);
    expect(isNamedTunnelReady(saved)).toBe(false);
  });

  it("provisions a named hostname through the account adapter and stores it outside the project", () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async (name) => ({ id: "33333333-3333-3333-3333-333333333333", name }),
      routeDns: async () => undefined,
    };
    return provisionNamedTunnel({
      workspaceId: "abcdef123456",
      workspaceName: "Demo",
      zone: "example.com",
      account,
    }).then((result) => {
      expect(result.fallback).toBe(false);
      expect(result.state.preference).toBe("named");
      expect(result.state.management).toBe("managed");
      expect(result.state.hostname).toBe("c2c-demo.example.com");
      expect(result.state.tunnelName).toBe("c2c-abcdef123456");
      expect(isNamedTunnelReady(readTunnelState("abcdef123456"))).toBe(true);
    });
  });

  it("falls back to a temporary address when named provisioning fails", () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async () => {
        throw new Error("no zone");
      },
      routeDns: async () => undefined,
    };
    return provisionNamedTunnel({
      workspaceId: "ws2",
      workspaceName: "Demo",
      zone: "example.com",
      account,
    }).then((result) => {
      expect(result.fallback).toBe(true);
      expect(result.state.preference).toBe("quick");
      expect(result.userMessage).toMatch(/临时地址/);
    });
  });
});

describe("CloudflaredNamedTunnel external observation without process control", () => {
  const tunnelId = "55555555-5555-5555-5555-555555555555";
  const hostname = "c2c.example.com";
  const tunnelName = "c2c-ws-adopt";
  const workspaceId = "ws-adopt";

  function setupNamedEnvironment(stateDir: string, port = 48765) {
    vi.spyOn(os, "homedir").mockReturnValue(stateDir);
    const credsDir = path.join(stateDir, ".cloudflared");
    fs.mkdirSync(credsDir, { recursive: true });
    const credentialsFile = path.join(credsDir, `${tunnelId}.json`);
    fs.writeFileSync(credentialsFile, JSON.stringify({ AccountTag: "tag", TunnelSecret: "sec" }));

    const configContent = renderNamedTunnelConfig({
      tunnelId,
      credentialsFile,
      hostname,
      localPort: port,
    });
    const configFile = namedTunnelConfigFile(workspaceId, stateDir);
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, configContent);

    return { credentialsFile, configFile };
  }

  function createMockFetch(opts: {
    publicInstanceId?: string | null;
    localInstanceId?: string | null;
    publicStatus?: number;
    localStatus?: number;
    publicService?: string;
    localService?: string;
    publicWorkspaceId?: string;
    localWorkspaceId?: string;
    publicReleaseId?: string;
    localReleaseId?: string;
    mcpStatus?: number;
    gate?: Promise<void>;
  } = {}) {
    const pubInst = opts.publicInstanceId !== undefined ? opts.publicInstanceId : "inst-match-123";
    const locInst = opts.localInstanceId !== undefined ? opts.localInstanceId : "inst-match-123";
    const pubStatus = opts.publicStatus ?? 200;
    const locStatus = opts.localStatus ?? 200;
    const pubService = opts.publicService ?? "c2c-bridge";
    const locService = opts.localService ?? "c2c-bridge";
    const pubWs = opts.publicWorkspaceId ?? workspaceId;
    const locWs = opts.localWorkspaceId ?? workspaceId;
    const mcpStat = opts.mcpStatus ?? 401;

    return vi.fn(async (input: string | URL) => {
      const urlStr = String(input);
      if (opts.gate) {
        await opts.gate;
      }
      if (urlStr.includes(`https://${hostname}/health`)) {
        if (pubStatus !== 200) {
          return new Response("Error", { status: pubStatus });
        }
        return new Response(
          JSON.stringify({
            status: "ok",
            service: pubService,
            workspaceId: pubWs,
            instanceId: pubInst ?? undefined,
            release: opts.publicReleaseId ? { releaseId: opts.publicReleaseId } : undefined,
          }),
          { status: 200 }
        );
      }
      if (urlStr.includes("http://127.0.0.1:") && urlStr.endsWith("/health")) {
        if (locStatus !== 200) {
          return new Response("Error", { status: locStatus });
        }
        return new Response(
          JSON.stringify({
            status: "ok",
            service: locService,
            workspaceId: locWs,
            instanceId: locInst ?? undefined,
            release: opts.localReleaseId ? { releaseId: opts.localReleaseId } : undefined,
          }),
          { status: 200 }
        );
      }
      if (urlStr.includes(`https://${hostname}/mcp`)) {
        return new Response("Unauthorized", { status: mcpStat });
      }
      return new Response(null, { status: 404 });
    });
  }

  it("externally observes existing verified public route without spawning, config rewrite, or runtime write", async () => {
    const stateDir = isolateStateDir();
    stateDirs.push(stateDir);
    const { configFile, credentialsFile } = setupNamedEnvironment(stateDir, 48765);

    const mockFetch = createMockFetch();
    const spawnImpl = vi.fn();
    const configBefore = fs.readFileSync(configFile, "utf8");

    const tunnel = new CloudflaredNamedTunnel({
      workspaceId,
      tunnelName,
      tunnelId,
      hostname,
      stateDir,
      credentialsFile,
      fetchImpl: mockFetch as any,
      spawnImpl: spawnImpl as any,
    });

    const url = await tunnel.start(48765);
    expect(url).toBe(`https://${hostname}`);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(fs.readFileSync(configFile, "utf8")).toBe(configBefore);
    expect(fs.existsSync(namedTunnelRuntimeFile(workspaceId, stateDir))).toBe(false);

    const status = tunnel.status();
    expect(status.running).toBe(true);
    expect(status.url).toBe(`https://${hostname}`);
    expect(status.originPort).toBe(48765);
    expect(status.management).toBe("external");
    expect(status.ownsProcess).toBe(false);
    expect(status.canControlProcess).toBe(false);
    expect(typeof status.observedAt).toBe("string");
    expect(status.executable).toBeNull();
    expect(status.argv).toEqual([]);
    expect(tunnel.getPublicUrl()).toBe(`https://${hostname}`);

    const doctor = await tunnel.doctor();
    expect(doctor.running).toBe(true);
    expect(doctor.management).toBe("external");
    expect(doctor.ownsProcess).toBe(false);
    expect(doctor.canControlProcess).toBe(false);
    expect(doctor.problems).toHaveLength(0);
  });

  it("read-only doctor observes the current bridge port when a new process has no prior tunnel observation", async () => {
    const stateDir = isolateStateDir();
    stateDirs.push(stateDir);
    const { configFile, credentialsFile } = setupNamedEnvironment(stateDir, 48765);
    const before = fs.readFileSync(configFile, "utf8");
    const spawnImpl = vi.fn();
    const tunnel = new CloudflaredNamedTunnel({ workspaceId, tunnelName, tunnelId,
      hostname, stateDir, credentialsFile, fetchImpl: createMockFetch() as any,
      spawnImpl: spawnImpl as any });
    expect(tunnel.status().running).toBe(false);
    const observed = await tunnel.doctor(48765);
    expect(observed).toMatchObject({ management: "external", running: true, reachable: true,
      originPort: 48765, ownsProcess: false, canControlProcess: false });
    expect(tunnel.status().running).toBe(true);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(fs.readFileSync(configFile, "utf8")).toBe(before);
    expect(fs.existsSync(namedTunnelRuntimeFile(workspaceId, stateDir))).toBe(false);
  });

  it("fails observation when instanceId mismatches between public and local", async () => {
    const stateDir = isolateStateDir();
    stateDirs.push(stateDir);
    const { configFile, credentialsFile } = setupNamedEnvironment(stateDir, 48765);

    const mockFetch = createMockFetch({
      publicInstanceId: "boot-inst-AAA",
      localInstanceId: "boot-inst-BBB",
    });
    const spawnImpl = vi.fn();

    // With a live unknown process in runtime file, falling back to spawn must fail closed
    writeSecureJson(namedTunnelRuntimeFile(workspaceId, stateDir), {
      pid: process.pid,
      workspaceId,
      tunnelName,
      tunnelId,
      hostname,
      originPort: 48765,
      configFile,
      startedAt: new Date().toISOString(),
    });

    const tunnel = new CloudflaredNamedTunnel({
      workspaceId,
      tunnelName,
      tunnelId,
      hostname,
      stateDir,
      credentialsFile,
      fetchImpl: mockFetch as any,
      spawnImpl: spawnImpl as any,
    });

    await expect(tunnel.start(48765)).rejects.toThrow(/A previous named tunnel process is still alive.*refusing to overwrite its origin config/i);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(tunnel.status().running).toBe(false);
  });

  it("fails observation when instanceId is missing or empty (missing proof)", async () => {
    const stateDir = isolateStateDir();
    stateDirs.push(stateDir);
    const { configFile, credentialsFile } = setupNamedEnvironment(stateDir, 48765);

    const mockFetch = createMockFetch({
      publicInstanceId: "",
      localInstanceId: "boot-inst-BBB",
    });
    const spawnImpl = vi.fn();

    writeSecureJson(namedTunnelRuntimeFile(workspaceId, stateDir), {
      pid: process.pid,
      workspaceId,
      tunnelName,
      tunnelId,
      hostname,
      originPort: 48765,
      configFile,
      startedAt: new Date().toISOString(),
    });

    const tunnel = new CloudflaredNamedTunnel({
      workspaceId,
      tunnelName,
      tunnelId,
      hostname,
      stateDir,
      credentialsFile,
      fetchImpl: mockFetch as any,
      spawnImpl: spawnImpl as any,
    });

    await expect(tunnel.start(48765)).rejects.toThrow(/A previous named tunnel process is still alive.*refusing to overwrite its origin config/i);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("fails observation when public /health returns HTTP 502", async () => {
    const stateDir = isolateStateDir();
    stateDirs.push(stateDir);
    const { configFile, credentialsFile } = setupNamedEnvironment(stateDir, 48765);

    const mockFetch = createMockFetch({
      publicStatus: 502,
    });
    const spawnImpl = vi.fn();

    writeSecureJson(namedTunnelRuntimeFile(workspaceId, stateDir), {
      pid: process.pid,
      workspaceId,
      tunnelName,
      tunnelId,
      hostname,
      originPort: 48765,
      configFile,
      startedAt: new Date().toISOString(),
    });

    const tunnel = new CloudflaredNamedTunnel({
      workspaceId,
      tunnelName,
      tunnelId,
      hostname,
      stateDir,
      credentialsFile,
      fetchImpl: mockFetch as any,
      spawnImpl: spawnImpl as any,
    });

    await expect(tunnel.start(48765)).rejects.toThrow(/A previous named tunnel process is still alive.*refusing to overwrite its origin config/i);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("does not launch a second tunnel when an external route is unverified and no runtime PID is recorded", async () => {
    const stateDir = isolateStateDir();
    stateDirs.push(stateDir);
    const { configFile, credentialsFile } = setupNamedEnvironment(stateDir, 48765);
    const before = fs.readFileSync(configFile, "utf8");
    const spawnImpl = vi.fn();
    const tunnel = new CloudflaredNamedTunnel({
      workspaceId, tunnelName, tunnelId, hostname, stateDir, credentialsFile,
      fetchImpl: createMockFetch({ publicStatus: 502 }) as any,
      spawnImpl: spawnImpl as any,
    });
    await expect(tunnel.start(48765)).rejects.toThrow(/External named tunnel route unverified/);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(fs.readFileSync(configFile, "utf8")).toBe(before);
    expect(fs.existsSync(namedTunnelRuntimeFile(workspaceId, stateDir))).toBe(false);
    expect(tunnel.status()).toMatchObject({ management: "external", running: false, reachable: false,
      ownsProcess: false, canControlProcess: false });
  });

  it("rejects an oversized public health response before trusting route identity", async () => {
    const stateDir = isolateStateDir();
    stateDirs.push(stateDir);
    const { credentialsFile } = setupNamedEnvironment(stateDir, 48765);
    const spawnImpl = vi.fn();
    const tunnel = new CloudflaredNamedTunnel({
      workspaceId, tunnelName, tunnelId, hostname, stateDir, credentialsFile,
      fetchImpl: vi.fn(async (input: string | URL) => String(input).startsWith(`https://${hostname}/health`)
        ? new Response("x".repeat(9_000), { status: 200 })
        : new Response("Unauthorized", { status: 401 })) as any,
      spawnImpl: spawnImpl as any,
    });
    await expect(tunnel.start(48765)).rejects.toThrow(/invalid JSON/);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("expires observation when age exceeds bounded freshness (stale observation)", async () => {
    const stateDir = isolateStateDir();
    stateDirs.push(stateDir);
    const { configFile, credentialsFile } = setupNamedEnvironment(stateDir, 48765);

    const mockFetch = createMockFetch();
    let nowMs = Date.now();
    const tunnel = new CloudflaredNamedTunnel({
      workspaceId,
      tunnelName,
      tunnelId,
      hostname,
      stateDir,
      credentialsFile,
      fetchImpl: mockFetch as any,
      observationTtlMs: 50,
      nowMs: () => nowMs,
    });

    await tunnel.start(48765);
    expect(tunnel.status().running).toBe(true);

    nowMs += 51;

    const staleStatus = tunnel.status();
    expect(staleStatus.running).toBe(false);
    expect(staleStatus.url).toBeNull();
    expect(staleStatus.detail).toContain("External tunnel observation expired");
    expect(staleStatus.management).toBe("external");
    expect(staleStatus.reachable).toBeNull();
    expect(staleStatus.originPort).toBe(48765);
    expect(staleStatus.ownsProcess).toBe(false);
    expect(tunnel.getPublicUrl()).toBeNull();

    const refreshed = await tunnel.doctor();
    expect(refreshed).toMatchObject({ management: "external", running: true, reachable: true,
      originPort: 48765, ownsProcess: false, canControlProcess: false });
    expect(tunnel.status().running).toBe(true);
  });

  it("stop() clears observation in memory without killing external process", async () => {
    const stateDir = isolateStateDir();
    stateDirs.push(stateDir);
    const { configFile, credentialsFile } = setupNamedEnvironment(stateDir, 48765);

    const mockFetch = createMockFetch();
    const tunnel = new CloudflaredNamedTunnel({
      workspaceId,
      tunnelName,
      tunnelId,
      hostname,
      stateDir,
      credentialsFile,
      fetchImpl: mockFetch as any,
    });

    await tunnel.start(48765);
    expect(tunnel.status().running).toBe(true);

    const killSpy = vi.spyOn(process, "kill");
    await tunnel.stop();
    expect(killSpy).not.toHaveBeenCalled();
    expect(tunnel.status().running).toBe(false);
    expect(tunnel.getPublicUrl()).toBeNull();
  });

  it("stop() during awaited probe cannot resurrect observation (generation fence)", async () => {
    const stateDir = isolateStateDir();
    stateDirs.push(stateDir);
    const { configFile, credentialsFile } = setupNamedEnvironment(stateDir, 48765);

    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => { releaseGate = r; });

    const mockFetch = createMockFetch({ gate });
    const tunnel = new CloudflaredNamedTunnel({
      workspaceId,
      tunnelName,
      tunnelId,
      hostname,
      stateDir,
      credentialsFile,
      fetchImpl: mockFetch as any,
    });

    const startPromise = tunnel.start(48765);
    await tunnel.stop();
    releaseGate();

    await expect(startPromise).rejects.toThrow(/interrupted by stop/i);
    expect(tunnel.status().running).toBe(false);
    expect(tunnel.getPublicUrl()).toBeNull();
  });

  it("stop() during a read-only doctor probe cannot restore an external observation", async () => {
    const stateDir = isolateStateDir();
    stateDirs.push(stateDir);
    const { credentialsFile } = setupNamedEnvironment(stateDir, 48765);
    const standardFetch = createMockFetch();
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    let observeStarted!: () => void;
    const started = new Promise<void>((resolve) => { observeStarted = resolve; });
    let holdNextHealth = false;
    const mockFetch = vi.fn(async (input: string | URL) => {
      if (holdNextHealth && String(input).endsWith("/health")) {
        holdNextHealth = false;
        observeStarted();
        await probeGate;
      }
      return standardFetch(input);
    });
    const tunnel = new CloudflaredNamedTunnel({ workspaceId, tunnelName, tunnelId,
      hostname, stateDir, credentialsFile, fetchImpl: mockFetch as any });
    await tunnel.start(48765);
    holdNextHealth = true;
    const observing = tunnel.doctor();
    await started;
    await tunnel.stop();
    releaseProbe();
    await observing;
    expect(tunnel.status().running).toBe(false);
    expect(tunnel.getPublicUrl()).toBeNull();
  });

  it("concurrent different-port starts cannot share wrong result", async () => {
    const stateDir = isolateStateDir();
    stateDirs.push(stateDir);
    const { configFile, credentialsFile } = setupNamedEnvironment(stateDir, 48765);

    let releaseGate48765!: () => void;
    const gate48765 = new Promise<void>((r) => { releaseGate48765 = r; });

    const mockFetch = vi.fn(async (input: string | URL) => {
      const urlStr = String(input);
      if (urlStr.includes("127.0.0.1:48765")) {
        await gate48765;
      }
      if (urlStr.endsWith("/mcp")) return new Response("Unauthorized", { status: 401 });
      const portMatch = urlStr.match(/127\.0\.0\.1:(\d+)/);
      const port = portMatch ? parseInt(portMatch[1], 10) : 48766;
      return new Response(JSON.stringify({
        status: "ok",
        service: "c2c-bridge",
        workspaceId,
        instanceId: `inst-${port}`,
      }), { status: 200 });
    });

    const tunnel = new CloudflaredNamedTunnel({
      workspaceId,
      tunnelName,
      tunnelId,
      hostname,
      stateDir,
      credentialsFile,
      fetchImpl: mockFetch as any,
    });

    const start1 = tunnel.start(48765);
    const start2 = tunnel.start(48766);
    releaseGate48765();

    const [res1, res2] = await Promise.allSettled([start1, start2]);
    if (res1.status === "rejected") {
      expect((res1.reason as Error).message).toMatch(/interrupted/i);
    }
    expect(res2.status).toBe("fulfilled");
    expect(tunnel.status().originPort).toBe(48766);
  });

  it("fails closed for CONTROL without erasing ambiguous malformed runtime state", async () => {
    const stateDir = isolateStateDir();
    stateDirs.push(stateDir);
    const { configFile, credentialsFile } = setupNamedEnvironment(stateDir, 48765);

    const runtimePath = namedTunnelRuntimeFile(workspaceId, stateDir);
    fs.writeFileSync(runtimePath, "{ corrupted invalid json syntax ... ");

    const mockFetch = createMockFetch({ publicStatus: 502 });
    const spawnImpl = vi.fn();

    const tunnel = new CloudflaredNamedTunnel({
      workspaceId,
      tunnelName,
      tunnelId,
      hostname,
      stateDir,
      credentialsFile,
      fetchImpl: mockFetch as any,
      spawnImpl: spawnImpl as any,
    });

    await expect(tunnel.start(48765)).rejects.toThrow(/ambiguous or malformed/i);
    expect(spawnImpl).not.toHaveBeenCalled();
    // Must NOT erase the malformed file
    expect(fs.existsSync(runtimePath)).toBe(true);
  });

  it("doctor() reprobes external connection and detects failed observation", async () => {
    const stateDir = isolateStateDir();
    stateDirs.push(stateDir);
    const { configFile, credentialsFile } = setupNamedEnvironment(stateDir, 48765);

    let healthy = true;
    const mockFetch = vi.fn(async (input: string | URL) => {
      const urlStr = String(input);
      if (urlStr.endsWith("/mcp")) return new Response("Unauthorized", { status: 401 });
      if (!healthy && urlStr.includes(`https://${hostname}`)) {
        return new Response("Bad Gateway", { status: 502 });
      }
      return new Response(JSON.stringify({
        status: "ok",
        service: "c2c-bridge",
        workspaceId,
        instanceId: "inst-doctor-probe",
      }), { status: 200 });
    });

    const tunnel = new CloudflaredNamedTunnel({
      workspaceId,
      tunnelName,
      tunnelId,
      hostname,
      stateDir,
      credentialsFile,
      fetchImpl: mockFetch as any,
    });

    await tunnel.start(48765);
    expect(tunnel.status().running).toBe(true);

    const doc1 = await tunnel.doctor();
    expect(doc1.running).toBe(true);
    expect(doc1.management).toBe("external");

    healthy = false;
    const doc2 = await tunnel.doctor();
    expect(doc2.running).toBe(false);
    expect(doc2.problems.some((p) => p.includes("external tunnel probe failed"))).toBe(true);
    expect(tunnel.status().running).toBe(false);

    healthy = true;
    const doc3 = await tunnel.doctor();
    expect(doc3).toMatchObject({ management: "external", running: true, reachable: true,
      originPort: 48765 });
  });

  it("release binding check: verifies release binding when provided", async () => {
    const stateDir = isolateStateDir();
    stateDirs.push(stateDir);
    const { configFile, credentialsFile } = setupNamedEnvironment(stateDir, 48765);

    // Mismatch release
    const mockFetchMismatch = createMockFetch({
      publicReleaseId: "v0.3.0",
      localReleaseId: "v0.4.0",
    });
    const tunnelMismatch = new CloudflaredNamedTunnel({
      workspaceId,
      tunnelName,
      tunnelId,
      hostname,
      stateDir,
      credentialsFile,
      fetchImpl: mockFetchMismatch as any,
      spawnImpl: vi.fn() as any,
      expectedReleaseId: "v0.3.0",
    });
    // With live unknown process blocking spawn, fails closed
    writeSecureJson(namedTunnelRuntimeFile(workspaceId, stateDir), {
      pid: process.pid,
      workspaceId,
      tunnelName,
      tunnelId,
      hostname,
      originPort: 48765,
      configFile,
      startedAt: new Date().toISOString(),
    });
    await expect(tunnelMismatch.start(48765)).rejects.toThrow(/refusing to overwrite its origin config/i);

    // Match release
    const mockFetchMatch = createMockFetch({
      publicReleaseId: "v0.3.0",
      localReleaseId: "v0.3.0",
    });
    const tunnelMatch = new CloudflaredNamedTunnel({
      workspaceId,
      tunnelName,
      tunnelId,
      hostname,
      stateDir,
      credentialsFile,
      fetchImpl: mockFetchMatch as any,
      expectedReleaseId: "v0.3.0",
    });
    const matchUrl = await tunnelMatch.start(48765);
    expect(matchUrl).toBe(`https://${hostname}`);
    expect(tunnelMatch.status().running).toBe(true);
  });
});

describe("C2C_TUNNEL_PROTOCOL", () => {
  it("defaults to auto and passes no protocol flags", () => {
    expect(resolveTunnelProtocol({})).toBe("auto");
    expect(tunnelProtocolArgs("auto")).toEqual([]);
  });

  it("resolves quic and passes --protocol quic", () => {
    expect(resolveTunnelProtocol({ C2C_TUNNEL_PROTOCOL: "quic" })).toBe("quic");
    expect(tunnelProtocolArgs("quic")).toEqual(["--protocol", "quic"]);
  });

  it("resolves http2 and passes --protocol http2", () => {
    expect(resolveTunnelProtocol({ C2C_TUNNEL_PROTOCOL: "http2" })).toBe("http2");
    expect(tunnelProtocolArgs("http2")).toEqual(["--protocol", "http2"]);
  });

  it("handles case-insensitivity and whitespace", () => {
    expect(resolveTunnelProtocol({ C2C_TUNNEL_PROTOCOL: "  QUIC  " })).toBe("quic");
    expect(resolveTunnelProtocol({ C2C_TUNNEL_PROTOCOL: "Http2" })).toBe("http2");
    expect(resolveTunnelProtocol({ C2C_TUNNEL_PROTOCOL: "AUTO" })).toBe("auto");
  });

  it("falls back to A2C_TUNNEL_PROTOCOL", () => {
    expect(resolveTunnelProtocol({ A2C_TUNNEL_PROTOCOL: "quic" })).toBe("quic");
  });

  it("fails closed on invalid protocol", () => {
    expect(() => resolveTunnelProtocol({ C2C_TUNNEL_PROTOCOL: "invalid-proto" })).toThrow(
      /Invalid tunnel protocol/i
    );
  });

  it("passes --protocol in Quick Tunnel spawn when configured", async () => {
    const fetchImpl = vi.fn(async () => healthResponse());
    const child = new FakeCloudflaredProcess();
    const spawnImpl = vi.fn(() => child as unknown as ChildProcess);
    const tunnel = new CloudflaredQuickTunnel(undefined, "cloudflared", {
      spawnImpl,
      fetchImpl,
      startTimeoutMs: 1_000,
      env: { C2C_TUNNEL_PROTOCOL: "quic" },
    });
    const starting = tunnel.start(4000);
    announceUrl(child);
    await expect(starting).resolves.toBe(QUICK_URL);
    expect(spawnImpl).toHaveBeenCalledWith(
      "cloudflared",
      ["tunnel", "--url", "http://127.0.0.1:4000", "--no-autoupdate", "--protocol", "quic"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
  });

  it("passes --protocol in namedTunnelLaunchArgs when configured", () => {
    const args = namedTunnelLaunchArgs("/path/to/config.yml", "11111111-2222-3333-4444-555555555555", "http2");
    expect(args).toContain("--protocol");
    expect(args).toContain("http2");
  });
});
