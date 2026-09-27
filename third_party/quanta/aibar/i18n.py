"""System-language presentation: Chinese for zh, English for all others."""
import json
import os
import re
import sys
from functools import lru_cache
from .brand import ASSETS


def choose_language(preferred):
    first = str(preferred[0]).replace('_', '-').lower() if preferred else ''
    return 'zh' if first == 'zh' or first.startswith('zh-') else 'en'


@lru_cache(maxsize=1)
def language():
    # Process-local preview for UI QA; never writes a system or user preference.
    preview = os.environ.get('QUANTA_UI_LANGUAGE')
    if preview in ('zh', 'en'):
        return preview
    if sys.platform == 'darwin':
        from Foundation import NSLocale
        return choose_language(list(NSLocale.preferredLanguages()))
    if sys.platform == 'win32':
        import ctypes
        return 'zh' if ctypes.windll.kernel32.GetUserDefaultUILanguage() & 0x3ff == 4 else 'en'
    import locale
    return choose_language([locale.getlocale()[0] or 'en'])


@lru_cache(maxsize=1)
def translations():
    return json.loads((ASSETS / 'translations-en.json').read_text(encoding="utf-8"))


PATTERNS = [
    (r"另有 (\d+) 个账号", r"\1 other accounts"),
    (r"(\d+) 窗口全满", r"All \1 windows full"),
    (r"最紧 (.*?) 剩 (\d+(?:\.\d+)?%)", r"Lowest \1: \2 remaining"),
    (r'最紧缺来源(?:仅|仍)?剩\s*(\d+(?:\.\d+)?%)', r'Lowest remaining quota: \1'),
    (r'(\d+)时(\d+)分后重置', r'Resets in \1h \2m'),
    (r'(\d+)分钟后重置', r'Resets in \1m'),
    (r'(\d+) 分钟前', r'\1 min ago'),
    (r'(\d+) 小时前', r'\1 hr ago'),
    (r'(\d+) 天前', r'\1 days ago'),
    (r'打开 (Z\.ai|BigModel|DeepSeek) 官方密钥页面 ↗', r'Open \1 API keys ↗'),
    (r'剩\s*(\d+(?:\.\d+)?%)', r'\1 remaining'),
]


def tr(value):
    if language() == 'zh' or not isinstance(value, str):
        return value
    mapping = translations()
    if value in mapping:
        return mapping[value]
    for pattern, replacement in PATTERNS:
        value = re.sub(pattern, replacement, value)
    # Single-word window labels are translated only as complete strings.
    parts = {k: v for k, v in mapping.items() if len(k) > 1}
    pattern = '|'.join(re.escape(k) for k in sorted(parts, key=len, reverse=True))
    value = re.sub(pattern, lambda m: parts[m.group()], value)
    return value.replace('；', '; ').replace('（', ' (').replace('）', ')')


def localize_html(html):
    """Localize display text only; do not rewrite scripts, credentials or data."""
    lang = language()
    html = html.replace('lang="zh-CN"', 'lang="'+('zh-CN' if lang == 'zh' else 'en')+'"')
    if lang == 'zh':
        return html
    config = json.dumps({'strings': translations(), 'patterns': PATTERNS}, ensure_ascii=True).replace('<', r'\u003c').replace('>', r'\u003e').replace('&', r'\u0026')
    script = (ASSETS / 'localize.js').read_text(encoding="utf-8").replace('/*CONFIG*/', config)
    return html.replace('</body>', '<script>'+script+'</script></body>')
