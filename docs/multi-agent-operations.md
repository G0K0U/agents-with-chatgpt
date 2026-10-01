# Multi-agent operations guide

User-facing operational guarantees of the A2C control plane: how execution
requests are selected, gated, tracked, cancelled, recovered, and audited. This
document describes behavior of the shipped code — it is not a design proposal.

## Naming

- **A2C** — the shared platform: loopback bridge, OAuth-protected MCP gateway,
  workspace authorization, provider registry, session registry, supervisor,
  tunnel management, release/LKG lifecycle, doctor.
- **C2C** — the Codex provider lane (official Codex App Server).
- **Z2C** — the ZCode/GLM provider lane (the `z2c/` companion in front of the
  official open-source ZCode `app-server --stdio` protocol).
- **G2C** — the Gemini provider lane (Antigravity/AGY CLI + Google OAuth).

## Plan, model, and effort selection

The ZCode/GLM lane is billing-plan aware. Plans are `DEFAULT`, `START`, and
`INDIVIDUAL`.

**Runtime capability boundary.** Plan-aware entitlement selection is a
capability of the patched ZCode CLI build (see `patches/zcode/` in the
repository: patch against `zai-org/ZCode` v3.14.3, Apache-2.0, with
reproducible build steps). A stock ZCode runtime supports the DEFAULT path
only; requests naming START or INDIVIDUAL against it fail closed as
`plan-unavailable`. Capability must be confirmed per runtime via
`runtimeCapabilities` (`entitlementSelection`, `machineLocalFilesystem`) —
an agent self-reporting `>= 0.16.9` is not sufficient evidence.

- Selection is **explicit-first**: a request that names a plan is honored
  exactly or rejected. `DEFAULT` is never auto-chosen for a request that did
  not ask for it, because a DEFAULT session may land on an entitled route and
  silently consume that plan's quota.
- The requested plan, the plan the runtime actually selected, and the evidence
  source are recorded as three distinct fields and must agree; a mismatch is a
  fail-closed rejection, never a silent correction.
- **No silent substitution**: model and effort are resolved against the live,
  account-scoped model catalog of the selected plan (`agent_model_catalog` /
  `agent_model_resolve`). A model or reasoning effort the catalog does not
  confirm fails with an explicit error before any turn is spent. On the
  standalone route, GLM-5.3-Flash requires an explicit reasoning level.
- **No cross-plan fallback**: an exhausted or unavailable quota never causes
  automatic consumption of a different plan. Only a request that explicitly
  names the other plan can use it.

## Fail-closed rules

Anything that cannot be proven is rejected, not approximated:

- An unobserved or mismatched provider/model identity fails task admission.
- A plan that cannot be honored is reported as `plan-unavailable` (a
  credential-state verdict with its own exit code), not as a crash or a
  fallback.
- Read-only lanes whose effective mode cannot be attested are torn down, not
  downgraded to "probably read-only".
- Network access defaults to **online** for tasks in a full-access deployment
  when the `network` field is omitted; an explicit `network: false` always
  forces offline execution. Deployments without full access reject every
  network-enabled task (`NETWORK_NOT_ALLOWED`) instead of launching anyway —
  there is no path that launches a provider while claiming offline guarantees
  it cannot enforce.

## Read-only vs. write boundary

- Read/review tools (file read, git diff, task/queue/provider state) are
  workspace-relative and separately scoped; they never mutate.
- Write paths (task submission, resume, cancel, queue control, provider
  control) are distinct MCP tools with their own OAuth scopes. ChatGPT cannot
  reach an arbitrary shell or protocol method — only the code-defined surface.
- Within a lane, session modes are attested from the native session itself;
  a claimed "plan mode" that reads back as edit/build fails closed.

## Idempotency

Task submission accepts a client-supplied `idempotency_key`
(1–128 ASCII letters/digits/underscores/hyphens). A replayed key on the same
workspace returns the existing task instead of creating duplicate work; the
stored task keeps a request fingerprint so a *changed* payload under the same
key is detectable rather than silently honored.

## Single writer

Each lane has one writer slot. Concurrent task execution on the same lane is
serialized or explicitly rejected — never interleaved. Writer-slot ownership
survives restarts and is recovered after a crashed holder exits, so a stale
process cannot deadlock the lane.

## Cancellation and failure checkpoints

- Tasks can be cancelled while queued or in flight; the native session is
  stopped and closed, and the task record reaches an explicit terminal state.
- Timeouts and provider failures close the loop: the task ends with a
  classified terminal state (not an indefinite hang) and a receipt that
  records the checkpoint reached, so a restart can resume or report instead
  of guessing.

## Quota classification

Terminal states distinguish *why* work stopped: quota/entitlement verdicts
(plan unavailable, credential state) are reported as first-class outcomes with
their own evidence, separate from crashes, timeouts, or cancellations. This
lets automation retry the right things (e.g. re-provision a credential) and
never the wrong ones (e.g. burn another plan's quota).

## Recovery and deployment

- `node scripts/deploy.mjs` is the one-command, idempotent local deploy
  (fresh clone or update). It never touches tunnels or DNS.
- `a2c restart` restarts the bridge; `a2c release activate` /
  `a2c release rollback` provide a validated, bounded LKG promote/rollback.
- The supervisor owns boot ordering (bridge → tunnel → provider lanes) and
  self-checks via `a2c supervisor status`.
- Task metadata and receipts persist across restarts; sessions can be listed
  and re-attached after a bridge restart.

## Network configuration and permissions

- The bridge is loopback-only HTTP with OAuth 2.1 (PKCE S256, dynamic client
  registration, rotating refresh tokens). No token → 401; wrong workspace → 403.
- Public reachability (Cloudflare quick or named tunnel) is a separate,
  human-operated step; local-only operation is fully supported. Deploy never
  creates or modifies tunnels.
- The full-access local executor is intentional and opt-in
  (`C2C_FULL_ACCESS_DEVELOPMENT=true`, see `docs/full-access-development.md`):
  task network access defaults to online when `network` is omitted, an
  explicit `network: false` forces offline execution, and non-full-access
  deployments reject network-enabled tasks outright.
- Pairing codes are the only secret that ever reaches a browser: one-time,
  short TTL, rate-limited, destroyed on use.

## Optional: ChatGPT dot + Slack coordination pattern

A practical pattern for long-running work: a ChatGPT dot assistant watches a
Slack channel and the bridge's authenticated MCP surface.

- **Continuous status checks** — the dot runs `a2c status --json`,
  `supervisor status`, and task reads on the machine that owns the bridge and
  posts concise summaries to Slack.
- **Terminal-state notifications** — START/COMPLETED/FAILED/CANCELLED
  receipts are announced, so finished or dead work is visible without
  watching a terminal.
- **Result audit** — the dot verifies claims against receipts and the
  audit-mirror journal rather than trusting chat text.
- **Authorized iteration** — follow-up tasks are dispatched only for changes
  explicitly authorized by the human in that thread.

Limits to plan around:

1. The loop depends on three things holding at once: the ChatGPT connector
   staying reachable, the OAuth identity you attach to the dot retaining its
   scopes, and a valid monitoring configuration on the machine that owns the
   bridge. If any of the three breaks, the loop stops; it does not self-heal
   and nothing here runs as an always-on service.
2. Monitoring here means explicit repeated queries and receipt reads — a
   single status call is not a persistent monitor, the dot is not permanently
   online, and Slack threads must not be assumed to auto-refresh tool schemas
   when the MCP surface changes.
3. No across-the-board model-stability claim is made: lane acceptance states
   differ (see the support matrix) and can change between cycles.
4. Every check and iteration consumes quota from the plan backing the dot.
   No component auto-switches plans on exhaustion.
5. This is a pattern, not a bundled feature: no Slack integration code and no
   dot internals ship with this repository.

## Evidence boundary (of the current release)

Stated plainly to avoid overclaiming: the Z2C companion suite passes in full
(302/302 re-run on the release-candidate tree) and typecheck/build pass. The
repository's own vitest suite (91 files) was rerun on the release-candidate
tree under controlled concurrency (`--maxWorkers=2 --minWorkers=1`, offline
fixtures only): **1408 passed, 3 skipped, 0 failed (1411)**. Chat-side runs
reported below completed with output match and
independent session reads across both billing plans — INDIVIDUAL GLM-5.3/max,
INDIVIDUAL GLM-5.3-Flash/max, and START GLM-5.3-Flash/max (maintainer's
terminal; not reproducible from this repository alone). The Gemini/AGY lane
was accepted in that cycle: `gemini-3.8-flash-high` at high reasoning effort
completed two consecutive turns in one session with output match. The Codex
lane is reported stable in use but was not individually re-accepted in the
current cycle. The DeepSeek/DSH adapter (`integrations/dsh-native-adapter`) is
explicitly partial: discovery works, while `dsh_task_submit` precise selection
currently covers exactly two **local slots** — the GSQ slot A
(`Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf`) and the Bonsai CRACK slot B
(`Bonsai2-CRACK-PQ2.ninfer`). Other local alternative weights are not yet
supported, and deepseek-official cloud models are out of scope for this
round. This is not an all-model/all-platform
production certification, and it is not a claim that all agent families are
fully covered.
