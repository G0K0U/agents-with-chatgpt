# ZCode upstream patch — standalone entitlement + machine filesystem scope

Reproducible source patch for the ZCode CLI runtime used by the Z2C/GLM lane.
Upstream project: [`zai-org/ZCode`](https://github.com/zai-org/ZCode),
licensed **Apache-2.0** (see upstream `LICENSE`). This patch is distributed
under the same license.

## Provenance

| Item | Value |
| --- | --- |
| Upstream repo | https://github.com/zai-org/ZCode |
| Base commit | `29628c9` — tag `v3.14.3` ("feat: update v3.14.3"; parent `872ad96` "feat: open source") |
| Patch | `0001-standalone-account-entitlement-and-machine-filesystem-scope.patch` (32 files, +1359/−51) |
| Verified | `git apply --check` + `git apply` on a fresh `v3.14.3` clone; all patched files byte-identical to the build tree this round's runtime was compiled from (modulo CRLF) |

The patch is **not** an upstream commit; it is maintained in this repository.
It contains no user paths, credentials, or machine state (scanned).

## What it does

The upstream worktree carried two entangled local features that share protocol
schema files, so they ship as one patch:

1. **Session-level entitlement selection + standalone account runtime** —
   `session/create` / `session/resume` accept an explicit
   `entitlement` (`start-plan` | `individual-coding-plan`); the runtime
   constrains model selection to the matching account access category,
   re-attests via Registry readback (fail closed), and exposes readback via
   `session/read settings.entitlement`. The `app-server` process can opt in to
   standalone account resolution via `ZCODE_PROTOCOL_STANDALONE_ACCOUNT_RUNTIME`
   (Shared Credential Store, same implementation as the interactive TUI
   entry); Start Plan requests authenticate with the login OAuth JWT. New
   module: `bootstrap/src/zcode-protocol/session-entitlement.ts`.
2. **Machine-local filesystem scope** — sessions may declare
   `filesystemScope: workspace | machine`; machine scope gates the tool
   handlers to the local machine with independent file-discovery tools. New
   module: `core/src/tool/filesystem-scope.ts`.

Both include upstream-tree tests (`bootstrap/test/`, `core/test/`) and a spec
(`apps/zcode-cli/spec/machine-local-filesystem.md`).

**Excluded on purpose** (local dev-only, not needed to build the CLI
runtime): `packages/desktop` shell-registration guards, `packages/services`
host process-manager tweak, local launcher scripts, log files.

## Build from source

```bash
git clone https://github.com/zai-org/ZCode.git
cd ZCode
git checkout v3.14.3
git apply /path/to/0001-standalone-account-entitlement-and-machine-filesystem-scope.patch
corepack enable          # pnpm 10.33.2 is pinned via packageManager
pnpm install
pnpm --dir apps/zcode-cli/packages/cli run build
# → apps/zcode-cli/packages/cli/dist/zcode.cjs
```

Point `Z2C_ZCODE_CLI` at the built `zcode.cjs` (or install it on the standard
resolution path) and run it as `zcode.cjs app-server --stdio`.

## Runtime identity and compatibility boundary

- This round's verified build:
  `sha256(zcode.cjs) = 973143c97e3df9f9f777995018ca7a8e9852b74cb398bb99b8bf1b9093f05327`
  (contains the entitlement/standalone markers; functional behavior, not byte
  identity, is the compatibility contract — bundler output may differ across
  rebuild environments).
- **Build-from-patch: verified 2026-10-01** on a clean clone
  (`v3.14.3` = `29628c9`, Apache-2.0): `git apply` clean →
  `pnpm install --frozen-lockfile` (pinned pnpm 10.33.2) →
  `turbo run build` 16/16 → `zcode.cjs` built;
  `sha256 = 52224ce753555ee3130a393fcfa89779c5bdcb1bf53dc532507eeab2f5196cb4`,
  entitlement/standalone + machine-scope markers present, `--version` →
  `0.16.9`. Note: `turbo run build` (not a bare per-package `tsc --noEmit`)
  is the working build-order entry on a fresh clone. (Detailed build evidence
  lives in the maintainer's local acceptance journal, not in this repository.)
- **Pending acceptance (open item — do not present as done)**: functional
  acceptance has **not** been executed against the candidate build —
  `runtimeCapabilities` (`entitlementSelection`, `machineLocalFilesystem`)
  live verification and the Z2C suite are still outstanding; the feature
  canary comes from the deployed local build (`973143c9…`), not from the
  clean-build candidate. A hash that differs from either recorded hash —
  from any earlier or later build — is by itself **not** evidence that a
  build is wrong, stale, or that the patch failed; only the functional
  contract above decides.
- The agent self-reports `0.16.9` (`apps/zcode-cli` package version) while the
  OSS monorepo tag is `v3.14.3`. **Do not infer capability from the reported
  version**: a stock or self-built agent claiming `>= 0.16.9` is *not*
  guaranteed to expose entitlement selection or machine scope. Check
  `runtimeCapabilities` (`entitlementSelection`, `machineLocalFilesystem`)
  instead — stock upstream returns neither flag.

## Capability boundary

- **Stock ZCode**: DEFAULT-plan sessions only. Requests naming `START` or
  `INDIVIDUAL` fail closed (`plan-unavailable`) on a stock runtime.
- **Patched build (this patch)**: adds the explicit entitlement path above.
  DEFAULT (no entitlement declared) behavior is unchanged.
