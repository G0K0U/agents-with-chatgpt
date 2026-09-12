# ZCode Scheduled Queue — Governed C2C Control Plane

The `zcode_*` MCP tools give ChatGPT/C2C governed access to a
governed scheduled worker queue. The queue root is **operator-configured** via the
`C2C_ZCODE_QUEUE_ROOT` environment variable (for example, a directory inside
a deployment you own, such as `<your-workspace>/var/c2c-zcode`). It is unset
by default: without configuration the tools fail closed and report
`ZCODE_ROOT_MISSING`.

When `C2C_ZCODE_QUEUE_ROOT` is a **relative** path, it resolves only
underneath an authorized workspace root — never against the process working
directory. The authorized workspace is resolved, in authority order, from:
an explicit workspace root, `C2C_ENGINEERING_AI_WORKSPACE_ROOT`, the
in-memory workspace registry, the persisted workspace registry
(`workspaces.json`), and the persisted runtime pointer — failing closed when
none resolves. An absolute `C2C_ZCODE_QUEUE_ROOT` is honored as-is after
traversal checks. The queue root is also identified by the logical workspace
name (default `engineering-ai`, override with
`C2C_ENGINEERING_AI_WORKSPACE_NAME`/`_ID`); no machine-specific absolute
path is ever baked into the product.

No caller can ever pass a filesystem
path — every tool operates on the configured root, and the control plane fails
closed on anything that is not a plain regular file inside it (symlinks,
junctions and reparse-point escapes are rejected, and reads are capped at
8 MiB per file).

## Coordinator ownership and lifecycle

The C2C bridge owns the queue coordinator. On bridge start it
starts exactly once per queue root (duplicate starts are no-ops); on bridge
shutdown it stops gracefully. It is the ONLY writer of lifecycle receipts
(`START`, `COMPLETED`, `FAILED`, `CANCELLED` in `receipts.jsonl`) and of
`worker-state.json` — the ChatGPT-facing control plane cannot forge terminal
receipts.

Lifecycle per task:

```
queued → (claim window) → dispatched through the native Desktop lane
        → START receipt → observed terminal → COMPLETED | FAILED | CANCELLED
CANCEL_REQUESTED while queued → CANCELLED (never dispatched)
CANCEL_REQUESTED while running → forwarded to the native lane → CANCELLED
```

Ownership is fenced through `worker-state.json` heartbeats: a second
coordinator observing a fresh foreign heartbeat goes STANDBY and never
dual-claims; when a heartbeat goes stale (or the previous owner wrote a
graceful `stopped` state) ownership is taken over. After a crash, tasks with
a `START` receipt but no terminal outcome are re-adopted by re-dispatching
the **same durable idempotency key**, so an already-accepted native task
replays instead of executing twice.

Dispatch happens only through the governed native Desktop lane
(`zcode_native_*` transport) and only while its identity attestation holds —
observed Desktop-managed GLM binding (sanctioned: builtin:zai-start-plan/GLM-5.3-Flash,
the Z.AI Individual Plan route). When the native lane is down the
coordinator degrades explicitly and claims nothing; there is no fallback and
no silent provider substitution.

### Desktop-agent prerequisite

The native lane executes tasks through the Desktop-managed ZCode agent. That
agent is reachable only when **ZCode Desktop runs with the Z2C desktop-agent
proxy**, i.e. it is launched with:

```
ZCODE_AGENT_SERVER_COMMAND = <node.exe>
ZCODE_AGENT_SERVER_ARGS_JSON = ["<z2c-install>/scripts/desktop-agent-proxy.mjs", "--stdio"]
```

The proxy publishes the per-workspace registration under
`%LOCALAPPDATA%\z2c\desktop-agents\` that the Z2C desktop provider requires
(run Z2C with `Z2C_PROVIDER=desktop` or the default `auto`). Without a live
Desktop-driven agent, admission fails explicitly (`provider not healthy`)
and tasks remain safely queued — they are claimed and dispatched
automatically once the lane recovers.

New tasks are claimed only inside the configured claim window
(`C2C_ZCODE_COORDINATOR_WINDOW`, local `HH:mm-HH:mm` ranges, comma-separated,
optional — default is always); already-running tasks always finish.
Dependency (`depends_on`) and write-conflict rules are enforced at claim
time: read tasks never conflict, declared writes conflict on any resource or
exclusive-path intersection, and an undeclared write is globally exclusive.

Environment (all optional):

- `C2C_ZCODE_COORDINATOR_DISABLE` — set `1` to disable the coordinator.
- `C2C_ZCODE_COORDINATOR_WINDOW` — claim window(s), e.g. `01:00-09:30,22:00-23:59`.
- `C2C_ZCODE_COORDINATOR_MAX_PARALLEL` — 1..3 (default 1).
- `C2C_ZCODE_COORDINATOR_POLL_MS` — loop interval, 1000..60000 (default 15000).

## Control-plane status layers

`zcode_list_tasks` returns a bounded `control_plane` view that names the
broken layer without exposing secrets or raw process output:

`QUEUE_ROOT_MISSING` → `QUEUE_ROOT_UNSAFE` → `WORKSPACE_BINDING_FAILED` →
`COORDINATOR_NOT_RUNNING` → `OUTSIDE_CLAIM_WINDOW` →
`ZCODE_DESKTOP_UNAVAILABLE` → `AUTH_NOT_ATTESTED` → `WRONG_PROVIDER` →
`READY`.

`zcode_native_self_test` reports a structured PASS/FAIL layer per check:
transport, service protocol, workspace binding, Desktop-managed auth,
provider identity, model identity, submit admission, idempotent replay,
idempotency conflict, task read-back, session attestation, queue/writer
invariants and cancel cleanup. A global PASS requires the full chain, not
mere HTTP connectivity.

## Files

| File | Role | Writers |
|---|---|---|
| `queue.jsonl` | append-only task queue (lifecycle input) | `zcode_enqueue_task` |
| `receipts.jsonl` | append-only lifecycle truth (START, COMPLETED, FAILED, CANCELLED) | **only the C2C-owned coordinator** |
| `control.jsonl` | append-only cancellation requests (`CANCEL_REQUESTED`) | `zcode_cancel_task` |
| `worker-state.json` | bounded worker status cache (never lifecycle truth) | the C2C-owned coordinator |
| `bootstrap-receipt.json` | bootstrap metadata (worker version/model/schedule) | bootstrap only |

## Tools

| Tool | Scope | Purpose |
|---|---|---|
| `zcode_enqueue_task` | `execution.submit` | Append one governed task to `queue.jsonl` |
| `zcode_get_task` | `execution.read` | One task's merged status, receipts and error |
| `zcode_list_tasks` | `execution.read` | Queue-order listing with the worker state cache |
| `zcode_cancel_task` | `execution.cancel` | Append `CANCEL_REQUESTED` to `control.jsonl` |

Existing workspace authorization is unchanged: these tools layer
`execution.*` scopes on top of the current C2C auth model and never weaken
it.

## Task schema (`queue.jsonl`)

```json
{
  "task_id": "zcode_a1b2c3d4e5f6...",
  "created_at": "2026-09-05T01:26:52+10:00",
  "role": "worker",
  "priority": 0,
  "instruction": "...",
  "network": false,
  "mode": "read|write|verify",
  "resources": ["frontend", "backend/api"],
  "exclusive_paths": ["backend/api/**"],
  "depends_on": ["zcode_prev_task"]
}
```

Only `role`, `priority` and `instruction` are required; `task_id` is
generated (`zcode_<24 hex>`) when omitted. `network` is always stored as
`false` and a `network=true` submission is rejected. `mode`, `resources`,
`exclusive_paths` and `depends_on` are optional and are consumed by the
ZCode coordinator's conflict and dependency rules (a `write` task without a
declared scope is treated as globally exclusive).

### Rejection rules

- `task_id` already present in `queue.jsonl` **or** `receipts.jsonl` →
  `ZCODE_DUPLICATE_TASK_ID`.
- Credential-like instructions are rejected with `ZCODE_CREDENTIAL_INPUT`:
  the listed terms (`token`, `password`, `cookie`, `api_key`,
  `client_secret`, `private key`, credentials) fail on occurrence, and
  `key: value` shapes fail the sanitizer.
- Malformed schema values fail with `ZCODE_INVALID_TASK`.

## Status truth

`receipts.jsonl` is the lifecycle truth. The merged status is derived with
a strict precedence, never guessed:

```
COMPLETED | FAILED | CANCELLED   (terminal receipt)  → completed | failed | cancelled
START receipt                                        → running
CANCEL_REQUESTED (control.jsonl)                     → cancel_requested
nothing                                              → queued
```

If any truth file contains a malformed line, the whole read fails closed
(`ZCODE_MALFORMED_FILE`) — bad lines are never skipped.

## Cancellation

`zcode_cancel_task` only ever appends
`{"event": "CANCEL_REQUESTED", "task_id": ..., "timestamp": ...}` to
`control.jsonl`. It refuses unknown tasks (`ZCODE_TASK_UNKNOWN`) and tasks
that already have a terminal receipt (`ZCODE_ALREADY_TERMINAL`). Repeated
requests are idempotent. It can never write `COMPLETED`, `FAILED` or
`CANCELLED` — terminal receipts belong to the ZCode queue coordinator
coordinator alone.

## Output hygiene

All tool outputs are sanitized before leaving the bridge: credential
shapes are redacted, absolute local paths are replaced with
`[local-path]`, and long text is bounded (instruction excerpts ≤ 600
characters, list caps ≤ 100 tasks, per-file reads ≤ 8 MiB).

## Testing

`tests/zcode-control.test.ts` covers schema validation, duplicate ids,
credential rejection, malformed-JSONL fail-closed behavior, output
sanitization, cancel-request truth, terminal receipt precedence,
symlink/junction escape rejection and the 8 MiB read cap — all against
isolated temporary queue roots. The configured production root is never
touched by tests.
