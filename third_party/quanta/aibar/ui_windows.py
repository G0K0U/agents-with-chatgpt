"""Windows tray: separate menu rows, background refresh and a named mutex."""
import sys
import threading
import time
from datetime import datetime, timezone
import pystray
from pystray import Menu, MenuItem
from .brand import APP_NAME, TAGLINE
from .i18n import tr
from .presentation import compact_cards, legend_rows, trusted_view
from .common import DATA_DIR, now_utc, write_json
from .config import load_config
from .history import append_history
from .icon import (render_icon, overall_remaining, per_source_remaining,
                   GREEN, AMBER, RED, GRAY, BLUE, PURPLE)
from .merge import collect_merged
from .oneshot import render_rows
from .status_text import REFRESHING_TEXT, windows_tooltip, last_refresh_row
from .windows_menu import ColorIcon, ColorMenuItem
from .server import create_server

_mutex_handle = None


def _already_running():
    global _mutex_handle
    if sys.platform != "win32":
        return False
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateMutexW.restype = wintypes.HANDLE
    import hashlib
    import os
    name = "Local\\aibar_tray_singleton"
    if os.environ.get("AIBAR_DATA_DIR"):
        name += "_" + hashlib.sha256(str(DATA_DIR).casefold().encode()).hexdigest()[:16]
    _mutex_handle = kernel.CreateMutexW(None, False, name)
    if not _mutex_handle:
        raise ctypes.WinError(ctypes.get_last_error())
    return ctypes.get_last_error() == 183


class TrayApp:
    def __init__(self, cfg, httpd=None):
        self.cfg, self.view = cfg, {}
        self.httpd = httpd
        self._stop = threading.Event()
        self._updating = threading.Lock()
        self.server = None
        self.server_error = None
        self.refreshing = False
        self.refresh_started = None
        self._refresh_error = None
        self.last_completed_at = None
        self._loop_thread = None
        self._serve_thread = None
        self.watchdog_report = {}
        self.flyout = None  # 托盘点击接管对象；看门狗在它死亡时回退原生菜单
        self._flyout_thread = None
        self.icon = ColorIcon(APP_NAME, icon=render_icon(None),
                              title=f"{APP_NAME} · 正在加载", menu=self._menu())

    def _menu(self):
        rows = [ColorMenuItem(tr(row.text), row.color) for row in render_rows(trusted_view(self.view)) if row.text]
        if self.server_error:
            rows.append(MenuItem("本地 API 启动失败: " + self.server_error, None, enabled=False))
        rows.append(MenuItem(tr(last_refresh_row(self.last_completed_at)), None, enabled=False))
        legend_defs = (
            (GREEN, "绿 >50%：配额充足"),
            (AMBER, "黄 >20–50%：注意用量"),
            (RED, "红 ≤20%：即将耗尽"),
            (GRAY, "灰：旧 / 未知 / 读取失败"),
            (BLUE, "蓝：余额（DeepSeek）"),
            (PURPLE, "紫：token 消耗（Muse）"),
        )
        legend = Menu(*[ColorMenuItem(text, tuple(bytes.fromhex(color[1:]))) for color, text in legend_rows(self.view)])
        from . import autostart_windows
        autostart_label = "开机自启 ✓" if autostart_windows.is_enabled() else "开机自启 ✗"
        actions = [
            MenuItem(tr("打开面板"), self._open_panel),
            MenuItem(tr("添加连接"), self._open_connections),
            # default=True: 双击托盘图标触发立即刷新
            MenuItem(tr("立即刷新"), self._refresh_now, default=True),
        ]
        if self.flyout is not None:
            actions.insert(1, MenuItem(tr("浮窗面板（卡片式）"), self._open_flyout))
        actions.extend([
            MenuItem(tr("重新检测数据源"), self._redetect),
            MenuItem(tr(autostart_label), self._toggle_autostart),
            MenuItem(tr("颜色说明"), legend),
            MenuItem(tr("退出"), self._quit)])
        return Menu(MenuItem(APP_NAME, None, enabled=False),
                    MenuItem(tr(TAGLINE), None, enabled=False), Menu.SEPARATOR,
                    *rows, Menu.SEPARATOR,
                    *actions)

    def _open_flyout(self, icon=None, item=None):
        if self.flyout is not None:
            self.flyout.toggle()

    def _refresh_now(self, icon=None, item=None):
        threading.Thread(target=self.update_once, daemon=True).start()

    def _redetect(self, icon=None, item=None):
        """重新检测数据源：全量重探（含 WSL）后立即刷新。"""
        from . import capabilities

        def work():
            try:
                capabilities.rescan(self.cfg)
            except Exception:
                pass
            self.update_once()

        threading.Thread(target=work, daemon=True).start()

    def _toggle_autostart(self, icon=None, item=None):
        from . import autostart_windows
        try:
            if autostart_windows.is_enabled():
                autostart_windows.disable()
            else:
                autostart_windows.enable()
        except OSError:
            pass
        self.icon.menu = self._menu()
        self.icon.update_menu()

    def _open_connections(self, icon=None, item=None):
        from .connection_launcher import open_connections
        process = open_connections()
        def completed():
            process.wait()
            if not self._stop.is_set():
                self._redetect()
        threading.Thread(target=completed, daemon=True).start()

    def _open_panel(self, icon=None, item=None):
        # 秒开：用托盘缓存的视图渲染，点击路径上不重新采集
        from .history import load_history
        from .merge import load_local_snapshot
        from . import panel as panel_mod
        view = self.view or load_local_snapshot() or {}
        html_text = panel_mod.build_panel_html(view, load_history())
        panel_mod.open_panel_in_background(html_text)

    def _quit(self, icon=None, item=None):
        self._stop.set()
        self.icon.stop()

    def update_once(self):
        if not self._updating.acquire(blocking=False):
            return
        self.refreshing = True
        self.refresh_started = time.monotonic()
        self._refresh_error = None
        try:
            self.icon.title = f"{APP_NAME} · {tr(REFRESHING_TEXT)}"
        except Exception:
            pass
        try:
            self.cfg = load_config()
            self.view = collect_merged(self.cfg)
            try:
                append_history(self.view)
            except Exception:
                pass
            muse = self.view.get("muse") or {}
            count = (muse.get("five_hour") or {}).get("requests") if muse.get("available") else None
            self.icon.icon = render_icon(overall_remaining(self.view), muse_count=count)
            self.last_completed_at = now_utc()
            self.icon.title = windows_tooltip(self.view, self.last_completed_at)
            self.icon.menu = self._menu()
            self.icon.update_menu()
            write_json(DATA_DIR / "runtime-status.json", {"updated_at": now_utc().isoformat(),
                       "refresh_ok": True, "api_ok": self.httpd is not None, "api_error": self.server_error})
        except Exception as exc:
            self._refresh_error = type(exc).__name__
            self.view = dict(self.view, _refresh_error=self._refresh_error)
            self.icon.icon = render_icon(None)
            self.icon.menu = self._menu()
            self.icon.update_menu()
            self.last_completed_at = self.last_completed_at or now_utc()
            self.icon.title = (f"{APP_NAME} " + tr("刷新失败：") + type(exc).__name__)[:127]
            write_json(DATA_DIR / "runtime-status.json", {"updated_at": now_utc().isoformat(),
                       "refresh_ok": False, "error": type(exc).__name__})
        finally:
            self.refreshing = False
            self._updating.release()

    def _loop(self):
        self.update_once()
        last = time.monotonic()
        marker = DATA_DIR / 'connections-changed.json'
        observed = marker.stat().st_mtime_ns if marker.exists() else 0
        while not self._stop.wait(2):
            try:
                changed = marker.stat().st_mtime_ns if marker.exists() else 0
            except OSError:
                changed = observed
            if changed != observed or time.monotonic() - last >= max(60, int(self.cfg.get('refresh_seconds', 300))):
                observed = changed
                self.update_once()
                last = time.monotonic()

    # ---- 10 分钟看门狗：自检服务器/采集线程/图标活性并自愈 ----

    def _watchdog_loop(self):
        interval = max(60, int(self.cfg.get("watchdog_seconds", 600)))
        while not self._stop.wait(interval):
            try:
                self._watchdog_once()
            except Exception:
                pass  # 看门狗自身绝不能拖垮托盘

    def _watchdog_once(self) -> dict:
        import socket as _socket
        from .common import read_json
        report = {"checked_at": now_utc().isoformat(), "healed": []}
        refreshed = False

        # 0) 浮窗线程活性：接管模式下死了 → 清 menu_toggle 回退原生菜单
        flyout_dead = (self.flyout is not None
                       and getattr(self, "_flyout_thread", None) is not None
                       and not self._flyout_thread.is_alive())
        if flyout_dead:
            self.icon.menu_toggle = None
            self.flyout = None
            report["healed"].append("flyout-fallback-native-menu")

        # 1) 采集线程活性：死了就重建；距上次完成超过 3 个周期也算僵死
        loop_alive = bool(self._loop_thread and self._loop_thread.is_alive())
        stale_limit = max(180, 3 * max(60, int(self.cfg.get("refresh_seconds", 300))))
        stale = (self.last_completed_at is None or
                 (now_utc() - self.last_completed_at).total_seconds() > stale_limit)
        if not loop_alive:
            self._loop_thread = threading.Thread(target=self._loop, daemon=True)
            self._loop_thread.start()
            refreshed = True
            report["healed"].append("collector-thread")
        report["collector_stale"] = stale

        # 2) 服务器活性：线程活着且端口真实可连；任一不满足 → 重建
        server_ok = bool(self._serve_thread and self._serve_thread.is_alive())
        if server_ok and self.httpd is not None:
            try:
                import socket as _s
                with _socket.create_connection(self.httpd.server_address, timeout=2):
                    pass
            except OSError:
                server_ok = False
        if not server_ok:
            try:
                if self.httpd:
                    if self._serve_thread and self._serve_thread.is_alive():
                        self.httpd.shutdown()
                    self.httpd.server_close()
                self.httpd = create_server(self.cfg)
                self._serve_thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
                self._serve_thread.start()
                self.server_error = None
                server_ok = True
                report["healed"].append("api-server")
            except (OSError, ValueError):
                self.server_error = "watchdog-restart-failed"
        report["server_ok"] = server_ok

        # 3) 图标活性（能走到这里即视为响应正常）
        report["icon_ok"] = self.icon is not None

        # 4) capability 快速复检：WSL/子 agent 启停后菜单自动跟上
        try:
            from . import capabilities
            capabilities.detect(self.cfg)
            report["caps_refreshed"] = True
        except Exception:
            report["caps_refreshed"] = False

        report["refreshed_after_heal"] = refreshed
        if refreshed:
            self.update_once()
        write_json(DATA_DIR / "watchdog.json", report)
        self._append_watchdog_log(report)
        self.watchdog_report = report
        return report

    def _append_watchdog_log(self, report: dict) -> None:
        log = DATA_DIR / "watchdog.log"
        try:
            if log.exists() and log.stat().st_size > 1_000_000:
                log.write_text("", encoding="utf-8")
            healed = ",".join(report.get("healed") or []) or "-"
            with open(log, "a", encoding="utf-8") as f:
                f.write(f"{report['checked_at']} healed={healed} "
                        f"server_ok={report.get('server_ok')} caps={report.get('caps_refreshed')}\n")
        except OSError:
            pass

    def start_services(self):
        """启动 API 服务器、采集循环与看门狗线程（不阻塞、不含图标）。"""
        if self.httpd is not None:
            self._serve_thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
            self._serve_thread.start()
        else:
            try:
                self.httpd = create_server(self.cfg)
                self._serve_thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
                self._serve_thread.start()
            except (OSError, ValueError) as exc:
                self.server_error = type(exc).__name__
        self._loop_thread = threading.Thread(target=self._loop, daemon=True)
        self._loop_thread.start()
        self._watchdog_thread = threading.Thread(target=self._watchdog_loop, daemon=True)
        self._watchdog_thread.start()

    def _icon_lifecycle(self):
        try:
            self.icon.run()
        finally:
            self._teardown()

    def _teardown(self):
        """Release tray resources (icon bitmaps, API server, stop flag).

        Shared by the native-menu path (via ``_icon_lifecycle``) and the
        flyout path (``main`` calls it after ``flyout.run()`` returns).
        """
        self._stop.set()
        if self.flyout is not None:
            self.flyout.request_quit()
        if self._flyout_thread and self._flyout_thread is not threading.current_thread():
            self._flyout_thread.join(timeout=3)
        try:
            self.icon.close_status_bitmaps()
        except Exception:
            pass
        if self.httpd:
            try:
                if self._serve_thread and self._serve_thread.is_alive():
                    self.httpd.shutdown()
            except Exception:
                pass
            try:
                self.httpd.server_close()
            except Exception:
                pass

    def run(self):
        self.start_services()
        self._icon_lifecycle()


def main():
    try:
        if "--connections" in sys.argv:
            from .connections_ui_windows import show_connections
            show_connections()
            return
        if "--panel-stdin" in sys.argv:
            from .panel import run_panel_from_file
            run_panel_from_file(sys.argv[sys.argv.index("--panel-stdin") + 1])
            return
        if "--flyout-test" in sys.argv:
            from tools.gui_smoke import flyout_test
            sys.exit(flyout_test())
        if "--panel-test" in sys.argv:
            from tools.gui_smoke import panel_test
            sys.exit(panel_test())
        if _already_running():
            return
        cfg = load_config()
        try:
            # 决定性单实例判据：端口绑定失败 = 已有实例（互斥只在部分打包形态下可靠）
            httpd = create_server(cfg)
        except OSError as exc:
            from .common import DATA_DIR
            (DATA_DIR / "main-bind-skip.log").write_text(
                f"{datetime.now(timezone.utc).isoformat()} bind: {exc}", encoding="utf-8")
            return
        app = TrayApp(cfg, httpd)
        flyout = None
        if "--no-flyout" not in sys.argv:
            try:
                from .flyout import QuantaFlyout, build_flyout_cards

                def _quit_all():
                    app._quit()
                    flyout.request_quit()

                candidate = QuantaFlyout({
                    "refresh": app._refresh_now,
                    "panel": app._open_panel,
                    "connections": app._open_connections,
                    "status": lambda: {"refreshing": app.refreshing, "started": app.refresh_started, "error": app._refresh_error, "updated": tr(last_refresh_row(app.last_completed_at))},
                    "legend": lambda: legend_rows(app.view),
                    "redetect": app._redetect,
                    "autostart": app._toggle_autostart,
                    "autostart_enabled": _autostart_enabled,
                    "quit": _quit_all,
                }, lambda: compact_cards(app.view))
                # 预先构建 Tk root：冻结环境的问题在这里暴露并留痕
                if candidate.prepare():
                    flyout = candidate
                    app.flyout = flyout
                    app.icon.menu_toggle = flyout.toggle  # 托盘点击传图标锚点
            except ImportError:
                flyout = None
        app.start_services()
        if flyout is not None:
            # 浮窗线程化：root 创建 + mainloop 全在浮窗自己的线程内
            app._flyout_thread = threading.Thread(
                target=_run_flyout_guarded, args=(app, flyout), daemon=True)
            app._flyout_thread.start()
            # 接管托盘点击：单击/右键直接弹浮窗（原生菜单成为隐藏兜底——
            # 浮窗线程若死亡，看门狗会清掉 menu_toggle 自动回退原生菜单）
            app.icon.menu_toggle = flyout.toggle
        if flyout is not None and "--show-flyout" in sys.argv:
            flyout.toggle()
        app._icon_lifecycle()
    except Exception:
        # frozen exe 无控制台：崩溃必须有迹可循
        import traceback
        from .common import DATA_DIR
        (DATA_DIR / "main-error.log").write_text(traceback.format_exc(), encoding="utf-8")
        raise


def _autostart_enabled() -> bool:
    from . import autostart_windows
    return autostart_windows.is_enabled()


def _run_flyout_guarded(app, flyout) -> None:
    """浮窗线程守护：异常退出时立刻回退原生菜单并留痕（托盘永不死）。"""
    try:
        flyout.run()
    except Exception:
        import traceback
        from .common import DATA_DIR, now_utc
        try:
            (DATA_DIR / "flyout-error.log").write_text(
                f"{now_utc().isoformat()} flyout thread died:\n"
                f"{traceback.format_exc()}", encoding="utf-8")
        except OSError:
            pass
    finally:
        app.icon.menu_toggle = None
        app.flyout = None


if __name__ == "__main__":
    main()
