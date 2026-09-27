"""Copy installed upstream license notices without changing their content."""
from importlib import metadata
import hashlib
import json
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parent.parent

def build_distributions():
    """Inventory only locked build dependencies, never unrelated audit tools."""
    result = []
    for line in (ROOT / "requirements-windows-build.txt").read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        name, version = line.split("==")
        dist = metadata.distribution(name)
        if dist.version != version:
            raise RuntimeError(f"Build dependency version mismatch: {name}")
        result.append(dist)
    if not result:
        raise RuntimeError("Build dependency lock is empty")
    return sorted(result, key=lambda d: d.metadata["Name"].lower())


def build():
    target = ROOT / "docs/licenses"
    target.mkdir(parents=True, exist_ok=True)
    components = []
    for dist in build_distributions():
        name, version = dist.metadata["Name"], dist.version
        notice_files = [f for f in dist.files or [] if any(
            word in Path(str(f)).name.lower() for word in ("license", "copying", "notice", "authors"))]
        notices = []
        for f in notice_files:
            source = Path(dist.locate_file(f))
            if not source.is_file():
                continue
            dest = target / f"{name}-{version}" / Path(str(f))
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, dest)
            notices.append(dest.relative_to(ROOT).as_posix())
        if name == "proxy_tools":
            notice = target / "proxy_tools-0.1.0/LICENSE.txt"
            if not notice.is_file():
                raise RuntimeError("Obtain proxy_tools upstream LICENSE.txt first")
            notices = [notice.relative_to(ROOT).as_posix()]
        if not notices:
            raise RuntimeError(f"Missing license for {name}")
        homepage = dist.metadata.get("Home-page") or ""
        components.append({"name": name, "version": version,
                           "package_url": f"pkg:pypi/{name.lower().replace('_', '-')}@{version}",
                           "homepage": homepage, "license_files": notices})
    python_license = Path(sys.base_prefix) / "LICENSE.txt"
    shutil.copyfile(python_license, target / "Python-LICENSE.txt")
    tk_license = Path(sys.base_prefix) / "tcl/tk8.6/license.terms"
    shutil.copyfile(tk_license, target / "Tk-license.terms")
    # Unmodified library source accompanies the LGPL notices and app build source.
    import pystray
    package = Path(pystray.__file__).parent
    for source in package.rglob("*.py"):
        dest = target / "pystray-source" / source.relative_to(package)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, dest)
    record = {"format": "Quanta dependency inventory v1", "python": sys.version.split()[0],
              "scope": "Installed runtime and build packages; pip/setuptools excluded as build installers",
              "components": components,
              "license_file_hashes": {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                                     for p in sorted(target.rglob("*")) if p.is_file()}}
    (ROOT / "docs/DEPENDENCIES.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    frozen = sorted(f"{c['name']}=={c['version']}" for c in components)
    (ROOT / "requirements-windows-build.txt").write_text("\n".join(frozen) + "\n", encoding="utf-8")
    print(f"Collected {len(components)} package notices and {len(record['license_file_hashes'])} files")


if __name__ == "__main__":
    build()
