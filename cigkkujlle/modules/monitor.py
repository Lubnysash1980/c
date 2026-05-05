import time
from pathlib import Path
LOG_DIR = Path('./logs')
LOG_DIR.mkdir(exist_ok=True)
def start_monitor():
    while True:
        with open(LOG_DIR / 'monitor.log', 'a') as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] Monitor active\n")
        time.sleep(10)
if __name__ == '__main__':
    start_monitor()