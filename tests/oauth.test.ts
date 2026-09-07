import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { AuthStore, filterScopes } from "../src/auth/store.js";
import { Workspace } from "../src/workspace/manager.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import { makeTmpDir, cleanup, write, isolateStateDir, pkceVerifierAndChallenge } from "./helpers.js";

let root: string;
let bridge: Bridge;
let base: string;

const REDIRECT_URI = "http://127.0.0.1:19999/callback";

describe("OAuth scope defaults", () => {
  it("never grants execution authority to an omitted or unknown scope request", () => {
    expect(filterScopes(undefined)).not.toContain("execution.submit");
    expect(filterScopes(undefined)).not.toContain("execution.cancel");
    expect(filterScopes(undefined)).not.toContain("execution.queue");
    expect(filterScopes(undefined)).not.toContain("audit_mirror.write");
    expect(filterScopes("unknown.scope")).not.toContain("execution.submit");
    expect(filterScopes("execution.submit execution.cancel")).toEqual([
      "execution.submit",
      "execution.cancel",
    ]);
    expect(filterScopes("execution.queue")).toEqual(["execution.queue"]);
    expect(filterScopes("audit_mirror.write")).toEqual(["audit_mirror.write"]);
  });
});

beforeAll(async () => {
  isolateStateDir();
  root = makeTmpDir("oauth-ws");
  write(root, "hello.txt", "hello oauth\n");
  bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("auth"), "store.json"),
  });
  base = bridge.localBaseUrl();
});

afterAll(async () => {
  await bridge.close();
  cleanup(root);
});

async function registerClient(): Promise<string> {
  const response = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT-Test", redirect_uris: [REDIRECT_URI] }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

function makeAuthorizeUrl(baseUrl: string, clientId: string, redirectUri = REDIRECT_URI): URL {
  const { challenge } = pkceVerifierAndChallenge();
  const authorizeUrl = new URL(`${baseUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  return authorizeUrl;
}

async function authorizeWithPairing(
  clientId: string,
  challenge: string,
  pairingCode: string,
  state = "st-123"
): Promise<{ code: string | null; location: string | null; page?: string; status?: number }> {
  const authorizeUrl = new URL(`${base}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("scope", "workspace.read workspace.search git.read execution.read offline_access");

  const pageResponse = await fetch(authorizeUrl, { redirect: "manual" });
  const html = await pageResponse.text();
  const requestId = html.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
  if (!requestId) return { code: null, location: null, page: html, status: pageResponse.status };

  const postResponse = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId, pairing_code: pairingCode }),
    redirect: "manual",
  });
  if (postResponse.status !== 302) {
    return { code: null, location: null, page: await postResponse.text(), status: postResponse.status };
  }
  const location = postResponse.headers.get("location");
  const code = location ? new URL(location).searchParams.get("code") : null;
  return { code, location, status: postResponse.status };
}

async function exchangeToken(
  clientId: string,
  code: string,
  verifier: string
): Promise<{ status: number; body: Record<string, string> }> {
  const response = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

describe("discovery metadata", () => {
  it("serves protected resource metadata", async () => {
    const response = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toContain("/mcp");
    expect(body.authorization_servers.length).toBe(1);
  });

  it("serves authorization server metadata with PKCE S256", async () => {
    const response = await fetch(`${base}/.well-known/oauth-authorization-server`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(body.registration_endpoint).toContain("/oauth/register");
  });
});

describe("OAuth client persistence", () => {
  it("keeps the same registered client valid after bridge restart", async () => {
    const restartRoot = makeTmpDir("oauth-restart-ws");
    write(restartRoot, "hello.txt", "restart persistence\n");
    const authFile = path.join(makeTmpDir("oauth-restart-auth"), "bridge.json");
    const first = await startBridge({ workspaceRoot: restartRoot, port: 0, persistRuntime: false, authStoreFile: authFile });
    let clientId: string;
    try {
      const registration = await fetch(`${first.localBaseUrl()}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "restart-test", redirect_uris: [REDIRECT_URI] }),
      });
      expect(registration.status).toBe(201);
      clientId = ((await registration.json()) as { client_id: string }).client_id;
    } finally {
      await first.close();
    }

    const second = await startBridge({ workspaceRoot: restartRoot, port: 0, persistRuntime: false, authStoreFile: authFile });
    try {
      const { challenge } = pkceVerifierAndChallenge();
      const authorizeUrl = new URL(`${second.localBaseUrl()}/oauth/authorize`);
      authorizeUrl.searchParams.set("client_id", clientId!);
      authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      const response = await fetch(authorizeUrl, { redirect: "manual" });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('name="request_id"');
    } finally {
      await second.close();
      cleanup(restartRoot);
    }
  });

  it("reloads a client persisted by another bridge instance before rejecting authorize", async () => {
    const previousStateDir = process.env.C2C_STATE_DIR;
    const stateDir = isolateStateDir();
    const restartRoot = makeTmpDir("oauth-live-reload-ws");
    write(restartRoot, "hello.txt", "live registry reload\n");
    let stale: Bridge | undefined;
    let writer: Bridge | undefined;
    try {
      // The stale instance models the bridge that was already running when
      // another instance completed ChatGPT's dynamic client registration.
      stale = await startBridge({ workspaceRoot: restartRoot, port: 0, persistRuntime: false });
      writer = await startBridge({ workspaceRoot: restartRoot, port: 0, persistRuntime: false });
      const registration = await fetch(`${writer.localBaseUrl()}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "live-reload-test", redirect_uris: [REDIRECT_URI] }),
      });
      expect(registration.status).toBe(201);
      const clientId = ((await registration.json()) as { client_id: string }).client_id;
      await writer.close();
      writer = undefined;

      expect(fs.existsSync(path.join(stateDir, "auth", "bridge.json"))).toBe(true);
      const response = await fetch(makeAuthorizeUrl(stale.localBaseUrl(), clientId), { redirect: "manual" });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('name="request_id"');
    } finally {
      await writer?.close();
      await stale?.close();
      cleanup(restartRoot);
      cleanup(stateDir);
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  });

  it("keeps the existing client across fresh bootstrap, registry changes, and named tunnel configuration", async () => {
    const previousStateDir = process.env.C2C_STATE_DIR;
    const stateDir = isolateStateDir();
    const firstRoot = makeTmpDir("oauth-bootstrap-first");
    const secondRoot = makeTmpDir("oauth-bootstrap-second");
    write(firstRoot, "hello.txt", "first workspace\n");
    write(secondRoot, "hello.txt", "second workspace\n");
    let first: Bridge | undefined;
    let second: Bridge | undefined;
    try {
      first = await startBridge({ workspaceRoot: firstRoot, port: 0, persistRuntime: false });
      const registration = await fetch(`${first.localBaseUrl()}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "bootstrap-test", redirect_uris: [REDIRECT_URI] }),
      });
      expect(registration.status).toBe(201);
      const clientId = ((await registration.json()) as { client_id: string }).client_id;
      await first.close();
      first = undefined;

      const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, "auth", "bridge.json"), "utf8")) as {
        clients: Array<{ clientId: string }>;
      };
      expect(persisted.clients.some((client) => client.clientId === clientId)).toBe(true);

      const secondWorkspace = new Workspace(secondRoot);
      writeTunnelState({
        workspaceId: secondWorkspace.id,
        preference: "named",
        tunnelName: "c2c-reconnect",
        tunnelId: "52087d82-cd6f-461c-add4-cc52050e205f",
        hostname: "c2c.example.test",
        zone: "example.test",
      });
      second = await startBridge({ workspaceRoot: secondRoot, port: 0, persistRuntime: false });
      expect(second.tunnel.name).toBe("cloudflare-named");

      const response = await fetch(makeAuthorizeUrl(second.localBaseUrl(), clientId), { redirect: "manual" });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('name="request_id"');
    } finally {
      await second?.close();
      await first?.close();
      cleanup(firstRoot);
      cleanup(secondRoot);
      cleanup(stateDir);
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  });

  it("fails safely on malformed persisted auth state", async () => {
    const previousStateDir = process.env.C2C_STATE_DIR;
    const stateDir = isolateStateDir();
    const malformedRoot = makeTmpDir("oauth-malformed-state");
    write(malformedRoot, "hello.txt", "malformed auth state\n");
    let malformed: Bridge | undefined;
    try {
      const authDir = path.join(stateDir, "auth");
      fs.mkdirSync(authDir, { recursive: true });
      fs.writeFileSync(path.join(authDir, "bridge.json"), JSON.stringify({ clients: {}, tokens: {} }));
      malformed = await startBridge({ workspaceRoot: malformedRoot, port: 0, persistRuntime: false });
      expect((await fetch(`${malformed.localBaseUrl()}/health`)).status).toBe(200);
      const response = await fetch(makeAuthorizeUrl(malformed.localBaseUrl(), "c2c_client_unknown"), { redirect: "manual" });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Unknown client");
    } finally {
      await malformed?.close();
      cleanup(malformedRoot);
      cleanup(stateDir);
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  });

  it("rejects an unknown OAuth client while preserving fail-closed authorize behavior", async () => {
    const response = await fetch(makeAuthorizeUrl(base, "c2c_client_unknown"), { redirect: "manual" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Unknown client");
  });

  it("does not let a stale bridge writer erase a client registered by another process", () => {
    const authRoot = makeTmpDir("oauth-concurrent-auth");
    const authFile = path.join(authRoot, "bridge.json");
    try {
      // Both stores load the empty file before either mutation. This models
      // separate workspace bridge processes sharing the bridge-wide registry.
      const staleWriter = new AuthStore("stale-workspace", { file: authFile });
      const registeringWriter = new AuthStore("registering-workspace", { file: authFile });
      const client = registeringWriter.registerClient({
        clientName: "concurrent-client",
        redirectUris: [REDIRECT_URI],
      });

      staleWriter.issueTokens({
        clientId: "unrelated-client",
        scopes: ["workspace.read"],
        workspaceId: "stale-workspace",
      });

      const restarted = new AuthStore("restarted-workspace", { file: authFile });
      expect(restarted.getClient(client.clientId)).toEqual(client);
    } finally {
      cleanup(authRoot);
    }
  });

  it("keeps token-to-client association through reload and refresh rotation", () => {
    const authRoot = makeTmpDir("oauth-token-association");
    const authFile = path.join(authRoot, "bridge.json");
    try {
      const first = new AuthStore("token-workspace", { file: authFile });
      const client = first.registerClient({ clientName: "token-client", redirectUris: [REDIRECT_URI] });
      const issued = first.issueTokens({
        clientId: client.clientId,
        scopes: ["workspace.read", "offline_access"],
        workspaceId: "token-workspace",
      });

      const restarted = new AuthStore("token-workspace", { file: authFile });
      const verified = restarted.verifyAccessToken(issued.accessToken);
      expect(verified.ok).toBe(true);
      if (verified.ok) expect(verified.record.clientId).toBe(client.clientId);

      const rotated = restarted.refresh(issued.refreshToken!, client.clientId);
      expect(rotated.ok).toBe(true);
      if (rotated.ok) {
        const rotatedAccess = restarted.verifyAccessToken(rotated.tokens.accessToken);
        expect(rotatedAccess.ok).toBe(true);
        if (rotatedAccess.ok) expect(rotatedAccess.record.clientId).toBe(client.clientId);
      }
      expect(restarted.refresh(issued.refreshToken!, client.clientId)).toEqual({
        ok: false,
        reason: "invalid_grant",
      });
    } finally {
      cleanup(authRoot);
    }
  });

  it("preserves healthy clients when an unrelated persisted client row is malformed", () => {
    const authRoot = makeTmpDir("oauth-corrupt-row");
    const authFile = path.join(authRoot, "bridge.json");
    try {
      const first = new AuthStore("corrupt-row-workspace", { file: authFile });
      const healthy = first.registerClient({ clientName: "healthy-client", redirectUris: [REDIRECT_URI] });
      const state = JSON.parse(fs.readFileSync(authFile, "utf8")) as {
        clients: unknown[];
        tokens: unknown[];
      };
      state.clients.push({ clientId: "c2c_client_malformed", redirectUris: ["not-a-url"] });
      fs.writeFileSync(authFile, JSON.stringify(state));

      const restarted = new AuthStore("corrupt-row-workspace", { file: authFile });
      expect(restarted.getClient(healthy.clientId)).toEqual(healthy);
      const replacement = restarted.registerClient({ clientName: "replacement-client", redirectUris: [REDIRECT_URI] });
      const finalStore = new AuthStore("corrupt-row-workspace", { file: authFile });
      expect(finalStore.getClient(healthy.clientId)).toEqual(healthy);
      expect(finalStore.getClient(replacement.clientId)).toEqual(replacement);
      expect(finalStore.getClient("c2c_client_malformed")).toBeUndefined();
    } finally {
      cleanup(authRoot);
    }
  });

  it("recovers an interrupted stale registry lock without replacing the state file", () => {
    const authRoot = makeTmpDir("oauth-stale-lock");
    const authFile = path.join(authRoot, "bridge.json");
    const lockFile = `${authFile}.lock`;
    try {
      const first = new AuthStore("lock-workspace", { file: authFile });
      const healthy = first.registerClient({ clientName: "lock-client", redirectUris: [REDIRECT_URI] });
      fs.writeFileSync(lockFile, "");
      const staleTime = new Date(Date.now() - 120_000);
      fs.utimesSync(lockFile, staleTime, staleTime);

      const restarted = new AuthStore("lock-workspace", { file: authFile });
      const replacement = restarted.registerClient({ clientName: "after-lock", redirectUris: [REDIRECT_URI] });
      const finalStore = new AuthStore("lock-workspace", { file: authFile });
      expect(finalStore.getClient(healthy.clientId)).toEqual(healthy);
      expect(finalStore.getClient(replacement.clientId)).toEqual(replacement);
      expect(fs.existsSync(lockFile)).toBe(false);
    } finally {
      cleanup(authRoot);
    }
  });

  it("does not remove an old but still registered client during reload", () => {
    const authRoot = makeTmpDir("oauth-active-old-client");
    const authFile = path.join(authRoot, "bridge.json");
    try {
      const first = new AuthStore("old-client-workspace", { file: authFile });
      const client = first.registerClient({ clientName: "old-but-valid", redirectUris: [REDIRECT_URI] });
      const state = JSON.parse(fs.readFileSync(authFile, "utf8")) as {
        clients: Array<Record<string, unknown>>;
        tokens: unknown[];
      };
      state.clients[0].createdAt = "2000-01-01T00:00:00.000Z";
      fs.writeFileSync(authFile, JSON.stringify(state));

      const restarted = new AuthStore("old-client-workspace", { file: authFile });
      expect(restarted.getClient(client.clientId)?.clientId).toBe(client.clientId);
    } finally {
      cleanup(authRoot);
    }
  });
});

describe("authorization + token flow", () => {
  it("completes the full pairing + PKCE flow and calls MCP", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code, location } = await authorizeWithPairing(clientId, challenge, pairing.code);
    expect(code).toBeTruthy();
    expect(location).toContain("state=st-123");

    const token = await exchangeToken(clientId, code!, verifier);
    expect(token.status).toBe(200);
    expect(token.body.access_token).toMatch(/^c2c_at_/);
    expect(token.body.refresh_token).toMatch(/^c2c_rt_/);
    expect(token.body.token_type).toBe("Bearer");

    // authorized MCP request
    const mcpResponse = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.body.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(mcpResponse.status).toBe(200);
  });

  it("rejects a wrong pairing code", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    bridge.pairing.create();
    const result = await authorizeWithPairing(clientId, challenge, "AAAA-AAAA");
    expect(result.code).toBeNull();
    expect(result.status).toBe(401);
    expect(result.page).toContain("Incorrect pairing code");
  });

  it("escapes the workspace name in the pairing page", async () => {
    const xssWorkspaceRoot = makeTmpDir("oauth-html");
    write(xssWorkspaceRoot, ".c2c.json", JSON.stringify({ name: "<script>alert('xss')</script>" }));
    const xssBridge = await startBridge({
      workspaceRoot: xssWorkspaceRoot,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth-html"), "store.json"),
    });

    try {
      const xssBase = xssBridge.localBaseUrl();
      const registration = await fetch(`${xssBase}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "HTML-Test", redirect_uris: [REDIRECT_URI] }),
      });
      expect(registration.status).toBe(201);
      const client = (await registration.json()) as { client_id: string };
      const { challenge } = pkceVerifierAndChallenge();

      const authorizeUrl = new URL(`${xssBase}/oauth/authorize`);
      authorizeUrl.searchParams.set("client_id", client.client_id);
      authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      const response = await fetch(authorizeUrl, { redirect: "manual" });
      expect(response.status).toBe(200);
      const html = await response.text();

      expect(html).not.toContain("<script>alert('xss')</script>");
      expect(html).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
    } finally {
      await xssBridge.close();
      cleanup(xssWorkspaceRoot);
    }
  });

  it("sets browser security headers on the pairing page", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const response = await fetch(authorizeUrl, { redirect: "manual" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; base-uri 'none'; frame-ancestors 'none'"
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("rejects PKCE verifier mismatch", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const token = await exchangeToken(clientId, code!, "wrong-verifier-wrong-verifier-wrong");
    expect(token.status).toBe(400);
    expect(token.body.error).toBe("invalid_grant");
  });

  it("authorization codes are one-time", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const first = await exchangeToken(clientId, code!, verifier);
    expect(first.status).toBe(200);
    const second = await exchangeToken(clientId, code!, verifier);
    expect(second.status).toBe(400);
  });

  it("requires PKCE at the authorization endpoint", async () => {
    const clientId = await registerClient();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    const response = await fetch(authorizeUrl, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("error=invalid_request");
  });

  it("rejects registration with non-https redirect uris", async () => {
    const response = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example.com/cb"] }),
    });
    expect(response.status).toBe(400);
  });
});

describe("token enforcement on /mcp", () => {
  const mcpCall = (token?: string): Promise<Response> =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

  it("401 without a token, with resource metadata pointer", async () => {
    const response = await mcpCall();
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("401 with an invalid token", async () => {
    const response = await mcpCall("c2c_at_totally-invalid");
    expect(response.status).toBe(401);
  });

  it("401 with an expired token", async () => {
    const expired = bridge.authStore.issueTokens({
      clientId: "test",
      scopes: ["workspace.read"],
      accessTtlMs: -1000,
    });
    const response = await mcpCall(expired.accessToken);
    expect(response.status).toBe(401);
  });

  it("403 with a token bound to another workspace", async () => {
    const foreign = bridge.authStore.issueTokens({
      clientId: "test",
      scopes: ["workspace.read"],
      workspaceId: "deadbeef0000",
    });
    const response = await mcpCall(foreign.accessToken);
    expect(response.status).toBe(403);
  });

  it("401 after revocation", async () => {
    const tokens = bridge.authStore.issueTokens({ clientId: "test", scopes: ["workspace.read"] });
    expect((await mcpCall(tokens.accessToken)).status).toBe(200);
    bridge.authStore.revokeToken(tokens.accessToken);
    expect((await mcpCall(tokens.accessToken)).status).toBe(401);
  });
});

describe("refresh token rotation", () => {
  it("rotates refresh tokens and invalidates the old one", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const initial = await exchangeToken(clientId, code!, verifier);

    const refresh = async (refreshToken: string): Promise<{ status: number; body: Record<string, string> }> => {
      const response = await fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, string> };
    };

    const rotated = await refresh(initial.body.refresh_token);
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(initial.body.refresh_token);

    const replayed = await refresh(initial.body.refresh_token);
    expect(replayed.status).toBe(400);
  });
});
