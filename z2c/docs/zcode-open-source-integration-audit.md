# ZCode Open-Source Integration Audit (Z2C Phase 0)

Date: 2026-09-21

> **Correction (2026-10-01):** this Phase-0 audit describes the *installed*
> Desktop agent, which was indeed not modified. It must not be read as
> "upstream is unmodified": the local OSS source checkout has since been
> patched (standalone entitlement selection + machine filesystem scope) and
> self-built into the CLI the Z2C/GLM lane can run. The authoritative,
> reproducible delivery is `patches/zcode/` in the A2C repository (patch
> against `zai-org/ZCode` `v3.14.3` / `29628c9`, Apache-2.0, with build
> steps). See `docs/multi-agent-operations.md` for the stock-vs-patched
> capability boundary.

Audited tree: upstream checkout of https://github.com/zai-org/ZCode at commit `872ad96` ("feat: open source"), monorepo version `3.14.0`.
Checkout location: a local read-only upstream reference checkout outside both Z2C trees (the installed application was not modified).

Installed-runtime cross-check (this machine, Windows):

| Artifact | Installed | Open-source repo | Match |
| --- | --- | --- | --- |
| Bundled agent `resources\glm\zcode.cjs` | `--version` → `0.16.9` | `apps/zcode-cli/package.json` → `0.16.9` | exact |
| Built-in provider config materialized | `~/.zcode/v2/runtime/provider/windows-x86_64/{3.12.3, 3.14.0, 3.14.1}` | monorepo version `3.14.0` | same era |
| Shared credential store | `~/.zcode/v2/credentials.json`, `provider_config.json`, `coding-plan-cache.json` exist | `packages/services/src/paths.ts:36-39`, `packages/adapters/src/auth/shared-credentials.ts:289` | exact |

Conclusion of the cross-check: **the installed Desktop's agent runtime is the same code that is now public.** Auditing the repository is auditing the installed binary; the minified `zcode.cjs` no longer needs to be probed to learn protocol behavior.

## Live-runtime deltas (observed during the 2026-09-21 canary; source vs installed 0.16.9 behavior)

Deltas discovered while proving the official path end-to-end against the real agent. All are handled by the provider's resolution/attestation logic:

1. **Availability list shape**: live `settings.model.available[]` entries nest ids under `ref` — `{ref: {providerId, modelId}, label, contextWindow, maxOutputTokens, reasoning: {levels, defaultLevel}, properties}` — not top-level `providerId`/`modelId`. The list follows the current model (after a switch it reports the switched-to model).
2. **Provider identity on the standalone route**: the session's native provider is `zai-api` (default model `zai-api/GLM-5.3`, thought levels `low|high|max`, default `max`). The Desktop-era ids (`builtin:zai-coding-plan`) do not exist in the standalone registry — confirming the "never hardcode provider ids" rule.
3. **Flash requires an explicit reasoning level**: `session/setModel {model: {providerId: "zai-api", modelId: "GLM-5.3-Flash"}}` is rejected with `-32603 "Reasoning level is required for zai-api/GLM-5.3-Flash"`; adding `options: {reasoningLevel: "max"}` succeeds and the readback attests `zai-api/GLM-5.3-Flash`. So **GLM-5.3-Flash + thoughtLevel=max IS available and attested on the standalone path**.
4. **Plan-mode gap (security-relevant)**: `session/create {mode: "plan"}` is silently NOT honored (effective mode reads back `build`/`edit`), and legacy `session/setMode {mode: "plan"}` is accepted but does not change the state. The v4 `switchCollaborationMode` command requires CAS (`baseRevision` + `baseLogEpoch` from a v4 conversation subscribe). Z2C therefore FAILS CLOSED on readonly lanes on the official path (provider attests the effective mode and tears the session down) until the v4 CAS path is implemented — see `docs/z2c-target-architecture.md`.
5. **Workspace handle retention**: the agent holds handles on the workspace directory for the process lifetime; Windows cleanup (rm) of a live workspace fails with EPERM until the child exits — cleanup must run after provider stop and be best-effort.

Live probe (installed binary, unmodified):

```
$ node resources\glm\zcode.cjs app-server --stdio
> {"id":"z2c-audit-1","method":"runtime/capabilities","params":{}}
< {"id":"z2c-audit-1","result":{"independentPlanState":true}}
```

plus `startup/storageState` notifications on stdout, NDJSON one object per line. This is the official protocol, running against the shared `~/.zcode/v2` store.

---

## 1. Which control surfaces are public/exported

All of the following are plain, readable TypeScript in the open repo (no minification, zod-validated schemas):

- **Agent app-server protocol (the surface Z2C needs most)** — method table `zcodeProtocolMethods` at `packages/shared/src/zcode-protocol/index.ts:3560-3664`; wire envelope schemas (`zcodeProtocolRequestSchema` = `{id, method, params, trace?}`, notifications `{method, params}`, responses `{id, result|error}`) at `index.ts:269-330`; NDJSON framing in `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/transport.ts:63-94` (`JSON.stringify(message) + "\n"`). Dispatch switch: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts:456-716`.
- **Session control methods** — `session/create` (`:1558`), `session/resume` (`:1582`), `session/list` (`:1600`), `session/subagents` (`:1611`), `session/read` (`:1648`), `session/messages` (`:1658`), `session/events` (`:1667`), `session/subscribe` (`:1505`), `session/send` (`:1730`), `session/stop` (`:1885`), `session/setModel` (`:1952`), `session/setThoughtLevel` (`:1962`), `session/setMode` (`:1974`), `session/close` (`:1983`), `session/fork` (`:1806`), `session/compact` (`:1829`), `session/usage` (`:1627`), `runtime/capabilities` (`:76`), `workspace/readPresentation` (`:1996`). All schemas zod-`.strict()` in the same file.
- **v4 conversation channel** — `v4/command` envelope + payload union (`packages/shared/src/zcode-protocol-v4/command.ts:43-244`, envelope `:320-334`, ack `:427-441`), read/subscribe methods (`transport.ts:307-359`).
- **Host service surface** (Desktop renderer / web clients): `IZCodeSessionService` (`packages/services/src/zcode-session/zcodeSession.ts:135-156`), `IZCodeAgentService` (`packages/services/src/zcode-agent/zcodeAgent.ts:566-863`).
- **Client SDK-in-repo**: `@zcode/client` exports exactly `RemoteServiceAccess`, `connectViaProtocol`, `connectViaWebSocket`, `connectViaMessagePort`, `createMessagePortServiceConnection` (`packages/client/src/index.ts:1-5`).
- **Standalone HTTP/WS server**: `@zcode/server` entry `packages/server/src/entry-http.ts:9-30` (port 3030, `ZCODE_SERVER_AUTH_TOKEN`), WS routes `/ws`, `/ws/host`, `/ws/remote/:id` (`packages/server/src/http.ts:317-343`), plus a stdio embeddable entry (`entry-stdio.ts:39-128`, `zcode-hello`/`hello-ack` handshake).
- **CLI entry points**: `zcode app-server --stdio` (`apps/zcode-cli/packages/cli/src/run.ts:525-531`, `arguments.ts:117-121`), `zcode-server-cli serve|status|stop|restart` (`packages/zcode-server-cli/src/cli.ts:89`), `zcode login zai|bigmodel` (`login-command.ts:14-16`).

"Public" here means *source-public*. Nothing is published to npm: all workspace packages are `"private": true` with raw-`.ts` `exports` (`packages/client/package.json:3-8`). The gap is packaging, not secrecy.

## 2. Which surfaces are internal/private

- The Desktop Electron IPC: `PlatformChannels`, `HostMessageTypes` (`packages/shared/src/channels.ts:158-424, 505-646`), MessagePort service forwarding (`packages/client/src/messageport.ts`) — renderer↔host only.
- Trusted-host elevation: `/ws/host` + one-time capability (`POST /api/rpc-host-capability`, `packages/server/src/hostCapability.ts:17-53`, header `ZCODE_RPC_HOST_CAPABILITY_HEADER` at `channels.ts:498`); `IProviderProvisioningTargetService` is stubbed to throw for non-desktop clients (`http.ts:105-116`).
- Role gates for web clients: `/ws` clients are pinned to clientMode `web-remote-replayable`, role `terminal-client` (`http.ts:93-99`); `setConnectionFlowStateV4` is trusted-host-relay-only (`zcodeAgent.ts:732-733`); connection scoping in `zcodeAgentConnectionScope.ts:228, 666-882`.
- Plugin runtime surface (see §9): declarative only.
- CUA broker socket (token-gated, OSS build is a fail-closed placeholder, `packages/zcode-cua/README.md:1-6`).

## 3. How Desktop and CLI instantiate the core agent runtime

Desktop: Electron main forks one **window host** utility process per window (`packages/desktop/src/main/desktopHostProcess.ts:236`, module `packages/desktop/src/host/index.ts`). The host builds all services (`createLocalServices`, `packages/services/src/node.ts:1281, 2425-2431`) and spawns **one agent child process per workspaceKey** via `ZCodeAgentProcessManager` (`packages/services/src/zcode-agent/zcodeAgentProcessManager.ts:832-887, 1019-1034`), `stdio: ["pipe","pipe","pipe"]`.

Agent command resolution (`resolveDefaultZCodeAgentCommand`, `zcodeAgentProcessManager.ts:438-464`), in priority order:

1. `ZCODE_AGENT_SERVER_COMMAND` + `ZCODE_AGENT_SERVER_ARGS_JSON` (default `["app-server","--stdio"]`) env override;
2. monorepo dev bundle `apps/zcode-cli/.../zcode.cjs`;
3. packaged Electron helper running the bundled node bundle;
4. deployed binary fallback (`packages/services/src/runtime-tools/providerRuntimeResolver.ts:23-30`).

**This makes Z2C's old "desktop-agent-proxy via ZCODE_AGENT_SERVER_COMMAND" trick an officially visible, source-verifiable seam** — but it is a shim seam, not a control API (the agent remains single-client; see §10).

CLI standalone: `zcode app-server --stdio` runs the agent in ONE process that owns credentials itself — `apps/zcode-cli/packages/bootstrap/src/app/process-provider-registry-runtime.ts:53-58` (`standalone` + `createSharedZCodeCredentialStore`), reading the same `~/.zcode/v2/credentials.json` as Desktop.

## 4. How sessions are created and controlled

Authoritative handler: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts` (`createSession` `:1212`, dispatcher `server.ts:569-603`).

- `session/create` params (zod strict): `{sessionId? (only for importedHistory), workspace: {workspacePath, workspaceIdentity?, remoteSessionId?, workspaceKey}, parentSessionId?, mode? ("plan"|"build"|"edit"|"yolo"|"auto"), model?: {providerId, modelId, options?: {reasoningLevel?}}, persistence? ("immediate"|"deferred"), thoughtLevel?, titleGenerationEnabled?, mcpServers?, toolAllowlist?, toolDenylist?, importedHistory?}`.
- `workspaceKey` is a **client-chosen association key** (any non-empty string; it is not a Desktop secret — Desktop derives its own).
- Initial model → `app.setModel(...)`; initial `thoughtLevel` → `app.setThoughtLevel(resolveSupportedAppThoughtLevel(...))`. **An unsupported thoughtLevel is silently skipped** (warn log `session_create.thought_level_skipped`, `server-operations.ts:1313-1330`) — clients MUST re-read state and attest (this validates Z2C's readback-attestation design).
- Result: `ZCodeSessionStateSnapshot` = `{protocol, session: {sessionId, workspace, sessionKind, title, mode, status, model?, createdAt, updatedAt}, settings, projection, runtime, messages[]}` (`index.ts:1015-1033`).
- `session/send` params: `{sessionId, content: string, inputId?, queryId?, modelSelection?, expectedRevision?, ...}`; result `{sessionId, accepted: true, stateRevision}` (`index.ts:1730-1777`). (`session/send` is marked deprecated in favor of the v4 command channel, but is still dispatched and is the simplest supported send path.)
- `session/stop` `{sessionId}`; `session/close` `{sessionId}` (close ≠ stop: close tears the runtime down).
- `session/resume` `{sessionId, workspace?, thoughtLevel?, mcpServers?...}` → snapshot.
- `session/read` `{sessionId}` → snapshot; `session/messages` `{sessionId}` → `{messages: ZCodeMessageWithParts[]}`.

## 5. How provider/model/thought-level selection works

- `modelSelectionSchema` = `{providerId, modelId, options?: {reasoningLevel?}}` (`packages/shared/src/model-selection.ts:4-17`); picker display form `providerId/modelId$reasoningLevel` (`:36-44`).
- Provider registry: built-in layer (release-downloaded config materialized under `~/.zcode/v2/runtime/provider/<platform>/<version>`) + personal layer (`~/.zcode/v2/provider_config.json`) + **entitlement-only account overlay** ("Token, API Key, Header 和账号身份必须 NOT 写入 Config" — `packages/provider/src/sources.ts:74-99`).
- Valid thought levels are **per-model, dynamic**: `settings.thoughtLevel.available[].value` from the provider option specs (`packages/provider/src/resolver.ts:76-102`, `packages/model-option-map/src/types.ts:11`). There is no global "max" enum; clients must resolve from `session/read` → `settings.thoughtLevel.available`.
- Runtime switching: `session/setModel {sessionId, model, expectedRevision?}`, `session/setThoughtLevel {sessionId, thoughtLevel, expectedRevision?}`, `session/setMode {sessionId, mode, expectedRevision?}` (`index.ts:1952-1981`); v4 equivalents `switchModelConfig {provider, model, thought}` / `switchCollaborationMode` (`zcode-protocol-v4/command.ts:205-214`).

## 6. How authentication is resolved internally

- Store: `~/.zcode/v2/credentials.json`, AES-256-GCM encrypted (`packages/services/src/credential/credentialService.ts:27-33`, `providers/credentialCipherProvider.ts:20-38`); OAuth token keys `oauth:{zai|bigmodel}:*`, shared `zcodejwttoken` (`oauth/repo/oauthCredentialRepo.ts:13-34, 321-340`); Coding-Plan API-key cache keys `account-provider:{plan}:{providerId}:...` (`model-provider/accountProviderCredentialKey.ts:27-40`).
- Desktop: the **host process** answers the agent's reverse-RPC `interaction/requestProviderRuntimeHeaders` per model request with `{headersApplied: true, requestAuth: {apiKey?, headers?}}`, auto-answered from the account store **without UI** (`packages/services/src/zcode-agent/zcodeAgentService.ts:2235-2282`, resolution `packages/services/src/model-provider/accountProviderRequestAuthService.ts:68-85`: start-plan → `zcodeJwtToken`, individual-coding-plan → cached API key, team → runtime key). Agent schema: `packages/shared/src/zcode-protocol/index.ts:2380-2428`.
- **Standalone CLI/app-server: no host exists — the process resolves credentials itself in-process** via `createStandaloneProviderRuntimeHeadersPort` + shared credential store (`apps/zcode-cli/packages/bootstrap/src/app/process-provider-registry-runtime.ts:31, 55-58`; `standalone-account-provider-runtime.ts`). A Z2C-spawned app-server therefore NEVER emits a runtime-headers request to Z2C and never exposes credential material on the protocol.
- CLI login: `zcode login [zai|bigmodel]` (OAuth browser flow, `apps/zcode-cli/packages/adapters/src/auth/localhost-callback.ts:43+`).

**Consequence for Z2C's security model: provider auth can stay 100% inside native ZCode on the standalone path, by construction.**

## 7. How permissions/user-input requests are surfaced

The agent raises interactions as **reverse requests** to the attached client (this is the host role; a standalone client is in that seat):

- `interaction/requestPermission` — `{requestId, sessionId, toolCallId, toolName, reason, riskLevel, input, options[]}` (`index.ts:2277-2291`); response `{decision: allow|deny|escalate|modify, reason?, modifiedInput?}`.
- `interaction/requestUserInput` — AskUserQuestion questions/options (`index.ts:2354-2377`); response `{action: accept|decline|cancel, content?}`.
- Pending requests are re-announced every 1 s (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/interaction-broker.ts:41, 195, 269, 340-354`).
- v4 path: `resolveInteraction {interactionId, answer}` command (`zcode-protocol-v4/command.ts:173-185`); unknown optionId maps to deny — fail-closed by design (`interaction-broker.ts:147-193`).
- `session/read` exposes `projection.pendingPermissions[]`; session events `permission.requested/resolved`, `userInput.requested/resolved` exist in `zcodeSessionEventTypeSchema` (`index.ts:1100-1126`).
- Unattended Z2C sessions should create sessions with restrictive `mode` (e.g. `plan` for read-only lanes) and/or `toolDenylist`, because the standalone client must answer or (by not answering) time the turn out — the current Z2C fail-closed stub behavior (`reject` unknown client requests) remains correct.

## 8. How event streaming/subscription works

- Notifications over the same NDJSON channel: `session/event` envelopes `{eventId, sessionId, turnId?, seq, timestamp}` with 25 event types — `session.created/resumed/updated/closed`, `turn.started/completed/failed`, `message.upserted/removed`, `part.started/delta/upserted/removed`, `model.streaming`, `tool.updated`, `permission.requested/resolved`, `userInput.requested/resolved`, `checkpoint.created`, ... (`index.ts:1036-1046, 1443-1471`).
- `state.updated {scope: server|workspace|session, revision, patch}` (`index.ts:1481-1491`).
- Pull surfaces for re-sync: `session/subscribe {sessionId, deliveryKind, afterSeq?, includeSnapshot}`, `session/events {sessionId, afterSeq?, limit?}`, `session/messages {sessionId, afterMessageId?, limit?}` — seq-cursor based, replay-safe.
- v4 adds topic frames `v4/conversation/frame` with snapshot/deltas (`transport.ts:382-390`).

**`turn.completed` / `turn.failed` events replace Z2C's old polling hack** (`state.updated` + transcript re-polling with two settled checks) for turn lifecycle.

## 9. Can a plugin directly access session control APIs?

**No.** Plugin manifest (`apps/zcode-cli/packages/contracts/src/plugins/index.ts:141-161`) supports `commands, agents, skills, hooks, mcpServers, lspServers, userConfig, settings, ...` — declarative components only. Hooks (`SessionStart | UserPromptSubmit | PreToolUse | PermissionRequest | PostToolUse | PostToolUseFailure | Stop`, `packages/shared/src/hooks.ts:4-65`) run external commands that receive JSON on stdin and may influence approval/flow — they cannot create/send/stop sessions or set models. A plugin-hosted MCP server is a server ZCode calls into (MCP client side, `apps/zcode-cli/packages/adapters/src/mcp/index.ts`), never a control plane. No credential access either (official MCP auth headers are host-issued, trust-gated, `zcodeAgentService.ts:2296-2325`).

Z2C therefore should NOT use a plugin for control. A plugin remains useful later for UX only (pairing/connected state, slash command to disconnect) — optional, not load-bearing.

## 10. Can an external process use an official client/RPC package?

- **Against Desktop's running agent: NO.** The app-server is single-client stdio, owned by the spawning host (`requestClient` throws `-32020` with no sink, `server.ts:786-800`; no TCP listener). There is no pairing/attach path into a running Desktop (`packages/server` builds its OWN agent processes; it does not attach to Desktop's).
- **By spawning its own agent: YES, fully supported** — `zcode app-server --stdio` is the exact contract Desktop uses, now open source, and standalone mode resolves credentials natively (§6). Verified live on the installed binary (header of this document).
- **Via the standalone `@zcode/server` (HTTP/WS): YES** — `zcode-server-cli serve` exposes the full service collection on `ws://127.0.0.1:3030/ws` (`ZCODE_SERVER_AUTH_TOKEN`). Caveats: all services share one token gate including credential/oauth channels (no per-channel ACL, `http.ts:117`); no token env = unauthenticated (`entry-http.ts:19-21`); web-role clients are restricted (`terminal-client`).
- **Via `@zcode/client` as an npm SDK: not yet possible** — private workspace packages, raw-TS exports, workspace-only deps (`packages/client/package.json`). Vendoring/monorepo-twinning is possible but heavy.

## 11. Which current Z2C hacks can now be deleted

| Legacy mechanism in Z2C | Status under open-source ZCode |
| --- | --- |
| Reverse-engineered NDJSON protocol (`src/providers/zcode/protocol.ts` wire shapes) | Wire format unchanged, now **source-verified** with zod schemas — keep implementation, retarget docs/types to `@zcode/shared` |
| `desktop-host-shim.mjs` / `desktop-agent-proxy*.mjs` (ZCODE_AGENT_SERVER_COMMAND insertion, registration files, token channel) | **OBSOLETE_AFTER_NEW_CONTROL_PATH** — superseded by Z2C spawning `zcode app-server --stdio` itself with native auth |
| Desktop registration-file discovery (`stateDir/desktop-agents/agent-*.json`, PID liveness) | Same — obsolete on the new path |
| `interaction/requestProviderRuntimeHeaders` stub answering (`{headersApplied: true}`) | Obsolete on standalone path (no such request reaches Z2C); keep as fail-closed reject in any future host-role lane |
| `session/requestRuntimePreferences` static defaults | Same |
| Headless `ZcodeProvider` requiring explicit `Z2C_MODEL_API_KEY` | **REMOVE_NOW** candidate — standalone app-server uses native Coding Plan auth; an explicit key lane is no longer needed (and violates the "no key handling" goal) |
| Hardcoded `{providerId: "zai-api", modelId: "GLM-5.3-Flash"}` in `createSession` | Replace with capability-resolved selection from `settings.model.available` + readback attestation |
| Turn-completion polling (`state.updated` + 2× settled transcript re-poll) | Replace with `turn.completed` / `turn.failed` `session/event` (keep polling only as fallback) |
| Model-binding attestation via `session/read` | Keep — this is the official authoritative surface (schemas now source-known) |

## 12. Minimal upstream change if no stable external-control surface exists

A stable surface *does* exist for the spawned-agent model (§10). What is missing is packaging + a stability contract, not a protocol. Recommended (small, generic, upstreamable):

1. Publish `@zcode/rpc`, `@zcode/shared` (protocol schemas), and a slim `@zcode/app-server-client` (spawn + NDJSON + typed session ops) with build outputs and semver.
2. Document `zcode app-server --stdio` as a supported embedder contract (handshake, method table, deprecation policy for `session/*` vs v4).
3. Optional sugar: `zcode external-control --stdio` facade that pins the supported method subset and echoes `protocol: {name, version}` at startup.

Nothing in Z2C's path requires an XUEnter-specific fork; see `docs/zcode-upstream-external-control-proposal.md`.

---

## Architecture decision

**Option B — build Z2C against the official `zcode app-server --stdio` contract** (spawned per authorized workspace by the Z2C bridge), with request/response types aligned to `@zcode/shared` source schemas.

Why not the others:

- **A (existing external API)**: no published SDK exists; the only official networked surface (`@zcode/server`) drags a 40-service collection behind a single token and cannot attach to the user's running Desktop.
- **C (plugin + bridge)**: plugins cannot control sessions (§9) — structurally impossible for the control direction.
- **D (upstream patch)**: not required for function; reduced to a packaging/documentation proposal.

The desktop-proxy lane is demoted to LEGACY_FALLBACK (see `docs/z2c-legacy-migration-plan.md`).

Security model validation against the task's mandatory list: on the standalone path Z2C never receives credentials (in-process resolution, §6), never answers runtime-header requests, can verify the exact session's model binding via authoritative `session/read` (§4-5), and fail-closed behavior is preserved (unsupported thoughtLevel silently skipped → readback attestation catches it; unknown client requests rejected).
