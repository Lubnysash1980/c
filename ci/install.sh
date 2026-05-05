#!/data/data/com.termux/files/usr/bin/bash
set -e
echo '[*] Installing dependencies (best-effort)'
pkg update -y || true
pkg install -y python git -y || true
python -m ensurepip || true
pip install --upgrade pip || true
if [ -f requirements.txt ]; then
    pip install -r requirements.txt || true
fi
echo '[*] Done. Run ./start.sh to launch services.'
