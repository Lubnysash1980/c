#!/data/data/com.termux/files/usr/bin/bash

echo "🚀 Sync starting..."

git add .

git commit -m "auto sync: $(date '+%Y-%m-%d %H:%M:%S')" || echo "no changes to commit"

git push origin main

echo "✅ Sync done"
