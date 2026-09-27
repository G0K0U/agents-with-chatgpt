# Agents with ChatGPT

[English](README.md) | **简体中文**

> ChatGPT 负责思考，Agent 负责干活——Codex、Gemini、GLM。

## 解决什么问题

ChatGPT 付费订阅的网页版额度大量闲置，编程 Agent 却在消耗紧张的 API 额度做
规划和 Review。本项目把"思考"交给你已付费的网页版 ChatGPT，本地 Agent 继续
负责执行。不用 API Key、不搞逆向代理——官方网页 + OAuth MCP 桥接，并提供明确
授权的本地任务提交路径。

## 这是什么

把 ChatGPT 网页版变成编码会话的"规划与审查大脑"。你的仓库永远不会被上传——
ChatGPT 通过 OAuth MCP 连接按需读取代码，并通过本地、经过身份证明的执行通道
提交任务。项目提供三条相互独立的执行通道：

1. **Codex** — 官方 Codex App Server（本地执行器）。
2. **Gemini** — Antigravity/AGY CLI + Google OAuth（按需就绪；没有活跃会话也是
   健康状态）。
3. **GLM（治理通道）** — Z2C 伴随组件 → ZCode Desktop → **仅 GLM-5.3-Flash**，
   原生同会话模型/身份证明 + 精确工作区绑定。

## 三条执行通道

### Codex — 原生 App Server

- 使用本地官方 **Codex App Server**，无 shim、无反向代理。
- 模型目录与任务执行使用同一已配置运行时；目录列出模型不等于真实任务完成。
  具体支持范围见[支持矩阵](docs/support-matrix.md)。
- 前置条件：机器上完成 Codex/OpenAI 登录（CLI 或桌面版）。

### 可选用量遥测 — Quanta

`agent_usage_status` 可读取本地 Quanta 采样。A2C 按供应商各自的采样时间
执行 60 秒新鲜度判断；缺失、过期或刷新失败的数据仍显示为 unknown。
没有安装 Quanta 也可手动执行 Agent。仓库包含 MIT 许可的
[Quanta 0.9.4+a2c.1 修补源码和构建说明](third_party/quanta/PATCH-INFO.md)；
上游原版 0.9.4 可执行文件不含此修补。

### Gemini — Antigravity/AGY CLI + Google OAuth

- 使用 **Antigravity (AGY) CLI** 与 Google OAuth。**不是** Gemini 网页版，
  **不是** 通用 Gemini API Key。
- **按需就绪（READY_ON_DEMAND）**：没有活跃会话就是健康态；不轮询、不烧配额。
- 前置条件：AGY 安装在 `%LOCALAPPDATA%\agy\bin\agy.exe` 并登录一次。

### GLM — ZCode + Z2C（治理通道，**仅 Flash**）

- 通过已安装并登录的 **ZCode** 官方 `app-server --stdio` 协议使用你的
  **Z.AI Coding Plan** 订阅。**Z2C 伴随组件**（见 [`z2c/`](z2c)，MIT）提供
  本地回环、令牌鉴权的语义服务；不替换 Desktop 内置 Agent，也不读取 ZCode 凭据。
- **治理策略仅限 Flash**：ChatGPT 控制的执行只接受
  `builtin:zai-coding-plan / GLM-5.3-Flash / max`，且该身份必须从确切原生会话
  （`official-session-read`）观测到。GLM-5.3 主模型仅保留给**手动** ZCode 使用，
  治理执行一律拒绝——不存在自动升级到主模型的路径。
- 支持对活跃会话的原生模型/推理强度切换（`update_zcode_session`）：会话 id 不变，
  切换后重新证明绑定，失败即拒绝。
- 前置条件：ZCode Desktop 登录 Z.AI 账号；Z2C 由安装器自动构建。

模型选择是动态的：`agent_model_catalog` 提供三个后端（Codex、Antigravity/Gemini、ZCode）的实时账号级模型目录，`agent_model_resolve` 把"用 Codex GPT-6 Astra Max"这类请求解析为经过目录确认的精确选择。不支持静默替换模型——不支持的模型或 effort 会以显式错误失败（见 `docs/release-and-operations.md`）。

## 前置条件

| 组件 | 是否由 C2C 安装器安装 | 说明 |
|---|---|---|
| Node.js ≥ 22、Git、pnpm | 是（winget / corepack，用户级） | |
| Codex CLI + 登录 | 否——自行安装并登录 | 检测到即激活 |
| Antigravity (AGY) CLI | 否——自行安装并登录 | `%LOCALAPPDATA%\agy\bin` |
| ZCode Desktop + Z.AI 订阅 | 否——自行安装并登录 | GLM Flash 通道 |
| cloudflared | 否——仅固定公网域名需要 | 快速隧道无需 |

## 本地 Agent 一键部署 · Quick deploy with a local agent

把仓库直接交给本地编码 Agent，或者自己执行一条命令。**全新克隆**后
（Windows / PowerShell 优先）：

```powershell
git clone https://github.com/G0K0U/agents-with-chatgpt.git
cd agents-with-chatgpt
node scripts\deploy.mjs
```

macOS / Linux 使用 `node scripts/deploy.mjs`。该命令**可重复执行**（幂等），
自动完成所有本地步骤：前置检查（Node.js ≥ 22、git、经 corepack 的 pnpm）、
安装依赖、构建（含可选的内置 Z2C 伴随组件）、初始化安全本地状态、启动本地
Bridge 并做健康验证（本地 MCP 未带令牌时必须返回 401，证明 OAuth 生效），
最后打印简明的成功摘要和下一步动作。常用参数：`--workspace <path>` 为某个
项目目录部署、`--autostart`（显式开启 Windows 登录自启）、
`--no-start-bridge`（仅检查）、`--json`。

**公网/域名步骤保留给人——这是刻意设计。** 部署流程绝不创建 Cloudflare
隧道、DNS 记录、主机名或证书，不启动 cloudflared，也绝不改动已有的隧道
配置。未选择公网连接时会打印明确的 `HUMAN ACTION REQUIRED` 区块，并给出
需要你自己执行的精确命令：`a2c tunnel choose --mode quick`（临时地址，无需
账号）或 `a2c tunnel choose --mode named --zone <你的域名>`（固定域名；会
打开浏览器完成一次性 Cloudflare 登录）。纯本地模式是完全受支持的使用方式。
ChatGPT 连接器配置（浏览器登录 + 一次性配对码）同样由人完成。

Agent 用户请阅读 [AGENTS.md](AGENTS.md)——本地自动化与人工操作边界、
标准部署/健康检查/重启/更新/回滚命令都在其中。

## 一行命令安装（Windows 11 x64）

在 PowerShell 里执行。该命令会安装并构建**本地可分发的全部组件**（C2C 与内置
Z2C 伴随组件）；三个供应商的账号登录仍需各自完成一次：

```powershell
irm https://raw.githubusercontent.com/G0K0U/agents-with-chatgpt/main/install/install.ps1 | iex
```

带参数（指定工作区、跳过隧道、锁定 commit）：

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/G0K0U/agents-with-chatgpt/main/install/install.ps1))) `
  -Workspace "C:\code\my project" -ExpectedCommit <release-commit-sha>
```

支持 `-Update` 更新、`-Uninstall` 卸载（默认保留用户数据）、
`-EnableAutoStart` 显式注册开机自启。完整参数见
[install/install.ps1](install/install.ps1)。

## 一段话安装（纯小白专用）

不懂 git、Node、终端？完全不需要懂。把下面这段话原样复制给你的编码
Agent（Codex），然后去倒杯咖啡：

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

**更新** — Skill 每天自动检查一次 GitHub，有新版本会自动更新，无需任何操作；
也可以随时对 Codex 说"更新 Codex with ChatGPT"。

## 安装 → 配置 → 使用（手动版）

1. 安装 Codex Skill：把 `skill/` 复制到 `~/.codex/skills/codex-with-chatgpt/`。
2. 对 Codex 说：**"使用 Codex with ChatGPT 完成首次配置。"**
3. 正常使用：**"使用 Codex with ChatGPT 实现 XXX。"**

就这么简单。MCP、OAuth、隧道、端口、localhost——统统不用懂，Codex 会自动配置。

唯一可能需要你的步骤：登录 ChatGPT（以及想要固定域名时登录一次 Cloudflare）。

### 可选的固定域名

默认公网地址是 Cloudflare 临时 URL，桥接重启后会变化。如果你有 Cloudflare
账号和已托管的域名，首次配置会询问是否绑定固定域名
（`c2c-<项目>.你的域名`），并在浏览器里完成一次 Cloudflare 授权。跳过或失败
也不影响功能，只是地址会变。凭据保存在系统应用状态目录，不进项目。

## 工作原理

```
              ┌───────────────────────────┐
              │       ChatGPT Web         │
              │     规划 / 审查 / 决策     │
              └──────────┬────────▲───────┘
                         │        │
                MCP      │        │ Computer Use
             数据平面     │        │ 控制平面（<1KB 消息）
                         ▼        │
              ┌─────────────────────────────┐
              │        C2C Bridge           │  仅回环 HTTP + OAuth 2.1
              │   读取/审查 + 受限任务适配    │  一次性配对码
              └───┬──────────┬──────────┬───┘
                  │          │          │
     ┌────────────▼───┐ ┌────▼─────────┐ ┌▼──────────────────────────────┐
     │  Codex App     │ │  AGY CLI     │ │ Z2C → desktop-agent 代理 →    │
     │  Server（原生） │ │ (Google      │ │ ZCode Desktop → GLM-5.3-Flash │
     │                │ │  OAuth)      │ │ (Z.AI 订阅，仅 Flash)          │
     └────────────────┘ └──────────────┘ └───────────────────────────────┘
```

- **控制平面（Computer Use）**：Codex 与 ChatGPT 只交换极小的结构化 `[C2C]`
  状态消息（`INIT → PLAN → EXECUTED → REVIEW → DONE`），从不粘贴 diff、日志或
  文件内容。
- **数据平面（MCP）**：ChatGPT 通过读取/审查工具按需取数，通过单独授权的任务、
  队列、供应商与审计镜像工具提交工作。MCP 面由代码定义（见 `src/mcp/`），
  每个写入路径都单独授权。
- **独立审查**：Agent 执行后，ChatGPT 通过 MCP 检查真实 git diff 与测试记录，
  绝不轻信"测试全过"的口头声明。
- **供应商隔离**：一个供应商的故障永远不会被另一个悄悄顶替。GLM 治理通道只在
  被证明的 Flash 身份上执行。

## 权限模型（简版）

- **本地执行器**：CLI 以 full-access 模式启动官方 Codex App Server，网络默认
  关闭，仅显式 `network: true` 且本地部署允许时开启。
- **受限公开契约**：ChatGPT 只能通过任务生命周期、队列控制、供应商与审计镜像
  工具操作，不能直接调用任意 MCP Shell 或 App Server 方法。
- **多授权工作区**：一个连接器只能选择本地 bridge 登记的注册工作区；每个条目有
  稳定 id 与规范根路径。
- **输出保护**：OAuth 令牌、配对码、凭据与主机路径在日志、任务元数据与会话
  检查点中持续脱敏。
- **知道 URL 不等于能访问**：公开 MCP 需要 OAuth 2.1（PKCE S256、动态客户端
  注册、刷新令牌轮换）。无令牌：401；错误工作区：403。
- **模型永远接触不到长期凭据**：浏览器唯一接触的秘密是一次性配对码（5 分钟
  有效、5 次尝试、用后即毁）。
- **GLM 身份证明**：治理 GLM 任务仅在确切原生会话通过 Desktop 自身的会话读取
  报告 `zcode-desktop / builtin:zai-coding-plan / GLM-5.3-Flash` 后才会被接纳；
  未观测到或主模型身份一律失败关闭。

完整威胁模型：[docs/security.md](docs/security.md)

## 验证

- `c2c status --json` — 工作区桥接/隧道/供应商状态。
- `c2c supervisor status` — 控制平面自检（全部通道）。
- `c2c doctor --fix` — 自动修复连接。
- 供应商冒烟：每条通道通过 ChatGPT 提交一个只读小任务。治理 GLM 任务必须产生
  START 与 COMPLETED 回执，且都显示 `GLM-5.3-Flash`。

## 开发者

```bash
pnpm install
pnpm build          # -> dist/，暴露 c2c 命令
pnpm test           # vitest 全量测试

# Z2C 伴随组件（GLM 通道）
cd z2c && npm install && npm run build

c2c setup           # bridge + 隧道 + 配对码，一条命令
c2c sandbox-allow   # 把设置目录加入 Codex 白名单
c2c status / doctor / pair / unpair / logs / stop
```

要求：Node.js >= 22、git；公网连接需要 `cloudflared`（自动检测）。

文档：[架构](docs/architecture.md) · [协议](docs/protocol.md) ·
[安全](docs/security.md) · [故障排查](docs/troubleshooting.md)

## 目录结构

```
src/          C2C bridge、MCP 面、OAuth、配对、工作区策略、隧道、供应商通道、
              release/LKG 生命周期、supervisor
z2c/          Z2C 伴随组件（MIT）：治理 GLM 控制平面 + desktop-agent 代理 +
              原生 ZCode 协议客户端
third_party/  Quanta 0.9.4+a2c.1 的 MIT 许可修补源码
skill/        Codex Skill（真正的 UX 层）
tests/        单元 + 集成测试
docs/         架构 / 协议 / 安全 / 故障排查
install/      Windows 安装器 + 开机自启注册
bin/          稳定的 LKG 解析启动器（bin/c2c.js，bin/a2c.js）
scripts/      本地一键部署（scripts/deploy.mjs）+ 构建/验收脚本
AGENTS.md     本地编码 Agent 的操作契约
CHANGELOG.md  各版本发布说明
```

## 公开基础设施边界

本仓库只包含源代码、架构说明与通用隧道集成。**不包含**维护者的网站/域名/
隧道、Cloudflare 账号、隧道 ID、证书、OAuth 状态、运行时状态、端点或凭据。
每位用户自行配置自己的隧道/域名，或使用本地/无隧道模式（`--no-tunnel`）。

## 开源致谢与上游声明

本公开仓库派生自 [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)
（MIT 许可证），并包含当前的多 Agent 扩展。上游版权归原贡献者所有，依 MIT
许可证条款保留。`z2c/` 伴随组件同样以 MIT 许可证分发；Quanta 修补源码保留
[自身 MIT 许可证](third_party/quanta/LICENSE)和[来源记录](third_party/quanta/PATCH-INFO.md)。

## 状态与声明

0.3.0 候选版本的本地 A2C OAuth 路径已完成 GPT-6 Sol/max 短 nonce 真实调用，
模型选择一致且没有文件改动。具体构建证据和未验证平台见[支持矩阵](docs/support-matrix.md)。
当前 ChatGPT 连接器仍需由该客户端独立复核。

**非官方社区项目。与 OpenAI、Google、Z.AI 无隶属或背书关系。**

## 许可证

[MIT](LICENSE) —— 适用于 C2C 与 `z2c/` 伴随组件。

full-access 开发模式通过 `C2C_FULL_ACCESS_DEVELOPMENT=true` 显式开启；否则 CLI
使用受限执行。参见[部署策略](docs/full-access-development.md)。
