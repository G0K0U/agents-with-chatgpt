# Release acceptance — v0.3.0

The product code was frozen at `16c22883c70fc8c513cea68c2e7bd2e391878b1c`.
This acceptance record and the support matrix were updated afterward; those
documentation edits do not change the A2C `src/` tree or the emitted build.
The release manifest and deployed pointer record the final public commit.

## Verified code and artifacts

- A2C `pnpm typecheck`, `pnpm build`, and the clean checkout release gate passed.
  Its full suite passed **1,240 tests in 76 files, with 0 failed and 0 skipped**.
  GitHub Actions passed on Windows with Node 22 and Node 24.
- Z2C `npm ci`, typecheck, build, and its full suite passed **196/196 tests in
  40 suites, with 0 skipped** in the independent clean checkout.
- The patched Quanta source passed **4/4** synthetic sampling tests. Its
  `0.9.4+a2c.1` Windows executable was built with pinned dependencies from
  the [vendored MIT source](../third_party/quanta/PATCH-INFO.md). No executable
  is distributed by this repository.
- The A2C source tree SHA-256 is
  `6fd5c3ade9a2ff823911fe418b6a70e00aec152b2c40ce800b2d00f5e19fc8db`.
  The emitted build SHA-256 is
  `74a5617ea367dfbf33a6d652217ad6246f368610c052f7450267b1bd78b5c315`.
  The clean release gate, isolated smoke test, real canary, and controlled
  deployment used that emitted build.

## Real execution and local MCP acceptance

The final A2C OAuth/MCP canary completed as task `c2c_0358389fdaaa`.
Its requested, resolved, thread-dispatched, turn-dispatched, and available
native context evidence all recorded `gpt-6-sol` with `max` effort. The
terminal status was `completed`, the turn completed, the final short nonce was
captured and matched, and no workspace files changed. This is one verified
local account/runtime path, not a guarantee for every account.

An independent same-machine installation used a clean checkout and temporary
HOME, state, and port. The compiled mapper and rejection paths redacted seven
credential forms; the resolver's ambiguous case was checked. Health returned
200, unauthenticated MCP returned 401, and a temporary read-scope OAuth client
listed 43 tools. Its token was revoked and its child process exited. The
controlled production installation also passed health, authenticated MCP,
model resolution, Quanta force refresh, and supervisor checks.

Synthetic regressions cover provider-specific sample times, expired and
missing samples, current Codex account selection, failed refresh and retention
of old timestamps, credits units, weekly exhaustion, and unknown quota routing.
A partial summary time cannot make another provider fresh. Available provider
access alone does not establish quota availability.

## Scope and external recheck

The current ChatGPT connector has **not** made an independent acceptance call.
The isolated installation ran on the same Windows machine; Windows Sandbox or
VM and other operating systems remain **NOT_TESTED**. No new live Gemini or GLM
turn is claimed for this build. Quanta is optional for manual execution, and
missing or stale quota remains unknown.

For a short connector recheck, use the current ChatGPT client to list MCP tools,
call the read-only model catalog, and confirm the visible model and effort for
the signed-in account. If usage is shown, check its observation time and quota
units. This recheck does not require another model execution.
