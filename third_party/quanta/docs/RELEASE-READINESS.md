# v0.9 prerelease acceptance

Status: prepared for controlled unsigned prerelease testing, not claimed stable or independently certified.

Windows: retain Quanta-0.9.0-Windows-x64-portable.zip and its existing source/binary-bound evidence. Prior release records report 183/193 source tests passed and eight packaged GUI smoke checks passed on the development PC. No Windows binary was rebuilt or executed on this Mac. Friend-device acceptance is pending by user choice.

Mac: use secure2 (build 9.2), not original or fix1. Includes integrated credential fixes and Codex discovery. 198 source checks: 181 passed, 17 skips. Native isolated Keychain persistence/save-protection and existing-connection upgrade authorization verified. Real GUI empty-input rejection passed. No credential values are included in this report.

Independent-device checklist (record PASS / FAIL / NOT TESTED / N/A for each)
1. Record OS, architecture, downloaded filename and SHA-256; verify before launch.
2. Extract app; launch with normal system protections enabled.
3. Sign into Codex on that device; check automatic detection and refreshed quota.
4. Open popup and details; verify bar labels, balances and reset times.
5. Open connections; confirm saved keys are not displayed. Paste own key, test/save, verify connected state. Never send keys in reports.
6. Test empty/invalid input; existing connection must remain intact.
7. Close panel; menu/tray icon remains. Quit from popup; process exits.
8. Reopen; settings and connections persist. Test clipboard shortcuts using non-secret sample text.
9. Test system-language behavior: Chinese uses Chinese, other languages use English. Do not change OS settings solely for automated checks without user intent.
10. Login startup / logout / reboot / multiple monitors: user-controlled optional tests; mark NOT TESTED if skipped.

Feedback template: OS/architecture; package/SHA; item; observed result; expected result; PASS/FAIL/NOT TESTED/N/A; redacted screenshot if helpful. Keep historical failure results attached to the original package.
