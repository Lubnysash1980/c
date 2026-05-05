#!/data/data/com.termux/files/usr/bin/bash
set -e
pkg install -y python redis >/dev/null 2>&1 || true
if [ ! -d ".venv" ]; then python -m venv .venv; fi
source .venv/bin/activate
pip install --upgrade pip >/dev/null 2>&1
pip install -r requirements.txt >/dev/null 2>&1
[ -f ".env" ] || cp .env.example .env
python - <<'PY'
import secrets
p=".env"
s=open(p,"r",encoding="utf-8").read()
s=s.replace("CHANGE_ME_64B", secrets.token_urlsafe(64))
open(p,"w",encoding="utf-8").write(s)
print("[*] SECRET generated in .env")
PY
echo "[✓] Installed."
