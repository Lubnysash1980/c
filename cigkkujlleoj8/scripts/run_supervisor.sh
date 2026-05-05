#!/bin/bash
set -euo pipefail
BASE_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$BASE_DIR"/venv/bin/activate || true
python3 "$BASE_DIR/core/supervisor.py"
