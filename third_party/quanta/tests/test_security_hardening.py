"""安全加固回归测试：轮转、行长上限、错误日志上限、红警阈值。"""
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from aibar import history
from aibar.providers import muse


class HistoryRotation(unittest.TestCase):
    def test_rotation_caps_file_lines(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "history.jsonl"
            view = {"codex": {}, "deepseek": {"balances": []}}
            for _ in range(history.MAX_LINES + 200):
                self.assertTrue(history.append_history(view, path))
            lines = path.read_text(encoding="utf-8").splitlines()
            self.assertLessEqual(len(lines), history.MAX_LINES)


class MuseParserLimits(unittest.TestCase):
    def test_giant_line_is_skipped_and_valid_events_survive(self):
        now_us = int((datetime.now(timezone.utc)).timestamp() * 1e6)
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            log = root / "session.jsonl"
            giant = '{"pad":"' + "x" * (12 * 1024 * 1024) + '"}'  # 12MB 单行
            good = json.dumps({"recorded_at": now_us, "payload_type": "runtime.session",
                               "usage": {"input_tokens": 10, "output_tokens": 5}})
            log.write_text(giant + "\n" + good + "\n", encoding="utf-8")
            seen, events, turns = set(), [], []
            muse._events_from_file(log, seen, events, turns)
            self.assertEqual(sum(t for _ts, t in events), 15)

    def test_malformed_lines_are_skipped(self):
        now_us = int((datetime.now(timezone.utc)).timestamp() * 1e6)
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "session.jsonl"
            lines = [
                "{broken",
                "[]",
                '{"usage": "not-a-dict"}',
                json.dumps({"id": "a", "recorded_at": now_us, "payload_type": "runtime.session",
                            "usage": {"input_tokens": 7}}),
            ]
            log.write_text("\n".join(lines), encoding="utf-8")
            seen, events, turns = set(), [], []
            muse._events_from_file(log, seen, events, turns)
            self.assertEqual([t for _ts, t in events], [7])


class MuseColorPolicy(unittest.TestCase):
    def test_muse_is_always_purple_when_available(self):
        """计数制：本地无法判定真实发不出去，不做红色告警（始终紫色）。"""
        from aibar.oneshot import render_rows, build_flyout_cards
        from aibar.icon import PURPLE

        def view(count):
            return {"muse": {"label": "Muse", "available": True,
                             "five_hour": {"requests": count, "tokens": 1000},
                             "today_tokens": 0, "week_7d_tokens": 0}}

        for count in (0, 4, 10, 25, 50):
            with self.subTest(count=count):
                rows = [r for r in render_rows(view(count)) if r.text.startswith("Muse")]
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0].color, PURPLE)
                card = next(c for c in build_flyout_cards(view(count)) if c["name"] == "Muse")
                self.assertEqual(card["dot"], PURPLE)
                self.assertIn(f"过去5小时 {count} 条", card["headline"])
                self.assertNotIn("/10", card["headline"])
                self.assertEqual(card["bars"], [])


class PanelEntryConsistency(unittest.TestCase):
    """事故复盘：ui_windows 引用了 panel 里被改名的函数而测试没拦住。
    这组测试锁定入口命名与文件交接方式，改名必须同步。"""

    def test_dispatch_matches_panel_api(self):
        if sys.platform != "win32":
            self.skipTest("Windows tray entry point")
        from aibar import panel, ui_windows
        with patch.object(sys, "argv", ["app.exe", "--panel-stdin", "path with spaces.html"]), \
             patch.object(panel, "run_panel_from_file") as show, \
             patch.object(ui_windows, "_already_running", side_effect=AssertionError("tray entered")):
            ui_windows.main()
        show.assert_called_once_with("path with spaces.html")

    def test_frozen_panel_child_uses_file_handoff_and_deletes_it(self):
        from aibar import panel
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "中文 path.html"
            page = "<h1>中文用量 123</h1>"
            path.write_text(page, encoding="utf-8")
            backend = Mock()
            def create(*args, **kwargs):
                self.assertFalse(path.exists())
                self.assertEqual(kwargs["html"], page)
            backend.create_window.side_effect = create
            with patch.dict(sys.modules, {"webview": backend}), patch.object(panel, "detail_menu", return_value=[]):
                panel.run_panel_from_file(str(path))
            backend.start.assert_called_once()


class ServerCrossPlatform(unittest.TestCase):
    """事故复盘：SO_EXCLUSIVEADDRUSE 被无条件引用，macOS 无该常量会 AttributeError。"""

    def test_exclusive_addruse_is_platform_guarded(self):
        from aibar import server
        cfg = {"server": {"host": "127.0.0.1", "port": 0, "token": "x" * 16}}
        with patch.object(server, "socket", SimpleNamespace()):
            with server.create_server(cfg) as instance:
                self.assertGreater(instance.server_address[1], 0)

    def test_create_server_binds_and_second_instance_rejected(self):
        import socket as _socket
        from aibar.server import create_server
        cfg = {"server": {"host": "127.0.0.1", "port": 0, "token": "x" * 16}}
        first = create_server(cfg)
        try:
            port = first.server_address[1]
            cfg2 = {"server": {"host": "127.0.0.1", "port": port, "token": "y" * 16}}
            with self.assertRaises(OSError):
                create_server(cfg2)
        finally:
            first.server_close()
