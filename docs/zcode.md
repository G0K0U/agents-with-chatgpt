# ZCode Free-Window Queue — Governed C2C Control Plane

The `zcode_*` MCP tools give ChatGPT/C2C governed access to a ZCode
free-window worker queue. The queue root is **operator-configured** via the
`C2C_ZCODE_QUEUE_ROOT` environment variable (for example, a directory inside
a deployment you own, such as `<your-workspace>/var/c2c-zcode`). It is unset
by default: without configuration the tools fail closed and report
`ZCODE_ROOT_MISSING`.

No caller can ever pass a filesystem
path — every tool operates on the configured root, and the control plane fails
closed on anything that is not a plain regular file inside it (symlinks,
junctions and reparse-point escapes are rejected, and reads are capped at
8 MiB per file).

## Files

| File | Role | Writers |
|---|---|---|
| `queue.jsonl` | append-only task queue (lifecycle input) | `zcode_enqueue_task` and the ZCode coordinator |
| `receipts.jsonl` | append-only lifecycle truth (START, COMPLETED, FAILED, CANCELLED) | **only the ZCode coordinator** |
| `control.jsonl` | append-only cancellation requests (`CANCEL_REQUESTED`) | `zcode_cancel_task` |
| `worker-state.json` | bounded worker status cache (never lifecycle truth) | the ZCode coordinator |
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
`CANCELLED` — terminal receipts belong to the ZCode free-window worker
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
