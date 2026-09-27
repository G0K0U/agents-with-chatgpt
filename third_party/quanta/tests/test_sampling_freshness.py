"""Synthetic sampling-time and cache-failure contract tests."""

import json
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

from aibar import collect, server
from aibar.common import write_json
from aibar.providers import glm


class SamplingFreshnessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "snapshot.json"
        self.addCleanup(self.temp.cleanup)

    def test_summary_does_not_certify_other_providers(self):
        stamp = "2026-09-27T01:00:00+00:00"
        visible = {key: {"visible": key in ("codex", "glm", "antigravity")}
                   for key in collect.KEY_ORDER}
        codex = {"accounts": [{"is_current": True, "snapshot_at": stamp}],
                 "observed_at": stamp, "observed_at_scope": "current_account"}
        ag = {"windows": [{"percent": 15}]}
        glm = {"windows": [{"percent": 25}]}
        with patch.object(collect, "SNAPSHOT_PATH", self.path), \
             patch.object(collect, "detect", return_value=visible), \
             patch.object(collect.codex, "collect", return_value=codex), \
             patch.object(collect.antigravity, "collect", return_value=ag), \
             patch.object(collect.glm, "collect", return_value=glm):
            result = collect.collect_local({"machine_name": "TEST", "labels": {}})
        self.assertEqual(result["observed_at"], stamp)
        self.assertEqual(result["observed_at_scope"], "partial_summary")
        self.assertNotIn("observed_at", result["antigravity"])
        self.assertNotIn("observed_at", result["glm"])

    def test_failed_provider_refresh_retains_original_sample_time(self):
        stamp = "2026-09-27T00:00:00+00:00"
        write_json(self.path, {"codex": {"observed_at": stamp,
                                         "accounts": [{"is_current": True, "snapshot_at": stamp}]}})
        visible = {key: {"visible": key == "codex"} for key in collect.KEY_ORDER}
        with patch.object(collect, "SNAPSHOT_PATH", self.path), \
             patch.object(collect, "detect", return_value=visible), \
             patch.object(collect.codex, "collect", side_effect=RuntimeError("synthetic")):
            result = collect.collect_local({"machine_name": "TEST", "labels": {}})
        self.assertEqual(result["codex"]["observed_at"], stamp)
        self.assertTrue(result["codex"]["refresh_failed"])
        self.assertEqual(result["codex"]["error"], "RuntimeError")
        self.assertIsNone(result["observed_at"])

    def test_glm_request_failure_has_no_new_sample_time(self):
        with patch.object(glm._OPENER, "open", side_effect=TimeoutError("synthetic")):
            result = glm.collect(token="synthetic-test-token")
        self.assertEqual(result["error"], "TimeoutError")
        self.assertNotIn("observed_at", result)
        self.assertNotIn("updated_at", result)

    def test_cache_serialization_and_failed_force_refresh_do_not_redate(self):
        stamp = "2026-09-27T00:00:00+00:00"
        original = {"observed_at": stamp, "observed_at_scope": "partial_summary",
                    "codex": {"observed_at": stamp, "accounts": []}}
        cfg = {"server": {"token": "synthetic-test-token-123", "host": "127.0.0.1", "port": 0}}
        httpd = server.create_server(cfg, snapshot_reader=lambda: original)
        worker = threading.Thread(target=httpd.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(lambda: (httpd.shutdown(), worker.join(timeout=2), httpd.server_close()))
        port = httpd.server_address[1]

        def read(suffix=""):
            request = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/usage{suffix}",
                headers={"X-Token": cfg["server"]["token"]})
            with urllib.request.urlopen(request, timeout=3) as response:
                return json.load(response)

        with patch.object(server, "collect_local", side_effect=RuntimeError("synthetic")):
            self.assertEqual(read()["observed_at"], stamp)
            self.assertEqual(read()["observed_at"], stamp)
            forced = read("?force_refresh=true")
        self.assertEqual(forced["observed_at"], stamp)
        self.assertEqual(forced["refresh_error"], "RuntimeError")
        self.assertTrue(forced["codex"]["refresh_failed"])
        self.assertEqual(forced["codex"]["error"], "RefreshFailed")


if __name__ == "__main__":
    unittest.main()
