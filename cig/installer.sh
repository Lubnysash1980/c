#!/data/data/com.termux/files/usr/bin/bash
set -e
echo '[*] Termux NFC Terminal v3 installer - best-effort'
if command -v termux-setup-storage >/dev/null 2>&1; then
    termux-setup-storage || true
fi
pkg update -y || true
pkg upgrade -y || true
pkg install -y python git clang make openssh || true
python -m ensurepip || true
pip install --upgrade pip || true
pip install -r requirements.txt || true
echo '[*] Done. Start with ./run.sh'
echo '[*] Optional: place android APK project zip (nfc_bridge_android.zip) into this folder and run ./install_apk_project.sh to copy it to Termux storage.'
