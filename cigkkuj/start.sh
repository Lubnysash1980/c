#!/data/data/com.termux/files/usr/bin/bash
set -e
BASE="$HOME/cybra_cloud_full"
cd "$BASE"
source .venv/bin/activate
export $(grep -v '^#' .env | xargs -d '\n' -I{} echo {})

# API Core
if ! pgrep -f "uvicorn app.main:app" >/dev/null; then
  nohup uvicorn app.main:app --host 0.0.0.0 --port ${API_PORT:-8088} --log-level info > logs/api.out 2>&1 &
  echo "[+] API :${API_PORT:-8088}"
fi

# Parliament
if ! pgrep -f "uvicorn app.parliament:app" >/dev/null; then
  nohup uvicorn app.parliament:app --host 0.0.0.0 --port ${PARLIAMENT_PORT:-8092} --log-level info > logs/parliament.out 2>&1 &
  echo "[+] Parliament :${PARLIAMENT_PORT:-8092}"
fi

# DEX
if ! pgrep -f "uvicorn app.dex:app" >/dev/null; then
  nohup uvicorn app.dex:app --host 0.0.0.0 --port ${DEX_PORT:-8094} --log-level info > logs/dex.out 2>&1 &
  echo "[+] DEX :${DEX_PORT:-8094}"
fi

# Bio-Portal
if ! pgrep -f "uvicorn app.bio:app" >/dev/null; then
  nohup uvicorn app.bio:app --host 0.0.0.0 --port ${BIO_PORT:-8098} --log-level info > logs/bio.out 2>&1 &
  echo "[+] Bio-Portal :${BIO_PORT:-8098}"
fi

# Autoscaler
if ! pgrep -f "python scripts/autoscaler.py" >/dev/null; then
  nohup python scripts/autoscaler.py > logs/autoscaler.out 2>&1 &
  echo "[+] Autoscaler"
fi

# Supervisor
if ! pgrep -f "bash scripts/supervisor.sh" >/dev/null; then
  nohup bash scripts/supervisor.sh > logs/supervisor.out 2>&1 &
  echo "[+] Supervisor"
fi

python - <<'PY'
print("--------------------------------------------------------")
print("✅ Cybra Cloud Full is UP")
print("• API:        http://127.0.0.1:8088/health")
print("• Parliament: http://127.0.0.1:8092/health")
print("• DEX:        http://127.0.0.1:8094/health")
print("• Bio-Portal: http://127.0.0.1:8098/health")
print("--------------------------------------------------------")
PY
