# Agents with ChatGPT

> ChatGPT thinks. Agents work — Codex, Gemini, and GLM.
> ChatGPT 负责思考，Agent 负责干活——Codex、Gemini、GLM。

> [!IMPORTANT]
> **遇到问题？** 请先向 Codex 发送 **「更新 Codex with ChatGPT」** 并重试。更新到最新版本可以解决大多数已知问题。  
> **Having trouble?** First ask Codex to **“Update Codex with ChatGPT”** and try again. Updating to the latest version resolves most known issues.

## What it is · 这是什么

**中文** — 把 ChatGPT 网页版变成编码会话的"规划与审查大脑"。你的仓库永远不会
被上传：ChatGPT 通过 OAuth MCP 连接按需读取代码，并通过本地执行通道提交任务。
本项目提供三条相互独立的执行通道：

1. **Codex** — 官方 Codex App Server（本地执行器）。
2. **Gemini** — Antigravity/AGY CLI + Google OAuth（按需就绪，无会话也是健康态）。
3. **GLM（治理通道）** — Z2C 伴随组件 → ZCode Desktop → **GLM-5.3-Flash（仅 Flash）**，
   会话级模型/推理强度原生证明，严格工作区绑定。

**EN** — Use the ChatGPT web app as the planning and review brain for your coding
sessions. Your repository is never uploaded: ChatGPT reads exactly the lines it
needs through an OAuth-protected MCP connection and submits work through local,
attested execution channels. Three independent provider lanes:

1. **Codex** — the official Codex App Server (local executor).
2. **Gemini** — the Antigravity/AGY CLI with Google OAuth (READY_ON_DEMAND; zero
   active sessions is a healthy state).
3. **GLM (governed lane)** — the Z2C semantic service → official ZCode app-server → **GLM-5.3-Flash
   only**, with native same-session model/identity attestation and exact
   workspace binding.

Detailed docs below are in English · 详细中文文档见 **[README.zh-CN.md](README.zh-CN.md)**

## Architecture · 架构

**A2C (Agents-to-ChatGPT) is the shared platform.** The provider lanes are
siblings under it — C2C is not the parent architecture:

```text
                   ChatGPT
                      │
                      ▼
                   A2C Core
      OAuth / Pairing · MCP Gateway · Workspace/Auth
        Provider Registry · Session Registry · Supervisor · Tunnel
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
       C2C           Z2C           G2C
  Codex-to-ChatGPT  ZCode-to-ChatGPT  Gemini-to-ChatGPT
      Codex         ZCode Desktop / GLM   AGY / Gemini
```

Naming rules:

- **A2C** — the shared platform/core (bridge, MCP gateway, OAuth/pairing,
  workspace authorization, supervisor, tunnel, release/LKG, doctor).
- **C2C** — Codex-to-ChatGPT: only the Codex provider lane (Codex App Server,
  Codex task/session lifecycle).
- **Z2C** — ZCode-to-ChatGPT: the ZCode Desktop / GLM lane (semantic
  `zcode_*` session tools, v4 plan governance).
- **G2C** — Gemini-to-ChatGPT: the Antigravity/AGY lane.

Model selection is dynamic: `agent_model_catalog` exposes the live,
account-scoped model directory for Codex, Antigravity/Gemini, and ZCode, and
`agent_model_resolve` turns requests like "use Codex GPT-6 Astra Max" into an
exact, catalog-confirmed selection before any task is submitted. Selections
are never silently substituted — an unsupported model or effort fails with an
explicit error (see `docs/release-and-operations.md`).

Legacy compatibility identifiers (kept on purpose; see
`docs/phase4-a2c-integration-acceptance.md`): the `c2c` CLI binary alias, the
`C2C_STATE_DIR` variable + `codex-with-chatgpt` state directory, `c2c_*` /
`c2cs_*` persisted id and token prefixes, `c2c-*` tunnel names / existing
`c2c.*` hostnames, and `.c2cignore` / `.c2c.json` project files. Readers
accept both `A2C_*` (canonical) and `C2C_*` (legacy) environment variables.

## Provider lanes · 三条执行通道

### Codex — native App Server

- Uses the official **Codex App Server** locally. No shims, no reverse proxies.
- Account model discovery and task execution use the same configured Codex
  runtime. A listed model still needs a completed live turn before support for
  that model is claimed; see the [support matrix](docs/support-matrix.md).
- Prerequisite: a Codex/OpenAI login on the machine (CLI or desktop app).

### Optional usage telemetry — Quanta

`agent_usage_status` reads local Quanta quota samples when available. A2C
checks each provider's own sample time within 60 seconds; missing, old or
failed samples stay unknown, including on an older Quanta installation.
Manual agent execution does not require Quanta. The patched, MIT-licensed
[Quanta 0.9.4+a2c.1 source and build instructions](third_party/quanta/PATCH-INFO.md)
are included here. An upstream v0.9.4 executable does not contain this patch.

### Gemini — Antigravity/AGY CLI + Google OAuth

- Uses the **Antigravity (AGY) CLI** with Google OAuth. This is **not** the Gemini
  website and **not** a generic Gemini API key.
- **READY_ON_DEMAND**: zero active sessions is healthy; no idle polling, no quota burn.
- Prerequisite: AGY installed at `%LOCALAPPDATA%\agy\bin\agy.exe` and signed in once.

### GLM — ZCode + Z2C (governed, **Flash only**)

- Uses your installed, signed-in **ZCode** and its official `app-server --stdio`
  protocol. The **Z2C companion** (shipped in [`z2c/`](z2c), MIT) provides a
  loopback, token-authenticated semantic service. It does not replace the
  Desktop bundled agent or read ZCode model credentials.
- **Governed policy is FLASH-ONLY**: ChatGPT-controlled execution admits exactly
  `builtin:zai-coding-plan / GLM-5.3-Flash / max`, observed from the exact native
  session (`official-session-read`). The main GLM-5.3 model stays available for **manual**
  ZCode use but is rejected for governed C2C execution — no automatic escalation.
- Model/reasoning changes on a live session are supported natively
  (`update_zcode_session`): same session id, re-attested binding, fail closed.
- Prerequisite: ZCode signed into your Z.AI account; Z2C is built by the
  installer.

## Prerequisites · 前置条件

| Component | Installed by the C2C installer | Notes |
|---|---|---|
| Node.js ≥ 22, Git, pnpm | yes (winget / corepack, user scope) | |
| Codex CLI + login | no — install/sign in yourself | lane active once detected |
| Antigravity (AGY) CLI | no — install/sign in yourself | `%LOCALAPPDATA%\agy\bin` |
| ZCode Desktop + Z.AI plan | no — install/sign in yourself | GLM Flash lane |
| cloudflared | no — only for a stable public hostname | quick tunnels work without it |

## Quick deploy with a local agent · 本地 Agent 一键部署

Hand this repository to any local coding agent — or run one command yourself.
From a **fresh clone** (Windows 11 / PowerShell first):

```powershell
git clone https://github.com/G0K0U/agents-with-chatgpt.git
cd agents-with-chatgpt
node scripts\deploy.mjs
```

macOS / Linux: `node scripts/deploy.mjs`. The command is **idempotent** —
re-running it is always safe. It automates everything local: prerequisite
checks (Node.js ≥ 22, git, pnpm via corepack), dependency install, build
(including the bundled Z2C companion), safe local state init,
local bridge start, and health verification (the local MCP endpoint must
answer 401 without a token — proving OAuth is enforced). It ends with a
concise success summary and explicit next actions. Useful flags:
`--workspace <path>` to deploy for a project directory, `--autostart`
(opt-in Windows logon task), `--no-start-bridge` (checks only), `--json`.

**What stays human — by design.** The deploy flow never creates Cloudflare
tunnels, DNS records, hostnames, or certificates, never starts cloudflared,
and never touches an existing tunnel configuration. With no public connection
configured it prints a `HUMAN ACTION REQUIRED` block containing the exact
commands to run yourself: `a2c tunnel choose --mode quick` (temporary
address, no account needed) or `a2c tunnel choose --mode named --zone
<your-domain.com>` (stable hostname; opens a browser for a one-time
Cloudflare login). Local-only operation is a fully supported outcome. The
ChatGPT connector step (browser login + one-time pairing code) is also human.

Agents: [AGENTS.md](AGENTS.md) is the operating contract — canonical
deploy/health/restart/update/rollback commands and the automation boundaries.

## One-line install · 一行命令安装（Windows 11 x64）

**中文** — 在 PowerShell 里执行。该命令会安装并构建**本地可分发的全部组件**
（C2C 与内置的 Z2C 伴随组件）；三个供应商的账号登录仍需各自完成一次：

```powershell
irm https://raw.githubusercontent.com/G0K0U/agents-with-chatgpt/main/install/install.ps1 | iex
```

带参数（指定工作区、跳过隧道、锁定 commit）：

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/G0K0U/agents-with-chatgpt/main/install/install.ps1))) `
  -Workspace "C:\code\my project" -ExpectedCommit <release-commit-sha>
```

脚本支持 `-Update` 更新、`-Uninstall` 卸载（默认保留用户数据）、
`-EnableAutoStart` 显式注册开机自启；安装目录、状态目录、工作区相互独立。
完整参数与失败码见 [install/install.ps1](install/install.ps1)。

**EN** — Run this in PowerShell. The command installs and builds **everything that
is locally distributable** (C2C plus the bundled Z2C companion); each provider's
account login is still a separate one-time step:

```powershell
irm https://raw.githubusercontent.com/G0K0U/agents-with-chatgpt/main/install/install.ps1 | iex
```

## Agent-prompt install · Agent 部署提示词

Prefer letting your coding agent do it? Copy the deploy prompt, the read-only
smoke-test prompt, and the two-session multi-agent example from
**[docs/agent-prompts.md](docs/agent-prompts.md)**. The classic one-paste
install prompt below is unchanged and battle-tested:

**中文** — 不懂 git、Node、终端？完全不需要懂。把下面这段话原样复制给你的
编码 Agent（Codex），然后去倒杯咖啡：

```text
请帮我完整安装并配置 Codex with ChatGPT，全程自动，我是不懂技术的小白，
所有事情你自己做：

1. 环境自检：需要 git 和 Node.js ≥ 22，缺什么就自动安装
  （macOS 用 Homebrew，Windows 用 winget），同时安装 cloudflared。
2. 下载：把 https://github.com/G0K0U/agents-with-chatgpt 克隆到
   ~/codex-with-chatgpt（已存在就 git pull 更新）。
3. 构建：在该目录里执行 corepack pnpm install 和 corepack pnpm build。
4. 安装 Skill：把仓库里的 skill/SKILL.md 复制到
   ~/.codex/skills/codex-with-chatgpt/SKILL.md，并把文件中
   "The codex-with-chatgpt checkout lives at:" 那一行的路径改成实际克隆路径。
5. 首次配置：按 SKILL.md 里的 first-time setup 流程执行
  （运行 c2c setup，用内置浏览器打开 ChatGPT 配置连接器并输入配对码）。
   全程只用内置浏览器，禁止打开任何第三方浏览器。
6. 只有遇到需要我登录（ChatGPT / Cloudflare）、验证码或两步验证时才叫我，
   而且一次只告诉我一个动作。
7. 完成后给我看 ✓ 清单，并确认文件读取测试通过。我不懂 MCP、OAuth、
   Tunnel、端口这些词，不要向我解释；出了问题先自己修。
```


**EN** — Don't know git, Node, or terminals? You don't need to. Copy the
paragraph below, paste it to your coding agent (Codex), and go grab a coffee:

```text
Please install and configure "Codex with ChatGPT" for me, fully automatically.
I am a non-technical user — do everything yourself:

1. Check the environment: git and Node.js >= 22 must be available. Install
   anything missing yourself (macOS: Homebrew, Windows: winget). Also install
   cloudflared.
2. Download: clone https://github.com/G0K0U/agents-with-chatgpt into
   ~/codex-with-chatgpt (if it already exists, git pull to update).
3. Build: inside that folder run `corepack pnpm install` then `corepack pnpm build`.
4. Install the Skill: copy skill/SKILL.md to
   ~/.codex/skills/codex-with-chatgpt/SKILL.md, and update the line
   "The codex-with-chatgpt checkout lives at:" to the actual clone path.
5. First-time setup: follow the SKILL.md "first-time setup" workflow
   (run c2c setup, configure the ChatGPT connector in the BUILT-IN browser,
   enter the pairing code). Never open a third-party browser.
6. Only interrupt me for logins (ChatGPT / Cloudflare), CAPTCHAs or 2FA —
   and give me exactly ONE action at a time.
7. When done, show me the ✓ checklist and confirm the file-read test passed.
   I don't know what MCP, OAuth, tunnels or ports are. Don't explain them.
   If anything breaks, fix it yourself first.
```


**Updates · 更新** — The Skill checks GitHub once a day and updates itself when a
new version is released; no action needed. You can also say "更新 Codex with ChatGPT"
anytime. / Skill 每天自动检查一次 GitHub，有新版本会自动更新，无需任何操作；
也可以随时对 Codex 说"更新 Codex with ChatGPT"。

---

*The sections below are in English. 以下详细内容为英文，中文完整版见
[README.zh-CN.md](README.zh-CN.md)。*

## Install → Setup → Use (manual)

1. Install the Codex Skill: copy `skill/` to `~/.codex/skills/codex-with-chatgpt/`.
2. Tell Codex: **"Set up Codex with ChatGPT."** (中文: "使用 Codex with ChatGPT 完成首次配置。")
3. Use Codex normally: **"Use Codex with ChatGPT to implement XXX."**

That's the whole manual. You don't need to know what MCP, OAuth, tunnels,
ports or localhost are — Codex configures everything automatically and you
just see:

```
Codex with ChatGPT

✓ Project detected
✓ Workspace Bridge started
✓ Secure connection established
✓ ChatGPT connected
✓ File read test passed

Ready.
```

The only steps that may need you: logging into ChatGPT (and, if you want a
stable hostname, logging into Cloudflare once). A **new** workspace also asks
you to create a ChatGPT Project (collection) once — pick **project-only
memory**, name it after the workspace. If the sidebar has no Projects row,
hover **Chats**, open the … menu, and choose **Organize by project**. Codex
then saves that collection link and starts chats from that page. Existing
workspaces that already have a C2C chat stay on the old one-conversation
style until you ask to switch.

### Optional stable hostname

The default public address is a temporary Cloudflare URL. It changes when the
bridge restarts, and Codex repairs ChatGPT by deleting that workspace's
connector and adding it again.

If you have a Cloudflare account and a domain already on Cloudflare, first-time
setup (and the next coding session, once) will ask whether you want a stable
hostname such as `c2c-<project>.your-domain.com`. That path opens a browser so
you can authorize Cloudflare. After that, the ChatGPT connector keeps working
across restarts. If you skip it, or login fails, Codex stays on the temporary
address — same features, just a slower repair.

Credentials stay in the OS app state directory, not in the project.

## How it works

```
              ┌───────────────────────────┐
              │       ChatGPT Web         │
              │    Reason / Plan/Review   │
              └──────────┬────────▲───────┘
                         │        │
                MCP      │        │ Computer Use
             Data Plane  │        │ Control Plane (<1 KB messages)
                         ▼        │
              ┌─────────────────────────────┐
              │        C2C Bridge           │  loopback-only HTTP + OAuth 2.1
              │   read/review + scoped      │  one-time pairing code
              │   task adapters             │  Cloudflare tunnel manager
              └───┬──────────┬──────────┬───┘
                  │          │          │
     ┌────────────▼───┐ ┌────▼─────────┐ ┌▼──────────────────────────────┐
     │  Codex App     │ │  AGY CLI     │ │ Z2C semantic service →        │
     │  Server        │ │  (Google     │ │ ZCode app-server → GLM-5.3-Flash│
     │  (native)      │ │  OAuth)      │ │ (Z.AI Coding Plan, Flash-only)│
     └────────────────┘ └──────────────┘ └───────────────────────────────┘
```

- **Control plane (Computer Use)**: Codex and ChatGPT exchange tiny structured
  `[C2C]` state messages — `INIT → PLAN → EXECUTED → REVIEW → DONE`. No diffs,
  no logs, no file bodies are ever pasted.
- **Data plane (MCP)**: ChatGPT pulls what it needs through the read/review
  tools and uses the separately authorized task, queue, provider, and
  audit-mirror tools. The MCP surface is code-defined (see `src/mcp/`) rather
  than a fixed count; every write path is separately scoped.
- **Independent review**: after an agent executes, ChatGPT inspects the actual
  git diff and test records through MCP — it never trusts "all tests passed"
  claims blindly.
- **Provider isolation**: one provider's failure never silently substitutes
  another. The GLM governed lane only executes on the attested Flash identity.

## Permission model (short version)

- **Full local executor**: the CLI starts the official Codex App Server with
  full filesystem and process access, matching the selected Codex/ChatGPT local
  execution mode. Requests default to `network: false`; this full-access
  backend rejects that setting before launching a provider because it cannot
  enforce offline execution. An explicit, locally authorized `network: true`
  request is required for a live task. A submitted task can edit any host path
  available to the bridge process.
- **Scoped public contract**: ChatGPT reaches execution through the task
  lifecycle, queue-control, provider, and audit-mirror tools; it cannot call an
  arbitrary MCP shell or App Server method directly. The bridge retains OAuth
  scope, workspace identity, owner, and session checks on every path.
- **Multiple authorized workspaces**: one connector can select only registry
  entries bootstrapped by the local bridge; every entry has a stable id and a
  canonical root. Public read/review tools remain workspace-relative.
- **Output protection remains**: OAuth tokens, pairing codes, credentials, and
  host paths are still redacted from logs, task metadata, session checkpoints,
  and released command output where those filters apply.
- **Knowing the URL grants nothing**: the public MCP endpoint requires OAuth 2.1
  (PKCE S256, dynamic client registration, rotating refresh tokens). Without a
  token: 401. Wrong workspace: 403.
- **The model never sees long-lived credentials**: the only secret that ever
  touches a browser is a one-time pairing code (5-minute TTL, 5 attempts,
  rate-limited, destroyed on use).
- **GLM attestation**: a governed GLM task is admitted only after the exact
  native session reports `zcode-desktop / builtin:zai-coding-plan / GLM-5.3-Flash`
  through the Desktop's own session read. Unobserved or main-model identity
  fails closed.

Full threat model: [docs/security.md](docs/security.md)

## Verification

- `c2c status --json` — bridge/tunnel/provider state for a workspace.
- `c2c supervisor status` — control-plane self-check (all lanes).
- `c2c doctor --fix` — auto-repair the connection.
- Provider smoke: one tiny read-only task per lane through ChatGPT. A governed
  GLM task must produce START and COMPLETED receipts both showing
  `GLM-5.3-Flash`.

## For developers

```bash
pnpm install
pnpm build          # -> dist/, exposes the `c2c` bin
pnpm test           # vitest: full unit + integration + full-access bridge suite

# Z2C companion (GLM lane)
cd z2c && npm ci && npm run build

c2c setup           # bridge + tunnel + pairing code, all in one
c2c sandbox-allow   # whitelist the settings dir in Codex (macOS + Windows)
c2c status / doctor / pair / unpair / logs / stop
```

Requirements: Node.js >= 22, git. `cloudflared` for the public connection
(auto-detected; the Skill installs it for you).

Docs: [AGENTS.md](AGENTS.md) (agent handoff) · [architecture](docs/architecture.md) · [protocol](docs/protocol.md) ·
[security](docs/security.md) · [troubleshooting](docs/troubleshooting.md) ·
[agent prompts](docs/agent-prompts.md) · [support matrix](docs/support-matrix.md) ·
[release operations](docs/release-and-operations.md) ·
[changelog](CHANGELOG.md)

## Project layout

```
src/          C2C bridge, MCP surface, OAuth, pairing, workspace policy,
              tunnel, provider lanes, release/LKG lifecycle, supervisor
z2c/          Z2C companion (MIT): semantic service + official ZCode protocol;
              legacy desktop-agent proxy is separate and not the default
third_party/  Vendored MIT-licensed Quanta 0.9.4+a2c.1 source patch
skill/        the Codex Skill (the real UX layer)
tests/        unit + integration tests
docs/         architecture / protocol / security / troubleshooting
install/      Windows installer + autostart registration
bin/          stable LKG-resolving launcher (bin/c2c.js, bin/a2c.js)
scripts/      one-command local deploy (scripts/deploy.mjs) + build/acceptance scripts
AGENTS.md     operating contract for local coding agents
CHANGELOG.md  release notes per version
```

## Public infrastructure boundary

This repository includes source code, architecture, and generic tunnel integration only. It does **NOT** ship the maintainer's website/domain/tunnel, Cloudflare account, tunnel ID, certificates, OAuth state, runtime state, endpoints, or credentials. Each user configures their own tunnel/hostname or uses local/no-tunnel mode (`--no-tunnel`).

## Attribution

This public repository derives from and upstreams [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt) under the MIT License, while this repository contains current multi-agent extensions. Upstream copyright remains with original contributors under the terms of the MIT License. The `z2c/` companion is distributed under the same MIT License. Vendored Quanta retains its own [MIT license](third_party/quanta/LICENSE) and [source record](third_party/quanta/PATCH-INFO.md).

## Status & disclaimer

The 0.3.0 candidate's local A2C OAuth path completed a GPT-6 Sol/max nonce
canary with matching selection and no file changes. See the
[support matrix](docs/support-matrix.md) for build-specific evidence and
unverified platforms. The current ChatGPT connector requires its own client
check. Full-access mode is intentional: a holder of execution scopes can
direct local Codex actions within the bridge process's OS permissions.

**Unofficial community project. Not affiliated with or endorsed by OpenAI, Google, or Z.AI.**

## License

[MIT](LICENSE) — applies to C2C and the `z2c/` companion.

Full-access development is opt-in via `C2C_FULL_ACCESS_DEVELOPMENT=true`; otherwise the CLI uses restricted execution. See [deployment policy](docs/full-access-development.md).
