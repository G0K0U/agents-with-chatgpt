"""PyInstaller 入口。

必须从根目录的独立脚本启动：ui_windows 内部使用相对导入
（from .config import ...），把 aibar/ui_windows.py 直接当脚本打包
会因"无父包"而 ImportError。此入口用绝对导入，冻结后一切正常。
"""
from aibar.ui_windows import main

if __name__ == "__main__":
    main()
