# macOS source security review — 2026-09-10

Scope: post-RC4 native macOS source changes on Apple Silicon, macOS 26.2.
This is a scoped code/privacy/regression review, not an independent penetration test,
security certification or approval for a signed public binary release.

## Findings addressed before upload

- Native detail/connection windows now fail closed until local content blocking is ready.
- Native bridge calls require a known WebView, its main frame, active content protection
  and the local `about:blank` document. Remote/file/data documents and subframes are rejected.
- Translation JSON escapes HTML delimiters before inline-script insertion.
- Mac-only connection hints/layout are opt-in. Default shared-panel output retains RC4 behaviour.
- Native icon imports are deferred, preserving non-Mac source inspection. Regression stubs
  were updated to include the new native-icon hook and refresh fields.
- macOS build dependencies have a separate pinned inventory; Windows inventory is unchanged.

## Checks and results

| Check | Result | Evidence/limit |
| --- | --- | --- |
| Full isolated source regressions | Pass | 162 tests, 149 passed, 13 skipped for platform conditions; no failures/errors |
| Credential entry and failure handling | Pass | Existing regression coverage rejects malformed keys, preserves old credentials, redacts errors and checks exact Keychain scope |
| WebKit message boundary | Pass | Rejected unprotected, unknown, subframe and non-local senders; normal connection window still opens in actual native GUI |
| Native GUI after hardening | Pass | English detail → Add connection → empty-key validation; synthetic usage data, no credential submission or Keychain mutation |
| Windows source separation | Pass | 11 Windows-specific source/build/entry/test files byte-identical to RC4; default panel output byte-identical in 3 representative cases |
| Known local config values and personal absolute paths | Pass | No matches in prepared source files; config content preserved; no config, snapshots, logs, app bundle or local reports queued for upload |
| Dependency advisory lookup | Pass within scope | 18 pinned Mac build packages queried through PyPI version JSON; all queries succeeded and listed no vulnerabilities on review date |
| Original RC4 integrity | Pass | Original ZIP members unchanged; original GUI failure remains a failure |
| Windows runtime/EXE GUI | Not tested | No Windows device used in this review; skipped tests are not passes |
| Other Macs, Intel, fresh user install, logout/login, network loss | Not tested | Separate hardware acceptance remains required |
| Developer ID / notarization | Not applicable to source push | Local build is ad-hoc signed; no new binary release is created |

Privacy review matched known values from the local configuration in memory and checked
prepared source for personal absolute paths. It did not enumerate unrelated Keychain items
or claim to detect every unknown secret. Only reviewed source/docs/tests are synchronized;
the existing private repository visibility is retained.

An initial regression run used the wrong working directory and also exposed the shared
hint change. Re-running from the source root after isolation and the test-stub update
produced the result above. Failures were retained locally rather than counted as passes.

## Remaining limits

Rebuilt ad-hoc apps can require fresh macOS Keychain authorization and may wait for that
system decision. This must be tested with stable publisher signing before general binary
distribution. Users approve trusted system prompts themselves; no security settings are
weakened. Neither successful tests nor empty advisory records prove absence of vulnerabilities.

Original RC4 on the tested notched Mac failed to expose Q visibly. Native UI improvements
are subsequent changes and do not retroactively validate the RC4 download or Windows EXE.
