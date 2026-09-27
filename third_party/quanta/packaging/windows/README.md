# Windows installer

`Quanta.iss` uses Inno Setup 6.7.3. Obtain the compiler from the [official download page](https://jrsoftware.org/isdl.php), and verify its Authenticode signature (Pyrsys B.V.) before running it. The unmodified installer engine and its notices remain intact. `InnoSetup-LICENSE.txt` is shipped with the installed app.

`ChineseSimplified.isl` is the upstream translation from `jrsoftware/issrc`, tag `is-6_7_3`, path `Files/Languages/Unofficial/ChineseSimplified.isl`; its attribution is preserved. English messages come from the compiler.

After the normal source, executable, and portable-package gates pass:

```powershell
.venv\Scripts\python tools/build_installer.py --compiler "C:\path\to\ISCC.exe" --package "outputs\Quanta-0.9.4-Windows-x64-portable" --output outputs
```

The installer must be tested before publication: folder selection, desktop and Start menu shortcut targets, Installed apps registration, reinstall/upgrade, uninstall cleanup, preservation of personal settings, and startup behavior. Bind that report to the installer SHA-256 and publish it with the build record. Do not count independent-device acceptance as passed based on the development computer.

Setup installs only for the current user. It writes app payloads to the chosen folder, shortcuts to that user's desktop and Start menu, and its own uninstall registration. There is no setup-time API connection or credential collection. An existing Quanta startup entry is retargeted; a fresh install never enables startup. Uninstall removes only its own startup target and does not touch personal settings or credentials. The app mutex prevents replacing a running tray copy; Restart Manager handles other open Quanta windows without forcing closure.

Portable-only `Verify.cmd` and `SHA256SUMS` are omitted from installed files, because the uninstaller adds its own files. The installer build JSON records every installed payload hash. The source ZIP and dependency notices remain included.
