"""Behavior regressions for startup, isolation and credential boundaries."""
import io
import json
import socket
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch

from aibar import capabilities, config, http_client, server
from aibar.common import now_utc


class CredentialBoundaries(unittest.TestCase):
    def test_redirect_never_receives_authorization(self):
        received = []

        class Redirect(BaseHTTPRequestHandler):
            def do_GET(self):
                received.append((self.path, self.headers.get("Authorization")))
                self.send_response(302)
                self.send_header("Location", "/redirected")
                self.end_headers()

            def log_message(self, *args):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), Redirect) as httpd:
            worker = threading.Thread(target=httpd.serve_forever, daemon=True)
            worker.start()
            try:
                req = urllib.request.Request(f"http://127.0.0.1:{httpd.server_port}/original",
                                             headers={"Authorization": "synthetic-secret"})
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    http_client.official_opener().open(req, timeout=2)
                caught.exception.close()
                self.assertEqual(received, [("/original", "synthetic-secret")])
            finally:
                httpd.shutdown()
                worker.join(timeout=2)

    def test_oversized_and_nonobject_responses_rejected(self):
        for body in (b" " * 21, b"[]", b"null"):
            with self.assertRaises(ValueError):
                http_client.read_object(io.BytesIO(body), limit=20)

    def test_provider_error_does_not_persist_secret(self):
        from aibar.providers import glm, deepseek
        fixture = "test-input-value-not-a-real-key"
        for module, kwargs in ((glm, {"token": fixture}),
                               (deepseek, {"api_key": fixture})):
            with patch.object(module._OPENER, "open", side_effect=OSError(fixture)):
                self.assertEqual(module.collect(**kwargs), {"error": "OSError"})

    def test_damaged_config_is_preserved(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "config.json"
            for body in ('{"server":', '[]', '{"server":null}'):
                path.write_text(body, encoding="utf-8")
                with patch.object(config, "CONFIG_PATH", path), patch.object(config, "ensure_dirs"):
                    with self.assertRaises(ValueError):
                        config.load_config()
                self.assertEqual(path.read_text(encoding="utf-8"), body)

    def test_slow_connection_times_out_and_releases_slot(self):
        cfg = {"server": {"host": "127.0.0.1", "port": 0, "token": "x" * 16}}
        with patch.object(server._Server, "request_timeout", 0.1), server.create_server(cfg) as httpd:
            worker = threading.Thread(target=httpd.serve_forever, daemon=True)
            worker.start()
            try:
                with socket.create_connection(httpd.server_address, timeout=2) as client:
                    client.sendall(b"GET /api/usage HTTP/1.1\r\n")
                    self.assertEqual(client.recv(20), b"")
            finally:
                httpd.shutdown()
                worker.join(timeout=2)


class Discovery(unittest.TestCase):
    def test_flyout_stays_on_anchor_monitor(self):
        from aibar.flyout import place_near_anchor
        for bounds, anchor in (((-1920, 0, 0, 1040), (-60, 1060)),
                               ((1920, 0, 3840, 1040), (3700, 1060)),
                               ((0, 40, 1920, 1080), (20, 20))):
            x, y = place_near_anchor(anchor, 570, 700, bounds)
            self.assertGreaterEqual(x, bounds[0])
            self.assertGreaterEqual(y, bounds[1])
            self.assertLessEqual(x + 570, bounds[2])
            self.assertLessEqual(y + 700, bounds[3])

    def test_first_detection_probes_wsl_and_manual_rescan_bypasses_ttl(self):
        with tempfile.TemporaryDirectory() as d, \
             patch.object(capabilities, "_muse_native_evidence", return_value=None), \
             patch.object(capabilities, "_muse_wsl_evidence", return_value="synthetic WSL") as probe, \
             patch.object(capabilities, "_muse_probe_ts", 0), \
             patch.object(capabilities, "_muse_probe_result", False):
            cache = Path(d) / "caps.json"
            self.assertTrue(capabilities.detect({}, cache_path=cache)["muse"]["visible"])
            capabilities.detect({}, cache_path=cache)
            self.assertEqual(probe.call_count, 1)
            capabilities.rescan({}, cache_path=cache)
            self.assertEqual(probe.call_count, 2)

    def test_naive_and_future_cache_dates_are_safe(self):
        self.assertTrue(capabilities._sticky_alive({"last_seen": now_utc().replace(tzinfo=None).isoformat()}))
        self.assertFalse(capabilities._sticky_alive({"last_seen": (now_utc() + timedelta(days=1)).isoformat()}))


@unittest.skipUnless(sys.platform == "win32", "Windows startup")
class WindowsLifecycle(unittest.TestCase):
    def test_normal_entry_wires_prepared_candidate(self):
        from aibar import ui_windows, flyout
        app, candidate = Mock(), Mock()
        candidate.prepare.return_value = True
        with patch.object(sys, "argv", ["Quanta.exe"]), \
             patch.object(ui_windows, "_already_running", return_value=False), \
             patch.object(ui_windows, "load_config", return_value={}), \
             patch.object(ui_windows, "create_server"), \
             patch.object(ui_windows, "TrayApp", return_value=app), \
             patch.object(ui_windows.threading, "Thread"), \
             patch.object(flyout, "QuantaFlyout", return_value=candidate):
            ui_windows.main()
        self.assertIs(app.flyout, candidate)
        self.assertEqual(app.icon.menu_toggle, candidate.toggle)
        app._icon_lifecycle.assert_called_once()

    def test_prepare_failure_retains_native_menu(self):
        from aibar import ui_windows, flyout
        app, candidate = Mock(), Mock()
        app.icon.menu_toggle = None
        candidate.prepare.return_value = False
        with patch.object(sys, "argv", ["Quanta.exe"]), \
             patch.object(ui_windows, "_already_running", return_value=False), \
             patch.object(ui_windows, "load_config", return_value={}), \
             patch.object(ui_windows, "create_server"), \
             patch.object(ui_windows, "TrayApp", return_value=app), \
             patch.object(flyout, "QuantaFlyout", return_value=candidate):
            ui_windows.main()
        self.assertIsNone(app.icon.menu_toggle)
        app._icon_lifecycle.assert_called_once()

    def test_stale_live_collector_is_not_duplicated_and_bound_host_is_probed(self):
        from aibar import ui_windows
        with patch.object(ui_windows, "ColorIcon"):
            app = ui_windows.TrayApp({"refresh_seconds": 60})
        app._loop_thread = Mock()
        app._serve_thread = Mock()
        app.httpd = Mock(server_address=("100.64.0.9", 8765))
        app.last_completed_at = now_utc() - timedelta(hours=1)
        with patch("socket.create_connection") as connect, \
             patch.object(ui_windows.threading, "Thread") as thread, \
             patch.object(capabilities, "detect"), patch.object(ui_windows, "write_json"), \
             patch.object(app, "_append_watchdog_log"):
            report = app._watchdog_once()
        connect.assert_called_once_with(("100.64.0.9", 8765), timeout=2)
        thread.assert_not_called()
        self.assertTrue(report["collector_stale"])

    def test_normal_flyout_exit_restores_native_menu(self):
        from aibar.ui_windows import _run_flyout_guarded
        app, flyout = Mock(), Mock()
        _run_flyout_guarded(app, flyout)
        self.assertIsNone(app.icon.menu_toggle)
        self.assertIsNone(app.flyout)
