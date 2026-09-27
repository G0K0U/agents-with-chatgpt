# Z2C Remote Pairing & Auth Design (Phase 2)

Date: 2026-09-21
Status: design prepared — no production cloud relay in this phase. The local bridge + MCP surface shipped; the pairing/relay flow below is the target for the distributable release.

## Goal

A user installs Z2C, connects ChatGPT with one explicit action, and ChatGPT receives a NARROW, revocable, semantic control capability. ZCode keeps credentials, permissions, and model state natively at every step.

```
Install Z2C
   ↓  (Z2C bridge starts, loopback only, official provider spawns app-server per workspace)
Connect ChatGPT  (one local action)
   ↓  one-time pairing code / browser authorization
Select authorized workspace(s)   (per-workspace scopes)
   ↓  outbound secure bridge (tunnel) — no inbound firewall/NAT config
Scoped semantic session controls (MCP tools only; no raw RPC)
```

## Local authentication (shipped behavior)

- The bridge binds `127.0.0.1` only.
- On first run it generates `z2c_<32 bytes hex>` into `%LOCALAPPDATA%\z2c\auth.json` (0400-equivalent user-only ACL). All local MCP traffic presents this bearer token.
- The token is machine-local and never synced, logged, or embedded in tool results.

## Pairing flow (design)

1. User runs `z2c connect` (or clicks "Connect ChatGPT" in the tray). The bridge:
   - generates a single-use pairing code (6 digits, 5-minute TTL, bounded attempts),
   - starts a short loopback HTTP callback listener,
   - displays the code + an authorization URL.
2. The user authorizes in the browser (ChatGPT connector flow or Z2C account). The remote bridge receives: `bridgeId`, the pairing code proof, and a public-key handshake (client generates an ed25519 keypair at first connect; the private key never leaves the machine).
3. On success the bridge issues a **scoped capability token** to the remote side:

| Field | Content |
| --- | --- |
| `sub` | remote principal (ChatGPT account id) |
| `scopes` | per-workspace: `workspace:<id>:session.create/read/send` etc. |
| `labs` | semantic tool allow-list (see below) |
| `exp` / `iat` | token lifetime |
| `jti` | revocation id |

4. Pairing code is burned on first use (replay of the code is useless).

## Token lifetime, replay, revocation

- Capability token: 30-day rolling lifetime, rotated on each refresh; refresh requires the SAME keypair (binds token to device).
- Replay prevention: every control request carries `(jti, nonce, timestamp)`; the bridge rejects stale timestamps (>60 s skew) and seen nonces (bounded LRU, persisted across restart).
- Disconnect/revoke: `z2c disconnect` deletes the stored principal + key binding and revokes the `jti` (bridged relays are notified on next heartbeat; worst case the token dies at its short TTL). Revocation is local-first — no cloud dependency for safety.

## Workspace scopes & session ownership

- Sessions are created only in authorized, canonicalized workspaces (registry-gated since Phase 1). The capability token enumerates workspace ids; the bridge re-validates EVERY call against the registry (revoking a workspace takes effect immediately, not at token refresh).
- Session ownership: a session created by the remote principal is tagged with that principal's id in the bridge task record. Read/send/stop on a session require: authorized workspace AND (owner principal OR explicit share). Cross-principal session confusion is structurally impossible (session ids are verified via exact-session readback against the authorized workspace before every dispatch).
- Multi-workspace: scopes are independent; revoking one workspace never affects others. Every admission re-checks both the workspace authorization and the observed native binding (model/plan) — so a stale token cannot outlive a policy change.

## Cross-user isolation

- The bridge is per-Windows-user (state under `%LOCALAPPDATA%\z2c`, ZCode store under `~/.zcode`). Another local user cannot read the bearer token or the credential store; another LOCAL process cannot control Z2C without the bearer token (loopback + token), and cannot control the agent processes at all (stdio-only children).
- Remote principals are namespaced; task ids, sessions, and audit records carry the principal.

## What is explicitly out of scope for raw access

- No `rpc_call(method, params)` tool — the remote surface is the semantic tool list only (`zcode_session_*`, `zcode_workspace_list`, `zcode_runtime_capabilities`).
- No provider credentials, auth headers, cookies, or tokens in any tool result (regression-tested; see `test/security.test.ts`).
- Permission asks (`interaction/requestPermission`) remain fail-closed rejected for unattended lanes; a future `zcode_permission_respond` must be a separately scoped, audited, allow-listed capability that NEVER grants `yolo`.

## Implementation status

| Piece | Status |
| --- | --- |
| Loopback bridge + bearer token | shipped (Phase 1) |
| Workspace registry + canonicalization + authorization | shipped (Phase 1) |
| Semantic MCP tools (submit/resume/read/status) | shipped |
| Full semantic tool set (events/messages/stop/close/set_model/set_thought_level/set_mode) | prepared — direct mappings of `AgentProvider` methods (see `docs/z2c-target-architecture.md`) |
| Pairing code + keypair + capability token | design (this doc) — no production relay required to build it |
| Outbound tunnel transport | existing tunnel work in the sibling c2c tree reusable; integration scheduled post-pairing |
