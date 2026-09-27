# Platform and provider support matrix

This matrix describes the 0.3.0 source candidate. A model's presence in a
catalog is not proof that a task completed with it. The local GPT-6 canary
below verifies this candidate's exact A2C emitted tree; model availability
can differ across accounts and runtimes.

See the [v0.3.0 acceptance record](release-acceptance-v0.3.0.md) for the
source test counts and the scope of the live canary.

| Platform | State | Scope |
| --- | --- | --- |
| Windows 11 x64 | Source and local control-plane tests passed | Development-machine verification; independent Windows Sandbox/VM install not yet claimed. |
| Windows Server / LTSC | NOT_TESTED | — |
| macOS | NOT_TESTED | Code paths exist. |
| Linux | NOT_TESTED for native providers | CI source checks do not prove a live provider. |
| Windows on ARM | NOT_TESTED | — |

| Provider or feature | State | Limit |
| --- | --- | --- |
| Codex App Server | GPT-6 Sol/max local A2C canary completed on build `0a72ac1b4dcf…`; task `c2c_069edfbb9fea` | Requested, resolved and dispatched model/effort matched; native context matched, final nonce was captured, and no files changed. A2C uses the same configured runtime for catalog and execution. No silent fallback. This does not certify every account or the current ChatGPT connector. |
| Antigravity / Gemini | Source-tested; earlier local Gemini canaries completed | Requires installed, signed-in AGY. Those earlier results are not evidence for this candidate build. |
| ZCode / Z2C official semantic service | 196 synthetic/contract tests passed in the candidate source | Governed lane requires observed `builtin:zai-coding-plan / GLM-5.3-Flash / max`; earlier live native results are historical. No new GLM turn is implied. |
| Quanta usage telemetry | Optional; freshness contract source-tested | Use the patched [Quanta 0.9.4+a2c.1 source](../third_party/quanta/PATCH-INFO.md) for provider-specific sample times. Older or absent Quanta yields unknown quota; manual execution remains available subject to its own provider checks. |
| GLM quota routing | Source-tested | Quanta's GLM pool does not automatically certify Start Plan, Coding Plan, and Desktop routes as the same pool. Weekly exhaustion blocks the reported pool. |

| Public surface | State |
| --- | --- |
| OAuth scopes and unauthenticated MCP 401 | Tested locally with an ephemeral OAuth client; this is **local authenticated MCP acceptance**. |
| Current ChatGPT connector client | Requires a separate call from the actual ChatGPT client; local OAuth tests do not prove it. |
| Named/Quick tunnel | No tunnel or DNS configuration changed by this candidate. |
| Fresh-machine installation | NOT_TESTED until an independent machine or VM is used. |
