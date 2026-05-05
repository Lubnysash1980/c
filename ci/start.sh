#!/data/data/com.termux/files/usr/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
nohup python3 web/cybrahab.py > cybrahab.log 2>&1 &
sleep 1
nohup python3 module_fetcher.py > fetcher.log 2>&1 &
sleep 1
nohup python3 module_manager.py > manager.log 2>&1 &
sleep 1
nohup python3 nano_watch.py > nano_watch.log 2>&1 &
echo 'Services started. Check logs in current folder.'
