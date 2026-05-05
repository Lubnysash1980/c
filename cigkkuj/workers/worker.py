import redis, time, json, sys, os
from dotenv import load_dotenv
load_dotenv(os.path.expanduser("~/cybra_cloud_full/.env"))
slot = next((a.split("=")[-1] for a in sys.argv if a.startswith("--slot=")), "0")
r = redis.Redis(host=os.getenv("REDIS_HOST","127.0.0.1"),
                port=int(os.getenv("REDIS_PORT","6379")), decode_responses=True)
Q = os.getenv("CYBRA_QUEUE","cybra:queue")
print(f"[+] Worker {slot} started")

while True:
    try:
        item = r.brpop(Q, timeout=5)
        if not item: time.sleep(0.2); continue
        _, data = item
        obj = json.loads(data)
        t = obj.get("t")
        if t == "click":
            d = obj["data"]
            print(f"[{slot}] click: {d}")
        elif t == "pay":
            d = obj["data"]
            print(f"[{slot}] pay: #{d['order_id']} {d['amount']} {d['currency']} via {d['method']}")
        elif t == "parliament_task":
            print(f"[{slot}] parliament task -> {obj.get('task')}")
        else:
            print(f"[{slot}] unknown: {obj}")
    except Exception as e:
        print(f"[{slot}] ❌", e)
        time.sleep(0.5)
