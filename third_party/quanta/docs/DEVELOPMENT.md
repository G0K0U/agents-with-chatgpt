# Development and release

Run commands from the repository root. Keep build environments separate from personal app data. Never commit credentials, snapshots, logs or generated binaries.

## Windows

Use Python 3.12 x64 and only the pinned `requirements-windows-build.txt` dependencies in a dedicated environment. The current verified runtime is Python 3.12.14.

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements-windows-build.txt
.venv\Scripts\python tools/test_release.py --output work/evidence/test-results.json
.venv\Scripts\python tools/audit_scan.py scan
.venv\Scripts\python build_windows.py
.venv\Scripts\python tools/release.py build
.venv\Scripts\python tools/smoke.py --exe dist/Quanta.exe --output work/evidence
.venv\Scripts\python tools/portable_release.py --dist dist --evidence work/evidence --output outputs
```

Commit source before the final build and checks. Packaging requires matching committed source, tests and binary smoke evidence. Skipped native Mac tests must be reported as skipped, not passed. Verify the portable folder with `Verify.cmd`. The source archive is `Quanta-source.zip`; it includes both platform sources, not a Mac binary.

Build the Windows installer from that verified portable folder using [the installer instructions](../packaging/windows/README.md). Publish Setup.exe, its SHA-256, build record, and native install/upgrade/uninstall acceptance report alongside the portable ZIP.

## macOS

Follow [the Mac build guide](macos/README.md). After any shared-code change, rerun native Mac tests and GUI/Keychain checks on a Mac. Record failures and platform skips separately. Never count the older Mac branch's checks as verification of a new combined build.

## Publishing

Attach versioned ZIPs and SHA-256 files to GitHub Releases, not to the source tree. v0.9.0 is an unsigned prerelease. Preserve older tagged releases as rollback history while directing users to the current release. Before adding a Mac binary, verify its exact source revision, signature, dependencies, license/source inventory and runtime behavior. Code signing/notarization are separate from GitHub publication.
