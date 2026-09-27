import copy
import sys
import json
import plistlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from aibar.flyout_model_mac import model_for
from aibar import autostart_mac


def app(view):
    return SimpleNamespace(view=view, refreshing=False, last_completed_at=None, _refresh_error=None)


def visible(*keys):
    return {k: k in keys for k in ('codex', 'glm', 'deepseek', 'muse', 'antigravity')}


class ModelTests(unittest.TestCase):
    def test_weekly_only_and_private_label(self):
        view = {'visible': visible('codex'), 'codex': {'accounts': [
            {'label': 'example@example.invalid', 'plan_type': 'prolite', 'is_current': True,
             'attribution_verified': True, 'stale': False,
             'primary_window_minutes': 10080, 'primary_used_percent': 61}]}}
        before = copy.deepcopy(view)
        result = model_for(app(view))
        self.assertEqual(result['cards'][0]['bars'][0]['label'], '周')
        self.assertEqual(result['cards'][0]['bars'][0]['remaining'], 39)
        self.assertEqual(len(result['cards'][0]['bars']), 1)
        self.assertNotIn('@', json.dumps(result))
        self.assertEqual(view, before)

    def test_stale_and_failed_bars_hidden(self):
        for state in ({'stale': True}, {'stale': False, 'error': 'timeout'}):
            view = {'visible': visible('glm'), 'glm': dict(state, windows=[{'label': '5h', 'percent': 10}])}
            self.assertEqual(model_for(app(view))['cards'][0]['bars'], [])

    def test_local_counts_are_not_quota(self):
        view = {'visible': visible('muse'), 'muse': {'available': True, 'five_hour': {'requests': 24}}}
        result = model_for(app(view))
        self.assertEqual(result['cards'][0]['bars'], [])
        self.assertIsNone(result['remaining'])

    def test_refresh_failure_is_visible(self):
        value = app({'visible': visible()});value._refresh_error = 'TimeoutError'
        self.assertIn('TimeoutError', model_for(value)['error'])
        self.assertIsNone(model_for(value)['remaining'])


class StartupTests(unittest.TestCase):
    def setUp(self):
        uid = patch('aibar.autostart_mac.os.getuid', return_value=501, create=True)
        uid.start(); self.addCleanup(uid.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.target = self.root / 'agents/com.aibar.tray.plist'
        for name, value in [('aibar.autostart_mac.target_path', lambda: self.target),
                            ('aibar.common.DATA_DIR', self.root / 'data')]:
            obj = patch(name, value);obj.start();self.addCleanup(obj.stop)
        self.runner = patch('aibar.autostart_mac.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout='')).start()
        self.addCleanup(patch.stopall)

    def test_enable_disable_preserves_backup(self):
        autostart_mac.set_enabled(True)
        before = self.target.read_bytes()
        self.assertTrue(autostart_mac.is_enabled())
        autostart_mac.set_enabled(False)
        self.assertFalse(self.target.exists())
        backups = list((self.root/'data/startup-backups').glob('*.plist'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), before)
        calls = [c.args[0][1] for c in self.runner.call_args_list]
        self.assertNotIn('bootout', calls)
        self.assertNotIn('bootstrap', calls)

    @unittest.skipUnless(sys.platform == 'darwin', 'macOS file permissions')
    def test_plist_permissions(self):
        autostart_mac.set_enabled(True)
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o600)

    def test_foreign_job_is_preserved(self):
        self.target.parent.mkdir()
        original = plistlib.dumps({'Label': 'another.service', 'ProgramArguments': ['something']})
        self.target.write_bytes(original)
        with self.assertRaises(ValueError):
            autostart_mac.set_enabled(True)
        self.assertEqual(self.target.read_bytes(), original)
        self.runner.assert_not_called()

    def test_failed_enable_rolls_back_new_file(self):
        self.runner.return_value.returncode = 1
        with self.assertRaises(OSError):
            autostart_mac.set_enabled(True)
        self.assertFalse(self.target.exists())

    def test_symlink_is_not_replaced(self):
        self.target.parent.mkdir()
        other = self.root / 'other';other.write_text('preserve')
        self.target.symlink_to(other)
        with self.assertRaises(ValueError):
            autostart_mac.set_enabled(True)
        self.assertTrue(self.target.is_symlink())
        self.assertEqual(other.read_text(), 'preserve')

if __name__ == '__main__':
    unittest.main()
