from fastapi import FastAPI
from pydantic import BaseModel
from dotenv import load_dotenv
import os, redis, json, time

load_dotenv(os.path.expanduser("~/cybra_cloud_full/.env"))
app = FastAPI(title="Cybra Parliament", version="1.0")

r = redis.Redis(host=os.getenv("REDIS_HOST","127.0.0.1"),
                port=int(os.getenv("REDIS_PORT","6379")), decode_responses=True)
Q = os.getenv("CYBRA_QUEUE","cybra:queue")

class Task(BaseModel):
    kind: str       # e.g. "create_exchange", "check_payment", "optimize_taxi"
    payload: dict | None = None

@app.get("/health")
def health():
    return {"ok": True, "role": "parliament"}

@app.post("/task")
def assign(t: Task):
    r.lpush(Q, json.dumps({"t":"parliament_task","task":t.dict(),"ts":time.time()}))
    return {"ok": True, "queued": t}
