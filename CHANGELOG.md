# Changelog

All notable changes to this project are documented here. The project versions
pre-1.0 releases with a minor bump per feature release; tags follow `vX.Y.Z`.

## [0.3.0] — 2026-09-22

### Release closure fixes (2026-09-27)

- Codex catalog and task execution now resolve the same persisted runtime
  override, including when task setup supplies a partial environment. The
  historical GPT-6 Sol/max rejection came from different Codex executable
  versions being used for listing and execution; model support still requires
  a completed live canary on the published build.
- Quanta usage checks provider-specific sample times with a 60-second bound;
  another provider's recent sample or an HTTP/cache time cannot make stale
  quota data fresh. Quanta failures have bounded, distinct local diagnostics.
- Route recommendations now respect weekly exhaustion and distinguish Quanta
  telemetry failure from provider/model unavailability. No unknown quota is
  turned into an available percentage.
- The vendored MIT-licensed Quanta 0.9.4+a2c.1 source patch preserves old sample
  times on failed collection and supplies a documented rebuild path.
- An already activated clean release can be installed into a matching existing
  checkout with complete source/build verification and an A/B rollback pointer.
- The isolated candidate smoke now checks compiled redaction and ambiguity
  paths and uses a temporary, read-scoped OAuth client.

### Added

- **One-command local deployment for a fresh clone.**
  `node scripts\deploy.mjs` (Windows) / `node scripts/deploy.mjs` (macOS/Linux)
  checks prerequisites (Node.js ≥ 20, git, pnpm via corepack), installs
  dependencies, builds, builds the optional in-repo Z2C companion when
  present, then hands off to the new `a2c deploy` command. The flow is
  idempotent — re-running it is always safe.
- **`a2c deploy` CLI command** — initializes safe local state, starts or
  reuses the local bridge (loopback only), verifies the local MCP endpoint
  (expects 401 without a token, proving OAuth enforcement), and prints a
  concise success summary with explicit next actions. Supports `--workspace`,
  `--state-dir`, `--no-start-bridge`, `--autostart` (explicit opt-in to the
  Windows logon task), and `--json`.
- **Explicit tunnel manual gate.** The deploy flow reads tunnel state but
  never creates tunnels, DNS records, hostnames, or certificates, never
  starts cloudflared, and never overwrites existing tunnel configuration. If
  no public connection has been chosen, it prints a `HUMAN ACTION REQUIRED`
  section with the exact commands the human must run themselves
  (`a2c tunnel choose --mode quick|named ...`). This keeps local automation
  fully automatic while public-domain/production-side setup stays
  human-operated.
- **`AGENTS.md`** — agent handoff contract for local coding agents: allowed
  local automation, human-only actions (Cloudflare/tunnel/DNS, ChatGPT login,
  pairing codes), canonical deploy/health/restart/update/rollback commands,
  secrecy rules, and repo conventions.
- **README "Quick deploy with a local agent"** section (Windows-first,
  copy/paste) in both English and Chinese READMEs; `docs/agent-prompts.md`
  now references the one-command flow and the handoff contract.
- **`CHANGELOG.md`** (this file).
- New regression coverage `tests/deploy.test.ts`: tunnel gate is read-only,
  existing quick/named tunnel configuration is preserved byte-identical,
  rendered output never leaks tunnel ids or pairing secrets, bridge
  reuse/start orchestration, and check-only idempotency.

### Notes

- The deployment flow intentionally leaves tunnel/public-host setup as a
  guided human step; local-only mode is a first-class outcome.

## [0.2.0] — 2026-09-06

Release candidate of the multi-agent C2C control plane: A2C shared platform
naming (c2c/z2c/g2c lanes), supervisor with bounded self-healing, shared
session plane, release/LKG lifecycle (`a2c release build|activate|rollback`),
unified doctor reporting, Windows autostart via the "A2C Bridge Supervisor"
logon task, and sanitized release acceptance docs. See
`docs/release-acceptance-v0.2.0.md`.

## [0.1.1] — 2026-09

Patch release: Windows Quick Tunnel startup fails closed; an inconclusive
local bridge probe is no longer treated as a dead process.
