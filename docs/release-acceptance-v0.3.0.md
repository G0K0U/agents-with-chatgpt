# Release acceptance — v0.3.0

This record covers the frozen v0.3.0 source candidate. The support matrix
defines the tested platforms and provider scope. Operational deployment and
GitHub publication are separate gates, recorded in the release report and PR.

## Source and real execution evidence

- A2C source typecheck passed. The corrected full source suite passed 1,237
  tests, with 3 skipped and 0 failed across 76 files. The release gate must
  repeat the full suite from the clean public commit.
- Z2C source typecheck and build passed; its suite passed 196 tests. The clean
  commit installation repeats these checks.
- The patched Quanta source passed 4 synthetic sampling tests. Windows build
  dependencies are pinned in `third_party/quanta/requirements-windows-build.txt`.
- A real A2C OAuth/MCP canary on the frozen A2C source and emitted tree
  completed as task `c2c_069edfbb9fea`. Requested, resolved, dispatched and
  native turn context all reported `gpt-6-sol` with `max` effort. Its final
  output matched the requested short nonce; no workspace files changed. The
  emitted build hash was
  `0a72ac1b4dcf2c3f0833815ec56620a46818a0ba1714e66d4f3b07d64ca57a45`;
  the A2C source hash was
  `3883a16eadc87c6eb73299ce9cc40c60ae33fe20df0a0e23e29a9310199571fb`.
  Final clean-commit build identity is checked against these values before
  claiming that this canary covers the release.
- Synthetic regressions cover provider-specific sample times, expired and
  missing samples, current Codex account selection, failed refresh and
  retention of old timestamps, quota units, weekly exhaustion, and unknown
  quota routing. Quanta's top-level partial summary cannot make another
  provider fresh.

## Scope of the claims

Local OAuth registration, read-scope MCP discovery, tool schemas, and an
unauthenticated MCP rejection were tested with a temporary client. The current
ChatGPT connector has **not** made an independent acceptance call. A same-machine
isolated install is not a fresh Windows Sandbox or VM install. Quanta is
optional for manual execution; unavailable or stale quota data remains unknown.
No new live GLM or Gemini turn is claimed for this source candidate.

The patched Quanta source, upstream provenance, license, sampling contract and
build steps are in [PATCH-INFO.md](../third_party/quanta/PATCH-INFO.md).

## Short external recheck

After installing this release, use the current ChatGPT connector to list MCP
tools and call the read-only model catalog. Confirm that the visible model and
effort reflect the signed-in account. If usage is shown, confirm its observation
time and quota units; unknown is an acceptable result when Quanta is absent or
stale. This recheck does not require another model execution.
