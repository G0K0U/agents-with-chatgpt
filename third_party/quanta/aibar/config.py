"""Config loading for ai-quota-bar. Config lives in ~/.aibar/config.json."""
import json
import secrets
from copy import deepcopy
from pathlib import Path

from .common import DATA_DIR, ensure_dirs, read_json, write_json

CONFIG_PATH = DATA_DIR / "config.json"

DEFAULT_CONFIG = {
    "machine_name": "",
    "server": {"host": "127.0.0.1", "port": 8765, "token": ""},
    # Other machine's collector: [{"name": "mac", "url": "http://100.x.y.z:8765", "token": "..."}]
    "peers": [],
    "refresh_seconds": 300,
    "labels": {
        "codex": {},      # account_id -> "1号" / "2号" ...
        "muse": "Muse Code",
        "antigravity": "Antigravity"
    },
    # GLM Coding Plan: token = the ANTHROPIC_AUTH_TOKEN you use with z.ai / bigmodel
    "glm": {"platform": "zai", "token": ""},
    "deepseek": {"api_key": ""},
    # Muse Code: passive local log reader. roots=[] auto-discovers the native
    # ~/.local/share/muse path plus every WSL distro via \\wsl.localhost.
    # Set "enabled": false to hide the Muse line entirely.
    "muse": {"roots": [], "enabled": True},
    # Google Antigravity: quota via local language server while it runs.
    "antigravity": {"roots": [], "enabled": True},
    # 自检系统：手动隐藏的来源（如 ["glm"]）；未填 token/key 的 API 来源自动隐藏
    "hidden_sources": [],
    # 看门狗：每 N 秒自检服务器/采集线程/图标活性并自愈（默认 10 分钟）
    "watchdog_seconds": 600,
    # Menu bar text template (macOS). {openai} {glm} {deepseek}
    "menubar_template": "AI {openai} | G{glm}",
}


def load_config() -> dict:
    ensure_dirs()
    if CONFIG_PATH.exists():
        try:
            cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as exc:
            raise ValueError("Cannot read config.json; existing configuration was preserved") from exc
        if not isinstance(cfg, dict):
            raise ValueError("config.json must contain an object")
        for key in ("server", "glm", "deepseek", "muse", "antigravity", "labels"):
            if key in cfg and not isinstance(cfg[key], dict):
                raise ValueError(f"config.json: {key} must contain an object")
    else:
        cfg = deepcopy(DEFAULT_CONFIG)
        cfg["server"]["token"] = secrets.token_hex(16)
        write_json(CONFIG_PATH, cfg)
        print(f"[aibar] 已生成默认配置: {CONFIG_PATH}（请填入 tokens / peers 后重启）")
    merged = _merge(DEFAULT_CONFIG, cfg)
    if not merged["server"]["token"]:
        merged["server"]["token"] = secrets.token_hex(16)
        write_json(CONFIG_PATH, merged)
    if not merged["machine_name"]:
        import platform
        merged["machine_name"] = platform.node() or "this-machine"
    import sys
    if sys.platform == "darwin":
        from .connections_mac import overlay
        merged = overlay(merged)
    elif sys.platform == "win32":
        from .connections_windows import overlay
        merged = overlay(merged)
    return merged


def save_config(cfg: dict) -> None:
    clean = deepcopy(cfg)
    protected = clean.pop('_secure_providers', [])
    clean.pop('_connection_errors', None)
    # A runtime overlay must never be serialized into plaintext settings.
    if protected:
        original = json.loads(CONFIG_PATH.read_text(encoding='utf-8-sig')) if CONFIG_PATH.exists() else {}
        for provider in protected:
            field = 'token' if provider == 'glm' else 'api_key'
            clean.setdefault(provider, {})[field] = original.get(provider, {}).get(field, '')
            if provider == 'glm':
                clean[provider]['platform'] = original.get(provider, {}).get('platform', 'zai')
    write_json(CONFIG_PATH, clean)


def _merge(base: dict, override: dict) -> dict:
    out = deepcopy(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out
