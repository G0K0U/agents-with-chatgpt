# macOS 原生版使用指南 | Native macOS guide

范围：RC4 之后的源码改动，仅原生 macOS 界面；Windows 托盘、EXE、构建依赖与原发布包不变。
原始 RC4 验收与此版本复测应分开记录。此源码分支不等于已发布、已公证的 Mac 安装包。

Scope: post-RC4 native macOS changes. Windows tray code, EXE build dependencies and
existing release assets are unchanged. Record original RC4 acceptance separately.
A source branch is not a notarized Mac binary release.

## 使用 | Use

- 点击菜单栏右侧小 Q，查看用量条、余额、活动计数、刷新与图例。右上角圆点表示总体额度状态。
- “面板”打开详细数据；关闭面板或按 ⌘W 后，菜单栏继续运行。“退出 Quanta”仅在浮窗中。
- 面板底部“添加链接”支持 GLM（Z.ai/BigModel）和 DeepSeek；未连接服务只显示一行提示。
- 连接窗口提供官方密钥页面链接。用户自行在默认浏览器登录、复制密钥，再回到密码框粘贴。
  支持 ⌘C、⌘V、⌘A 等标准编辑快捷键；不会自动查找浏览器密码或其他应用钥匙串。
- 点击测试并保存后，仅查询官方用量/余额；验证成功才存入本机钥匙串。失败保留原连接。
  绿色表示已连接，红色表示未连接或失败，等待验证显示中性状态。
- “可连接的服务”表示支持该服务，不表示已检测到账号。Codex/Muse/Antigravity 仍按原有本地检测规则工作。
- 系统首选语言为中文时使用中文（含 zh-Hans/zh-Hant）；其他语言使用英文。
  语言在启动时读取；无需改动系统语言来测试，开发者可仅在测试进程设置 `QUANTA_UI_LANGUAGE=en`。
- 未检测到本机 Muse 时不显示紫色图例。无进度条的状态/余额行使用紧凑字号。

Click Q to view usage, balances, activity, refresh controls and the colour guide.
Details opens the full panel; closing it keeps Quanta in the menu bar. Quit Quanta
is available only in the popover. Add connection is in the detail panel and supports
GLM (Z.ai/BigModel) and DeepSeek. Open the official API-key page, sign in yourself,
and paste your key back into the password field. Test and save validates read-only
usage/balance access before saving to the local Keychain. Failed attempts preserve
the previous connection. Chinese system preferences select Chinese; all other
languages select English on launch. Availability hints list supported services,
not detected accounts. Standard Mac editing shortcuts are supported.

## 启动与构建 | Run and build

源码调试仍需 Python；独立 `.app` 自带运行环境，安装后不依赖终端/Python 窗口。
已实测环境：Apple Silicon arm64、macOS 26.2、Python 3.12.13。
Intel Mac、旧版 macOS 与其他设备首次安装尚未验收，不宣称通用支持。

Source development requires Python. A built `.app` bundles its runtime and does not
need an open Terminal/Python window. Tested build environment: Apple Silicon arm64,
macOS 26.2, Python 3.12.13. Intel, older macOS and fresh installations on other devices
remain untested.

在新的源码目录创建专用环境；不要覆盖现有环境：
Create a dedicated environment in a new source checkout:

```sh
python3 -m venv .venv-mac
.venv-mac/bin/python -m pip install -r requirements-macos-build.txt
.venv-mac/bin/python -m aibar.ui_mac
```

构建独立应用（仅在 Mac 上运行；不要使用 Windows 构建脚本）：
Build the standalone app on a Mac:

```sh
.venv-mac/bin/python -m PyInstaller --noconfirm packaging/macos/Quanta.spec
codesign --verify --deep --strict dist/Quanta.app
```

产物为 `dist/Quanta.app`。此配方使用本地 ad-hoc 签名，不是 Developer ID 签名或 Apple 公证。
构建目录应在本机普通开发目录内，避免云盘/文件管理器为产物附加不兼容元数据。
签名检查失败时停止分发并检查构建日志；不要关闭 Gatekeeper 或移除下载隔离属性绕过系统提示。

Output: `dist/Quanta.app`. The recipe uses local ad-hoc signing, not Developer ID or
Apple notarization. Build in a local development directory without cloud-sync metadata.
Stop distribution if signature verification fails. Do not disable Gatekeeper or remove
quarantine attributes to bypass security prompts.

## 升级、配置与自启 | Upgrade, configuration and login startup

先通过浮窗退出旧 Quanta，保留旧应用副本，再把新应用放到固定的 `~/Applications/Quanta.app`
或 `/Applications/Quanta.app`。不要同时运行源码版和独立版。保留 `~/.aibar` 和钥匙串条目。
关闭详情窗口不退出；完全退出请使用浮窗“退出 Quanta”。

登录启动是可选功能，由浮窗开关控制，只管理当前用户的 `com.aibar.tray` 项；不会因手动退出而立即重启。
改变应用位置后重新开启自启以更新路径。旧安装器 `install_mac.command` 是源码安装/立即启动方案，
不要把它和独立应用方案叠加使用。实际注销/登录测试应由用户在方便时执行。

Quit the old app from its popover, keep a rollback copy, and install the new app at a
fixed location. Preserve `~/.aibar` and Keychain entries. Do not run source and bundled
instances together. Login startup is opt-in through the popover and does not respawn
a manually quit app. Re-enable it after moving the app. The legacy source installer
starts a separate source installation; do not combine it with the app-bundle setup.

新增密钥仅保存在本机钥匙串，运行时合并到内存；不会自动迁移或删除原配置文件中的凭证。
重新构建的 ad-hoc 应用可能触发钥匙串再次授权，系统拒绝/等待授权时连接不可用，某些系统上可能延迟启动。
只由用户确认可信 Quanta 的系统授权；不要授权未知程序，不修改钥匙串为“允许所有应用访问”。
对外分发前应使用稳定发行者签名并补做升级/钥匙串授权验收。

New keys are stored only in the local Keychain and overlaid in memory. Existing
configuration-file keys are neither migrated nor deleted. Rebuilt ad-hoc apps may
require renewed Keychain access; denied/pending access can leave connections unavailable
or delay startup on some systems. Only the user should approve a trusted Quanta prompt.
Do not grant access to all applications. Stable publisher signing and upgrade/Keychain
acceptance are required before general distribution.

## 安全与验证边界 | Security and verification boundary

WebKit 窗口使用非持久存储、本地内容限制和受限消息入口；不载入远端页面来处理密钥。
官方密钥网页只在默认浏览器打开。连接测试不发起模型生成、充值或额度重置。
认证本机 API 沿用原有地址与令牌规则，不对外开放新端口。

WebKit uses ephemeral storage, local content restrictions and a restricted native bridge.
Official key pages open in the default browser. Connection tests perform no generation,
purchase or quota reset. Existing local API binding/authentication rules remain in place.

原始 RC4 在本次 Mac 上出现菜单栏 Q 被刘海区域遮挡的失败；后续修复不算原包通过。
原生版已进行本机 GUI 检查；自动化回归只能补充证据。Windows 真机、断网恢复、
注销后自启、Intel/其他 Mac 和首次安装仍须独立验收。安全复查摘要见
[MACOS-SECURITY-REVIEW.md](MACOS-SECURITY-REVIEW.md)。

Original RC4 failed menu-bar visibility on the tested notched Mac. Later fixes do not
change that original result. Native GUI checks and automated regressions are separate
evidence. Windows hardware, network recovery, login startup after a real login, Intel,
other Macs and clean installs still need independent acceptance.
