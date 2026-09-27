import ctypes
import sys
import unittest

from aibar.icon import AMBER, BLUE, GRAY, GREEN, RED, render_icon
from aibar.oneshot import quota_color, render_rows


class UsageColours(unittest.TestCase):
    def test_quota_thresholds_and_invalid_values(self):
        for used, expected in ((0, GREEN), (49, GREEN), (50, AMBER), (79, AMBER),
                               (80, RED), (100, RED), (None, GRAY), (101, GRAY),
                               (-1, GRAY), (float('nan'), GRAY), (True, GRAY)):
            with self.subTest(used=used):
                self.assertEqual(quota_color(used), expected)

    def test_account_windows_are_independent_and_stale_is_neutral(self):
        account = {'label':'example', 'attribution_verified':True, 'stale':False,
                   'effective_primary_used_percent':90, 'effective_secondary_used_percent':5}
        # 单行式：取两窗口中最紧的（90% 用量 → 剩 10% → RED）
        single = render_rows({'codex':{'accounts':[account]}})[0]
        self.assertEqual(single.color, RED)
        stale = render_rows({'codex':{'accounts':[{**account, 'stale':True}]}})[0]
        self.assertEqual(stale.color, GRAY)
        # reset_done 的 5h 窗口被排除，颜色只由可信的周窗口（剩 95%）决定
        reset = render_rows({'codex':{'accounts':[{**account, 'primary_reset_done':True}]}})[0]
        self.assertEqual(reset.color, GREEN)
        rows = render_rows({'codex':{'accounts':[{**account, 'attribution_verified':False}]}})
        self.assertTrue(any(r.color == GRAY and '核验' in r.text for r in rows))

    def test_provider_windows_balance_and_unknown_quota(self):
        rows = render_rows({'glm':{'stale':False, 'windows':[{'label':'5h','percent':10},
                    {'label':'week','percent':65}]}, 'deepseek':{'stale':False,
                    'balances':[{'total_balance':'12.34','currency':'USD'}], 'is_available':True}})
        # 单行式：GLM 取最紧窗口（week 剩 35% → AMBER）
        self.assertEqual([r.color for r in rows if r.text.startswith('GLM')], [AMBER])
        self.assertTrue(any(r.color == BLUE and '12.34' in r.text for r in rows))

    @unittest.skipUnless(sys.platform == 'win32', 'Native Windows menu')
    def test_native_menu_has_real_coloured_bitmaps_and_reuses_handles(self):
        from pystray import Menu
        from pystray._util import win32
        from aibar.windows_menu import ColorIcon, ColorMenuItem
        icon = ColorIcon('colour-proof', render_icon(None), menu=Menu(
            ColorMenuItem('red', RED), ColorMenuItem('green', GREEN), ColorMenuItem('red again', RED)))
        get_info = ctypes.WinDLL('user32', use_last_error=True).GetMenuItemInfoW
        get_info.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.POINTER(win32.MENUITEMINFO)]
        get_info.restype = ctypes.c_int
        try:
            for _ in range(3):
                icon._update_menu()
                handles = []
                for index in range(3):
                    info = win32.MENUITEMINFO(cbSize=ctypes.sizeof(win32.MENUITEMINFO), fMask=0x80|0x1)
                    self.assertTrue(get_info(icon._menu_handle[0], index, True, ctypes.byref(info)))
                    self.assertTrue(info.hbmpItem)
                    self.assertFalse(info.fState & win32.MFS_DISABLED)
                    handles.append(info.hbmpItem)
                self.assertEqual(handles[0], handles[2])
                self.assertNotEqual(handles[0], handles[1])
                self.assertEqual(len(icon._status_bitmaps), 2)
        finally:
            if icon._menu_handle:
                win32.DestroyMenu(icon._menu_handle[0])
                icon._menu_handle = None
            icon.close_status_bitmaps()


if __name__ == '__main__':
    unittest.main()
