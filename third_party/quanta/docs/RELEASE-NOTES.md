# Windows v0.9.4 — installer prerelease

Adds a per-user Windows installer with an installation-folder picker, desktop shortcut option, Start menu shortcut, and Windows Installed apps entry. The README Windows button downloads Setup.exe; the portable ZIP remains available. Installing does not enable launch at login. Existing Quanta startup choices follow the installed path; uninstall only removes startup pointing to that installation and preserves personal settings and credentials. The installer and app remain unsigned. Mac binaries are unchanged.

# Windows v0.9.3 — unsigned prerelease

Windows v0.9.3 fixes a refresh failure in English mode when multiple quota windows make the translated tray tooltip exceed the Windows length limit. The failure could mark every card outdated despite successful data collection. The tooltip is now limited after translation, including UTF-16 handling. Two regression tests cover the native failure and Unicode boundary. This reproduces a plausible cause of the reported ValueError; it does not prove the cause on the reporting device. Mac binaries are unchanged.

# Windows v0.9.2 — unsigned prerelease

Fixes the popup Startup button remaining Chinese in English mode after its status symbols were removed. Enabled state still uses the blue background. Mac binaries are unchanged.

# Windows v0.9.1 — unsigned prerelease

Windows Codex detection remains compatible with desktop launches lacking PATH: it uses the official per-user cached CLI. Non-file cache candidates are ignored, executable startup failures become safe quota errors, and Details displays actionable recovery guidance without raw error content.

The installed Codex CLI inside WindowsApps was found but its direct execution was denied on the test computer; that unsupported fallback was not shipped. The normal cached CLI completed a live account-verified read with PATH discovery disabled.

The README now distinguishes Windows v0.9.1 from Mac v0.9.0 secure2/build 9.2, and explains the Mac archive's current SOURCE-SHA256.json versus its historical baseline manifest. Mac binaries remain unchanged. See WINDOWS-0.9.1-TESTING.md for local test scope.

# Quanta v0.9.0 — unsigned prerelease

The Windows download replaces RC4 as the current development release. It includes the tested compact popup, native connections, Windows Credential Manager storage, bilingual presentation, fixed-size detail cards, consistent value typography, dark scrollbars and taskbar-free popup.

The native macOS source from PR #1 is consolidated into the repository with its own detail renderer and build recipe. Keychain errors now fail closed, and secure credential overlays are protected from plaintext configuration saves. The integrated credential changes need native Mac retesting. A Mac binary has since been uploaded from a separate native snapshot; it does not contain those later fixes. See the Mac guide for its limited testing scope.

Setup is separated into Windows and macOS guides. Historical porting instructions are archived. Windows remains unsigned, and the Mac build recipe remains ad-hoc signed without Apple notarization. See SECURITY-REVIEW-0.9.md for validation and remaining limits.
