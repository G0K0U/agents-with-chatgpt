"""Regression: flyout wiring NameErrors / missing helper (Linux-safe source asserts)."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _src(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


class FlyoutWiring(unittest.TestCase):
    def test_ui_windows_imports_time(self):
        self.assertIn("\nimport time\n", _src("aibar/ui_windows.py"))

    def test_rows_provider_uses_imported_name(self):
        src = _src("aibar/ui_windows.py")
        self.assertIn("lambda: compact_cards(app.view)", src)
        self.assertNotIn("build_flyout_rows(app.view)", src)

    def test_tray_app_has_teardown(self):
        self.assertIn("def _teardown(self):", _src("aibar/ui_windows.py"))

    def test_flyout_error_loggers_import_now_utc(self):
        src = _src("aibar/flyout.py")
        self.assertEqual(src.count("from .common import DATA_DIR, now_utc"), 2)

    def test_flyout_exports_both_builders(self):
        from aibar import flyout
        self.assertTrue(callable(flyout.build_flyout_cards))
        self.assertTrue(callable(flyout.build_flyout_rows))
        self.assertIs(flyout.build_flyout_cards, flyout.build_flyout_rows)


if __name__ == "__main__":
    unittest.main()
