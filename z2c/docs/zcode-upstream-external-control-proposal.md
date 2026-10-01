# Upstream ZCode Proposal: A Supported External-Control Surface

Date: 2026-09-21
Proposed for: zai-org/ZCode (open source, monorepo v3.14.0 / app-server 0.16.9)
Author context: Z2C — a third-party bridge that lets ChatGPT control local ZCode sessions over MCP.

## Problem statement

ZCode can today be controlled externally only through surfaces that are *source-visible but not contractually supported*:

- `zcode app-server --stdio` is the embedder contract ZCode Desktop itself uses, and third parties (Z2C) can spawn it — but nothing documents it as stable, and its method table (`session/*` legacy namespace vs the `v4/*` command/frame namespace) has no external deprecation policy.
- `@zcode/client` (`connectViaWebSocket` + typed service accessors) is a complete, transport-agnostic SDK — but it is a `private` workspace package with raw-`.ts` exports, unusable outside the monorepo.
- Builders therefore fall back to reading the source and freezing wire shapes by hand — exactly the fragility (silent schema drift, undocumented CAS requirements, ignored params like `session/create mode:"plan"` on some paths) that a supported contract would eliminate.

Everything needed already exists in the codebase. What is missing is packaging, documentation, and a narrow stability promise.

## Generic use cases (beyond ChatGPT)

- IDE/editor plugins driving ZCode sessions (VS Code/JetBrains extensions).
- CI/CD runners executing governed code tasks headlessly with audited model identity.
- Personal automation (cron/shortcuts) creating and resuming sessions.
- Team tools: session dashboards, usage metering, bulk read-only session inspection.
- Accessibility/remote wrappers (phone/web clients beyond the built-in web UI).
- Any second process on the user's machine that today has no legitimate way to cooperate with ZCode without scraping protocol traffic.

## Minimal public API (proposal)

1. **Publish the protocol schemas**: `@zcode/shared` (or a new `@zcode/protocol`) exposing the zod schemas for the "ZCode Protocol" (NDJSON request/response/notification envelopes) and the `session/*` + `runtime/capabilities` method table. These are already `.strict()` zod schemas — the ideal single source of truth for a versioned contract.
2. **Publish a slim client**: `@zcode/app-server-client` (new package, no `@zcode/services` dependency graph):
   - `spawnAndConnect({cliPath, cwd, env, args?: ["--stdio"]})` → `ZcodeAppServerConnection`
   - typed `request(method, params)` with id correlation and timeout
   - notification subscription (`session/event`, `state.updated`)
   - reverse-request policy hook (allow-list; default reject, fail-closed)
   - helper facades: `createSession`, `resume`, `read`, `send`, `stop`, `close`, `setModel`, `setThoughtLevel`, `setMode`, `capabilities`
   - collaboration-state helpers: `subscribeSessionState` (v4 conversation topic), `readCollaborationState` (revision/logEpoch/planEnabled), `setCollaborationMode` (CAS `switchCollaborationMode` with bounded stale-retry) — the exact surface Z2C proved against the live runtime
3. **Document the embedder contract** (`docs/external-control.md` in the ZCode repo): NDJSON framing, handshake, lifecycle, the standalone auth model (child resolves credentials from the shared store; client never handles them), and which namespaces are stable vs internal.
4. **Version signal**: include `protocol: {name, version}` in a `runtime/capabilities` response (or a `zcode-hello` line on stdout like the existing `entry-stdio` handshake) so clients can negotiate and fail fast on drift.
5. **Typed collaboration-mode helpers with CAS** (Phase-2 lesson from building Z2C's readonly lane): the `switchCollaborationMode` path requires `v4/conversation/subscribe` → snapshot (`revision`, `logEpoch`) → `v4/command` CAS envelope, and the plan state lives in the v4 projection (`config.planEnabled`) — not in the legacy `session/read`. A published helper should expose `subscribeSessionState` / `setCollaborationMode(sessionId, mode)` and document that (a) the plan flag is v4-only, and (b) collaboration state is runtime-local — cold resume resets it, so embedders must re-establish it. Two live-observed 0.16.9 behaviors worth codifying upstream: `session/create mode:"plan"` and `session/setMode plan` are silently ineffective on the standalone path, and the plan flag does not survive cold resume. Either document both, or make them consistent (honor plan at create; persist the flag) — silent no-ops are the worst outcome for external integrations that need readonly guarantees.
6. **Semantics worth a second look for embedders**: draft-only sessions (no persisted turn) are not resumable after close (`session/resume` → "Session not found") — worth documenting; and `v4/conversation/subscribe` delivers its initial snapshot as a post-response frame on the same stream — the framing order matters to clients.

Equivalent sugar CLI (optional, lowest priority): `zcode external-control --stdio` — a thin alias over `app-server --stdio` that pins the supported method subset.

## Proposed source locations

| Piece | Location |
| --- | --- |
| Schemas (already exist) | `packages/shared/src/zcode-protocol/index.ts`, `packages/shared/src/zcode-protocol-v4/*` |
| Client package (new, reusing existing code) | `packages/app-server-client/` composed from `packages/rpc`-free pieces: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/transport.ts` framing + a spawn wrapper like `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts` command resolution |
| Docs | `docs/` or `packages/client/README.md` |
| Packaging | workspace `package.json`s: remove `"private": true` for the published pair, add build outputs + `publishConfig` |

No changes to the agent dispatch, storage, or permission semantics are required.

## Security boundaries (preserved by design)

- **Credentials never leave ZCode.** The standalone agent resolves provider auth in-process from the shared credential store (`~/.zcode/v2`); a control client never sees key material and is never asked for runtime headers. The proposal changes nothing here — it makes the existing boundary contractual.
- **Single-client stdio remains the boundary.** A control client owns the child it spawns; there is no inbound attach to a running Desktop and none is proposed.
- **Client-side reverse-request policy**: interactions (`interaction/requestPermission`, `interaction/requestUserInput`) flow to the client that must remain able to reject unknown requests fail-closed (the schema/policy hook above codifies this).
- **No new network surface.** Publishing packages does not expose ports; remote access remains the existing explicit `@zcode/server` token model.

## Backwards compatibility

- The `session/*` legacy namespace keeps working (Desktop still consumes it); the contract marks it "supported for embedders" while the `v4/*` namespace evolves additively (its zod schemas are already frozen-by-golden-tests, additive-only per in-repo discipline comments).
- Existing in-repo consumers are untouched: the client package is new, the shared-package publication only adds build outputs.
- Desktop's own agent spawning continues to use the same code path — the published client is extracted from it, not parallel to it.

## Tests

- Golden round-trip: spawn the published client against the real CLI (`zcode app-server --stdio`), drive `capabilities → create → setModel/setThoughtLevel → read → send → turn.completed → stop → close → resume` in CI (the Z2C canary at `z2c/src/canary/official.ts` in this repository is a working reference implementation of exactly this flow).
- Schema freeze tests already exist for `zcode-protocol-v4`; extend the same golden pattern to the published envelope schemas.
- Fail-closed tests: unknown method (-32601), invalid params (-32602), unsupported thoughtLevel silently-skipped detection via readback, reverse-request reject policy.

## Why this belongs upstream rather than in Z2C

1. **ZCode already ships the seam.** `app-server --stdio` is not a hack — it is how Desktop launches agents. The only alternatives for outsiders are source-freezing (fragile) or per-project forks of the spawn+framing code (wasteful, drift-prone).
2. **One contract beats N mimics.** Every third party that reverse-freezes the wire shape risks breaking silently on ZCode updates; a versioned published schema converts that from runtime breakage into a negotiate-and-fail-fast check.
3. **Security posture improves.** A documented client policy (reject unknown reverse requests, never handle credentials) is safer than undocumented clients discovering the interaction protocol by trial.
4. **Zero product risk.** No new attack surface, no behavior change for Desktop/web users; it is packaging + docs of code that already ships.
