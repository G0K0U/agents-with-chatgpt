"""Milestone 1: interactive refresh + status transparency (Linux-runnable)."""
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from aibar import history
from aibar.history import sparkline
from aibar.oneshot import render, render_rows
from aibar.panel import build_panel_html
from aibar.status_text import REFRESHING_TEXT, format_tooltip, last_refresh_row


def _texts(view):
    return [r.text for r in render_rows(view)]


class InteractiveRefresh(unittest.TestCase):
    def test_double_click_is_default_refresh_item(self):
        src = Path("aibar/ui_windows.py").read_text(encoding="utf-8")
        self.assertIn("打开面板", src)
        self.assertIn("REFRESHING_TEXT", src)
        # 双击 = 默认菜单项
        self.assertRegex(src, r'MenuItem\(tr\("立即刷新"\).*default=True')

    def test_mac_has_panel_and_refreshing_state(self):
        src = Path("aibar/ui_mac.py").read_text(encoding="utf-8")
        self.assertIn("打开面板", src)
        self.assertIn("REFRESHING_TEXT", src)
        self.assertIn("last_refresh_row", src)

    def test_refreshing_and_completion_text(self):
        self.assertEqual(REFRESHING_TEXT, "刷新中…")
        view = {"codex": {"accounts": []}, "muse": {"available": False}}
        stamp = datetime(2026, 9, 4, 12, 34, 56, tzinfo=timezone.utc)
        tip = format_tooltip(view, stamp)
        self.assertIn("更新", tip)
        self.assertIn(stamp.astimezone().strftime("%H:%M:%S"), tip)
        self.assertIn("上次刷新", last_refresh_row(stamp))
        self.assertIn("尚未刷新", last_refresh_row(None))

    def test_completed_title_preserves_remaining_and_muse_count(self):
        now = datetime.now(timezone.utc)
        view = {
            "codex": {"accounts": [{
                "account_id": "a", "label": "A", "is_current": True,
                "attribution_verified": True, "stale": False,
                "snapshot_ts": now.timestamp(),
                "effective_primary_used_percent": 20,
                "effective_secondary_used_percent": 30,
            }]},
            "muse": {"available": True, "five_hour": {"requests": 7}},
            "glm": {"stale": True}, "deepseek": {"stale": True},
            "antigravity": {"stale": True},
        }
        tip = format_tooltip(view, now)
        self.assertIn("剩80%", tip)
        self.assertIn("Muse过去5h 7条", tip)

    def test_codex_no_snapshot_reason(self):
        texts = _texts({"codex": {}})
        self.assertTrue(any("近 8 天无快照" in t for t in texts))

    def test_antigravity_ide_stopped_reason(self):
        view = {"antigravity": {"available": True, "windows": [],
                                "conversations": 3, "generations": 5}}
        texts = _texts(view)
        self.assertTrue(any("IDE 未运行" in t for t in texts))
        self.assertTrue(any("会话 3" in t and "生成 5 次" in t for t in texts))

    def test_muse_wsl_reason_and_count_system(self):
        texts = _texts({"muse": {"available": False}})
        self.assertTrue(any("WSL 关闭或尚未使用" in t for t in texts))
        full = render({"muse": {"available": True, "five_hour": {"requests": 2, "tokens": 300},
                                "today_tokens": 1, "week_7d_tokens": 3}})
        self.assertIn("2 条", full)
        self.assertIn("300 tok", full)

    def test_token_missing_reasons(self):
        texts = _texts({"glm": {"error": "未配置 GLM token（config.json → glm.token）"},
                        "deepseek": {"error": "未配置 DeepSeek API key（config.json → deepseek.api_key）"}})
        joined = "\n".join(texts)
        self.assertIn("未配置 GLM token", joined)
        self.assertIn("未配置 DeepSeek API key", joined)

    def test_no_percent_sources_explain_themselves(self):
        joined = render({"deepseek": {"balances": [], "stale": False},
                         "muse": {"available": False}})
        self.assertIn("余额 未知", joined)
        self.assertIn("Muse 未运行", joined)

    def test_history_append_and_trend(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "history.jsonl"
            view = {"recommendation": {"remaining_5h": 80.0, "remaining_week": 70.0},
                    "glm": {"windows": [{"percent": 10}]},
                    "antigravity": {"windows": [{"percent": 20}]},
                    "deepseek": {"balances": [{"total_balance": "5.0", "currency": "USD"}]},
                    "muse": {"five_hour": {"requests": 2}}}
            self.assertTrue(history.append_history(view, path))
            self.assertTrue(history.append_history(view, path))
            loaded = history.load_history(path=path)
            self.assertEqual(len(loaded), 2)
            self.assertEqual(sparkline([1, 2, 3]), "▁▄█")
            self.assertEqual(sparkline([]), "暂无趋势")

    def test_panel_cards_use_existing_view_only(self):
        view = {"merged_at": "2026-09-04T00:00:00+00:00",
                "codex": {"accounts": []},
                "glm": {"error": "未配置 GLM token"}, "deepseek": {"error": "未配置 DeepSeek API key"},
                "muse": {"available": False}, "antigravity": {"available": False}}
        page = build_panel_html(view, [])
        for title in ("Codex", "GLM", "DeepSeek", "Muse", "Antigravity"):
            self.assertIn(title, page)
        self.assertIn("近 7 天趋势", page)
        self.assertIn("托盘常驻", page)


if __name__ == "__main__":
    unittest.main()
