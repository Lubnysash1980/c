#!/data/data/com.termux/files/usr/bin/bash
set -e
cd $HOME
SRC_DIR="$HOME/cybra_cloud_full_src"
mkdir -p "$SRC_DIR"
cp -r /mnt/data/cybra_cloud_full/* "$SRC_DIR"/
cd "$SRC_DIR"
bash install.sh
bash start.sh

echo "--------------------------------------------------------"
echo "🔐 Optional: Publish to GitHub releases (requires gh auth login)"
echo "   gh release create v3.6 cybra_cloud_full.zip --title 'Cybra Cloud Full v3.6' --notes 'Auto bundle'"
echo "--------------------------------------------------------"
