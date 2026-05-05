#!/data/data/com.termux/files/usr/bin/bash
set -e
echo "=========================================================="
echo "🤖  CYBRA CLOUD FULL — INSTALL"
echo "=========================================================="
BASE="$HOME/cybra_cloud_full"
mkdir -p "$BASE"/{logs,runtime/redis,public/invoices}
cp -n /mnt/data/cybra_cloud_full/.env "$BASE/.env" 2>/dev/null || true

# Packages
pkg update -y && pkg upgrade -y
pkg install -y python redis git curl wget unzip clang cmake gh

# Python venv
cd "$BASE"
if [ ! -d ".venv" ]; then
  echo "[*] 🧩 Creating venv..."
  python -m venv .venv
fi
source .venv/bin/activate
python -m pip install --upgrade pip >/dev/null 2>&1
python -m pip install --no-cache-dir fastapi uvicorn redis apscheduler pydantic psutil python-dotenv reportlab qrcode aiofiles >/dev/null 2>&1

# Redis
if ! pgrep -f redis-server >/dev/null 2>&1; then
  echo "[*] 🧠 Starting Redis..."
  redis-server --dir "$BASE/runtime/redis" --daemonize yes
fi

python scripts/healthcheck.py || true
echo "[OK] ✅ Install complete"
