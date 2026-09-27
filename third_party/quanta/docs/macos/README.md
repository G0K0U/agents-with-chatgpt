# macOS v0.9 build 9.6 (layout6)

Download `Quanta-0.9.0-macOS-arm64-layout6.zip` from the v0.9 release. Extract it, quit the old Quanta from its popup, replace Quanta.app in Applications and open it. Python is not required. Existing configuration is preserved. Apple Silicon only.

This build uses the integrated v0.9 source plus the Mac fixes included in `Quanta-0.9.0-integrated-source-layout6.zip`. It supersedes the earlier Mac snapshots and fix1 for testing. It includes Keychain fail-closed reads, protected settings saves, immediate protection after saving a new connection, and Codex desktop executable discovery without terminal PATH.

If a saved connection needs access after upgrading, open Add connection and click Allow access to saved Keychain connection. This explicitly permits a system authorization prompt; background refresh never prompts. Denial leaves the connection unavailable and preserves existing settings. No saved secret is shown in the editor.

Validation: 198 checks run on Mac; 181 passed, 17 platform/dependency skips. Earlier secure2 validation: an isolated real Keychain round trip, protected settings save, real connection window, empty-input rejection and explicit Keychain authorization succeeded. Existing GLM connection returned to connected after authorization. These secure2 GUI/Keychain results were not rerun as layout3/layout6 acceptance; the original, fix1 and secure2 evidence remain separate. Package signatures, checksums, source hashes, dependency/license inventory are supplied in the download.

Unsigned prerelease: local ad-hoc signature only, no Developer ID or notarization. Do not disable Gatekeeper, SIP or remove quarantine. Independent clean-device acceptance, Intel Macs, logout/reboot and exhaustive GUI coverage are pending. Windows independent testing will be performed later by the user on a friend's computer.

Build: use Python 3.12.13 and requirements-macos-build.txt, then `python -m PyInstaller --noconfirm packaging/macos/Quanta.spec`. Mac and Windows renderers remain separate. See bundled source and evidence for exact provenance.

## Source records

For layout6, verify **SOURCE-SHA256.json**: it records the exact source files and the matching record is bundled with the app. SOURCE-MANIFEST.json inside the companion source archive is the historical v0.9.0 baseline, not layout6's manifest. Use the exact layout6 companion ZIP, not the automatic v0.9.0 source download, to reproduce that Mac build.

Windows v0.9.4 is a separate platform update. It does not rename or replace the tested Mac 0.9.0 build 9.6 binary.




## GLM-based standard height — build 9.6

All cards use the current normal GLM card as the height reference: 400×288px. Original fonts, spacing and trend charts are preserved. This reduces the 480px layout5 card and removes the extra bottom space seen in the intermediate 320px local preview. The installed Chinese GLM view, including its two quota bars and trend, was inspected through the real GUI. Actual content remains visible with normal bottom padding.

AGY long lists, multiple Codex accounts, longer translations or unusually long content scroll inside the same fixed card; they never set the height of every card. Independent Mac-device acceptance remains pending. Windows v0.9.4 is unchanged. Earlier synthetic measurement records are historical and are not a claim that every translated/card combination fits without scrolling at 288px.
