"""macOS menu bar. AppKit updates stay on the main thread."""
import threading
import sys
import time
import queue
import rumps
from .brand import APP_NAME, TAGLINE, ASSETS
from .common import DATA_DIR, now_utc
from .config import load_config
from .i18n import tr
from .history import append_history
from .icon import BLUE, GRAY, PURPLE, overall_remaining
from .merge import collect_merged
from .oneshot import render_rows
from .status_text import REFRESHING_TEXT, last_refresh_row
from .server import create_server

DOT = {(46, 160, 67): "🟢", (210, 153, 34): "🟡", (218, 54, 51): "🔴"}
DOT.update({GRAY: "⚪", BLUE: "🔵", PURPLE: "🟣"})
_instance_lock = None


def _already_running():
    global _instance_lock
    import fcntl
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _instance_lock = open(DATA_DIR / "mac-tray.lock", "a")
    try:
        fcntl.flock(_instance_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return False
    except BlockingIOError:
        _instance_lock.close()
        return True


class MenuBarApp(rumps.App):
    def __init__(self, cfg):
        super().__init__(APP_NAME, icon=str(ASSETS / "quanta-menubar.svg"),
                         template=True, quit_button=None)
        self.cfg, self.view = cfg, {}
        self.pending = queue.SimpleQueue()
        self._busy = threading.Lock()
        self._last_refresh = 0
        self.server_error = None
        self.refreshing = False
        self.last_completed_at = None
        self._refresh_error = None
        self._status_dot = None
        self._flyout = None
        self._open_initial_panel = bool(getattr(sys, "frozen", False)) and "--background" not in sys.argv
        from .icon_mac import prepare_status_position
        prepare_status_position()
        rumps.events.before_start.register(self._restore_status_position)
        self._render()
        self.timer = rumps.Timer(self.tick, 1)
        self.timer.start()

    def _restore_status_position(self):
        from .icon_mac import install_status_icon
        self._status_dot = install_status_icon(self._nsapp.nsstatusitem)
        self._update_status_icon()
        from .flyout_mac import MacFlyout
        self._flyout = MacFlyout.alloc().initWithApp_(self)

    def _update_status_icon(self):
        if self._status_dot is None:
            return
        remaining = None if self._refresh_error else overall_remaining(self.view)
        self._status_dot.set_remaining(remaining)
        if self.refreshing:
            message = REFRESHING_TEXT
        elif self._refresh_error:
            message = "刷新失败: " + self._refresh_error
        else:
            message = last_refresh_row(self.last_completed_at)
        button = self._nsapp.nsstatusitem.button()
        button.setToolTip_(APP_NAME + " · " + tr(message))

    def refresh(self, sender=None, *, redetect=False):
        if not self._busy.acquire(blocking=False):
            return
        self._last_refresh = time.monotonic()
        self.refreshing = True
        self._refresh_error = None
        self._render()
        def work():
            try:
                if redetect:
                    from .capabilities import rescan
                    rescan(self.cfg)
                self.pending.put((collect_merged(self.cfg), None))
            except Exception as exc:
                self.pending.put((None, type(exc).__name__))
            finally:
                self._busy.release()
        threading.Thread(target=work, daemon=True).start()

    def open_panel(self, sender=None):
        # 秒开：用缓存的视图渲染，点击路径上不重新采集
        from .history import load_history
        from .merge import load_local_snapshot
        from . import panel_mac as panel_mod
        view = self.view or load_local_snapshot() or {}
        html_text = panel_mod.build_panel_html(view, load_history(), mac_native=True)
        if self._flyout is not None:
            self._flyout.open_details(html_text)
        else:
            panel_mod.open_panel_in_background(html_text)

    def tick(self, sender):
        if self._flyout is not None:
            self._flyout.update()
        while not self.pending.empty():
            view, error = self.pending.get_nowait()
            if error:
                self._refresh_error = error
                self.refreshing = False
                self._render()
            else:
                self._refresh_error = None
                self.view = view
                self.last_completed_at = now_utc()
                self.refreshing = False
                try:
                    append_history(view)
                except Exception:
                    pass
                self._render()
                if self._open_initial_panel and self._flyout is not None:
                    self._open_initial_panel = False
                    self.open_panel()
        if time.monotonic() - self._last_refresh >= max(60, int(self.cfg.get("refresh_seconds", 300))):
            self.refresh()

    def _render(self):
        self._update_status_icon()
        self.menu.clear()
        self.menu.add(rumps.MenuItem(APP_NAME))
        self.menu.add(rumps.MenuItem(tr(TAGLINE)))
        self.menu.add(None)
        for row in render_rows(self.view):
            if row.text:
                marker = DOT[row.color] + " " if row.color is not None else ""
                self.menu.add(rumps.MenuItem(marker + tr(row.text)))
        if self.server_error:
            self.menu.add(rumps.MenuItem("本地 API 启动失败: " + self.server_error))
        if self._refresh_error:
            self.menu.add(rumps.MenuItem("刷新失败: " + self._refresh_error))
        self.menu.add(rumps.MenuItem(REFRESHING_TEXT if self.refreshing
                                    else last_refresh_row(self.last_completed_at)))
        self.menu.add(None)
        self.menu.add(rumps.MenuItem(tr("打开面板"), callback=self.open_panel))
        self.menu.add(rumps.MenuItem(tr("立即刷新"), callback=self.refresh))
        self.menu.add(rumps.MenuItem(tr("退出"), callback=lambda _: rumps.quit_application()))


def main():
    if _already_running():
        return
    from .lifecycle_mac import install_delegate
    install_delegate()
    cfg = load_config()
    app = MenuBarApp(cfg)
    server = None
    try:
        server = create_server(cfg)
        threading.Thread(target=server.serve_forever, daemon=True).start()
    except (OSError, ValueError) as exc:
        app.server_error = type(exc).__name__
    app.refresh()
    try:
        app.run()
    finally:
        if server:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
