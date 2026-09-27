"""Exercise file ownership and errors without opening real desktop windows."""
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from aibar import panel


class PanelLifecycle(unittest.TestCase):
    def test_text_fallback_does_not_show_stylesheet_or_script(self):
        page = '<style>body{color:red}</style><script>ignored()</script><h1>额度</h1><p>剩余 80%</p>'
        self.assertEqual(panel._html_to_text(page), '额度\n剩余 80%')

    def test_spawn_failure_removes_written_page(self):
        with tempfile.TemporaryDirectory() as d:
            targets = []
            def fail(args, **kwargs):
                targets.append(Path(args[-1]))
                self.assertTrue(targets[-1].is_file())
                raise OSError("simulated process creation error")
            with patch.object(panel, "DATA_DIR", Path(d)), \
                 patch.object(panel.subprocess, "Popen", side_effect=fail):
                self.assertFalse(panel._show_in_subprocess("<h1>test</h1>"))
            self.assertFalse(targets[0].parent.exists())

    def test_concurrent_children_get_independent_pages_and_delayed_exit_cleanup(self):
        with tempfile.TemporaryDirectory() as d:
            jobs = []
            original_reap = panel._reap_panel
            def reap(proc, exchange):
                try:
                    original_reap(proc, exchange)
                finally:
                    proc.reaped.set()
            def spawn(args, **kwargs):
                proc = Mock()
                proc.finished = threading.Event()
                proc.reaped = threading.Event()
                proc.poll.return_value = None
                proc.wait.side_effect = lambda: proc.finished.wait(5)
                jobs.append((Path(args[-1]), proc))
                return proc
            with patch.object(panel, "DATA_DIR", Path(d)), \
                 patch.object(panel.subprocess, "Popen", side_effect=spawn), \
                 patch.object(panel, "_reap_panel", side_effect=reap), \
                 patch.object(sys, "frozen", True, create=True):
                try:
                    self.assertTrue(panel._show_in_subprocess("first 中文"))
                    self.assertTrue(panel._show_in_subprocess("second 中文"))
                    self.assertNotEqual(jobs[0][0], jobs[1][0])
                    for (path, _), text in zip(jobs, ("first 中文", "second 中文")):
                        self.assertEqual(path.read_text(encoding="utf-8"), text)
                finally:
                    for _, proc in jobs:
                        proc.finished.set()
                    for _, proc in jobs:
                        self.assertTrue(proc.reaped.wait(5))
            for path, _ in jobs:
                self.assertFalse(path.parent.exists())

    def test_missing_webview_cleans_file_before_text_fallback(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "panel.html"
            page = "<h1>中文 456</h1>"
            path.write_text(page, encoding="utf-8")
            def fallback(text):
                self.assertFalse(path.exists())
                self.assertEqual(text, page)
            with patch.dict(sys.modules, {"webview": None}), \
                 patch.object(panel, "_show_with_tkinter", side_effect=fallback) as show:
                panel.run_panel_from_file(str(path))
            show.assert_called_once()

    def test_invalid_utf8_is_deleted_and_has_visible_error(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "panel.html"
            path.write_bytes(b"\xff\xfe")
            backend = Mock()
            with patch.dict(sys.modules, {"webview": backend}), patch.object(panel, "detail_menu", return_value=[]):
                panel.run_panel_from_file(str(path))
            self.assertFalse(path.exists())
            self.assertIn("无法读取", backend.create_window.call_args.kwargs["html"])

    def test_backend_start_failure_uses_child_main_thread_fallback(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "panel.html"
            path.write_text("<h1>render error test</h1>", encoding="utf-8")
            backend = Mock()
            backend.start.side_effect = RuntimeError("renderer missing")
            with patch.dict(sys.modules, {"webview": backend}), \
                 patch.object(panel, "_show_with_tkinter") as show:
                panel.run_panel_from_file(str(path))
            show.assert_called_once_with("<h1>render error test</h1>")
            self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
