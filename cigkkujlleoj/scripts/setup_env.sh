#!/bin/bash
set -euo pipefail
BASE_DIR=$(cd "$(dirname "$0")/.." && pwd)
python3 -m venv "$BASE_DIR/venv"
. "$BASE_DIR/venv/bin/activate"
pip install -r "$BASE_DIR/requirements.txt"
echo "Environment ready. Use ./scripts/run_supervisor.sh to start."
