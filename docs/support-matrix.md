# v0.4.0 support and evidence

The public v0.4.0 source package is verified on Windows/Node 24. CI checks
Windows/Node 22 and 24. Live installation repair evidence comes from the
development 0.3.0 LKG and must not be substituted for live v0.4.0 artifact
acceptance. See [current acceptance](release-acceptance-v0.4.0-dot.md).

The existing Dot timer/poll loop, GLM START/INDIVIDUAL exact binding and an
Opus 5.5/high read-only turn were observed during repair. The subsequent Opus
product turn failed quota and is not accepted as UI completion. Real-machine
reboot, independent-machine installation and other platforms remain NOT_TESTED.

## Historical v0.3.0 support record

This matrix describes v0.3.0 at the tested A2C source and emitted build hashes
in the [acceptance record](release-acceptance-v0.3.0.md). Model availability can
differ across accounts and runtimes. The current ChatGPT connector still needs
its own read-only recheck.

| Platform | State | Scope |
| --- | --- | --- |
| Windows 11 x64 | PASS locally | Clean same-machine install and deployment; Windows CI passed on Node 22 and 24. Independent Windows Sandbox/VM install is NOT_TESTED. |
| Windows Server / LTSC | NOT_TESTED | — |
| macOS | NOT_TESTED | Code paths exist. |
| Linux | NOT_TESTED for native providers | This release's CI gate runs on Windows. |
| Windows on ARM | NOT_TESTED | — |

| Provider or feature | State | Limit |
| --- | --- | --- |
| Codex App Server | GPT-6 Sol/max local A2C task `c2c_0358389fdaaa` completed on the tested emitted build | Requested, resolved and dispatched model/effort matched native context; final nonce was captured, and no files changed. No silent fallback. This does not certify every account or the current ChatGPT connector. |
| Antigravity / Gemini | Source-tested | Requires installed, signed-in AGY. Earlier local Gemini results are historical; no new Gemini turn is claimed for this build. |
| ZCode / Z2C official semantic service | Clean source build and 196/196 contract tests passed | Governed lane requires observed `builtin:zai-coding-plan / GLM-5.3-Flash / max`; earlier live native results are historical. No new GLM turn is claimed. |
| Quanta usage telemetry | Optional; patched source and local executable tested | The [Quanta 0.9.4+a2c.1 source](../third_party/quanta/PATCH-INFO.md) supplies provider-specific sample times. Older or absent Quanta yields unknown quota; manual execution remains available subject to provider checks. |
| GLM quota routing | Source-tested | Quanta's GLM pool does not certify every Start Plan, Coding Plan, and Desktop route as the same pool. Weekly exhaustion blocks the reported pool. |

| Public surface | State |
| --- | --- |
| OAuth scopes and unauthenticated MCP 401 | PASS with an ephemeral local read-scope OAuth client; this is **local authenticated MCP acceptance**. |
| Current ChatGPT connector client | NOT_TESTED independently; requires a call from the actual ChatGPT client. |
| Named/Quick tunnel | Named tunnel health and unauthenticated MCP 401 passed locally; each installer configures its own endpoint. |
| Fresh-machine installation | NOT_TESTED until an independent machine or VM is used. |
