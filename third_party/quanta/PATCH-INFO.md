# Quanta 0.9.4+a2c.1 source patch

This is a vendored derivative of the MIT-licensed Quanta v0.9.4 **release
source ZIP** from `SparklingAstronaut/quanta`, tagged at
`a6bce6d9` (the tag commit). The exact upstream asset was
`Quanta-0.9.4-source.zip`, SHA-256
`3129d987a9446c63e13d225610c5231ecdfe3b461c895a1728d99fd0a2dfcf0d`.
The upstream repository may require authorization. Its complete release source
is included here, so an external user can obtain the patched source from this
public repository. `UPSTREAM-SOURCE-MANIFEST.json` records the **original** ZIP
contents; it is not a hash of this derivative. The upstream MIT license and
third-party notices remain in this directory.

The changed source files are `aibar/collect.py`,
`aibar/providers/antigravity.py`, `aibar/providers/codex.py`,
`aibar/providers/glm.py`, and `aibar/server.py`. The synthetic regression test
is `tests/test_sampling_freshness.py`. Windows version metadata identifies the
derivative as `0.9.4+a2c.1` (file version 0.9.4.1).

## Sampling contract

- `generated_at` is the snapshot serialization time, not a quota sample time.
- Top-level `observed_at` has `observed_at_scope: partial_summary`; it only
  summarizes providers with their own successful sample times and must not
  certify another provider's quota.
- Codex's `observed_at` applies only to the current account. A2C reads its
  `is_current` account's `snapshot_at` where present.
- Antigravity attaches `observed_at` only after obtaining quota windows; GLM
  attaches it after a successful quota response.
  A failed provider refresh retains its earlier sample and timestamp with
  `refresh_failed` and `error`, so consumers can invalidate it.
- `GET /api/usage?force_refresh=true` runs a new collection. A collection
  failure returns the old sample with a failure marker and its original time.
  Ordinary reads return the existing snapshot without redating it.
- A2C accepts only ISO 8601 sample timestamps with explicit timezones and
  applies its 60-second freshness policy separately for each provider.

## Rebuild on Windows

Use Python 3.12 in a new virtual environment. From this directory:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-windows-build.txt
.\.venv\Scripts\python.exe -m unittest tests.test_sampling_freshness -v
.\.venv\Scripts\python.exe build_windows.py
```

`build_windows.py` verifies the exact pinned dependency inventory, writes
`dist/Quanta.exe`, and writes `dist/Quanta.exe.build.json` containing the
build input hashes, source revision, dependency versions and executable hash.
Rebuilding may yield a different executable byte hash across Python or
PyInstaller environments; verify the input inventory and resulting hash.
The binary is not committed here. The existing upstream v0.9.4 binary is
historical and does not include this patch.

The service binds to loopback and uses its configured `X-Token` authentication.
Do not publish local Quanta configuration, tokens or snapshots.
