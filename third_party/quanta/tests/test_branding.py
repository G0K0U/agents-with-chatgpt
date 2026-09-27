"""Check the public identity and installed assets without opening windows."""
import base64
import io
import re
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image
from aibar.brand import APP_NAME, TAGLINE, ASSETS, WINDOW_TITLE
from aibar.icon import render_icon, GREEN, RED, GRAY
from aibar.panel import build_panel_html


class QuantaBranding(unittest.TestCase):
    def test_panel_embeds_decodable_icon_and_public_identity(self):
        page = build_panel_html({}, [])
        self.assertIn(f"<title>{WINDOW_TITLE}</title>", page)
        self.assertIn(f"<h1>{APP_NAME}</h1>", page)
        self.assertIn(TAGLINE, page)
        encoded = re.search(r'data:image/png;base64,([^\"]+)', page)[1]
        with Image.open(io.BytesIO(base64.b64decode(encoded))) as logo:
            self.assertEqual(logo.size, (128, 128))
            self.assertEqual(logo.getpixel((0, 0))[3], 0)

    def test_ico_frames_are_complete_and_transparent(self):
        sizes = {16, 20, 24, 32, 40, 48, 64, 96, 128, 256}
        with Image.open(ASSETS / "icon.ico") as ico:
            self.assertEqual(ico.ico.sizes(), {(s, s) for s in sizes})
            for size in sizes:
                frame = ico.ico.getimage((size, size))
                self.assertEqual(frame.getpixel((0, 0))[3], 0)

    def test_live_status_changes_badge_but_retains_brand(self):
        outputs = [render_icon(v) for v in (80, 10, None)]
        for output, colour in zip(outputs, (GREEN, RED, GRAY)):
            self.assertEqual(output.getpixel((54, 54))[:3], colour)
        self.assertEqual(outputs[0].crop((0, 0, 40, 40)).tobytes(),
                         outputs[1].crop((0, 0, 40, 40)).tobytes())
        self.assertNotEqual(render_icon(80, 7).tobytes(), render_icon(80, 8).tobytes())

    @unittest.skipUnless(sys.platform == 'win32', 'Windows startup command')
    def test_frozen_autostart_points_to_real_executable(self):
        from aibar.autostart_windows import _command
        with patch.object(sys, "frozen", True, create=True), \
             patch.object(sys, "executable", r"C:\Apps\Quanta\Quanta.exe"):
            self.assertEqual(_command(), '"C:\\Apps\\Quanta\\Quanta.exe"')


if __name__ == "__main__":
    unittest.main()
