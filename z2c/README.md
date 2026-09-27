# ZCode with ChatGPT (Z2C)

Z2C is the local, loopback-only companion for the governed ZCode lane in
[Agents with ChatGPT](https://github.com/G0K0U/agents-with-chatgpt). The default
service starts the installed ZCode official `app-server --stdio` protocol. It
does not replace ZCode Desktop's bundled agent, read ZCode credentials, or
silently fall back to the legacy Desktop proxy.

## Build and check

Node.js 20 or newer and an installed, signed-in ZCode are prerequisites.
From this directory:

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

`npm run service` runs the semantic service in the foreground. Its HTTP/MCP
surface binds to loopback (default `127.0.0.1:8766`) and requires the local
service secret for control. A2C normally starts the built
`dist/service/main.js` through its supervisor after the workspace queue has
been checked and maintenance pause is in place. See
`docs/z2c-local-service.md` for lifecycle and `docs/zcode-open-source-integration-audit.md`
for the observed native protocol.

The official CLI is discovered from the installed ZCode layout. If it is in a
nonstandard location, set `Z2C_ZCODE_CLI` to its executable or `.cjs` path.
For ZCode 0.16.9, the packaged built-in provider configuration is discovered
beside the CLI; an explicit `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` takes
precedence. `Z2C_STATE_DIR` selects the private local state directory and
`Z2C_PORT` selects the loopback port. Never place state files or tokens in a
repository.

Governed task admission requires an observed session binding of
`builtin:zai-coding-plan / GLM-5.3-Flash / max`. Missing or different native
capabilities fail closed. Workspace grants, caller ownership, and queue pause
are separate checks; a healthy port alone does not authorize execution. The
service offers read-only session observation and a local-only governed task
adapter for A2C. The deprecated task bridge in `dist/index.js` is not the
semantic service entry.

The source is MIT licensed; see `LICENSE`. This companion is also distributed
as the `z2c/` subtree of the A2C repository for one-command local builds.
