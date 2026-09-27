import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from aibar.providers import codex_live


@unittest.skipUnless(os.name == 'nt', 'Windows executable discovery')
class WindowsDiscovery(unittest.TestCase):
    def test_no_path_uses_cached_cli(self):
        with tempfile.TemporaryDirectory() as directory:
            exe = Path(directory) / 'OpenAI/Codex/bin/version/codex.exe'
            exe.parent.mkdir(parents=True)
            exe.touch()
            with patch.dict(os.environ, {'LOCALAPPDATA': directory}), \
                 patch.object(codex_live.shutil, 'which', return_value=None):
                self.assertEqual(codex_live._find_executable(), str(exe))

    def test_directory_named_executable_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / 'OpenAI/Codex/bin/version/codex.exe').mkdir(parents=True)
            with patch.dict(os.environ, {'LOCALAPPDATA': directory}), \
                 patch.object(codex_live.shutil, 'which', return_value=None):
                with self.assertRaises(codex_live.QuotaReadError):
                    codex_live._find_executable()

    def test_start_failure_is_safe_quota_error(self):
        profile = Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex')
        with patch.object(codex_live, '_find_executable', return_value='fixture'), \
             patch.object(codex_live, '_query', side_effect=PermissionError('private-error')):
            with self.assertRaises(codex_live.QuotaReadError) as error:
                codex_live.read_verified(profile)
            self.assertNotIn('private-error', str(error.exception))


class RecoveryPresentation(unittest.TestCase):
    def test_failure_guidance_does_not_show_raw_error(self):
        from aibar.panel import build_panel_html
        view = {'visible': {'codex': True}, 'codex': {'accounts': [], 'live_error': 'private-error'}}
        with patch('aibar.i18n.language', return_value='zh'):
            html = build_panel_html(view, [])
        self.assertIn('请先打开官方 Codex 应用并登录', html)
        self.assertNotIn('private-error', html)
