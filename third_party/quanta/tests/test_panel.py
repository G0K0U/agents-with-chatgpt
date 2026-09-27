"""Milestone 2: detail panel (HTML via existing merge layer, no new network)."""
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from aibar import history, panel
from aibar.panel import build_panel_html, source_cards


def _view(now):
    return {
        "merged_at": now,
        "recommendation": {"label": "A", "remaining_5h": 80, "remaining_week": 70},
        "codex": {"accounts": [{
            "account_id": "a", "label": "A", "is_current": True,
            "attribution_verified": True, "stale": False,
            "snapshot_ts": time.time(), "snapshot_at": now,
            "primary_resets_at": time.time() + 3600,
            "effective_primary_used_percent": 20,
            "effective_secondary_used_percent": 30}]},
        "glm": {"stale": False, "windows": [{"label": "5h窗口", "percent": 10, "reset_at": time.time() + 3600}],
                "updated_at": now},
        "deepseek": {"stale": False, "balances": [{"total_balance": "5.0", "currency": "USD"}],
                     "is_available": True, "updated_at": now},
        "muse": {"label": "Muse", "available": True, "week_7d_tokens": 4,
                 "today_tokens": 1, "five_hour": {"requests": 3}, "updated_at": now},
        "antigravity": {"stale": False, "available": True, "windows": [{"label": "Gemini 5h窗口", "percent": 15,
                                                        "reset_at": time.time() + 3600}],
                        "conversations": 2, "generations": 4, "updated_at": now},
    }


class Panel(unittest.TestCase):
    def test_six_cards_chinese_and_top_lamp(self):
        now = datetime.now(timezone.utc).isoformat()
        cards = source_cards(_view(now))
        self.assertEqual([c["key"] for c in cards],
                         ["codex", "glm", "deepseek", "muse", "antigravity"])
        for card in cards:
            for field in ("title", "value", "reset", "updated", "source"):
                self.assertTrue(card[field], card["key"] + "/" + field)
        page = build_panel_html(_view(now), [])
        for title in ("Codex", "GLM", "DeepSeek", "Muse", "Antigravity"):
            self.assertIn(title, page)
        self.assertIn("汇总", page)
        self.assertIn("当前数值", page)
        self.assertIn("重置倒计时", page)
        self.assertIn("上次刷新", page)
        self.assertIn("数据来源", page)
        self.assertIn("近 7 天趋势", page)
        # self-contained: no external fetches
        self.assertNotIn("http://", page)
        self.assertNotIn("https://", page)

    def test_adversarial_labels_are_escaped(self):
        # 对抗：厂商字段里混入 <script> 必须被转义，不得进入 HTML 生效
        now = datetime.now(timezone.utc).isoformat()
        view = {"merged_at": now,
                "glm": {"stale": False, "windows": [{"label": "<script>alert(1)</script>", "percent": 10}],
                        "updated_at": now},
                "codex": {"accounts": [{"account_id": "x", "label": "<img src=x onerror=alert(2)>",
                                        "is_current": True, "attribution_verified": True,
                                        "stale": False, "snapshot_ts": time.time(),
                                        "snapshot_at": now,
                                        "primary_resets_at": time.time() + 3600,
                                        "effective_primary_used_percent": 5,
                                        "effective_secondary_used_percent": 5}]}}
        page = build_panel_html(view, [])
        self.assertNotIn("<script>alert(1)</script>", page)
        self.assertNotIn("<img src=x onerror=alert(2)>", page)
        self.assertIn("&lt;script&gt;", page)
        self.assertIn("&lt;img", page)

    def test_degraded_sources_still_render_reasons(self):
        now = datetime.now(timezone.utc).isoformat()
        view = {"merged_at": now, "codex": {},
                "glm": {"error": "未配置 GLM token"},
                "deepseek": {"error": "未配置 DeepSeek API key"},
                "muse": {"available": False},
                "antigravity": {"stale": False, "available": True, "windows": [], "conversations": 1, "generations": 2}}
        page = build_panel_html(view, [])
        self.assertIn("近 8 天无快照", page)
        self.assertIn("未配置 token", page)
        self.assertIn("WSL 未运行", page)
        self.assertIn("IDE 未运行", page)

    def test_history_filters_to_seven_days(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "history.jsonl"
            fresh = {"ts": datetime.now(timezone.utc).isoformat(), "codex_5h_remaining": 80}
            old_ts = datetime.fromtimestamp(time.time() - 8 * 86400, tz=timezone.utc).isoformat()
            old = {"ts": old_ts, "codex_5h_remaining": 10}
            path.write_text(__import__("json").dumps(fresh) + "\n" + __import__("json").dumps(old) + "\n",
                            encoding="utf-8")
            loaded = history.load_history(path=path)
            self.assertEqual(len(loaded), 1)
            self.assertEqual(loaded[0]["codex_5h_remaining"], 80)

    def test_trend_sparkline_edge_cases(self):
        self.assertEqual(history.sparkline([]), "暂无趋势")
        self.assertEqual(history.sparkline([None, None]), "暂无趋势")
        self.assertEqual(history.sparkline([5]), "暂无趋势")
        flat = history.sparkline([3, 3, 3])
        self.assertTrue(flat and flat != "暂无趋势")
        rising = history.sparkline([1, 2, 3, 4])
        self.assertEqual(len(rising), 4)

    def test_panel_uses_existing_merge_layer(self):
        import inspect
        src = inspect.getsource(panel.get_panel_html)
        self.assertIn("collect_merged", src)
        # no new network paths in panel/history
        for mod in (panel, history):
            src = inspect.getsource(mod)
            self.assertNotIn("urllib.request", src)
            self.assertNotIn("http.client", src)
            self.assertNotIn("socket.create_connection", src)

    def test_subprocess_path_is_preferred(self):
        # 子进程可用时直接走 webview-subprocess，不再碰进程内 webview
        with patch.object(panel, "_show_in_subprocess", return_value=True) as sub, \
             patch.object(panel, "_show_with_webview", side_effect=AssertionError("must not be called")) as web, \
             patch.object(panel, "get_panel_html", return_value="<html></html>"):
            self.assertEqual(panel.show_panel(), "webview-subprocess")
            sub.assert_called_once()
            web.assert_not_called()

    def test_webview_failure_falls_back_to_tkinter(self):
        # 子进程不可用 + 进程内 webview 也失败 → tkinter 兜底
        with patch.object(panel, "_show_in_subprocess", return_value=False), \
             patch.object(panel, "_show_with_webview", side_effect=RuntimeError("no gui")) as web, \
             patch.object(panel, "_show_with_tkinter", return_value=True) as tk, \
             patch.object(panel, "get_panel_html", return_value="<html></html>"):
            self.assertEqual(panel.show_panel(), "tkinter")
            web.assert_called_once()
            tk.assert_called_once()

    def test_open_panel_does_not_block_tray(self):
        with patch.object(panel, "show_panel", return_value="webview") as show:
            thread = panel.open_panel_in_background()
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
            show.assert_called_once()
            self.assertTrue(thread.daemon)


if __name__ == "__main__":
    unittest.main()
