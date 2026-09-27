"""Wrap the gated portable release in a per-user Windows installer."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from tools.portable_release import VERSION, check_gates, digest
from tools.release import revision


def verify_package(package, dist):
    expected = {}
    for line in (package / 'SHA256SUMS').read_text(encoding='utf-8').splitlines():
        checksum, name = line.split('  ', 1)
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts or name in expected:
            raise RuntimeError('Invalid portable manifest path')
        expected[name] = checksum
    actual = {p.relative_to(package).as_posix() for p in package.rglob('*') if p.is_file()}
    if actual != set(expected) | {'SHA256SUMS'}:
        raise RuntimeError('Portable package file inventory differs')
    if any(digest(package / name) != checksum for name, checksum in expected.items()):
        raise RuntimeError('Portable package checksum mismatch')
    status = json.loads((package / 'RELEASE-STATUS.json').read_text(encoding='utf-8'))
    if (status['version'] != VERSION or status['source_revision'] != revision()
            or digest(package / 'Quanta.exe') != digest(dist / 'Quanta.exe')
            or digest(package / f'Quanta-{VERSION}-source.zip') != digest(dist / 'Quanta-source.zip')):
        raise RuntimeError('Portable package is stale')
    return {name: checksum for name, checksum in expected.items() if name != 'Verify.cmd'}


def build(compiler, package, output, dist, evidence):
    check_gates(dist, evidence)
    files = verify_package(package, dist)
    output.mkdir(parents=True, exist_ok=True)
    target = output / f'Quanta-{VERSION}-Windows-x64-Setup.exe'
    if target.exists():
        raise RuntimeError('Installer already exists; use a fresh output directory')
    subprocess.run([str(compiler), '/Qp', f'/DAppVersion={VERSION}',
                    f'/DPackageDir={package}', f'/DOutputDir={output}',
                    str(ROOT / 'packaging/windows/Quanta.iss')], check=True, cwd=ROOT)
    checksum = digest(target)
    target.with_suffix('.exe.sha256').write_text(checksum + '  ' + target.name + '\n', encoding='ascii')
    files['InnoSetup-LICENSE.txt'] = digest(ROOT / 'packaging/windows/InnoSetup-LICENSE.txt')
    record = {'version': VERSION, 'source_revision': revision(), 'installer_sha256': checksum,
              'compiler_sha256': digest(compiler), 'payload_files': files,
              'signed': False, 'scope': 'current user', 'desktop_shortcut_default': True,
              'start_menu_shortcut': True, 'launch_at_login_default': False}
    target.with_suffix('.exe.build.json').write_text(json.dumps(record, indent=2), encoding='utf-8')
    print(f'Installer built: {target}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--compiler', type=Path, required=True)
    parser.add_argument('--package', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--dist', type=Path, default=ROOT / 'dist')
    parser.add_argument('--evidence', type=Path, default=ROOT / 'work/evidence')
    args = parser.parse_args()
    build(*(getattr(args, name).resolve() for name in ('compiler','package','output','dist','evidence')))
