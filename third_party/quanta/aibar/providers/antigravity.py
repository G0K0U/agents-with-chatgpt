"""Google Antigravity (Gemini) usage — local language server API + DB counts.

Two data layers, both confined to the local machine:

1. Quota (while the Antigravity app is running): discover the language server
   process, read --csrf_token / --extension_server_port from its command line,
   find its listening port, and POST Connect-RPC requests to
   /exa.language_server_pb.LanguageServerService/{RetrieveUserQuotaSummary,
   GetUserStatus} with headers X-Codeium-Csrf-Token + Connect-Protocol-Version.
   This is the exact protocol the community quota watchers use (CodexBar's
   docs/antigravity.md is the reference). Only 127.0.0.1 is ever contacted —
   the LS itself is what talks to Google.

   Quota shape: two groups ("Gemini Models", "Claude and GPT models"), each
   with a weekly bucket and a 5h bucket, remainingFraction + resetTime.
   Same window semantics as the GLM provider, so these feed the tray light.

2. Activity counts (always): passive read-only scan of
   ~/.gemini/*/conversations/*.db for conversation/generation counts.

When the app is closed, layer 1 degrades gracefully to counts-only.
"""
import json
import os
import re
import socket
import sqlite3
import ssl
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from ..common import now_utc, parse_ts, local_day_start
from ..http_client import read_object

_MODEL_RE = re.compile(r"gemini-[0-9][0-9.]+[-a-z0-9]*")
_DIRS = ("antigravity", "antigravity-ide", "antigravity-cli")
_GROUP_SHORT = {"gemini models": "Gemini", "claude and gpt models": "Claude·GPT"}
_WINDOW_LABEL = {"5h": "5h窗口", "weekly": "周窗口"}
_PROBE_BODY = {"ideName": "antigravity", "extensionName": "antigravity",
               "locale": "en", "ideVersion": "unknown"}
_TIMEOUT = 4


# ---------- local request helper (loopback only, no redirects) ----------

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE  # LS uses a self-signed cert on loopback
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect,
                                      urllib.request.HTTPSHandler(context=_CTX))


def _post_local(port: int, method: str, csrf: str) -> dict | None:
    """POST a Connect-RPC call to 127.0.0.1:<port>; return parsed JSON or None.

    SSRF guard: scheme pinned to https, host pinned to the literal 127.0.0.1
    and re-resolved to a loopback IP before every request; redirects disabled.
    """
    url = f"https://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/{method}"
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != "127.0.0.1":
        return None
    try:
        ip = socket.getaddrinfo(parsed.hostname, None, proto=socket.IPPROTO_TCP)[0][4][0]
    except OSError:
        return None
    if not ip.startswith("127."):
        return None
    req = urllib.request.Request(
        url,
        data=json.dumps(_PROBE_BODY).encode(),
        headers={
            "Content-Type": "application/json",
            "X-Codeium-Csrf-Token": csrf,
            "Connect-Protocol-Version": "1",
        },
        method="POST",
    )
    try:
        with _OPENER.open(req, timeout=_TIMEOUT) as resp:
            return read_object(resp)
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError):
        return None


# ---------- layer 1: quota via the local language server ----------

def _process_lines() -> list[str]:
    """pid + command line of every language_server process, as text lines."""
    if os.name == "nt":
        try:
            out = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 "Get-CimInstance Win32_Process -Filter \"Name='language_server.exe'\""
                 " | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }"],
                capture_output=True, text=True, timeout=25, creationflags=subprocess.CREATE_NO_WINDOW,
            )
            return out.stdout.splitlines()
        except (OSError, subprocess.TimeoutExpired):
            return []
    try:
        out = subprocess.run(["ps", "-ax", "-o", "pid=,command="],
                             capture_output=True, text=True, timeout=15)
        return out.stdout.splitlines()
    except (OSError, subprocess.TimeoutExpired):
        return []


def _ls_candidates() -> list[dict]:
    """Extract {pid, csrf, ext_port} for Antigravity language server processes."""
    out = []
    for line in _process_lines():
        if "language_server" not in line or "antigravity" not in line.lower():
            continue
        csrf_m = re.search(r"--csrf_token (\S+)", line)
        ext_m = re.search(r"--extension_server_port (\d+)", line)
        ext_csrf_m = re.search(r"--extension_server_csrf_token (\S+)", line)
        pid_m = re.match(r"^\s*(\d+)\|", line)
        pid = None
        if os.name == "nt":
            pid_m = pid_m or re.search(r"ProcessId=(\d+)", line)
            if pid_m:
                pid = int(pid_m.group(1))
        else:
            # ps output is "PID COMMAND"; accept the Windows "PID|CMDLINE"
            # shape as well so fixture lines parse on every platform.
            pid_m = pid_m or re.match(r"\s*(\d+)\s", line)
            if pid_m:
                pid = int(pid_m.group(1))
        csrf = (ext_csrf_m.group(1) if ext_csrf_m else None) or \
               (csrf_m.group(1) if csrf_m else None)
        if pid and csrf:
            out.append({"pid": pid, "csrf": csrf,
                        "ext_port": int(ext_m.group(1)) if ext_m else None})
    return out


def _listen_ports(pid: int) -> list[int]:
    if os.name == "nt":
        try:
            out = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 f"(Get-NetTCPConnection -OwningProcess {pid} -State Listen"
                 " -ErrorAction SilentlyContinue).LocalPort"],
                capture_output=True, text=True, timeout=20, creationflags=subprocess.CREATE_NO_WINDOW,
            )
            return sorted({int(x) for x in out.stdout.split() if x.isdigit()})
        except (OSError, subprocess.TimeoutExpired, ValueError):
            return []
    try:
        out = subprocess.run(
            ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", str(pid)],
            capture_output=True, text=True, timeout=15,
        )
        ports = set()
        for line in out.stdout.splitlines()[1:]:
            m = re.search(r":(\d+)\s", line + " ")
            if m:
                ports.add(int(m.group(1)))
        return sorted(ports)
    except (OSError, subprocess.TimeoutExpired):
        return []


def _group_windows(rus: dict) -> list[dict]:
    windows = []
    for group in (rus.get("response", {}).get("groups") or []):
        gname = _GROUP_SHORT.get(group.get("displayName", "").lower(),
                                 group.get("displayName", "?"))
        for bucket in group.get("buckets") or []:
            frac = bucket.get("remainingFraction")
            if frac is None:
                continue
            reset = parse_ts(bucket.get("resetTime") or "")
            windows.append({
                "label": f"{gname} {_WINDOW_LABEL.get(bucket.get('window', ''), bucket.get('window', '?'))}",
                "percent": round((1 - frac) * 100, 1),
                "remaining": round(frac * 100, 1),
                "reset_at": int(reset.timestamp()) if reset else None,
            })
    windows.sort(key=lambda w: w["percent"], reverse=True)
    return windows


def _quota_via_ls() -> dict:
    """Query the local LS for quota; {} when the app isn't running/usable."""
    for cand in _ls_candidates():
        ports = _listen_ports(cand["pid"])
        if cand.get("ext_port"):
            ports.append(cand["ext_port"])
        for port in ports:
            rus = _post_local(port, "RetrieveUserQuotaSummary", cand["csrf"])
            if rus and rus.get("response", {}).get("groups"):
                return {"windows": _group_windows(rus), "source_port": port}
        for port in ports:
            gus = _post_local(port, "GetUserStatus", cand["csrf"])
            status = (gus or {}).get("userStatus") or {}
            configs = (status.get("cascadeModelConfigData") or {}).get("clientModelConfigs") or []
            windows = []
            for cfg in configs:
                info = cfg.get("quotaInfo") or {}
                frac = info.get("remainingFraction")
                if frac is None:
                    continue
                reset = parse_ts(info.get("resetTime") or "")
                name = cfg.get("model") or cfg.get("name") or "模型"
                windows.append({"label": f"{name}", "percent": round((1 - frac) * 100, 1),
                                "remaining": round(frac * 100, 1),
                                "reset_at": int(reset.timestamp()) if reset else None})
            if windows:
                windows.sort(key=lambda w: w["percent"], reverse=True)
                return {"windows": windows,
                        "plan": (status.get("planStatus", {}).get("planInfo") or {}).get("planName"),
                        "email": status.get("email"), "source_port": port}
    return {}


# ---------- layer 2: passive conversation counts ----------

def _scan_db(db: Path, models: dict) -> int:
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    except sqlite3.Error:
        return 0
    try:
        rows = con.execute("SELECT data FROM gen_metadata").fetchall()
    except sqlite3.Error:
        return 0
    finally:
        con.close()
    count = 0
    for (blob,) in rows:
        if not blob:
            continue
        count += 1
        m = _MODEL_RE.search(bytes(blob).decode("utf-8", "ignore"))
        if m:
            name = m.group(0).rstrip("-")
            models[name] = models.get(name, 0) + 1
    return count


def _counts(roots=None) -> tuple[int, int, dict, datetime | None, int]:
    gemini = Path.home() / ".gemini"
    roots = [Path(r) for r in roots] if roots else [gemini / d / "conversations" for d in _DIRS]
    now = now_utc()
    today_cut = local_day_start(now)
    conversations = generations = today_conversations = 0
    models: dict = {}
    last_activity: datetime | None = None
    for root in roots:
        if not root.is_dir():
            continue
        for db in root.glob("*.db"):
            try:
                mtime = datetime.fromtimestamp(db.stat().st_mtime, tz=timezone.utc)
            except OSError:
                continue
            if last_activity is None or mtime > last_activity:
                last_activity = mtime
            if mtime >= today_cut:
                today_conversations += 1
            n = _scan_db(db, models)
            if n:
                conversations += 1
                generations += n
    return conversations, generations, models, last_activity, today_conversations


# ---------- entry point ----------

def collect(roots: list | None = None, label: str = "Antigravity") -> dict:
    conversations, generations, models, last_activity, today_conversations = _counts(roots)
    now = now_utc()
    quota = _quota_via_ls()
    if not conversations and not quota:
        return {
            "label": label,
            "available": False,
            "note": "未找到 Antigravity 会话数据（未安装或还没用过）",
        }
    top_model = max(models, key=models.get) if models else "?"
    return {
        "label": label,
        "available": True,
        "windows": quota.get("windows") or [],
        "plan": quota.get("plan"),
        "email": quota.get("email"),
        "conversations": conversations,
        "today_conversations": today_conversations,
        "generations": generations,
        "models": models,
        "top_model": top_model,
        "last_activity": last_activity.isoformat() if last_activity else None,
        "observed_at": now.isoformat() if quota.get("windows") else None,
        "updated_at": now.isoformat(),
        "quota_error": None if quota.get("windows") else "QuotaUnavailable",
        "note": "配额来自本机语言服务器（localhost）；计数来自本地会话库",
    }
