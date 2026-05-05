from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import time

app = FastAPI(title="CYBRA-DEX API", version="1.0")

class Order(BaseModel):
    side: str   # buy/sell
    symbol: str # CYB/USDT etc.
    qty: float
    leverage: int = 1

@app.get("/health")
def health():
    return {"ok": True, "engine": "mock-matching", "ts": time.time()}

@app.post("/order")
def place(o: Order):
    if o.leverage < 1 or o.leverage > 300:
        raise HTTPException(400, "leverage out of bounds (1..300)")
    return {"ok": True, "order_id": f"DEX-{int(time.time()*1000)}", "accepted": o}
