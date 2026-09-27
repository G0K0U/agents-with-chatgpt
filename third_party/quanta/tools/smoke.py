"""Isolated offline EXE acceptance; never stops pre-existing applications."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent


def stop_owned(proc):
    if proc.poll() is None:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                       capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
        proc.wait(timeout=10)


def run(exe, output):
    output.mkdir(parents=True, exist_ok=True)
    data = Path(tempfile.mkdtemp(prefix="quanta-smoke-", dir=output))
    # Keep the bootloader extraction path short, like a normal user TEMP.
    # Nesting it under a long repository path can exceed Windows MAX_PATH
    # before the app starts. App data/evidence remain isolated under output.
    extraction = Path(tempfile.mkdtemp(prefix="quanta-extract-"))
    env = dict(os.environ, AIBAR_DATA_DIR=str(data), TEMP=str(extraction), TMP=str(extraction))
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    token = secrets.token_hex(24)
    config = {"machine_name": "smoke-fixture", "server": {"host": "127.0.0.1",
              "port": port, "token": token}, "peers": [], "watchdog_seconds": 60,
              "hidden_sources": ["codex", "glm", "deepseek", "muse", "antigravity"]}
    (data / "config.json").write_text(json.dumps(config), encoding="utf-8")
    config_hash = hashlib.sha256((data / "config.json").read_bytes()).hexdigest()
    results, owned = [], []

    def record(name, ok, detail=""):
        results.append({"name": name, "ok": bool(ok), "detail": detail})
        print(("PASS " if ok else "FAIL ") + name + (": " + detail if detail else ""), flush=True)

    def spawn(*args):
        p = subprocess.Popen([str(exe), *args], cwd=ROOT, env=env,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW)
        owned.append(p)
        return p

    from aibar.http_client import official_opener
    opener = official_opener()

    def status(value=None):
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/usage",
                                     headers={"X-Token": value} if value else {})
        try:
            with opener.open(req, timeout=2) as response:
                return response.status
        except urllib.error.HTTPError as exc:
            return exc.code
        except OSError:
            return None

    try:
        first = spawn()
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline and first.poll() is None and status(token) != 200:
            time.sleep(0.3)
        record("normal EXE startup", first.poll() is None and status(token) == 200)
        codes = (status(), status("wrong-token"), status(token))
        record("API authentication", codes == (401, 401, 200), str(codes))
        second = spawn()
        try:
            second.wait(timeout=20)
            record("second instance exits", second.returncode == 0 and first.poll() is None and status(token) == 200)
        except subprocess.TimeoutExpired:
            record("second instance exits", False, "timeout")
            stop_owned(second)
        for mode in ("flyout", "panel"):
            process = spawn("--" + mode + "-test")
            try:
                process.wait(timeout=25)
                path = data / (mode + "-smoke.json")
                report = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
                record(mode + " actual rendering and lifecycle", process.returncode == 0 and report.get("ok"),
                       json.dumps(report, ensure_ascii=True))
            except subprocess.TimeoutExpired:
                record(mode + " actual rendering and lifecycle", False, "timeout is a failure")
                stop_owned(process)
        deadline = time.monotonic() + 65
        while time.monotonic() < deadline and not (data / "watchdog.json").exists() and first.poll() is None:
            time.sleep(0.5)
        path = data / "watchdog.json"
        report = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        record("fresh watchdog health", report.get("server_ok") and not report.get("healed"))
        record("configuration preserved", config_hash == hashlib.sha256((data / "config.json").read_bytes()).hexdigest())
        record("no main or Tk callback errors", not any((data / name).exists()
               for name in ("main-error.log", "flyout-error.log", "flyout-tk.log", "flyout-dispatch.log")))
    finally:
        cleanup_errors = []
        for proc in reversed(owned):
            try:
                stop_owned(proc)
            except (OSError, subprocess.TimeoutExpired) as exc:
                cleanup_errors.append(type(exc).__name__)
        (data / "config.json").unlink(missing_ok=True)
        if cleanup_errors:
            record("owned process cleanup", False, ", ".join(cleanup_errors))
        (output / "smoke-results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
        (output / "smoke-exe.sha256").write_text(hashlib.sha256(exe.read_bytes()).hexdigest(), encoding="ascii")
    return 0 if results and all(row["ok"] for row in results) else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exe", type=Path, default=ROOT / "dist/Quanta.exe")
    parser.add_argument("--output", type=Path, default=ROOT / "work/smoke")
    args = parser.parse_args()
    import sys
    sys.path.insert(0, str(ROOT))
    raise SystemExit(run(args.exe.resolve(), args.output.resolve()))
