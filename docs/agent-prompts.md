# Agent prompts — install, smoke-test, and multi-agent use

These prompts let a coding agent deploy and verify C2C using only this
repository's public docs and scripts. Steps the agent can complete on its own
are marked; steps that need the human (browser logins, pairing codes) are
called out one at a time.

## 1. Deploy prompt (paste to your coding agent)

```text
Install "Agents with ChatGPT" (C2C) on this Windows 11 machine, following the
public repo docs only. Run the installer script install/install.ps1 with
-Workspace pointing at my current project directory, installing dependencies
via winget if missing, and build with pnpm. Then verify with the c2c command
shim it creates (doctor + status --json, same --workspace/--state-dir), fix
any issue you find yourself, and only interrupt me for the two actions that
require a human: the ChatGPT browser login and the one-time pairing code.
Finish by printing the MCP URL, the connector setup steps, and the final
status output.
```

Equivalent minimal version:

```text
Install https://github.com/G0K0U/agents-with-chatgpt per its README
(install/install.ps1), target workspace = current directory, then run doctor,
set up the ChatGPT connector, and show me the final status. Only ask me for
browser logins and the pairing code — one action at a time.
```

## 2. Read-only smoke-test prompt (paste after install)

The installer creates a `c2c.cmd` shim inside the install directory
(`%LOCALAPPDATA%\Programs\codex-with-chatgpt\c2c.cmd` by default). Use that
path, or `node <install-dir>\dist\cli\index.js` directly. Verification must
pass the same `-Workspace` / `-StateDir` values used during install.

```text
Verify my Agents with ChatGPT deployment WITHOUT changing anything: using the
c2c command shim in the install directory with the same --workspace and
--state-dir values from the install, run `status --json` and `doctor`; report
bridge state, port, workspace id, and tunnel URL; confirm the public MCP
endpoint answers 401 without a token and succeeds with the paired connector;
do not modify any file, credential, or tunnel setting. Output a short
PASS/FAIL table with evidence.
```

Useful lifecycle commands (all take `--workspace` / `--state-dir`):

```powershell
& "$env:LOCALAPPDATA\Programs\codex-with-chatgpt\c2c.cmd" status  --json --workspace "C:\my project" --state-dir "$env:LOCALAPPDATA\codex-with-chatgpt"
& "$env:LOCALAPPDATA\Programs\codex-with-chatgpt\c2c.cmd" doctor  --workspace "C:\my project" --state-dir "$env:LOCALAPPDATA\codex-with-chatgpt"
& "$env:LOCALAPPDATA\Programs\codex-with-chatgpt\c2c.cmd" stop    --workspace "C:\my project" --state-dir "$env:LOCALAPPDATA\codex-with-chatgpt"
& "$env:LOCALAPPDATA\Programs\codex-with-chatgpt\c2c.cmd" pair    --workspace "C:\my project" --state-dir "$env:LOCALAPPDATA\codex-with-chatgpt"   # fresh pairing code
```

## 3. Minimal multi-agent example (two sessions, one planner + one executor)

With the bridge running for a workspace:

1. In ChatGPT (the planner, connected via the MCP connector), ask:
   *"List the TODO markers in this workspace and propose a one-file fix."*
   ChatGPT reads the workspace through the read/review MCP tools.
2. Approve the task it submits. The executor agent (Codex App Server, or
   another configured provider) performs the scoped write while the bridge
   enforces the workspace writer lock — a second write task queues until the
   first finishes or is cancelled.
3. In a second ChatGPT chat connected to the same connector, ask:
   *"Review the latest task's diff and test results."* The reviewer reads the
   recorded execution evidence; it never needs the writer's own claims.
4. Cancel test: submit a long task, cancel it from either session, and verify
   the status is `cancelled` (not silently `completed`) via `execution_queue`.

Expected observable result: two independent sessions cooperate through the
bridge without sharing credentials; the writer lock serializes writes; the
audit record shows requested vs effective network state and terminal receipts
for every task.

## 4. What the agent cannot do for you

- ChatGPT login / CAPTCHA / 2FA in the connector browser flow.
- Entering the one-time pairing code (it is displayed to you, with a 5-minute TTL).
- Cloudflare account authorization if you opt into a stable hostname.

## 5. Public infrastructure boundary

This repository includes source code and generic tunnel integration only. It does not provide any maintainer website, domain, tunnel, Cloudflare account, tunnel ID, certificates, OAuth state, runtime state, endpoints, or credentials. Each user configures their own tunnel/hostname or runs locally with `--no-tunnel`.
