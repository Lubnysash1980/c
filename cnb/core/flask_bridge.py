#!/usr/bin/env python3
"""Flask bridge with API for web panel, JWT+HTTPS, live logs (polling), process status via psutil."""
import os, json, time, ssl, subprocess
from flask import Flask, jsonify, request, send_from_directory, abort
import jwt
import psutil

BASE = os.path.dirname(os.path.dirname(__file__))
CONFIG_PATH = os.path.join(BASE, 'data', 'config.json')
os.makedirs(os.path.join(BASE,'data','logs'), exist_ok=True)
# load config
try:
    cfg = json.load(open(CONFIG_PATH))
except Exception:
    cfg = {'api_port':8443, 'auth_token':'cybra-secret-token','jwt_secret':'cybra-jwt-secret','use_https':False,'certfile':'data/certs/cert.pem','keyfile':'data/certs/key.pem'}
JWT_SECRET = cfg.get('jwt_secret', cfg.get('auth_token'))
JWT_ALGO = cfg.get('jwt_algo','HS256')

app = Flask(__name__, static_folder=os.path.join(BASE,'frontend'))

def generate_token(payload=None, exp=3600):
    payload = payload or {}
    payload['exp'] = int(time.time()) + int(exp)
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)

def verify_token(token):
    try:
        jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
        return True
    except Exception as e:
        return False

def require_auth(f):
    def wrapper(*args, **kwargs):
        auth = request.headers.get('Authorization','') or request.args.get('token','')
        if auth.startswith('Bearer '):
            token = auth.split(' ',1)[1]
        else:
            token = auth
        if not verify_token(token):
            abort(401)
        return f(*args, **kwargs)
    wrapper.__name__ = f.__name__
    return wrapper

@app.route('/panel')
def panel_index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/static/<path:p>')
def static_files(p):
    return send_from_directory(app.static_folder, p)

@app.route('/api/token', methods=['POST'])
def api_token():
    data = request.get_json() or {}
    key = data.get('key') or request.args.get('key')
    if not key or key != cfg.get('auth_token'):
        return jsonify({'ok':False}), 401
    t = generate_token({'user':'owner'}, exp=24*3600)
    if isinstance(t, bytes):
        t = t.decode('utf-8')
    return jsonify({'ok':True,'token':t})

@app.route('/api/status')
@require_auth
def api_status():
    procs = []
    for p in psutil.process_iter(['pid','name','cpu_percent','memory_percent']):
        procs.append(p.info)
    return jsonify({'ok':True,'processes':procs})

@app.route('/api/logs')
@require_auth
def api_logs():
    logdir = os.path.join(BASE,'data','logs')
    files = [f for f in os.listdir(logdir) if f.endswith('.log')]
    return jsonify({'ok':True,'logs':files})

@app.route('/api/logtail')
@require_auth
def api_logtail():
    fname = request.args.get('file')
    lines = int(request.args.get('lines',50))
    if not fname:
        return jsonify({'ok':False,'reason':'file required'}),400
    path = os.path.join(BASE,'data','logs', fname)
    if not os.path.exists(path):
        return jsonify({'ok':False,'reason':'not found'}),404
    with open(path,'rb') as f:
        try:
            f.seek(0,2)
            size = f.tell()
            block = 1024
            data = b''
            while size>0 and data.count(b'\n') <= lines:
                if size-block>0:
                    f.seek(size-block)
                else:
                    f.seek(0)
                data = f.read() + data
                size -= block
            text = b'\n'.join(data.splitlines()[-lines:]).decode('utf-8',errors='replace')
        except Exception as e:
            text = ''
    return jsonify({'ok':True,'tail':text})

@app.route('/api/start_module', methods=['POST'])
@require_auth
def api_start_module():
    data = request.get_json() or {}
    name = data.get('name')
    if not name:
        return jsonify({'ok':False,'reason':'name required'}),400
    path = os.path.join(BASE,'modules_active', name + '.py')
    if not os.path.exists(path):
        return jsonify({'ok':False,'reason':'module not found'}),404
    logfile = os.path.join(BASE,'data','logs', name + '.log')
    p = subprocess.Popen(['python3', path], stdout=open(logfile,'a'), stderr=open(logfile,'a'), preexec_fn=os.setsid)
    return jsonify({'ok':True,'pid':p.pid})

@app.route('/api/stop_module', methods=['POST'])
@require_auth
def api_stop_module():
    data = request.get_json() or {}
    pid = int(data.get('pid',0))
    if not pid:
        return jsonify({'ok':False,'reason':'pid required'}),400
    try:
        os.kill(pid, 15)
        return jsonify({'ok':True})
    except Exception as e:
        return jsonify({'ok':False,'reason':str(e)}),500

if __name__=='__main__':
    port = int(cfg.get('api_port',8443))
    use_https = cfg.get('use_https', False)
    cert = cfg.get('certfile')
    key = cfg.get('keyfile')
    print('Starting Flask web panel on port', port, 'HTTPS=', use_https)
    if use_https and cert and key and os.path.exists(cert) and os.path.exists(key):
        context = (cert,key)
        app.run(host='0.0.0.0', port=port, ssl_context=context)
    else:
        app.run(host='0.0.0.0', port=port)
