from fastapi import FastAPI, Header, HTTPException
import os
from dotenv import load_dotenv

load_dotenv(os.path.expanduser("~/cybra_cloud_full/.env"))
app = FastAPI(title="Cybra Bio-Portal", version="1.0")
MASTER = os.getenv("BIOMETRIC_MASTER_TOKEN","__SET_YOUR_BIOMETRIC_TOKEN__")

@app.get("/health")
def health():
    return {"ok": True, "bio": True}

@app.get("/portal")
def portal(biometric_token: str = Header(None)):
    if biometric_token != MASTER:
        raise HTTPException(401, "biometric_token invalid")
    return {"ok": True, "portal": "granted", "roles": ["owner","parliament","dex-admin"]}
