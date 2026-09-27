# Z2C Local Service

Date: 2026-09-21 (Phase 3)
Entry: `npm run service` (foreground) or `z2c start` (detached) — Windows-first.

## Process ownership

One long-running, per-user service process (`Z2C Service` scheduled task at logon, or manual `z2c start`) owns:

- the loopback HTTP server (`127.0.0.1:<port>`): `/health`, `/mcp`, `/api/*`
- the `ZcodeOfficialProvider` and **its** `zcode app-server --stdio` children (one child; session-scoped runtimes live inside it)
- all authorization state (grants, pairing, ownership) and the durable task store

The service is the ONLY component that spawns agent children. ChatGPT/clients never do.

## State directory (`%LOCALAPPDATA%\z2c`, per-user)

| File | Schema v | Content |
| --- | --- | --- |
| `state.json` | 1 | durable task store (tasks/queues/outputs/legacy workspace entries) — unchanged since Phase 1 |
| `security.json` | 1 | `installId` + service secret(s) (`{id, secret, createdAt, retiredAt?}`, rotation grace 24 h). Values never printed; only fingerprints appear in status/doctor |
| `auth.json` | 1 | legacy MCP bearer token (Phase 1 compatibility; kept in sync semantics — service secret is authoritative for `/api`) |
| `grants.json` | 1 | workspace grants: `{workspaceId, canonicalPath, displayName, permissions:{read,write}, grantedAt, grantedBy:"local-user", revokedAt?}` |
| `pairing.json` | 1 | pending pairing requests + paired clients (`clientId`, `tokenHash` only, `deviceName`, `pairedAt`, `revokedAt?`) |
| `ownership.json` | 1 | Z2C-owned sessions: `{sessionId, workspaceId, clientId, accessMode, createdAt, lastUsedAt}` |
| `service.json` | 1 | PID file: `{pid, installId, startedAt, port, protocolVersion}` |
| `children.json` | 1 | recorded agent child pids (for orphan cleanup) |
| `audit/audit.log` | — | append-only audit (no secrets, no conversation content) |
| `service-out.log` | — | daemon stdout/stderr when detached |

## Startup

`z2c start`:

1. refuses to start if `service.json` points at a LIVE process (single instance); a STALE pid file (dead pid) is replaced;
2. runs orphan cleanup (below);
3. loads all state, starts the official provider (fail-loud: no legacy downgrade), starts supervision + HTTP server;
4. writes `service.json`.

## Shutdown

- `z2c stop` → `POST /api/admin/shutdown` (service secret) → closes HTTP, stops the provider (terminating app-server children), clears `children.json`, removes `service.json`.
- SIGINT/SIGTERM follow the same path.
- The supervision timer is idempotent during shutdown (`stopping` flag).

## Crash recovery

- On restart, tasks that were mid-flight are marked `interrupted` by `Persistence.reconcileOnRestart()` — historical truth is never overwritten.
- Orphaned agent children from a hard crash are cleaned by `cleanupOrphanChildren()`: each recorded pid is killed ONLY after the OS confirms its command line is really a `zcode.cjs … app-server` process (pid-reuse guard).
- The service secret, grants, pairings, and ownership survive restarts (explicit schemas above).

## Supervision

A 10 s monitor restarts the official provider with bounded backoff (1 s → 60 s, capped) if it degrades. It never downgrades to a legacy lane. Restarts are audit-logged (`service.provider_restart`).

## Multi-session behavior

Sessions are session-scoped inside the single agent child (official protocol). The service enforces ownership (one client cannot touch another client's session), workspace grants on every call, and governed admission (model attestation, readonly plan evidence) at admission AND dispatch — identical policy for the MCP surface, the management API, and any future transport.

## Upgrade behavior

State files are versioned (`version: 1`). Unknown versions are refused (fail-closed) rather than silently reinterpreted — a migration must be explicit code. Additive fields are fine; the service ignores unknown keys when reading.
