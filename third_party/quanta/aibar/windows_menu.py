"""Real bitmap status dots for Windows menus, independent of emoji rendering."""
import ctypes
import struct
from ctypes import wintypes

import pystray
from PIL import Image, ImageDraw


def _trace_click(message: str) -> None:
    """点击链路追踪：托盘→浮窗→Tk 每一跳都留痕（1MB 截断）。
    成功路径也记录——这是定位"点了没反应"的唯一可靠手段。"""
    from .common import DATA_DIR, now_utc
    log = DATA_DIR / "click-trace.log"
    try:
        if log.exists() and log.stat().st_size > 1_000_000:
            log.write_text("", encoding="utf-8")
        with open(log, "a", encoding="utf-8") as f:
            f.write(f"{now_utc().isoformat()} {message}\n")
    except OSError:
        pass


class ColorMenuItem(pystray.MenuItem):
    def __init__(self, text, color=None):
        super().__init__(text, None, enabled=True)
        self.status_color = color


class ColorIcon(pystray.Icon):
    """托盘图标：原生菜单行带彩色圆点位图；可接管为自定义浮窗。

    ``menu_toggle`` 非 None 时（浮窗模式），左/右键都改为弹出自定义浮窗，
    原生菜单完全不再出现。"""
    menu_toggle = None

    def __init__(self, *args, **kwargs):
        self._status_bitmaps = {}
        self._gdi = ctypes.WinDLL('gdi32', use_last_error=True)
        self._gdi.CreateDIBSection.argtypes = [wintypes.HDC, ctypes.c_void_p, wintypes.UINT,
            ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD]
        self._gdi.CreateDIBSection.restype = wintypes.HBITMAP
        self._gdi.DeleteObject.argtypes = [wintypes.HANDLE]
        self._gdi.DeleteObject.restype = wintypes.BOOL
        super().__init__(*args, **kwargs)

    def _bitmap(self, color):
        if color not in self._status_bitmaps:
            size = 16
            image = Image.new('RGBA', (size, size))
            ImageDraw.Draw(image).ellipse((2, 2, size-3, size-3), fill=(*color, 255))
            pixels = image.tobytes('raw', 'BGRA')
            info = ctypes.create_string_buffer(struct.pack('<IiiHHIIiiII',
                40, size, -size, 1, 32, 0, len(pixels), 0, 0, 0, 0) + bytes(4))
            pointer = ctypes.c_void_p()
            handle = self._gdi.CreateDIBSection(None, info, 0, ctypes.byref(pointer), None, 0)
            if not handle:
                raise ctypes.WinError(ctypes.get_last_error())
            ctypes.memmove(pointer, pixels, len(pixels))
            self._status_bitmaps[color] = handle
        return self._status_bitmaps[color]

    def _create_menu_item(self, descriptor, callbacks):
        item = super()._create_menu_item(descriptor, callbacks)
        color = getattr(descriptor, 'status_color', None)
        if color is not None:
            item.fMask |= 0x80  # MIIM_BITMAP, alongside MIIM_STRING.
            item.hbmpItem = self._bitmap(color)
        return item

    def close_status_bitmaps(self):
        for handle in self._status_bitmaps.values():
            self._gdi.DeleteObject(handle)
        self._status_bitmaps.clear()

    def _on_notify(self, wparam, lparam):
        """浮窗模式：左/右键都改为弹出 Quanta 自定义浮窗（锚定图标位置）。"""
        if self.menu_toggle is not None:
            from pystray._util import win32
            if lparam in (win32.WM_LBUTTONUP, win32.WM_RBUTTONUP):
                _trace_click(f"on_notify lparam={lparam} → menu_toggle")
                # 点击瞬间记录光标物理坐标（=托盘图标位置）——Tk 已把进程
                # 设为 DPI aware，此坐标与 Tk 屏幕坐标同尺度
                anchor = None
                try:
                    import ctypes
                    from ctypes import wintypes
                    pt = wintypes.POINT()
                    ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
                    anchor = (pt.x, pt.y)
                except Exception:
                    pass
                try:
                    self.menu_toggle(anchor)
                except Exception:
                    import traceback
                    _trace_click("menu_toggle RAISED: " + traceback.format_exc()[-300:])
                return
        super()._on_notify(wparam, lparam)
