"""Local refresh history (stdlib only, no network).

Every successful collector refresh appends one JSON line to
``~/.aibar/history.jsonl``. Panels render a 7-day mini trend from it.
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path

from .common import DATA_DIR
from .codex_windows import usable_windows

HISTORY_PATH = DATA_DIR / "history.jsonl"
MAX_DAYS = 7
MAX_LINES = 2000  # 追加时轮转：超过即只保留最新 2000 行，防止无限增长

_SPARK = "▁▂▃▄▅▆▇█"


def _num(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def extract_point(view: dict, now=None) -> dict:
    """Compact numeric snapshot used for trends."""
    ts = (now or datetime.now(timezone.utc)).isoformat()
    point: dict = {"ts": ts}
    rec = (view.get("codex") or {}).get("recommendation") if isinstance(view.get("codex"), dict) else None
    # collect_merged puts recommendation at top level, not under codex.
    rec = view.get("recommendation") or rec
    point["codex_5h_remaining"] = _num((rec or {}).get("remaining_5h"))
    point["codex_week_remaining"] = _num((rec or {}).get("remaining_week"))
    if not rec:
        current = next((a for a in (view.get("codex") or {}).get("accounts", []) if a.get("is_current")), None)
        for minutes, key in ((300, "codex_5h_remaining"), (10080, "codex_week_remaining")):
            point[key] = min((w["remaining"] for w in usable_windows(current or {})
                              if w["window_minutes"] == minutes), default=None)
    for key, prefix in (("glm", "glm"), ("antigravity", "agy")):
        provider = view.get(key) or {}
        fiveh, best = None, None
        for win in provider.get("windows") or []:
            pct = win.get("percent")
            if not isinstance(pct, (int, float)) or isinstance(pct, bool):
                continue
            remaining = max(0, min(100, 100 - pct))
            if best is None or remaining < best:
                best = remaining
            if "5h" in str(win.get("label", "")):
                fiveh = remaining if fiveh is None else min(fiveh, remaining)
        # 趋势专盯 5h 窗口（节拍器）；周窗口排空极慢，min 会把曲线拖成平线
        point[prefix + "_remaining"] = fiveh if fiveh is not None else best
    deep = view.get("deepseek") or {}
    balance = None
    for b in deep.get("balances") or []:
        try:
            balance = float(b.get("total_balance"))
            break
        except (TypeError, ValueError):
            continue
    point["deepseek_balance"] = balance
    point["codex_5h_tokens"] = _num((view.get("codex") or {}).get("tokens_5h"))
    point["glm_5h_used"] = _num((view.get("glm") or {}).get("five_hour_used"))
    muse = view.get("muse") or {}
    if muse.get("available"):
        five = muse.get("five_hour") or {}
        point["muse_5h_count"] = _num(five.get("requests"))
        point["muse_5h_tokens"] = _num(five.get("tokens"))
    else:
        # WSL 关闭/日志缺失时不记 0——假零会把趋势砸到归零；记 None 让画图跳过缺口
        point["muse_5h_count"] = None
        point["muse_5h_tokens"] = None
    return point


def append_history(view: dict, path: Path | None = None) -> bool:
    """Append one trend point. Never raises; returns success."""
    try:
        target = Path(path) if path else HISTORY_PATH
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(target, "a", encoding="utf-8") as f:
            f.write(json.dumps(extract_point(view), ensure_ascii=False) + "\n")
        _rotate(target)
        return True
    except OSError:
        return False


def _rotate(target: Path, keep: int = MAX_LINES) -> None:
    """防御：历史文件只增不减，超 MAX_LINES 即裁到最新 keep 行。"""
    try:
        lines = target.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    if len(lines) <= keep:
        return
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text("\n".join(lines[-keep:]) + "\n", encoding="utf-8")
    tmp.replace(target)


def load_history(days: int = MAX_DAYS, path: Path | None = None, now_ts: float | None = None) -> list[dict]:
    """Read points from the last ``days`` days (oldest first)."""
    target = Path(path) if path else HISTORY_PATH
    try:
        lines = target.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    cutoff = (now_ts if now_ts is not None else time.time()) - days * 86400
    out = []
    for line in lines[-2000:]:
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if not isinstance(item, dict) or "ts" not in item:
            continue
        try:
            ts = datetime.fromisoformat(str(item["ts"]).replace("Z", "+00:00")).timestamp()
        except (ValueError, TypeError, OverflowError):
            continue
        if ts >= cutoff:
            out.append(item)
    return out


def sparkline(values: list) -> str:
    """Unicode mini trend; gaps (None) are skipped."""
    nums = [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]
    if len(nums) < 2:
        return "暂无趋势"
    lo, hi = min(nums), max(nums)
    if hi == lo:
        return _SPARK[3] * min(len(nums), 12)
    out = ""
    for v in nums[-12:]:
        idx = int((v - lo) / (hi - lo) * (len(_SPARK) - 1))
        out += _SPARK[idx]
    return out
