"""Milestone 3: packaging and release readiness."""
import json
import re
import unittest
from pathlib import Path


class Release(unittest.TestCase):
    def test_config_example_has_only_placeholders(self):
        data = json.loads(Path("config-example.json").read_text(encoding="utf-8"))
        text = Path("config-example.json").read_text(encoding="utf-8")
        for secret in (data["server"]["token"], data["glm"]["token"], data["deepseek"]["api_key"]):
            self.assertEqual(secret, "YOUR_TOKEN_HERE")
        self.assertNotRegex(text, r"sk-[A-Za-z0-9]{8,}")
        self.assertNotRegex(text, r"[0-9a-f]{32,}")

    def test_license_mit_neutral(self):
        text = Path("LICENSE").read_text(encoding="utf-8")
        self.assertIn("MIT License", text)
        self.assertIn("ai-quota-bar contributors", text)
        self.assertNotIn("Michael", text)

    def test_readme_bilingual_sections(self):
        text = Path("README.md").read_text(encoding="utf-8")
        for link in ('docs/windows/README.md', 'docs/macos/README.md', 'docs/DEVELOPMENT.md'):
            self.assertIn(link, text)
            self.assertTrue(Path(link).is_file())
        self.assertIn('AI 用量，一眼掌握', text)
        self.assertIn('unsigned prerelease', text)
        # no concrete personal data in examples
        self.assertNotIn("Michael", text)
        concrete = [m for m in re.findall(r"100\.[0-9]+\.[0-9]+\.[0-9]+", text)
                    if m != "100.64.0.0"]
        self.assertEqual(concrete, [])

    def test_windows_packaging_ready(self):
        self.assertTrue(Path("build_windows.py").is_file())
        src = Path("build_windows.py").read_text(encoding="utf-8")
        self.assertIn("--noconsole", src)
        self.assertIn("icon.ico", src)
        self.assertTrue(Path("assets/icon.ico").is_file())
        self.assertTrue(Path("assets/icon.png").is_file())

    def test_mac_scheme_documented(self):
        self.assertTrue(Path("install_mac.command").is_file())
        self.assertTrue(Path("install_mac.py").is_file())
        readme = Path("README.md").read_text(encoding="utf-8")
        self.assertIn("docs/macos/README.md", readme)
        self.assertTrue(Path("packaging/macos/Quanta.spec").is_file())

    def test_no_new_network_endpoints(self):
        # panel/history/status layers must not open network paths
        for name in ("aibar/panel.py", "aibar/history.py", "aibar/status_text.py", "build_windows.py"):
            src = Path(name).read_text(encoding="utf-8")
            self.assertNotIn("urllib.request", src, name)
            self.assertNotIn("socket.create_connection", src, name)
        # allowlist constants stay intact
        self.assertIn("100.64.0.0/10", Path("aibar/merge.py").read_text(encoding="utf-8"))
        self.assertIn("100.64.0.0/10", Path("aibar/server.py").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
