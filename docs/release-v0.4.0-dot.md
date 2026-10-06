# A2C v0.4.0 — ChatGPT Dot workflow and control-plane recovery

This release packages the integrated A2C/Z2C control plane and its existing
goal/agent management workflow for ChatGPT Dot. It preserves the latest public
media, execution-record and workspace-path fixes while adding the tested local
reliability and native-provider changes.

## Changes

- Dot-led goal supervision, Luna low dispatch and real worker/task/session
  readback, with finite audit-gated orchestration and an exclusive shared writer.
- Deterministic lifecycle/readiness, boot generation, durable versus runtime
  state separation, stale-state invalidation and idempotent reconciliation.
- Existing supervisor's bounded targeted recovery, LKG activation/rollback,
  protected ownership checks and optional interactive Windows logon startup.
- Formal operator global dispatch status/pause/resume. Persisted resume cannot
  hide an active environment pause; queue and operator policy remain separate.
- Health remains inspectable during workspace/provider degradation. Safe
  machine-readable failure layer, code, retryability and version replace generic
  internal-error projection at the controllable MCP/bridge boundary.
- Explicit GLM START/INDIVIDUAL provider/session evidence and highest live effort
  policy. No DEFAULT substitution, silent provider fallback or API-key route.
- Official Antigravity Opus 5.5 admission, live highest-effort gate and exact
  model normalization. Exact-conversation attestation prevents other CLI calls
  from contaminating observed model/effort and failure evidence.
- Native deadline audit retains the primary timeout and partial checkpoint;
  model cancellation without an observed deadline remains a distinct cause.
- Portable saved workflow and finite one-command status/start entry. It waits
  for a proven supervisor's first readiness tick without duplicate startup.

## Evidence and limits

The installed core repair (development 0.3.0 LKG) passed authenticated
control-plane reads, native self-test and explicit START/INDIVIDUAL readback.
Historical formal bridge restarts and cold supervisor recovery passed. A later
attestation deployment returned STOP_FAILED, then recovered through the
protected existing stop/ensure path after the old bridge exited; that failed
handoff remains a failure. These are installation-level repair observations,
not byte-for-byte live provider acceptance of the v0.4.0 public artifact. An actual Opus 5.5/high read-only capability turn completed.
A subsequent UI product turn produced partial work and failed with the real
Claude/Opus shared-pool QUOTA_EXHAUSTED; it is not reported as product completion.
Its old cross-session CLI-log attestation was disputed and independently
revalidated through that exact conversation's initial settings without rewriting
the receipt. Quota is an external constraint, not something self-repair bypasses.

Full-machine reboot and cross-platform live providers were not tested. Cloud
Computer Task transaction/permission-review internals and external FISHTANK
services remain outside this repository's control. Dot timer/poll supervision
was demonstrated; native terminal-event subscription is not claimed.

Publication build/test results and their precise scope are recorded in
[the acceptance evidence](release-acceptance-v0.4.0-dot.md). Runtime acceptance
and code tests are different gates. The installed product queue is currently
manually paused; publication preserves that decision.

Start with [Dot goal management](dot-goal-workflow.md),
[saved workflow recovery](engineering-ai-workflow.md), and
[release operations](release-and-operations.md). Public tunnel/DNS provisioning,
login/2FA and connector pairing remain human-operated. No credentials or private
runtime journals are included in the release.

## Dependency maintenance

Compatible dependency patches were locked, and the test runner was updated to
Vitest 4.1.11 to remove the remaining development-only advisories. A2C and Z2C
dependency audits reported zero known advisories at publication preparation.
Test setup now isolates state before provider imports, so subprocess mocks
remain effective while operator state stays protected. No assertions were
removed to accommodate the update.
