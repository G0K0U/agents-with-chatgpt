# Z2C Legacy Migration Plan

Date: 2026-09-21
Context: ZCode is open source; the audit (`docs/zcode-open-source-integration-audit.md`) shows the installed agent (0.16.9) is the same code as the public repo, and the official `zcode app-server --stdio` standalone path resolves provider auth natively. The reverse-engineering-era machinery below is reclassified accordingly.

Classification legend:

- **LEGACY_REQUIRED** — still load-bearing; do not touch.
- **LEGACY_FALLBACK** — keep working, demoted from default; deletion gate defined.
- **OBSOLETE_AFTER_NEW_CONTROL_PATH** — inert once the official path ships and soaks; delete at the gate.
- **REMOVE_NOW** — no remaining legitimate use; delete in this cycle.

## Inventory and disposition

| Item | Files / symbols | Class | Deletion gate |
| --- | --- | --- | --- |
| Reverse-engineered protocol client | `src/providers/zcode/protocol.ts` | **LEGACY_REQUIRED** (retargeted: wire format is now the official, source-verified protocol; docs/types aligned to `@zcode/shared` schemas) | n/a — becomes the official client |
| Child-process owner | `src/providers/zcode/process.ts` | **LEGACY_REQUIRED** (reused by the official provider; spawn args now include `--stdio`, env is credential-free) | n/a |
| Desktop agent proxy | `scripts/desktop-agent-proxy.mjs`, `scripts/desktop-agent-proxy.stderr-canary.mjs` | **LEGACY_FALLBACK** | Delete when (a) official provider is default for ≥1 release AND (b) no deployment launches Desktop with `ZCODE_AGENT_SERVER_COMMAND` pointing at Z2C. The `ZCODE_AGENT_SERVER_COMMAND` seam itself is official (audit §3) but multiplexing a second control client through it is replaced by Z2C spawning its own agent. |
| Desktop host shim | `scripts/desktop-host-shim.mjs`, `scripts/desktop-host-shim.coding-plan-canary.mjs` | **OBSOLETE_AFTER_NEW_CONTROL_PATH** (already marked UNSUPPORTED FOR GOVERNED EXECUTION 2026-09-16 in-file) | Delete with the proxy; its only jobs (answer reverse requests, push provider registry) do not exist on the standalone path. |
| `workspace/updateProviderRegistry` push | `src/providers/zcode/client.ts` `ensureWorkspaceReady()` | **REMOVE_NOW** on the official path (official provider never calls it; tests assert absence). The legacy headless `ZcodeProvider` keeps it until that class is deleted. | Legacy headless class deletion (below). |
| Credential-store reading (`readZcodeRuntimeToken`, `Z2C_CREDENTIAL_KEY`) | `src/config.ts:95-106`, used by `client.ts` | **REMOVE_NOW** from all NEW code. **SECURITY**: reading `~/.zcode/v2/credentials.json` and injecting it as `ZCODE_RUNTIME_API_KEY` violates the Z2C security model; the official standalone agent resolves the same credential in-process without Z2C ever holding it. | Legacy headless class deletion (below); remove `readZcodeRuntimeToken` from `config.ts` in the same gate. |
| `Z2C_MODEL_API_KEY` env lane + custom provider `custom:z2c` | `config.ts` `modelApiKey`, `client.ts` provider push | **REMOVE_NOW** for the official path; the legacy headless class retains it until deletion so existing deployments don't break mid-cycle. | One release after official default. |
| Desktop provider (attach to Desktop-spawned agent) | `src/providers/zcode/desktop.ts`, registration discovery in `src/index.ts` (`cleanupStaleDesktopAgentRegistrations`) | **LEGACY_FALLBACK** | Delete when official path is default for ≥1 release and no user requires sessions to live inside the running Desktop app. Note: sessions created by the official provider persist in the same on-disk store and remain visible/resumable natively, which removes the main reason for this lane. |
| Hardcoded provider/model constants | `types.ts` `REQUIRED_START_PLAN_PROVIDER_ID`, `createSession` hardcoded `zai-api/GLM-5.3-Flash` in `desktop.ts:333-336` | **REMOVE_NOW** on the official path: model ids stay policy constants (Flash-only governed lane) but provider identity is OBSERVED from `session/read`, never hardcoded or equality-gated (audit §5; engine updated accordingly). | Done in this cycle for the official path; desktop provider keeps its behavior until its deletion gate. |
| Idle-poll turn detection (`state.updated` + double-settled transcript poll) | `desktop.ts` `resolveTurnWhenSettled` | **LEGACY_FALLBACK** inside the official provider (bounded fallback only; primary signal is `session/event` `turn.completed`/`turn.failed`). | Re-evaluate after soaking; candidate for removal once event delivery is proven across restarts/resumes. |
| Reverse-request stubs (`session/requestRuntimePreferences` defaults, `interaction/requestProviderRuntimeHeaders` `{headersApplied:true}`) | `protocol.ts:104-126` | **LEGACY_REQUIRED** as fail-closed reject; the two explicit answers remain only because a client MUST answer or the agent times the request out. On the standalone path neither request arrives (auth is in-process); if one ever arrives it signals a topology mistake and is logged. | n/a |
| `session/updateRuntimeModelConfig` compatibility | (no longer referenced in src) | **REMOVE_NOW** — the official equivalents are `session/setModel` + `session/setThoughtLevel` (audit §4-5). | Done; only doc references remain. |
| Desktop registration cleanup | `src/index.ts:95-115` | **LEGACY_FALLBACK** (runs only while the desktop lane exists). | With desktop provider deletion. |
| `probe/*.mjs`, `.diag-*.mjs` reverse-engineering probes | repo root / `probe/` | **REMOVE_NOW** candidates (historical value only). Not deleted in this cycle to preserve user work untouched; flagged for the next cleanup pass. | Next cleanup pass, explicit user sign-off. |

## Execution order

**Phase 2 update (2026-09-21): steps 1-2 are DONE.** The official provider is the default (`Z2C_PROVIDER` defaults to `official`; legacy lanes are explicit opt-in only — `desktop`/`desktop-legacy`/`headless` — and a failed official initialization never silently downgrades). `readZcodeRuntimeToken`, `zcodeCredentialStorePath`, `zcodeCredentialKey` and `runtimeApiKeyEnv` are DELETED from `src/config.ts`; the legacy headless lane now requires an explicitly user-owned `Z2C_MODEL_API_KEY` (a standalone key lane, intentionally separate from ZCode native auth — classification C). Security regressions live in `test/security.test.ts`. Readonly governance moved to the authoritative v4 CAS path (see `docs/z2c-target-architecture.md`), removing the last functional reason the desktop lane existed.

1. ~~**This cycle:** official provider ships; engine stops equality-gating provider identity~~ — done Phase 1.
2. ~~**Next cycle:** default `Z2C_PROVIDER=official`; legacy headless class + `readZcodeRuntimeToken` + `Z2C_MODEL_API_KEY` config deleted~~ — done Phase 2 (headless class retained but key-gated; `readZcodeRuntimeToken` deleted; full class deletion pending Gate A soak).
3. **Gate A (official default soaked ≥1 release + canaries green + no configured fallback depends on it):** delete `desktop-host-shim*.mjs` and the legacy headless `ZcodeProvider` (`client.ts`) outright.
4. **Gate B (after confirming no `ZCODE_AGENT_SERVER_COMMAND` deployments):** delete `desktop-agent-proxy*.mjs`, `DesktopZCodeProvider` (`desktop.ts`), registration discovery/cleanup in `index.ts`, and the `REQUIRED_START_PLAN_PROVIDER_ID` constant.
5. **Gate C:** delete reverse-engineering probes (`probe/`, `.diag-*`) after archival.

Each deletion is gated on: all tests green on the official path, both live canaries (`npm run canary:official`) passing against the installed agent, and a grep proving zero imports/references from shipped code.
