"""Launch the native editor; credentials stay inside its native controls."""
import os
import subprocess
import sys
import threading

_lock = threading.Lock()
_process = None


def child_environment():
    # Separate windows may outlive the tray. Give frozen children their own
    # extraction directory so closing the parent cannot remove their files.
    return dict(os.environ, PYINSTALLER_RESET_ENVIRONMENT='1') if getattr(sys, 'frozen', False) else None


def open_connections():
    global _process
    with _lock:
        if _process is not None and _process.poll() is None:
            return _process
        if getattr(sys, 'frozen', False):
            args = [sys.executable, '--connections']
        else:
            from pathlib import Path
            pythonw = Path(sys.executable).with_name('pythonw.exe')
            args = [str(pythonw if pythonw.exists() else sys.executable), '-m', 'aibar.connections_ui_windows']
        _process = subprocess.Popen(args, env=child_environment())
        return _process


def detail_menu():
    if sys.platform != 'win32':
        return []
    from webview.menu import Menu, MenuAction
    from .i18n import tr
    return [Menu('Quanta', [MenuAction(tr('添加连接'), open_connections)])]
