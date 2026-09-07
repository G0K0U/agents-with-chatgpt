# Omnigent G1 (Codex only)

Legacy Codex remains the default. Select Omnigent in the **local bridge process
environment**, then restart that bridge using its existing state directory:

```powershell
$env:C2C_ORCHESTRATOR = 'omnigent'
$env:C2C_OMNIGENT_URL = 'http://127.0.0.1:6767' # optional; this is the default
$env:C2C_OMNIGENT_HOST_ID = '<trusted local Omnigent host id>'
```

Set `C2C_ORCHESTRATOR=legacy` (or remove it) and restart to use legacy execution.
An invalid selector fails closed. Changing the flag does not migrate queued
tasks: tasks whose recorded orchestrator differs fail with `ORCHESTRATOR_CHANGED`
and must be submitted again explicitly. Existing task/session history stays
readable. No OAuth or canonical state directory settings change.

G1 uses the installed Omnigent Sessions API and its `codex-native` harness, while
the C2C provider remains `codex`. Omnigent must already be running with a local
host and working Codex authentication. C2C does not install, start or vendor
Omnigent, copy credentials, or expose administration endpoints as MCP tools.
Only literal HTTP loopback origins are accepted; redirects and URL credentials
are rejected. The operator's host id must refer to the same local filesystem.
An authenticated/unsupported server or unavailable Codex fails explicitly.
There is no fallback to another provider or to legacy coding execution.

C2C validates workspace access, owner/session identity, provider, write scopes
and network policy before dispatch. It uploads a small C2C-authored agent config
with no Omnigent OS tools, terminals, skills or provider delegation. Codex runs
with `workspace-write`, `approval=never`, explicit writable roots, temporary
directory exceptions disabled, web search disabled, and the C2C-authorized
network flag. The first declared writable directory is the session cwd so a
`src` scope does not implicitly grant the whole repository. Additional scopes
are passed explicitly. **G1 keeps this scoped sandbox even in a full-access C2C
deployment**; scopes outside the authorized workspace are rejected. Existing
legacy full-access behavior is unchanged. Unsupported permissions fail rather
than being escalated. C2C audits changed paths again after execution, including
changes to already dirty files. No worktrees are created or merged.

Each C2C task gets a fresh Omnigent session to prevent inherited permissions and
stale-turn output. The C2C session remains the continuation/history identity;
G1 does not reuse the provider's conversation. Its task, C2C session, Omnigent
session and turn ids are linked under `<stateDir>/omnigent/<workspaceId>/` and
in the existing task/session records. The linkage contains no prompt or output.
Do not change the origin/host configuration while remote tasks require recovery.

Requests, startup, execution, cancellation, SSE bytes and paginated transcripts
are bounded. C2C subscribes before sending an instruction because Omnigent has
no event replay. A live correlated native turn edge or typed response terminal
event is required; an idle snapshot alone never proves success. Only completed
assistant text from that turn is released through C2C's sanitizer. Reasoning,
other turns, tool payloads, upstream error bodies and credentials are excluded.

Cancellation sends `interrupt`, then `stop_session`, and confirms the dedicated
runner is offline. The evaluated interrupt API's `queued:false` acknowledgement
alone does not prove delivery. An unconfirmed stop leaves the task `cancelling`
and retains the workspace writer lease. Retry `cancel_codex_task` when Omnigent
is reachable. On restart, C2C stops outstanding remote writers before releasing
the workspace queue. A lost submit acknowledgement is never retried.

With `run_tests=true`, the existing C2C registered verification profile runs
after a successful, stopped Omnigent turn. It uses the existing fixed App Server
`command/exec` verification mechanism; no legacy `thread/start` or coding
`turn/start` is dispatched. Verification failure stays a task failure. The MCP
tools and their input schemas remain unchanged; task/record `orchestrator` is
additive.

The implementation is checked with deterministic fake transports, including
native lifecycle events. These tests do not establish live acceptance. The
smallest next live check is to restart an isolated bridge with the settings
above, authorize a disposable workspace, and submit a single-file Codex edit
with `write_scope: ["src"]`, `network: false`, `run_tests: false`. Inspect
`get_codex_task` and `execution_output` for the Codex identity, correlated ids,
scoped diff and completed result; also confirm that the Omnigent runner stopped.
Then test cancellation of a second bounded task and the registered verification
profile. Keep the current deployment on `legacy` until those live checks pass.
