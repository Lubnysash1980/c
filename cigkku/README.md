# Cyber Parliament — KyberPay Approval Platform (Full Project)

This project provides a **from-scratch** implementation of a Cyber Parliament for approving payments up to **1,000,000 UAH**, generating **QR codes**, and producing **PDF receipts** once paid.

## Features
- Parliament proposals (create → vote → auto-finalize on quorum)
- Amount guard: 1..1,000,000 UAH
- Redis-backed sessions with TTL
- QR PNG generation
- PDF receipts on payment
- Optional device binding (device_hash)
- Minimal Admin UI (HTML) to create proposals, vote, and preview QR
- Telegram notification hooks (optional)

## Quickstart (Termux / Linux)
```bash
cd backend
bash install.sh
redis-server --daemonize yes || true
source .venv/bin/activate
python app.py   # http://127.0.0.1:8093
```

Open the **Admin UI** by double-clicking `frontend/index.html`. Configure backend URL on the page (defaults to `http://127.0.0.1:8093`).

## Env (.env in backend/)
- SECRET — generated automatically on install
- PARLIAMENT_MEMBERS — CSV of member ids (e.g., alice,bob,charlie)
- PARLIAMENT_QUORUM — required YES votes to approve
- QR_TTL_MIN — QR validity minutes
- ALLOWED_DEVICES — CSV of device_hash allowed (optional)
- TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID — optional notifications
