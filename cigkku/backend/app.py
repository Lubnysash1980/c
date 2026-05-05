#!/usr/bin/env python3
import os, json, hmac, hashlib, time, uuid, base64, io, asyncio
from datetime import datetime, timedelta
from typing import Optional
from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import JSONResponse, HTMLResponse
from pydantic import BaseModel, Field
from dotenv import load_dotenv
import redis as redis_lib
import httpx, qrcode
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4

load_dotenv()
SECRET = os.getenv("SECRET","CHANGE").encode()
HOST = os.getenv("HOST","0.0.0.0")
PORT = int(os.getenv("PORT","8093"))
REDIS_HOST = os.getenv("REDIS_HOST","127.0.0.1")
REDIS_PORT = int(os.getenv("REDIS_PORT","6379"))
REDIS_DB = int(os.getenv("REDIS_DB","0"))
QR_TTL_MIN = int(os.getenv("QR_TTL_MIN","10"))
MEMBERS = [m.strip() for m in (os.getenv("PARLIAMENT_MEMBERS","") or "").split(",") if m.strip()]
QUORUM = int(os.getenv("PARLIAMENT_QUORUM","1"))
ALLOWED_DEVICES = set([s.strip() for s in (os.getenv("ALLOWED_DEVICES","") or "").split(",") if s.strip()])
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN","")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID","")

QRS_DIR = "qrs"; INV_DIR = "invoices"
os.makedirs(QRS_DIR, exist_ok=True); os.makedirs(INV_DIR, exist_ok=True)
r = redis_lib.Redis(host=REDIS_HOST, port=REDIS_PORT, db=REDIS_DB, decode_responses=True)
app = FastAPI(title="Cyber Parliament — KyberPay", version="1.0")

def b64url(d: bytes) -> str:
    return base64.urlsafe_b64encode(d).rstrip(b"=").decode()
def sign_token(payload: dict) -> str:
    hb=b64url(json.dumps({"alg":"HS256","typ":"JWT"}).encode())
    pb=b64url(json.dumps(payload,separators=(',',':')).encode())
    sig=hmac.new(SECRET,f"{hb}.{pb}".encode(),hashlib.sha256).digest()
    return f"{hb}.{pb}.{b64url(sig)}"
def verify_token(token: str) -> dict:
    hb,pb,sb=token.split(".")
    exp=hmac.new(SECRET,f"{hb}.{pb}".encode(),hashlib.sha256).digest()
    if not hmac.compare_digest(exp, base64.urlsafe_b64decode(sb+"==")): raise HTTPException(401,"Bad signature")
    p=json.loads(base64.urlsafe_b64decode(pb+"=="))
    if int(time.time())>int(p.get("exp",0)): raise HTTPException(401,"Expired")
    return p
def sess_key(s): return f"sess:{s}"
def prop_key(pid): return f"prop:{pid}"
def qr_png(url: str, sess: str, amount: int) -> bytes:
    qr=qrcode.QRCode(box_size=10,border=2); qr.add_data(url); qr.make(fit=True)
    img=qr.make_image(fill_color="black", back_color="white").convert("RGB")
    W=img.size[0]+80; H=img.size[1]+160
    c=Image.new("RGB",(W,H),"white"); d=ImageDraw.Draw(c); f=ImageFont.load_default()
    d.text((40,18),"CYBRA - KyberPay (Parliament)", fill="black", font=f)
    d.text((40,36),f"ID: {sess}", fill="black", font=f)
    qx=(W-img.size[0])//2; qy=58; c.paste(img,(qx,qy))
    d.text((40,qy+img.size[1]+8), f"Amount: {amount} UAH", fill="black", font=f)
    d.text((40,qy+img.size[1]+26), f"Valid {QR_TTL_MIN} min", fill="black", font=f)
    b=io.BytesIO(); c.save(b,"PNG"); return b.getvalue()
def pdf_receipt(sess: str, amount: int, paid_at: str, token: str):
    p=os.path.join(INV_DIR,f"{sess}_receipt.pdf"); canv=canvas.Canvas(p,pagesize=A4); w,h=A4
    canv.setTitle(f"KyberPay Receipt {sess}")
    canv.setFont("Helvetica-Bold",16); canv.drawString(50,h-60,"CYBRA — KyberPay Receipt")
    canv.setFont("Helvetica",11); canv.drawString(50,h-90,f"Session: {sess}")
    canv.drawString(50,h-110,f"Amount: {amount} UAH"); canv.drawString(50,h-130,f"Paid at: {paid_at}")
    import qrcode, tempfile; tmp=tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    q=qrcode.QRCode(box_size=4,border=1); q.add_data(token); q.make(fit=True); q.make_image(fill_color="black", back_color="white").save(tmp.name)
    canv.drawImage(tmp.name, w-180, h-220, width=120, height=120); canv.showPage(); canv.save(); return p
async def tg_ping(text: str):
    if not (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID): return
    try:
        async with httpx.AsyncClient(timeout=10) as cli:
            await cli.post(f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage", json={"chat_id":TELEGRAM_CHAT_ID,"text":text})
    except Exception: pass

class ProposalCreate(BaseModel):
    amount: int = Field(..., ge=1, le=1_000_000)
    memo: str = Field("", max_length=200)
    device_hash: Optional[str] = None
class VoteReq(BaseModel):
    proposal_id: str; member: str; vote: bool
class PayReq(BaseModel):
    token: str; device_hash: Optional[str] = None

@app.get("/healthz")
def healthz(): return {"ok":True,"members":MEMBERS,"quorum":QUORUM}

@app.post("/parliament/proposal")
async def create_proposal(req: ProposalCreate):
    if req.device_hash and ALLOWED_DEVICES and req.device_hash not in ALLOWED_DEVICES: raise HTTPException(403,"device not approved")
    pid=f"P{uuid.uuid4().hex[:10]}"
    r.hset(prop_key(pid), mapping={"proposal_id":pid,"amount":str(int(req.amount)),"memo":req.memo,"device_hash":req.device_hash or "","status":"open","created_at":datetime.utcnow().isoformat(),"votes_yes":"[]","votes_no":"[]"})
    await tg_ping(f"📝 New proposal {pid} • {req.amount} UAH • {req.memo}")
    return {"proposal_id":pid,"status":"open"}

@app.get("/parliament/proposal/{pid}")
def get_proposal(pid: str):
    data=r.hgetall(prop_key(pid)); 
    if not data: raise HTTPException(404,"not found")
    data["votes_yes"]=json.loads(data.get("votes_yes","[]")); data["votes_no"]=json.loads(data.get("votes_no","[]"))
    return data

@app.post("/parliament/vote")
async def vote(req: VoteReq):
    if req.member not in MEMBERS: raise HTTPException(403,"not a member")
    k=prop_key(req.proposal_id); data=r.hgetall(k)
    if not data: raise HTTPException(404,"proposal not found")
    if data.get("status")!="open": raise HTTPException(409,"proposal not open")
    vyes=set(json.loads(data.get("votes_yes","[]"))); vno=set(json.loads(data.get("votes_no","[]")))
    vyes.discard(req.member); vno.discard(req.member); (vyes if req.vote else vno).add(req.member)
    r.hset(k, mapping={"votes_yes":json.dumps(list(vyes)),"votes_no":json.dumps(list(vno))})
    if len(vyes)>=QUORUM:
        amount=int(data.get("amount","0")); devh=data.get("device_hash") or ""
        ts=datetime.utcnow().strftime("%Y%m%d_%H%M%S"); sess=f"QR_{ts}_{uuid.uuid4().hex[:8]}"
        now=int(time.time()); exp=now+QR_TTL_MIN*60; payload={"v":1,"session":sess,"amount_uah":amount,"iat":now,"exp":exp}
        if devh: payload["device_hash"]=devh
        token=sign_token(payload); url=f"/demo?token={token}"
        r.hset(sess_key(sess), mapping={"status":"active","amount":str(amount),"token":token,"exp":str(exp),"created_at":datetime.utcnow().isoformat(),"device_hash":devh})
        r.expire(sess_key(sess), QR_TTL_MIN*60)
        with open(os.path.join(QRS_DIR, f"{sess}.png"),"wb") as f: f.write(qr_png(url,sess,amount))
        r.hset(k, mapping={"status":"approved","session":sess})
        await tg_ping(f"✅ Proposal {req.proposal_id} APPROVED • Session {sess} • {amount} UAH")
        return {"ok":True,"finalized":True,"session":sess,"amount":amount}
    await tg_ping(f"🗳 Vote on {req.proposal_id}: {req.member} → {'YES' if req.vote else 'NO'}")
    return {"ok":True,"finalized":False}

@app.get("/qr/{session}/png")
def qr_png_endpoint(session: str):
    p=os.path.join(QRS_DIR,f"{session}.png"); s=r.hgetall(sess_key(session))
    if not s or not os.path.exists(p): raise HTTPException(404,"not found")
    return Response(content=open(p,"rb").read(), media_type="image/png")

@app.post("/pay/{session}")
async def pay(session: str, req: PayReq):
    s=r.hgetall(sess_key(session))
    if not s: raise HTTPException(404,"not found")
    if s.get("status") in ("used","blocked"): raise HTTPException(409,"already finalized")
    payload=verify_token(req.token)
    if payload.get("session")!=session: raise HTTPException(400,"session mismatch")
    if s.get("device_hash") and req.device_hash and s.get("device_hash")!=req.device_hash: raise HTTPException(401,"wrong device")
    paid_at=datetime.utcnow().isoformat(); r.hset(sess_key(session), mapping={"status":"used","paid_at":paid_at})
    pdf=pdf_receipt(session,int(s.get("amount","0")),paid_at,s.get("token"))
    await tg_ping(f"💸 Paid: {session} • {s.get('amount')} UAH")
    return {"ok":True,"session":session,"amount":s.get("amount"),"receipt_pdf":pdf}

@app.post("/parliament/block/{session}")
async def block_session(session: str):
    if not r.hgetall(sess_key(session)): raise HTTPException(404,"not found")
    r.hset(sess_key(session), mapping={"status":"blocked","blocked_at":datetime.utcnow().isoformat()})
    await tg_ping(f"⛔ Blocked: {session}")
    return {"ok":True}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT)
