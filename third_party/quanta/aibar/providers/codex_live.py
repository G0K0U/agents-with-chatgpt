"""Read account-bound quota through the installed, official Codex app-server.

Only initialize, account/read and account/rateLimits/read are sent. No model
turns, login changes, resets or copied credentials are involved.
"""
import asyncio
import os
import shutil
import subprocess
from pathlib import Path

from ..common import now_utc, read_json

SOURCE = "codex_app_server"


class QuotaReadError(RuntimeError):
    pass


def _find_executable():
    found = shutil.which("codex.exe" if os.name == "nt" else "codex")
    if found:
        return found
    if os.name == "nt":
        root = Path(os.environ.get("LOCALAPPDATA", Path.home()/"AppData/Local"))/"OpenAI/Codex/bin"
        candidates = [p for p in root.glob("*/codex.exe") if p.is_file()]
        if candidates:
            return str(max(candidates, key=lambda p: p.stat().st_mtime))
    else:
        candidates = [Path("/opt/homebrew/bin/codex"), Path("/usr/local/bin/codex")]
        # Finder-launched apps do not inherit the terminal's PATH. Probe the
        # known desktop bundle layouts in both macOS Applications directories.
        for applications in (Path("/Applications"), Path.home() / "Applications"):
            for bundle in ("Codex.app", "ChatGPT.app"):
                candidates.append(applications / bundle / "Contents/Resources/codex")
        for path in candidates:
            if path.is_file() and os.access(path, os.X_OK):
                return str(path)
    raise QuotaReadError("Codex executable unavailable")


def _identity(codex_dir):
    auth = read_json(codex_dir/"auth.json", {}) or {}
    return (auth.get("tokens") or {}).get("account_id")


def validate_observation(before, usage, after, expected_id):
    first, last = before.get("account") or {}, after.get("account") or {}
    email = first.get("email")
    if first.get("type") != "chatgpt" or not email or last != first:
        raise QuotaReadError("Account identity unavailable or changed during quota read")
    account_id = usage.get("accountId")
    if not account_id or account_id != expected_id:
        raise QuotaReadError("Quota response did not confirm the signed-in account ID")
    buckets = usage.get("rateLimitsByLimitId")
    if buckets is not None:
        limits = buckets.get("codex")
    else:
        limits = usage.get("rateLimits")
    if not limits or limits.get("limitId") not in (None, "codex"):
        raise QuotaReadError("Codex quota bucket unavailable")
    if not any(limits.get(key) for key in ("primary", "secondary")):
        raise QuotaReadError("Codex quota window unavailable")
    windows = {}
    for key in ("primary", "secondary"):
        window = limits.get(key) or {}
        used = window.get("usedPercent")
        if used is not None and (isinstance(used, bool) or not isinstance(used, (int, float)) or not 0 <= used <= 100):
            raise QuotaReadError("Invalid quota percentage")
        windows[key] = {"used_percent": used, "window_minutes": window.get("windowDurationMins"),
                        "resets_at": window.get("resetsAt")}
    return {"account_id": account_id, "email": email,
            "rate_limits": {**windows, "plan_type": limits.get("planType") or first.get("planType")},
            "observed_at": now_utc()}


async def _query(executable, codex_dir):
    import json
    kwargs = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    proc = await asyncio.create_subprocess_exec(executable, "app-server", "--stdio",
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL, **kwargs)

    async def send(item):
        proc.stdin.write((json.dumps(item)+"\n").encode("utf-8"))
        await proc.stdin.drain()

    async def rpc(method, request_id, params=None):
        request = {"method": method, "id": request_id}
        if params is not None:
            request["params"] = params
        await send(request)
        while True:
            line = await proc.stdout.readline()
            if not line:
                raise QuotaReadError("Codex app-server exited before answering")
            item = json.loads(line)
            if item.get("id") == request_id and "method" not in item:
                if "error" in item:
                    raise QuotaReadError("Codex account service rejected the quota read")
                return item["result"]
            if "method" in item and "id" in item:
                # Never execute server-initiated actions or supply auth credentials.
                await send({"id": item["id"], "error": {"code": -32601, "message": "Read-only quota client"}})

    async def sequence():
        expected_id = _identity(codex_dir)
        if not expected_id:
            raise QuotaReadError("No signed-in ChatGPT account")
        await rpc("initialize", 1, {"clientInfo": {"name": "aibar_quota_monitor",
                  "title": "AI Quota Monitor", "version": "0.3.0"}})
        await send({"method": "initialized"})
        before = await rpc("account/read", 2, {"refreshToken": False})
        usage = await rpc("account/rateLimits/read", 3)
        after = await rpc("account/read", 4, {"refreshToken": False})
        if _identity(codex_dir) != expected_id:
            raise QuotaReadError("Login changed during quota read")
        return validate_observation(before, usage, after, expected_id)

    try:
        return await asyncio.wait_for(sequence(), timeout=20)
    finally:
        proc.stdin.close()
        try:
            await asyncio.wait_for(proc.wait(), timeout=2)
        except asyncio.TimeoutError:
            proc.terminate()
            await proc.wait()


def read_verified(codex_dir):
    # Never read the normal login and attribute it to a custom log directory.
    expected_home = Path(os.environ.get("CODEX_HOME") or (Path.home()/".codex"))
    if codex_dir.resolve() != expected_home.resolve():
        raise QuotaReadError("Live verification requires the active Codex profile")
    try:
        return asyncio.run(_query(_find_executable(), codex_dir))
    except OSError as exc:
        raise QuotaReadError("Codex executable could not be started; open Codex and refresh") from exc
    except asyncio.TimeoutError as exc:
        raise QuotaReadError("Live quota request timed out") from exc
