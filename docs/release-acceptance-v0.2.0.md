# Release acceptance summary — v0.2.0 (sanitized)

This summary describes what was verified for the v0.2.0 release candidate and
what remains explicitly unverified. Internal evidence (logs, machine paths,
acceptance JSON) is kept out of the public repository by design.

## Verified for this release

- **Source & regression**: `tsc --noEmit` clean; full test suite 52 files,
  839 passed, 4 skipped, 0 failed — run three separate times on the exact
  release tree, including once through the overnight coordinator harness.
- **Privacy/portability hardening**: no machine-local workspace ids, paths,
  hostnames, or account names ship in the product. Operator-configured
  environment variables (`ZCODE_NATIVE_ALLOWED_WORKSPACES`,
  `C2C_ZCODE_QUEUE_ROOT`, `C2C_ENGINEERING_AI_WORKSPACE_ID`,
  `C2C_ONEDRIVE_FOLDER_NAME`, `C2C_ONEDRIVE_AUDIT_ROOT`) fail closed when
  unset; the bridge derives its own workspace id instead of hard-coding one.
- **Installer**: `install/install.ps1` exercised end-to-end in isolated
  directories on Windows 11 x64 — 11/11 steps OK (clone at pinned commit,
  integrity check, dependency install, build, doctor, setup, healthy bridge,
  unauthenticated 401 challenge). Evidence level: development machine with
  dependencies present; a clean-VM rerun is future work.
- **Live control loop (isolated bridge)**: scripted OAuth client
  (registration → PKCE authorization with pairing code → token exchange with
  refresh), authenticated MCP tool discovery, two REAL agent sessions
  cooperating through distinct sessions (session 2 consumed session 1's
  artifact), writer-slot serialization observed (second task queued while the
  first ran), cancellation verified to reach terminal `cancelled` (never
  silently completed), and consistent task/audit status afterwards.
- **Security regressions**: runtime-pointer ownership (20 hermetic cases),
  restart handoff, shared-bridge discovery, state-domain ownership,
  full-access bridge, and tunnel fail-closed suites all green.
- **Antigravity / Gemini primary integration**: Antigravity direct provider
  adapter verified with `gemini-3.8-flash-high` (truthful lifecycle phases,
  evidence-grounded session ID, model identity separation, network deny policy,
  safe cancellation without Codex AppServer disruption, and fail-closed
  workspace write scoping).
- **Honest support claims**: see docs/support-matrix.md — Windows 11 x64 is
  the only verified platform first release; everything else is NOT_TESTED
  and labeled as such.

## Verified post-release hotfix (2026-09-12)

- **Native ZCode Desktop route (Windows 11 x64)**: the live chain
  desktop-agent proxy → Z2C → ZCode Desktop GLM session was accepted with
  real (non-mocked) evidence — a harmless write task executed for real with
  its output retrieved and verified on disk; the exact observed session
  binding was `builtin:zai-start-plan / GLM-5.3-Flash` (source:
  `desktop-session-read`, Desktop-managed authentication); same-session
  resume completed in the identical session; cancellation reached a terminal
  `cancelled` state; durable idempotency replay returned the same task while
  a tampered request under the same key was refused
  (`IDEMPOTENCY_CONFLICT`); wrong-workspace and unattested-session access
  failed closed (`ZCODE_NATIVE_WORKSPACE_FORBIDDEN`).
- **Public repository published**: this repository is live at
  [G0K0U/agents-with-chatgpt](https://github.com/G0K0U/agents-with-chatgpt);
  the release lineage includes commit `40d1a5a` (release + coordinator
  idempotency contract) and the hotfix commit that supersedes it as HEAD.

## Explicitly NOT verified (do not assume)

- ChatGPT client end-to-end with an authenticated connector — requires a
  human ChatGPT session (PENDING_MANUAL_ACCEPTANCE).
- GitHub-hosted artifact re-verification (download-back + reinstall).
- Clean-machine (Windows Sandbox/VM) installer rerun.
- macOS/Linux/arm64 platforms and Gemini models beyond live-verified
  gemini-3.8-flash-high — all fail closed or NOT_TESTED, never claimed.

## Distribution integrity

- Release commit and tag are pinned; the installer supports
  `-ExpectedCommit` verification and records the checked-out SHA.
- No binaries are signed; provenance is the git history on the public
  repository. CI (typecheck + build + tests on Windows/Linux, Node 20/22)
  runs on every push and pull request.
