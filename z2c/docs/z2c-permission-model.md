# Z2C Permission Model

Governed task dispatch now supplies an internal, turn-scoped execution grant
from the admitted workspace and write scope, after the existing workspace,
model, effort, and readonly-plan attestation gates. No public request field
can set this grant. Semantic session sends without a task grant remain denied.

`interaction/requestPermission` receives an allow-once decision only for an
active grant and a recognized native `allow_once` option. Read permits confined
`Read`; write additionally permits `Write`, `Edit`, and bounded `Bash` commands:
`node --version`, `pnpm --version`, `pnpm test/build/typecheck`, `git status/diff`,
and workspace-local JavaScript files run by node. Existing ancestors are
realpath-checked, including new files below symlinks. Credential/config paths,
unknown tools/options, critical requests, inline code, shell composition,
sandbox overrides, and background execution are denied. Requests and responses
never copy tool input or provider-supplied reasons into permission audit records.
Only the decision and policy name are audited.

This is a development-command approval policy, not an OS sandbox: admitted
workspace scripts and package scripts execute with the service account's existing
local permissions. It does not claim to confine arbitrary program behavior.
General shell commands remain denied rather than being guessed safe.

Grants are removed at completion, failure, timeout, stop/close, and process exit.
`interaction/requestUserInput` and all other unknown reverse requests remain
fail-closed; unattended question auto-resolution remains disabled. Provider auth,
workspace admission, idempotency, model/effort attestation, and writer scheduling
are unchanged. No persistent/global native allow rules are installed.
