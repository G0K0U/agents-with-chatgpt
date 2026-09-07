# Platform & provider support matrix (honest state)

Verified = executed on a real machine with recorded evidence in this repo's
test suite or acceptance notes. Anything not listed as verified is NOT_TESTED
or PENDING, never assumed.

## Platforms

| Platform | State | Evidence |
|---|---|---|
| Windows 11 x64 | VERIFIED (development machine: unit/integration suite green; bridge, tunnel, CLI lifecycle exercised live) | `vitest` suite 52 files / 839 tests; live acceptance notes |
| Windows Server / LTSC | NOT_TESTED | — |
| macOS | NOT_TESTED (code paths exist; no first-release verification) | — |
| Linux | NOT_TESTED (CI covers typecheck/build/tests only) | — |
| Windows on ARM | NOT_TESTED | — |

First release officially targets **Windows 11 x64**. Other platforms may work
but are unclaimed until verified.

## Agent providers

| Provider | State | Notes |
|---|---|---|
| Codex App Server (official) | VERIFIED in hermetic tests + live use | primary executor; full-access mode is an explicit local choice |
| Antigravity / Gemini | VERIFIED (adapter + live gemini-3.8-flash-high) | offline workspace contract, identity separation, and live G7C activation verified; other models unverified; workspace granularity |
| ZCode native (Z2C desktop, Start-Plan) | PENDING: fails closed unless the operator runs the Z2C desktop-agent proxy and enables the workspace via `ZCODE_NATIVE_ALLOWED_WORKSPACES` | binding gate requires observed `builtin:zai-start-plan/GLM-5.3-Flash` |
| ZCode free-window queue (`zcode_*` tools) | VERIFIED in hermetic tests | disabled until `C2C_ZCODE_QUEUE_ROOT` is configured |
| Omnigent | DEPRECATED | legacy orchestrator, not recommended; see docs/omnigent.md |

## Public surface

| Item | State |
|---|---|
| OAuth 2.1 (PKCE, DCR, refresh rotation) + 401 without token | VERIFIED (tests + live 401 challenge) |
| Named/Quick tunnel lifecycle | VERIFIED in tests; live Quick Tunnel startup fail-closed fix verified |
| ChatGPT client end-to-end (authenticated connector run) | PENDING_MANUAL_ACCEPTANCE — requires the operator's ChatGPT session; never claimed by CI |
| Clean-machine install | see install/install.ps1; Windows Sandbox/VM rerun NOT_TESTED at first release |
