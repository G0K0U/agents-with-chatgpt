"""Detect which AI sources actually exist on this machine.

Visibility policy (v2 self-check):
- A source is *visible* only when there is real evidence it exists here
  (files on disk / signed-in account) or it is an API source whose token
  the user configured.
- Detection is sticky: once a source has been seen it stays visible until
  the user hides it via ``hidden_sources`` — a stopped WSL distro or a
  closed IDE must never make an installed source vanish mid-session.
- Cheap checks run every refresh and only ever *upgrade* visibility;
  ``full=True`` re-probes the expensive signals (WSL) as well.
"""
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from .common import DATA_DIR, now_utc, read_json, write_json

CACHE_PATH = DATA_DIR / "capabilities.json"
STICKY_TTL = 14 * 86400  # sticky entries older than this may expire
MUSE_PROBE_TTL = 600  # seconds between expensive WSL probes

_KEYS = ("codex", "glm", "deepseek", "muse", "antigravity")
KEY_ORDER = _KEYS  # 公开常量：collect/merge 按此顺序对齐可见性映射
_muse_probe_ts = 0.0
_muse_probe_result = False  # WSL 探测结果缓存（与 _muse_probe_ts 配对）


def _codex_evidence(home: Path) -> str | None:
    return "~/.codex/auth.json" if (home / ".codex" / "auth.json").is_file() else None


def _antigravity_evidence(home: Path) -> str | None:
    base = home / ".gemini"
    if not base.is_dir():
        return None
    for child in base.glob("antigravity*/conversations"):
        if child.is_dir():
            return f"~/.gemini/{child.parent.name}/conversations"
    return None


def _muse_native_evidence(home: Path) -> str | None:
    native = home / ".local" / "share" / "muse" / "sessions"
    return "~/.local/share/muse/sessions" if native.is_dir() else None


def _muse_wsl_evidence() -> str | None:
    """Windows-only: probe running WSL distros for Muse session dirs.

    Expensive (spawns wsl.exe + UNC walks) — caller throttles via MUSE_PROBE_TTL.
    """
    if sys.platform != "win32":
        return None
    from .providers.muse import _default_roots
    return "WSL 发行版内的 Muse 会话目录" if _default_roots() else None


def _load_sticky(cache_path: Path | None = None) -> dict:
    data = read_json(cache_path or CACHE_PATH, {}) or {}
    return data.get("sources", {}) if isinstance(data, dict) else {}


def _save_sticky(sticky: dict, cache_path: Path | None = None) -> None:
    write_json(cache_path or CACHE_PATH, {"sources": sticky, "saved_at": now_utc().isoformat()})


def _upgrade(sticky: dict, key: str, evidence: str) -> None:
    now = now_utc().isoformat()
    entry = sticky.get(key) or {}
    sticky[key] = {"installed": True, "evidence": evidence,
                   "first_seen": entry.get("first_seen") or now, "last_seen": now}


def _sticky_alive(entry: dict) -> bool:
    try:
        last = datetime.fromisoformat(str(entry.get("last_seen")).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return False
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return 0 <= (datetime.now(timezone.utc) - last).total_seconds() < STICKY_TTL


def detect(cfg: dict | None = None, full: bool = False, home: Path | None = None,
           cache_path: Path | None = None) -> dict:
    """Return ``{key: {"installed", "configured", "visible", "evidence", ...}}``.

    Never raises; probe failures simply count as "no evidence this round".
    """
    cfg = cfg or {}
    home = home or Path.home()
    sticky = _load_sticky(cache_path)
    global _muse_probe_ts

    result = {}
    for key in _KEYS:
        hidden = key in (cfg.get("hidden_sources") or [])
        if key == "muse":
            enabled = (cfg.get("muse", {}) or {}).get("enabled", True)
        elif key == "antigravity":
            enabled = (cfg.get("antigravity", {}) or {}).get("enabled", True)
        else:
            enabled = True
        entry = sticky.get(key) or {}

        if key == "codex":
            evidence = _codex_evidence(home)
        elif key == "antigravity":
            evidence = _antigravity_evidence(home)
        elif key == "muse":
            evidence = _muse_native_evidence(home)
            if (home == Path.home() and not evidence and enabled and not hidden
                    and (full or time.time() - _muse_probe_ts > MUSE_PROBE_TTL)):
                global _muse_probe_result
                _muse_probe_result = bool(_muse_wsl_evidence())
                _muse_probe_ts = time.time()
            if home == Path.home() and not evidence and _muse_probe_result:
                evidence = "WSL Muse 会话目录"
        else:  # glm / deepseek — API services: existence == configured
            secret_field = "token" if key == "glm" else "api_key"
            evidence = "config" if (cfg.get(key, {}) or {}).get(secret_field) else None

        # sticky 只属于"磁盘证据类"来源（文件删了才能证伪）；API 类以配置为准
        disk_evidence_key = key in ("codex", "antigravity", "muse")
        installed = bool(evidence) or (disk_evidence_key and key in sticky and _sticky_alive(entry))
        if evidence and disk_evidence_key:
            _upgrade(sticky, key, evidence)

        result[key] = {
            "installed": installed,
            "evidence": evidence or entry.get("evidence") or "",
            "visible": installed and enabled and not hidden,
            "enabled": enabled,
            "hidden": hidden,
        }

    _save_sticky(sticky, cache_path)
    return result


def visible_keys(capabilities: dict) -> list[str]:
    return [k for k in _KEYS if (capabilities.get(k) or {}).get("visible")]


def rescan(cfg: dict | None = None, home: Path | None = None,
           cache_path: Path | None = None) -> dict:
    """菜单「重新检测数据源」入口：强制全量重探（含 WSL）。"""
    return detect(cfg=cfg, full=True, home=home, cache_path=cache_path)
