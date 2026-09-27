"""Shared tray status text: refreshing tooltip + completion time."""
from __future__ import annotations

from datetime import datetime, timezone

from .brand import APP_NAME
from .icon import overall_remaining, per_source_remaining

REFRESHING_TEXT = "刷新中…"


def _local_hms(value: datetime | None = None) -> str:
    dt = value or datetime.now(timezone.utc)
    return dt.astimezone().strftime("%H:%M:%S")


def format_tooltip(view: dict, completed_at: datetime | None = None) -> str:
    """Completed tooltip: quota summary + completion time (<=127 chars)."""
    muse = view.get("muse") or {}
    count = (muse.get("five_hour") or {}).get("requests") if muse.get("available") else None
    sources = " | ".join(f"{name} 剩{remaining:.0f}%" for name, remaining in per_source_remaining(view))
    if count is not None:
        sources += f" | Muse过去5h {count}条"
    stamp = _local_hms(completed_at)
    if sources:
        return (f"{APP_NAME} · 已验证配额: {sources}（{stamp}更新）")[:127]
    return f"{APP_NAME}：暂无可验证配额（{stamp}更新）"[:127]


def windows_tooltip(view: dict, completed_at: datetime | None = None) -> str:
    """Localize before enforcing Windows' 127 UTF-16-unit tooltip limit."""
    from .i18n import tr
    text = tr(format_tooltip(view, completed_at))
    return text.encode('utf-16-le')[:254].decode('utf-16-le', errors='ignore')


def last_refresh_row(completed_at: datetime | None) -> str:
    if completed_at is None:
        return "上次刷新：尚未刷新"
    if isinstance(completed_at, datetime):
        return "上次刷新：" + completed_at.astimezone().strftime("%m-%d %H:%M:%S")
    return "上次刷新：" + str(completed_at)
