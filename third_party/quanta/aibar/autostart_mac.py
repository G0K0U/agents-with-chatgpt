"""Opt-in login startup; never restart the active tray or edit account config."""
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

LABEL = 'com.aibar.tray'


def target_path():
    return Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')


def _read_owned(path):
    if path.is_symlink():
        raise ValueError('Refusing to replace a linked startup file')
    spec = plistlib.loads(path.read_bytes())
    args = spec.get('ProgramArguments', [])
    source_command = len(args) == 3 and args[1:] == ['-m', 'aibar.ui_mac']
    bundle_command = len(args) in (1, 2) and str(args[0]).endswith('/Quanta.app/Contents/MacOS/Quanta') and (len(args) == 1 or args[1] == '--background')
    if spec.get('Label') != LABEL or not (source_command or bundle_command):
        raise ValueError('Existing startup file belongs to another command')
    return spec


def is_enabled():
    path = target_path()
    if not path.exists():
        return False
    spec = _read_owned(path)
    result = subprocess.run(['launchctl', 'print-disabled', f'gui/{os.getuid()}'],
                            capture_output=True, text=True, timeout=5)
    disabled = f'"{LABEL}" => true' in result.stdout
    return bool(spec.get('RunAtLoad')) and not disabled


def set_enabled(enabled):
    from .common import DATA_DIR
    path = target_path()
    if path.is_symlink():
        raise ValueError("Refusing to replace a linked startup file")
    previous = path.read_bytes() if path.exists() else None
    if previous is not None:
        _read_owned(path)
    backup = None
    if previous is not None:
        folder = DATA_DIR / 'startup-backups'
        folder.mkdir(parents=True, exist_ok=True)
        backup = folder / (LABEL + '-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '.plist')
        shutil.copy2(path, backup)
        backup.chmod(0o600)
    if enabled:
        path.parent.mkdir(parents=True, exist_ok=True)
        spec = {'Label': LABEL, 'ProgramArguments': ([sys.executable, '--background'] if getattr(sys, 'frozen', False) else [sys.executable, '-m', 'aibar.ui_mac']),
                'WorkingDirectory': str(Path(__file__).resolve().parent.parent),
                'RunAtLoad': True, 'StandardOutPath': str(DATA_DIR / 'mac-stdout.log'),
                'StandardErrorPath': str(DATA_DIR / 'mac-stderr.log')}
        fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.quanta-')
        try:
            with os.fdopen(fd, 'wb') as stream:
                plistlib.dump(spec, stream)
            os.replace(temporary, path)
            result = subprocess.run(['launchctl', 'enable', f'gui/{os.getuid()}/{LABEL}'],
                                    capture_output=True, timeout=5)
            if result.returncode:
                raise OSError('Login startup could not be enabled')
        except Exception:
            if previous is None:
                path.unlink(missing_ok=True)
            elif backup:
                shutil.copy2(backup, path)
            raise
        finally:
            Path(temporary).unlink(missing_ok=True)
    elif previous is not None:
        # Disabling affects future launches, not the currently running process.
        result = subprocess.run(['launchctl', 'disable', f'gui/{os.getuid()}/{LABEL}'],
                                capture_output=True, timeout=5)
        if result.returncode:
            raise OSError('Login startup could not be disabled')
        path.unlink()  # Exact, validated file; an owner-only backup was kept above.
