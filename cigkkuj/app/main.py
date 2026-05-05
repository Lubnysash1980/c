from fastapi import FastAPI, BackgroundTasks
from pydantic import BaseModel
from dotenv import load_dotenv
import os, redis, json, time
from scripts.generate_receipt import generate_receipt

load_dotenv(os.path.expanduser("~/cybra_cloud_full/.env"))
app = FastAPI(title="Cybra Cloud API", version="1.0")
r = redis.Redis(host=os.getenv("REDIS_HOST","127.0.0.1"),
                port=int(os.getenv("REDIS_PORT","6379")), decode_responses=True)
Q = os.getenv("CYBRA_QUEUE","cybra:queue")

class Click(BaseModel):
    user: str
    amount: float
    meta: dict | None = None

class PayIn(BaseModel):
    order_id: str
    amount: float
    currency: str = "UAH"
    method: str = "cybra_pay"
    meta: dict | None = None

@app.get("/health")
def health():
    return {"ok": True, "queue": r.llen(Q)}

@app.post("/queue")
def queue_item(d: Click):
    entry = d.dict()
    r.lpush(Q, json.dumps({"t":"click","data":entry,"ts":time.time()}))
    return {"ok": True, "queued": entry}

@app.post("/pay")
def pay(d: PayIn, bg: BackgroundTasks):
    payload = d.dict()
    r.lpush(Q, json.dumps({"t":"pay","data":payload,"ts":time.time()}))
    bg.add_task(_gen_receipt, payload)
    return {"ok": True, "accepted": payload}

def _gen_receipt(payload):
    try:
        fn = generate_receipt(payload)
        r.set(f"receipt:{payload['order_id']}", fn)
    except Exception as e:
        print("[RCPT] error", e)
