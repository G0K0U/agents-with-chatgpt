"""One window-bound action: open the native connection editor, without keys."""
import secrets

from .connection_launcher import open_connections


class PanelActions:
    def __init__(self):
        self._token = secrets.token_urlsafe(32)
        self._window = None

    def open_connections(self, token):
        if (not isinstance(token, str) or not secrets.compare_digest(token, self._token)
                or self._window is None):
            return False
        try:
            # NavigateToString documents have about:blank as their real location.
            # Check the document itself as well as the backend's cached URL.
            if self._window.get_current_url() not in (None, 'about:blank'):
                return False
            if self._window.evaluate_js('window.location.href') != 'about:blank':
                return False
            open_connections()
            return True
        except Exception:
            return False


def create_panel_window(webview, title, html_text, **options):
    actions = PanelActions()
    html_text = html_text.replace('data-quanta-action=""',
                                  f'data-quanta-action="{actions._token}"')
    options.setdefault("text_select", True)
    window = webview.create_window(title, html=html_text, js_api=actions, **options)
    actions._window = window
    return window
