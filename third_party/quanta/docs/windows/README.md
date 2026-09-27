# Windows

Click [Download Windows installer](https://github.com/SparklingAstronaut/quanta/releases/download/v0.9.4/Quanta-0.9.4-Windows-x64-Setup.exe), then open the downloaded file. Select an installation folder and click Install. The default is your own `AppData\Local\Programs\Quanta` folder; it does not require administrator access. Setup always creates a Start menu shortcut and offers a desktop shortcut, selected by default. Open Quanta from either shortcut. No Python installation is needed.

下载后打开安装程序，选择安装目录，再点击安装。默认只为当前用户安装，创建开始菜单入口，并默认勾选桌面快捷方式。

The installer is available in English and Simplified Chinese. The app follows your Windows display language. Installing does not turn on launch at login; use Startup in the Q popup if you want that. Start menu placement and launch at login are separate features. The detail panel uses Microsoft Edge WebView2; install its runtime from Microsoft if it is unavailable.

The [portable ZIP](https://github.com/SparklingAstronaut/quanta/releases/download/v0.9.4/Quanta-0.9.4-Windows-x64-portable.zip) remains available. Extract the whole folder, run `Verify.cmd`, then `Quanta.exe`. Portable copies do not create shortcuts or an uninstall entry.

The executable is unsigned. A checksum verifies file consistency, not publisher identity. Do not disable Windows security protections to run it.

Click Q in the notification area (possibly under hidden icons). Refresh updates data, Details opens the panel, and Connect opens the native GLM/DeepSeek editor. Auto start is blue only when enabled. Cards stay the same size as the window changes. API keys entered through the editor are validated before being saved in Windows Credential Manager.

To upgrade an installed copy, close all Quanta windows, quit Q, and run the new installer. It remembers the installation folder and shortcut choice. An existing launch-at-login entry follows the installed executable. For portable copies, keep the old folder as a rollback copy and extract the new version into a separate folder; re-enable Startup after moving it.

To uninstall, quit Q and use Windows Settings → Apps → Installed apps → Quanta → Uninstall. App files and installer-created shortcuts are removed. Personal settings in `~/.aibar` and saved Windows Credential Manager connections are preserved. A startup entry is removed only if it points to the copy being uninstalled.

系统为中文时使用中文，其余语言使用英文。退出旧版本后再启动新版本，保留配置和系统凭据；不要同时运行两份应用。

## Codex detection

Quanta first checks PATH for `codex.exe`, then the official per-user `OpenAI/Codex/bin/<version>/codex.exe` cache. This fallback works when the app is launched without a terminal PATH. Open and sign into the official Codex desktop app before testing Quanta. If detection fails, open/update Codex and refresh Quanta; report the result rather than copying executables out of WindowsApps or changing permissions.

A Store-installed CLI can be visible under WindowsApps while direct execution is denied. Quanta does not use that unsupported launch route. It verifies that returned quota belongs to the signed-in account and does not display raw startup errors.
