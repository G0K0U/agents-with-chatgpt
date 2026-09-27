"""Run the full suite with isolated local app data and bind results to sources."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


def run(output):
    sys.path.insert(0, str(ROOT))
    from tools.release import revision, source_files
    work = ROOT / "work"
    work.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="release-tests-", dir=work) as directory:
        os.environ["AIBAR_DATA_DIR"] = directory
        suite = unittest.defaultTestLoader.discover(str(ROOT / "tests"))
        result = unittest.TextTestRunner(verbosity=1).run(suite)
        record = {"source_revision": revision(), "tests_run": result.testsRun,
                  "failures": len(result.failures), "errors": len(result.errors),
                  "skipped": len(result.skipped), "ok": result.wasSuccessful(),
                  "source_hashes": {n: hashlib.sha256((ROOT / n).read_bytes()).hexdigest()
                                    for n in source_files()}}
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(record, indent=2), encoding="utf-8")
        return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "work/test-results.json")
    raise SystemExit(run(parser.parse_args().output.resolve()))
