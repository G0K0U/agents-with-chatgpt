"""Local Muse token activity and deduplicated user messages over the last five hours."""
import json
import os
import hashlib
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ..common import now_utc, local_day_start

_TOKEN_KEYS = ("input_tokens", "output_tokens", "cache_write_tokens")


def _wsl_distro_names() -> list[str]:
    # \\wsl.localhost's root cannot be enumerated (WinError 67), so ask WSL
    # itself for the distro list and build direct paths instead.
    import subprocess
    if os.name != "nt":
        return []
    try:
        out = subprocess.run(
            ["wsl.exe", "--list", "--running", "--quiet"], capture_output=True, timeout=20,
            creationflags=subprocess.CREATE_NO_WINDOW
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if out.returncode != 0:
        return []
    text = out.stdout.decode("utf-16-le", errors="replace").replace("\x00", "")
    return [n.strip() for n in text.splitlines() if n.strip()]


def _default_roots() -> list[Path]:
    """Native Muse path plus every WSL distro's Muse path we can read."""
    roots = [Path.home() / ".local" / "share" / "muse" / "sessions"]
    for distro in _wsl_distro_names():
        base = Path("//wsl.localhost") / distro
        candidate_sets = []
        home_base = base / "home"
        try:
            candidate_sets += [u / ".local" / "share" / "muse" / "sessions"
                               for u in home_base.iterdir()]
        except OSError:
            pass
        candidate_sets.append(base / "root" / ".local" / "share" / "muse" / "sessions")
        roots.extend(candidate_sets)
    return [r for r in roots if r.is_dir()]


def _epoch_us_to_dt(value) -> datetime | None:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if v > 1e16:  # nanoseconds
        v /= 1e9
    elif v > 1e13:  # microseconds
        v /= 1e6
    elif v > 1e10:  # milliseconds
        v /= 1e3
    if v <= 0:
        return None
    try:
        return datetime.fromtimestamp(v, tz=timezone.utc)
    except (ValueError, OSError, OverflowError):
        return None


def _tokens_from_usage(usage: dict) -> int | None:
    if usage.get("input_tokens") is None and usage.get("output_tokens") is None:
        return None
    return sum(usage.get(k) or 0 for k in _TOKEN_KEYS)


def _walk(node, ts, rid, seen: set, events: list, turns: list):
    if isinstance(node, dict):
        if "recorded_at" in node:
            parsed = _epoch_us_to_dt(node["recorded_at"])
            if parsed:
                ts = parsed
        if "id" in node and isinstance(node["id"], str):
            rid = node["id"]
        if ts is not None and node.get("payload_type") == "runtime.user_intent.accepted":
            key = ("turn", rid or hashlib.sha256(json.dumps(node, sort_keys=True).encode()).hexdigest())
            if key not in seen:
                seen.add(key)
                turns.append(ts)
        usage = node.get("usage")
        if isinstance(usage, dict):
            tokens = _tokens_from_usage(usage)
            if tokens is not None and ts is not None:
                key = ("usage", rid or hashlib.sha256(json.dumps(node, sort_keys=True).encode()).hexdigest())
                if key not in seen:
                    seen.add(key)
                    events.append((ts, tokens))
        for v in node.values():
            _walk(v, ts, rid, seen, events, turns)
    elif isinstance(node, list):
        for v in node:
            _walk(v, ts, rid, seen, events, turns)


def _events_from_file(jsonl: Path, seen: set, events: list, turns: list) -> None:
    try:
        with open(jsonl, encoding="utf-8", errors="replace") as f:
            while True:
                # 防御：readline 限长——畸形/巨型单行不会拖爆内存（最多 8MB）
                line = f.readline(8 * 1024 * 1024)
                if not line:
                    break
                if not any(s in line for s in ("input_tokens", "output_tokens", "user_intent")):
                    continue
                try:
                    frame = json.loads(line)
                except ValueError:
                    continue
                # Frames may embed child records as JSON strings.
                for child in frame.get("children") or []:
                    raw = child.get("record_json")
                    if isinstance(raw, str):
                        try:
                            _walk(json.loads(raw), None, None, seen, events, turns)
                        except ValueError:
                            continue
                _walk(frame, None, None, seen, events, turns)
    except OSError:
        return  # unreadable file (locked / gone) — skip


def collect(roots: list | None = None, label: str = "Muse Code", enabled: bool = True) -> dict:
    if not enabled:
        return {"label": label, "available": False, "disabled": True,
                "week_7d_tokens": 0, "today_tokens": 0}
    if roots:
        scan_roots = [Path(r) for r in roots]
    else:
        scan_roots = _default_roots()
    scan_roots = [r for r in scan_roots if r.is_dir()]
    now = now_utc()
    if not scan_roots:
        return {
            "label": label,
            "available": False,
            "week_7d_tokens": 0,
            "today_tokens": 0,
            "note": "未找到 Muse 会话日志（WSL 未运行或尚未使用 Muse）",
        }

    seen: set = set()
    events: list = []
    turns: list = []
    files_seen = set()
    for root in scan_roots:
        for jsonl in root.rglob("session.jsonl"):
            key = str(jsonl.resolve())
            if key in files_seen:
                continue
            files_seen.add(key)
            _events_from_file(jsonl, seen, events, turns)
    turns.sort()
    events.sort(key=lambda e: e[0])
    week_cut = now - timedelta(days=7)
    today_cut = local_day_start(now)
    week_tokens = sum(t for ts, t in events if week_cut <= ts <= now)
    today_tokens = sum(t for ts, t in events if today_cut <= ts <= now)

    five_cut = now - timedelta(hours=5)
    # Internal model calls are not user messages. Missing turn records stay zero.
    recent_turns = [ts for ts in turns if five_cut < ts <= now]
    tokens_5h = sum(t for ts, t in events if five_cut < ts <= now)
    five_hour = {"started_at": five_cut.isoformat(), "ends_at": now.isoformat(),
                 "requests": len(recent_turns), "tokens": tokens_5h,
                 "window_kind": "rolling_activity"}
    return {
        "label": label,
        "available": True,
        "week_7d_tokens": week_tokens,
        "today_tokens": today_tokens,
        "five_hour": five_hour,
        "sessions_seen": len(files_seen),
        "updated_at": now.isoformat(),
        "note": "过去5小时本地用户消息数与token消耗；不等于官方计费量或剩余额度",
    }
