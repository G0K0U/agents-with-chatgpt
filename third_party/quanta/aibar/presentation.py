"""Fail-closed display data shared by tray, flyout and details."""
from copy import deepcopy
import math


def trusted_view(view):
    view = deepcopy(view or {})
    failed = bool(view.get('_refresh_error'))
    cx = view.get('codex') or {}
    if failed or cx.get('live_error'):
        view.pop('recommendation', None)
        for account in cx.get('accounts') or []:
            account['stale'] = True
        view['codex'] = cx
    for name in ('glm', 'antigravity', 'deepseek'):
        provider = view.get(name)
        if not provider:
            continue
        if failed or provider.get('stale', True) or provider.get('error'):
            provider['windows'] = []
            provider['balances'] = []
            provider['stale'] = True
        else:
            provider['windows'] = [w for w in provider.get('windows') or []
                if isinstance(w.get('percent'), (int, float)) and not isinstance(w.get('percent'), bool)
                and math.isfinite(w['percent']) and 0 <= w['percent'] <= 100]
    return view


def compact_cards(view):
    from .oneshot import build_flyout_cards
    from .i18n import tr
    view = trusted_view(view)
    cards = build_flyout_cards(view)
    cx = view.get('codex') or {}
    selected = view.get('recommendation') or next((a for a in cx.get('accounts') or [] if a.get('is_current')), {})
    for card in cards:
        card['name'] = card['name'].split(' · ')[0]
        if card['name'] == 'AGY':
            card['name'] = 'Antigravity'
        if card['name'].startswith('Codex') and selected:
            role = '当前账号' if selected.get('is_current') else '建议账号'
            card['name'] += ' · ' + tr(role)
        for key in ('name', 'headline', 'detail'):
            card[key] = tr(card.get(key, ''))
        card['bars'] = [(tr(label), value) for label, value in card.get('bars') or []]
    return cards


def legend_rows(view):
    from .i18n import tr
    rows = [('#3fb950', '绿 >50%：配额充足'), ('#d29922', '黄 20–50%：注意用量'),
            ('#f85149', '红 ≤20%：即将耗尽'), ('#8b949e', '灰：旧 / 未知 / 读取失败')]
    visible = (view or {}).get('visible') or {}
    if visible.get('deepseek', False):
        rows.append(('#2f81f7', '蓝：余额（DeepSeek）'))
    if visible.get('muse', False):
        rows.append(('#a371f7', '紫：本地活动（Muse），非额度'))
    return [(color, tr(text)) for color, text in rows]
