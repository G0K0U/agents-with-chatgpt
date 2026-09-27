import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from tools import portable_release, release


class EvidenceGates(unittest.TestCase):
    def test_extra_or_wrong_version_build_dependencies_are_rejected(self):
        import build_windows
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "requirements-windows-build.txt").write_text("sample_package==1.0\n")
            installed = [SimpleNamespace(metadata={"Name": "sample-package"}, version="1.0")]
            with patch.object(build_windows, "ROOT", root), \
                 patch.object(build_windows.importlib.metadata, "distributions", return_value=installed):
                build_windows.verify_build_environment()
                installed.append(SimpleNamespace(metadata={"Name": "unrelated"}, version="1.0"))
                with self.assertRaisesRegex(RuntimeError, "clean virtual environment"):
                    build_windows.verify_build_environment()
                installed.pop()
                installed[0].version = "2.0"
                with self.assertRaisesRegex(RuntimeError, "clean virtual environment"):
                    build_windows.verify_build_environment()

    def test_license_source_inventory_is_complete(self):
        release.verify_license_inventory()

    def test_deleted_or_modified_license_source_blocks_build(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "docs/licenses/library.py"
            source.parent.mkdir(parents=True)
            (root / "docs/DEPENDENCIES.json").write_text(json.dumps({
                "license_file_hashes": {"docs/licenses/library.py": hashlib.sha256(b"original").hexdigest()}}))
            with patch.object(release, "ROOT", root):
                with self.assertRaisesRegex(RuntimeError, "inventory"):
                    release.build_inputs()
                source.write_bytes(b"changed")
                with self.assertRaisesRegex(RuntimeError, "inventory"):
                    release.build_inputs()
                source.write_bytes(b"original")
                release.verify_license_inventory()

    def test_failed_source_tests_cannot_ship(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "test-results.json").write_text(json.dumps({"ok": False}))
            with patch.object(release, "verify_release"), \
                 patch.object(release, "source_files", return_value=[]), \
                 patch.object(release, "revision", return_value="fixture"):
                with self.assertRaisesRegex(RuntimeError, "test evidence"):
                    portable_release.check_gates(root, root)

    def test_stale_binary_smoke_cannot_ship(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "test-results.json").write_text(json.dumps({"ok": True, "tests_run": 121,
                "failures": 0, "errors": 0, "source_revision": "fixture", "source_hashes": {}}))
            names = ["normal EXE startup", "API authentication", "second instance exits",
                     "flyout actual rendering and lifecycle", "panel actual rendering and lifecycle",
                     "fresh watchdog health", "configuration preserved", "no main or Tk callback errors"]
            (root / "smoke-results.json").write_text(json.dumps([{"name": n, "ok": True} for n in names]))
            (root / "smoke-exe.sha256").write_text("old-binary")
            (root / "Quanta.exe").write_bytes(b"new-binary")
            with patch.object(release, "verify_release"), \
                 patch.object(release, "source_files", return_value=[]), \
                 patch.object(release, "revision", return_value="fixture"):
                with self.assertRaisesRegex(RuntimeError, "different binary"):
                    portable_release.check_gates(root, root)


@unittest.skipUnless(sys.platform == "win32", "Windows package verifier")
class PackageVerifier(unittest.TestCase):
    def test_valid_tampered_extra_and_traversal_packages(self):
        work = Path(__file__).resolve().parent.parent / "work"
        work.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="verify space & ", dir=work) as directory:
            root = Path(directory)
            shutil.copyfile(Path(__file__).resolve().parent.parent / "tools/Verify.cmd", root / "Verify.cmd")
            (root / "Quanta.exe").write_bytes(b"synthetic executable")
            good = "".join(hashlib.sha256((root / name).read_bytes()).hexdigest() + "  " + name + "\n"
                           for name in ("Quanta.exe", "Verify.cmd"))

            def verify():
                result = subprocess.run(["cmd.exe", "/d", "/c", "Verify.cmd", "--no-pause"], cwd=root,
                    capture_output=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW)
                return result.returncode

            (root / "SHA256SUMS").write_text(good)
            self.assertEqual(verify(), 0)
            (root / "Quanta.exe").write_bytes(b"modified")
            self.assertNotEqual(verify(), 0)
            (root / "Quanta.exe").write_bytes(b"synthetic executable")
            (root / "unexpected.dll").write_bytes(b"unlisted")
            self.assertNotEqual(verify(), 0)
            (root / "unexpected.dll").unlink()
            (root / "SHA256SUMS").write_text(good + "0" * 64 + "  ../outside\n")
            self.assertNotEqual(verify(), 0)
