#!/data/data/com.termux/files/usr/bin/bash
set -e
BASE="$HOME/cybra_cloud_full"
cd "$BASE"
source .venv/bin/activate
export $(grep -v '^#' .env | xargs -d '\n' -I{} echo {})
LOG="logs/sv.loop.log"
echo "[*] 🛰 Supervisor loop..." >> "$LOG"
while true; do
  curl -s "http://127.0.0.1:${API_PORT:-8088}/health" | grep -q '"ok": true' || nohup uvicorn app.main:app --host 0.0.0.0 --port ${API_PORT:-8088} --log-level info >> logs/api.out 2>&1 &
  curl -s "http://127.0.0.1:${PARLIAMENT_PORT:-8092}/health" | grep -q '"ok": true' || nohup uvicorn app.parliament:app --host 0.0.0.0 --port ${PARLIAMENT_PORT:-8092} --log-level info >> logs/parliament.out 2>&1 &
  curl -s "http://127.0.0.1:${DEX_PORT:-8094}/health" | grep -q '"ok": true' || nohup uvicorn app.dex:app --host 0.0.0.0 --port ${DEX_PORT:-8094} --log-level info >> logs/dex.out 2>&1 &
  curl -s "http://127.0.0.1:${BIO_PORT:-8098}/health" | grep -q '"ok": true' || nohup uvicorn app.bio:app --host 0.0.0.0 --port ${BIO_PORT:-8098} --log-level info >> logs/bio.out 2>&1 &
  if ! pgrep -f "python scripts/autoscaler.py" >/dev/null; then
    nohup python scripts/autoscaler.py >> logs/autoscaler.out 2>&1 &
  fi
  if ! pgrep -f redis-server >/dev/null; then
    redis-server --dir "$BASE/runtime/redis" --daemonize yes
  fi
  sleep 8
done
