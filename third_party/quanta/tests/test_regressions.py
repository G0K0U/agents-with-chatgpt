import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from aibar import collect, common, config, icon, merge, server
from aibar.oneshot import render
from aibar.providers import antigravity, codex, muse


class Regressions(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        # Keep observations behind both Windows clock APIs (their precision differs).
        self.now = datetime.now(timezone.utc) - timedelta(seconds=1)

    def tearDown(self):
        self.tmp.cleanup()

    def snapshot(self, machine='local', **providers):
        return {'machine': machine, 'generated_at': self.now.isoformat(), **providers}

    def account(self, **changes):
        data = {'account_id': 'a', 'label': 'A', 'is_current': True,
                'attribution_verified': True, 'snapshot_ts': self.now.timestamp(),
                'primary_used_percent': 10, 'secondary_used_percent': 20,
                'primary_window_minutes': 300, 'secondary_window_minutes': 10080,
                'primary_resets_at': (self.now + timedelta(hours=1)).timestamp(),
                'secondary_resets_at': (self.now + timedelta(days=1)).timestamp()}
        data.update(changes)
        return data

    def test_weekly_exhausted_account_is_red_and_not_recommended(self):
        view = merge.merge_snapshots(self.snapshot(codex={'accounts': [self.account(secondary_used_percent=100)]}), [])
        self.assertNotIn('recommendation', view)
        self.assertEqual(icon.overall_remaining(view), 0)

    def test_recommendation_uses_both_windows(self):
        accounts = [self.account(primary_used_percent=0, secondary_used_percent=95),
                    self.account(account_id='b', label='B', primary_used_percent=25, secondary_used_percent=30)]
        view = merge.merge_snapshots(self.snapshot(codex={'accounts': accounts}), [])
        self.assertEqual(view['recommendation']['label'], 'B')

    def test_expired_observation_is_unknown_not_full(self):
        account = self.account(primary_resets_at=self.now.timestamp()-1, secondary_resets_at=self.now.timestamp()-1)
        view = merge.merge_snapshots(self.snapshot(codex={'accounts': [account]}), [])
        normalized = view['codex']['accounts'][0]
        self.assertIsNone(normalized['effective_primary_used_percent'])
        self.assertIsNone(normalized['effective_secondary_used_percent'])
        self.assertNotIn('recommendation', view)
        self.assertIsNone(icon.overall_remaining(view))
        self.assertNotIn('满血', render(view))

    def test_old_or_unverified_account_is_not_advice(self):
        for values in ({'snapshot_ts': self.now.timestamp()-3600}, {'attribution_verified': False}):
            view = merge.merge_snapshots(self.snapshot(codex={'accounts': [self.account(**values)]}), [])
            self.assertNotIn('recommendation', view)
            self.assertIsNone(icon.overall_remaining(view))

    def test_remote_current_does_not_replace_local_current(self):
        a = self.account(is_current=False)
        b = self.account(is_current=True)
        result = merge.merge_snapshots(self.snapshot(codex={'accounts': [a]}),
                                       [self.snapshot('other', codex={'accounts': [b]})])
        self.assertFalse(result['codex']['accounts'][0]['is_current'])

    def test_codex_switch_never_assigns_unidentified_snapshot(self):
        state_path = self.root / 'state.json'
        common.write_json(state_path, {'accounts': {'old': self.account()}, 'current_account_id': 'old'})
        common.write_json(self.root / 'auth.json', {'tokens': {'account_id': 'new'}, 'last_refresh': self.now.isoformat()})
        rl = {'primary': {'used_percent': 42, 'resets_at': self.now.timestamp()+3600}}
        with patch.object(codex, 'STATE_PATH', state_path), patch.object(codex, '_scan_sessions', return_value=[(self.now, rl)]):
            result = codex.collect(self.root)
        self.assertEqual([a['account_id'] for a in result['accounts']], ['old'])
        self.assertFalse(result['accounts'][0]['attribution_verified'])
        self.assertEqual(result['latest_unattributed']['primary_used_percent'], 42)

    def test_codex_other_limit_bucket_is_ignored(self):
        path = self.root / 'rollout.jsonl'
        path.write_text(json.dumps({'type': 'event_msg', 'timestamp': self.now.isoformat(),
            'payload': {'rate_limits': {'limit_id': 'another-model', 'primary': {'used_percent': 70}}}}))
        self.assertIsNone(codex._latest_snapshot_from_file(path))

    def test_muse_rolling_window_and_duplicate_turns(self):
        frames = []
        for i, age in enumerate([6, 2, 0.5]):
            rec = {'id': f'event-{i}', 'recorded_at': int((self.now-timedelta(hours=age)).timestamp()*1e6),
                   'payload_type': 'runtime.user_intent.accepted'}
            frames.append(json.dumps({'children': [{'record_json': json.dumps(rec)}]}))
        (self.root/'session.jsonl').write_text('\n'.join(frames + frames[-1:]))
        with patch.object(muse, 'now_utc', return_value=self.now):
            result = muse.collect([self.root])
        self.assertEqual(result['five_hour']['requests'], 2)

    def test_muse_internal_calls_not_counted_as_messages(self):
        rec = {'id': 'call', 'recorded_at': int(self.now.timestamp()*1e6), 'usage': {'input_tokens': 10}}
        (self.root/'session.jsonl').write_text(json.dumps(rec))
        result = muse.collect([self.root])
        self.assertEqual(result['five_hour']['requests'], 0)
        self.assertEqual(result['week_7d_tokens'], 10)

    def test_muse_cross_machine_sum_and_duplicate_machine(self):
        a = self.snapshot(muse={'available': True, 'five_hour': {'requests': 3}})
        b = self.snapshot('other', muse={'available': True, 'five_hour': {'requests': 4}})
        result = merge.merge_snapshots(a, [b, b])
        self.assertEqual(result['muse']['five_hour']['requests'], 7)

    def test_failure_is_visible_not_discarded(self):
        view = merge.merge_snapshots(self.snapshot(glm={'error': 'synthetic failure'}), [])
        self.assertEqual(view['glm']['error'], 'synthetic failure')
        self.assertIn('synthetic failure', render(view))

    def test_stale_provider_does_not_make_green_light(self):
        data = self.snapshot(glm={'windows': [{'label': '5h', 'percent': 0}]})
        data['generated_at'] = (self.now-timedelta(hours=1)).isoformat()
        self.assertIsNone(icon.overall_remaining(merge.merge_snapshots(data, [])))

    def test_default_config_is_not_mutated(self):
        config._merge(config.DEFAULT_CONFIG, {})['server']['token'] = 'changed'
        self.assertEqual(config.DEFAULT_CONFIG['server']['token'], '')

    def test_collect_merged_without_config(self):
        with patch.object(merge, 'load_config', return_value={'peers': []}), patch.object(merge, 'collect_local', return_value=self.snapshot()):
            self.assertEqual(merge.collect_merged()['machines'][0]['name'], 'local')

    def test_parallel_writers_leave_valid_atomic_json(self):
        path = self.root/'state.json'
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda i: common.write_json(path, {'value': i}), range(40)))
        self.assertIn(common.read_json(path)['value'], range(40))
        self.assertEqual(list(self.root.glob('*.tmp')), [])

    def test_collectors_are_serialized(self):
        active = peak = 0
        def work(cfg):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            time.sleep(0.02)
            active -= 1
            return {}
        with patch.object(collect, '_collect_local', side_effect=work), ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(collect.collect_local, [{}, {}, {}, {}]))
        self.assertEqual(peak, 1)

    def test_timestamp_normalization_and_local_day_boundary(self):
        self.assertIsNotNone(common.parse_ts('2026-09-04T00:00:00').tzinfo)
        self.assertIsNone(common.parse_ts(123))
        start = common.local_day_start(self.now)
        self.assertEqual(start.astimezone().hour, 0)
        self.assertEqual(start.astimezone().date(), self.now.astimezone().date())

    def test_antigravity_pid_is_not_extension_port(self):
        lines = ['12345|C:/antigravity/language_server.exe --csrf_token synthetic --extension_server_port 60024']
        with patch.object(antigravity, '_process_lines', return_value=lines):
            self.assertEqual(antigravity._ls_candidates()[0]['pid'], 12345)

    def test_antigravity_no_proxy_handler(self):
        handlers = [h for h in antigravity._OPENER.handlers if isinstance(h, urllib.request.ProxyHandler)]
        self.assertTrue(all(not h.proxies for h in handlers))

    def test_http_api_authentication_cache_and_bound_address(self):
        cfg = {'server': {'host': '127.0.0.1', 'port': 0, 'token': 'synthetic-token-123456'}}
        httpd = server.create_server(cfg, snapshot_reader=lambda: {'machine': 'fixture'})
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        url = f'http://127.0.0.1:{httpd.server_port}/api/usage'
        try:
            with self.assertRaises(urllib.error.HTTPError) as caught:
                opener.open(url, timeout=2)
            self.assertEqual(caught.exception.code, 401)
            caught.exception.close()
            req = urllib.request.Request(url, headers={'X-Token': cfg['server']['token']})
            with opener.open(req, timeout=2) as response:
                self.assertEqual(json.load(response), {'machine': 'fixture'})
            self.assertEqual(httpd.server_address[0], '127.0.0.1')
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join()

    def test_unsafe_listening_addresses_are_rejected(self):
        for address in ('0.0.0.0', '192.168.1.1', '8.8.8.8'):
            with self.assertRaises(ValueError):
                server.validate_host(address)

    def test_public_peer_is_rejected_before_request(self):
        with patch.object(urllib.request, 'build_opener') as build:
            value = merge.fetch_peer({'url': 'http://8.8.8.8:8765', 'token': 'synthetic'})
        self.assertIn('error', value)
        build.assert_not_called()

    def test_windows_accounts_have_separate_menu_rows(self):
        import sys
        if sys.platform != 'win32':
            self.skipTest('Windows menu backend')
        from aibar.ui_windows import TrayApp
        with patch('aibar.ui_windows.ColorIcon'):
            app = TrayApp({})
        # 极简单行式：多账号聚合成一行，展示最优账号；行内不换行
        app.view = merge.merge_snapshots(self.snapshot(codex={'accounts': [self.account(), self.account(account_id='b', label='B')]}), [])
        items = [item.text for item in app._menu()]
        codex_rows = [value for value in items if value.startswith('Codex')]
        self.assertEqual(len(codex_rows), 1)
        self.assertTrue(all('\n' not in value for value in items))


if __name__ == '__main__':
    unittest.main()
