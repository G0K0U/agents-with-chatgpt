# Security review — v0.9.0

Reviewed on 2026-09-10. Scope: current Windows changes, native Mac source integration, credential storage, network policy, local UI bridges and release contents. This is a scoped code/regression review, not a penetration test or security certification.

## Fixes

- Mac Keychain failures now fail closed instead of falling back to a different legacy account. Missing entries still preserve explicit legacy compatibility.
- Mac Keychain overlays are marked as protected, so saving settings cannot serialize new secure keys into plaintext configuration. The shared save path preserves the original file credential fields.
- Failed secure-store reads on either platform remain protected during settings saves.
- Native Mac details keep their own renderer and local WebKit action boundary. The Windows bridge continues to expose only a window-bound, token-checked action that opens a native connection editor.

## Evidence

- Combined source regressions: 193 tests, 183 passed, 10 native Mac checks skipped on Windows; no failures/errors in the completed pre-build run. Final version-bound evidence is included with the Windows release package.
- Synthetic Keychain policy tests verify failure behavior, legacy compatibility and that secure values never reach the configuration file. These do not access a real Keychain.
- Thirty distinct pinned Windows/Mac package versions queried through PyPI advisory metadata: all queries succeeded, no listed vulnerabilities returned at review time. This is not a complete software supply-chain guarantee.
- Scoped privacy scan of tracked files and reachable history used three known local Quanta secrets in memory, including Quanta's own saved provider entries: no matches. Secret values were not printed or persisted. This cannot detect every unknown secret.
- Windows dependency consistency check passed. Internet credential requests reject redirects and environment proxies, use normal TLS validation and bounded responses. Antigravity's self-signed TLS exception remains confined to its fixed loopback language-service endpoint.
- Local API requires a token, compares it in constant time and restricts binding to loopback or the existing Tailscale IPv4 range; requests are bounded by concurrency and timeout limits. Tailscale encryption depends on an actual tunnel, not merely an address prefix.
- HTML output escapes provider data; translation JSON escapes script delimiters. Windows native actions reject foreign documents. Mac bridge checks protected local main-frame senders; native bridge tests require macOS and are reported as skipped here.
- Windows packaging requires matching committed-source hashes, passing source tests, exact executable smoke evidence, source/license inventory and archive verification. No personal configuration, history, raw logs or credentials are included.

## Limits and release status

v0.9.0 is an unsigned prerelease. The Windows executable is not Authenticode signed. The Mac recipe produces an ad-hoc signature, not Developer ID signing or Apple notarization. GitHub does not confer either.

Historical Mac status: the original and fix1 downloads used separate snapshots and lacked the integrated Keychain fixes. Their evidence does not validate secure2, and the new results do not retroactively validate those downloads. Mac secure2 (0.9.0, build 9.2) is rebuilt from the integrated source plus the scoped fixes below. Its companion source archive and bundled source-hash manifest identify the exact inputs; license notices are included. See [Mac package status](macos/README.md). Independent clean Windows installation, Intel Macs, other Mac versions, physical multi-monitor/DPI coverage and logout/login scenarios remain outside this review.

Legacy configuration-file keys are preserved, not automatically migrated or erased. Local account access can expose usage data; temporary detail HTML may survive abnormal termination. Hashes prove consistency, not publisher identity. Findings and unsupported environments should be reported through the repository without keys or personal logs.

## Mac secure2 follow-up — 2026-09-11

- Protect newly applied Keychain connections immediately, before a subsequent background refresh, so an intervening settings save cannot serialize the new key.
- Permit Keychain authentication only from an explicit action in the trusted connection window; background reads remain noninteractive and fail closed. Saved secrets are not returned to the web view.
- Discover executable Codex/ChatGPT app resources when Finder supplies no terminal PATH. Account validation and Windows discovery are unchanged.
- Integrated Mac run: 198 checks, 181 passed, 17 platform/dependency skips, no failures or errors. The skips include four Windows Tk editor checks because the Mac build environment has no Tk. These checks do not replace GUI acceptance.
- Native isolated Keychain persistence and protected-settings-save checks passed using synthetic data and a dedicated temporary service. The test item was removed. Denied-access behavior was also checked using a simulated denial.
- Real installed app: existing GLM connection was connected after explicit upgrade authorization; blank-key submission was rejected. Full service/account coverage is not claimed.
- All 18 locked Mac package versions matched the build environment; dependency consistency passed. PyPI advisory queries returned no listed vulnerabilities at review time. Native/Python license inventory is bundled with secure2.
- Existing configuration and startup settings were preserved during installation. No real credentials or personal logs are distributed.
- Windows binary is unchanged. Independent Windows testing will be performed later on a friend's computer; independent Mac testing is also pending. See [release readiness](RELEASE-READINESS.md).
