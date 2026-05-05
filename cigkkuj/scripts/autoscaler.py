import os, time, subprocess, redis, psutil
from dotenv import load_dotenv
load_dotenv(os.path.expanduser("~/cybra_cloud_full/.env"))

MAX_WORKERS = int(os.getenv("CYBRA_MAX_WORKERS", "1000"))
MIN_WORKERS = int(os.getenv("CYBRA_MIN_WORKERS", "2"))
STEP       = int(os.getenv("CYBRA_SCALE_STEP", "25"))
Q          = os.getenv("CYBRA_QUEUE", "cybra:queue")
BASE       = os.path.expanduser("~/cybra_cloud_full")
r = redis.Redis(host=os.getenv("REDIS_HOST","127.0.0.1"),
                port=int(os.getenv("REDIS_PORT","6379")), decode_responses=True)

def current_workers():
    try:
        out = subprocess.getoutput("pgrep -af 'python workers/worker.py' | wc -l")
        return int(out.strip())
    except:
        return 0

def spawn(n):
    base = current_workers()
    for i in range(1, n+1):
        slot = base + i
        if slot > MAX_WORKERS: break
        subprocess.Popen(["bash","-lc",f"nohup python workers/worker.py --slot={slot} > logs/worker_{slot}.out 2>&1 &"],
                         cwd=BASE)

while True:
    try:
        llen = r.llen(Q)
        cw = current_workers()
        target = max(MIN_WORKERS, min(MAX_WORKERS, (llen // 5) + MIN_WORKERS))
        if target > cw:
            spawn(min(STEP, target - cw))
    except Exception as e:
        print("[ASC] error:", e)
    time.sleep(3)
