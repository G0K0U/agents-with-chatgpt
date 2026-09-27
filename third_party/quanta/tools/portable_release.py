"""Prepare an unsigned Windows RC only after matching source/EXE gates pass."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys
import zipfile

ROOT = Path(__file__).resolve().parent.parent
VERSION = "0.9.4"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_gates(dist, evidence):
    from tools.release import verify_release, revision, source_files
    verify_release(dist)
    tests = json.loads((evidence / "test-results.json").read_text(encoding="utf-8"))
    expected = {name: digest(ROOT / name) for name in source_files()}
    if (not tests.get("ok") or tests.get("tests_run", 0) < 121 or tests.get("failures")
            or tests.get("errors") or tests.get("source_revision") != revision()
            or tests.get("source_hashes") != expected):
        raise RuntimeError("Source test evidence is missing, failed or stale")
    smoke = json.loads((evidence / "smoke-results.json").read_text(encoding="utf-8"))
    required = {"normal EXE startup", "API authentication", "second instance exits",
                "flyout actual rendering and lifecycle", "panel actual rendering and lifecycle",
                "fresh watchdog health", "configuration preserved", "no main or Tk callback errors"}
    if len(smoke) != len(required) or {r.get("name") for r in smoke} != required or not all(r.get("ok") for r in smoke):
        raise RuntimeError("EXE acceptance has not passed all required checks")
    if (evidence / "smoke-exe.sha256").read_text().strip() != digest(dist / "Quanta.exe"):
        raise RuntimeError("EXE acceptance belongs to a different binary")
    return tests, smoke


def build(dist, evidence, output):
    from tools.release import revision
    tests, smoke = check_gates(dist, evidence)
    output.mkdir(parents=True, exist_ok=True)
    package = output / f"Quanta-{VERSION}-Windows-x64-portable"
    if package.exists():
        raise RuntimeError("Use a fresh output directory; existing package will not be overwritten")
    package.mkdir()
    for name in ("Quanta.exe", "Quanta.exe.build.json", "LICENSE", "config-example.json", "SOURCE-MANIFEST.json"):
        shutil.copyfile(dist / name, package / name)
    for source, name in (("docs/PORTABLE-FIRST-USE.txt", "START-HERE.txt"),
                         ("docs/PRIVACY.md", "PRIVACY.md"),
                         ("docs/RELEASE-NOTES.md", "RELEASE-NOTES.md"),
                         ("docs/THIRD-PARTY-NOTICES.txt", "THIRD-PARTY-NOTICES.txt"),
                         ("docs/DEPENDENCIES.json", "DEPENDENCIES.json"),
                         ("tools/Verify.cmd", "Verify.cmd")):
        shutil.copyfile(ROOT / source, package / name)
    shutil.copytree(ROOT / "docs/licenses", package / "licenses")
    # Corresponding app and LGPL library source stay with every portable download.
    shutil.copyfile(dist / "Quanta-source.zip", package / f"Quanta-{VERSION}-source.zip")
    status = {"version": VERSION, "channel": "unsigned-prerelease", "platform": "Windows x64",
              "source_revision": revision(), "exe_sha256": digest(package / "Quanta.exe"),
              "tests_run": tests["tests_run"], "tests_skipped": tests["skipped"], "smoke": smoke,
              "authenticode_signed": False, "public_release_ready": False,
              "remaining": ["Publisher code signing and signature verification",
                            "Independent clean Windows device and physical tray click acceptance",
                            "Native macOS rebuild and runtime acceptance for the integrated source"],
              "macos_runtime_verified": False}
    (package / "RELEASE-STATUS.json").write_text(json.dumps(status, indent=2), encoding="utf-8")
    names = sorted(p.relative_to(package).as_posix() for p in package.rglob("*") if p.is_file())
    (package / "SHA256SUMS").write_text("".join(digest(package / n) + "  " + n + "\n" for n in names), encoding="utf-8")
    archive = output / (package.name + ".zip")
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(package.rglob("*")):
            if path.is_file():
                z.write(path, package.name + "/" + path.relative_to(package).as_posix())
    with zipfile.ZipFile(archive) as z:
        for name in z.namelist():
            relative = name.split("/", 1)[1]
            if z.read(name) != (package / relative).read_bytes():
                raise RuntimeError("ZIP verification failed")
    (output / (archive.name + ".sha256")).write_text(digest(archive) + "  " + archive.name + "\n", encoding="ascii")
    print(f"Unsigned release candidate verified: {archive}")
    return package


if __name__ == "__main__":
    sys.path.insert(0, str(ROOT))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, default=ROOT / "dist")
    parser.add_argument("--evidence", type=Path, default=ROOT / "work/evidence")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    build(args.dist.resolve(), args.evidence.resolve(), args.output.resolve())
