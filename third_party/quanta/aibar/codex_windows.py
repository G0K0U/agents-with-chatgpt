"""Interpret Codex windows by duration; primary/secondary are only API slots."""
import math
import re
import time


def _number(value):
    return (not isinstance(value, bool) and isinstance(value, (int, float))
            and math.isfinite(value))


def plan_label(account):
    plan = account.get("plan_type") or ""
    if not isinstance(plan, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", plan):
        return ""
    return {"plus": "Plus", "pro": "Pro", "prolite": "Pro (prolite)"}.get(plan, plan)


def account_windows(account):
    """Preserve duration, usage and reset together, including unfamiliar windows."""
    windows = []
    for index, key in enumerate(("primary", "secondary"), 1):
        minutes = account.get(key + "_window_minutes")
        raw = account.get(key + "_used_percent")
        used = account.get("effective_" + key + "_used_percent", raw)
        reset = account.get(key + "_resets_at")
        if all(v is None for v in (minutes, raw, used, reset)):
            continue
        minutes = minutes if _number(minutes) and minutes > 0 else None
        if minutes == 10080:
            label = "周"
        elif minutes is None:
            label = f"窗口{index}（时长未知）"
        elif minutes % 1440 == 0:
            label = f"{minutes / 1440:g}天"
        elif minutes % 60 == 0:
            label = f"{minutes / 60:g}h"
        else:
            label = f"{minutes:g}分钟"
        expired = bool(account.get(key + "_reset_done") or (_number(reset) and reset <= time.time()))
        used = used if _number(used) and 0 <= used <= 100 and not expired else None
        windows.append({"slot": key, "label": label, "window_minutes": minutes,
                        "used_percent": used, "remaining": None if used is None else 100 - used,
                        "resets_at": reset, "expired": expired})
    return sorted(windows, key=lambda w: w["window_minutes"] or float("inf"))


def usable_windows(account):
    if account.get("stale", True) or account.get("attribution_verified") is not True:
        return []
    return [w for w in account_windows(account) if w["remaining"] is not None]


def recommendation_windows(rec):
    """Explicit legacy field names remain readable; new advice carries durations."""
    if "windows" in rec:
        return rec["windows"]
    return [{"label": label, "remaining": rec[key], "window_minutes": minutes}
            for key, label, minutes in (("remaining_5h", "5h", 300), ("remaining_week", "周", 10080))
            if _number(rec.get(key)) and 0 <= rec[key] <= 100]
