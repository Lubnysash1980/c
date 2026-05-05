#!/data/data/com.termux/files/usr/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
nohup python3 module_manager.py > terminal.log 2>&1 &
echo "Started module_manager.py (logs -> terminal.log)"
nohup python3 optimizer.py > optimizer.log 2>&1 &
echo "Started optimizer in background (optimizer.log)"
