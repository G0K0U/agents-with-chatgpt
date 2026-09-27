# Z2C Pairing Protocol

Date: 2026-09-21 (Phase 3). Local prototype shipped (`src/authz/pairing.ts`, management API, `z2c pair …`); designed to be lifted verbatim into the future ChatGPT connector/relay flow (see `docs/z2c-remote-pairing-design.md`).

## Three separate authorizations

| Layer | What it proves | Who grants it | Stored in |
| --- | --- | --- | --- |
| **Device pairing** | "this device may call Z2C's semantic tools" | local user (one-time code confirmation) | `pairing.json` (token hash only) |
| **Workspace authorization** | "sessions may run in this workspace" | local user (`z2c workspace authorize`) | `grants.json` |
| **Session authorization** | "this principal owns/controls THIS session" | derived: creator principal + exact-session attestation | `ownership.json` |

Pairing success alone authorizes NOTHING: a newly paired client can call `zcode_workspace_list` (sees only what the user granted) and can only create sessions in granted workspaces. A pairing credential can never become a provider credential — Z2C never handles provider credentials at all.

## State machine

```
UNPAIRED ──beginPairing(deviceName)──▶ PAIRING_PENDING ──confirmPairing(id, code)──▶ PAIRED
              (no change on failure)        │ expiry / burn / attempts                 │
                                            ▼                                          ▼
                                        UNPAIRED ◀──────────────── revoke(clientId) ──┘
                                                                       (re-pair = new PAIRING_PENDING)
```

## Wire details (management API, service-secret authenticated)

- `POST /api/pairing/begin {deviceName}` → `{pairingId, code, expiresAt}` — 6-digit code, 5-minute TTL, ≤3 concurrent pending requests, ≤5 attempts each, single-use (burned on success or attempt exhaustion).
- `POST /api/pairing/confirm {pairingId, code}` → `{clientId, token, deviceName}` — the client token `z2cpair_<64 hex>` is shown EXACTLY ONCE; only its SHA-256 is persisted. Comparison is constant-time; expiry is honored even across service restarts (state is reloaded from disk).
- `GET /api/pairing/clients`, `POST /api/pairing/revoke {clientId}` — revocation is immediate (auth check consults `revokedAt` on every request).
- Paired clients authenticate as `Bearer <token>` on `/mcp` and get principal `{kind:"client", clientId}`. The management API (`/api/*`) remains service-secret-only.

## Replay / theft threat model

| Threat | Mitigation |
| --- | --- |
| Replayed pairing confirmation | single-use burn + 5-min TTL + attempt bound |
| Stale pairing token | revocation list checked on every request; tokens rotate on re-pair |
| Stolen client token | hash-only storage; revoke + re-pair; token binds to semantic scope only (no management, no provider credentials, no raw RPC) |
| Copied state directory | per-user directory ACLs; token useless off-machine (service binds loopback); install identity + service secret do not travel |
| Cross-user on one machine | separate `%LOCALAPPDATA%\z2c` per user; service is per-user |
| Session-id guessing | ownership registry rejects unknown sessions (`SESSION_NOT_OWNED`) |
| Workspace-path guessing | only canonical granted workspaces; exact-session readback binds session↔workspace |
