#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [ "$(uname -s)" != "Darwin" ]; then
  echo "This installer is for macOS."
  exit 1
fi
python3 -c 'import sys; assert sys.version_info >= (3, 10), "Python 3.10 or newer is required"'
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python install_mac.py
