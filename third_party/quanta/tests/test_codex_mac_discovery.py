import unittest
from pathlib import Path
from unittest.mock import patch
from aibar.providers import codex_live

@unittest.skipIf(codex_live.os.name == 'nt', 'Mac executable discovery')
class MacDiscovery(unittest.TestCase):
    def discover(self, executable, allowed=True):
        with patch.object(codex_live.shutil, 'which', return_value=None), patch.object(Path, 'home', return_value=Path('/test-user')), patch.object(Path, 'is_file', lambda p: str(p) == executable), patch.object(codex_live.os, 'access', return_value=allowed):
            return codex_live._find_executable()

    def test_desktop_only_install_without_shell_path(self):
        for folder in ('/Applications', '/test-user/Applications'):
            for app in ('ChatGPT.app', 'Codex.app'):
                path = folder + '/' + app + '/Contents/Resources/codex'
                with self.subTest(path=path):
                    self.assertEqual(self.discover(path), path)

    def test_non_executable_bundle_file_is_rejected(self):
        with self.assertRaises(codex_live.QuotaReadError):
            self.discover('/Applications/ChatGPT.app/Contents/Resources/codex', False)

    def test_missing_install_reports_unavailable(self):
        with self.assertRaises(codex_live.QuotaReadError):
            self.discover('/unrelated/codex')

class MacReadFailureMessage(unittest.TestCase):
    def test_mac_shows_failure_without_changing_windows_or_leaking_error(self):
        from aibar.panel_mac import build_panel_html
        view = {'visible': {'codex': True}, 'codex': {'live_error': 'private-detail-do-not-display', 'accounts': []}}
        with patch('aibar.i18n.language', return_value='en'):
            mac = build_panel_html(view, [], mac_native=True)
            windows = build_panel_html(view, [])
        self.assertIn('Live quota unavailable.', mac)
        self.assertNotIn('Live quota unavailable.', windows)
        self.assertNotIn('private-detail-do-not-display', mac)
