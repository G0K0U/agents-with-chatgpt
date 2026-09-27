"""Merge snapshots without promoting stale or unverified data to quota advice."""
import ipaddress
import json
import time
import urllib.parse
import urllib.request
from copy import deepcopy

from .common import read_json, now_utc, parse_ts
from .collect import SNAPSHOT_PATH, collect_local
from .config import load_config
from .http_client import read_object
from .codex_windows import account_windows, usable_windows


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_peer(peer):
    try:
        parsed = urllib.parse.urlsplit(peer["url"])
        ip = ipaddress.ip_address(parsed.hostname)
        if (parsed.scheme != "http" or parsed.username or parsed.password or parsed.query or
                parsed.fragment or parsed.path not in ("", "/") or ip.version != 4 or
                not (ip.is_loopback or ip in ipaddress.ip_network("100.64.0.0/10"))):
            raise ValueError("Peer URL must use a loopback or Tailscale IPv4 address")
        req = urllib.request.Request(peer["url"].rstrip("/") + "/api/usage",
                                     headers={"X-Token": peer.get("token", "")})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        with opener.open(req, timeout=6) as resp:
            value = read_object(resp)
        if not isinstance(value, dict):
            raise ValueError("Invalid peer snapshot")
        return value
    except Exception as exc:
        return {"machine": peer.get("name", "peer"), "error": type(exc).__name__, "generated_at": None}


def _stamp(value):
    parsed = parse_ts(value)
    return parsed.timestamp() if parsed else 0


def normalize_account(account, now_ts=None):
    a = deepcopy(account)
    now_ts = time.time() if now_ts is None else now_ts
    a["stale"] = not 0 <= now_ts - (a.get("snapshot_ts") or 0) <= 900
    for key in ("primary", "secondary"):
        reset = a.get(key + "_resets_at")
        expired = bool(reset and reset <= now_ts)
        a[key + "_reset_done"] = expired
        used = a.get(key + "_used_percent")
        a["effective_" + key + "_used_percent"] = None if expired else used
    return a


def merge_snapshots(local, peers):
    merged = {"machines": [], "codex": {"accounts": [], "tokens_5h": None}, "glm": None,
              "deepseek": None, "antigravity": None, "visible": {}, "merged_at": now_utc().isoformat()}
    for key in ("muse",):
        merged[key] = {"label": "Muse Code", "week_7d_tokens": 0,
                       "today_tokens": 0, "available": False, "disabled": True,
                       "five_hour": {"tokens": 0, "requests": 0, "percent": None,
                                     "window_kind": "rolling_activity"}, "errors": []}
    accounts = {}
    local_current = {a.get("account_id") for a in (local.get("codex") or {}).get("accounts", [])
                     if a.get("is_current")}
    seen_machines = set()
    for index, snap in enumerate([local] + list(peers)):
        if not isinstance(snap, dict):
            continue
        machine = snap.get("machine") or f"peer-{index}"
        if machine in seen_machines:
            continue
        seen_machines.add(machine)
        # 可见性跨机 OR：任一机器检测到该来源即视为可见
        for key, flag in (snap.get("visible") or {}).items():
            merged["visible"][key] = merged["visible"].get(key, False) or bool(flag)
        snapshot_age = time.time() - _stamp(snap.get("generated_at"))
        fresh = 0 <= snapshot_age <= 900
        merged["machines"].append({"name": machine, "generated_at": snap.get("generated_at"),
                                   "ok": "error" not in snap and fresh, "error": snap.get("error"),
                                   "stale": not fresh})
        cx = snap.get("codex") or {}
        cx_tokens = cx.get("tokens_5h")
        if cx_tokens is not None:  # 同一账号在多机的本地 token 消耗求和
            merged["codex"]["tokens_5h"] = (merged["codex"].get("tokens_5h") or 0) + cx_tokens
        unassigned = cx.get("latest_unattributed")
        old = merged["codex"].get("latest_unattributed")
        if unassigned and (not old or unassigned.get("snapshot_ts", 0) > old.get("snapshot_ts", 0)):
            merged["codex"]["latest_unattributed"] = normalize_account(unassigned)
        for account in cx.get("accounts", []):
            key = account.get("account_id")
            if not key:
                continue
            prev = accounts.get(key)
            seen_on = sorted(set((prev or {}).get("seen_on", []) + [machine]))
            if prev is None or account.get("snapshot_ts", 0) >= prev.get("snapshot_ts", 0):
                accounts[key] = normalize_account(account)
            accounts[key]["seen_on"] = seen_on
            accounts[key]["is_current"] = key in local_current
        for key in ("muse",):
            value, dest = snap.get(key) or {}, merged[key]
            dest["label"] = value.get("label") or dest["label"]
            dest["disabled"] = dest["disabled"] and bool(value.get("disabled", False))
            if value.get("error"):
                dest["errors"].append(f"{machine}: {value['error']}")
            if not fresh or value.get("error"):
                continue
            dest["available"] = dest["available"] or bool(value.get("available"))
            dest["week_7d_tokens"] += value.get("week_7d_tokens") or 0
            dest["today_tokens"] += value.get("today_tokens") or 0
            five = value.get("five_hour") or {}
            for count in ("tokens", "requests"):
                dest["five_hour"][count] += five.get(count) or 0
            dest["cap_note"] = value.get("cap_note", "本地活动统计；官方剩余额度未知")
        for key in ("glm", "deepseek", "antigravity"):
            val = snap.get(key)
            if not isinstance(val, dict):
                continue
            val = deepcopy(val)
            val["stale"] = not fresh
            stamp = _stamp(val.get("updated_at") or snap.get("generated_at"))
            cur = merged[key]
            # Preserve current failures rather than silently showing an older success.
            if not cur or stamp >= cur.get("_merge_stamp", 0):
                val["_merge_stamp"] = stamp
                merged[key] = val
    merged["codex"]["accounts"] = list(accounts.values())
    merged["codex"]["live_error"] = (local.get("codex") or {}).get("live_error")
    candidates = []
    for account in accounts.values():
        windows = account_windows(account)
        if (windows and len(usable_windows(account)) == len(windows) and
                all(w["window_minutes"] is not None and w["remaining"] > 0 for w in windows)):
            candidates.append(account)
    # Do not recommend switching between unlike reported quota schedules.
    current = next((a for a in accounts.values() if a.get("is_current")), None)
    if current:
        schedule = [w["window_minutes"] for w in account_windows(current)]
        candidates = [a for a in candidates if [w["window_minutes"] for w in account_windows(a)] == schedule]
    if candidates:
        best = max(candidates, key=lambda a: min(w["remaining"] for w in usable_windows(a)))
        windows = usable_windows(best)
        remaining = {}
        for window in windows:
            minutes, value = window["window_minutes"], round(window["remaining"], 1)
            remaining[minutes] = min(value, remaining.get(minutes, value))
        merged["recommendation"] = {"label": best.get("label"), "account_id": best.get("account_id"),
                                    "plan_type": best.get("plan_type"), "windows": windows,
                                    "remaining_5h": remaining.get(300), "remaining_week": remaining.get(10080),
                                    "is_current": best.get("is_current")}
    return merged


def collect_merged(cfg=None):
    cfg = cfg or load_config()
    view = merge_snapshots(collect_local(cfg), [fetch_peer(p) for p in cfg.get("peers", [])])
    if not cfg.get("codex", {}).get("show_unattributed", True):
        view["codex"].pop("latest_unattributed", None)
    return view


def load_local_snapshot():
    return read_json(SNAPSHOT_PATH)
