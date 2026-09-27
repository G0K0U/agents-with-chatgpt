import sys
import unittest
from types import SimpleNamespace as NS
from unittest.mock import patch
from aibar import i18n, panel, panel_mac


class PresentationSecurity(unittest.TestCase):
    def test_translation_cannot_close_script(self):
        with patch.object(i18n, 'language', return_value='en'), patch.object(i18n, 'translations', return_value={'label': '</script><script>alert(1)</script>'}):
            page = i18n.localize_html('<html><body>label</body></html>')
        self.assertEqual(page.count('</script>'), 1)
        self.assertNotIn('<script>alert', page)

    def test_mac_connection_entry_is_opt_in(self):
        view = {'visible': {'glm': False, 'deepseek': False}}
        windows = panel.build_panel_html(view, [])
        mac = panel_mac.build_panel_html(view, [], mac_native=True)
        self.assertNotIn('<!--connections-action-->', windows)
        self.assertIn('add-connection', windows)
        self.assertIn('<!--connections-action-->', mac)
        self.assertNotIn('填入 token 后自动出现', mac)


@unittest.skipUnless(sys.platform == 'darwin', 'Native WebKit bridge')
class BridgeSecurity(unittest.TestCase):
    def test_rejects_remote_frames_and_unprotected_documents(self):
        from aibar.flyout_mac import trusted_message
        view = NS(URL=lambda: NS(absoluteString=lambda: 'about:blank'))
        message = NS(webView=lambda: view, frameInfo=lambda: NS(isMainFrame=lambda: True))
        self.assertTrue(trusted_message(message, (view,), True))
        self.assertFalse(trusted_message(message, (view,), False))
        self.assertFalse(trusted_message(message, (), True))
        for address in ('https://example.invalid', 'file:///tmp/page.html', 'data:text/html,test', 'about:blank#foreign'):
            view.URL = lambda: NS(absoluteString=lambda: address)
            self.assertFalse(trusted_message(message, (view,), True))
        view.URL = lambda: NS(absoluteString=lambda: 'about:blank')
        message.frameInfo = lambda: NS(isMainFrame=lambda: False)
        self.assertFalse(trusted_message(message, (view,), True))
