"""Build and verify local release packages from a clean, committed source tree."""
import argparse
import hashlib
import json
import shutil
import stat
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOP_LEVEL = {"README.md", "LICENSE", "requirements.txt", "config-example.json",
             "requirements-windows-build.txt", "requirements-macos-build.txt", "quanta_mac.py", ".gitattributes",
             "run_tray.py", "build_windows.py", "install_mac.py", "install_mac.command",
             "start_mac.command", "start_windows.bat", "start_hidden.vbs", "make_icon.py"}
DIRECTORIES = {"aibar", "tests", "tools", "docs", "assets", "packaging"}
ARTIFACTS = ("Quanta.exe", "Quanta.exe.build.json", "Quanta-source.zip",
             "README.md", "LICENSE", "config-example.json", "首次使用说明.txt",
             "SECURITY-AUDIT.md", "SOURCE-MANIFEST.json")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def source_files():
    output = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT)
    names = [n.decode("utf-8") for n in output.split(b"\0") if n]
    return sorted(n for n in names if n in TOP_LEVEL or n.split("/")[0] in DIRECTORIES)


def verify_license_inventory():
    record = json.loads((ROOT / "docs/DEPENDENCIES.json").read_text(encoding="utf-8"))
    expected = record["license_file_hashes"]
    actual = {p.relative_to(ROOT).as_posix(): sha(p.read_bytes())
              for p in (ROOT / "docs/licenses").rglob("*") if p.is_file()}
    if not expected or actual != expected:
        raise RuntimeError("License/source inventory is missing, modified or stale")


def build_inputs():
    verify_license_inventory()
    names = [p.relative_to(ROOT).as_posix() for folder in ("aibar", "assets")
             for p in (ROOT / folder).rglob("*") if p.is_file()
             and "__pycache__" not in p.parts and p.suffix in (".py", ".ico", ".png", ".svg", ".txt", ".json", ".js", ".html")]
    names += ["run_tray.py", "build_windows.py", "README.md", "requirements.txt",
              "requirements-windows-build.txt", "docs/DEPENDENCIES.json"]
    names += ["tools/gui_smoke.py"]
    names += ["LICENSE", "docs/THIRD-PARTY-NOTICES.txt"]
    names += [p.relative_to(ROOT).as_posix() for p in (ROOT / "docs/licenses").rglob("*") if p.is_file()]
    return {name: sha((ROOT / name).read_bytes()) for name in sorted(names)}


def revision():
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()


def verify_exe(destination):
    record = json.loads((destination / "Quanta.exe.build.json").read_text(encoding="utf-8"))
    if record["inputs"] != build_inputs() or record["exe_sha256"] != sha((destination / "Quanta.exe").read_bytes()):
        raise RuntimeError("EXE or build inputs are stale; rebuild the Windows EXE first")


def create_release(destination):
    dirty = subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT)
    if dirty.strip():
        raise RuntimeError("Commit the intended source changes before packaging")
    destination.mkdir(parents=True, exist_ok=True)
    verify_exe(destination)
    names = source_files()
    sources = {name: sha((ROOT / name).read_bytes()) for name in names}
    record = {"source_revision": revision(), "files": sources}
    with zipfile.ZipFile(destination / "Quanta-source.zip", "w", zipfile.ZIP_DEFLATED) as z:
        for name in names:
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            mode = 0o755 if name.endswith(".command") else 0o644
            info.external_attr = (stat.S_IFREG | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, (ROOT / name).read_bytes())
        z.writestr("SOURCE-MANIFEST.json", json.dumps(record, indent=2, sort_keys=True))
    for name in ("README.md", "LICENSE", "config-example.json"):
        shutil.copy2(ROOT / name, destination / name)
    shutil.copy2(ROOT / "docs/FIRST-USE.txt", destination / "首次使用说明.txt")
    shutil.copy2(ROOT / "docs/SECURITY-AUDIT.md", destination / "SECURITY-AUDIT.md")
    (destination / "SOURCE-MANIFEST.json").write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (destination / "SHA256SUMS").write_text("".join(f"{sha((destination / n).read_bytes())}  {n}\n" for n in ARTIFACTS), encoding="utf-8")
    verify_release(destination)


def verify_release(destination):
    verify_exe(destination)
    checksums = {}
    for line in (destination / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        expected, name = line.split("  ", 1)
        if name not in ARTIFACTS or name in checksums:
            raise RuntimeError("Unexpected or duplicate checksum entry")
        checksums[name] = expected
        if sha((destination / name).read_bytes()) != expected:
            raise RuntimeError(f"Artifact checksum mismatch: {name}")
    if set(checksums) != set(ARTIFACTS):
        raise RuntimeError("Incomplete artifact checksums")
    record = json.loads((destination / "SOURCE-MANIFEST.json").read_text(encoding="utf-8"))
    if record["source_revision"] != revision():
        raise RuntimeError("Source revision differs from the release")
    if set(record["files"]) != set(source_files()):
        raise RuntimeError("Release source inventory differs from current source")
    with zipfile.ZipFile(destination / "Quanta-source.zip") as z:
        if set(z.namelist()) != set(record["files"]) | {"SOURCE-MANIFEST.json"}:
            raise RuntimeError("Unexpected or missing ZIP entries")
        for name, expected in record["files"].items():
            if sha(z.read(name)) != expected or sha((ROOT / name).read_bytes()) != expected:
                raise RuntimeError(f"Source mismatch: {name}")
        if json.loads(z.read("SOURCE-MANIFEST.json")) != record:
            raise RuntimeError("ZIP provenance differs from the release")
    print(f"RELEASE VERIFIED: {len(record['files'])} source files; all artifact and ZIP hashes match; {record['source_revision']}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("build", "verify"))
    parser.add_argument("--dist-dir", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    (create_release if args.action == "build" else verify_release)(args.dist_dir.resolve())
