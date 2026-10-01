# Continuation machine review

Executor completion never supplies independent acceptance. UI nodes first pass
the existing web source gate. Verification nodes keep their verification intent:
they do not run the web gate, and worker command summaries are historical
observations rather than deterministic test proof. Both kinds then require an
independent readonly review before becoming STABLE or releasing a dependency.

The controller calls `submitNative({write_scope: 'readonly', mode: 'plan'})`.
Only the returned task's exact `model_binding` is accepted:
`builtin:zai-start-plan` / `GLM-5.3-Flash`. Task, workspace and session namespaces
must match on subsequent reads and output retrieval. Constants are comparison
targets, not evidence. There is no Codex reviewer path or fallback. Readonly
review reads bypass writer-slot observation and cannot release a writer slot.

Each node stores up to three review attempts in its protected continuation
`state.json`. The controller writes a dispatch intent before submission and
writes the returned task/session/binding immediately upon validated admission.
Restart polls a known task, retaining its deadline; terminal receipts are not
re-read or overwritten. Invalid persisted review shapes, cross-node/workspace
bindings, symlinks and unexpected state-file targets fail closed.

Z2C supports optional workspace-scoped durable keys under `workspace-task-v1`.
Keys contain 1?128 ASCII letters, digits, underscores or hyphens, starting with
an alphanumeric character. The canonical SHA-256 request fingerprint covers the
exact instruction, workspace ID, write scope, network, mode and resume session,
with explicit defaults. Z2C also binds the authorized canonical workspace path.
The exact session binding gate still runs before admitting a new task. Under the
serialized workspace admission path, the task, key and FIFO entry are persisted
together before send. Replays validate the durable accepted binding and request,
return the same task/session/model binding before capacity checks, and never
create/resume a session or enqueue/send again. Conflicting requests fail closed.
Keyed records are not evicted by ordinary task-history retention.

C2C persists the exact original prompt and request fingerprint with `intentId` as
the key. An unbound DISPATCHING attempt replays that original request only when
owner, lease, pause and idle-writer safety permit. Recovery binds the returned
identity immediately, before current source verification. Changed source makes
the original result STALE; a later bounded attempt uses a new key. Requests never
change under the old key. Events distinguish fresh dispatch from recovery and
report whether Z2C actually replayed an accepted task.

The native client verifies `provider_status.durable_idempotency` before keyed
submission because older MCP builds may silently strip unknown arguments. An
older build blocks with `REVIEW_Z2C_UPGRADE_REQUIRED` before submit. The returned
key, request fingerprint, protocol, task/session namespace and GLM binding must
also validate. Conflict or invalid proof becomes DISPATCH_BLOCKED with no fresh
key or Codex fallback. Transport loss remains DISPATCHING/REVIEW_REPLAY_PENDING
and uses the existing 5?10 second wake. Legacy unkeyed uncertain records remain
readable but require explicit repair; a safe original key cannot be invented.

Both journals flush file contents before atomic replacement and fail closed on
persistence errors. The continuation journal never deletes its old durable file
as a rename fallback. Z2C stops further sends after a persistence failure until
restart reconciliation. Bootstrap restores queued-but-unsent FIFO membership;
already running tasks become interrupted and are never resent. This guarantees
one durable admission per key and at most one instruction send; it does not
promise completion after an ambiguous native-send crash. Windows Node cannot
flush parent directory handles; sudden power-loss/filesystem durability beyond
successful file flushes is not claimed. No live restart is performed by this work.

Reviewer output must be a JSON object with exactly `schema_version: 1`,
`decision: PASS | REWORK | BLOCKED`, `reviewed_task_id`, `source_fingerprint`,
`summary` (1–2000 characters), and `findings` (up to 20 strings, each 1–2000
characters). The whole output is limited to 12,000 UTF-8 bytes. Missing output,
invalid JSON, wrong task/fingerprint/schema, changed metadata, unsuccessful tasks,
transport failures and deadlines block release. Reviewer prose is sanitized.
No model/session/provider claims in output are trusted.

The dedicated review fingerprint includes the approved node governance tuple and
existing `apps/web`, `apps/api`, `apps/runner`, `packages`, `scripts`, `src`,
`tests`, and `docs` roots, plus root manifests and configuration. Unrelated
workspace data such as `var/db`, uploads, and arbitrary root binaries is outside
this acceptance surface. Missing optional roots are allowed.
It deliberately does not reuse the web verification fingerprint or gitignore.
Traversal is sorted and bounded to 25,000 entries, 64 directory levels, 16 MiB per
file and 128 MiB total, with containment and regular-file/symlink checks.
Generated build/cache/package directories, temporary files, `.codex-tmp`,
`.tooling/test-tmp`, and the two collector mirror files
`docs/audit-loop-state.md` and `docs/audit-execution-timeline.md` are excluded.
Other docs and audit documents remain covered. Oversized or unsafe trees block
review; no partial fingerprint is accepted.

The fingerprint is captured before dispatch and recomputed after completion and
before dependency release. A mismatch produces STALE; a new review may follow
within the three-attempt node limit. REWORK can dispatch only a previously
approved corrective executor input, subject to the existing task budget,
authorization, model/effort, pause/cancel, writer coordination and lease rules.
No corrective writes are inferred from reviewer findings. Each review has a
ten-minute deadline, with individual transport calls bounded to twenty seconds.
Known active reviews also schedule one adaptive, unref controller wake, initially
five seconds and at most ten seconds, bounded by the review deadline. It only
wakes the serialized controller; it creates no worker, writer slot, or collector
loop. It clears when no review is ACTIVE or awaiting keyed dispatch recovery, or the controller closes. Pause prevents
new dispatch/release. At the deadline, the exact persisted reviewer is cancelled
through `cancelNative`, bypassing writer-slot observation. The returned workspace,
task, session and model binding must match and the task must be terminal for
cancellation to be confirmed. Cancellation failures, pending responses, identity
drift, and interrupted cancellation persistence remain explicitly unconfirmed.
Every timeout blocks successors regardless of cancellation outcome. Uncertain
legacy dispatches without a proven key are never cancelled or retried. Keyed recovery first binds identity, then cancels immediately if its original deadline has expired.

Status exposes each node's `machineReview`, actual reviewer metadata, attempt
history, and `lastValidReceipt`. This is only the latest attempt's PASS receipt
for the current executor and fingerprint; otherwise it is null, including before
reconciliation notices an edit. BLOCKED and STALE require the known reviewer
identity; DISPATCHING, DISPATCH_BLOCKED and legacy REVIEW_DISPATCH_UNCERTAIN may lack it. Status exposes the non-secret key and request fingerprint but omits the original prompt.
Historical receipts do not establish freshness
for future successors. `lastAuthenticatedChatGptReviewAt` remains null and
`independentAcceptance` remains `PENDING_CHATGPT`: GLM machine review is not an
authenticated ChatGPT review. This change has offline fixture verification only;
it makes no live acceptance claim and requires no service restart during testing.
