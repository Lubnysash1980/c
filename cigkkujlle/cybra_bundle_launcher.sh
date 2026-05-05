#!/bin/bash
TARGET=${1:-$HOME/cybra_runner}
mkdir -p "$TARGET"
unzip -o cybra_full_bundle.zip -d "$TARGET"
cd "$TARGET"
mkdir -p logs checksums modules

# Termux wake lock
if command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock
fi

# Автозапуск через systemd user services
mkdir -p $HOME/.config/systemd/user

create_service() {
    local name="$1"
    local cmd="$2"
    local log="$3"
    local svc_file="$HOME/.config/systemd/user/$name.service"
    cat > "$svc_file" <<EOL
[Unit]
Description=Cybra AI $name
After=network.target

[Service]
Type=simple
ExecStart=/bin/bash -c '$cmd > "$TARGET/logs/$log" 2>&1'
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOL
    systemctl --user daemon-reload
    systemctl --user enable "$name"
    systemctl --user start "$name"
}

create_service "cybra_manager" "python3 $TARGET/modules/monitor.py" "monitor.out"
create_service "cybra_helper" "python3 $TARGET/modules/helper.py" "helper.out"
create_service "cybra_security" "python3 $TARGET/modules/security_check.py" "security.out"

# SHA-512 ротація та авто-перевірка модулів
MAX_SHA=512
while true; do
    for file in $TARGET/modules/*.py; do
        [ -e "$file" ] || continue
        sha_file="$TARGET/checksums/modules/$(basename "$file").sha512"
        new_sha=$(sha512sum "$file" | awk '{print $1}')
        old_sha=$(cat "$sha_file" 2>/dev/null || echo "")
        if [ "$new_sha" != "$old_sha" ]; then
            echo "$(date '+%Y-%m-%d %H:%M:%S') - Модуль $(basename "$file") змінено, перезавантаження..."
            touch "$TARGET/modules_reload_trigger"
            echo "$new_sha" > "$sha_file"
        fi
    done
    files=($(ls -1t $TARGET/checksums/modules/*.sha512 2>/dev/null))
    count=${#files[@]}
    if [ $count -gt $MAX_SHA ]; then
        for ((i=$MAX_SHA;i<$count;i++)); do
            rm -f "${files[$i]}"
        done
    fi
    sleep 10
done &

echo "Cybra full platform with auto-reload modules started"
