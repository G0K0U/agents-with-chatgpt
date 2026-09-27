# Phase 3 — Live Acceptance Evidence

Date: 2026-09-21
Driver: `scripts/phase3-acceptance.mjs` (run: `node scripts/phase3-acceptance.mjs`)
Environment: real installed ZCode agent (`resources\glm\zcode.cjs`, runtime **0.16.9**), real service process (`src/service/main.ts` via tsx, port 8767, CLEAN state directory created fresh for the run), real paired-client flow over the loopback HTTP service. Result: **14/14 step groups PASS, exit 0.**

| Steps | Requirement | Result | Evidence |
| --- | --- | --- | --- |
| 1–2 | Clean start, no manual provider env | PASS | service healthy on 8767, `protocol_version: 1`, provider `healthy` (stale `Z2C_PROVIDER` User env was unset for the run; `z2c doctor` flags it for permanent cleanup) |
| 3 | Pair a local test client | PASS | `cli_0f30…`-class clientId issued via one-time code; token shown once, only hash persisted |
| 4 | Authorize one disposable workspace | PASS | grant `ws_f-ai-startup-zcode-with…` (read+write) created by local user |
| 5 | MCP runtime capabilities call | PASS | `zcode_runtime_capabilities` → provider `zcode-official`, runtime `0.16.9`, status `healthy` |
| 6 | Create WRITE session | PASS | `sess_3947f83a…` attested `zai-api/GLM-5.3-Flash@max` |
| 7 | Harmless real turn | PASS | response: `"Z2C PHASE3 ACCEPTANCE OK"` |
| 8 | Exact attestation | PASS | `official-session-read` source, runtime `0.16.9`, identity re-observed |
| 9 | READONLY session + v4 plan | PASS | `sess_cdd7e7af…` `plan_enabled: true` via v4 CAS |
| 10–11 | Mutation probe refused | PASS | agent: *"Plan mode is active, so I can't create the file right now…"*; `fileCreated=false`; plan remained `true` |
| 12 | Workspace revoke blocks access | PASS | client `zcode_session_read` → `WORKSPACE_NOT_AUTHORIZED` |
| 13 | Client revoke blocks calls | PASS | revoked token on `/mcp` → HTTP 401 |
| 14–15 | Restart: revocations persist | PASS | after full stop+start: revoked workspace absent from grant list; revoked client inactive; `revokedAt` durable in `pairing.json` |
| 16 | Local auth still correct after restart | PASS | service secret → 200; wrong secret → 401 |
| 17–18 | Shutdown; no orphan agents | PASS | agent children before=1 → after=0; `children.json` emptied; `service.json` removed |

## Findings corrected during acceptance

1. **Ownership access matrix**: `zcode_session_send` initially required "write" ownership access, blocking legitimate instruction delivery to readonly sessions. Fixed: send is read/talk access — the agent-layer plan mode is the mutation guard (live-proven by the probe). Config-changing operations (`set_model`, `set_thought_level`, `set_mode`, `close`) still require write access and are refused on readonly sessions.
2. **Interaction auto-resolution hardening**: the runtime-preferences answer now sets `askUserQuestionAutoResolutionEnabled: false` (pinned by a protocol test) — governed unattended lanes must never auto-resolve asks.
3. **Post-turn attestation settle**: `zcode_session_send` waits 1.5 s for interaction-resolution projection lag before the authoritative plan read.

## Regression gates

- `npm run typecheck` — clean.
- `npm test` — **126/126 pass, 28 suites, exit 0**.
