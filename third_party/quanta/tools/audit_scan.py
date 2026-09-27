"""Known-value privacy check of tracked files and every Git history blob.

Sensitive values stay in memory. Counts are printed, never the values.
This does not prove that arbitrary, previously unknown secrets are absent.
"""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLACEHOLDERS = {"your_token_here", "claude code", "muse code"}


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def tracked_files():
    return [ROOT / name.decode("utf-8") for name in git("ls-files", "-z").split(b"\0") if name]


def build_dictionary(config=None):
    values = set()
    config = Path(config) if config else Path.home() / ".aibar/config.json"
    def visit(node, key=""):
        if isinstance(node, dict):
            for k, value in node.items():
                visit(value, k)
        elif isinstance(node, list):
            for item in node:
                visit(item, key)
        elif isinstance(node, str):
            values.update(re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+", node))
            if any(word in key.lower() for word in ("token", "api_key", "password", "secret")):
                values.add(node)
    if config.exists():
        visit(json.loads(config.read_text(encoding="utf-8-sig")))
    for name in ("config-预填-mac.json", "给AI的安装说明.md", "MAC-部署必读.txt", "完整对话记录.md"):
        for directory in (ROOT, ROOT / "private"):
            path = directory / name
            if path.is_file():
                value = path.read_text(encoding="utf-8", errors="replace")
                values.update(re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+|sk-[A-Za-z0-9_-]{8,}", value))
    return {v for v in values if len(v) >= 4 and v.lower() not in PLACEHOLDERS}


def scan():
    values = [v.lower().encode("utf-8") for v in build_dictionary()]
    if not values:
        print("PRIVACY SCAN: UNAVAILABLE (no known local sensitive values)")
        return 2
    hits = files = blobs = 0
    for path in tracked_files():
        files += 1
        data = path.read_bytes().lower()
        hits += any(value in data for value in values)
    objects = git("rev-list", "--objects", "--all").splitlines()
    process = subprocess.Popen(["git", "cat-file", "--batch"], cwd=ROOT,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
        for line in objects:
            oid = line.split(b" ", 1)[0]
            process.stdin.write(oid + b"\n")
            process.stdin.flush()
            header = process.stdout.readline().split()
            if len(header) != 3:
                raise RuntimeError("Git object read failed")
            size = int(header[2])
            data = process.stdout.read(size)
            if len(data) != size or process.stdout.read(1) != b"\n":
                raise RuntimeError("Incomplete Git object")
            if header[1] == b"blob":
                blobs += 1
                lower = data.lower()
                hits += any(value in lower for value in values)
    finally:
        process.stdin.close()
        process.stdout.close()
        process.wait()
    if process.returncode:
        raise RuntimeError("Git history scan failed")
    print(f"known values: {len(values)}; tracked files: {files}; history blobs: {blobs}; matches: {hits}")
    print("PRIVACY SCAN: " + ("CLEAN (scoped known-value check)" if not hits else "FAIL"))
    return 1 if hits else 0


def manifest():
    target = ROOT / "private/MANIFEST.sha256"
    target.parent.mkdir(exist_ok=True)
    lines = [f"# Source revision: {git('rev-parse', 'HEAD').decode().strip()}"]
    for path in sorted(tracked_files()):
        lines.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(ROOT).as_posix()}")
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Source manifest rebuilt: {len(lines) - 1} files; EXE checksums are in dist/SHA256SUMS")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("scan", "manifest"), nargs="?", default="scan")
    args = parser.parse_args()
    return scan() if args.action == "scan" else manifest()


if __name__ == "__main__":
    raise SystemExit(main())
