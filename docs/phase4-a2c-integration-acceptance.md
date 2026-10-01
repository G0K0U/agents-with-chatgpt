# Phase 4 — A2C Naming Migration & Z2C Semantic MCP Integration — Live Acceptance

Date: 2026-09-22
Driver: `scripts/a2c-zcode-acceptance.mjs` (run: `node --import tsx scripts/a2c-zcode-acceptance.mjs`)
Result: **9/9 step groups PASS, exit 0** against the REAL installed ZCode agent (runtime 0.16.9) with real GLM turns — no mocks.

## Topology proven

```
acceptance client (OAuth bearer, workspace-scoped token)
  → A2C MCP Gateway  (src/bridge/server.ts → src/mcp/server.ts, serverInfo "Agents with ChatGPT", 35 tools)
  → zcode_* tools    (src/mcp/zcode-session-tools.ts — A2C workspace + session-ownership enforcement)
  → Z2C adapter      (src/execution/zcode-session-client.ts, loopback-only, secret-gated)
  → z2c-service      (Phase-3 semantic implementation, sibling zcode-with-chatgpt checkout)
  → zcode app-server --stdio → ZCode → GLM
```

## Step evidence

| Step | Check | Result |
| --- | --- | --- |
| z2c-service | Phase-3 semantic service healthy, protocol v1 | PASS |
| a2c-bridge | Real `startBridge` gateway up; bridge-root + engineering-ai both authorized | PASS |
| mcp-contract | `initialize` → serverInfo **"Agents with ChatGPT"**; `tools/list` → **35 tools** incl. all 7 zcode_* | PASS |
| capabilities | `zcode_runtime_capabilities` → provider zcode-official healthy, ZCode 0.16.9, Z2C protocol v1 | PASS |
| workspace-list | engineering-ai grant mirrored into the Z2C lane (local-user propagation, not client self-auth) | PASS |
| session-create | `zai-api/GLM-5.3-Flash@max` attested from the exact session | PASS |
| set-model+thought | same-session switches re-attested (GLM-5.3-Flash @ max) | PASS |
| session-send | real GLM turn: `"A2C ZCODE INTEGRATION OK"` | PASS |
| session-read | `official-session-read`, runtime 0.16.9 | PASS |
| negative | unknown session → `ZCODE_SESSION_NOT_OWNED`; unregistered workspace denied; second OAuth client denied foreign session (same message — no existence oracle) | PASS |

## Architecture terminology migration (Phase 0–3, 12)

Classification table (current → target), applied with compatibility:

| Current name | Responsibility | Target | Migration |
| --- | --- | --- | --- |
| `bin/c2c.js`, CLI `.name("c2c")` | shared platform CLI | `bin/a2c.js` / `.name("a2c")` | done — `c2c` bin kept as legacy alias |
| `SERVICE_NAME "c2c-bridge"` (/health contract) | shared gateway identity | `"a2c-bridge"` | done — legacy name accepted by all health readers (`isBridgeServiceName`) |
| `PRODUCT_NAME "Codex with ChatGPT"` | product/connector title | `"Agents with ChatGPT"` | done — OAuth `resource_name`, connector default, CLI banner |
| `C2C_*` env vars (log level, providers, cloudflared, RG, OneDrive, engineering-ai, zcode-queue, desktop-exe, full-access) | shared platform config | `A2C_*` canonical | done — `src/config/env.ts` `sharedEnv()` reads A2C first, C2C fallback; spawn handoffs dual-write |
| `C2C_STATE_DIR` + state dir `codex-with-chatgpt` | **persisted deployment identifier** | keep | documented legacy identifier — renaming orphans live state (`src/config/paths.ts` note) |
| Task/session id prefixes `c2c_`/`c2cs_`, token prefixes `c2c_at/rt`, client `c2c_client_` | persisted/issued identifiers | keep | legacy compatibility identifiers; validators still accept them |
| Tunnel name `c2c-<workspace>`, host `c2c.xuenter.com` | operator tunnel identity | keep | legacy — renaming would break the live connector DNS |
| `.c2cignore` / `.c2c.json` in user repos | user-facing config | keep | legacy — dual-read migration deferred |
| Scheduled task "C2C Bridge Supervisor" | shared autostart | "A2C Bridge Supervisor" | done in install scripts; legacy task disabled on install |
| `codex` provider lane (app-server, `CODEX_HOME`) | Codex lane | **C2C meaning going forward** | untouched — genuinely Codex |
| `Z2C_*` env, z2c companion (port 8766→semantic service), ZCode Desktop manager | ZCode/GLM lane | **Z2C** | already lane-correct; supervisor now prefers the semantic service entry (`dist/service/main.js`) |
| Antigravity/AGY lane | Gemini lane | **G2C** terminology | docs/registry naming only; upstream AGY identifiers untouched |

## Phase 5 — Z2C semantic integration (reuse, not reimplementation)

The gateway forwards to the Phase-3 `z2c-service` — the semantic engine was NOT duplicated:

- `src/execution/zcode-session-client.ts` — loopback-only forwarding client (handshake identity check `z2c-service`, token scrubbing, one re-handshake retry, per-call timeouts), grant mirroring via the local secret (workspace grant propagation is a LOCAL-user action, never client self-authorization).
- `src/execution/zcode-session-ownership.ts` — per-OAuth-client ownership store in the A2C state domain; unknown and foreign sessions produce the SAME error (no existence oracle).
- `src/mcp/zcode-session-tools.ts` — the seven semantic tools; A2C `resolveWorkspace` + scope checks run BEFORE any upstream interaction.
- Registered at the documented extension point in `src/mcp/server.ts` (alongside the zcode-native lane).

## Phase 7–9 — provider lanes, supervisor, tunnel

- Provider lanes verified independent: codex (app-server), gemini (antigravity), glm/z2c (semantic service). Z2C unavailability cannot take down the gateway (forwarding failures map to coded `ZCODE_SESSION_*` tool errors; the shared lanes kept passing throughout).
- Supervisor (`actionRestartZ2c`) now prefers the semantic service entry over the legacy task bridge; legacy fallback retained.
- Tunnel untouched (existing connector hostname/tunnel preserved); the tunnel health check accepts both bridge service names during rollout.

## Phase 17 — regression status

- `npm run typecheck` — clean.
- `npx vitest run` — 937 passed / 44 failed / 3 skipped. **All 44 failures are pre-existing on this working tree and unrelated to this phase** (proven: `tests/continuation.test.ts` 39 and `tests/zcode-native-self-test.test.ts` 5 fail identically with this phase's edits in their import graphs reverted; both cover subsystems with the operator's own uncommitted mid-development changes). My earlier interim regressions (state-dir env leak, bootstrap-name lookups, tool-count contract) were fixed during this phase.
- Live acceptance: 9/9 PASS (this document).
