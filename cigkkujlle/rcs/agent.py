import requests, os, time, subprocess, hmac, hashlib
SERVER = os.environ.get('RCS_SERVER','http://127.0.0.1:5600')
AGENT_TOKEN = os.environ.get('AGENT_TOKEN','change_agent_token')
SECRET = os.environ.get('RCS_SECRET','change_this_secret')
while True:
    try:
        r = requests.post(SERVER+'/api/agent/poll', json={'agent_token': AGENT_TOKEN}, timeout=30)
        time.sleep(5)
    except Exception:
        time.sleep(5)
