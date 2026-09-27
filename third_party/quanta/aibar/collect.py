"""Collect a full local snapshot from all providers.

自检系统接线：只采集本机实际存在的来源（capabilities.detect 裁决），
未安装的来源不产生任何采集开销，快照里携带 visible 映射供菜单/面板过滤。
"""
import threading

from .capabilities import KEY_ORDER, detect
from .common import DATA_DIR, now_utc, parse_ts, read_json, write_json
from .config import load_config
from .providers import antigravity, codex, deepseek, glm, muse

SNAPSHOT_PATH = DATA_DIR / "local_snapshot.json"

_COLLECT_LOCK = threading.Lock()


def _safe(fn, *args, previous=None, **kwargs):
    try:
        result = fn(*args, **kwargs)
    except Exception as exc:  # noqa: BLE001 - 单家失败不拖垮整张快照
        result = {"error": type(exc).__name__}
    if not isinstance(result, dict):
        result = {"error": "InvalidProviderResult"}
    failure = result.get("error") or result.get("quota_error")
    if not failure:
        return result
    # A failed refresh may retain the last sample for display, but its sample
    # time must never become the time of this failed collection attempt.
    old = previous if isinstance(previous, dict) else {}
    retained = {key: value for key, value in old.items()
                if key not in ("error", "quota_error", "refresh_error", "refresh_failed")}
    retained.update({"error": str(failure), "refresh_failed": True})
    return retained


def collect_local(cfg=None):
    with _COLLECT_LOCK:
        return _collect_local(cfg)


def _collect_local(cfg: dict | None = None) -> dict:
    cfg = cfg or load_config()
    previous = read_json(SNAPSHOT_PATH, {}) or {}
    if not isinstance(previous, dict):
        previous = {}
    caps = detect(cfg)
    visible = {key: bool((caps.get(key) or {}).get("visible")) for key in KEY_ORDER}

    snapshot = {
        "machine": cfg["machine_name"],
        "generated_at": now_utc().isoformat(),
        "visible": visible,
    }
    if visible["codex"]:
        snapshot["codex"] = _safe(codex.collect, previous=previous.get("codex"), labels=cfg.get("labels", {}).get("codex", {}))
    if visible["glm"]:
        snapshot["glm"] = _safe(glm.collect, previous=previous.get("glm"),
            platform=cfg.get("glm", {}).get("platform", "zai"),
            token=cfg.get("glm", {}).get("token", ""),
        )
    if visible["deepseek"]:
        snapshot["deepseek"] = _safe(deepseek.collect, previous=previous.get("deepseek"), api_key=cfg.get("deepseek", {}).get("api_key", ""))
    if visible["muse"]:
        snapshot["muse"] = _safe(muse.collect, previous=previous.get("muse"),
            roots=cfg.get("muse", {}).get("roots") or None,
            label=cfg.get("labels", {}).get("muse", "Muse Code"),
            enabled=cfg.get("muse", {}).get("enabled", True),
        )
    if visible["antigravity"]:
        snapshot["antigravity"] = _safe(antigravity.collect, previous=previous.get("antigravity"),
            roots=cfg.get("antigravity", {}).get("roots") or None,
            label=cfg.get("labels", {}).get("antigravity", "Antigravity"),
        )

    # Conservative: calculate oldest relevant sample time across quota providers
    provider_times = []
    for key in ("codex", "glm", "antigravity"):
        pdata = snapshot.get(key)
        if isinstance(pdata, dict) and not pdata.get("error"):
            obs = pdata.get("observed_at")
            if obs:
                dt = parse_ts(obs)
                if dt:
                    provider_times.append(dt)
    snapshot["observed_at"] = min(provider_times).isoformat() if provider_times else None
    # This is a display summary of the providers that supplied timestamps.
    # It cannot certify the age of a different provider's data.
    snapshot["observed_at_scope"] = "partial_summary"

    write_json(SNAPSHOT_PATH, snapshot)
    return snapshot


if __name__ == "__main__":
    snap = collect_local()
    print(snap.get("machine") or "")
    import json
    print(json.dumps(snap, ensure_ascii=False, indent=1))
