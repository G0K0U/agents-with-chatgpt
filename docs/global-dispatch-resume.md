# Operator global product dispatch

The existing bridge admin surface provides `GET /admin/dispatch-policy` and
`POST /admin/dispatch-policy` with `{ "action": "pause" }` or `"resume"`.
All operations require the existing loopback/admin-token guard. They do not
grant workspace authorization, change a workspace queue, create tasks, or
install/change a continuation.

Use the standard CLI, which loads its existing local admin identity without
printing it:

```
node bin/a2c.js dispatch-policy status --json
node bin/a2c.js dispatch-policy pause --json
node bin/a2c.js dispatch-policy resume --json
```

The response distinguishes `effectivePaused`, `stateFile` and `envOverride`.
Missing policy retains the established unpaused default; malformed policy
fails closed. Both writes use durable atomic replacement with schema 1.
Repeated writes of an already selected state preserve its original timestamp.
Every authenticated mutation records the action and effective result in the
existing bridge log, without tokens or request bodies.

An explicit process `PRODUCT_TASK_DISPATCH_PAUSED=true` (or `1`) still wins.
Resume persists the operator decision but returns HTTP 409,
`ENV_OVERRIDE_ACTIVE`, `ok=false`, and `restartRequired=true`. The status route
remains independently readable. Do not override user/machine environment
settings implicitly.

The supervisor's managed Z2C startup environment is recomputed from effective
policy on every replacement. A provider that was started while paused retains
that environment until replaced. The resume response therefore also identifies
the managed-provider restart requirement. Use existing protected provider
shutdown and supervisor replacement only after checking all native sessions,
queues and writer leases; do not kill arbitrary processes or start a parallel
bridge. A workspace manually paused still requires its existing
`execution_queue(resume)` operation and independent status readback.

Readiness remains a separate control-plane gate. During periodic observations,
health retains timestamped live provider/session facts and exposes
`RECONCILING` with `RECONCILIATION_PHASE`, observation sources and timestamps.
It does not claim READY while reconciliation runs. An actual provider failure
invalidates its cached evidence. `node bin/a2c.js health --json` is the standard
read-only check.
