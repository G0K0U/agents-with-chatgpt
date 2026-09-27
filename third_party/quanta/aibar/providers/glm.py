"""GLM Coding Plan quota via Z.ai / BigModel's OFFICIAL usage endpoint.

Same endpoint as the official glm-plan-usage plugin published by zai-org
(zai-coding-plugins repo): GET {base}/api/monitor/usage/quota/limit with the
account's own token as raw Authorization header.

A plan account returns MULTIPLE windows (e.g. Lite: a 5-hour window plus a
weekly window, field level="lite"). Free/trial credit pools are NOT part of
this response — plan windows are what gate usage, so those are what we show.
"""
import json
import time
import urllib.parse
import urllib.request

from ..common import now_utc
from ..http_client import official_opener, read_object

# Observed shapes: (unit=3, number=5) → 5h window, (unit=6, number=1) → weekly.
# Preserve an unknown window's type rather than inventing its duration.
_WINDOW_LABELS = {(3, 5): "5h窗口", (6, 1): "周窗口"}
_OPENER = official_opener()


def _classify(item: dict) -> str:
    label = _WINDOW_LABELS.get((item.get("unit"), item.get("number")))
    if label:
        return label
    return f"{item.get('type', '未知')} (unit={item.get('unit', '?')}, number={item.get('number', '?')})"


def collect(platform: str = "zai", token: str = "") -> dict:
    if not token:
        return {"error": "未配置 GLM token（config.json → glm.token）"}
    if platform == "bigmodel":
        url = "https://open.bigmodel.cn/api/monitor/usage/quota/limit"
    else:
        url = "https://api.z.ai/api/monitor/usage/quota/limit"
    # 仅允许两家官方主机，防止任何其他目标被请求
    if urllib.parse.urlparse(url).hostname not in ("api.z.ai", "open.bigmodel.cn"):
        return {"error": "blocked: non-official GLM host"}
    req = urllib.request.Request(url, headers={
        "Authorization": token,
        "Accept": "application/json",
        "User-Agent": "ai-quota-bar/0.1",
    })
    try:
        with _OPENER.open(req, timeout=15) as resp:
            data = read_object(resp)
    except Exception as e:  # noqa: BLE001 - report any failure in the snapshot
        return {"error": type(e).__name__}

    payload = data.get("data") or data
    windows = []
    for item in payload.get("limits") or []:
        pct = item.get("percentage")
        if pct is None:
            continue
        windows.append({
            "label": _classify(item),
            "type": item.get("type"),
            "percent": pct,
            "used": item.get("currentValue"),
            "quota": item.get("usage"),
            "remaining": item.get("remaining"),
            "reset_at": int(item["nextResetTime"] / 1000) if item.get("nextResetTime") else None,
        })
    windows.sort(key=lambda w: w["percent"], reverse=True)
    five_used = next((w.get("used") for w in windows if "5h" in str(w.get("label", ""))), None)
    obs_now = now_utc().isoformat()
    return {
        "level": payload.get("level"),
        "windows": windows,
        "five_hour_used": five_used,  # 官方用量单位的已用量（非 token，单位未公开）
        "tokens_5h_percent": next((w["percent"] for w in windows if w["label"] == "5h窗口"), None),
        "observed_at": obs_now,
        "updated_at": obs_now,
    }
