from flask import Flask, request, jsonify
import sqlite3, os, time, hmac, hashlib, jwt
from functools import wraps

SECRET = os.environ.get('RCS_SECRET','change_this_secret')
JWT_SECRET = os.environ.get('RCS_JWT','change_jwt')
DB_PATH = os.environ.get('RCS_DB','rcs.db')
app = Flask(__name__)
# --- simplified DB & endpoints omitted for brevity ---
if __name__=='__main__':
    app.run(host='0.0.0.0', port=5600)
