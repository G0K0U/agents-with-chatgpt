"""Quanta 托盘弹出浮窗（替代 Windows 原生菜单）。

设计语言与面板一致：深色、圆角卡片、来源单行摘要（彩色圆点）、动作按钮组。
pywinstyles 提供 Win11 Acrylic 质感（不可用时静默降级为纯色深底）。

线程模型（社区标准模式）：
- Tk root 与 mainloop 在**主线程**；pystray 图标在后台线程。
- 托盘线程通过 ``toggle()`` 投递请求到队列；Tk 轮询队列后执行，
  避免跨线程直接操作 Tk 控件。
- 未安装 customtkinter 时降级为纯 tkinter 深色样式；连 tkinter 都没有
  则由调用方回退到系统原生菜单。
"""
from __future__ import annotations

import queue
import sys
import threading
import time

from .brand import APP_NAME, TAGLINE
from .i18n import tr

_BG = "#0d1117"
_CARD = "#161b22"
_HOVER = "#1f2733"
_FG = "#e6edf3"
_MUTED = "#8b949e"

_ACTIONS = (
    ("刷新", "refresh"),
    ("面板", "panel"),
    ("连接", "connections"),
    ("检测", "redetect"),
    ("自启", "autostart"),
    ("图例", "legend"),
    ("退出", "quit"),
)

_LEGEND_ROWS = (
    ("#3fb950", "绿 >50%：配额充足"),
    ("#d29922", "黄 20–50%：注意用量"),
    ("#f85149", "红 ≤20%：即将耗尽"),
    ("#8b949e", "灰：旧 / 未知 / 读取失败"),
    ("#2f81f7", "蓝：余额（DeepSeek）"),
    ("#a371f7", "紫：token 消耗（Muse）"),
)


def place_near_anchor(anchor, width, height, bounds):
    """Physical screen coordinates, including monitors left of the primary."""
    left, top, right, bottom = bounds
    ax, ay = anchor or (right - width // 2 - 14, bottom)
    x = max(left + 8, min(ax - width // 2, right - width - 8))
    y = ay - height - 12
    if y < top + 8:
        y = ay + 32
    return x, max(top + 8, min(y, bottom - height - 8))


def monitor_work_area(root, anchor):
    fallback = (0, 0, root.winfo_screenwidth(), root.winfo_screenheight())
    if sys.platform != "win32":
        return fallback
    try:
        import ctypes
        from ctypes import wintypes

        class MonitorInfo(ctypes.Structure):
            _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT),
                        ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]

        user = ctypes.windll.user32
        user.MonitorFromPoint.argtypes = [wintypes.POINT, wintypes.DWORD]
        user.MonitorFromPoint.restype = wintypes.HANDLE
        user.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MonitorInfo)]
        point = wintypes.POINT(*(anchor or (fallback[2] - 1, fallback[3] - 1)))
        monitor = user.MonitorFromPoint(point, 2)
        info = MonitorInfo()
        info.cbSize = ctypes.sizeof(info)
        if user.GetMonitorInfoW(monitor, ctypes.byref(info)):
            r = info.rcWork
            return r.left, r.top, r.right, r.bottom
    except (OSError, AttributeError):
        pass
    return fallback


def _log_tk_exception(exc, val, tb):
    """Tk 回调异常留痕（frozen exe 无控制台；日志 1MB 截断防膨胀）。"""
    import traceback
    from .common import DATA_DIR, now_utc
    log = DATA_DIR / "flyout-tk.log"
    try:
        if log.exists() and log.stat().st_size > 1_000_000:
            log.write_text("", encoding="utf-8")
        with open(log, "a", encoding="utf-8") as f:
            f.write(f"{now_utc().isoformat()} "
                    f"{''.join(traceback.format_exception(exc, val, tb))[-2000:]}\n")
    except OSError:
        pass


def build_flyout_rows(view: dict):
    """兼容入口：直接返回结构化卡片（oneshot.build_flyout_cards）。"""
    from .oneshot import build_flyout_cards
    return build_flyout_cards(view)


# ui_windows 的浮窗接线使用此名称——与 build_flyout_rows 同一实现
build_flyout_cards = build_flyout_rows


class QuantaFlyout:
    """无边框置顶浮窗。``toggle`` 线程安全；关闭仅为隐藏（进程常驻）。"""

    WIDTH = 360

    def __init__(self, callbacks: dict, rows_provider):
        self._callbacks = callbacks          # {"refresh": fn, "panel": fn, "redetect": fn,
                                             #  "autostart": fn, "quit": fn,
                                             #  "autostart_enabled": () -> bool}
        self._rows_provider = rows_provider  # () -> [(dot, name, summary)]
        self._queue: "queue.Queue[str]" = queue.Queue()
        self._root = None
        self._last_signature = None
        self.visible = False

    def _resize_to_content(self):
        root = self._root
        root.update_idletasks()
        bounds = monitor_work_area(root, getattr(self, '_anchor', None))
        scale = root._get_window_scaling()
        max_h = bounds[3] - bounds[1] - 24
        req = max((c.winfo_reqheight() for c in root.winfo_children()), default=0) + 8
        if req > max_h:
            self._render_rows(force=True, scroll_h=max(60, int(max_h / scale) - 205))
            root.update_idletasks()
            req = max((c.winfo_reqheight() for c in root.winfo_children()), default=0) + 8
        h = max(1, int(min(max_h, max(300 * scale, req)) / scale))
        x, y = place_near_anchor(getattr(self, '_anchor', None), round(self.WIDTH * scale), round(h * scale), bounds)
        root.geometry(f'{self.WIDTH}x{h}+{x}+{y}')

    # ---- 托盘线程调用 ----
    def toggle(self, anchor=None) -> None:
        """anchor: (x, y) 托盘图标物理坐标（点击瞬间采集），用于贴图标定位。"""
        from .windows_menu import _trace_click
        if anchor is not None:
            self._anchor = anchor  # 简单赋值，GIL 下原子；仅 Tk 线程读取
        _trace_click(f"flyout.toggle: queue.put(toggle) anchor={anchor}")
        self._queue.put("toggle")

    def notify_rows_changed(self) -> None:
        self._queue.put("rows")

    def prepare(self) -> bool:
        """探测：本进程能否构建 Tk root（建完即毁）。
        只回答"可不可用"，不复用探测用的 root——Tkinter 铁律：root 必须
        由后续运行 mainloop 的同一线程创建，跨线程 after() 永远不触发
        （这正是浮窗点不开的根因）。失败留痕 flyout-error.log。"""
        try:
            probe = self._build_root()
            try:
                probe.destroy()
            except Exception:
                pass
            return True
        except Exception:
            import traceback
            from .common import DATA_DIR
            try:
                (DATA_DIR / "flyout-error.log").write_text(
                    traceback.format_exc(), encoding="utf-8")
            except OSError:
                pass
            return False

    def run(self) -> None:
        """阻塞：root 创建 + after + mainloop 必须全在本线程内完成。"""
        self._root = self._build_root()
        from .windows_menu import _trace_click
        _trace_click("flyout.run: root built in own thread, starting mainloop")
        self._root.after(80, self._poll)
        try:
            self._root.mainloop()
        finally:
            self._hide_legend_tip()
            self.visible = False
            self._root.destroy()
            self._root = None

    def request_quit(self) -> None:
        self._queue.put("quit")

    # ---- Tk 主线程 ----
    def _build_root(self):
        from .windows_menu import _trace_click
        import customtkinter as ctk
        ctk.set_appearance_mode("dark")
        root = ctk.CTk()
        root.withdraw()
        if sys.platform == "win32":
            # Set before mapping so the shell never creates a taskbar button.
            root.attributes("-toolwindow", True)
        # 教训：overrideredirect(无边框) 在本机 + CTk 组合下鼠标输入完全不达
        #（键盘可达、消息直投也不达）——改用普通装饰窗口，输入 100% 可靠。
        root.title(f"{APP_NAME} · {tr(TAGLINE)}")
        root.attributes("-topmost", True)
        root.configure(fg_color=_BG)
        root.protocol("WM_DELETE_WINDOW", self._hide)  # 关闭=隐藏，不退进程
        root.bind("<Escape>", lambda _e: self._hide())
        # 探针：窗口收到的任何鼠标按下都留痕——定位"按钮按不动"的关键证据
        root.bind("<Button-1>", lambda e: _trace_click(
            f"flyout window Button-1 at ({e.x},{e.y}) widget={type(e.widget).__name__}"))
        # 冻结 exe 无控制台：Tk 回调异常全部留痕，否则轮询断链无迹可寻
        root.report_callback_exception = _log_tk_exception
        return root

    @classmethod
    def _apply_dwm_round_corners(cls, root) -> None:
        """Windows 11 DWM 原生圆角 + 投影（Win10 静默降级为方角）。
        DWMWA_WINDOW_CORNER_PREFERENCE(33) = DWMWCP_ROUND(2)。系统级圆角：
        带抗锯齿与阴影，优于任何 transparentcolor/透明拼图 hack。"""
        if sys.platform != "win32":
            return
        try:
            import ctypes
            hwnd = cls._real_hwnd(root)  # 纯 int（HWND 包装曾 TypeError 静默失败）
            preference = ctypes.c_int(2)  # DWMWCP_ROUND
            ctypes.windll.dwmapi.DwmSetWindowAttribute(
                hwnd, 33, ctypes.byref(preference), ctypes.sizeof(preference))
        except Exception:
            pass

    def _poll(self):
        try:
            self._poll_once()
        except Exception:
            self._log_dispatch_error("poll")
            if self._root is not None:
                self._root.after(250, self._poll)

    def _poll_once(self):
        try:
            while True:
                item = self._queue.get_nowait()
                from .windows_menu import _trace_click
                _trace_click(f"flyout._poll: processing {item!r}")
                if item == "toggle":
                    self._toggle_on_main()
                elif item == "rows":
                    if self.visible:
                        self._render_rows(force=True)
                elif item == "quit":
                    self._root.quit()
                    return
        except queue.Empty:
            pass
        if self.visible:
            self._dismiss_if_inactive()
        if self.visible:
            # 防闪烁：只在数据/状态真正变化时重建，绝不盲目重画
            signature = (self._rows_provider(),
                         self._callbacks.get("autostart_enabled", lambda: True)())
            if signature != self._last_signature:
                self._render_rows()
                self._resize_to_content()
            self._update_feedback()
        self._root.after(250, self._poll)

    def _toggle_on_main(self):
        if self.visible:
            self._hide()
        else:
            self._show()

    def _hide(self):
        if getattr(self, "_progress", None) is not None:
            self._progress.stop()
            self._busy_animated = False
        self._hide_legend_tip()  # 悬停卡片不留孤儿
        try:
            self._root.withdraw()
        except Exception:
            pass
        self.visible = False

    def _dismiss_if_inactive(self):
        """Dismiss on app switching without confusing child/legend focus changes.

        Check the Windows foreground window from the existing Tk poll. A short
        opening grace allows the tray click and deiconify activation to settle.
        No global mouse hook or focus stealing is needed.
        """
        if time.monotonic() < getattr(self, "_dismiss_after", 0):
            return
        root = self._root
        if sys.platform == "win32":
            import ctypes
            user = ctypes.windll.user32
            user.GetForegroundWindow.restype = ctypes.c_void_p
            foreground = user.GetForegroundWindow()
            if not foreground:  # Brief transition between foreground windows.
                return
            owned = {self._real_hwnd(root)}
            tip = getattr(self, "_legend_tip", None)
            if tip is not None:
                owned.add(self._real_hwnd(tip))
            if foreground not in owned:
                self._hide()
        else:
            focused = root.focus_displayof()
            if focused is None or focused.winfo_toplevel() not in (
                    root, getattr(self, "_legend_tip", None)):
                self._hide()

    def _show(self):
        root = self._root
        cards = self._rows_provider()
        self._render_rows(force=True, cards=cards)
        # 实测内容高度（不再用公式猜——公式算少会把按钮挤出窗口）
        root.update_idletasks()
        req = 8
        for child in root.winfo_children():
            try:
                req = max(req, child.winfo_reqheight())
            except Exception:
                pass
        anchor = getattr(self, "_anchor", None)
        bounds = monitor_work_area(root, anchor)
        scale = root._get_window_scaling()
        max_h = bounds[3] - bounds[1] - 24
        if req > max_h:
            # 内容超出上限：卡片区改为可滚动，按钮/图例固定可见
            self._render_rows(force=True, cards=cards, scroll_h=max(60, int(max_h / scale) - 205))
            root.update_idletasks()
            req = max(8, min(max_h, root.winfo_children()[0].winfo_reqheight()))
            req = min(req, max_h)
        physical_h = min(max_h, max(round(300 * scale), req + 8))
        h = max(1, int(physical_h / scale))
        # 优先贴着托盘图标（点击瞬间采集的光标坐标，DPI 感知进程下与 Tk 同尺度）；
        # 无锚点（程序化调用）才退回屏幕右下角。上下放不下则翻转到另一侧。
        x, y = place_near_anchor(anchor, round(self.WIDTH * scale), round(h * scale), bounds)
        root.geometry(f"{self.WIDTH}x{h}+{x}+{y}")
        root.deiconify()
        # tkinter 坑：withdraw→deiconify 会丢 -topmost，必须在 deiconify 后重申
        root.attributes("-topmost", True)
        # 去标题栏：剥 WS_CAPTION 系样式位（保持普通窗口输入模型——
        # overrideredirect 会杀鼠标输入，绝不再用）
        self._strip_title_bar(root)
        root.geometry(f"{self.WIDTH}x{h}+{x}+{y}")  # 剥离后重申客户端几何
        self._apply_dwm_round_corners(root)
        root.lift()
        root.focus_force()
        self._dismiss_after = time.monotonic() + 0.3
        self.visible = True

    @staticmethod
    def _real_hwnd(root) -> int:
        """取 Tk 窗口的顶层原生句柄（纯 int——之前 HWND 包装 TypeError，
        剥离与圆角从未生效的根因）。"""
        import ctypes
        u32 = ctypes.windll.user32
        u32.GetParent.argtypes = [ctypes.c_void_p]
        u32.GetParent.restype = ctypes.c_void_p
        u32.GetAncestor.argtypes = [ctypes.c_void_p, ctypes.c_uint]
        u32.GetAncestor.restype = ctypes.c_void_p
        wid = root.winfo_id()
        parent = u32.GetParent(wid)
        hwnd = u32.GetAncestor(parent, 2) if parent else 0  # GA_ROOT
        return hwnd or wid

    @classmethod
    def _strip_title_bar(cls, root) -> None:
        """映射后剥掉标题栏/边框样式位。窗口仍走普通输入路径（与实测一致）。
        Tk 可能在几何/焦点操作后重设样式：每次 _show 重执 + after 延迟兜底。"""
        if sys.platform != "win32":
            return
        try:
            import ctypes
            u32 = ctypes.windll.user32
            hwnd = cls._real_hwnd(root)
            GWL_STYLE = -16
            WS_CAPTION, WS_THICKFRAME = 0x00C00000, 0x00040000
            WS_SYSMENU, WS_MINBOX, WS_MAXBOX = 0x00080000, 0x00010000, 0x00020000
            WS_POPUP = 0x80000000
            style = u32.GetWindowLongW(hwnd, GWL_STYLE)
            new = (style & ~(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINBOX | WS_MAXBOX)) | WS_POPUP
            from .windows_menu import _trace_click
            _trace_click(f"strip_title_bar: hwnd={hwnd} style=0x{style & 0xFFFFFFFF:08x} "
                         f"-> 0x{new & 0xFFFFFFFF:08x}")
            if new != style:
                u32.SetWindowLongW(hwnd, GWL_STYLE, new)
                u32.SetWindowPos(hwnd, 0, 0, 0, 0, 0,
                                 0x0001 | 0x0002 | 0x0004 | 0x0020 | 0x0010)  # NOMOVE|NOSIZE|NOZORDER|FRAMECHANGED|NOACTIVATE
                root.after(80, lambda: cls._strip_title_bar_quiet(root))
        except Exception as exc:
            from .windows_menu import _trace_click
            _trace_click(f"strip_title_bar FAILED: {exc!r}")

    @classmethod
    def _strip_title_bar_quiet(cls, root) -> None:
        """静默版剥离（after 兜底，不打日志）。"""
        if sys.platform != "win32":
            return
        try:
            import ctypes
            u32 = ctypes.windll.user32
            hwnd = cls._real_hwnd(root)
            GWL_STYLE = -16
            WS_CAPTION, WS_THICKFRAME = 0x00C00000, 0x00040000
            WS_SYSMENU, WS_MINBOX, WS_MAXBOX = 0x00080000, 0x00010000, 0x00020000
            WS_POPUP = 0x80000000
            style = u32.GetWindowLongW(hwnd, GWL_STYLE)
            new = (style & ~(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINBOX | WS_MAXBOX)) | WS_POPUP
            if new != style:
                u32.SetWindowLongW(hwnd, GWL_STYLE, new)
                u32.SetWindowPos(hwnd, 0, 0, 0, 0, 0,
                                 0x0001 | 0x0002 | 0x0004 | 0x0020 | 0x0010)
        except Exception:
            pass

    def _render_rows(self, force: bool = False, cards=None, scroll_h=None) -> None:
        """重建内容。``force=True`` 跳过签名比对；``scroll_h`` 给定时卡片区
        变为固定高度可滚动（按钮/图例始终可见，内容不再被砍）。"""
        signature = (self._rows_provider(),
                     self._callbacks.get("autostart_enabled", lambda: True)())
        if not force and signature == self._last_signature:
            return
        self._last_signature = signature
        cards = self._rows_provider() if cards is None else cards
        self._hide_legend_tip()  # 按钮即将重建：先清悬停卡片，避免孤儿残留
        import customtkinter as ctk
        for child in self._root.winfo_children():
            child.destroy()
        window = ctk.CTkFrame(self._root, fg_color=_BG, corner_radius=14)
        window.place(x=0, y=0, relwidth=1, relheight=1)

        head = ctk.CTkFrame(window, fg_color="transparent")
        head.pack(fill="x", padx=16, pady=(14, 8))
        ctk.CTkLabel(head, text=APP_NAME, font=("Segoe UI", 18, "bold"), text_color=_FG
                     ).pack(side="left")
        ctk.CTkLabel(head, text=tr(TAGLINE), font=("Segoe UI", 11), text_color=_MUTED
                     ).pack(side="left", padx=10, pady=(4, 0))

        # 按钮条沉底（side=bottom 先 pack 者在最下）；图例已改为按钮悬停浮窗
        bar_btns = ctk.CTkFrame(window, fg_color="transparent")
        bar_btns.pack(side="bottom", fill="x", padx=12, pady=(8, 14))

        self._feedback = ctk.CTkLabel(window, text='', wraplength=self.WIDTH - 32,
            anchor='w', justify='left', font=('Segoe UI', 11), text_color=_MUTED)
        self._feedback.pack(side='bottom', fill='x', padx=16, pady=(2, 0))
        self._progress = ctk.CTkProgressBar(window, height=3, fg_color=_BG, border_color=_BG, border_width=0, mode='indeterminate', indeterminate_speed=0.6)
        self._progress.pack(side='bottom', fill='x', padx=16, pady=2)
        self._progress.set(0)
        self._progress.configure(progress_color=_BG)
        self._busy_animated = False
        self._action_buttons = {}

        # 卡片容器：正常直接 pack；超高时用可滚动框架
        if scroll_h is not None:
            cards_area = ctk.CTkScrollableFrame(window, height=scroll_h,
                                                 fg_color="transparent",
                                                 scrollbar_button_color=_CARD)
            cards_area.pack(fill="both", expand=True, padx=0, pady=(0, 4))
            host = cards_area
        else:
            host = window

        for card in cards:
            hexdot = f"#{card['dot'][0]:02x}{card['dot'][1]:02x}{card['dot'][2]:02x}"
            row = ctk.CTkFrame(host, fg_color=_CARD, corner_radius=10)
            row.pack(fill="x", padx=12, pady=4)
            head_row = ctk.CTkFrame(row, fg_color="transparent")
            head_row.pack(fill="x", padx=10, pady=(8, 0))
            ctk.CTkLabel(head_row, text="●", text_color=hexdot, width=24,
                         font=("Segoe UI", 12)).pack(side="left")
            ctk.CTkLabel(head_row, text=tr(card["name"]), text_color=_FG, anchor="w", wraplength=self.WIDTH - 76, justify="left",
                         font=("Segoe UI", 13, "bold")).pack(side="left", padx=2)
            if card.get("headline") and not card.get("bars"):
                ctk.CTkLabel(head_row, text=tr(card["headline"]), text_color=_FG if card["name"] == "DeepSeek" else _MUTED,
                             anchor="e", font=("Segoe UI", 10, "bold") if card["name"] == "DeepSeek" else ("Segoe UI", 11)
                             ).pack(side="right")
            # 多窗口来源：逐条迷你进度条（颜色=剩余紧急度）
            for bar_label, remaining in card.get("bars") or []:
                cls = "#3fb950" if remaining > 50 else ("#d29922" if remaining > 20 else "#f85149")
                brow = ctk.CTkFrame(row, fg_color="transparent")
                brow.pack(fill="x", padx=12, pady=1)
                ctk.CTkLabel(brow, text=tr(bar_label), text_color=_MUTED, width=44,
                             anchor="w", font=("Segoe UI", 10)).pack(side="left")
                bar = ctk.CTkProgressBar(brow, width=80, height=6, corner_radius=3,
                                         fg_color="#21262d", progress_color=cls)
                bar.set(max(0.0, min(1.0, remaining / 100)))
                bar.pack(side="left", fill="x", expand=True, padx=4)
                ctk.CTkLabel(brow, text=tr(f"剩 {remaining:.0f}%"), text_color=_FG,
                             width=65, anchor="e", font=("Segoe UI", 10, "bold")).pack(side="left")
            if card.get("detail"):
                ctk.CTkLabel(row, text=tr(card["detail"]), wraplength=self.WIDTH - 48, justify="left", text_color=_MUTED, anchor="w",
                             font=("Segoe UI", 10)).pack(fill="x", padx=12, pady=(0, 6))

        for index, (text, action) in enumerate(_ACTIONS):
            label = text
            btn = ctk.CTkButton(bar_btns, text=tr(label), width=72, height=30, corner_radius=8,
                fg_color='#1f6feb' if action == 'autostart' and self._callbacks.get('autostart_enabled', lambda: False)() else _CARD, hover_color=_HOVER,
                text_color=_FG, font=('Segoe UI', 11), command=lambda a=action: self._dispatch(a))
            btn.grid(row=index // 4, column=index % 4, sticky='ew', padx=3, pady=3)
            bar_btns.grid_columnconfigure(index % 4, weight=1)
            self._action_buttons[action] = btn
            if action == 'legend':
                self._legend_btn = btn
        self._update_feedback()

    def _update_feedback(self):
        status = self._callbacks.get('status', lambda: {})()
        busy = bool(status.get('refreshing'))
        stalled = busy and status.get('started') is not None and time.monotonic() - status['started'] > 90
        message = tr('刷新耗时过长；等待当前请求结束') if stalled else tr('刷新中…') if busy else status.get('updated', '')
        if status.get('error'):
            message = tr('刷新失败；请检查网络后重试') + ' · ' + str(status['error'])
        self._feedback.configure(text=message, text_color='#f85149' if stalled or status.get('error') else _MUTED)
        for action in ('refresh', 'redetect'):
            self._action_buttons[action].configure(state='disabled' if busy else 'normal')
        animate = busy and not stalled
        if animate != self._busy_animated:
            self._progress.configure(progress_color="#1f6feb" if animate else _BG)
            self._progress.start() if animate else self._progress.stop()
            if not animate:
                self._progress.set(0)
            self._busy_animated = animate

    def _show_legend_tip(self) -> None:
        """在图例按钮上方浮出纯展示小卡片。"""
        btn = getattr(self, "_legend_btn", None)
        if btn is None:
            return
        self._hide_legend_tip()  # 先清旧（重渲染后可能残留）
        try:
            import customtkinter as ctk
            tip = ctk.CTkToplevel(self._root)
            tip.overrideredirect(True)
            tip.attributes("-topmost", True)
            tip.configure(fg_color=_BG)
            frame = ctk.CTkFrame(tip, fg_color=_CARD, corner_radius=10)
            frame.pack(padx=6, pady=6, fill="both", expand=True)
            for hexcolor, text in self._callbacks.get("legend", lambda: _LEGEND_ROWS)():
                lrow = ctk.CTkFrame(frame, fg_color="transparent")
                lrow.pack(fill="x", padx=12, pady=1)
                ctk.CTkLabel(lrow, text="●", text_color=hexcolor, width=24,
                             font=("Segoe UI", 11)).pack(side="left")
                ctk.CTkLabel(lrow, text=tr(text), text_color=_MUTED, anchor="w",
                             font=("Segoe UI", 11)).pack(side="left")
            tip.update_idletasks()
            tw = max(tip.winfo_reqwidth(), 240)
            th = tip.winfo_reqheight()
            bx, by = btn.winfo_rootx(), btn.winfo_rooty()
            bounds = monitor_work_area(self._root, (bx, by))
            x, y = place_near_anchor((bx + btn.winfo_width() // 2, by), tw, th, bounds)
            tip.geometry(f"{tw}x{th}+{x}+{y}")
            tip.deiconify()
            tip.attributes("-topmost", True)  # deiconify 后重申（已知坑）
            self._legend_tip = tip
        except Exception:
            self._log_dispatch_error("legend-tip")

    def _hide_legend_tip(self) -> None:
        tip = getattr(self, "_legend_tip", None)
        if tip is not None:
            try:
                tip.destroy()
            except Exception:
                pass
            self._legend_tip = None

    def _dispatch(self, action: str) -> None:
        from .windows_menu import _trace_click
        _trace_click(f"dispatch: {action} (hiding + invoking callback)")
        # 「图例」：点击切换显示/隐藏，浮窗本体不隐藏
        if action == "legend":
            if getattr(self, "_legend_tip", None) is not None:
                self._hide_legend_tip()
            else:
                self._show_legend_tip()
            return
        if action in ('refresh', 'redetect', 'autostart'):
            if action in ('refresh', 'redetect') and self._callbacks.get('status', lambda: {})().get('refreshing'):
                return
            callback = self._callbacks.get(action)
            if callable(callback):
                callback()
            self._update_feedback()
            return
        # 「面板」要等 onefile 子进程解压（2-5s）：浮窗先留在原地给反馈再隐藏
        if action == "panel":
            try:
                self._root.after(2500, self._hide)
            except Exception:
                self._hide()
            try:
                callback = self._callbacks.get("panel")
                if callable(callback):
                    callback()
            except Exception:
                self._log_dispatch_error(action)
            return
        self._hide()
        try:
            callback = self._callbacks.get(action)
            if callable(callback):
                callback()
        except Exception:
            self._log_dispatch_error(action)

    @staticmethod
    def _log_dispatch_error(action: str) -> None:
        # 浮窗动作异常必须留痕（冻结 exe 无控制台）
        import traceback
        from .common import DATA_DIR, now_utc
        log = DATA_DIR / "flyout-dispatch.log"
        try:
            if log.exists() and log.stat().st_size > 1_000_000:
                log.write_text("", encoding="utf-8")
            with open(log, "a", encoding="utf-8") as f:
                f.write(f"{now_utc().isoformat()} {action}: "
                        f"{traceback.format_exc()[-400:]}\n")
        except OSError:
            pass
