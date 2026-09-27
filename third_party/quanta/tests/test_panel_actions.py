import unittest
from unittest.mock import Mock, patch
from aibar.panel_actions import PanelActions
from aibar.panel import build_panel_html


class PanelActionTests(unittest.TestCase):
    def test_frozen_child_gets_independent_runtime_without_changing_parent(self):
        import os
        from aibar import connection_launcher
        with patch.object(connection_launcher.sys, 'frozen', True, create=True), patch.dict(os.environ, {'TEST_MARKER': 'kept'}, clear=True):
            child = connection_launcher.child_environment()
            self.assertEqual(child, {'TEST_MARKER': 'kept', 'PYINSTALLER_RESET_ENVIRONMENT': '1'})
            self.assertNotIn('PYINSTALLER_RESET_ENVIRONMENT', os.environ)

    def test_wrong_token_or_unbound_window_cannot_launch(self):
        api = PanelActions()
        with patch('aibar.panel_actions.open_connections') as launch:
            self.assertFalse(api.open_connections(api._token))
            api._window = Mock()
            self.assertFalse(api.open_connections('wrong'))
            self.assertFalse(api.open_connections({}))
            launch.assert_not_called()

    def test_navigated_document_cannot_launch_even_with_token(self):
        api = PanelActions()
        api._window = Mock()
        with patch('aibar.panel_actions.open_connections') as launch:
            for backend, document in [('https://example.test', 'about:blank'),
                                      (None, 'https://example.test')]:
                api._window.get_current_url.return_value = backend
                api._window.evaluate_js.return_value = document
                self.assertFalse(api.open_connections(api._token))
            launch.assert_not_called()

    def test_bound_local_document_opens_only_native_editor(self):
        api = PanelActions()
        api._window = Mock()
        api._window.get_current_url.return_value = None
        api._window.evaluate_js.return_value = 'about:blank'
        with patch('aibar.panel_actions.open_connections') as launch:
            self.assertTrue(api.open_connections(api._token))
            launch.assert_called_once_with()

    def test_all_supported_sources_and_visible_action_are_present(self):
        html = build_panel_html({'visible': {'codex': True}}, [])
        for name in ('Codex', 'GLM', 'DeepSeek', 'Muse', 'Antigravity'):
            self.assertIn(name, html)
        self.assertIn('id="add-connection"', html)
        self.assertNotIn('~/.aibar/config.json', html)
        self.assertIn("connect-src 'none'", html)
