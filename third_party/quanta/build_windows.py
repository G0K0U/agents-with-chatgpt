"""Build the Windows tray exe with PyInstaller (run on Windows).

Usage (on Windows, from the project root):
    python -m venv .venv
    .venv\\Scripts\\python -m pip install -r requirements-windows-build.txt
    .venv\\Scripts\\python build_windows.py

Output: dist\\Quanta.exe (windowless, with icon). dist/ is git-ignored.
Cross-building a Windows exe from Linux/macOS is not supported by
PyInstaller, so this script refuses to run elsewhere on purpose.
"""
import os
import argparse
import hashlib
import json
import importlib.metadata
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ENTRY = ROOT / "run_tray.py"
ICON = ROOT / "assets" / "icon.ico"
ASSETS = ROOT / "assets"


def verify_build_environment():
    # Optional packages can be pulled into the EXE by dependency hooks.
    # Require the exact lock in a dedicated environment to keep the inventory true.
    normalize = lambda name: name.lower().replace("_", "-").replace(".", "-")
    expected = dict(line.split("==") for line in
                    (ROOT / "requirements-windows-build.txt").read_text().splitlines()
                    if line.strip() and not line.startswith("#"))
    expected = {normalize(name): version for name, version in expected.items()}
    actual = {normalize(dist.metadata["Name"]): dist.version
              for dist in importlib.metadata.distributions()
              if normalize(dist.metadata["Name"]) not in {"pip", "setuptools"}}
    if not expected or actual != expected:
        raise RuntimeError("Build in a clean virtual environment with only requirements-windows-build.txt installed")


def main(output_dir=None) -> int:
    if sys.platform != "win32":
        print("build_windows.py must run on Windows: PyInstaller cannot cross-build "
              "a Windows exe from this platform.")
        print("On your Windows machine, run the three commands in this file's docstring.")
        return 2
    if not ENTRY.is_file():
        print(f"missing entry: {ENTRY}")
        return 1
    if not ICON.is_file():
        print(f"missing icon: {ICON}")
        return 1
    from tools.release import build_inputs, revision
    verify_build_environment()
    output_dir = Path(output_dir).resolve() if output_dir else ROOT / "dist"
    inputs = build_inputs()
    source_revision = revision()
    cmd = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean",
           "--noconsole", "--onefile", "--name", "Quanta",
           "--distpath", str(output_dir),
           "--icon", str(ICON),
           "--version-file", str(ASSETS / "windows-version.txt"),
           "--add-data", f"{ASSETS}{os.pathsep}assets",
           "--add-data", f"{ROOT / 'README.md'}{os.pathsep}.",
           "--add-data", f"{ROOT / 'LICENSE'}{os.pathsep}.",
           "--add-data", f"{ROOT / 'docs/THIRD-PARTY-NOTICES.txt'}{os.pathsep}.",
           "--add-data", f"{ROOT / 'docs/licenses'}{os.pathsep}licenses",
           # customtkinter 自带主题数据文件，PyInstaller 不会自动收集
           "--collect-all", "customtkinter",
           "--collect-all", "pywinstyles",
           str(ENTRY)]
    print("running:", " ".join(cmd))
    completed = subprocess.run(cmd, cwd=ROOT)
    exe = output_dir / "Quanta.exe"
    if completed.returncode == 0 and exe.is_file():
        if inputs != build_inputs():
            raise RuntimeError("Build inputs changed during the build")
        record = {"source_revision": source_revision, "inputs": inputs,
                  "exe_sha256": hashlib.sha256(exe.read_bytes()).hexdigest(),
                  "python_version": sys.version,
                  "build_packages": {name: importlib.metadata.version(name)
                                     for name in ("PyInstaller", "pillow", "pywebview", "pystray", "pythonnet", "customtkinter", "pywinstyles")}}
        exe.with_suffix(".exe.build.json").write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"built: {exe}")
    return completed.returncode


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist-dir", type=Path)
    raise SystemExit(main(parser.parse_args().dist_dir))
