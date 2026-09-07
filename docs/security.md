# Security Model

## Trust boundaries

1. **Workspace registry** is the routing boundary. One bridge may serve several
   locally registered workspaces; every token carries an authorized workspace-id
   set and a request for an unregistered or unauthorized id returns 403.
2. **Workspace content is untrusted.** README, comments, diffs may contain
   prompt injection. Every MCP tool description carries an explicit warning and
   tools never grant capabilities based on file content.
3. **The model never sees long-lived credentials.** Computer Use only ever
   handles the one-time pairing code. Access/refresh tokens travel only inside
   the OAuth redirect/token endpoints between ChatGPT's client and the bridge.

## Threat model → mitigations

| Threat | Mitigation |
| --- | --- |
| MCP URL leaks | URL alone is useless: every `/mcp` request requires a valid bearer token (401 without, 403 wrong workspace) |
| Pairing code brute force | 8 chars from a 31-char CSPRNG alphabet (~40 bits), 5 attempts per session, per-IP rate limit (10/min), 5-minute TTL, one-time use, session destroyed on limit |
| OAuth CSRF | `state` round-tripped verbatim; authorization requests are server-side records keyed by random ids |
| Code interception | PKCE S256 mandatory (plain rejected); authorization codes are one-time, 5-minute TTL, bound to client + redirect URI |
| Token theft | Opaque high-entropy tokens; stored only as SHA-256 hashes; access tokens live 1 h; refresh tokens rotate on every use (replay of the old one fails); revocation endpoint + `c2c unpair` |
| Workspace traversal in MCP read/review tools | `realpath` canonicalization of the deepest existing ancestor; containment check against the selected registered root; case-insensitive comparison on macOS/Windows; rejects `..`, absolute escapes, backslash tricks, null bytes. This does not sandbox a full-access coding turn. |
| Symlink escape in MCP read/review tools | Canonicalization resolves symlinks before the containment check (file and directory symlinks both covered by tests). Full-access task execution intentionally bypasses this read-tool boundary. |
| Sensitive files in MCP responses | Deny-by-default patterns (.env*, keys, SSH, cloud creds, keychains…) remain enforced for reads, listings and search; `git diff` adds pathspec excludes; `.env.example` allowed. The full-access executor may access such files because that is the selected permission mode. |
| Oversized file / diff DoS | read_file caps lines and bytes per response; git_diff paginates by byte offset with hard caps; search caps matches and file sizes |
| Tunnel exposure | Bridge binds 127.0.0.1 only (refuses 0.0.0.0); the only public surface is HTTPS via the tunnel, protected by OAuth; `/health` reveals only a salted workspace hash |
| Admin API abuse | Loopback-only + random admin token (0600 runtime file) + requests with proxy headers (`cf-connecting-ip`, `x-forwarded-for`) rejected; unauthenticated probes get 404 |
| Shared-state multi-instance race | One bridge-owned state-domain lock and owner record is held for the process lifetime. Each restart receives a generation and private auth snapshot; writes revalidate the generation immediately before commit. A live legacy bridge in the same state domain is rejected, while an explicit isolated `C2C_STATE_DIR` creates an independent domain. |
| Log credential leakage | Logger redacts token prefixes, bearer headers, token-like parameters, and pairing-code-shaped strings before writing |
| Controlled task authorization | `execution.submit`, `execution.cancel`, `execution.queue`, and `audit_mirror.write` are separate explicit OAuth scopes; task input remains strict and is bound to a registered workspace, owner and session. In full-access mode the submitted Codex task intentionally receives the bridge process's OS permissions. Queue pause is workspace-scoped and does not alter task permissions. |
| Engineering AI audit mirror | The separately scoped writer accepts only bounded text or the matching fixed ledger read through an authorized Engineering AI workspace. It resolves only an explicit/standard/bounded-discovered named OneDrive account root, accepts exactly the two `Desktop/Startup` siblings (`engineering-ai-audit-status.md` and `engineering-ai-audit-timeline.md`), maps them to `docs/audit-loop-state.md` and `docs/audit-execution-timeline.md`, canonicalizes real paths, rejects traversal/siblings/absolute paths and symlink/junction/reparse-point escapes, writes through a complete temporary file plus atomic rename, and records UTC/byte-count/SHA-256 evidence in the C2C execution log. |
| Codex approval escalation | The CLI full-access deployment sends `approvalPolicy: never`; the user-selected mode intentionally removes the former approval gate. Thread/turn identity, owner/session routing and terminal lifecycle checks remain. |
| Agent runtime pollution | The fixed App Server child receives a bridge-owned per-workspace `SERENA_HOME`; its fixed official MCP config layer explicitly forwards only that variable to Serena. Serena's supported external project-data setting is prepared before startup. The state path is canonicalized and must be outside the connected workspace. Runtime paths are not added to task write scopes and are not accepted as task permission roots. |
| Network opt-in / web-MCP bypass | Coding-task network is disabled by default, including in full-access mode. Only an explicit `network: true` accepted by the locally authorized full-access deployment enables the coding turn's `networkAccess`; verification remains `network: false`, and task lifecycle plus OAuth execution scope remain the authorization gate. |
| Execution output leak | Codex may nominate test/build/lint logs; a local sanitizer redacts tokens, pairing-code-shaped strings and home paths, truncates size, and refuses private-key blocks entirely. Restricted items are listed without a body. ChatGPT still cannot run commands directly. |
| Verification command injection | `run_tests` is only a boolean. The bridge resolves a local typed profile keyed by the registered workspace id; executable, argv, cwd, timeout, sandbox and network policy are not MCP inputs. The official App Server `command/exec` call is constructed from that profile and is never exposed as a public tool. |
| Verification state pollution | Verification reads the connected repository but uses a task-specific C2C-owned temp/cache root as its only writable root. Runtime creation and cleanup canonicalize paths and reject workspace-inside or reparse-point escapes. A missing profile or failed verifier is recorded as failure rather than success. |
| Lifecycle/resource exhaustion | Task, verification, approval and interrupt operations have bounded timers. Cancellation/timeout first uses the official interrupt lifecycle, then closes the fixed App Server connection when needed. The active slot remains occupied until cleanup completes, and terminal publication is guarded against duplicate or late events. |
| Checkpoint / resume dump | Session checkpoints store short protocol fields only (capped). Resume uses the existing chat or HANDOFF — no new protocol state, no log paste, no re-pairing. |

## Token & scope design

Scopes: `workspace.read`, `workspace.search`, `git.read`, `execution.read`,
`execution.submit`, `execution.cancel`, `execution.queue`, `audit_mirror.write`,
`offline_access`. The execution write/cancellation/queue scopes are explicit and are not included when an
OAuth client omits `scope`.
Tools enforce scopes individually (`INSUFFICIENT_SCOPE`).
Access tokens: 1 hour. Refresh tokens: 30 days, rotated. All tokens bound to
authorized workspace-id set and `client_id`.

## Storage

State lives under the OS-convention app dir
(`~/Library/Application Support/codex-with-chatgpt` on macOS), directories 0700,
files 0600. Named-hostname preference and tunnel metadata live there too
(`tunnels/<workspaceId>.json`) — never in the project. Only SHA-256 hashes of
tokens are persisted — a stolen state file does not yield usable bearer tokens.

**V1 limitation**: client registrations and token hashes are file-based rather
than OS-keychain-based. The first owner generation imports the prior bridge and
workspace snapshots once; subsequent generations read only the prior
generation snapshot and write only their own generation file. Each mutation
still uses the process-safe latest-snapshot lock and complete temporary-file
replacement, and a generation fence is checked immediately before commit.
Malformed state is never silently overwritten. Raw tokens are never written
anywhere. Keychain integration is a V2 item.

## Controlled execution boundary

With explicit `execution.submit`, ChatGPT may submit a task containing a
registered workspace id, natural-language instruction, directory scope,
`run_tests`, `network`, and the compatibility field
`approval_mode: workspace_write`. `network` is false when omitted, and true is
accepted only by the locally authorized full-access deployment. The official
App Server performs the coding work with `danger-full-access`,
`approvalPolicy: never`, and the effective `networkAccess` value; the task can
use the OS permissions of the bridge process. The public MCP endpoint still does not
accept arbitrary App Server methods or expose a generic shell tool, and task
metadata/output remain sanitized.

Without the explicit execution scopes, the nine existing read/review tools
continue to work exactly as before. The audit mirror requires its own explicit
scope, and every attempted mirror write appends an auditable record to the
existing workspace JSONL execution log.

The App Server's C2C runtime state is kept under the OS state directory at
`runtime/workspaces/<workspace-id>/`; this is separate from the workspace's
user-visible files and from the task's declared writable roots. A state-path
misconfiguration that would place runtime data inside the workspace fails
closed before runtime directories are created.

## Full-access deployment mode

The current CLI deployment intentionally replaces the former coding-turn
sandbox, sensitive-path denylist, and approval gate with the user-selected
full-access mode. A holder of the connector's execution scopes can direct local
Codex to read, create, modify, delete, and execute wherever the bridge process's
operating-system account has access. Network remains disabled by default and is
an explicit per-task opt-in in this deployment. This is an intentional
permission trade-off, not a security pass under the former sandbox criteria.

The fixed 14-tool MCP contract, OAuth scope checks, stable workspace registry,
workspace/owner/session/task ownership, loopback-only admin API, and output
redaction remain active. The verification profile below is still bridge-owned
and bounded, but it is an observability/reproducibility guard rather than a
sandbox around the full-access coding turn.

The queue-control tool is intentionally narrower than execution submission: it
accepts only a registered workspace id and `status`, `pause`, or `resume`. Its
durable state is bridge-owned and per workspace; a paused queue blocks only
queued work in that namespace and does not interrupt the active task.

## Verification capability

The bridge deliberately separates agent write authorization from deterministic
verification authorization. The former is the task's existing directory
`write_scope`; the latter is a local registry entry selected by workspace id.
The registered profile is a fixed local verification command selected by
workspace id. It uses its own C2C runtime/temp/cache root and sanitized output.
This is a local deployment choice, not a permission granted by project files or
by ChatGPT. Expanding the registry requires a code/config change and
corresponding tests; it cannot be done through task instructions.
