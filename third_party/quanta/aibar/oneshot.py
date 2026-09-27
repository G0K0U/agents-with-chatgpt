"""Plain-text presentation shared by the Windows and macOS menus.

v2 极简单行式：每个已启用的来源一行摘要，明细在面板。
可见性由快照里的 ``visible`` 映射驱动（capabilities 自检系统写入）；
旧快照没有该映射时按"全部可见"处理，保证向后兼容。
"""
import json
import re
import sys
from datetime import datetime, timezone
from typing import NamedTuple
from .common import fmt_reset, now_utc
from .icon import BLUE, GRAY, PURPLE, RED, color_for
from .config import load_config
from .presentation import trusted_view
from .merge import collect_merged
from .codex_windows import plan_label, usable_windows, recommendation_windows


def _now():
    return datetime.now(timezone.utc)


def _fmt_int(value):
    try:
        return f"{int(value):,}"
    except (TypeError, ValueError):
        return "0"

_EMAIL_RE = re.compile(r"([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+)")


def _mask_email(text: str) -> str:
    return _EMAIL_RE.sub(r"\1***\2", text or "")


def _quota(a, prefix, label):
    value = a.get("effective_" + prefix + "_used_percent")
    if a.get(prefix + "_reset_done"):
        return label + " 重置时间已过，等待新快照"
    if value is None:
        return label + " 未知"
    return f"{label} 剩 {100 - value:.0f}%"


class UsageRow(NamedTuple):
    text: str
    color: tuple | None = None


def quota_color(used, trusted=True):
    if not trusted or isinstance(used, bool) or not isinstance(used, (float, int)) or not 0 <= used <= 100:
        return GRAY
    return color_for(100 - used)


def _is_visible(view, key: str) -> bool:
    """快照带 visible 映射时按其过滤；旧快照缺省视为可见（向后兼容）。"""
    return (view.get("visible") or {}).get(key, True)


def _fmt_tok(value) -> str:
    try:
        return f"{int(value):,}"
    except (TypeError, ValueError):
        return "0"


def _codex_rows(view, add):
    cx = view.get("codex") or {}
    if cx.get("live_error") and not cx.get("accounts"):
        add("Codex 读取失败: " + cx["live_error"], GRAY)
        return
    rec = view.get("recommendation")
    accounts = cx.get("accounts") or []
    if rec:
        hint = "" if rec.get("is_current") else "（建议切号）"
        windows = recommendation_windows(rec)
        if windows:
            parts = " · ".join(f"{w['label']}剩 {w['remaining']:.0f}%" for w in windows)
            add(f"Codex {plan_label(rec)} {_mask_email(rec['label'])}  {parts}{hint}".strip(),
                color_for(min(w["remaining"] for w in windows)))
            return
    # 无推荐时：只用可信窗口（非 stale、未过期）拼单行；过期窗口不参与展示
    for account in sorted(accounts, key=lambda a: not a.get("is_current")):
        parts, trusted_remaining = [], []
        for window in usable_windows(account):
            parts.append(f"{window['label']}剩 {window['remaining']:.0f}%")
            trusted_remaining.append(window["remaining"])
        if parts:
            label = _mask_email(account.get("label", "?"))
            add(f"Codex {plan_label(account)} {label}  " + " · ".join(parts), color_for(min(trusted_remaining)))
            return
    if accounts:
        add("Codex 已登录，尚无可核验用量（等待新快照）", GRAY)
        return
    add("Codex 近 8 天无快照（未登录或日志已过期）", GRAY)


def _muse_rows(view, add):
    m = view.get("muse") or {}
    if m.get("disabled"):
        add("Muse 已禁用（muse.enabled=false）")
        return
    if m.get("available"):
        five = m.get("five_hour") or {}
        count = five.get("requests", 0)
        tokens = five.get("tokens")
        tok_text = f" · {_fmt_tok(tokens)} tok" if tokens is not None else ""
        # 计数制：本地无法判定真实是否发得出去，不做红色告警（保持紫色）
        add(f"Muse  过去5小时 {count} 条{tok_text}", PURPLE)
        return
    add("Muse 未运行（WSL 关闭或尚未使用）", GRAY)


def _windows_rows(key, label, view, add, empty_hint):
    value = view.get(key) or {}
    if value.get("error"):
        add(f"{label} 读取失败: {value['error']}", GRAY)
        return
    if value.get("stale"):
        add(f"{label} 旧快照，等待更新", GRAY)
        return
    windows = [w for w in (value.get("windows") or []) if w.get("percent") is not None]
    if windows:
        worst = min(windows, key=lambda w: 100 - w["percent"])
        remaining = 100 - worst["percent"]
        if len(windows) > 1:
            add(f"{label}  最紧 {worst.get('label', '?')} 剩 {remaining:.0f}%",
                quota_color(worst["percent"], True))
        else:
            add(f"{label}  {worst.get('label', '?')} 剩 {remaining:.0f}%",
                quota_color(worst["percent"], True))
        return
    if key == "antigravity":
        if value.get("available"):
            add(f"AGY  会话 {value.get('conversations', 0)} · 生成 {value.get('generations', 0)} 次"
                f"（IDE 未运行，配额待读取）", GRAY)
        else:
            add(f"AGY  {value.get('note') or empty_hint}", GRAY)
    else:
        add(f"{label}  {empty_hint}", GRAY)


def _deepseek_rows(view, add):
    d = view.get("deepseek") or {}
    if d.get("error"):
        add(f"DeepSeek 读取失败: {d['error']}", GRAY)
        return
    balances = " · ".join(f"{b.get('total_balance')} {b.get('currency')}" for b in d.get("balances", []))
    amounts = []
    for b in d.get("balances") or []:
        try:
            amounts.append(float(b.get("total_balance") or 0))
        except (TypeError, ValueError):
            continue
    broke = bool(amounts) and all(v <= 0 for v in amounts)
    color = GRAY if d.get("stale", True) or not balances else \
        RED if broke or d.get("is_available") is False else BLUE
    suffix = "（旧快照）" if d.get("stale") else ""
    add("DeepSeek  余额 " + (balances or "未知") + suffix, color)


def render_rows(view):
    """极简单行式：每个可见来源一行摘要；未启用的来源零行。"""
    lines = []

    def add(text, color=None):
        lines.append(UsageRow(text, color))

    if _is_visible(view, "codex"):
        _codex_rows(view, add)
    if _is_visible(view, "muse"):
        _muse_rows(view, add)
    if _is_visible(view, "antigravity"):
        _windows_rows("antigravity", "AGY", view, add, "暂无官方配额窗口")
    if _is_visible(view, "glm"):
        _windows_rows("glm", "GLM", view, add, "已配置（等待用量窗口）")
    if _is_visible(view, "deepseek"):
        _deepseek_rows(view, add)
    return lines


def render(view):
    return "\n".join(row.text for row in render_rows(view))


def build_flyout_cards(view: dict) -> list[dict]:
    """浮窗双行卡片的结构化数据（与 render_rows 同一可见性语义）。

    每张卡：{dot, name, headline, bars, detail}
    - headline：首行关键值（右对齐不截断的信息放这里）
    - bars：多窗口来源逐条迷你进度条 [(label, remaining)]（AGY 4 条全展示）
    - detail：次行灰色补充（重置倒计时 / 今日与近 7 天 / 未运行原因）
    """
    def _mask(text):
        return _EMAIL_RE.sub(r"\1***\2", text or "")

    def _rel(iso):
        try:
            dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        except (ValueError, TypeError):
            return ""
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        secs = int((_now() - dt).total_seconds())
        if secs < 0:
            secs = 0
        if secs < 60:
            return "刚刚"
        if secs < 3600:
            return f"{secs // 60} 分钟前"
        return f"{secs // 3600} 小时前"

    cards = []
    view = trusted_view(view)

    # -- Codex --
    if _is_visible(view, "codex"):
        cx = view.get("codex") or {}
        rec = view.get("recommendation")
        bars, detail = [], ""
        if rec:
            name = f"Codex {plan_label(rec)} · {_mask(rec['label'])}"
            windows = recommendation_windows(rec)
            bars = [(w["label"], w["remaining"]) for w in windows]
            resets = [w["resets_at"] for w in windows if w.get("resets_at")]
            detail = fmt_reset(min(resets)) if resets else ""
        elif cx.get("accounts"):
            cur = next((a for a in cx["accounts"] if a.get("is_current")), cx["accounts"][0])
            name = f"Codex {plan_label(cur)} · {_mask(cur.get('label', '?'))}"
            windows = usable_windows(cur)
            bars = [(w["label"], w["remaining"]) for w in windows]
            others = len(cx["accounts"]) - 1
            resets = [w["resets_at"] for w in windows if w.get("resets_at")]
            detail = fmt_reset(min(resets)) if resets else ""
            if others:
                detail += f" · 另有 {others} 个账号"
            if not bars:
                detail = "旧 / 未核验 / 已过期读数，等待更新"
        else:
            name, bars, detail = "Codex", [], "近 8 天无快照（未登录或日志已过期）"
        color = color_for(min((b[1] for b in bars), default=100)) if bars else GRAY
        cards.append({"dot": color, "name": name, "headline": _headline_from_bars(bars),
                      "bars": bars, "detail": detail})

    # -- Muse --
    if _is_visible(view, "muse"):
        m = view.get("muse") or {}
        if m.get("available"):
            five = m.get("five_hour") or {}
            count = five.get("requests", 0)
            cards.append({"dot": PURPLE, "name": "Muse",
                          "headline": f"过去5小时 {count} 条 · {_fmt_int(five.get('tokens'))} tok",
                          "bars": [],
                          "detail": f"今日 {_fmt_int(m.get('today_tokens'))} · 近7天 {_fmt_int(m.get('week_7d_tokens'))}"})
        else:
            cards.append({"dot": GRAY, "name": "Muse", "headline": "未运行",
                          "bars": [], "detail": "WSL 关闭或尚未使用（启动后自动计数）"})

    # -- AGY（四窗口逐条进度条）--
    if _is_visible(view, "antigravity"):
        a = view.get("antigravity") or {}
        wins = [w for w in (a.get("windows") or []) if w.get("percent") is not None]
        if wins:
            bars = [(w.get("label", "?"), 100 - w["percent"]) for w in wins]
            worst = min(b[1] for b in bars)
            cards.append({"dot": color_for(worst), "name": "AGY",
                          "headline": _headline_from_bars(bars), "bars": bars,
                          "detail": f"会话 {a.get('conversations', 0)} · 生成 {a.get('generations', 0)} 次"
                                    + (" · IDE 未运行" if not a.get("_ls_live", True) else "")})
        elif a.get("error") or a.get("stale"):
            cards.append({"dot": GRAY, "name": "Antigravity", "headline": "读取失败" if a.get("error") else "旧快照", "bars": [], "detail": "等待刷新；本地计数不代表额度"})
        elif a.get("available"):
            cards.append({"dot": GRAY, "name": "AGY", "headline": "本地计数",
                          "bars": [],
                          "detail": f"会话 {a.get('conversations', 0)} · 生成 {a.get('generations', 0)} 次（IDE 未运行）"})
        else:
            cards.append({"dot": GRAY, "name": "AGY", "headline": "未安装",
                          "bars": [], "detail": str(a.get("note") or "未检测到会话数据")})

    # -- GLM --
    if _is_visible(view, "glm"):
        g = view.get("glm") or {}
        wins = [w for w in (g.get("windows") or []) if w.get("percent") is not None]
        if wins:
            bars = [(w.get("label", "?"), 100 - w["percent"]) for w in wins]
            worst = min(b[1] for b in bars)
            resets = [w.get("reset_at") for w in wins if w.get("reset_at")]
            # 注意：fmt_reset 用模块级导入——函数内局部 import 会让该名字
            # 变成整个函数的局部变量，先执行的分支再用它就 UnboundLocalError
            detail = fmt_reset(min(resets)) if resets else ""
            cards.append({"dot": color_for(worst), "name": "GLM",
                          "headline": _headline_from_bars(bars), "bars": bars,
                          "detail": detail})
        elif g.get("error"):
            cards.append({"dot": GRAY, "name": "GLM", "headline": "读取失败",
                          "bars": [], "detail": "请检查连接，稍后刷新"})
        elif g.get("stale"):
            cards.append({"dot": GRAY, "name": "GLM", "headline": "旧快照", "bars": [], "detail": "等待用量窗口数据"})
        else:
            cards.append({"dot": GRAY, "name": "GLM", "headline": "已配置",
                          "bars": [], "detail": "等待用量窗口数据"})

    # -- DeepSeek --
    if _is_visible(view, "deepseek"):
        d = view.get("deepseek") or {}
        balances = " · ".join(f"{b.get('total_balance')} {b.get('currency')}" for b in d.get("balances", []))
        amounts = []
        for b in d.get("balances") or []:
            try:
                amounts.append(float(b.get("total_balance") or 0))
            except (TypeError, ValueError):
                continue
        broke = bool(amounts) and all(v <= 0 for v in amounts)
        cards.append({"dot": GRAY if d.get("stale") or d.get("error") else RED if broke else BLUE, "name": "DeepSeek",
                      "headline": balances or "未知", "bars": [],
                      "detail": "读取失败，等待刷新" if d.get("error") else "旧快照，等待更新" if d.get("stale") else "余额已耗尽，充值前保持红色" if broke else "余额制，无重置"})
    return cards


def _headline_from_bars(bars):
    """多窗口来源的首行摘要：最紧窗口或全满表述。"""
    if not bars:
        return ""
    worst_label, worst_rem = min(bars, key=lambda b: b[1])
    if all(rem >= 99 for _l, rem in bars):
        return f"{len(bars)} 窗口全满"
    if len(bars) > 1:
        return f"最紧 {worst_label} 剩 {worst_rem:.0f}%"
    return f"剩 {worst_rem:.0f}%"


def main():
    view = collect_merged(load_config())
    print(json.dumps(view, ensure_ascii=False, indent=1) if "--json" in sys.argv else render(view))


if __name__ == "__main__":
    main()
