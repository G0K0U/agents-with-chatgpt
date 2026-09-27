"""Per-user autostart via the HKCU Run key.

  python -m aibar.autostart_windows on     # 开机自启（当前用户）
  python -m aibar.autostart_windows off    # 取消自启
  python -m aibar.autostart_windows show   # 查看当前状态

Uses pythonw.exe (windowless) plus an absolute sys.path insert, so it does
not depend on PATH or the task's working directory.
"""
import sys
import winreg
from pathlib import Path

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
VALUE_NAME = "Quanta"


def _command() -> str:
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}"'
    project_dir = str(Path(__file__).resolve().parent.parent)
    # 优先直启打包好的 exe；无 dist 产物时回退 pythonw 源码模式
    exe = Path(project_dir) / "dist" / "Quanta.exe"
    if exe.is_file():
        return f'"{exe}"'
    pythonw = sys.executable.replace("python.exe", "pythonw.exe")
    inner = (
        f"import sys; sys.path.insert(0, r'{project_dir}'); "
        "from aibar.ui_windows import main; main()"
    )
    return f'"{pythonw}" -c "{inner}"'


def is_enabled() -> bool:
    """菜单开关用：自启项是否存在（不打印、不抛错）。"""
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_READ) as key:
            winreg.QueryValueEx(key, VALUE_NAME)
        return True
    except (FileNotFoundError, OSError):
        return False


def enable() -> None:
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
        winreg.SetValueEx(k, VALUE_NAME, 0, winreg.REG_SZ, _command())
    print("已开启开机自启（当前用户）。")


def disable() -> None:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
            winreg.DeleteValue(k, VALUE_NAME)
        print("已取消开机自启。")
    except FileNotFoundError:
        print("本来就没有自启项。")


def show() -> None:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            val, _ = winreg.QueryValueEx(k, VALUE_NAME)
        print("自启已开启，命令为：\n ", val)
    except FileNotFoundError:
        print("自启未开启。")


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "show"
    {"on": enable, "off": disable, "show": show}[action]()
