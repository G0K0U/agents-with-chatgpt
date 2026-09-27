# AGENTS.md — operating guide for local coding agents

Handoff contract for any local coding agent (Codex, ZCode/GLM, Gemini, or
other) asked to deploy, verify, repair, update, or roll back **Agents with
ChatGPT (A2C)** from this repository. Read this file before touching anything.

Agents with ChatGPT turns the ChatGPT web app into the planning/review brain
for local coding agents. A local loopback bridge exposes an OAuth-protected
MCP surface; ChatGPT reads code through it and submits tasks to provider lanes
(Codex App Server, Gemini/AGY, ZCode/GLM-5.3-Flash via the Z2C companion).
Architecture: `docs/architecture.md` · Security: `docs/security.md`.

## Boundaries (non-negotiable)

**Local automation is allowed.** A local agent may, without asking: check
prerequisites, run `pnpm install` / `pnpm build` / tests, initialize local
state, start/stop/restart the local bridge and supervisor, register or update
the logon autostart task **when the user explicitly asks for autostart**, read
status/doctor output, and commit to the local git checkout.

**Public connection is human-operated.** Never run, and never "repair" by
running, any of these without the user explicitly asking for that exact
change — they touch the user's Cloudflare account/domain or production
connector configuration:

- `a2c tunnel choose --mode quick` / `--mode named ...` (public-connection choice)
- anything that provisions tunnels, DNS records, hostnames, or certificates
  (`provisionNamedTunnel`, `POST /admin/tunnel/start`, cloudflared setup)
- ChatGPT browser login / CAPTCHA / 2FA, and entering the one-time pairing code
  (codes are shown to the human; never print, store, or reuse them)

**Deploy is tunnel-safe by design.** `a2c deploy` and `scripts/deploy.mjs`
only *read* tunnel state. If no public connection is configured they print a
`HUMAN ACTION REQUIRED` section with the exact commands for the human — that
is the expected first-run outcome for local-only use. Existing tunnel
configuration must never be overwritten.

**Secrecy.** Never print or persist: pairing codes, OAuth/admin tokens,
cookies, cloudflared certificates, tunnel credentials/ids, or file contents
from the state dir. State lives outside the repo (default
`%LOCALAPPDATA%\codex-with-chatgpt` on Windows, `~/Library/Application
Support/codex-with-chatgpt` on macOS, `$XDG_STATE_HOME/codex-with-chatgpt` on
Linux) and is never committed.

## Canonical commands

All CLI commands below work on Windows (PowerShell) and POSIX; `node
bin/a2c.js` runs the active last-known-good (LKG) release from this checkout
and falls back to `dist/`, then to TypeScript sources via tsx. Add
`--workspace <path>` / `--state-dir <path>` when not operating on the current
directory / default state dir.

Deploy (fresh clone or re-deploy; idempotent, Windows-first):

```powershell
git clone https://github.com/G0K0U/agents-with-chatgpt.git
cd agents-with-chatgpt
node scripts\deploy.mjs              # macOS/Linux: node scripts/deploy.mjs
```

Useful deploy flags: `--workspace <path>` (deploy for a project directory),
`--state-dir <path>`, `--autostart` (opt-in Windows logon task),
`--no-start-bridge` (checks + tunnel gate only), `--json`.

Health checks:

```powershell
node bin\a2c.js status               # bridge + public connection state
node bin\a2c.js status --json        # machine-readable
node bin\a2c.js doctor               # diagnose; add --fix to auto-repair locally
node bin\a2c.js tunnel status        # read-only tunnel gate state
node bin\a2c.js supervisor status    # control-plane self-check
node bin\a2c.js release status       # LKG release identity and drift
```

Restart / stop / update / rollback:

```powershell
node bin\a2c.js restart              # controlled bridge restart
node bin\a2c.js restart --tunnel     # restart and re-establish the public connection (only if already configured)
node bin\a2c.js stop                 # stop the workspace bridge
git pull; node scripts\deploy.mjs    # update/redeploy from this checkout
node bin\a2c.js release activate     # gate + promote + atomically repoint LKG
node bin\a2c.js release rollback     # validated bounded A/B swap to previous LKG
```

Autostart (Windows, explicit opt-in): re-run
`powershell -NoProfile -ExecutionPolicy Bypass -File install\register-autostart.ps1`,
or deploy with `--autostart`. The logon task runs the LKG-aware supervisor
(`supervisor run`), which owns boot ordering: bridge → tunnel → provider lanes.

## Verify before you claim success

```powershell
pnpm typecheck
pnpm build
pnpm test                            # full suite; CI runs Windows + Ubuntu, Node 20/22
```

Focused: `pnpm exec vitest run tests/deploy.test.ts tests/release-lifecycle.test.ts`.
Operational proof after a deploy: compare local/public `/health` instance,
workspace, service and release; verify authenticated MCP with the existing
authorized identity. An unauthenticated `/mcp` 401 proves the auth challenge,
not process ownership or connector acceptance. Public-connection reachability
is only expected after the human completes the tunnel step. See
`docs/release-and-operations.md` for the candidate gate and safe switch.

## Repo conventions

- Package manager: pnpm (corepack-pinned). Node >= 20. TypeScript, ESM,
  vitest; tests import `../src/...` directly and use `tests/helpers.ts`
  fixtures (`makeTmpDir`, `isolateStateDir`, `makeGitRepo`).
- Releases: branch `release/vX.Y.Z`, tag `vX.Y.Z`, `CHANGELOG.md` entry, and a
  GitHub release whose notes summarize the changelog section. Version lives in
  `package.json` and `src/version.ts` — keep both in lockstep.
- Docs for deeper work: `docs/agent-prompts.md` (user-facing deploy/smoke
  prompts), `skill/SKILL.md` (the ChatGPT-side Skill workflows, incl. guided
  first-time setup), `docs/support-matrix.md`, `docs/troubleshooting.md`,
  `docs/security.md`.
- Do not commit: logs, `queue.jsonl`/`control.jsonl` journals, `releases/`,
  `dist/`, `var/`, state or credentials. The in-flight work of others in the
  checkout is untouchable: never delete or overwrite files you did not make.
