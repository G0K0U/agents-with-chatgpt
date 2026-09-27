"""Account-bound live Codex quota, with explicitly unverified legacy history."""
import json
import time
from datetime import timedelta
from pathlib import Path

from ..common import STATE_DIR, now_utc, read_json, write_json, parse_ts
from . import codex_live

STATE_PATH = STATE_DIR / "codex_state.json"
WEB_SOURCE = "codex_web_email"


def _email_key(email):
    return "email:" + email.strip().casefold()


def _read_auth(auth_path: Path) -> dict:
    d = read_json(auth_path, {}) or {}
    tokens = d.get("tokens") or {}
    return {
        "account_id": tokens.get("account_id"),
        "last_refresh": parse_ts(d.get("last_refresh")),
    }


def _latest_snapshot_from_file(path: Path):
    """Return (event_ts, rate_limits) of the last token_count event in a rollout."""
    found = None
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                if '"rate_limits"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if d.get("type") != "event_msg":
                    continue
                p = d.get("payload") or {}
                rl = p.get("rate_limits")
                if not isinstance(rl, dict) or rl.get("limit_id") not in (None, "codex"):
                    continue
                ts = parse_ts(d.get("timestamp"))
                if ts and (rl.get("primary") or rl.get("secondary")):
                    found = (ts, rl)
    except OSError:
        return None
    return found


def _scan_sessions(codex_dir: Path, max_age_days: int = 8):
    """Yield (event_ts, rate_limits) snapshots from recent rollout files."""
    sessions = codex_dir / "sessions"
    if not sessions.is_dir():
        return
    cutoff = time.time() - max_age_days * 86400
    files = []
    for path in sessions.rglob("rollout-*.jsonl"):
        try:
            modified = path.stat().st_mtime
        except OSError:
            continue
        if modified >= cutoff:
            files.append((modified, path))
    files = [p for _, p in sorted(files, key=lambda item: item[0], reverse=True)]
    for path in files[:200]:
        snap = _latest_snapshot_from_file(path)
        if snap:
            yield snap


def _normalize(ts, rl) -> dict:
    primary, secondary = rl.get("primary") or {}, rl.get("secondary") or {}
    now_ts = now_utc().timestamp()
    primary_reset = primary.get("resets_at")
    # A passed reset time invalidates this observation; it does not prove zero use.
    effective_primary = (
        None if (primary_reset and primary_reset <= now_ts) else primary.get("used_percent")
    )
    return {
        "plan_type": rl.get("plan_type") or "",
        "primary_used_percent": primary.get("used_percent"),
        "effective_primary_used_percent": effective_primary,
        "primary_reset_done": bool(primary_reset and primary_reset <= now_ts),
        "primary_resets_at": primary_reset,
        "primary_window_minutes": primary.get("window_minutes"),
        "secondary_used_percent": secondary.get("used_percent"),
        "secondary_resets_at": secondary.get("resets_at"),
        "secondary_window_minutes": secondary.get("window_minutes"),
        "snapshot_at": ts.isoformat(),
        "snapshot_ts": ts.timestamp(),
    }


def _latest_tokens_from_file(path: Path):
    """Return (event_ts, total_tokens) of the last token_count event in a rollout."""
    found = None
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                if '"total_token_usage"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if d.get("type") != "event_msg":
                    continue
                info = (d.get("payload") or {}).get("info") or {}
                usage = info.get("total_token_usage") or {}
                total = usage.get("total_tokens")
                ts = parse_ts(d.get("timestamp"))
                if ts and isinstance(total, (int, float)):
                    found = (ts, total)
    except OSError:
        return None
    return found


def tokens_5h(codex_dir: Path | None = None, now=None) -> int | None:
    """Token 消耗（最近 5 小时，滚动窗口）＝近 5h 内有活动的 rollout 文件的
    会话累计 token 之和。本地只读，无网络请求；无数据返回 None。"""
    codex_dir = codex_dir or Path.home() / ".codex"
    sessions = codex_dir / "sessions"
    if not sessions.is_dir():
        return None
    now_ts = now_utc().timestamp()
    cutoff = now_ts - 6 * 3600  # 略宽于 5h 窗口，容忍文件 mtime 误差
    total = 0
    counted = 0
    for path in sessions.rglob("rollout-*.jsonl"):
        try:
            if path.stat().st_mtime < cutoff:
                continue
        except OSError:
            continue
        snap = _latest_tokens_from_file(path)
        if snap and snap[0].timestamp() >= now_ts - 5 * 3600:
            total += int(snap[1])
            counted += 1
    return total if counted else None


def collect(codex_dir: Path | None = None, labels: dict | None = None) -> dict:
    codex_dir = codex_dir or Path.home() / ".codex"
    labels = labels or {}
    auth = _read_auth(codex_dir / "auth.json")
    current_id = auth.get("account_id")
    state = read_json(STATE_PATH, {}) or {"accounts": {}, "current_account_id": None}

    snapshots = sorted(_scan_sessions(codex_dir), key=lambda s: s[0].timestamp(), reverse=True)

    accounts: dict[str, dict] = state.get("accounts", {})
    # Legacy state used a time heuristic that could attach another account's
    # snapshot. Retain these entries as history, but do not certify ownership.
    for key, account in accounts.items():
        verified_web = (account.get("verification_source") == WEB_SOURCE
                        and account.get("email")
                        and key == _email_key(account["email"]))
        if account.get("verification_source") != codex_live.SOURCE and not verified_web:
            account["attribution_verified"] = False
    latest_unattributed = _normalize(*snapshots[0]) if snapshots else None

    live_error = None
    try:
        observed = codex_live.read_verified(codex_dir)
        if observed["account_id"] != current_id:
            raise codex_live.QuotaReadError("Signed-in account changed before collection")
        # A web observation proves its email, not a historical account UUID.
        # Replace that email-only row once the official service supplies its ID.
        accounts.pop(_email_key(observed["email"]), None)
        accounts[current_id] = {
            **_normalize(observed["observed_at"], observed["rate_limits"]),
            "email": observed["email"], "attribution_verified": True,
            "verification_source": codex_live.SOURCE,
        }
    except codex_live.QuotaReadError as exc:
        live_error = str(exc)
    except Exception as exc:
        live_error = type(exc).__name__

    # Keep only fresh entries (drop snapshots older than 8 days).
    cutoff_ts = now_utc().timestamp() - 8 * 86400
    accounts = {k: v for k, v in accounts.items() if v.get("snapshot_ts", 0) >= cutoff_ts}
    for account_id in labels:
        if account_id.startswith("email:") and any(
                a.get("attribution_verified") and a.get("email")
                and _email_key(a["email"]) == account_id for a in accounts.values()):
            continue
        accounts.setdefault(account_id, {"attribution_verified": False})
    state["accounts"] = accounts
    state["current_account_id"] = current_id
    write_json(STATE_PATH, state)

    out = []
    for acct_id, snap in accounts.items():
        out.append({
            **snap,
            "account_id": acct_id,
            "label": snap.get("email") or labels.get(acct_id, f"号{acct_id[-4:]}" if acct_id else "未知"),
            "is_current": acct_id == current_id,
        })
    out.sort(key=lambda a: -(a.get("effective_primary_used_percent") if a.get("effective_primary_used_percent") is not None else -1))
    observed_at = None
    current_acc = next((a for a in out if a.get("is_current")), None)
    if current_acc and current_acc.get("snapshot_at"):
        observed_at = current_acc.get("snapshot_at")
    return {"provider": "codex", "observed_at": observed_at,
            "observed_at_scope": "current_account" if observed_at else None,
            "accounts": out, "latest_unattributed": latest_unattributed,
            "live_error": live_error, "tokens_5h": tokens_5h(codex_dir),
            "note": "当前账号用量通过 Codex 服务核验；其他账号显示最近已核验读数或等待登录"}
