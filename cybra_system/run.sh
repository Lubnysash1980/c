#!/data/data/com.termux/files/usr/bin/bash
# Start the NFC terminal in background using nohup.
nohup python3 terminal_main.py > terminal.log 2>&1 &
echo "Started terminal_main.py (logs -> terminal.log)"
