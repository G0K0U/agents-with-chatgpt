"""Detail panel: HTML built from the existing collect/merge view.

No network here by design — callers pass a view from
``aibar.merge.collect_merged`` plus history from ``aibar.history``.
Window backends (pywebview preferred, tkinter fallback) only display it;
closing the window never stops the tray.
"""
from __future__ import annotations

import base64
import html
import re
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from .brand import APP_NAME, TAGLINE, WINDOW_TITLE, ASSETS
from .common import DATA_DIR, fmt_reset, parse_ts
from .history import load_history
from .icon import overall_remaining

SOURCES_ORDER = ("codex", "glm", "deepseek", "muse", "antigravity")

_EMAIL_RE = re.compile(r"([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+)")


def _mask_email(text: str) -> str:
    return _EMAIL_RE.sub(r"\1***\2", text or "")


def _humanize_ts(value) -> str:
    """ISO 时间串 → “N 分钟前”；解析失败原样返回。"""
    dt = parse_ts(value) if isinstance(value, str) else None
    if dt is None:
        return value or "未知"
    from .common import now_utc
    secs = int((now_utc() - dt).total_seconds())
    if secs < 0:
        secs = 0
    if secs < 60:
        return "刚刚"
    if secs < 3600:
        return f"{secs // 60} 分钟前"
    if secs < 86400:
        return f"{secs // 3600} 小时前"
    return f"{secs // 86400} 天前"

_TITLES = {
    "codex": "Codex",
    "glm": "GLM",
    "deepseek": "DeepSeek",
    "muse": "Muse",
    "antigravity": "Antigravity",
}

_SOURCE_NOTES = {
    "codex": "数据来源：本机 Codex 官方服务核验（只读，不发起模型调用）",
    "glm": "数据来源：官方 quota 接口的本机查询结果",
    "deepseek": "数据来源：官方余额接口的本机查询结果；余额制，本就无百分比",
    "muse": "数据来源：本地会话用户消息计数；计数制，本就无官方百分比",
    "antigravity": "数据来源：本机语言服务器配额（运行时）＋本地会话库计数",
}

_TREND_KEYS = {
    "codex": "codex_5h_tokens",
    "glm": "glm_5h_used",
    "deepseek": "deepseek_balance",
    "muse": "muse_5h_tokens",
    "antigravity": "agy_remaining",
}

_TREND_UNITS = {
    "codex": "token",
    "glm": "官方用量单位",
    "deepseek": "余额",
    "muse": "token",
    "antigravity": "剩余%",
}

# 单位 → Y 轴颜色：同单位同色，扫一眼就知道这张图量的是什么
_UNIT_COLORS = {
    "token": "#a371f7",        # 紫：token 消耗
    "剩余%": "#d29922",        # 橙：官方窗口剩余比例
    "官方用量单位": "#58a6ff",  # 蓝：GLM 官方计数字段
    "余额": "#3fb950",         # 绿：钱包里的钱
}


def _esc(value) -> str:
    return html.escape("" if value is None else str(value), quote=True)


def _codex_card(view: dict) -> dict:
    from .codex_windows import plan_label, usable_windows
    rec = view.get("recommendation") or {}
    cx = view.get("codex") or {}
    accounts = cx.get("accounts") or []
    bars = []
    if accounts:
        for a in accounts[:3]:
            lbl = (plan_label(a) + " " + _mask_email(a.get("label", "?"))).strip()
            for window in usable_windows(a):
                bars.append((f"{lbl} {window['label']}", window["used_percent"]))
    if rec:
        value = f"当前最优：{plan_label(rec)} {_mask_email(rec.get('label', ''))}"
    elif bars:
        value = f"{len(accounts)} 个账号在档 · 窗口剩余见下"
    else:
        value = "近 8 天无快照：未登录或日志已过期"
    resets = [w["resets_at"] for a in accounts for w in usable_windows(a) if w.get("resets_at")]
    reset = fmt_reset(min(resets)) if resets else "无固定重置（见各账号窗口）"
    updated = (accounts[0].get("snapshot_at") if accounts else None) or view.get("merged_at") or "未知"
    return {"key": "codex", "value": value, "reset": reset, "bars": bars,
            "updated": updated}


def _windows_card(key: str, view: dict, empty_hint: str) -> dict:
    provider = view.get(key) or {}
    windows = provider.get("windows") or []
    if provider.get("error"):
        value = "读取失败：" + str(provider.get("error"))
        if "未配置" in str(provider.get("error")):
            value += "（未配置 token）"
    elif provider.get("stale"):
        value = "旧快照，等待更新"
    elif windows:
        parts = []
        for w in windows:
            pct = w.get("percent")
            parts.append(f"{w.get('label', '?')} 剩 {100 - pct:.0f}%" if pct is not None else f"{w.get('label', '?')} 未知")
        value = "；".join(parts)
    elif key == "antigravity" and provider.get("available"):
        value = "IDE 未运行，仅显示本地计数"
    elif key == "antigravity":
        value = str(provider.get("note") or empty_hint)
    else:
        value = empty_hint
    resets = [w.get("reset_at") for w in windows if w.get("reset_at")]
    reset = fmt_reset(min(resets)) if resets else ("余额制，无重置" if key == "deepseek" else "未知或等待刷新")
    if key == "antigravity" and not resets and provider.get("available"):
        reset = f"本地计数持续更新；配额需 IDE 运行时读取"
    bars = [(w.get("label", "?"), w.get("percent")) for w in windows if w.get("percent") is not None]
    return {"key": key, "value": value, "reset": reset, "bars": bars,
            "updated": provider.get("updated_at") or view.get("merged_at") or "未知"}


def _deepseek_card(view: dict) -> dict:
    d = view.get("deepseek") or {}
    if d.get("error"):
        value = "读取失败：" + str(d.get("error"))
        if "未配置" in str(d.get("error")):
            value += "（未配置 token）"
        value += "；余额制，本就无百分比"
    else:
        balances = " · ".join(f"{b.get('total_balance')} {b.get('currency')}" for b in d.get("balances", []))
        value = "余额 " + (balances or "未知")
        if d.get("stale"):
            value += "（旧快照）"
    return {"key": "deepseek", "value": value, "reset": "余额制，无重置",
            "updated": d.get("updated_at") or view.get("merged_at") or "未知"}


def _muse_card(view: dict) -> dict:
    m = view.get("muse") or {}
    if m.get("disabled"):
        value = "已在配置中禁用，不显示计数"
    elif m.get("available"):
        count = (m.get("five_hour") or {}).get("requests", 0)
        value = (f"过去 5 小时 {count} 条 · 今日 {m.get('today_tokens', 0):,} tok · "
                 f"近 7 天 {m.get('week_7d_tokens', 0):,} tok")
    else:
        value = "未检测到可读日志（WSL 未运行或尚未使用）"
    return {"key": "muse", "value": value, "reset": "滚动 5 小时窗口",
            "updated": m.get("updated_at") or view.get("merged_at") or "未知"}


_PILLS = {
    "codex": "已核验",
    "glm": "官方配额",
    "deepseek": "余额制",
    "muse": "计数制",
    "antigravity": "运行时配额",
}


def source_cards(view: dict) -> list[dict]:
    """按可见性过滤后的卡片（自检系统：未安装的来源彻底不出现）。"""
    view = view or {}
    cards = [_codex_card(view)]
    cards.append(_windows_card("glm", view, "暂无官方配额窗口"))
    cards.append(_deepseek_card(view))
    cards.append(_muse_card(view))
    agy = _windows_card("antigravity", view, "暂无官方配额窗口")
    if (view.get("antigravity") or {}).get("available"):
        conv = (view.get("antigravity") or {}).get("conversations", 0)
        gen = (view.get("antigravity") or {}).get("generations", 0)
        agy["value"] += f"；本地会话 {conv} · 生成 {gen} 次"
    cards.append(agy)
    for card in cards:
        card["title"] = _TITLES[card["key"]]
        card["source"] = _SOURCE_NOTES[card["key"]]
        card["pill"] = _PILLS[card["key"]]
    # 自检过滤：快照带 visible 映射时，未启用的来源不出卡片
    visible_map = view.get("visible") or {}
    if visible_map:
        cards = [c for c in cards if visible_map.get(c["key"], True)]
    return cards


def _addable_hint(view: dict, *, mac_native=False) -> str:
    """未配置的 API 类来源（GLM/DeepSeek）在页脚给出添加指引。"""
    visible_map = view.get("visible") or {}
    if not visible_map:
        return ""
    addable = [name for key, name in (("glm", "GLM"), ("deepseek", "DeepSeek"))
               if not visible_map.get(key, True)]
    if not addable:
        return ""
    if mac_native:
        return "可连接的服务：" + " · ".join(addable)
    return "可添加数据源：" + " · ".join(addable) + " —— 在 ~/.aibar/config.json 填入 token 后自动出现"


def _bars_html(bars: list | None) -> str:
    """窗口进度条：填充长度=剩余比例，颜色=紧急度（绿>50>黄>20>红）。"""
    if not bars:
        return ""
    out = ['<div class="bars">']
    for label, used in bars:
        remaining = max(0.0, min(100.0, 100 - used))
        cls = "ok" if remaining > 50 else ("warn" if remaining > 20 else "bad")
        out.append(
            f'<div class="brow"><span class="blabel">{_esc(label)}</span>'
            f'<div class="bar"><div class="fill {cls}" style="width:{remaining:.0f}%"></div></div>'
            f'<span class="bpct">剩 {remaining:.0f}%</span></div>'
        )
    out.append("</div>")
    return "".join(out)


def _fmt_val(v: float) -> str:
    """紧凑数值标签：1234567 → 1.2M，1234 → 1.2k，71 → 71"""
    if abs(v) >= 1e9:
        return f"{v / 1e9:.1f}G"
    if abs(v) >= 1e6:
        return f"{v / 1e6:.1f}M"
    if abs(v) >= 1e3:
        return f"{v / 1e3:.1f}k"
    return f"{v:.0f}"


def _svg_trend(values: list, width: int = 240, height: int = 56,
               axis_color: str = "#8b949e", line_color: str | None = None) -> str:
    """近 7 天趋势 → 平滑弧线 SVG：带 Y 轴刻度、网格线、渐变面积与端点圆点。
    少于 2 个数据点返回空。"""
    pts = [v for v in values if isinstance(v, (int, float))]
    if len(pts) < 2:
        return ""
    if len(pts) > 40:  # 抽稀到 ~40 个点，弧线足够平滑
        step = len(pts) / 40
        pts = [pts[int(i * step)] for i in range(40)]
    lo, hi = min(pts), max(pts)
    if hi == lo:
        hi = lo + 1  # 全平序列也给一条可见的线
    pad_l, pad_r, pad_t, pad_b = 40, 6, 6, 6
    n = len(pts)

    def xy(i):
        x = pad_l + i * (width - pad_l - pad_r) / (n - 1)
        y = pad_t + (1 - (pts[i] - lo) / (hi - lo)) * (height - pad_t - pad_b)
        return x, y

    coords = [xy(i) for i in range(n)]
    d = f"M {coords[0][0]:.1f} {coords[0][1]:.1f}"
    for i in range(n - 1):  # Catmull-Rom → 三次贝塞尔，弧线平滑
        p0 = coords[i - 1] if i > 0 else coords[i]
        p1, p2 = coords[i], coords[i + 1]
        p3 = coords[i + 2] if i + 2 < n else p2
        c1x, c1y = p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6
        c2x, c2y = p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6
        d += f" C {c1x:.1f} {c1y:.1f}, {c2x:.1f} {c2y:.1f}, {p2[0]:.1f} {p2[1]:.1f}"
    fill_d = d + f" L {coords[-1][0]:.1f} {height - pad_b} L {pad_l} {height - pad_b} Z"
    color = line_color or axis_color  # 整张图统一用单位色：轴、线、渐变一体
    gid = f"tg{abs(hash(tuple(pts))) % 999999}"

    # Y 轴：三条网格线（顶=最大值，底=最小值，中=均值位）+ 右对齐刻度文字
    grid = []
    for frac, label in ((0.0, _fmt_val(hi)), (0.5, _fmt_val((hi + lo) / 2)), (1.0, _fmt_val(lo))):
        y = pad_t + frac * (height - pad_t - pad_b)
        grid.append(f'<line x1="{pad_l}" y1="{y:.1f}" x2="{width - pad_r}" y2="{y:.1f}" '
                    f'stroke="#21262d" stroke-width="1"/>')
        grid.append(f'<text x="{pad_l - 5}" y="{y + 3:.1f}" text-anchor="end" '
                    f'font-size="9" fill="{axis_color}">{label}</text>')
    axis = f'<line x1="{pad_l}" y1="{pad_t}" x2="{pad_l}" y2="{height - pad_b}" stroke="{axis_color}" stroke-width="1"/>'
    return (
        f'<svg viewBox="0 0 {width} {height}" width="100%" height="{height}" '
        f'preserveAspectRatio="none" role="img">'
        f'<defs><linearGradient id="{gid}" x1="0" y1="0" x2="0" y2="1">'
        f'<stop offset="0" stop-color="{color}" stop-opacity="0.32"/>'
        f'<stop offset="1" stop-color="{color}" stop-opacity="0.04"/></linearGradient></defs>'
        f'{"".join(grid)}{axis}'
        f'<path d="{fill_d}" fill="url(#{gid})"/>'
        f'<path d="{d}" fill="none" stroke="{color}" stroke-width="2" stroke-linecap="round"/>'
        f'<circle cx="{coords[-1][0]:.1f}" cy="{coords[-1][1]:.1f}" r="2.6" fill="{color}"/></svg>'
    )


def build_panel_html(view: dict, history: list[dict] | None = None, *, mac_native=False) -> str:
    """Self-contained HTML (no external requests)."""
    view = view or {}
    history = load_history() if history is None else history
    remaining = overall_remaining(view)
    if remaining is None:
        lamp, summary = "⚪", "暂无可验证配额"
    elif remaining > 50:
        lamp, summary = "🟢", f"最紧缺来源仍剩 {remaining:.0f}%"
    elif remaining > 20:
        lamp, summary = "🟡", f"最紧缺来源剩 {remaining:.0f}%，注意用量"
    else:
        lamp, summary = "🔴", f"最紧缺来源仅剩 {remaining:.0f}%"
    by_key: dict[str, list] = {k: [] for k in SOURCES_ORDER}
    for point in history or []:
        for key in SOURCES_ORDER:
            by_key[key].append(point.get(_TREND_KEYS[key]))
    merged_rel = _humanize_ts(view.get("merged_at"))
    parts = ['<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">',
             '<meta name="viewport" content="width=device-width,initial-scale=1">',
             f'<title>{WINDOW_TITLE}</title><style>',
             'body{margin:0;padding:20px 22px;background:#0d1117;color:#e6edf3;',
             'font-family:"Segoe UI",system-ui,-apple-system,sans-serif}',
             '.brand{display:flex;align-items:center;gap:14px;padding:0 0 18px;',
             'margin-bottom:17px;border-bottom:1px solid #243148}',
             '.brand img{width:56px;height:56px;flex-shrink:0}',
             '.brand h1{margin:0;font-size:27px;letter-spacing:-.5px;font-weight:650}',
             '.brand p{margin:4px 0 0;color:#91a6c4;font-size:13px}',
             '.top{display:flex;align-items:center;gap:14px;margin-bottom:6px}',
             '.lamp{font-size:30px}.top h2{margin:0;font-size:20px;font-weight:600}',
             '.meta{color:#8b949e;font-size:12px;margin-bottom:16px}',
             '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),400px));'
             'gap:14px;align-items:start;justify-content:start}',
             '.card{box-sizing:border-box;min-width:0;height:288px;overflow-y:auto;overflow-x:hidden;'
             'scrollbar-gutter:stable;overflow-wrap:anywhere;background:#161b22;border:1px solid #21262d;'
             'border-radius:12px;padding:14px 16px}',
             '.card-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}',
             '.card h3{margin:0;font-size:15px;color:#58a6ff;font-weight:600}',
             '.pill{font-size:11px;padding:2px 8px;border-radius:10px;background:#21262d;color:#8b949e}',
             '.value{font-size:13px;line-height:1.6;margin-bottom:10px}',
             '.bars{margin:8px 0 10px;display:flex;flex-direction:column;gap:6px}',
             '.brow{display:flex;align-items:center;gap:8px;font-size:12px}',
             '.blabel{max-width:118px;color:#8b949e;flex-shrink:0;overflow:hidden;',
             'text-overflow:ellipsis;white-space:nowrap}',
             '.bar{flex:1;height:8px;background:#21262d;border-radius:4px;overflow:hidden}',
             '.fill{height:100%;border-radius:4px}.ok{background:#3fb950}.warn{background:#d29922}.bad{background:#f85149}',
             '.bpct{width:104px;flex-shrink:0;white-space:nowrap;text-align:right;color:#e6edf3}',
             '.row{display:flex;justify-content:space-between;gap:10px;font-size:12px;',
             'color:#8b949e;border-top:1px solid #21262d;padding:5px 0 0;margin-top:5px}',
             '.row span{color:#c9d1d9;text-align:right}',
             '.row.trend-label{margin-bottom:2px}.trendbox{margin:2px 0 2px}',
             '.none{color:#6e7681;font-size:12px}',
             '.trend{color:#58a6ff;letter-spacing:2px;font-size:13px}',
             ('.addable{margin:4px 0 0;padding:0;border:0;' if mac_native else
              '.addable{margin-top:16px;padding:10px 14px;border:1px dashed #30363d;border-radius:10px;'),
             'color:#8b949e;font-size:12px}',
             'small.src{color:#6e7681;font-size:11px;display:block;margin-top:8px}</style></head><body>']
    logo_data = base64.b64encode((ASSETS / "png" / "icon-128.png").read_bytes()).decode("ascii")
    parts.append(f'<header class="brand"><img src="data:image/png;base64,{logo_data}" alt="Quanta">'
                 f'<div><h1>{APP_NAME}</h1><p>{TAGLINE}</p></div></header>')
    parts.append(f'<div class="top"><span class="lamp">{lamp}</span><h2>汇总：{_esc(summary)}</h2></div>'
                 f'<div class="meta">{merged_rel}更新 · 关闭窗口只隐藏面板，托盘常驻不受影响</div>'
                 f'<div class="grid">')
    for card in source_cards(view):
        unit = _TREND_UNITS[card["key"]]
        unit_color = _UNIT_COLORS.get(unit, "#8b949e")
        svg = _svg_trend([p.get(_TREND_KEYS[card["key"]]) for p in history or []],
                         axis_color=unit_color, line_color=unit_color)
        trend_html = svg or '<span class="none">暂无趋势（刷新两次后生成）</span>'
        trend_label = (f'近 7 天趋势 · <span style="color:{unit_color}">{_esc(unit)}</span>'
                       if unit else "近 7 天趋势")
        pill = card.get("pill", "")
        pill_html = f'<span class="pill">{_esc(pill)}</span>' if pill else ""
        updated_rel = _humanize_ts(card["updated"])
        bars = _bars_html(card.get("bars"))
        if mac_native and card["key"] == "codex" and not card.get("bars"):
            error = (view.get("codex") or {}).get("live_error")
            if error:
                from .i18n import language
                missing = error == "Codex executable unavailable"
                if language() == "zh":
                    card["value"] = ("未找到 Codex 程序，请确认已安装到应用程序目录" if missing else
                                     "当前额度读取失败，请确认 Codex 已登录并联网后刷新")
                else:
                    card["value"] = ("Codex executable not found. Check its installation in Applications." if missing else
                                     "Live quota unavailable. Check Codex sign-in and connection, then refresh.")
        parts.append(
            f'<div class="card"><div class="card-h"><h3>{_esc(card["title"])}</h3>{pill_html}</div>'
            f'<div class="value">当前数值：{_esc(card["value"])}</div>'
            f'{bars}'
            f'<div class="row"><span>重置倒计时</span><span>{_esc(card["reset"])}</span></div>'
            f'<div class="row"><span>上次刷新</span><span title="{_esc(card["updated"])}">{_esc(updated_rel)}</span></div>'
            f'<div class="row trend-label"><span>{trend_label}</span></div>'
            f'<div class="trendbox">{trend_html}</div>'
            f'<small class="src">{_esc(card["source"])}</small></div>'
        )
    if mac_native:
        parts.append('</div><div style="margin-top:12px"><!--connections-action-->')
    hint = _addable_hint(view, mac_native=mac_native)
    if hint:
        parts.append(f'<div class="addable">{_esc(hint)}</div>')
    parts.append('</div></body></html>')
    return "".join(parts)


def get_panel_html() -> str:
    """Read current data via the existing collect/merge layer."""
    from .merge import collect_merged
    from .config import load_config
    view = collect_merged(load_config())
    return build_panel_html(view, load_history())


def _show_with_webview(html_text: str) -> bool:
    import webview
    window = webview.create_window(WINDOW_TITLE, html=html_text, width=900, height=730)
    webview.start(private_mode=True, icon=str(ASSETS / "icon.ico"))
    return window is not None


def _show_in_subprocess(html_text: str) -> bool:
    """Each child owns its main thread and a separate, short-lived HTML file."""
    err_log = DATA_DIR / "panel-error.log"
    exchange = None
    proc = None
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        exchange = tempfile.TemporaryDirectory(prefix="aibar-panel-")
        target = Path(exchange.name) / "panel.html"
        target.write_text(html_text, encoding="utf-8")
        if getattr(sys, "frozen", False):
            args = [sys.executable, "--panel-stdin", str(target)]
        else:
            args = [sys.executable, "-m", "aibar.panel_mac", "--panel-stdin", str(target)]
        # 防御：错误日志超 1MB 直接截断，防止无限增长
        if err_log.exists() and err_log.stat().st_size > 1_000_000:
            err_log.write_text("", encoding="utf-8")
        with open(err_log, "ab") as errors:
            proc = subprocess.Popen(
                args, stdout=subprocess.DEVNULL, stderr=errors,
                cwd=Path(__file__).resolve().parent.parent,
                **({"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}),
            )
        # Wait for exit in a worker: a child may fail after Popen has returned.
        threading.Thread(target=_reap_panel, args=(proc, exchange), daemon=True).start()
        return proc.poll() is None
    except OSError:
        return False
    finally:
        if proc is None and exchange is not None:
            exchange.cleanup()


def _reap_panel(proc, exchange) -> None:
    try:
        proc.wait()
    finally:
        exchange.cleanup()


def _show_with_tkinter(html_text: str) -> bool:
    import tkinter as tk
    from tkinter import scrolledtext
    root = tk.Tk()
    root.title(WINDOW_TITLE)
    try:
        if sys.platform == "win32":
            root.iconbitmap(str(ASSETS / "icon.ico"))
        else:
            root._quanta_icon = tk.PhotoImage(file=str(ASSETS / "icon.png"))
            root.iconphoto(True, root._quanta_icon)
    except tk.TclError:
        pass
    root.geometry("760x560")
    # tkinter shows a readable text fallback of the same cards.
    text = scrolledtext.ScrolledText(root, wrap="word")
    text.pack(fill="both", expand=True)
    text.insert("1.0", _html_to_text(html_text))
    text.configure(state="disabled")
    root.protocol("WM_DELETE_WINDOW", root.destroy)  # 只关面板，不退托盘
    root.mainloop()
    return True


def _html_to_text(html_text: str) -> str:
    import re
    html_text = re.sub(r"<(style|script)\b[^>]*>.*?</\1\s*>", "", html_text,
                       flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<[^>]+>", "\n", html_text)
    text = html.unescape(text)
    lines = [ln.strip() for ln in text.splitlines()]
    return "\n".join(ln for ln in lines if ln)


def show_panel(html_text: str | None = None) -> str:
    """Show the panel; prefers a child process running pywebview.
    传入 html_text（托盘缓存的渲染结果）可跳过重新采集，实现秒开。"""
    if html_text is None:
        html_text = get_panel_html()  # 慢路径：完整采集一遍
    if _show_in_subprocess(html_text):
        return "webview-subprocess"
    try:
        _show_with_webview(html_text)  # 主线程调用方仍可用
        return "webview"
    except Exception:
        _show_with_tkinter(html_text)
        return "tkinter"


def open_panel_in_background(html_text: str | None = None) -> threading.Thread:
    """Open without blocking the tray icon loop."""
    thread = threading.Thread(target=show_panel, args=(html_text,), daemon=True)
    thread.start()
    return thread


def run_panel_from_file(path: str) -> None:
    """--panel-stdin 模式：独立进程主线程渲染指定 HTML 文件（pywebview）。
    读入内存后立即删除磁盘文件——用量数据不在盘上长期残留。"""
    import os
    target = Path(path)
    try:
        html_text = target.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        html_text = "<h1>面板数据缺失或无法读取，请关闭后重新打开面板。</h1>"
    finally:
        try:
            target.unlink()  # 读后即焚：面板数据不落盘残留
        except OSError:
            pass
    _icon = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "assets", "icon.ico")
    try:
        import webview
        webview.create_window(WINDOW_TITLE, html=html_text, width=900, height=730)
        webview.start(private_mode=True, icon=_icon if os.path.exists(_icon) else None)
    except Exception:
        # Both backends must run on the child process's main thread (macOS too).
        _show_with_tkinter(html_text)


if __name__ == "__main__":
    if "--panel-stdin" in sys.argv:
        idx = sys.argv.index("--panel-stdin")
        run_panel_from_file(sys.argv[idx + 1])
    else:
        _html_text = sys.stdin.read()
        import os
        import webview

        _icon = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                             "assets", "icon.ico")
        webview.create_window(WINDOW_TITLE, html=_html_text, width=900, height=730)
        webview.start(private_mode=True, icon=_icon if os.path.exists(_icon) else None)
