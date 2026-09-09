# ZCode Integration: Free-Window Queue vs. Native Control Plane

The C2C bridge provides two distinct, non-overlapping ZCode integration surfaces:
1. **Free-Window Queue (`zcode_*`, 4 tools)**: An asynchronous, file-based batch queue driven by append-only JSONL files (`queue.jsonl`, `receipts.jsonl`) at an operator-configured root (`C2C_ZCODE_QUEUE_ROOT`).
2. **Native Start Plan Control Plane (`zcode_native_*`, 8 tools)**: A real-time, synchronous control plane that dispatches tasks directly to the native ZCode Desktop environment via an external companion bridge (`Z2C`).

These two surfaces serve different workflows and fail closed independently; there is no fallback between them in either direction.

| Attribute | Free-Window Queue (`zcode_*`) | Native Control Plane (`zcode_native_*`) |
|---|---|---|
| **Tools (count)** | 4 tools (`zcode_enqueue_task`, `zcode_get_task`, `zcode_list_tasks`, `zcode_cancel_task`) | 8 tools (`zcode_native_read_session`, `zcode_native_self_test`, `zcode_native_status`, `zcode_native_submit_task`, `zcode_native_get_task`, `zcode_native_cancel_task`, `zcode_native_execution_output`, `zcode_native_resume_session`) |
| **Execution mode** | Asynchronous batch queue | Real-time synchronous dispatch and multi-turn session resume |
| **Backend** | File-based append-only logs (`queue.jsonl`, `receipts.jsonl`) | Companion Z2C Desktop bridge (external, Desktop-owned auth) |
| **Identity / Binding** | Generic worker queue roles | Exact session pin: `builtin:zai-start-plan / GLM-5.3-Flash` |
| **Gating environment** | `C2C_ZCODE_QUEUE_ROOT` | `ZCODE_NATIVE_ALLOWED_WORKSPACES` |
| **Multi-turn resume** | Not supported (single-task batch queue) | Supported via `zcode_native_resume_session` |
| **Status truth** | `receipts.jsonl` (written exclusively by coordinator) | Native Z2C protocol state, writer slot serialization |

---

# Part 1: ZCode Free-Window Queue (`zcode_*`)

The four `zcode_*` MCP tools give ChatGPT/C2C governed access to a ZCode
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

# Part 2: Native ZCode Start Plan Control Plane (`zcode_native_*`)

The eight `zcode_native_*` tools provide a governed real-time control plane forwarding tasks directly to the native ZCode Desktop environment.

## Architecture & Boundaries

- **External companion Z2C**: Forwarding relies on an independent companion bridge (`Z2C`) that interfaces with the desktop agent. The companion Z2C bridge is **external** to this repository and is not bundled here.
- **Desktop-owned authentication**: All model authentication is managed and minted by the native ZCode Desktop runtime through a runtime auth handoff. The C2C bridge requires no upstream API keys, manages no secrets, and never falls back to API keys.
- **Exact identity pin & fail-closed**: Z2C admits tasks only after asserting exact session binding to `builtin:zai-start-plan / GLM-5.3-Flash`. The binding is verified on session read and re-verified on task submission. Any divergence from this exact identity fails closed immediately. No fallback to the free-window queue or other providers exists in either direction.
- **Workspace allowlist**: Native forwarding is gated by the `ZCODE_NATIVE_ALLOWED_WORKSPACES` environment variable. Unless a workspace is explicitly included in this comma-delimited allowlist, all native operations fail closed.
- **Queue & writer serialization**: Native submissions honor the shared workspace queue pause/freeze state and serialize through the workspace writer slot.

## Native Tools (8 tools)

| Tool | Scope | Purpose |
|---|---|---|
| `zcode_native_read_session` | `execution.read` | Read and attest the exact native session workspace, Desktop Start Plan provider (`builtin:zai-start-plan`), and model (`GLM-5.3-Flash`); fails closed on mismatch |
| `zcode_native_self_test` | `execution.submit` | Read-only protocol self-test verifying durable idempotency, exact binding, replay, conflict detection, and unchanged queue/writer state |
| `zcode_native_status` | `execution.read` | Check health and Start Plan identity of the independent Z2C desktop control plane for an authorized workspace |
| `zcode_native_submit_task` | `execution.submit` | Dispatch a realtime native ZCode Start Plan task via Z2C in an allowlisted workspace |
| `zcode_native_get_task` | `execution.read` | Retrieve bounded native task metadata (`z2c_*` task ID, `sess_*` session ID, status, timestamps) |
| `zcode_native_cancel_task` | `execution.cancel` | Cancel an active or queued native task (interrupts the underlying real ZCode session) |
| `zcode_native_execution_output` | `execution.read` | Retrieve bounded, sanitized final assistant output from a completed native task for independent audit of the GLM result |
| `zcode_native_resume_session` | `execution.submit` | Continue an existing native `sess_*` ZCode session with a new instruction, maintaining session context |

## Verification Status (Windows 11 x64)

The native ZCode companion integration is **VERIFIED** on Windows 11 x64 using only sanitized facts:
- **Status & self-test**: Status/self-test passed (`zcode_native_status` and `zcode_native_self_test`).
- **Exact session binding**: Bound strictly to `builtin:zai-start-plan / GLM-5.3-Flash`.
- **Real native model turn**: A real native model turn completed and returned output.
- **Same-session resume**: Same-session resume returned the new turn response while maintaining session continuity.
- **Workspace probe**: Engineering AI workspace probe completed.
- **Desktop authentication**: The companion Z2C Desktop bridge is external to this repository and Desktop owns authentication.
- **Hygiene**: Local paths, PIDs, task/session IDs, credentials, headers, account details, and private endpoints are strictly excluded.

