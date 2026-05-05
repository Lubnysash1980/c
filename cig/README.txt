Termux NFC Terminal v3 - Quickstart
- Place this folder in Termux home (~/termux_nfc_terminal_v3)
- Run: bash installer.sh
- Then: ./run.sh
- To install Android project, copy nfc_bridge_android.zip here and run ./install_apk_project.sh
- The system will run a module manager with watchdog, an optimizer loop (50 passes), and AI-agent logging.
- Flask endpoint /nfc will receive posts from the Android app.
Notes:
- Real NFC on Android is handled by the APK -> it must point to your Termux device IP.
- This bundle aims to be resilient: modules auto-restart, and ai_agent tries simple autofixes (pip installs).
- Do not store real PAN/CVV unless you are compliant with law & security.
