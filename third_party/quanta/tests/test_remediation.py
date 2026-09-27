"""Runtime regressions and release provenance checks for v8 remediation."""
import importlib.util
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from tools import audit_scan, release


class RuntimeRegressions(unittest.TestCase):
    def test_mac_menu_renders_purple_muse_without_appkit(self):
        backend = SimpleNamespace(App=object, MenuItem=lambda label, **kwargs: label)
        spec = importlib.util.spec_from_file_location("aibar._mac_test", "aibar/ui_mac.py")
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"rumps": backend}):
            spec.loader.exec_module(module)
        from aibar.oneshot import render_rows
        view = {"muse": {"available": True, "five_hour": {"requests": 3, "tokens": 1234},
                          "today_tokens": 1234, "week_7d_tokens": 1234}}
        menu = Mock()
        app = SimpleNamespace(view=view, menu=menu, server_error=None,
                              last_completed_at=None, open_panel=Mock(), refresh=Mock(),
                              _update_status_icon=Mock(), _refresh_error=None, refreshing=False)
        module.MenuBarApp._render(app)
        labels = [c.args[0] for c in menu.add.call_args_list if c.args[0]]
        self.assertTrue(any(label.startswith("🟣 ") and "1234" in label.replace(",", "") for label in labels))

    @unittest.skipUnless(sys.platform == "win32", "Windows runtime status")
    def test_windows_refresh_reports_active_api(self):
        from aibar import ui_windows
        app = SimpleNamespace(_updating=threading.Lock(), cfg={}, view={},
                              icon=Mock(), httpd=object(), server=None, server_error=None,
                              last_completed_at=None, _menu=Mock(return_value=Mock()))
        with patch.object(ui_windows, "collect_merged", return_value={}), \
             patch.object(ui_windows, "append_history"), \
             patch.object(ui_windows, "write_json") as write:
            ui_windows.TrayApp.update_once(app)
        self.assertTrue(write.call_args.args[1]["api_ok"])
        self.assertTrue(write.call_args.args[1]["refresh_ok"])


class AuditRegressions(unittest.TestCase):
    def test_dictionary_does_not_write_secrets(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            config = root / "config.json"
            config.write_text(json.dumps({"server": {"token": "synthetic-test-secret"},
                                          "glm": {"token": "YOUR_TOKEN_HERE"}}), encoding="utf-8")
            before = set(root.rglob("*"))
            with patch.object(audit_scan, "ROOT", root), \
                 patch.object(Path, "write_text", side_effect=AssertionError("unexpected write")):
                values = audit_scan.build_dictionary(config)
            self.assertIn("synthetic-test-secret", values)
            self.assertNotIn("YOUR_TOKEN_HERE", values)
            self.assertEqual(before, set(root.rglob("*")))

    def test_missing_dictionary_is_unavailable_not_clean(self):
        with patch.object(audit_scan, "build_dictionary", return_value=set()), \
             patch("builtins.print"):
            self.assertEqual(audit_scan.scan(), 2)


class ReleaseRegressions(unittest.TestCase):
    def test_release_roundtrip_and_stale_zip_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "repo"
            out = Path(d) / "dist"
            root.mkdir()
            out.mkdir()
            names = ["README.md", "LICENSE", "config-example.json", "aibar/server.py",
                     "docs/FIRST-USE.txt", "docs/SECURITY-AUDIT.md", "install_mac.command"]
            for name in names:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(name + "\n", encoding="utf-8")
            exe = out / "Quanta.exe"
            exe.write_bytes(b"synthetic executable")
            inputs = {"aibar/server.py": release.sha((root / "aibar/server.py").read_bytes())}
            (out / "Quanta.exe.build.json").write_text(json.dumps({
                "inputs": inputs, "exe_sha256": release.sha(exe.read_bytes())}), encoding="utf-8")
            with patch.object(release, "ROOT", root), patch.object(release, "revision", return_value="test-revision"), \
                 patch.object(release, "source_files", return_value=names), \
                 patch.object(release, "build_inputs", return_value=inputs), \
                 patch.object(release.subprocess, "check_output", return_value=b""), patch("builtins.print"):
                release.create_release(out)
                release.verify_release(out)
                with release.zipfile.ZipFile(out / "Quanta-source.zip") as z:
                    self.assertTrue(z.getinfo("install_mac.command").external_attr >> 16 & 0o111)
                (out / "Quanta-source.zip").write_bytes(b"old archive")
                with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                    release.verify_release(out)

    def test_stale_exe_is_rejected_before_packaging(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            (out / "Quanta.exe").write_bytes(b"exe")
            (out / "Quanta.exe.build.json").write_text(json.dumps({
                "inputs": {"server.py": "old"}, "exe_sha256": release.sha(b"exe")}), encoding="utf-8")
            with patch.object(release, "build_inputs", return_value={"server.py": "new"}):
                with self.assertRaisesRegex(RuntimeError, "stale"):
                    release.verify_exe(out)


if __name__ == "__main__":
    unittest.main()
