# Saved workflow and finite recovery entry

This portable runbook preserves the existing Dot → Luna low → A2C worker →
Dot verify → next-task workflow. Supply your own project, workspace and durable
Dot/Luna references. Installation-specific receipts, paths, account state and
credentials are intentionally absent from this public document.

From the A2C checkout:

```powershell
node scripts/engineering-ai-workflow.mjs status
node scripts/engineering-ai-workflow.mjs start
```

`status` checks local control-plane health, the current recovery supervisor,
dispatch policy and highest-effort policy. `start` reuses the formal LKG-aware
supervisor start, proves the same process owner, and waits within a bounded
budget for readiness. Neither command submits tasks, clears pauses, registers
a second bridge or installs a scheduler. Add `--json`, `--state-dir <existing
state>`, or `--wait-seconds 1..120` as needed. Unknown ownership fails closed.

## One-time operator policy

When explicitly authorized by the operator:

```powershell
node bin/a2c.js worker-effort-policy require-highest
node bin/a2c.js dispatch-policy status
node bin/a2c.js dispatch-policy resume
```

Status/pause/resume use the existing protected admin/control-plane path. Resume
is atomic, durable and idempotent; it does not create work or modify continuation
state. An external `PRODUCT_TASK_DISPATCH_PAUSED=true` still overrides persisted
resume and is reported as ENV_OVERRIDE_ACTIVE. Identify its source and perform
the required controlled restart; do not silently alter unrelated user/machine
environment settings. Workspace queue resume is a separate authorized action.

## Each resume

1. Read status; start only the existing control plane when needed. Check local
   versus public health identity through your configured connection. A transport
   connection alone does not establish readiness.
2. Read authenticated runtime capabilities, workspace list/info, harmless file,
   native status and workspace queue. Run the native self-test where needed.
   Verify START and INDIVIDUAL through exact session/provider readback.
3. If a real worker or writer exists, supervise it. Unknown create outcomes
   require reconciliation. Do not submit another writer, delete locks or replay
   a failed/cancelled historical task.
4. Read your existing Dot. If it already polls, leave it running. If it stopped,
   send the explicitly authorized resume request to that same supervisor with
   current gate evidence. Dot refreshes the current product ledger and dispatches
   bounded tasks through the existing Luna low or authorized direct hard-task lane.
5. Observe actual task/session binding and terminal handling. Task submission,
   a dispatcher completing, build passing, or a worker claiming DONE does not
   prove product acceptance. Preserve browser-blocked evidence separately.

## Local self-repair

The existing supervisor orders boot, reconciles durable workspace mappings,
invalidates stale boot/session generations and recovers affected provider lanes.
It uses ownership, heartbeat, protected admin control and the current immutable
LKG release. Recovery is bounded and reports exhausted/unknown states rather
than restarting forever or stealing a live writer.

Windows logon startup is opt-in via the existing `install/register-autostart.ps1`
or deploy `--autostart`. Desktop providers remain in the interactive user session.
No new parallel startup/bridge is required. Full-machine reboot was not performed
in the recorded repair; controlled bridge/provider recovery and cold supervisor
start were tested. Re-run this gate after the next real logon.

The local supervisor does not guarantee a remote Dot conversation survives
deletion, missing cloud authorization, quota exhaustion or external network
failure. [Dot goal management](dot-goal-workflow.md) describes these boundaries.
Keep the real account state outside Git; never back up prior boot PIDs, sessions
or RUNNING snapshots as facts for the next boot.
