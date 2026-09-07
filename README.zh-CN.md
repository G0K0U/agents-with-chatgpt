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
`network: true` 且本地 full-access 部署允许时才开启。公开 MCP 接口仍保持固定的 14 个
工具，其中外部写入仅限单独授权的精确审计镜像工具，不新增通用 Shell 工具。

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
             ┌───────────────────────────┐
             │      ChatGPT 网页版       │
             │   推理 / 规划 / 审查      │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
              数据面    │          │ 控制面（消息 < 1 KB）
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │   仅监听本机回环地址
             │  MCP 读/审查        │   OAuth 2.1 + 一次性配对码
             │  受限任务适配器      │
             │  OAuth + 配对       │   Cloudflare Quick Tunnel
             │  Tunnel 管理        │
             └──────────┬──────────┘
                        │  本地策略校验的任务 / 审查数据
                        ▼
             ┌─────────────────────┐          ┌─────────────────────┐
             │     本地工作区      │◀─────────│ Official Codex      │
             └─────────────────────┘ 受限写入 │ App Server (v2)     │
                                              │ tests               │
                                              └─────────────────────┘
```

- **控制面（Computer Use）**：Codex 与 ChatGPT 之间只交换极小的结构化 `[C2C]`
  状态消息——`INIT → PLAN → EXECUTED → REVIEW → DONE`。绝不粘贴 diff、日志
  或文件内容。
- **数据面（MCP）**：ChatGPT 缺什么自己拉什么，共 9 个读/审查工具；另有明确授权的
  `submit_codex_task`、`get_codex_task`、`cancel_codex_task`、`execution_queue` 四个受限
  任务/队列工具：
  `workspace_info`、`list_directory`、`read_file`、`search_workspace`、
  `git_status`、`git_diff`、`test_status`、`execution_summary`、
  `execution_output`。`write_engineering_ai_audit_mirror` 使用单独 scope，且只允许
  写入操作者自行配置的 Engineering AI 审计状态目标（未设置
  `C2C_ENGINEERING_AI_WORKSPACE_ID` 时该功能关闭）。
- **独立审查**：Codex 执行完毕后，ChatGPT 通过 MCP 亲自检查真实的 git diff
  和测试记录——绝不因为 Codex 说"测试全过"就直接相信。

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
pnpm build          # 产出 dist/，暴露 c2c 命令
pnpm test           # vitest：完整单元、集成和 full-access bridge 测试

c2c setup           # 一条命令：Bridge + 隧道 + 配对码
c2c sandbox-allow   # 把本地设置目录加入 Codex 沙箱白名单（macOS / Windows）
c2c status / doctor / pair / unpair / logs / stop
```

环境要求：Node.js >= 22、git；公网连接需要 `cloudflared`
（自动检测，Skill 会替你安装）。

文档：[架构](docs/architecture.md) · [协议](docs/protocol.md) ·
[安全](docs/security.md) · [故障排查](docs/troubleshooting.md)

## 目录结构

```
src/
  bridge/     本机回环 HTTP 服务、端口自动恢复、管理 API
  mcp/        9 个读/审查工具 + 4 个任务/队列工具、无状态 HTTP
  auth/       OAuth 2.1（PKCE、动态注册、refresh 轮换、吊销）
  pairing/    一次性配对码（CSPRNG、TTL、限速）
  workspace/  稳定注册表 id、路径收敛、敏感文件策略、搜索、git
  tunnel/     TunnelProvider 抽象 + Cloudflare Quick Tunnel
  execution/  App Server 适配器、任务状态和审查闭环记录
  process/    守护进程生命周期
  cli/        c2c 命令行
skill/        Codex Skill（真正的 UX 层）
tests/        单元 + 集成测试
docs/         架构 / 协议 / 安全 / 故障排查
```

## 公开基础设施边界

本仓库仅提供开源源代码、架构设计与通用的隧道集成支持，**不提供**维护者个人的网站、域名、隧道、Cloudflare 账号、隧道 ID、证书、OAuth 状态、运行时状态、服务端点或任何凭据。每位使用者需自行配置自己的隧道/域名或使用本地免隧道模式（`--no-tunnel`）。

## 开源致谢与上游声明

本项目基于 [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)（遵循 MIT 许可证），并包含当前的多 Agent 协作与扩展。上游代码著作权归原作者所有，本项目严格遵循 MIT 许可证相关条款。

## 状态与声明

Bootstrap 升级已端到端验证：Bridge、OAuth + 配对、公网隧道、同一 ChatGPT
连接器选择多个已授权工作区、会话跨重启续接，以及 full-access 执行器。full-access
是有意选择的权限模型：持有该 connector 执行权限的人可以让本地 Codex 使用 bridge
进程在操作系统层面拥有的权限。

**非官方社区项目，与 OpenAI 无关联，未获其背书。**

## 许可证

[MIT](LICENSE)
