# Architecture

```
             ┌───────────────────────────┐
             │    ChatGPT Web / Sol      │
             │  Reason / Plan / Review   │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
            Data Plane  │          │ Control Plane
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │
             │  MCP read/review    │
             │  scoped task adapter│
             │  OAuth AS + PRM     │
             │  Pairing Manager    │
             │  Tunnel Manager     │
             │  Admin API (local)  │
             └──────────┬──────────┘
                        │  policy-validated task / review data
                        ▼
             ┌─────────────────────┐
             │   Local Workspace   │
             └──────────▲──────────┘
                        │ scoped writes / tests
             ┌──────────┴──────────┐
             │ Official Codex      │
             │ App Server (v2)     │
             └─────────────────────┘
```

## Principles

- **ChatGPT thinks. Codex works.** The bridge never re-implements a coding harness.
- **Computer Use = control plane**: tiny `[C2C]` state messages (< 1 KB).
- **MCP = data plane**: ChatGPT pulls files/diffs/search results itself.
- **Explicit deployment mode**: the CLI may run the official Codex App Server in
  the user-selected full-access mode. ChatGPT still submits through the fixed
  task lifecycle rather than receiving an arbitrary MCP shell or App Server API.
- **Codex owns the agent lifecycle**: the bridge delegates thread/turn,
  approvals and interruption to the official Codex App Server.
- **Registry is the routing boundary**: one bridge owns a local registry of
  authorized workspace ids and canonical roots; one connector may select among
  those entries while owner/session checks remain in force.

## Components (src/)

| Module | Responsibility |
| --- | --- |
| `bridge/` | Express app assembly, loopback-only listener, port fallback, runtime state, admin API |
| `mcp/` | McpServer with 9 read/review tools, three task lifecycle tools, one separately scoped queue-control tool, and the exact-target Engineering AI audit-mirror writer; stateless Streamable HTTP transport |
| `auth/` | OAuth 2.1 authorization server: discovery metadata (RFC 8414 + Protected Resource Metadata), dynamic client registration (RFC 7591), authorization-code + PKCE (S256 only), refresh rotation, revocation (RFC 7009). Opaque tokens stored as SHA-256 hashes |
| `pairing/` | PairingCode lifecycle: CSPRNG generation, TTL, attempt limits, IP rate limit, one-time use |
| `workspace/` | Canonical-path containment (realpath of deepest existing ancestor), sensitive-file policy, `.c2cignore`, paginated read/list, ripgrep search with Node fallback, git status/diff with pagination |
| `tunnel/` | `TunnelProvider` interface + Cloudflare Quick and workspace-configured Named Tunnel implementations; business logic is vendor-agnostic |
| `execution/` | Official App Server stdio adapter, C2C-owned per-workspace runtime isolation, typed local verification profiles, exact-target audit-mirror writer, persisted task metadata, compatible JSONL execution records, and optional sanitized command output (`execution_output`) |
| `process/` | Daemon spawn/reuse, health probing, graceful shutdown |
| `cli/` | `c2c` commands; `--json` everywhere for the Skill |
| `config/`, `logger/` | OS-convention state dir, secret-redacting logger |

## Request lifecycles

**MCP call**: ChatGPT → tunnel (https) → bridge `/mcp` → bearer middleware
(401/403) → stateless StreamableHTTP transport → tool handler → workspace layer
(path containment → ignore rules → pagination) → JSON result.

**Controlled execution**: `submit_codex_task` → OAuth execution scope and
workspace/owner/session checks → fixed official `codex app-server --stdio`
client → `thread/start` → `turn/start` → one compatible execution record. The
CLI's full-access deployment sends `danger-full-access` and
`approvalPolicy: never`; `networkAccess` is the task's effective `network` flag,
which defaults to false and can be true only after local full-access capability
authorization. The Codex child therefore inherits the bridge process's OS
permissions while network remains opt-in. The public MCP surface still exposes only the task lifecycle;
`get_codex_task` exposes sanitized task metadata and ChatGPT reviews the
resulting `execution_summary`, `execution_output`, `test_status` and `git_diff`
data through the existing tools.

`execution_queue` is the separate bridge-owned control path for one registered
workspace. Its status action requires `execution.read`; pause/resume require
`execution.queue`. The pause record is durable per workspace, keeps queued
tasks in submission order, leaves the live writer untouched, and is exposed in
`workspace_info` and `execution_summary`. It cannot execute commands or change
task write/network permissions.

When `run_tests=true`, the agent is explicitly told not to run a test command.
After a successful coding turn, the bridge resolves a locally registered typed
verification profile for the workspace and invokes that fixed executable/argv
through the official App Server `command/exec` method. Verification remains
bridge-owned and bounded even though the coding turn is full-access: its profile,
cwd, timeout, sandbox and output release policy are not MCP inputs. Its result,
output id and argv hash are stored in the same compatible execution record. A
missing or invalid profile is a typed failure, never a successful task with an
unverified `run_tests` request.
Task, approval, verification and interrupt timers are bounded. Cancellation and
timeouts converge on one immutable terminal record, with an App Server close as
the documented Windows buffered-command fallback when an interrupt cannot settle.

**Multiple workspaces**: the bridge bootstraps the requested workspace and its
own repository into a persistent administrator-owned registry. MCP accepts only
stable registered ids; it never accepts a filesystem path as an authorization
input. Each selected workspace has its own task/runtime/audit namespace, while
the same OAuth connector token may carry the registered workspace id set.

**Authorization**: 401 with `WWW-Authenticate: resource_metadata=…` →
`/.well-known/oauth-protected-resource/mcp` → AS metadata → DCR →
`/oauth/authorize` (HTML pairing page) → pairing code verified → 302 with
authorization code → `/oauth/token` (PKCE S256) → access + refresh tokens.

**Ports**: prefer 48765, bind 127.0.0.1 only. On conflict, `/health` identifies
whether the occupant is a c2c bridge for the same workspace (reuse) or not
(fall back to an ephemeral port). Configuration follows automatically via the
runtime state file; users never see ports.

**Tunnel**: default is a Cloudflare Quick Tunnel (`cloudflared tunnel --url …`).
The URL changes per start, so `c2c doctor` can restart it and tell the Skill to
Delete + recreate that workspace's ChatGPT connector. A workspace may instead
choose a named hostname once (`c2c tunnel choose --mode named --zone <domain>`).
The Skill asks before the first public URL exists; `cloudflared tunnel login` is
the only extra user step. Tunnel name, UUID, hostname and preference live under
the OS state dir (`tunnels/<workspaceId>.json`), never in the project. Each
named start atomically rewrites a workspace-specific machine-local
`tunnels/<workspaceId>/cloudflared.yml` with the current loopback port, then
launches `cloudflared tunnel --config … run <uuid>` without a `--url` shortcut.
The bridge reports success only after the public `/mcp` endpoint returns the
expected unauthenticated HTTP 401; a 502 is always a failed start. Explicit
named provisioning fails closed if the hostname cannot be routed. If a named
tunnel later drops, doctor asks for a Cloudflare re-login (`namedRepair`) instead
of rotating the ChatGPT connector.
