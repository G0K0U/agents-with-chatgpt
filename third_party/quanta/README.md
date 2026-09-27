# Quanta

> **A2C vendored source patch (0.9.4+a2c.1).** This directory is the complete
> MIT-licensed Quanta 0.9.4 release source plus the sampling-freshness changes
> described in [PATCH-INFO.md](PATCH-INFO.md). Build from this directory to
> obtain the patched version. Links below are retained upstream documentation
> and may require access to the upstream repository; their prebuilt v0.9.4
> downloads do **not** contain the A2C patch.

**AI usage at a glance. / AI 用量，一眼掌握。**

Quanta brings your AI quotas, balances and local activity into a Windows tray or macOS menu-bar app. It supports Codex, GLM, DeepSeek, Muse and Antigravity, with Chinese and English interfaces.

## Downloads

**[Download Windows installer](https://github.com/SparklingAstronaut/quanta/releases/download/v0.9.4/Quanta-0.9.4-Windows-x64-Setup.exe)** · **[Download Mac Apple Silicon ZIP](https://github.com/SparklingAstronaut/quanta/releases/download/v0.9.0/Quanta-0.9.0-macOS-arm64-layout6.zip)**

Click your platform to download directly. On Windows, open the downloaded installer, choose a folder, and install. Desktop and Start menu shortcuts are included. Sign in with repository access first. / 点击对应系统即可下载。Windows：打开安装程序、选择安装目录，即可创建桌面和开始菜单快捷方式；请先登录有仓库权限的 GitHub 账号。

[Windows v0.9.4 files and checksums](https://github.com/SparklingAstronaut/quanta/releases/tag/v0.9.4) · [Mac layout6 files and checksums](https://github.com/SparklingAstronaut/quanta/releases/tag/v0.9.0)

| Platform | Distribution | Start here |
| --- | --- | --- |
| Windows x64 — **v0.9.4** | Installer with folder selection, desktop and Start menu shortcuts | [Windows guide](docs/windows/README.md) |
| macOS Apple Silicon — **v0.9.0, build 9.6 (layout6)** | `Quanta-0.9.0-macOS-arm64-layout6.zip`; extract and move `Quanta.app` to Applications | [macOS guide](docs/macos/README.md) |

**Windows is an unsigned prerelease; Mac is an ad-hoc-signed prerelease.** Windows may show a publisher/reputation warning. The Mac download is ad-hoc signed, not a Developer ID signed or Apple-notarized download. GitHub hosting does not replace platform signing. The repository remains private; downloads require repository access.

Windows has been built and exercised on the development computer. The uploaded Mac app was reported tested on Apple Silicon/macOS 26.2; its ZIP checksum, executable architecture and bundle version were independently checked. Intel Macs and independent clean-device installation are not verified.

**Mac layout6 update:** All detail cards use the same 400×288px size. Original fonts, spacing and trend sizes are preserved. The standard height follows normal GLM content; AGY and other extra-long contents scroll internally instead of raising every card. Narrow windows shrink all card widths together. Build 9.6 includes the integrated Keychain safety fixes, protection immediately after saving a new connection, and Codex desktop discovery. Use the layout6 download; earlier Mac snapshots and fix1 remain historical. Native validation passed within the scope documented in [Mac package status](docs/macos/README.md). Independent device testing remains pending.

### Which source and version?

- **Windows v0.9.4:** built from the `v0.9.4` tag; use its versioned source ZIP and `SOURCE-MANIFEST.json`.
- **Mac layout6:** the app still identifies as 0.9.0, build 9.6. Use `Quanta-0.9.0-integrated-source-layout6.zip` from the Mac release. **`SOURCE-SHA256.json` is the current source record**, and is also included with the app.
- The Mac source ZIP's older `SOURCE-MANIFEST.json` describes the original v0.9.0 baseline; it does not describe layout6. It is retained as historical evidence. GitHub's automatic source ZIP for v0.9.0 is also the old baseline.
- Earlier Mac files without `layout6`, and `fix1`, are historical. Use the direct Mac button above for testing.

## Testing with friends

Share this README's direct platform downloads and [10-minute tester guide](docs/TESTING.md). Download the **Windows installer EXE** or **macOS arm64 ZIP**, not GitHub's automatically generated source-code ZIP. Neither app download needs Python.

This repository is private: friends must be invited as collaborators and signed in to download. A release link alone will not give them access. No visibility or access settings are changed automatically.

For Windows without installation, the [portable ZIP](https://github.com/SparklingAstronaut/quanta/releases/download/v0.9.4/Quanta-0.9.4-Windows-x64-portable.zip) remains available.

Windows is available for the checklist below; the layout6 Mac upload is available for the checklist with the native-validation limits above.

朋友测试：先获得仓库访问权限，再按系统下载应用 ZIP（不要下载 Source code）。参考[测试清单](docs/TESTING.md)，反馈系统版本、复现步骤和隐藏个人信息的截图。layout6 Mac 包已包含凭据修复，可按清单测试；独立设备验收待完成。

## What you can see

| Source | Information |
| --- | --- |
| Codex | Account-attributed quota windows and reset times when available |
| GLM | Official usage windows for Z.ai or BigModel |
| DeepSeek | Official API balance, shown as currency rather than a quota percentage |
| Muse | Local activity and token counts; not a subscription quota |
| Antigravity | Quotas from its local language service; local activity is kept distinct |

Click Q to open the compact view. Refresh updates the data; Details opens the larger panel. Add connection connects GLM or DeepSeek. Codex, Muse and Antigravity use local detection. Startup at login is optional. Closing a panel leaves Q running; use Quit in the popup to exit.

点击 Q 查看紧凑浮窗；“面板”打开详情，“连接”添加 GLM 或 DeepSeek。Codex、Muse 和 Antigravity 自动检测本机数据。自启可选，关闭面板不会退出，完全退出请使用浮窗中的“退出”。

## Connections and privacy

Enter your own API key in Quanta's connection editor. Test and save uses read-only usage/balance requests, with no model generation, purchase or quota reset. New keys use Windows Credential Manager or macOS Keychain. Existing plaintext configuration keys are preserved for compatibility; they are not automatically migrated or removed.

Quanta reads local service data and contacts configured official services. Its optional authenticated device API binds to loopback by default. Keep device tokens private. Do not put your configuration, keys or usage history into issues or commits. [Privacy details](docs/PRIVACY.md).

## Build and contribute

Use a dedicated environment and the lock file for your platform. Windows executables must be built on Windows; Mac apps must be built on macOS. [Development and release guide](docs/DEVELOPMENT.md).

```text
 aibar/                shared collectors and platform-specific UI modules
 assets/               icons, translations and local UI resources
 packaging/macos/      native Mac app build recipe
 docs/windows/         Windows setup
 docs/macos/           macOS setup
 docs/archive/         historical development and acceptance records
 tests/                regression and security checks
 tools/                audit, packaging and verification tools
```

Windows details use `aibar/panel.py`; native Mac details use `aibar/panel_mac.py` to preserve their separate UI contracts. Shared provider and configuration code stays in `aibar/`. Build artifacts and user data are excluded from Git.

[Release notes](docs/RELEASE-NOTES.md) · [Security review](docs/SECURITY-REVIEW-0.9.md) · [MIT license](LICENSE)

See [current release readiness and independent-device checklist](docs/RELEASE-READINESS.md).
