"""Mac presentation of the same structured quota cards used on Windows."""
import copy
import math
from .oneshot import build_flyout_cards
from .icon import GRAY, color_for, overall_remaining
from .status_text import last_refresh_row
from .merge import load_local_snapshot


def model_for(app, startup=False, feedback=''):
    view = copy.deepcopy(app.view or {})
    # Never paint an old or failed provider snapshot as a current quota bar.
    for key in ('glm', 'antigravity', 'deepseek'):
        provider = view.get(key) or {}
        if provider.get('stale', True) or provider.get('error'):
            provider['windows'] = []
            if key == 'deepseek':
                provider['balances'] = []
            view[key] = provider
    cards = []
    for source in build_flyout_cards(view):
        name = str(source['name']).split(' · ')[0]  # No account identifiers in the compact view.
        if name == 'AGY':
            name = 'Antigravity'
        bars = []
        for label, value in source.get('bars') or []:
            try:
                value = float(value)
            except (ValueError, TypeError):
                continue
            if math.isfinite(value):
                value = max(0, min(100, value))
                bars.append({'label': str(label), 'remaining': value,
                             'color': '#%02x%02x%02x' % color_for(value)})
        color = source.get('dot') or GRAY
        cards.append({'name': name, 'headline': source.get('headline') or '', 'bars': bars,
                      'detail': source.get('detail') or '', 'color': '#%02x%02x%02x' % color})
    remaining = overall_remaining(view)
    error = getattr(app, '_refresh_error', None)
    if error:
        remaining = None
    local = load_local_snapshot() or {}
    show_muse_legend = bool((local.get('visible') or {}).get('muse', False))
    return {'show_muse_legend': show_muse_legend, 'cards': cards, 'refreshing': bool(app.refreshing),
            'remaining': remaining, 'updated': last_refresh_row(app.last_completed_at),
            'error': ('刷新失败：' + error) if error else '',
            'startup': bool(startup), 'feedback': feedback}
