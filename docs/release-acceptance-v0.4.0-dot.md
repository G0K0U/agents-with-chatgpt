# v0.4.0 publication acceptance

Prepared on 2026-10-06 from G0K0U/agents-with-chatgpt main 16ab1ba.
The existing Quanta source, historical release records, Node 22 minimum and
Windows runner-temp fixes are preserved. Publication is isolated from the
dirty installation and product workspace.

| Gate | Result | Scope |
| --- | --- | --- |
| A2C typecheck/build | PASS | Clean publication worktree, Windows/Node 24 |
| A2C full suite | PASS | 104 files; 1503 passed, 3 existing skips |
| Preserved upstream search coverage | PASS | 22 tests including 10 additional cases; no assertions removed |
| Z2C typecheck/build/full suite | PASS | 318 passed, no failures or skips |
| Dependency audit | PASS | A2C production+development and Z2C: zero known advisories at preparation |
| Compiled isolated MCP candidate | PASS | Actual authenticated read-only MCP; 65 tools, 401 without auth, matching release/hash; no production state or inference |
| Installed repair control plane | PASS | Development 0.3.0 LKG; actual authenticated read path and stable READY |
| START / INDIVIDUAL | PASS | Exact native session requested=observed; live GLM max |
| Installed native self-test | Historical PASS | Not repeated while the product queue is manually paused |
| Installed bridge recovery | Mixed, explicit evidence | Historical formal PASS; later STOP_FAILED handoff recovered through protected existing owner path |
| Opus 5.5/high admission | PASS | Actual read-only turn completed; exact conversation revalidation |
| Subsequent Opus UI turn | FAILED_QUOTA | Partial work preserved; no product acceptance or automatic fallback |
| Dot wake/supervision | Demonstrated polling | Existing timer/task readback; native terminal subscription unverified |
| Current product dispatch | MANUALLY_PAUSED | Global policy enabled, workspace pause preserved, no active writer |
| Real full reboot | NOT_TESTED | Generation/reconciliation/cold-start tests are code tests |
| Live providers on public v0.4.0 artifact | NOT_TESTED | Installed-core evidence cannot substitute for artifact-specific live proof |

A2C's full-suite run above preceded import of the 10 additional public search
cases; their complete 22-case suite was then tested separately. GitHub CI
runs the final complete tree on Windows/Node 22 and 24, including Z2C. Its
status is available on the release pull request, rather than inferred here.

Original failed publication attempts remain in ignored local evidence. The
failures involved a directory-substring test, omitted media files during
source-base integration and provider imports occurring before mocks. The
fixtures/import order were corrected; no safety assertion or real test was
removed or skipped to produce this result.

The release includes source and portable operation instructions, not tokens,
account state, runtime journals, product source or an EXE. Recovery uses the
existing supervisor and operator guard. Quota, login/2FA, revoked access and
external cloud transactions remain explicit external boundaries.

The formal candidate build gate passed and promoted immutable artifact
0.4.0-42726c81-c3d316d0. The compiled smoke tested seven credential redaction
forms on both mapper and rejected-call paths, rejected ambiguous model
resolution, validated instance/release/build identity and authenticated shared
agent-plane tools, then shut down its exact temporary child. It did not
activate a production LKG, reconfigure a tunnel or create a model worker.

The first hosted CI run passed the complete A2C suite on both Node 22 and
24, then exposed two Z2C tests that assumed a locally installed ZCode runtime.
The installed-layout test now creates real fixture files and verifies explicit
override precedence. Doctor diagnostics use a private fixture state and a
version-only CLI; an additional assertion proves a missing CLI still fails
even when the legacy configuration warning is present. All 47 affected tests
passed locally with no skips. Original failed CI remains visible in run
37465871989; the release notes record the subsequent CI result.

Hosted runner case counts differ when ripgrep is absent: the Node fallback
engine runs there, while local search acceptance covers both ripgrep and Node.
The first Node 24 job recorded 1505 A2C passes with no skips. Numerical counts
are environment-specific; release CI and local gates are reported separately.
