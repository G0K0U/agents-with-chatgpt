# Local macOS arm64 build. No credentials or user data are bundled.
from pathlib import Path
root = Path(SPECPATH).resolve().parents[1]
import sys
sys.path.insert(0, str(root))
from aibar.dock_icon_mac import png_data
from PyInstaller.config import CONF
mac_icon = Path(CONF['workpath']) / "quanta-dock.png"
mac_icon.parent.mkdir(parents=True, exist_ok=True)
mac_icon.write_bytes(png_data())
a = Analysis([str(root / 'quanta_mac.py')], pathex=[str(root)],
             binaries=[], datas=[(str(root / 'assets'), 'assets')],
             hiddenimports=['Security', 'WebKit', 'AppKit', 'Foundation'],
             hookspath=[], hooksconfig={}, runtime_hooks=[],
             excludes=['tkinter', 'pytest'], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='Quanta',
          debug=False, bootloader_ignore_signals=False, strip=False,
          upx=False, console=False, target_arch='arm64',
          codesign_identity=None, entitlements_file=None)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='Quanta')
app = BUNDLE(coll, name='Quanta.app', icon=str(mac_icon),
             bundle_identifier='com.sparklingastronaut.quanta',
             info_plist={'CFBundleDisplayName':'Quanta', 'CFBundleName':'Quanta',
                         'CFBundleShortVersionString':'0.9.0', 'CFBundleVersion':'9.6',
                         'LSUIElement':True, 'CFBundleDevelopmentRegion':'en',
                         'CFBundleLocalizations':['en','zh-Hans','zh-Hant'], 'NSHighResolutionCapable':True,
                         'NSPrincipalClass':'NSApplication'})
