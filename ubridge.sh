#!/data/data/com.termux/files/usr/bin/bash
# Thin wrapper for Termux convenience
SCRIPT_DIR="$(dirname "$0")"
python3 "$SCRIPT_DIR/universal_bridge.py" "$@"
