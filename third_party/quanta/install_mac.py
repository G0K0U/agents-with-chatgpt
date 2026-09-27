"""Install a per-user launch agent using this package's virtual environment."""
import os
import plistlib
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

def main():
    if sys.platform != "darwin":
        raise SystemExit("macOS only")
    root = Path(__file__).resolve().parent
    python = root / ".venv/bin/python"
    if not python.is_file():
        raise SystemExit("Run install_mac.command first")
    os.umask(0o077)
    from aibar.config import load_config, CONFIG_PATH
    load_config()
    CONFIG_PATH.chmod(0o600)
    data = CONFIG_PATH.parent
    agents = Path.home() / "Library/LaunchAgents"
    agents.mkdir(parents=True, exist_ok=True)
    target = agents / "com.aibar.tray.plist"
    if target.exists():
        shutil.copy2(target, target.with_suffix(".plist.before-" + datetime.now().strftime("%Y%m%d-%H%M%S")))
        subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}", str(target)], check=False, capture_output=True)
    spec = {"Label": "com.aibar.tray", "ProgramArguments": [str(python), "-m", "aibar.ui_mac"],
            "WorkingDirectory": str(root), "RunAtLoad": True,
            "StandardOutPath": str(data / "mac-stdout.log"), "StandardErrorPath": str(data / "mac-stderr.log")}
    with target.open("wb") as f:
        plistlib.dump(spec, f)
    target.chmod(0o600)
    subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(target)], check=True)
    print("Quanta installed. Configuration:", CONFIG_PATH)
    print("Validate the menu and peer status on this Mac; no provider credentials were bundled.")

if __name__ == "__main__":
    main()
