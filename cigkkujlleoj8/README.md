Cybra HyperPlatform (auto-recovery, hyper-multiprocessing, Termux helper)
------------------------------------------------------------------------
Features:
- Flask-based supervisor with auto-restart on crash.
- Termux-friendly API endpoints for control and status.
- Multiprocessing pool and per-module processes; configurable max workers (supports up to 512).
- SHA-512 integrity checks for modules on start.
- Simple token-based security and permissions endpoint.
- Monitoring + history circular buffer (size 512) for events and decisions.
- Module wrapper that validates, runs module in isolated process group and restarts on failure.
- Log rotation and secure file permissions where appropriate.

Quick start:
1) unzip the package
2) cd cybra_hyperplatform
3) python3 -m venv venv && . venv/bin/activate
4) pip install -r requirements.txt
5) ./scripts/run_supervisor.sh
6) API: http://localhost:7077 (endpoints: /status, /start_module, /stop_module, /grant, /monitor, /health)
