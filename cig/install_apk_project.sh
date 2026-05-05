#!/data/data/com.termux/files/usr/bin/bash
# If you copied nfc_bridge_android.zip to Termux home, this will unzip it to ./android_project
if [ -f nfc_bridge_android.zip ]; then
    mkdir -p android_project
    unzip -o nfc_bridge_android.zip -d android_project
    echo 'Android project unpacked to android_project/ - build locally or push to GitHub'
else
    echo 'Place nfc_bridge_android.zip in this folder first.'
fi
