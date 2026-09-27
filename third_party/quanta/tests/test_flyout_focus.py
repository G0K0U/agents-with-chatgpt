"""Native focus regression: a tray popup must dismiss like a menu."""
import sys
import time
import unittest


@unittest.skipUnless(sys.platform == "win32", "Windows native focus")
class FlyoutFocus(unittest.TestCase):
    def test_other_window_dismisses_but_legend_and_children_do_not(self):
        import ctypes
        import customtkinter as ctk
        from aibar.flyout import QuantaFlyout

        popup = QuantaFlyout({"autostart_enabled": lambda: False}, lambda: [])
        popup._root = popup._build_root()
        root = popup._root
        other = ctk.CTk()
        other.title("Quanta focus regression target")
        other.geometry("260x140+40+40")
        other.withdraw()
        root.after(80, popup._poll)

        def pump(seconds=0.6):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                root.update()
                time.sleep(0.01)
            if popup.visible:
                user = ctypes.windll.user32
                user.GetWindowLongW.argtypes = [ctypes.c_void_p, ctypes.c_int]
                style = user.GetWindowLongW(popup._real_hwnd(root), -20)
                self.assertTrue(style & 0x80, "popup lost WS_EX_TOOLWINDOW")
                self.assertFalse(style & 0x40000, "popup advertises a taskbar button")

        try:
            popup._show()
            pump()
            self.assertTrue(popup.visible)
            other.deiconify()
            other.lift()
            other.focus_force()
            pump()
            user = ctypes.windll.user32
            user.GetForegroundWindow.restype = ctypes.c_void_p
            self.assertEqual(user.GetForegroundWindow(), popup._real_hwnd(other))
            self.assertFalse(popup.visible, "popup stayed above another foreground window")
            self.assertFalse(root.winfo_viewable())

            popup._show()
            pump()
            self.assertTrue(popup.visible, "popup could not reopen")
            popup._legend_btn.focus_force()
            pump()
            self.assertTrue(popup.visible, "child focus dismissed popup")
            popup._show_legend_tip()
            popup._legend_tip.focus_force()
            pump()
            self.assertTrue(popup.visible, "legend focus dismissed popup")
            self.assertIsNotNone(popup._legend_tip)
            other.focus_force()
            pump()
            self.assertFalse(popup.visible)
            self.assertIsNone(popup._legend_tip, "legend survived popup dismissal")
            popup._show()
            pump()
            self.assertTrue(popup.visible)
            root.event_generate("<Escape>")
            pump(0.1)
            self.assertFalse(popup.visible)
        finally:
            popup._hide()
            other.destroy()
            root.destroy()
            popup._root = None
