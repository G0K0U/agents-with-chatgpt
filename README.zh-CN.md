# Agents with ChatGPT

[English](README.md) | **简体中文**

> ChatGPT 负责思考，Codex 负责干活。

## 解决什么问题

ChatGPT 付费订阅的网页版额度大量闲置，Codex 却在消耗紧张的 API 额度做
规划和 Review。本项目把"思考"交给你已付费的网页版 ChatGPT，Codex 继续负责
本地执行。不用 API Key、不搞逆向代理——官方网页 + OAuth MCP 桥接，并提供明确授权的
本地任务提交路径。

## 这是什么

把 ChatGPT 网页版变成 Codex 编码会话的"规划与审查大脑"，执行权仍由 Codex 的本地
执行器掌握。你的仓库永远不会被上传——ChatGPT 通过 OAuth MCP 连接按需读取代码，
并可通过本地 Codex App Server 提交任务。当前 CLI 按已选择的 full-access 模式运行执行器：
Codex 可以使用 bridge 进程拥有的文件系统和进程权限；网络默认关闭，只有任务明确设置
`network: true` 且本地 full-access 部署允许时才开启。公开 MCP 接口仍保持固定、显式枚举的 28 个 MCP 工具，
其中外部写入仅限单独授权的精确审计镜像工具，不新增通用 Shell 工具。

## 一行命令安装（Windows 11 x64）

在 PowerShell 里执行（依赖缺失时脚本会用 winget 自动以用户级安装
git/Node.js）：

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

1. 环境自检：需要 git 和 Node.js ≥ 20，缺什么就自动安装
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

**更新**：Skill 每天自动检查一次 GitHub，有新版本会自动更新并继续任务，
无需任何操作；也可以随时对 Codex 说"更新 Codex with ChatGPT"。

## 安装 → 配置 → 使用（手动版）

1. 安装 Codex Skill：把 `skill/` 复制到 `~/.codex/skills/codex-with-chatgpt/`。
2. 对 Codex 说：**"使用 Codex with ChatGPT 完成首次配置。"**
3. 之后正常使用：**"使用 Codex with ChatGPT，帮我实现 XXX。"**

说明书到此结束。你不需要知道 MCP、OAuth、Tunnel、端口、localhost 是什么——
Codex 会自动完成所有配置，你只会看到：

```
Codex with ChatGPT

✓ 当前项目已识别
✓ Workspace Bridge 已启动
✓ 安全连接已建立
✓ ChatGPT 已连接
✓ 文件读取测试通过

Ready.
```

唯一可能需要你动手的步骤：登录 ChatGPT（如果要用固定域名，再登录一次 Cloudflare）。**新仓库**还会请你在 ChatGPT 里建一次项目（合集）：名字用仓库名，记忆选「仅限项目记忆」。侧栏如果没有「项目」，把鼠标放在「聊天」上，点右边三个点，选「按项目整理」。之后对话都从合集页开，不用回首页。已经在用的仓库默认还是原来的一条长对话，除非你说要改成 Project。

### 可选的固定域名

默认公网地址是临时的，桥重启后会变。Codex 会删掉这个项目的 ChatGPT 插件再按新地址加回去。

如果你有 Cloudflare 账号，并且域名已经加在 Cloudflare 上，首次配置时（老用户则在下一次编码时问一次）会问你要不要用固定域名，例如 `c2c-<项目>.你的域名`。选是的话，浏览器里授权一次 Cloudflare 即可。之后重启一般不用再改插件。没有账号、不想用、登录失败：继续用临时地址，功能一样，只是修复更慢。

凭证放在系统目录，不进项目。

## 工作原理

```
                ┌──────────────────────────┐
                │       ChatGPT 网页版     │
                │   推理 / 规划 / 审查     │
                └───────────┬────────▲─────┘
                            │        │
                  MCP       │        │ Computer Use
                数据面      │        │ 控制面（消息 < 1 KB）
                            ▼        │
                ┌─────────────────────────────────┐
                │            C2C 核心             │  仅监听本机回环
                │  MCP 读/审查 + 任务工具         │  OAuth 2.1 + 配对码
                │  运行时身份 + 发布生命周期      │  Cloudflare 隧道
                │  有界监督者 + doctor 诊断       │
                └───────┬──────────┬─────────┬────┘
                        │          │         │
                按需    │          │  按需   │   托管常驻
                        ▼          ▼         ▼
              ┌────────────┐ ┌────────────┐ ┌──────────────────┐
              │   Codex    │ │  Gemini /  │ │ ZCode / GLM      │
              │ App Server │ │ Antigravity│ │ Z2C →            │
              │            │ │    AGY     │ │ ZCode Desktop    │
              └────────────┘ └────────────┘ └──────────────────┘
```

- **控制面（Computer Use）**：Codex 与 ChatGPT 之间只交换极小的结构化 `[C2C]`
  状态消息——`INIT → PLAN → EXECUTED → REVIEW → DONE`。绝不粘贴 diff、日志
  或文件内容。
- **数据面（MCP）**：固定的 28 个工具契约。ChatGPT 通过读/审查工具
  （`workspace_info`、`list_directory`、`read_file`、`search_workspace`、
  `git_status`、`git_diff`、`test_status`、`execution_summary`、
  `execution_output`）按需拉取；在明确授权时通过 Codex 任务生命周期工具
  （`submit_codex_task`、`get_codex_task`、`cancel_codex_task`）和受限的
  `execution_queue` 控制工具提交/暂停任务；通过 `zcode_*` 队列/原生工具和
  agent 路由工具触达 ZCode 通道。单独 scope 的
  `write_engineering_ai_audit_mirror` 只允许写入操作者自行配置的
  Engineering AI 审计状态目标（未设置 `C2C_ENGINEERING_AI_WORKSPACE_ID`
  时该功能关闭）。
- **供应商通道相互隔离**：Codex 与 Gemini/Antigravity AGY 按需启动；
  ZCode/GLM 是经 Z2C 连接 ZCode Desktop 的托管常驻通道。每条通道有自己的
  启动策略和故障域——一条通道降级不会拖垮其他通道。
- **独立审查**：Agent 执行完毕后，ChatGPT 通过 MCP 亲自检查真实的 git diff
  和测试记录——绝不因为对方说"测试全过"就直接相信。

## 运行时生命周期与可靠性（Stability R1 / R1.1）

- **不可变发布（LKG）**：`c2c release build` 产出 `dist/` 和构建清单，并把
  不可变副本归档到 `releases/<id>/`；`c2c release activate` 先跑发布门禁，
  通过后才改写 `LKG.json`。门禁失败时上一个 last-known-good 发布原封不动，
  坏构建永远不会毁掉正在工作的运行时。守护进程启动 bridge 时优先使用 LKG
  发布。
- **运行时身份**：每次构建记录它由哪棵源码树、哪棵 dist 树产出；运行时会
  重新哈希这两棵树，漂移（`SOURCE_BUILD_MISMATCH`、
  `BUILD_RUNTIME_MISMATCH`）会被检测出来，而不是默默跑着过期输出。
- **有界监督者**：一个轻量进程观察控制面并做定向恢复——重新探测、对账、
  重连受影响的供应商、重启受影响的伴随进程，只有 C2C 自身不健康时才重启
  C2C。重启按退避有界（立即、5s、15s、30s，之后 FAILED 等人工介入），
  重启风暴在结构上不可能发生。监督者从不写持久状态（任务记录、回执、
  认证、工作区归属对它只读）。
- **Windows 开机自启**：`install/register-autostart.ps1` 注册登录触发的
  计划任务运行 `c2c supervisor run`，由监督者接管启动顺序
  （bridge → 隧道 → 供应商通道）。
- **供应商启动策略**：
  - `codex` / `gemini`（Antigravity AGY）——**按需**：只做本地、零成本的
    就绪检查（可执行文件可解析、隔离状态可准备）。空闲时不驻留进程、
    不消耗配额。前提：分别安装并登录 Codex CLI / Gemini 或 Antigravity。
  - `zcode`（GLM）——**托管常驻**：ZCode Desktop GUI 本身就是通道；缺失时
    监督者会带桌面代理环境变量启动它，让注册 → Z2C → 工作区绑定 →
    原生证明链自行建立。前提：安装 ZCode Desktop。
- **统一 doctor**：`c2c doctor`/status 从本地持久界面（运行时指针、发布
  指针、监督者状态、有界存活探测）汇总出一张运维视图，剥离管理员令牌，
  单个分区读取失败不会拖垮整份报告。

这些机制用于界定和发现故障，并不意味着供应商永远在线或故障不可能发生。
各通道仍有各自的外部前提；平台支持以 Windows 11 x64 为先——详见
[支持矩阵](docs/support-matrix.md)。

## 权限模型（简版）

- **执行器为 full-access**：当前 CLI 启动官方 Codex App Server 时开启完整文件系统
  和进程权限，网络默认关闭；只有任务明确设置 `network: true` 且本地部署允许时才开启。
  任务因此可以修改 bridge 进程在操作系统层面有权限访问的路径。
- **公开接口仍固定**：ChatGPT 只能通过 3 个任务生命周期工具和 1 个队列控制工具请求
  执行/暂停，外部写入也只有单独 scope 的精确审计镜像工具，不能直接调用任意 MCP Shell
  或 App Server 方法；
  OAuth scope、工作区身份、owner 和 session 归属校验继续保留。
- **多个已授权工作区**：同一个 connector 只能选择本地 bridge 注册表中的工作区；每个
  工作区有稳定 id 和 canonical root。公开读/审查工具仍使用工作区相对路径。
- **输出仍做保护**：OAuth token、配对码、凭据和主机路径在日志、会话摘要、任务元数据
  以及可释放的命令输出中继续脱敏；full-access 不会改变 MCP 响应契约。
- **知道 URL 不等于有权限**：公网 MCP 端点强制 OAuth 2.1（PKCE S256、动态
  客户端注册、refresh token 轮换）。无令牌：401；令牌属于别的工作区：403。
- **模型永远接触不到长期凭据**：唯一会出现在浏览器里的秘密是一次性配对码
  （5 分钟有效、限 5 次尝试、限速、用后即毁）。

完整威胁模型：[docs/security.md](docs/security.md)

## 开发者

```bash
pnpm install
pnpm build          # 产出 dist/ + 构建清单，暴露 c2c 命令
pnpm test           # vitest：完整单元、集成和 full-access bridge 测试

c2c setup           # 一条命令：Bridge + 隧道 + 配对码
c2c sandbox-allow   # 把本地设置目录加入 Codex 沙箱白名单（macOS / Windows）
c2c status / doctor / pair / unpair / logs / stop
c2c release build / c2c release activate   # 不可变 LKG 发布生命周期
c2c supervisor run                          # 有界恢复循环（自启入口）
```

环境要求：Node.js >= 20、git；公网连接需要 `cloudflared`
（自动检测，Skill 会替你安装）。

文档：[架构](docs/architecture.md) · [协议](docs/protocol.md) ·
[安全](docs/security.md) · [故障排查](docs/troubleshooting.md)

## 目录结构

```
src/
  bridge/       本机回环 HTTP 服务、端口自动恢复、管理 API、运行时身份
  mcp/          固定 28 个工具的 MCP 契约（见「工作原理」）
  auth/         OAuth 2.1（PKCE、动态注册、refresh 轮换、吊销）
  pairing/      一次性配对码（CSPRNG、TTL、限速）
  workspace/    稳定注册表 id、路径收敛、敏感文件策略、搜索、git
  tunnel/       TunnelProvider 抽象 + Cloudflare Quick/Named Tunnel
  execution/    App Server 适配器、任务状态、审查闭环记录、ZCode 通道
  supervisor/   有界监督者 + 供应商启动策略
  process/      守护进程生命周期、不可变发布/LKG 生命周期、统一报告
  cli/          c2c 命令行
skill/        Codex Skill（真正的 UX 层）
tests/        单元 + 集成测试
docs/         架构 / 协议 / 安全 / 故障排查
```

## 公开基础设施边界

本仓库仅提供开源源代码、架构设计与通用的隧道集成支持，**不提供**维护者个人的网站、域名、隧道、Cloudflare 账号、隧道 ID、证书、OAuth 状态、运行时状态、服务端点或任何凭据。每位使用者需自行配置自己的隧道/域名或使用本地免隧道模式（`--no-tunnel`）。

## 开源致谢与上游声明

本项目基于 [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)（遵循 MIT 许可证），并包含当前的多 Agent 协作与扩展。上游代码著作权归原作者所有，本项目严格遵循 MIT 许可证相关条款。

## 状态与声明

v0.2.0 发布已验证的内容：发布树上源码/回归套件全绿，安装脚本在
Windows 11 x64 上端到端跑通，真实 OAuth 控制闭环与多 Agent 协作会话，
以及 Antigravity 直连适配器。Stability R1/R1.1（不可变 LKG 发布、运行时
身份、有界监督者、供应商启动策略）已随本次源码发布并附带回归测试。
Windows 11 x64 是唯一已验证平台——详见[支持矩阵](docs/support-matrix.md)
与 [v0.2.0 验收摘要](docs/release-acceptance-v0.2.0.md)中明确列出
已验证/未验证的内容。full-access 是有意选择的权限模型：持有该 connector
执行权限的人可以让本地 Agent 使用 bridge 进程在操作系统层面拥有的权限。

**非官方社区项目，与 OpenAI 无关联，未获其背书。**

## 许可证

[MIT](LICENSE)
