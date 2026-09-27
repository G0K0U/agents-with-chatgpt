"""Shared helpers for ai-quota-bar."""
import json
import os
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

DATA_DIR = Path(os.environ.get("AIBAR_DATA_DIR") or (Path.home() / ".aibar")).resolve()
STATE_DIR = DATA_DIR / "state"
_IO_LOCK = threading.RLock()


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def parse_ts(value: str) -> datetime | None:
    """Parse an ISO-8601 timestamp (with Z suffix) into aware UTC datetime."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    except (ValueError, AttributeError, TypeError):
        return None


def read_json(path: Path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path: Path, data) -> None:
    with _IO_LOCK:
        _write_json(path, data)


def _write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        for attempt in range(6):
            try:
                os.replace(tmp, path)
                break
            except PermissionError:
                if attempt == 5:
                    raise
                time.sleep(0.05)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def local_day_start(dt: datetime | None = None) -> datetime:
    local = (dt or now_utc()).astimezone()
    return local.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)


def ensure_dirs() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)


def fmt_reset(resets_at: int | None) -> str:
    """Human-readable countdown for a unix reset timestamp."""
    if not resets_at:
        return ""
    delta = datetime.fromtimestamp(resets_at, tz=timezone.utc) - now_utc()
    seconds = int(delta.total_seconds())
    if seconds <= 0:
        return "已重置"
    h, rem = divmod(seconds, 3600)
    m = rem // 60
    return f"{h}时{m:02d}分后重置" if h else f"{m}分钟后重置"


def week_start_utc(dt: datetime | None = None) -> datetime:
    dt = dt or now_utc()
    return (dt - timedelta(days=7)).replace(microsecond=0)
