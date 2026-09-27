import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const REQUIRED_SHARED_TOOLS = [
  "agent_session_list", "agent_session_read", "agent_session_messages",
  "agent_activity_list", "agent_task_read", "agent_output_read",
];

async function request(url, init = {}) {
  const response = await fetch(url, {
    redirect: "manual", signal: AbortSignal.timeout(10_000), ...init,
  });
  const body = await response.text();
  if (body.length > 128 * 1024) throw new Error("OAuth probe response exceeded its size limit");
  return { response, body };
}

function expectStatus(actual, expected, stage) {
  if (actual !== expected) throw new Error(`${stage}: HTTP ${actual}, expected ${expected}`);
}

/** Read only through a token supplied by an already authorized identity. */
export async function probeExistingAuthorizedMcp({ publicBase, token, expectedWorkspaceId }) {
  if (!/^https:\/\//.test(publicBase) || !token || !/^[a-f0-9]{12}$/.test(expectedWorkspaceId)) {
    throw new Error("Existing authorized MCP probe inputs are invalid");
  }
  const client = new Client({ name: "a2c-release-acceptance", version: "1.0.0" });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(`${publicBase}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" },
    });
    await client.connect(transport);
    const tools = await client.listTools();
    const names = new Set(tools.tools.map((tool) => tool.name));
    const info = await client.callTool({ name: "workspace_info", arguments: {} });
    if (info.isError) throw new Error("workspace_info read failed");
    const payload = JSON.parse(info.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
    if (payload.workspaceId !== expectedWorkspaceId) throw new Error("authenticated workspace binding mismatch");
    return {
      ok: true, server: client.getServerVersion()?.name ?? null,
      toolsCount: names.size, sharedToolsPresent: REQUIRED_SHARED_TOOLS.every((name) => names.has(name)),
      workspaceId: payload.workspaceId,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Exercise the actual local pairing + OAuth PKCE flow, then connect to MCP
 * through the selected route. A fresh read-only client is revoked in finally.
 * Codes, bearer tokens, and tool payloads never enter the returned evidence.
 */
export async function probeAuthenticatedMcp({ publicBase, localBase, adminToken, expectedWorkspaceId }) {
  if (!/^https?:\/\//.test(publicBase) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(localBase) ||
      !adminToken || !/^[a-f0-9]{12}$/.test(expectedWorkspaceId)) {
    throw new Error("OAuth probe inputs are invalid");
  }
  const callback = "http://127.0.0.1:19000/a2c-release-acceptance";
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let token = null;
  let client = null;
  try {
    const registration = await request(`${publicBase}/oauth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "A2C release acceptance", redirect_uris: [callback] }),
    });
    expectStatus(registration.response.status, 201, "client registration");
    const clientId = JSON.parse(registration.body).client_id;
    if (typeof clientId !== "string" || !clientId) throw new Error("OAuth client id missing");

    const authUrl = new URL(`${publicBase}/oauth/authorize`);
    for (const [key, value] of Object.entries({
      response_type: "code", client_id: clientId, redirect_uri: callback,
      code_challenge: challenge, code_challenge_method: "S256",
      scope: "workspace.read execution.read git.read",
    })) authUrl.searchParams.set(key, value);
    const authorization = await request(authUrl);
    expectStatus(authorization.response.status, 200, "authorization request");
    const requestId = /name="request_id" value="([a-f0-9]+)"/.exec(authorization.body)?.[1];
    if (!requestId) throw new Error("OAuth request id missing");

    const pairing = await request(`${localBase}/admin/pairing`, {
      method: "POST", headers: { authorization: `Bearer ${adminToken}` },
    });
    expectStatus(pairing.response.status, 200, "local pairing");
    const pairingCode = JSON.parse(pairing.body).code;
    if (typeof pairingCode !== "string" || !pairingCode) throw new Error("pairing code missing");
    const approval = await request(`${publicBase}/oauth/authorize`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId, pairing_code: pairingCode }),
    });
    expectStatus(approval.response.status, 302, "pairing approval");
    const location = approval.response.headers.get("location");
    if (!location) throw new Error("OAuth authorization redirect missing");
    const redirected = new URL(location);
    if (redirected.origin !== new URL(callback).origin || redirected.pathname !== new URL(callback).pathname) {
      throw new Error("OAuth authorization redirected to a different callback");
    }
    const code = redirected.searchParams.get("code");
    if (!code) throw new Error("OAuth authorization code missing");

    const exchange = await request(`${publicBase}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code,
        code_verifier: verifier, client_id: clientId, redirect_uri: callback }),
    });
    expectStatus(exchange.response.status, 200, "token exchange");
    token = JSON.parse(exchange.body).access_token;
    if (typeof token !== "string" || !token) throw new Error("OAuth access token missing");

    client = new Client({ name: "a2c-release-acceptance", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${publicBase}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" },
    });
    await client.connect(transport);
    const tools = await client.listTools();
    const names = new Set(tools.tools.map((tool) => tool.name));
    const info = await client.callTool({ name: "workspace_info", arguments: {} });
    if (info.isError) throw new Error("workspace_info read failed");
    const payload = JSON.parse(info.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
    if (payload.workspaceId !== expectedWorkspaceId) throw new Error("authenticated workspace binding mismatch");
    return {
      ok: true, server: client.getServerVersion()?.name ?? null,
      toolsCount: names.size, sharedToolsPresent: REQUIRED_SHARED_TOOLS.every((name) => names.has(name)),
      workspaceId: payload.workspaceId,
    };
  } finally {
    await client?.close().catch(() => undefined);
    if (token) {
      await request(`${publicBase}/oauth/revoke`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      }).catch(() => undefined);
    }
  }
}
