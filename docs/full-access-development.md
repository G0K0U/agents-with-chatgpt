# Full-access development deployments

The CLI defaults to restricted execution. To explicitly authorize full local filesystem and process access for development, set `C2C_FULL_ACCESS_DEVELOPMENT=true` in the bridge process environment before starting it. Only the exact value `true` enables this mode. For example, in PowerShell:

```powershell
$env:C2C_FULL_ACCESS_DEVELOPMENT = "true"
c2c start -w "C:\path\to\your\project"
```

Restart an already running bridge for environment changes to take effect. Configure the same environment in any service or scheduled task that launches it. Remove the variable and restart to restore restricted execution. Queued full-access tasks cannot resume under a restricted deployment. Embedders may explicitly select the equivalent `startBridge({ fullAccess: true, ... })` option; omission remains restricted.

In this mode authenticated, authorized Codex and Gemini submissions may name existing absolute directories outside the registered workspace in `write_scope`. Scopes describe task intent, not a sandbox boundary: the executor has the bridge account's filesystem and process privileges. Gemini no longer rejects external or subdirectory scopes or treats workspace containment as an execution restriction in this mode. The registered workspace remains the working directory and session anchor.

Task text and task parameters cannot enable the deployment flag. Enable it only when the user authorizes full-access development and trusts principals holding execution scopes. OAuth, execution authorization, workspace registration, task/session ownership, provider identity checks, and audit recording remain in place. There is no unauthenticated shell endpoint. Task network access defaults to online in this deployment when the `network` field is omitted, an explicit `network: false` always keeps the task offline, and requested/effective network decisions remain recorded.

Changed-file snapshots remain workspace-based; they are not a complete inventory of writes across the host filesystem. Full-access mode does not expand read-only connector file browsing. Restricted deployments retain workspace scope validation and Gemini's workspace-level preflight restrictions.
