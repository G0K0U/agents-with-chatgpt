"""Credential policy tests with a simulated Keychain; no native storage access."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


class KeychainOverlaySafety(unittest.TestCase):
    def setUp(self):
        self.security = SimpleNamespace(errSecSuccess=0, errSecItemNotFound=-25300)
        spec = importlib.util.spec_from_file_location('aibar._keychain_policy_fixture',
            Path(__file__).parents[1] / 'aibar/connections_mac.py')
        self.module = importlib.util.module_from_spec(spec)
        with patch.dict('sys.modules', {'Security': self.security,
                                      'Foundation': SimpleNamespace(NSData=object)}):
            spec.loader.exec_module(self.module)

    def test_denied_keychain_does_not_fall_back_to_legacy(self):
        with patch.object(self.module, 'read_connection', side_effect=OSError('denied')):
            result = self.module.overlay({'glm': {'token': 'legacy'}})
        self.assertEqual(result['glm']['token'], '')
        self.assertIn('glm', result['_connection_errors'])
        self.assertIn('glm', result['_secure_providers'])

    def test_secure_overlay_is_not_serialized(self):
        from aibar import config
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config.json'
            original = {'glm': {'token': 'legacy', 'platform': 'zai'}}
            path.write_text(json.dumps(original), encoding='utf-8')
            with patch.object(self.module, 'read_connection', side_effect=[
                    {'secret': 'keychain-only', 'platform': 'bigmodel'}, None]):
                result = self.module.overlay(original)
            self.assertEqual(result['glm']['token'], 'keychain-only')
            with patch.object(config, 'CONFIG_PATH', path):
                config.save_config(result)
            self.assertNotIn('keychain-only', path.read_text())
            self.assertEqual(json.loads(path.read_text())['glm'], original['glm'])

    def test_missing_credential_keeps_legacy_compatibility(self):
        with patch.object(self.module, 'read_connection', return_value=None):
            result = self.module.overlay({'glm': {'token': 'legacy'}})
        self.assertEqual(result['glm']['token'], 'legacy')
