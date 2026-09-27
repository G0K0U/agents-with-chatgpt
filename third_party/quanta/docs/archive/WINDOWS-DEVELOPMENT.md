# Quanta

## Windows preview 0.3.0 — local candidate

This branch implements the eight selected Windows improvements: fail-closed stale/error display, native GLM/DeepSeek connection settings, Windows Credential Manager, Chinese/English presentation, compact adaptive cards, identity-free compact titles, refresh progress with duplicate-action prevention, and detected-source legends.

Use **连接 / Connect** in the flyout or the prominent **添加连接 / Add connection** button on the detail page. The detail page lists all five supported sources: GLM/DeepSeek use the native editor, while Codex/Muse/Antigravity use existing local detection. A narrowly scoped, window-bound action opens the native editor; it never reads or saves keys through the page. The detail page has no extra native menu strip. Its 360-pixel cards rearrange into columns as the window changes width. Choose GLM Z.ai/BigModel or DeepSeek, open the fixed official key page, and enter your own key locally. The editor queries only the existing usage/balance API and saves after successful validation. It never displays a saved key. Old plaintext configuration is preserved, not migrated. A non-secret notification reloads the tray after a successful save.

Refresh and Rescan keep the flyout open, disable duplicate actions while busy, show progress and completion/failure, and stop animation after 90 seconds if a request remains outstanding. The unknown state replaces old quota bars after failure. Closing details keeps the tray alive; startup remains optional.

This candidate uses **Python 3.12.14 x64**, the existing local runtime, with the same pinned 20 packages. The Python 3.14 installer was blocked by automatic approval review. Its license inventory has been updated to the actual runtime. This is a documented departure from the original RC4 build recipe below. It remains an unsigned local preview, not a clean-machine or macOS-certified release. No Mac-only implementation was merged.

`QUANTA_UI_LANGUAGE=zh` or `en` selects a process-local preview; it does not change Windows preferences. `--show-flyout` opens the compact view at startup for inspection. `AIBAR_DATA_DIR` isolates test configuration, ports and Quanta test credential names; never set it to an existing personal data directory for tests.

RC4 is retained separately for rollback. The older sections below document the baseline procedure and original selection. No push, merge or release upload is implied by this local candidate.


**AI 用量，一眼掌握。**

原名 AI Quota Bar，继续沿用 `~/.aibar` 中的现有配置与历史数据。
Formerly AI Quota Bar; existing configuration and history stay in `~/.aibar`.

本地 AI 订阅额度总览：Windows 托盘 + macOS 菜单栏 + 详情面板。
Local AI subscription overview: Windows tray + macOS menu bar + detail panel.

<a id="windows-port"></a>

## 新 Windows 上的选择性移植：已确认范围

**用户已选择下列八项全部移植，不需要再次逐项确认。** 这是后续 Windows 开发任务的范围说明，不表示功能已经实现或验收通过。仅做原包验收时，直接执行后面的“独立设备验收”；用户要求按本节移植时，执行这里的开发流程。

参考 [Mac PR #1](https://github.com/SparklingAstronaut/quanta/pull/1)，本次审阅的源提交为 `fef36e7c03b1ed9be7ea8ec51f6bf0494e0b5ae7`，分支 `feat/macos-native-ui`。后续新增的 Mac 改动不自动纳入范围。**从 Windows/main 基线建立独立开发分支，按功能移植，不整体合并 Mac 分支。**

| 已选项目 | Windows 要实现的行为 | 实施与验收要点 |
|---|---|---|
| 1. 旧数据 / 失败状态处理 | 旧或失败的配额与余额不冒充当前数据；刷新失败有明确反馈 | 覆盖 Codex、GLM、Antigravity、DeepSeek，保持余额/活动计数与额度区别；恢复刷新后重新显示可信数据 |
| 2. 连接设置界面 | 在应用中添加 GLM、DeepSeek，选择 GLM 区域、打开官方密钥页、测试并保存 | 验证通过才替换连接，失败保留原连接；使用已有只读用量/余额接口，不调用模型；用户自行登录和输入密钥 |
| 3. Windows 系统凭据存储 | 新保存的服务密钥由 Windows 的用户级系统凭据机制保护 | 采用 Credential Manager 或适当的用户级 DPAPI 方案；仅访问 Quanta 自己的条目，不枚举其他应用凭据；不把密钥回显给页面或写入日志；兼容旧配置，不擅自删除旧明文凭据，不宣称旧凭据已自动安全迁移 |
| 4. 中英文支持 | 按系统首选语言显示中文或英文，覆盖浮窗、菜单、详情、连接设置与动态状态 | 复用翻译资源并接入 Windows 界面；文本文件明确使用 UTF-8；保留仅进程内的语言预览，不更改系统语言；不翻译凭证或数据内容 |
| 5. 浮窗布局 | 借鉴 Mac 紧凑卡片、信息层级、操作区、滚动和自适应高度 | 在 Windows 现有界面上适配；保留托盘左/右键、失焦自动收起、重开、图例与内部焦点行为；验证缩放和多显示器，不直接搬 AppKit/WebKit |
| 6. 隐藏账号标识 | 紧凑浮窗不显示邮箱或原始账号 ID，保留来源、套餐等必要信息 | 多账号可使用不含身份信息的别名区分，仍清楚标识当前/建议账号；不修改底层账号归属判断 |
| 7. 刷新动画 | 刷新期间显示进行中状态/动画，阻止重复触发，完成或失败后恢复操作 | 不阻塞界面，不无限旋转；错误可见；避免高频重绘造成持续 CPU 占用 |
| 8. 动态图例 | 按实际检测到的来源显示相关图例，例如未检测到 Muse 时隐藏紫色说明 | 刷新/重新检测后同步更新；保留未知、余额、本地活动与额度的不同含义 |

不移植 Mac 专属实现：AppKit/NSPopover、Dock 和刘海定位、Keychain 后端、⌘ 编辑菜单、launchctl 自启、Mac `.app` 构建。Windows 需要等价功能时使用 Windows 实现。保留既有自动检测、配额周期解释、配置、历史、自启及回退能力。

### 执行顺序：先基线，再移植，再验收

1. **先测原始 RC4。** 在安装开发依赖之前，按后文 Windows 清单运行原始 EXE，记录该设备能否直接启动、基本行为与性能。保留原包、哈希及原始失败记录。
2. **建立独立开发分支。** 从当前 Windows/main 基线开始，记录基线 commit 与 Mac 参考 commit。先检查两者后续变化；逐项移植上述八项，记录每项涉及的文件与测试。已确认范围内的常规实现不再逐项询问用户。
3. **完成安全与回归检查。** 重点覆盖新凭据验证失败不覆盖旧连接、错误脱敏、界面输入与原生动作边界、账号归属、周额度不被标成 5h、过期状态、双语和托盘自动收起。若采用网页承载连接设置，落实本地内容限制及原生调用来源/动作白名单；不得加载远程页面处理密钥。
4. **处理平台差异。** Mac 代码中的 `os.getuid()`、权限位断言、Keychain/AppKit 导入和相关测试不能直接在 Windows 使用；适配或明确平台跳过。不能将跳过计入通过。同步检查 Windows 构建资源是否包含新增翻译/界面文件，并更新相应构建输入与许可清单。
5. **构建新的候选版本。** 使用锁定的干净 Windows 构建环境，生成独立版本号与哈希，不覆盖 RC4 资产。完成源码测试、实际 EXE 界面与生命周期验收，并执行下面的同机性能比较。
6. **区分开发与干净安装环境。** 安装过 Python、SDK 或开发依赖的系统不能继续宣称完全干净。新普通用户只隔离用户配置，不隔离系统级依赖；完全干净的依赖验收需要保留的开发前系统环境或另一独立环境。环境不可用就明确未测，不要求用户为此重装系统，也不虚构替代结果。
7. **回原 Windows 验证升级。** 在用户可操作的时间，检查已有配置、账号、历史、自启和托盘行为，保留旧版供回退；暂时无法访问原设备则标为待验收。
8. **交付范围清单与证据。** 给出八项完成状态、新版本/commit/哈希、测试结果、性能差异、失败与未测项。只在用户要求时推送、合并或发布；不因测试通过自动取消未签名/prerelease 状态。

### 同一台 Windows 上的新旧版本性能比较

使用 RC4 与新候选 EXE 比较，不用源码运行代替打包版。一次只运行一个版本，保持相同电源模式、屏幕设置、数据源和近似网络条件，记录测量工具与方法。不要为了性能测试修改或重置真实额度。

| 指标 | 测量口径 |
|---|---|
| 首次启动 | 单独记录首次解压后从启动到托盘可交互、首次数据完成的时间；首次扫描/系统拦截另记 |
| 后续启动 | 正常退出再启动，两个版本各测至少 5 次；报告中位数与范围，不把后续启动叫冷启动 |
| 内存 | 空闲稳定后、浮窗打开、详情打开分别采样；汇总相关主进程和子进程，注明是否包含 WebView 子进程及使用的内存指标 |
| 空闲 CPU | 启动稳定后观察至少 60 秒，记录平均值及峰值；刷新发生时另列，不混入空闲数据 |
| 刷新耗时 | 从点击到成功/失败反馈各测至少 5 次；记录网络/API 影响，不把厂商延迟都归因于 UI |
| 界面响应 | 浮窗打开、收起、重开和详情打开各观察至少 5 次；区分首次与后续响应，记录卡顿/不响应 |

为新旧版本使用相同测量方法，保留单次记录再汇总绝对差与百分比变化；基线为零或无效时不计算百分比。人工计时注明近似，不编造毫秒精度。明显回退需要复测并解释；没有预先约定的性能目标，不自行写成“性能验收全部通过”。

除后文通用验收报告外，追加：八项移植状态、开发基线/候选版本、性能测量条件、两版原始数据与汇总、干净安装环境是否真实可用、原 Windows 升级检查结果。不能只报告通过次数而省略失败或平台跳过。

可交给新 Windows 上 AI 的任务指令：

> 阅读 README“新 Windows 上的选择性移植”和“独立设备验收”。八项功能均已选择，请先完成原 RC4 的基线记录，再在独立分支逐项移植、回归、打包和同机性能比较。不要整体合并 Mac 分支或带入 Mac 专属实现。保护现有账号配置，真实记录失败与未测环境，交付候选版本及脱敏报告；没有明确上传/发布要求时保持本地。

<a id="device-acceptance"></a>

## 交给另一台设备上的 AI：独立设备验收

**先读本节再执行。Windows 验收已发布的 EXE；macOS 验收源码运行版。当前没有 Mac `.app` / `.dmg`。**
RC4 是未签名预发布版。测试通过与代码签名是两件独立的事；一台设备通过，只证明记录中的系统、硬件和版本通过。

用户可以直接给另一台设备上的 AI 这段指令：

> 阅读本 README 的“独立设备验收”部分，识别当前系统，按对应步骤验收 Quanta RC4。
> 先确认下载版本和设备环境，再执行测试，最后按结果模板记录通过、失败、未测和不适用项。
> 保留已有配置，不泄露凭证，不关闭系统安全功能，不替我注销或重启。
> 如果你不能操作真实 GUI，就完成可执行的检查，并明确列出需要我点击的项目；不要用单元测试代替 GUI 验收。
> 先记录原版本的失败证据；如需修改代码，区分原版本验收与修复后的复测，不把修复结果算到原发布包上。

### 0. 通用准备与操作边界

1. 在另一台真实设备上运行。记录测试日期、Windows/macOS 版本、CPU 架构（Windows x64/ARM64、Mac Apple Silicon/Intel）、屏幕缩放、多显示器情况和 Python 版本（仅源码测试需要）。不同系统的结果分别记录。
2. 登录有权限的 GitHub 账号，从 [RC4 发布页](https://github.com/SparklingAstronaut/quanta/releases/tag/v0.2.0-rc.4) 获取软件。私有仓库访问失败时说明缺少权限；不要改成公开仓库。
3. 先确认是否已有 Quanta 正在运行及 `~/.aibar` 配置。已有安装按下方“升级”说明保留回退副本；不要覆盖配置，不要复制开发机器的账号数据来伪造首次启动。
4. 首次安装与已有配置升级分别记录。需要首次安装证据时使用没有装过 Quanta 的设备或新的普通用户；不要为制造“干净环境”删除已有 `.aibar`。
5. 不使用管理员/root 权限启动 Quanta，不关闭杀毒、防火墙、SmartScreen 或 Gatekeeper，不移除隔离属性来绕过拦截。遇到系统阻止运行，记录提示并将后续启动项标为阻塞。
6. 凭证只在本机配置。不要把 `config.json`、`auth.json`、完整快照、`.aibar`、账号邮箱、token 或原始 AI 对话发送给云端 AI、提交 Git 或附到 issue。截图和错误摘录先脱敏。
7. 不主动调用付费模型、消耗额度或重置用量来制造测试数据。使用已有账号和正常使用后的读数。没有某服务的账号时，记录该服务未测；未知/未配置不算功能失败。
8. 自启测试会改变当前用户登录启动项；先记录原状态。注销/重启、切断当前远程连接的网络测试由用户在方便时执行。测试完成后按用户意愿恢复原状态。
9. 不自动推送代码、上传报告、发布新版本或购买签名服务。报告先保存在本机；用户要求同步时只同步脱敏内容。

### 1. Windows：验收原始 RC4 便携包

1. 下载发布页 Assets 中的 `Quanta-0.2.0-rc.4-Windows-x64-portable.zip` 和同名 `.sha256`。**不要用 GitHub 自动生成的 Source code ZIP 代替 EXE 包。** 当前包目标是 Windows x64；Windows ARM64 的兼容运行应单独记录，不能冒充原生 ARM64 支持。
2. 在 PowerShell 进入下载目录，检查 ZIP：

   ```powershell
   Get-FileHash -LiteralPath '.\Quanta-0.2.0-rc.4-Windows-x64-portable.zip' -Algorithm SHA256
   ```

   RC4 预期 SHA-256：`f2e096fd8effaa00209b716e8de7249dc518ccb2323cfb81f04ffb9ed324213b`。若不一致，停止运行并报告；此值仅适用于该 RC4 资产。
3. 完整解压到固定、本人可写的文件夹。运行 `Verify.cmd`，记录是否显示 `PASS`。哈希证明文件一致性，不能替代发行者签名。
4. 双击 `Quanta.exe`。无需安装 Python。到任务栏隐藏图标区域寻找 Q 图标，然后逐项测试：

| 编号 | 操作 | 通过条件 |
|---|---|---|
| W1 | 首次启动 | 托盘出现 Q，无崩溃；缺少数据源时有合理提示 |
| W2 | 单击、右键 Q；点击其他应用；再次打开，重复 3 次 | 浮窗出现，切换应用后自动收起，能够重开 |
| W3 | 点击图例、内部按钮 | 图例正常开关，内部操作不会误收起；切换其他应用时图例随浮窗消失 |
| W4 | 点击刷新，等待完成 | 不持续卡在刷新中；完成时间更新；接口失败有提示 |
| W5 | 打开详情，关闭详情 | 面板内容可见；关闭后托盘仍运行；记录 WebView 或文字回退模式 |
| W6 | 托盘已运行时再双击 EXE | 原实例继续工作，无第二个常驻实例或端口冲突 |
| W7 | 在可用屏幕、实际缩放比例下打开浮窗和面板 | 内容及按钮可见、可点击，无出屏或明显截断；未测试的 DPI/显示器组合明确标记 |
| W8 | 开启自启，用户注销并重新登录；再关闭自启并重复 | 开启时自动启动，关闭后不自动启动；记录并恢复原状态 |
| W9 | 用户允许时断网刷新，然后恢复网络再刷新 | 不崩溃；无数据时明确未知/失败，缓存显示遵循其新鲜度；恢复后可刷新。无联网数据源时该项标为不适用 |
| W10 | 点击退出，然后重新启动 | 托盘退出；重新启动正常，已有配置保留 |

启动时若旧版本已运行，先通过其菜单退出。不得为了处理端口占用批量结束其他 Python 或 AI 工具进程。

### 2. macOS：验收源码运行版

Mac 无法直接运行上述 Windows EXE。登录后在 [仓库](https://github.com/SparklingAstronaut/quanta) 选择 **Code → Download ZIP**，或使用已有 Git 登录克隆仓库。解压到固定文件夹，记录源码 commit；ZIP 下载没有 Git 元数据时，从 GitHub 页面记录对应 commit。

确认 `python3 --version` 为 3.10 或更新版本，且当前目录含 `requirements.txt` 与 `aibar/`。缺少 Python 时先说明前置条件；安装失败时记录实际 Python/macOS 版本与脱敏错误，不默默换依赖版本后宣称原版本通过。

在该目录的终端逐条执行，任一步失败就停止后续步骤：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m aibar.ui_mac
```

使用新下载的源码目录，避免覆盖其他工作的 `.venv`。依赖安装会联网，只安装到项目虚拟环境。先保持终端打开，完成手动运行验收；不要同时运行安装脚本启动第二个实例。

| 编号 | 操作 | 通过条件 |
|---|---|---|
| M1 | 手动启动 | 顶部菜单栏出现 Quanta/Q，终端无导致退出的异常 |
| M2 | 打开菜单，点击菜单外，再次打开 | 原生菜单正常开关；Mac 不要求与 Windows 浮窗外观相同 |
| M3 | 立即刷新，打开详情，再关闭详情 | 刷新完成或明确报错；面板能打开；关闭面板后菜单栏仍运行 |
| M4 | 应用已运行时从另一个终端执行同一启动命令 | 第二个实例退出，原实例继续工作 |
| M5 | 退出，再手动启动 | 能正常结束并重新启动，保留配置 |
| M6 | 用户允许时断网刷新，再恢复网络 | 不崩溃，失败/缓存状态合理，联网后可恢复；无联网数据源时标为不适用 |
| M7 | 按下面步骤安装登录自启，再由用户注销/登录 | 自动出现菜单栏图标，刷新与详情正常 |

手动验收通过后，先在菜单中退出 Quanta，再运行：

```bash
bash install_mac.command
```

这会安装依赖、初始化或复用 `~/.aibar/config.json`，创建当前用户的 `~/Library/LaunchAgents/com.aibar.tray.plist`，并立即启动应用。不是单纯的依赖安装命令。原有 plist 若存在会先备份。

如果本次是新安装且测试后不保留自启，可以在确认目标确实是本次 Quanta 服务后运行：

```bash
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.aibar.tray.plist"
```

该命令卸载当前服务，但不会删除 plist；要取消以后登录时的自启，还需把这个确切的 plist 移到本机备份目录。已有安装则恢复之前的 plist/启动状态。不要删除整个 LaunchAgents 或 `.aibar` 目录。

更细的 Mac/双机检查见 [MAC-VALIDATION.md](docs/MAC-VALIDATION.md)。双机同步是可选的独立测试，不是单机首次启动的前置条件；本轮不自动添加 peer 或修改网络配置。

### 3. 两个平台都要核对：账号与额度含义

- 使用设备上已经登录的账号；需要登录时让用户自行完成。确认 Quanta 与官方页面显示的是同一账号，刷新后对照并记录比较时间。
- **根据返回的时长识别窗口，不根据 Plus/Pro 名称或 primary/secondary 顺序推断。** 300 分钟对应 5h，10080 分钟对应周；只有周窗口就只显示周额度，缺少 5h 不表示无限额度。
- 应用显示剩余百分比，接口可能显示已用百分比，两者应满足 `剩余 = 100 − 已用`。允许刷新时间差与显示舍入，明显不一致必须记录，不能自行改读数凑一致。
- 同时核对套餐显示、重置时间和周期。`prolite` 是可能返回的原始类型；不要把某次测试账号的百分比写成所有用户的固定期望。
- 有 Plus 和 Pro 账号时分别测试；只有一种就明确另一种未测，不要求购买套餐。周耗尽、未知窗口、旧快照等单元测试覆盖不能冒充真实账号实测。
- GLM/Antigravity 的额度、DeepSeek 余额、Muse 本地活动计数分别验证；不能互相换算。缺少平台或账号就标记未测/不适用。

### 4. 可选源码回归与失败处理

GUI 手动验收是必须单独记录的证据。源码回归可以补充，但 Windows EXE 验收不要求安装 Python，Mac 跳过 Windows 专属测试也不等于 Windows 已通过。

如运行源码测试，应在单独终端设置 `AIBAR_DATA_DIR` 指向项目 `work/` 下新建的空测试目录，再执行：

```text
python -B -m unittest discover -s tests
```

这里的 `python` 指对应项目虚拟环境中的解释器。测试目录不得指向已有个人 `.aibar`；测试结束关闭该终端，正常启动/自启不继承测试数据目录。记录测试数量、失败、错误和跳过数量。

失败时保留版本、操作步骤、预期/实际结果、脱敏错误和截图。GUI 测试期间避免其他自动化抢焦点；首次失败和重试结果都要记录。不能只保留成功的一次。无法启动、缺少硬件、没有 GUI 控制权限或被系统拦截时，明确阻塞项。

### 5. 验收结果模板：由执行测试的 AI 填写

把下面模板存到本机 `work/acceptance-<系统>-<日期>.md`。`work/` 已被 Git 忽略；报告不要包含凭证、设备序列号、个人邮箱或完整用户目录。截图使用脱敏后的相对文件名。

```text
Quanta 独立设备验收
日期与时区：
设备：Windows/macOS 版本；CPU 架构；缩放/显示器情况（不写序列号）
安装场景：首次安装 / 已有配置升级
版本与来源：RC4 资产名称、ZIP SHA-256；Mac/源码测试填写 commit
Python 与依赖安装结果（仅源码测试）：
原有 Quanta / 自启状态：

逐项结果（Windows W1–W10 或 Mac M1–M7，每项都填写）：
编号 | 通过/失败/未测/不适用 | 实际观察 | 脱敏证据

额度对照：平台、套餐类型、周期、剩余/已用口径、比较时间；不写账号标识
源码测试（如运行）：总数、失败、错误、跳过、测试数据隔离位置
问题复现：步骤、期望、实际结果、首次失败及重试结果
修改记录：是否改源码/依赖/配置；改过则列出修复版本和复测范围
收尾：退出/保留运行；自启恢复情况；未完成的清理
结论：此设备上的哪些项目通过；剩余失败/阻塞/未测项目
签名状态：如实填写，不根据测试通过推断已签名
```

### 6. 签名与正式发布：单独处理

- Windows 正式签名需要发行者代码签名证书或签名服务，通过 [SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool) 等工具签名并加时间戳。签名会改变 EXE 哈希，之后必须更新校验清单、重新打包并验证实际签名包。
- Mac 若要发布可直接打开的独立应用，还需制作 `.app`，进行 [Developer ID 签名和 Apple 公证](https://developer.apple.com/developer-id/)。源码运行通过不等于这些工作已完成。
- 本节授权范围是设备验收。测试 AI 不应购买证书、申请开发者账号、收集签名私钥或擅自去掉 prerelease 标记。最终发布状态应依据汇总后的实际证据更新。

## 功能 | Features

- 五个来源：Codex、GLM、DeepSeek、Muse、Antigravity。
  Five sources: Codex, GLM, DeepSeek, Muse, Antigravity.
- 口径：剩余百分比按“100 − 已用”显示；Muse 托盘中央数字是过去 5 小时
  本地用户消息数（计数制，非官方百分比），Windows 现在显示在 Q 图标角标内；Antigravity 显示四个配额窗口
  （两个分组 × 5 小时/周）加本地会话计数。
  Semantics: remaining percent is "100 − used". The Muse tray number is the
  local user-message count in the last 5 hours, now in the Q icon badge on Windows (count-based, not an official
  percent). Antigravity shows four quota windows (two groups × 5h/week) plus
  local conversation counts.
- 交互刷新：Windows 单击或右键托盘直接打开浮窗，再选“刷新”；原生菜单回退模式可双击刷新；
  刷新期间提示“刷新中…”，完成后显示完成时间与“上次刷新”行。
  Interactive refresh: click or right-click the Windows tray icon to open the flyout
  or choose Refresh Now. The flyout provides refresh, panel, detection, autostart, click-toggle legend and quit actions. The tooltip shows a refreshing state, then the
  completion time plus a last-refresh row.
- 无法显示时给出具体原因：Antigravity IDE 未运行（仅本地计数）/
  WSL 未运行 / 未配置 token / 近 8 天无快照 /
  该来源本就无百分比（DeepSeek 余额制、Muse 计数制）。
  When a source cannot display, it states the reason: Antigravity IDE not
  running (local counts only) / WSL not running / token not configured /
  no snapshot in ~8 days / source has no percent by design (DeepSeek is
  balance-based, Muse is count-based).
- 详情面板：托盘菜单“打开面板”，按检测结果显示数据源卡片（当前数值、重置倒计时、
  上次刷新时间、数据来源说明）加顶部汇总灯与近 7 天迷你趋势；
  关闭详情窗口结束该面板，托盘常驻。
  Detail panel: "Open Panel" in the tray menu. Detected source cards (current value,
  reset countdown, last refresh, data-source note) plus a top summary light
  and 7-day mini trends. Closing the detail window ends that panel process; the tray stays running.
- 颜色：绿剩 >50% · 黄剩 >20–50% · 红剩 ≤20% · 灰旧/未知 · 蓝余额。
  Colours: green >50% left · amber 20–50% · red ≤20% · grey stale/unknown ·
  blue balance.

## 安装 | Install

需要 Python 3.10+。依赖只装进项目内 `.venv`，不做全局安装。
Requires Python 3.10+. Dependencies go into the project-local `.venv` only.

Windows（在项目目录运行）：

```bat
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m aibar.ui_windows
```

开机自启（二选一）：`python -m aibar.autostart_windows on`（注册表 HKCU Run），
或把 `start_hidden.vbs` 放进启动文件夹（需按文件内注释改 `PYTHONW` 路径）。
打包 exe（Windows x64、Python 3.14）：使用专门的干净 `.venv`，安装
`requirements-windows-build.txt` 中的锁定依赖后，再运行
`.venv\Scripts\python build_windows.py`，产物为 `dist\Quanta.exe`
（无控制台，含图标；`dist/` 不入库）。
For the Windows EXE, use Python 3.14 x64 and a clean virtual environment with
only `requirements-windows-build.txt` installed. Extra packages or mismatched
versions stop the build to keep bundled components consistent with the inventory.

macOS（先把解压后的 `ai-quota-bar` 文件夹移到固定位置，再运行）：

```bash
bash install_mac.command   # 建 .venv、装依赖、写默认配置、装 launch agent
bash start_mac.command     # 手动启动
```

详情面板优先用 pywebview（已在 `requirements.txt` 中）；若所在机器无法
显示 webview，自动回退到 tkinter 标准库，不引入 Electron/Tauri。
The panel prefers pywebview (listed in `requirements.txt`) and falls back to
stock tkinter when webview is unavailable. No Electron/Tauri.

配置：首次运行自动生成 `~/.aibar/config.json`（含随机本地 API token），
对照 `config-example.json` 在本机填入各家 token（占位符 `YOUR_TOKEN_HERE`
处）。历史趋势存于本机 `~/.aibar/history.jsonl`（每次刷新追加一行）。
Configuration is generated at `~/.aibar/config.json` on first run (with a
random local API token). Fill in provider tokens locally following
`config-example.json` (`YOUR_TOKEN_HERE` placeholders). Trends are stored at
`~/.aibar/history.jsonl` (one line per refresh).

双机（可选）：两台机器先各自连好 Tailscale；把 `server.host` 设为本机的
Tailscale IPv4，并在对端以 `http://<peer-tailscale-ip>:8765` 加 peer
（token 走私密渠道）。回环与 `100.64.0.0/10` 之外一律拒绝，DNS/代理/
跳转一律不支持。
Two-machine (optional): bring up Tailscale on both, set `server.host` to this
machine's Tailscale IPv4, and add the peer as `http://<peer-tailscale-ip>:8765`
(exchange tokens privately). Only loopback and `100.64.0.0/10` are accepted;
DNS/proxy/redirects are rejected.

## 安全模型 | Security model

- 凭据只存用户本机 `~/.aibar`（`config.json` 权限建议仅本人可读写），
  仓库永不含密钥：`config-example.json` 仅含 `YOUR_TOKEN_HERE` 占位符，
  `private/`、`.venv/`、`dist/`、`*.zip` 均不入库。
  Credentials live only in the local `~/.aibar` on your machine
  (`config.json` should be owner-only). The repo never contains secrets:
  `config-example.json` carries only `YOUR_TOKEN_HERE` placeholders, and
  `private/`, `.venv/`, `dist/`, `*.zip` are never committed.
- 本机 API 默认只听回环，Tailscale 场景仅允许 `100.64.0.0/10`；
  peer 请求禁用代理与跳转，`/api/usage` 需 `X-Token` 且只读缓存快照。
  The local API listens on loopback by default (Tailscale range
  `100.64.0.0/10` only when configured). Peer fetches disable proxies and
  redirects; `/api/usage` requires `X-Token` and serves the cached snapshot.
- 面板只读现有 `collect/merge` 数据，不新建任何网络请求路径。
  The panel only reads the existing `collect/merge` view; no new network path.
- 示例路径一律用占位符，如 `C:\Users\<你的用户名>\ai-quota-bar` 与
  `/Users/<你的用户名>/ai-quota-bar`，请替换为你本机真实用户名。
  Example paths always use placeholders such as
  `C:\Users\<你的用户名>\ai-quota-bar` and `/Users/<你的用户名>/ai-quota-bar`.

## 故障排查 | Troubleshooting

- 一直“刷新中…”：看托盘 tooltip 与 `~/.aibar/runtime-status.json`
  的 `refresh_ok`/`error`；常见为某家接口超时，菜单对应行会写明失败原因。
  Stuck refreshing: check the tooltip and `refresh_ok`/`error` in
  `~/.aibar/runtime-status.json`. The failing source row states the cause.
- “未配置 token”：按 `config-example.json` 在本机 `config.json` 填入后重启。
  "Token not configured": fill it in the local `config.json` and restart.
- “近 8 天无快照”（Codex）：近 8 天无可用日志或未登录，登录后刷新。
  "No snapshot in ~8 days" (Codex): log in and refresh.
- “WSL 未运行”（Muse）：Muse 日志在 WSL 内，启动对应发行版并使用后计数。
  "WSL not running" (Muse): logs live inside WSL; start it and use Muse.
- “IDE 未运行，仅显示本地计数”（Antigravity）：启动 Antigravity 后配额
  经本机语言服务器读取；关闭时只有本地会话计数。
  "IDE not running, local counts only" (Antigravity): start the IDE so quota
  can be read from the local language server.
- “余额制/计数制，本就无百分比”不是故障：DeepSeek 显示余额，Muse
  显示本地计数，不换算官方百分比。
  "Balance/count-based, no percent by design" is not an error: DeepSeek shows
  balance, Muse shows local counts, never an inferred official percent.
- 面板打不开：Windows/macOS 本机先确认托盘在运行，再点“打开面板”；
  若 webview 后端缺失会自动用 tkinter 文本版。
  Panel won't open: confirm the tray is running, then choose Open Panel.
  A tkinter text fallback is used when the webview backend is missing.
- 回归测试（沙箱/本机均可）：`.venv/bin/python -B -m unittest discover -s tests`
 （Windows 用 `.venv\Scripts\python` 同命令）。
  Regression tests: `.venv/bin/python -B -m unittest discover -s tests`.

## 当前验证边界 | Verification boundary

Windows 回归覆盖账号歧义、周耗尽、过期/旧快照、滚动计数、去重、跨机求和、
失败可见性、原子写、采集序列化、回环鉴权与独立菜单行；不模拟厂商计费后台，
macOS 真机与双机仍需按 `docs/MAC-VALIDATION.md` 手工验收。
Windows regressions cover account ambiguity, weekly exhaustion, expired/stale
snapshots, rolling counts, dedup, cross-machine sums, failure visibility,
atomic writes, collection serialization, loopback auth, and separate menu rows.
They do not simulate billing backends; macOS hardware and two-machine setups
still need the manual acceptance in `docs/MAC-VALIDATION.md`.

## 发布与审计 | Release and audit

审计工具与报告随源码分发：`tools/audit_scan.py`、`tools/release.py`、
`docs/SECURITY-AUDIT.md`。敏感字典仅在内存中存在。面板使用独立的短期
交换文件，读取后删除；临时文件不属于永久用量记录。系统异常终止时无法
保证清理执行。使用云端 AI 开发工具不等于没有云服务调用。

Audit tools and the report are included with source. Known sensitive values stay
in memory. Each panel uses its own short-lived exchange file, removed after read
and cleaned on process failure/exit; abrupt termination can prevent cleanup.
Cloud AI-assisted development must not be described as having no cloud calls.

构建后运行 `python tools/release.py build` 生成同步 Mac 源码包和哈希清单，
再运行 `python tools/release.py verify` 核对当前源码、ZIP 和各发布文件。
Run these commands after the Windows build to generate and verify the matching
Mac source ZIP and release checksums. Exact source revision and hashes are in
`SOURCE-MANIFEST.json` and `SHA256SUMS`, not handwritten in a report.

Windows 浮窗依赖 customtkinter；不可用时回退系统托盘菜单。测试工具通过 AIBAR_DATA_DIR 使用独立目录，正常使用无需设置。
