#!/bin/bash
# Скрипт для Termux: встановлення та запуск Cybra Web Panel

ARCHIVE="cybra_hyperplatform_webpanel.zip"
TARGET="cybra_webpanel"

echo "[*] Розпаковка архіву..."
unzip -o $ARCHIVE -d $TARGET

cd $TARGET || { echo "Не можу перейти в $TARGET"; exit 1; }

echo "[*] Створення віртуального середовища..."
python3 -m venv venv
. venv/bin/activate

echo "[*] Встановлення залежностей..."
pip install --upgrade pip
pip install flask psutil pyjwt

# Генерація HTTPS сертифікатів
mkdir -p data/certs
CERT=data/certs/cert.pem
KEY=data/certs/key.pem
if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  echo "[*] Генерація самопідписаних сертифікатів..."
  openssl req -x509 -nodes -days 365 -newkey rsa:2048     -keyout "$KEY" -out "$CERT"     -subj "/C=UA/ST=Kyiv/L=Kyiv/O=Cybra/CN=localhost"
fi

# Увімкнення HTTPS у конфігу
CONFIG=data/config.json
python3 - <<EOF
import json
cfg=json.load(open("$CONFIG"))
cfg['use_https']=True
json.dump(cfg, open("$CONFIG","w"), indent=2)
EOF

echo "[*] Запуск Web Panel..."
python3 core/flask_bridge.py
