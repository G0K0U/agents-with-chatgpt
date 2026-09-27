# Local release and operations

This guide describes the current A2C and bundled Z2C source distribution.
Node.js 22 or newer, pnpm 11.24.0 (A2C), and npm 11.17.0 (Z2C) are used by
the recorded Windows candidate gate. The lockfiles are required for repeatable
installation. ZCode, Codex, AGY, and their account logins are separate user
prerequisites; the installer does not modify their installations or sessions.

## Fresh local installation

Run `node scripts/deploy.mjs` from a clone. It installs A2C with
`pnpm install --frozen-lockfile`, installs the bundled `z2c/` with `npm ci`,
builds both, then performs local deployment checks. `--workspace <absolute
path>` and `--state-dir <absolute path>` select the scope; `--no-start-bridge`
is a check-only run. `--autostart` is an explicit opt-in. The PowerShell
installer in `install/install.ps1` also builds `z2c/dist/service/main.js`.

The GLM lane uses the installed ZCode official app-server through the Z2C
semantic service, not `z2c/dist/index.js`. A2C's supervisor never treats a
mere port listener as proof of workspace authorization or a particular
session/provider/model. Governed dispatch requires an observed
`builtin:zai-coding-plan / GLM-5.3-Flash / max` binding and a non-paused
workspace queue. Do not set Desktop Agent command overrides.

## Public connection

The bridge listens on loopback. A bridge-managed quick or named tunnel is one
supported mode. An independently installed Cloudflared Windows service is an
**external, observe-only** mode: A2C may probe its configured HTTPS hostname
and the fixed loopback origin port, but it does not own, stop, or reconfigure
that service. Local `/health`, public `/health`, and public unauthenticated
`/mcp` establish different facts. A public 401 proves an authentication
challenge only. Compare the current non-secret `instanceId`, workspace,
service, and release from local and public `/health` before claiming the route
points to this bridge. Cloudflare DNS, account access, connector login, and
pairing are user-operated steps; see `AGENTS.md`.

For an external tunnel, `status` and `doctor` refresh an expired observation
through the authenticated loopback admin route. That read checks the fixed
public and local `/health` identities and public MCP challenge without
starting or controlling Cloudflared. An expired observation remains unverified
until the refresh succeeds; `ownsProcess` and `canControlProcess` stay false.

## Model catalog and per-task selection

The bridge keeps a live, account-scoped model catalog for the three backends
(read-only; it never starts inference or sessions):

- **Codex** — `codex app-server --stdio` + `model/list` (paginated), same
  executable/config/auth path as task execution. App Server children are
  launched WITHOUT a hardcoded model; every task passes its selection on
  `thread/start`/`turn/start`.
- **Antigravity/AGY** — `agy models` (account-scoped CLI listing); effort is
  encoded in the Gemini model id suffix.
- **ZCode** — the loopback z2c-service `zcode_model_catalog` tool (runtime
  settings observed through an existing owned session; never creates one).

ChatGPT-facing tools: `agent_model_catalog` (list, freshness/revision per
agent) and `agent_model_resolve` (deterministic no-inference resolution with
matched/ambiguous/not_found/unverified/unavailable outcomes). Catalog-listed
is NOT inference-verified.

Selection priority for Codex tasks: explicit task selection > bridge-local
preference (`A2C_CODEX_PREFERRED_MODEL`/`A2C_CODEX_PREFERRED_EFFORT` or the
optional bridge-owned `<stateDir>/model-preferences.json`; never the user's
`~/.codex/config.toml`) > verified account default. Every selection is
persisted on the task record, re-confirmed against the current catalog at
dispatch (fail-closed `MODEL_NOT_LISTED`/`UNSUPPORTED_EFFORT`/`MODEL_CATALOG_UNAVAILABLE`
instead of silent substitution), and reported with
requested/resolved/observed evidence. Protected continuation nodes whose pin
is no longer listed stay paused with an explicit reason; approvals are never
re-signed.

## Candidate gate and switch

From a clean committed checkout, install A2C and Z2C dependencies from their
locks, run both typechecks and the Z2C suite, then build A2C. Run
`node dist/cli/index.js release activate` to execute the A2C release gate
(typecheck, build, manifest, full tests), promote an immutable release tree,
and update that checkout's LKG. `release activate` takes **no release ID** and
rebuilds; use the resulting manifest and ID, not an earlier dist hash.

Run `scripts/candidate-smoke.mjs` against the named immutable release CLI with
an existing private evidence directory. It checks the release tree hash,
compiled catalog mapper and rejection redaction, the ambiguous resolver,
isolated bridge health, unauthenticated MCP 401 and an ephemeral read-scoped
OAuth client. It revokes that client's token and closes the isolated bridge.
This local client is not evidence that the user's ChatGPT connector called MCP.

For a separate existing installation whose `src/` content matches the
activated source, `installActivatedRelease(sourceRoot, targetRoot)` in
`src/process/release.ts` verifies the clean source commit, active pointer,
source and build hashes in both checkouts, copies that **exact** release tree,
and records the old pointer for rollback before switching LKG. It refuses a
tampered or incomplete release. Back up the other components separately.
Check maintenance pause, queue/writer state, and process ownership before a
single controlled restart; then compare new process ID, release/instance
identity, health and authenticated MCP. Restart Z2C or Quanta only if their
own code changed. Do not modify tunnel/DNS state as part of this switch.

`ownership_unknown` is a hard stop. The Windows process inspector first reads
WMI and fills missing Node executable/argv fields only when a limited-access
native handle confirms the same OS creation time. If proof remains unavailable,
stop before moving LKG. A failure after pointer activation is a partial
activation; inspect the exact stage and runtime before rollback. Do not delete
locks or force-stop a PID.

`node bin/a2c.js release rollback` validates and restores the previous LKG
**pointer**. It is a runtime release operation, not a source tree rollback or
an automatic process restart. Verify owner and maintenance pause, then use a
controlled bridge restart and compare the new instance and authenticated MCP.
Never reset or clean a dirty worktree as part of runtime rollback.

The official ZCode `session/list` can include an idle historical session while
`session/read` returns `-32004` until that native session is active. A stored
message is not live read proof. Keep foreign history observe-only; never resume
it merely to satisfy a release check. Record the exact workspace binding and
upstream error instead.

## Supervisor and maintenance

`node bin/a2c.js supervisor start|status|stop` uses the configured workspace
and state directory. A live READY snapshot requires a matching lock, OS
process generation, and fresh heartbeat. Historical snapshots remain
diagnostic context and cannot authorize control. Stop revalidates identity
before signaling. Unknown ownership stays unknown. The supervisor uses
bounded targeted recovery by lane; its health checks do not send model
prompts. Z2C can be restarted independently while the A2C bridge remains
healthy. A missing Z2C semantic build must fail rather than start the legacy
task bridge.

Pause the affected workspace queue before any service recovery that could
dispatch work. The Engineering AI queue and Z2C's own task queue are distinct;
inspect both, active writers, and dispatch intent. Keep historical queued
write tasks paused until their owner explicitly resumes them. To diagnose a
failed switch, retain the gate logs, current LKG pointer, candidate hashes,
local/public health identities, and the exact ownership failure. Private
state and credentials remain outside the repository.
