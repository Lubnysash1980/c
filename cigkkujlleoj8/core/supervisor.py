#!/usr/bin/env python3
"""Flask supervisor that manages modules with auto-restart, multiprocessing and security.
Provides Termux-friendly endpoints and supports a hyper worker count up to 512.
"""
import os, sys, time, json, hashlib, signal, threading
from flask import Flask, jsonify, request, abort
from multiprocessing import Process, Manager, current_process
from module_wrapper import ModuleWrapper
from monitor import Monitor
from functools import wraps

BASE = os.path.dirname(os.path.dirname(__file__))
CONFIG_PATH = os.path.join(BASE, 'data', 'config.json')
os.makedirs(os.path.join(BASE,'data','logs'), exist_ok=True)

# Load config
try:
    with open(CONFIG_PATH, 'r') as f:
        CONFIG = json.load(f)
except Exception:
    CONFIG = {'api_port':7077, 'max_workers':16, 'auth_token':'cybra-secret-token', 'history_size':512}

app = Flask(__name__)
manager = Manager()
state = manager.dict()  # shared state across processes
state['modules'] = manager.dict()  # name -> {pids:[],sha512:,status:}
state['history'] = manager.list()  # circular buffer of events
history_lock = threading.Lock()

monitor = Monitor(state, os.path.join(BASE,'data','logs'), CONFIG.get('history_size',512))

# Auth decorator
def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.headers.get('X-Cybra-Token') or request.args.get('token')
        if not token or token != CONFIG.get('auth_token'):
            abort(401)
        return f(*args, **kwargs)
    return decorated

def push_history(item):
    with history_lock:
        history = list(state['history'])
        history.append({'time': time.time(), **item})
        # keep last N items
        maxh = CONFIG.get('history_size',512)
        if len(history) > maxh:
            history = history[-maxh:]
        # replace shared list
        state['history'][:] = history

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'ok': True, 'modules_count': len(state['modules'])})

@app.route('/status', methods=['GET'])
@token_required
def status():
    return jsonify({'modules': dict(state['modules']), 'history_len': len(state['history'])})

@app.route('/grant', methods=['POST'])
def grant():
    # Grant permissions / set token (Termux helper can call)
    data = request.get_json() or {}
    token = data.get('token')
    if token:
        CONFIG['auth_token'] = token
        with open(CONFIG_PATH,'w') as f:
            json.dump(CONFIG,f, indent=2)
        return jsonify({'ok':True})
    return jsonify({'ok':False,'reason':'token required'}),400

@app.route('/start_module', methods=['POST'])
@token_required
def start_module():
    data = request.get_json() or {}
    name = data.get('name')
    count = int(data.get('count',1))
    if not name:
        return jsonify({'ok':False,'reason':'name required'}),400
    # module path
    modpath = os.path.join(BASE,'modules', name + '.py')
    if not os.path.exists(modpath):
        return jsonify({'ok':False,'reason':'module not found'}),404
    # compute sha512
    with open(modpath,'rb') as f:
        sha = hashlib.sha512(f.read()).hexdigest()
    # start count processes (respect max_workers)
    max_workers = int(CONFIG.get('max_workers',16))
    # ensure not exceeding 512
    if max_workers > 512:
        max_workers = 512
    started = []
    for i in range(count):
        mw = ModuleWrapper(modpath, name, sha, state, CONFIG)
        p = mw.start_process()
        started.append(p.pid)
        push_history({'event':'start_module','name':name,'pid':p.pid})
    # register
    state['modules'][name] = {'pids': started, 'sha512': sha, 'status':'running'}
    return jsonify({'ok':True,'pids':started})

@app.route('/stop_module', methods=['POST'])
@token_required
def stop_module():
    data = request.get_json() or {}
    name = data.get('name')
    if not name:
        return jsonify({'ok':False,'reason':'name required'}),400
    if name not in state['modules']:
        return jsonify({'ok':False,'reason':'not running'}),404
    info = state['modules'][name]
    pids = info.get('pids',[])
    import signal, os
    results = []
    for pid in pids:
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
            results.append({'pid':pid,'stopped':True})
        except Exception as e:
            results.append({'pid':pid,'error':str(e)})
    state['modules'].pop(name, None)
    push_history({'event':'stop_module','name':name,'result':results})
    return jsonify({'ok':True,'result':results})

@app.route('/monitor', methods=['GET'])
@token_required
def monitor_route():
    return jsonify({'monitor': monitor.summary(), 'history_len': len(state['history'])})

# ensure monitor runs in background
monitor.start()

if __name__=='__main__':
    port = CONFIG.get('api_port',7077)
    print('Starting Cybra HyperPlatform Supervisor on port', port, flush=True)
    app.run(host='0.0.0.0', port=port)
