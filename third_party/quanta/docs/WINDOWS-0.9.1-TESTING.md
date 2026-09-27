# Windows v0.9.1 test scope

This update is tested on the existing development computer, not an independent clean device. Windows app source, actual packaged GUI checks, startup/health and Codex account-attribution checks are separate from Mac validation.

Discovery regressions cover a missing PATH, cached CLI selection, rejection of directories named codex.exe, safe startup-error handling and recovery text that does not expose raw errors. A live read through the installed cached CLI succeeded with PATH lookup unavailable; only read-only account and rate-limit requests were used.

The alternative direct CLI inside the registered WindowsApps package was discovered but Windows denied execution. That experimental fallback was removed; no OS permissions or security settings were changed. Opening and signing into the official Codex app first remains the setup instruction.

The release package contains source- and executable-bound test evidence. Existing personal configuration and credentials are preserved. Mac secure2 has not been executed on this Windows computer, and its binary is unchanged.
