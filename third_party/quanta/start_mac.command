#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "Run bash install_mac.command first."
  exit 1
fi
exec .venv/bin/python -m aibar.ui_mac
