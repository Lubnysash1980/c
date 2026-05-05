#!/data/data/com.termux/files/usr/bin/bash
# Termux installer script - best-effort. Run inside Termux.
set -e
echo '[*] Updating packages...'
pkg update -y
pkg upgrade -y
echo '[*] Installing essentials...'
pkg install -y python git clang make openssh
pip install --upgrade pip
echo '[*] Installing python requirements...'
pip install -r requirements.txt || true
echo '[*] Done. To run: ./run.sh'
