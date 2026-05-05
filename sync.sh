#!/data/data/com.termux/files/usr/bin/bash

echo "🚀 Smart sync..."

git add .

if git diff --cached --quiet; then
  echo "⚠️ No changes"
  exit 0
fi

git commit -m "auto sync $(date '+%H:%M:%S')"

git push origin main

echo "✅ Done"
