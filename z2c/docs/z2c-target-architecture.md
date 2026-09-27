# Z2C Target Architecture (post open-source ZCode)

Date: 2026-09-21 (updated Phase 3)
Decision: **Option B — build on ZCode's official `zcode app-server --stdio` contract** (see `docs/zcode-open-source-integration-audit.md` for the evidence).

## Phase 3: distributable local service layer

The control path is now a product surface. One per-user daemon (`src/service/main.ts`, `z2c start`) owns everything and exposes ONE transport-neutral authorization layer (`src/service/sessions.ts` SessionService + `src/authz/*`):

```
ChatGPT MCP  ·  local CLI (z2c)  ·  future relay
        └────────── Transport Adapter ──────────┘
                       │  principals: service secret (local) | paired client tokens
                       ▼
        Z2C Authorization  (grants + pairing + ownership + attestation policy)
                       ▼
                 SessionService      ← semantic zcode_* tools ONLY; no raw RPC
                       ▼
            ZcodeOfficialProvider  (src/providers/zcode/official.ts)
                       ▼
        zcode app-server --stdio (children supervised, orphans cleaned)
```

- **Local service**: `docs/z2c-local-service.md` — pid file, supervision with bounded backoff, orphan-child cleanup, explicit state schemas under `%LOCALAPPDATA%\z2c`.
- **Auth**: high-entropy service secret with rotation grace; paired-client tokens (hash-only, shown once, revocable); management API is local-user only.
- **Workspace authorization**: local-user grants with read/write permissions; canonical-path anti-traversal; revocation is immediate on every call.
- **Session ownership**: paired clients see/control only their own sessions; bare session ids are not authorization.
- **Protocol version**: `Z2C_PROTOCOL_VERSION = 1` (src/version.ts) — decoupled from the ZCode runtime version; additive evolution, majors on breaking change.
- Legacy Phase-1/2 task tools remain registered under their old names (deprecated) for existing integrations.

## Chosen architecture

```
ChatGPT
   │  MCP over HTTP (loopback, bearer token) — semantic tools only
   ▼
Z2C MCP Server / control plane            (unchanged surface: src/mcp/server.ts)
   │  AgentProvider interface             (src/providers/types.ts)
   ▼
ZcodeOfficialProvider  ← NEW DEFAULT      (src/providers/zcode/official.ts)
   │  spawns, per authorized workspace pool:
   │    node <zcode.cjs> app-server --stdio
   │  official NDJSON ZCode Protocol      (schemas: @zcode/shared, source-verified)
   ▼
ZCode agent process (standalone mode)
   ├─ native sessions        (session/create|resume|read|list|send|stop|close)
   ├─ native provider/auth   (~/.zcode/v2/credentials.json — resolved IN-PROCESS,
   │                          never surfaced on the protocol to Z2C)
   ├─ native model selection (session/setModel, modelSelectionSchema)
   ├─ native thought level   (session/setThoughtLevel, per-model availability)
   ├─ native permissions     (interaction/* reverse requests — Z2C rejects
   │                          unattended asks; plan-mode lanes avoid them)
   └─ native tools/runtime   (unchanged; capability probing via runtime/capabilities)
```

### Why this and not the alternatives

- **A (existing external API):** nothing is published as an SDK; the only networked official surface (`@zcode/server`) is a 40-service collection behind a single token, cannot attach to the user's running Desktop, and drags credential/oauth channels behind the same gate. Rejected as the primary path.
- **B (official source-level contract):** `zcode app-server --stdio` is the exact contract ZCode Desktop itself uses (source: `zcodeAgentProcessManager.ts:438-464`); standalone mode resolves Coding-Plan auth in-process from the shared store. The installed binary (0.16.9) is the same code as the open-source repo, verified live. Smallest maintainable surface.
- **C (plugin + bridge):** plugins structurally cannot control sessions (declarative manifest only). Rejected for control; revisit only for pairing/connected-state UX later.
- **D (upstream patch):** not required for function. Reduced to a packaging/docs proposal (`docs/zcode-upstream-external-control-proposal.md`): publish `@zcode/rpc`/`@zcode/shared`/slim client and document the app-server embedder contract.

### Component responsibilities

| Component | Responsibility |
| --- | --- |
| MCP server | semantic tools (`zcode_session_*`), auth (loopback + bearer), no raw RPC forwarding |
| Task engine | queueing, admission policy (Flash-only governed lane), readback attestation |
| **ZcodeOfficialProvider** | spawn/monitor `app-server --stdio`, official protocol client, capability-resolved model/thought selection, authoritative `session/read` attestation, turn lifecycle via `session/event` (`turn.completed`/`turn.failed`), clean stop/close/resume |
| ZCode agent | sessions, credentials, provider registry, permissions, tools — 100% native |

### Protocol usage (official, source-verified)

- Requests `{id, method, params}` → responses `{id, result|{code,message}}`, notifications `{method, params}`, NDJSON framing. Z2C request ids are namespaced (`z2c-*`).
- Session ops: `session/create {workspace:{workspacePath, workspaceKey}, mode, persistence:"immediate"}`, `session/read {sessionId}` (authoritative snapshot: `session.{workspace,model}`, `settings.{model.available, thoughtLevel.{current,available}}`), `session/send {sessionId, content, inputId}`, `session/stop`, `session/close`, `session/resume {sessionId, workspace}`, `session/list {workspace}`, `session/messages {sessionId}`, `runtime/capabilities`.
- Turn completion: `session/event` notifications with `type: "turn.completed" | "turn.failed"` (envelope `{eventId, sessionId, seq, timestamp}`), replacing the legacy idle-poll heuristic (kept as a bounded fallback).
- Model resolution against live 0.16.9 behavior: availability-list match first (`ref`-nested entries), then a same-provider `session/setModel` carrying `options.reasoningLevel` — the session's OWN provider id (observed, never substituted) with ZCode enforcing entitlement; only the attested readback accepts the result. Live-verified: `zai-api/GLM-5.3-Flash` + `reasoningLevel: "max"` attests on the standalone route.
- Reverse requests from the agent (`interaction/requestPermission`, `interaction/requestUserInput`, …) are **rejected fail-closed** and recorded. A future `zcode_permission_respond` capability must be a semantic, audited, allow-listed surface — never raw forwarding.

### Readonly governance (Phase 2 — implemented, live-proven)

Live 0.16.9 findings that shaped the design:

- `session/create mode:"plan"` is silently ignored and legacy `session/setMode plan` is a no-op; the working path is the **v4 command** `switchCollaborationMode {mode}` under CAS.
- Plan mode is a **v4-projection flag** (`config.planEnabled`), observable only through the v4 conversation state stream — the legacy `session/read` mode field never reflects it.
- The plan flag is **runtime-local execution state**: a cold resume resets it to workspace defaults (history replays; the flag does not). A readonly lane must re-establish and re-attest after every resume.

Implementation (`ZcodeOfficialProvider`):

- `subscribeSessionState(sessionId)` — subscribes the authoritative v4 conversation topic (`clientMode: "desktop-continuous"`) and captures the snapshot (`revision`, `logEpoch`, `config.{mode, planEnabled}`); fail-closed if the snapshot frame is not observed.
- `readSessionCollaborationState(sessionId)` — authoritative re-read via `v4/conversation/resync` (forced snapshot, count-based freshness).
- `setSessionCollaborationMode(sessionId, mode)` — issues `v4/command {type: "switchCollaborationMode", payload: {mode}, baseRevision, baseLogEpoch}` with CAS material taken ONLY from the subscribed snapshot; `stale` verdicts refresh and retry (bounded); the transition must be OBSERVED in the projection (`planEnabled === true` for plan) or the call fails closed.
- `createSession({readonly: true})` establishes plan via the path above before returning; `resumeSession({readonly: true})` re-establishes it after cold resume.
- The engine requires observed `planEnabled === true` at admission AND again at dispatch for every readonly task; key replay re-validates the persisted plan evidence. A readonly task therefore can never run in an edit/build-approving mode.

Live proof: the real agent, told to write a file inside a plan session, refused ("plan mode is active, which prohibits any edits or non-readonly tool calls"), no file appeared, and the plan flag stayed true — see the canary (`npm run canary:official`).

### Security model mapping (mandatory invariants → mechanism)

| Invariant | Mechanism on the official path |
| --- | --- |
| Never paste/print/persist provider keys | Z2C holds no key material at any layer; `readZcodeRuntimeToken` and `Z2C_MODEL_API_KEY` lanes are retired (see migration plan) |
| Auth stays inside native ZCode | standalone app-server resolves Coding-Plan auth in-process (`process-provider-registry-runtime.ts:53-58`); no runtime-header reverse request ever reaches Z2C |
| No silent provider/model switch | model changes are explicit requests verified by `session/read`; provider identity is OBSERVED, never chosen by Z2C |
| Fail closed on unconfirmed identity | unsupported thoughtLevel is silently skipped by ZCode (`server-operations.ts:1313-1330`) → Z2C attests post-change state and throws on mismatch; binding read must match exact sessionId + workspace, else null/admission failure |
| No execution outside authorized workspaces | workspace registry canonicalization + `session.workspace` equality check on every binding read; `session/create` only with registry-approved refs |
| No raw RPC to ChatGPT | MCP tools are semantic; no `rpc_call(method, params)` surface exists |
| Another local process must not control ZCode | MCP HTTP is loopback-bound with a generated bearer token; the app-server child is stdio-only (no listener) |

### Remote connection model (design target, not in this slice)

Pairing flow stays as designed in the existing bridge work: user selects "Connect ChatGPT" → one-time pairing code → user selects authorized workspace(s) → ChatGPT receives a scoped capability. Outbound-only connectivity (tunnel) remains the transport goal. The protocol direction proven in this cycle is ChatGPT → Z2C MCP → Z2C bridge → native ZCode; the plugin investigation conclusion (audit §9) stands: plugins cannot carry the control direction and are optional UX sugar.

### Test strategy

In-process tests drive the provider against a fixture app-server implementing the OFFICIAL contract (`test/fixtures/fake-app-server.mjs`), including negative assertions (no `workspace/updateProviderRegistry` calls, no credential-bearing env, fail-closed model/thought mismatches). The live canary (`npm run canary:official`) proves the real installed agent end-to-end: capabilities → create → resolve+set model/thought → attested readback → read-only turn → streamed response → stop → resume.
