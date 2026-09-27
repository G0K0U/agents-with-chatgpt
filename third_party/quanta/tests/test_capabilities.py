"""自检系统测试：能力检测、可见性过滤、首次运行、看门狗自愈。"""
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from aibar import capabilities, oneshot
from aibar.capabilities import detect


def _home_with(*paths):
    """隔离的假 HOME + 隔离的 sticky 缓存路径。返回 (ctx, home, cache)。
    带文件后缀的相对路径创建为文件，其余创建为目录。"""
    tmp = tempfile.TemporaryDirectory()
    home = Path(tmp.name)
    for rel in paths:
        target = home / rel
        if Path(rel).suffix:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("{}\n", encoding="utf-8")
        else:
            target.mkdir(parents=True, exist_ok=True)
    return tmp, home, home / "capabilities.json"


class CapabilityDetection(unittest.TestCase):
    def test_codex_detected_by_auth_json(self):
        tmp, home, cache = _home_with(".codex/auth.json")
        with tmp:
            caps = detect({}, home=home, cache_path=cache)
            self.assertTrue(caps["codex"]["installed"])
            self.assertTrue(caps["codex"]["visible"])

    def test_codex_absent_when_no_auth(self):
        tmp, home, cache = _home_with()
        with tmp:
            caps = detect({}, home=home, cache_path=cache)
            self.assertFalse(caps["codex"]["installed"])
            self.assertFalse(caps["codex"]["visible"])

    def test_antigravity_detected_by_conversations_dir(self):
        tmp, home, cache = _home_with(".gemini/antigravity-ide/conversations")
        with tmp:
            caps = detect({}, home=home, cache_path=cache)
            self.assertTrue(caps["antigravity"]["installed"])

    def test_muse_native_detected(self):
        tmp, home, cache = _home_with(".local/share/muse/sessions")
        with tmp:
            caps = detect({}, home=home, cache_path=cache)
            self.assertTrue(caps["muse"]["installed"])

    def test_api_sources_configured_by_token(self):
        tmp, home, cache = _home_with()
        with tmp:
            caps = detect({"glm": {"token": "abc"}, "deepseek": {"api_key": ""}},
                           home=home, cache_path=cache)
            self.assertTrue(caps["glm"]["visible"])
            self.assertFalse(caps["deepseek"]["visible"])

    def test_hidden_sources_override(self):
        tmp, home, cache = _home_with(".codex/auth.json")
        with tmp:
            caps = detect({"hidden_sources": ["codex"]}, home=home, cache_path=cache)
            self.assertTrue(caps["codex"]["installed"])
            self.assertFalse(caps["codex"]["visible"])

    def test_enabled_gate(self):
        tmp, home, cache = _home_with(".local/share/muse/sessions")
        with tmp:
            caps = detect({"muse": {"enabled": False}}, home=home, cache_path=cache)
            self.assertTrue(caps["muse"]["installed"])
            self.assertFalse(caps["muse"]["visible"])

    def test_sticky_survives_missing_evidence(self):
        """装过 Muse 后证据消失（WSL 关闭/目录没了）：sticky 缓存独立于 HOME，
        14 天内保持可见。"""
        with tempfile.TemporaryDirectory() as cache_dir:
            cache = Path(cache_dir) / "capabilities.json"
            tmp, home, _ = _home_with(".local/share/muse/sessions")
            with tmp:
                first = detect({}, home=home, cache_path=cache)
                self.assertTrue(first["muse"]["installed"])
            # HOME 整个消失后再次检测（非 full）→ sticky 保持
            caps = detect({}, home=home, cache_path=cache)
            self.assertTrue(caps["muse"]["installed"])

    def test_api_source_hidden_immediately_after_token_removed(self):
        tmp, home, cache = _home_with()
        with tmp:
            cfg = {"glm": {"token": "abc"}}
            detect(cfg, home=home, cache_path=cache)
            cfg["glm"]["token"] = ""
            caps = detect(cfg, home=home, cache_path=cache)
            self.assertFalse(caps["glm"]["visible"])


class VisibilityFiltering(unittest.TestCase):
    def test_hidden_provider_produces_zero_rows(self):
        view = {"visible": {"glm": False, "deepseek": False},
                "glm": {"error": "未配置 GLM token"},
                "deepseek": {"error": "未配置 DeepSeek API key"}}
        texts = [r.text for r in oneshot.render_rows(view)]
        self.assertFalse(any("GLM" in t or "DeepSeek" in t for t in texts))

    def test_visible_provider_produces_single_row(self):
        view = {"visible": {"glm": True},
                "glm": {"windows": [{"label": "5h窗口", "percent": 32}]}}
        rows = [r for r in oneshot.render_rows(view) if r.text.startswith("GLM")]
        self.assertEqual(len(rows), 1)
        self.assertIn("5h窗口 剩 68%", rows[0].text)

    def test_missing_visible_map_defaults_visible(self):
        """旧快照没有 visible 映射 → 全部可见（向后兼容）。"""
        view = {"glm": {"windows": [{"label": "5h窗口", "percent": 10}]}}
        rows = [r for r in oneshot.render_rows(view) if r.text.startswith("GLM")]
        self.assertEqual(len(rows), 1)


class PanelVisibility(unittest.TestCase):
    def test_panel_hides_uninstalled_and_shows_addable_hint(self):
        from aibar.panel import build_panel_html
        view = {"merged_at": "2026-09-05T00:00:00+00:00",
                "visible": {"codex": True, "glm": False, "deepseek": False,
                            "muse": True, "antigravity": True},
                "codex": {"accounts": []},
                "muse": {"available": True, "five_hour": {"requests": 1, "tokens": 100},
                         "today_tokens": 1, "week_7d_tokens": 1},
                "antigravity": {"available": True, "windows": [], "conversations": 1,
                                "generations": 2}}
        page = build_panel_html(view, [])
        self.assertNotIn(">GLM<", page)
        self.assertNotIn(">DeepSeek<", page)
        self.assertIn("GLM · 可连接", page)
        self.assertIn("DeepSeek · 可连接", page)
        self.assertIn('id="add-connection"', page)
        self.assertIn(">Muse<", page)


class WatchdogOnce(unittest.TestCase):
    """看门狗单次自检：线程死亡被重建、结果落盘。"""

    def setUp(self):
        if sys.platform != "win32":
            return
        from aibar import ui_windows
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.apps = []
        for patcher in (mock.patch.object(ui_windows, "DATA_DIR", Path(self.tmp.name)),
                        mock.patch.object(ui_windows.TrayApp, "update_once"),
                        mock.patch.object(capabilities, "detect", return_value={})):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(lambda: [app._teardown() for app in self.apps])

    def _make_app(self):
        from aibar.ui_windows import TrayApp
        with mock.patch("aibar.ui_windows.ColorIcon"):
            app = TrayApp({"server": {"host": "127.0.0.1", "port": 0, "token": "x" * 16},
                           "refresh_seconds": 300, "watchdog_seconds": 600})
        self.apps.append(app)
        return app

    @unittest.skipUnless(sys.platform == "win32", "Windows tray runtime")
    def test_dead_collector_thread_is_rebuilt(self):
        app = self._make_app()
        app._loop_thread = threading.Thread(target=lambda: None, daemon=True)
        app._loop_thread.start()
        app._loop_thread.join(timeout=2)  # 线程自然结束 = 死亡
        report = app._watchdog_once()
        self.assertIn("collector-thread", report["healed"])
        self.assertTrue(app._loop_thread.is_alive())

    @unittest.skipUnless(sys.platform == "win32", "Windows tray runtime")
    def test_watchdog_report_persisted(self):
        app = self._make_app()
        app._loop_thread = threading.Thread(target=lambda: None, daemon=True)
        app._loop_thread.start()
        app._loop_thread.join(timeout=2)
        app._watchdog_once()
        from aibar.common import read_json
        report = read_json(Path(self.tmp.name) / "watchdog.json")
        self.assertTrue(report.get("checked_at"))


class FlyoutCardRegression(unittest.TestCase):
    """事故复盘：Codex 推荐分支用到 fmt_reset，而 GLM 分支深处的局部
    from-import 让它变成未绑定局部变量——真实数据（有推荐+重置时间）
    一渲染就 UnboundLocalError，浮窗永远弹不出来。"""

    def test_codex_recommendation_with_resets_renders(self):
        import time as _time
        from aibar.oneshot import build_flyout_cards
        view = {
            "visible": {"codex": True, "glm": True},
            "recommendation": {"label": "me@x.test", "remaining_5h": 77.0,
                               "remaining_week": 34.0, "is_current": True,
                               "windows": [{"label": "5h", "window_minutes": 300,
                                            "remaining": 77.0, "resets_at": _time.time() + 3600},
                                           {"label": "周", "window_minutes": 10080,
                                            "remaining": 34.0, "resets_at": _time.time() + 7200}]},
            "codex": {"accounts": [{"label": "me@x.test", "is_current": True,
                                    "primary_resets_at": _time.time() + 3600}]},
            "glm": {"windows": [{"label": "5h窗口", "percent": 10,
                                 "reset_at": _time.time() + 7200}]},
        }
        cards = build_flyout_cards(view)  # 崩溃点：Codex 分支先于 GLM 局部导入执行
        codex = next(c for c in cards if c["name"].startswith("Codex"))
        self.assertIn("重置", codex["detail"])
        glm = next(c for c in cards if c["name"] == "GLM")
        self.assertTrue(glm["detail"])  # GLM 分支同样用 fmt_reset

    def test_no_local_imports_in_build_flyout_cards(self):
        """防复发：函数体内不允许局部 import（名字遮蔽根源）。"""
        import ast
        import inspect
        from aibar import oneshot
        src = inspect.getsource(oneshot.build_flyout_cards)
        for node in ast.walk(ast.parse(src)):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                self.fail(f"build_flyout_cards 含局部 import: line {node.lineno}")
