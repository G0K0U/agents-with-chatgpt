import copy
import json
import os
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

from aibar import connections_windows as connections
from aibar import i18n
from aibar.presentation import trusted_view, compact_cards, legend_rows
from aibar.panel import source_cards, build_panel_html


class Connections(unittest.TestCase):
    def test_empty_and_malformed_success_payloads_do_not_count_as_validation(self):
        self.assertFalse(connections.valid_response('glm', {'windows': [{'percent': float('nan')}]}))
        self.assertFalse(connections.valid_response('deepseek', {'balances': [{}]}))
        self.assertTrue(connections.valid_response('deepseek', {'balances': [{'currency': 'USD', 'total_balance': '0'}]}))

    def test_saving_runtime_config_does_not_write_secure_overlay(self):
        from aibar import config
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config.json'
            path.write_text(json.dumps({'glm': {'token': 'old-legacy', 'platform': 'bigmodel'}}), encoding='utf-8')
            runtime = {'glm': {'token': 'new-secure', 'platform': 'zai'}, '_secure_providers': ['glm']}
            with patch.object(config, 'CONFIG_PATH', path):
                config.save_config(runtime)
            saved = path.read_text(encoding='utf-8')
            self.assertNotIn('new-secure', saved)
            self.assertNotIn('_secure_providers', saved)
            self.assertEqual(json.loads(saved)['glm'], {'token': 'old-legacy', 'platform': 'bigmodel'})

    def test_invalid_input_never_contacts_provider(self):
        with patch('aibar.providers.glm.collect') as collect, patch.object(connections, 'save_connection') as save:
            for provider, key, region in [('evil', 'key', 'zai'), ('glm', 'key', 'evil'),
                                          ('glm', 'bad\nkey', 'zai'), ('glm', '', 'zai')]:
                self.assertFalse(connections.test_and_save(provider, key, region)[0])
            collect.assert_not_called()
            save.assert_not_called()

    def test_failed_verification_preserves_existing_credential(self):
        with patch('aibar.providers.glm.collect', return_value={'error': 'secret-sensitive-error'}), patch.object(connections, 'save_connection') as save:
            ok, message = connections.test_and_save('glm', 'test-secret')
            self.assertFalse(ok)
            self.assertNotIn('secret', message)
            save.assert_not_called()

    def test_success_verifies_before_atomic_save(self):
        events = []
        def collect(**kw):
            events.append(('query', kw['api_key']))
            return {'balances': [{'currency': 'USD', 'total_balance': '0'}]}
        with patch('aibar.providers.deepseek.collect', side_effect=collect), patch.object(connections, 'save_connection', side_effect=lambda *args: events.append(('save', args[1]))):
            ok, message = connections.test_and_save('deepseek', 'test-secret')
        self.assertTrue(ok)
        self.assertEqual(events, [('query', 'test-secret'), ('save', 'test-secret')])
        self.assertNotIn('test-secret', message)

    def test_storage_failure_is_redacted(self):
        with patch('aibar.providers.deepseek.collect', return_value={'balances': [{'currency': 'USD', 'total_balance': '1'}]}), patch.object(connections, 'save_connection', side_effect=OSError('secret')):
            ok, message = connections.test_and_save('deepseek', 'sensitive')
        self.assertFalse(ok)
        self.assertNotIn('secret', message)
        self.assertNotIn('sensitive', message)

    def test_overlay_preserves_legacy_disk_configuration(self):
        cfg = {'glm': {'token': 'legacy', 'platform': 'bigmodel'}, 'hidden_sources': ['glm']}
        original = copy.deepcopy(cfg)
        with patch.object(connections, 'read_connection', side_effect=[{'secret': 'new', 'platform': 'zai'}, None]):
            result = connections.overlay(cfg)
        self.assertEqual(cfg, original)
        self.assertEqual(result['glm']['token'], 'new')
        self.assertEqual(result['hidden_sources'], ['glm'])

    def test_missing_store_keeps_legacy_but_store_failure_fails_closed(self):
        cfg = {'glm': {'token': 'legacy'}}
        with patch.object(connections, 'read_connection', return_value=None):
            self.assertEqual(connections.overlay(cfg)['glm']['token'], 'legacy')
        with patch.object(connections, 'read_connection', side_effect=OSError):
            result = connections.overlay(cfg)
            self.assertEqual(result['glm']['token'], '')
            self.assertIn('glm', result['_connection_errors'])

    def test_official_destinations_and_no_enumeration(self):
        self.assertEqual(connections.key_page('deepseek'), 'https://platform.deepseek.com/api_keys')
        with self.assertRaises((KeyError, ValueError)):
            connections.key_page('https://evil.test')
        with self.assertRaises(ValueError):
            connections.read_connection('another-app')


class Display(unittest.TestCase):
    def test_failed_old_values_are_removed_from_flyout_and_detail(self):
        for status in ({'stale': True}, {'stale': False, 'error': 'TimeoutError'}):
            view = {'glm': dict(status, windows=[{'percent': 5, 'label': '5h'}]),
                    'deepseek': dict(status, balances=[{'currency': 'USD', 'total_balance': '987.65'}]),
                    'antigravity': dict(status, windows=[{'percent': 7, 'label': 'Weekly'}])}
            before = copy.deepcopy(view)
            self.assertFalse(any(c['bars'] for c in compact_cards(view)))
            cards = source_cards(view)
            self.assertFalse(any(c.get('bars') for c in cards))
            self.assertNotIn('987.65', str(cards))
            self.assertEqual(view, before)

    def test_bad_numeric_windows_never_render(self):
        view = {'glm': {'stale': False, 'windows': [{'percent': value} for value in [True, float('nan'), float('inf'), -1, 101, '50']]}}
        self.assertEqual(trusted_view(view)['glm']['windows'], [])

    def test_compact_name_contains_no_identity_and_keeps_weekly(self):
        account = {'label': 'alice@example.test', 'plan_type': 'prolite', 'is_current': True,
            'attribution_verified': True, 'stale': False, 'primary_window_minutes': 10080,
            'effective_primary_used_percent': 40}
        view = {'codex': {'accounts': [account]}, 'visible': {'codex': True, 'glm': False, 'deepseek': False, 'antigravity': False, 'muse': False}}
        with patch.dict(os.environ, QUANTA_UI_LANGUAGE='zh'):
            i18n.language.cache_clear()
            cards = compact_cards(view)
            self.assertNotIn('alice', str(cards))
            self.assertNotIn('@', str(cards))
            self.assertEqual(cards[0]['bars'], [('周', 60)])
            self.assertIn('当前账号', cards[0]['name'])
        i18n.language.cache_clear()

    def test_refresh_failure_discards_recommendation_and_quota(self):
        view = {'_refresh_error': 'TimeoutError', 'recommendation': {'label': 'old'},
                'glm': {'stale': False, 'windows': [{'percent': 0}]}}
        result = trusted_view(view)
        self.assertNotIn('recommendation', result)
        self.assertEqual(result['glm']['windows'], [])

    def test_legends_follow_detected_sources(self):
        rows = str(legend_rows({'visible': {'muse': False, 'deepseek': False}}))
        self.assertNotIn('Muse', rows)
        self.assertNotIn('DeepSeek', rows)
        rows = str(legend_rows({'visible': {'muse': True, 'deepseek': True}}))
        self.assertIn('Muse', rows)
        self.assertIn('DeepSeek', rows)

    def test_bilingual_assets_and_html_boundary(self):
        with patch.dict(os.environ, QUANTA_UI_LANGUAGE='en'):
            i18n.language.cache_clear()
            self.assertEqual(i18n.tr('连接'), 'Connect')
            self.assertEqual(i18n.tr('周'), 'Weekly')
            html = build_panel_html({'visible': {'codex': True}}, [])
            self.assertIn('Content-Security-Policy', html)
            self.assertIn("connect-src 'none'", html)
            self.assertIn('lang="en"', html)
        i18n.language.cache_clear()


if __name__ == '__main__':
    unittest.main()
