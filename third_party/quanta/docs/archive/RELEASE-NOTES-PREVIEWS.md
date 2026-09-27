# Windows preview 0.3.0.16

The main panel scrollbar is now 11 pixels wide for easier grabbing; card scrollbars remain 8 pixels wide. Both keep the dark styling and blue hover highlight.

The large panel’s outer scrollbar now uses the same slim dark styling as the card scrollbars.

Scrollable detail cards now use a slim rounded slate scrollbar with a transparent track and blue hover highlight. This replaces the default white scrollbar on overflowing cards such as Antigravity.

The tray popup is now a Windows tool window, set before it first appears, so opening it does not add a taskbar button. Focus, dismissal and repeated reopening remain covered by the native regression checks.

DeepSeek balance amounts in the compact flyout now use bold white text, matching the foreground colour of remaining-percentage values.

The connection editor uses Quanta’s app icon and opens at a slimmer 400-pixel width. Auto start uses a plain label without a cross or tick; its blue background indicates enabled state.

Frozen detail/editor subprocesses now use independent extraction directories so they can outlive the tray without sharing files removed during its shutdown.

Blue flyout buttons indicate enabled settings only: Auto start is blue when enabled. Refresh and other momentary actions use a neutral background.

The connection editor now uses a Mac-inspired red/green/neutral status block with a concise monospaced status label. Extra service, host, mode and state detail lines have been removed. Only a successful test-and-save turns it green; saved-but-unverified connections remain neutral. Technical text is built from fixed values and contains no key or raw response.

All detail cards, including Connections and sources, now share 360 × 300 pixel dimensions, padding and border styling. Extra content scrolls inside its card. Window resizing only rearranges the fixed-size cards.

Connections and sources now participates in the same fixed-width card grid. Detail text selection/copy is enabled. The native key input has explicit Ctrl+A/C/X/V, Insert-key alternatives and a right-click editing menu; it only accesses the clipboard in response to the user choosing an edit action.

Removed the native detail menu strip, made Add connection a small secondary button, and fixed source cards at 360 pixels. Window resizing changes column count rather than stretching cards.

The detail page now has a prominent Add connection button and shows all five supported sources. The only page-to-native action opens the native editor, bound to this local window and its action token; keys never enter HTML. The floating refresh track is invisible when idle.

Narrower 360-pixel floating panel, tighter controls, and no duplicate quota percentage heading.

Eight selected Windows ports implemented locally. Native connection editor and Credential Manager replace the Mac-specific connection/Keychain implementation. Stale/error display, compact account privacy, dynamic legends, refresh feedback and Chinese/English resources are wired into Windows. The graphical details window uses a native menu for connections; no credential-handling web bridge is exposed.

Python 3.12.14 was used because the Python 3.14 installer was blocked by automatic approval review. The pinned package versions remain unchanged; Python license/inventory reflects the actual build. This candidate remains unsigned. Live GLM/DeepSeek key validation, login startup, network disruption and additional monitor/DPI combinations require separate acceptance. Existing RC4 is retained.

---

# Quanta 0.2.0-rc.4 Windows 发布候选

RC4 修复 Codex 升级套餐后把周额度标成 5h 的问题。窗口名称现在来自官方返回的时长（300 分钟为 5h、10080 分钟为周），不再把 primary/secondary 位置当作固定周期，也不按套餐硬编码。只有周窗口时仅显示周额度；未知时长明确标为未知。托盘、卡片、详情、重置时间与历史记录共用同一解释，显示已返回的套餐类型。旧或未核验的卡片读数不再冒充当前配额，不在不同周期的账号之间作切换建议。

接口语义依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt)，并经本机账号只读实时回包核对。没有调用登录修改、用量重置或模型生成。

RC3 修复托盘浮窗切换到其他窗口后仍置顶的问题。浮窗会在失去前台状态后自动收起，同时清除图例；内部按钮与图例切换焦点不会误收起，之后可以正常重新打开。真实 Windows 窗口测试及冻结 EXE 验收覆盖该行为。

RC2 审查了 GLM 的 Muse 颜色调整：本地消息计数始终使用紫色，不推断官方额度已耗尽；浮窗同时移除未经证实的“/10”上限。恢复意外删除的 pystray 随附源码，新增构建时的第三方许可及源码清单校验，缺失或变更会阻止打包。测试凭证的重命名保留原有错误信息脱敏断言。

Windows 构建现要求仅安装锁定依赖的干净虚拟环境，阻止额外审计工具的可选模块混入 EXE。

分发形式：Windows x64 便携版，无需安装 Python。此包未做 Authenticode 数字签名。

本版完成托盘卡片浮窗、直接点击打开、图例点击开关、按钮布局与显示器定位修复，修正启动崩溃和鼠标回调异常。

安全修复包括认证请求拒绝跳转、网络响应及 API 并发限制、保留损坏配置、看门狗线程与服务恢复修复。新增真实 EXE 启动、鉴权、单实例、Tk / WebView 渲染和生命周期验收。

发布资料新增隐私说明、第三方许可、依赖版本清单、可重建源码及升级/卸载步骤。应用自己的代码使用 MIT 许可，依赖继续使用各自许可。

适用范围为 Windows x64。本次 Windows 主机和独立测试目录通过的结果见 RELEASE-STATUS.json；不将 macOS 源码检查、另一台设备或独立干净系统视为已验收。

正式公开发布前，发行者需完成代码签名、在独立干净 Windows 设备上确认首次启动/托盘实体点击/关闭/自启，并选定公开下载和问题反馈渠道。不要绕过系统安全提示，也不要把测试结果写成厂商计费准确性的保证。
