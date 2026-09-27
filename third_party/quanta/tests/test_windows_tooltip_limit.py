import sys
import unittest
from unittest.mock import patch

from aibar.status_text import format_tooltip, windows_tooltip
from aibar.i18n import tr


class WindowsTooltipLimit(unittest.TestCase):
    def test_english_multi_provider_tooltip_fits_native_buffer(self):
        view = {
            'glm': {'stale': False, 'windows': [
                {'label': '5h窗口', 'percent': 20},
                {'label': '周窗口', 'percent': 30}]},
            'antigravity': {'stale': False, 'windows': [
                {'label': name, 'percent': 40}
                for name in ('Claude 5h', 'Gemini Pro 5h', 'Gemini Flash 5h')]}}
        with patch('aibar.i18n.language', return_value='en'):
            original = tr(format_tooltip(view))
            self.assertGreater(len(original), 128)
            fixed = windows_tooltip(view)
        self.assertLessEqual(len(fixed.encode('utf-16-le')), 254)
        self.assertIn('GLM', fixed)
        if sys.platform == 'win32':
            from pystray._util.win32 import NOTIFYICONDATAW
            with self.assertRaises(ValueError):
                NOTIFYICONDATAW(szTip=original)
            NOTIFYICONDATAW(szTip=fixed)

    def test_surrogate_pair_is_not_split(self):
        with patch('aibar.i18n.tr', return_value='x' * 126 + '\U0001f680'):
            fixed = windows_tooltip({})
        self.assertEqual(fixed, 'x' * 126)
