import fs from "node:fs";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { makeTmpDir, cleanup } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import { writeLastEndpoint } from "../src/config/endpoint.js";

const seam = vi.hoisted(() => ({ observation: null as any, publicOk: true, config: "",
  cloudflared: "fixture-cloudflared" as string | null,
  admin: vi.fn(), ensure: vi.fn(), stop: vi.fn() }));
vi.mock("../src/process/daemon.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/process/daemon.js")>(),
  findSharedBridgeObservation: vi.fn(async () => seam.observation),
  adminFetch: seam.admin, ensureBridge: seam.ensure, stopBridge: seam.stop,
}));
vi.mock("../src/tunnel/probe.js", () => ({ probePublicMcp: vi.fn(async (url: string) =>
  ({ ok: seam.publicOk, url, status: seam.publicOk ? 401 : 503, checkedAt: "now" })) }));
vi.mock("../src/tunnel/detect.js", () => ({ detectTunnelBinaries: () => ({ cloudflared: seam.cloudflared, wrangler: null }) }));
vi.mock("../src/config/sandbox-allow.js", () => ({
  getCodexConfigPath: () => seam.config, isStateDirAllowlisted: () => true,
  ensureSandboxAllowlist: () => ({ alreadyAllowed: true, added: false }),
}));

let base: string, state: string, a: Workspace, b: Workspace, output: string;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  base = makeTmpDir("g7a-cli");
  for (const name of ["a", "b", "state"]) fs.mkdirSync(path.join(base, name));
  a = new Workspace(path.join(base, "a")); b = new Workspace(path.join(base, "b")); state = path.join(base, "state");
  vi.stubEnv("C2C_STATE_DIR", state);
  seam.config = path.join(base, "config.toml"); fs.writeFileSync(seam.config, "");
  seam.publicOk = true; seam.cloudflared = "fixture-cloudflared"; output = "";
  const runtime = { workspaceId: a.id, workspaceRoot: a.root, pid: 900001, port: 50111, stateDir: state };
  seam.observation = { state: "healthy", shared: true, runtime, requestedWorkspace: { id: b.id, root: b.root },
    adminInfo: { ...runtime, workspaceName: a.name, publicUrl: "https://owner.example", tokenCount: 1,
      tunnel: { provider: "cloudflare-named", running: true, url: "https://owner.example" } } };
  seam.ensure.mockResolvedValue({ runtime, observation: seam.observation, spawned: false });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "http://127.0.0.1:50111/mcp") return new Response(null, { status: 401 });
    if (url === "http://127.0.0.1:50111/health") return new Response(JSON.stringify({ service: "c2c-bridge", workspaceId: a.id, status: "ok" }));
    throw new Error("Unexpected network request");
  }));
  vi.spyOn(process.stdout, "write").mockImplementation((text: any) => { output += text; return true; });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); cleanup(base); });
async function run(command: string, extra: string[] = []) {
  vi.spyOn(process, "argv", "get").mockReturnValue([process.execPath, "c2c", command, "--json", "--workspace", b.root, ...extra]);
  await import("../src/cli/index.js");
  await vi.waitFor(() => expect(output).toContain("\n"));
  return JSON.parse(output.trim());
}
it("doctor B reports healthy owner and persists B endpoint without writing A metadata", async () => {
  const result = await run("doctor", ["--no-fix"]);
  expect(result.report.tunnel).toEqual({ ok: true, detail: "https://owner.example" });
  expect(result.namedRepair.needed).toBe(false);
  const endpoint = JSON.parse(fs.readFileSync(path.join(state, "endpoints", `${b.id}.json`), "utf8"));
  expect(endpoint.workspaceId).toBe(b.id); expect(endpoint.publicUrl).toBe("https://owner.example");
  expect(fs.existsSync(path.join(state, "endpoints", `${a.id}.json`))).toBe(false);
  expect(seam.admin).not.toHaveBeenCalled(); expect(seam.stop).not.toHaveBeenCalled();
});
it("doctor with fix reports true owner tunnel down without quick fallback or shared restart", async () => {
  seam.publicOk = false;
  const result = await run("doctor");
  expect(result.report.tunnel).toEqual({ ok: false, detail: "NAMED_TUNNEL_DOWN" });
  expect(seam.admin).not.toHaveBeenCalled(); expect(seam.stop).not.toHaveBeenCalled(); expect(seam.ensure).not.toHaveBeenCalled();
});
it("start B persists the requested workspace endpoint while retaining owner runtime", async () => {
  const result = await run("start");
  expect(result.workspaceId).toBe(b.id);
  expect(fs.existsSync(path.join(state, "endpoints", `${b.id}.json`))).toBe(true);
  expect(fs.existsSync(path.join(state, "endpoints", `${a.id}.json`))).toBe(false);
  expect(seam.admin).not.toHaveBeenCalled();
});
it("second start --tunnel reuses healthy shared owner info without privileged tunnel mutation", async () => {
  const result = await run("start", ["--tunnel"]);
  expect(result).toMatchObject({ ok: true, workspaceId: b.id, mcpUrl: "https://owner.example/mcp" });
  expect(seam.ensure).toHaveBeenCalledWith(b.root, { stateDir: state });
  expect(seam.admin).not.toHaveBeenCalled(); expect(seam.stop).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(state, "runtime", `${b.id}.json`))).toBe(false);
});
it("status exposes requested workspace separately from actual owner and uses current owner tunnel", async () => {
  const result = await run("status");
  expect(result).toMatchObject({ ok: true, workspaceId: b.id, workspaceRoot: b.root,
    shared: true, ownerWorkspace: { id: a.id, root: a.root }, mode: "named", publicUrl: "https://owner.example" });
  expect(seam.admin).not.toHaveBeenCalled();
});

it("start --tunnel succeeds and reuses owner without admin tunnel mutation when cloudflared binary is missing but public URL is healthy", async () => {
  seam.cloudflared = null;
  const result = await run("start", ["--tunnel"]);
  expect(result).toMatchObject({ ok: true, workspaceId: b.id, mcpUrl: "https://owner.example/mcp" });
  expect(seam.ensure).toHaveBeenCalledWith(b.root, { stateDir: state });
  expect(seam.admin).not.toHaveBeenCalled();
  expect(seam.stop).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(state, "runtime", `${b.id}.json`))).toBe(false);
});

it("start --tunnel fails with NEED_CLOUDFLARED when cloudflared binary is missing and public URL is down", async () => {
  seam.cloudflared = null;
  seam.publicOk = false;
  const result = await run("start", ["--tunnel"]);
  expect(result.ok).toBe(false);
  expect(result.error).toContain("NEED_CLOUDFLARED");
  expect(seam.admin).not.toHaveBeenCalled();
});

it("start --tunnel honors explicit --state-dir for endpoint persistence without mutating default state dir", async () => {
  const customState = path.join(base, "custom-state");
  fs.mkdirSync(customState);
  seam.cloudflared = null;
  const customRuntime = { ...seam.observation.runtime, stateDir: customState };
  const customObservation = {
    ...seam.observation,
    runtime: customRuntime,
    adminInfo: { ...seam.observation.adminInfo, stateDir: customState },
  };
  seam.observation = customObservation;
  seam.ensure.mockResolvedValueOnce({ runtime: customRuntime, observation: customObservation, spawned: false });

  const result = await run("start", ["--tunnel", "--state-dir", customState]);
  expect(result).toMatchObject({ ok: true, workspaceId: b.id, mcpUrl: "https://owner.example/mcp" });
  expect(seam.ensure).toHaveBeenCalledWith(b.root, { stateDir: customState });
  expect(fs.existsSync(path.join(customState, "endpoints", `${b.id}.json`))).toBe(true);
  expect(fs.existsSync(path.join(state, "endpoints", `${b.id}.json`))).toBe(false);
  expect(seam.admin).not.toHaveBeenCalled();
});

it("start --tunnel succeeds and reuses owner named tunnel when bridge info has publicUrl null, tunnel.running false, and cloudflared is missing", async () => {
  seam.cloudflared = null;
  seam.observation.adminInfo = {
    ...seam.observation.adminInfo,
    publicUrl: null,
    tunnel: { provider: "cloudflare-named", running: false, url: null },
  };
  writeTunnelState(
    {
      workspaceId: a.id,
      preference: "named",
      provider: "cloudflare-named",
      hostname: "owner-named.example",
      tunnelName: "named-tun",
      tunnelId: "11111111-2222-3333-4444-555555555555",
    },
    state
  );

  const result = await run("start", ["--tunnel"]);
  expect(result).toMatchObject({ ok: true, workspaceId: b.id, mcpUrl: "https://owner-named.example/mcp" });
  expect(seam.ensure).toHaveBeenCalledWith(b.root, { stateDir: state });
  expect(seam.admin).not.toHaveBeenCalled();
  expect(seam.stop).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(state, "runtime", `${b.id}.json`))).toBe(false);
  expect(fs.existsSync(path.join(state, "endpoints", `${b.id}.json`))).toBe(true);
});

it("start --tunnel succeeds and reuses persisted endpoint when bridge info has publicUrl null, tunnel.running false, and cloudflared is missing", async () => {
  seam.cloudflared = null;
  seam.observation.adminInfo = {
    ...seam.observation.adminInfo,
    publicUrl: null,
    tunnel: { provider: null, running: false, url: null },
  };
  writeLastEndpoint(
    {
      workspaceId: b.id,
      port: 50111,
      publicUrl: "https://persisted-b.example",
      mcpUrl: "https://persisted-b.example/mcp",
      connectorName: "Codex with ChatGPT · B",
    },
    state
  );

  const result = await run("start", ["--tunnel"]);
  expect(result).toMatchObject({ ok: true, workspaceId: b.id, mcpUrl: "https://persisted-b.example/mcp" });
  expect(seam.ensure).toHaveBeenCalledWith(b.root, { stateDir: state });
  expect(seam.admin).not.toHaveBeenCalled();
  expect(seam.stop).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(state, "runtime", `${b.id}.json`))).toBe(false);
});

it("start --tunnel fails with NEED_CLOUDFLARED when persisted candidate is unhealthy and cloudflared is missing", async () => {
  seam.cloudflared = null;
  seam.publicOk = false;
  seam.observation.adminInfo = {
    ...seam.observation.adminInfo,
    publicUrl: null,
    tunnel: { provider: "cloudflare-named", running: false, url: null },
  };
  writeTunnelState(
    {
      workspaceId: a.id,
      preference: "named",
      provider: "cloudflare-named",
      hostname: "owner-down.example",
      tunnelName: "named-tun",
      tunnelId: "11111111-2222-3333-4444-555555555555",
    },
    state
  );

  const result = await run("start", ["--tunnel"]);
  expect(result.ok).toBe(false);
  expect(result.error).toContain("NEED_CLOUDFLARED");
  expect(seam.admin).not.toHaveBeenCalled();
});

it("shared owner uses owner state safely and does not fabricate requester runtime or adopt mismatched identity", async () => {
  seam.cloudflared = null;
  seam.observation.adminInfo = {
    ...seam.observation.adminInfo,
    publicUrl: null,
    tunnel: { provider: "cloudflare-named", running: false, url: null },
  };
  writeTunnelState(
    {
      workspaceId: a.id,
      preference: "named",
      provider: "cloudflare-named",
      hostname: "owner-safe.example",
      tunnelName: "named-tun",
      tunnelId: "11111111-2222-3333-4444-555555555555",
    },
    state
  );
  expect(fs.existsSync(path.join(state, "endpoints", `${b.id}.json`))).toBe(false);
  expect(fs.existsSync(path.join(state, "runtime", `${b.id}.json`))).toBe(false);

  const result = await run("start", ["--tunnel"]);
  expect(result).toMatchObject({ ok: true, workspaceId: b.id, mcpUrl: "https://owner-safe.example/mcp" });
  expect(fs.existsSync(path.join(state, "runtime", `${b.id}.json`))).toBe(false);
  expect(fs.existsSync(path.join(state, "endpoints", `${b.id}.json`))).toBe(true);
  const endpoint = JSON.parse(fs.readFileSync(path.join(state, "endpoints", `${b.id}.json`), "utf8"));
  expect(endpoint.workspaceId).toBe(b.id);
  expect(endpoint.publicUrl).toBe("https://owner-safe.example");
  expect(fs.existsSync(path.join(state, "endpoints", `${a.id}.json`))).toBe(false);
  expect(seam.admin).not.toHaveBeenCalled();
});

it("start --tunnel with custom stateDir reuses persisted candidate when bridge info has publicUrl null and cloudflared is missing", async () => {
  const customState = path.join(base, "custom-state-2");
  fs.mkdirSync(customState);
  seam.cloudflared = null;
  const customRuntime = { ...seam.observation.runtime, stateDir: customState };
  const customObservation = {
    ...seam.observation,
    runtime: customRuntime,
    adminInfo: {
      ...seam.observation.adminInfo,
      stateDir: customState,
      publicUrl: null,
      tunnel: { provider: "cloudflare-named", running: false, url: null },
    },
  };
  seam.observation = customObservation;
  seam.ensure.mockResolvedValueOnce({ runtime: customRuntime, observation: customObservation, spawned: false });

  writeTunnelState(
    {
      workspaceId: a.id,
      preference: "named",
      provider: "cloudflare-named",
      hostname: "custom-state-owner.example",
      tunnelName: "named-tun",
      tunnelId: "11111111-2222-3333-4444-555555555555",
    },
    customState
  );

  const result = await run("start", ["--tunnel", "--state-dir", customState]);
  expect(result).toMatchObject({ ok: true, workspaceId: b.id, mcpUrl: "https://custom-state-owner.example/mcp" });
  expect(seam.ensure).toHaveBeenCalledWith(b.root, { stateDir: customState });
  expect(fs.existsSync(path.join(customState, "endpoints", `${b.id}.json`))).toBe(true);
  expect(fs.existsSync(path.join(state, "endpoints", `${b.id}.json`))).toBe(false);
  expect(fs.existsSync(path.join(customState, "runtime", `${b.id}.json`))).toBe(false);
  expect(seam.admin).not.toHaveBeenCalled();
});

it("fail-closed identity ignores endpoint with mismatched workspaceId and falls back to NEED_CLOUDFLARED when no other candidate exists", async () => {
  seam.cloudflared = null;
  seam.observation.adminInfo = {
    ...seam.observation.adminInfo,
    publicUrl: null,
    tunnel: { provider: null, running: false, url: null },
  };
  fs.mkdirSync(path.join(state, "endpoints"), { recursive: true });
  fs.writeFileSync(
    path.join(state, "endpoints", `${b.id}.json`),
    JSON.stringify({
      workspaceId: "corrupted-id",
      port: 50111,
      publicUrl: "https://corrupted.example",
      mcpUrl: "https://corrupted.example/mcp",
    })
  );

  const result = await run("start", ["--tunnel"]);
  expect(result.ok).toBe(false);
  expect(result.error).toContain("NEED_CLOUDFLARED");
  expect(seam.admin).not.toHaveBeenCalled();
});

it("direct owner start --tunnel succeeds and reuses named tunnel when info has publicUrl null, tunnel.running false, and cloudflared is missing", async () => {
  seam.cloudflared = null;
  const runtime = { workspaceId: a.id, workspaceRoot: a.root, pid: 900001, port: 50111, stateDir: state };
  seam.observation = {
    state: "healthy",
    shared: false,
    runtime,
    adminInfo: {
      ...runtime,
      workspaceName: a.name,
      publicUrl: null,
      tokenCount: 1,
      tunnel: { provider: "cloudflare-named", running: false, url: null },
    },
  };
  seam.ensure.mockResolvedValue({ runtime, observation: seam.observation, spawned: false });

  writeTunnelState(
    {
      workspaceId: a.id,
      preference: "named",
      provider: "cloudflare-named",
      hostname: "owner-direct.example",
      tunnelName: "named-tun",
      tunnelId: "11111111-2222-3333-4444-555555555555",
    },
    state
  );

  vi.spyOn(process, "argv", "get").mockReturnValue([process.execPath, "c2c", "start", "--json", "--workspace", a.root, "--tunnel"]);
  output = "";
  await import("../src/cli/index.js");
  await vi.waitFor(() => expect(output).toContain("\n"));
  const result = JSON.parse(output.trim());

  expect(result).toMatchObject({ ok: true, workspaceId: a.id, mcpUrl: "https://owner-direct.example/mcp" });
  expect(seam.ensure).toHaveBeenCalledWith(a.root, { stateDir: state });
  expect(seam.admin).not.toHaveBeenCalled();
  expect(seam.stop).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(state, "endpoints", `${a.id}.json`))).toBe(true);
});

it("direct owner start --tunnel succeeds and reuses persisted endpoint when info has publicUrl null, tunnel.running false, and cloudflared is missing", async () => {
  seam.cloudflared = null;
  const runtime = { workspaceId: a.id, workspaceRoot: a.root, pid: 900001, port: 50111, stateDir: state };
  seam.observation = {
    state: "healthy",
    shared: false,
    runtime,
    adminInfo: {
      ...runtime,
      workspaceName: a.name,
      publicUrl: null,
      tokenCount: 1,
      tunnel: { provider: null, running: false, url: null },
    },
  };
  seam.ensure.mockResolvedValue({ runtime, observation: seam.observation, spawned: false });

  writeLastEndpoint(
    {
      workspaceId: a.id,
      port: 50111,
      publicUrl: "https://owner-persisted.example",
      mcpUrl: "https://owner-persisted.example/mcp",
      connectorName: "Codex with ChatGPT",
    },
    state
  );

  vi.spyOn(process, "argv", "get").mockReturnValue([process.execPath, "c2c", "start", "--json", "--workspace", a.root, "--tunnel"]);
  output = "";
  await import("../src/cli/index.js");
  await vi.waitFor(() => expect(output).toContain("\n"));
  const result = JSON.parse(output.trim());

  expect(result).toMatchObject({ ok: true, workspaceId: a.id, mcpUrl: "https://owner-persisted.example/mcp" });
  expect(seam.ensure).toHaveBeenCalledWith(a.root, { stateDir: state });
  expect(seam.admin).not.toHaveBeenCalled();
  expect(seam.stop).not.toHaveBeenCalled();
});


