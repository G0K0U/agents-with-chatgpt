# Quanta v0.9 — friend testing

Allow about 10 minutes. This is an unsigned prerelease, so report problems rather than treating it as a production monitor.

## Before starting

- Accept the repository invitation and sign in to GitHub; the downloads are private.
- Open [the README downloads](../README.md#downloads). Windows x64 users need the Windows installer EXE; Apple Silicon users need the macOS arm64 app ZIP. Source ZIPs are for developers.
- Follow the [Windows](windows/README.md) or [Mac](macos/README.md) setup guide. Keep an older copy and your existing settings. Never run two copies together.
- Windows: open Setup.exe, choose a folder, then check the desktop shortcut and Start menu entry. The portable alternative uses Verify.cmd after extraction. Mac: extract and move Quanta.app to Applications. No Python is needed.
- Report any OS security warning exactly. Do not disable security protections. **On Mac, use secure2 (build 9.2); original and fix1 packages are historical and lack the integrated credential fixes.**

## Checklist

1. Open the app and locate Q in the Windows notification area or Mac menu bar. Record how long first startup takes approximately.
2. Open and dismiss the popup three times, switch to another app, then reopen it. Try its legend and Details buttons.
3. Resize the detail window and scroll its cards and the main page. Check that text, balances and buttons remain readable.
4. Click Refresh once. Confirm progress ends with a result or clear error. Check the reset-window labels against the service's own display where available; balances and activity counts are not quota percentages.
5. Check Chinese or English text using your normal system language. Report untranslated, clipped or confusing labels; no system-language change is required.
6. Optionally test Add connection with your own GLM/DeepSeek key on Windows or Mac secure2. Check paste, empty-input feedback and successful save. Never send the key to the developer. On Mac, if an upgraded saved connection needs permission, use Allow access to saved Keychain connection; report denial behavior without sharing credentials.
7. Close Details and confirm Q stays available. Quit from Q and reopen the app. Confirm settings remain present. Startup-at-login testing is optional; do not log out just for this checklist.

If a source is not installed or you have no account/key, mark it **not tested**. Do not count missing services as a failure or skipped checks as passes.

## Send feedback

Use a repository issue or your existing private conversation with the app owner. Include:

- OS version and CPU type (Windows x64 / Mac M-series), display scaling and number of monitors.
- Exact installer or ZIP filename and Quanta version.
- The checklist item, steps taken, expected result and actual result.
- Whether restarting changes the problem.
- A screenshot with email addresses, account IDs and usage details hidden as needed.

Do not attach API keys, configuration files, Keychain/Credential Manager contents, raw chat logs or unreviewed diagnostic archives.

中文反馈请写明：系统与芯片、下载的 ZIP 文件名、操作步骤、预期与实际结果，以及已隐藏个人信息的截图。没有测试的项目请标记“未测”，不要提交密钥或完整配置。

Record PASS / FAIL / NOT TESTED / N/A per item. Independent Windows testing is deferred to the user's friend's computer; it has not been counted as passed. See [release readiness](RELEASE-READINESS.md).
