# ai_agent.py - enhanced agent: logs, suggests, can POST reports to cybra endpoint
import time,traceback,json,os,requests

LOG = os.path.join(os.path.dirname(__file__),'agent.log')
CYBRA_ENDPOINT = os.environ.get('CYBRA_ENDPOINT')  # optional remote receiver (http)
MAX_AUTOFIX = 5  # how many auto-fix attempts per issue

def analyze_exception(module_name, exc):
    msg = str(exc)
    suggestion = 'Restart module; check logs.'
    if 'ModuleNotFoundError' in msg or 'No module named' in msg:
        suggestion = 'Missing Python dependency. Run installer or pip install the missing package.'
    elif 'PermissionError' in msg:
        suggestion = 'Permission denied: run termux-setup-storage and check paths.'
    entry = {'time': time.time(), 'module': module_name, 'error': msg, 'suggestion': suggestion}
    with open(LOG,'a',encoding='utf-8') as f:
        f.write(json.dumps(entry,ensure_ascii=False)+'\n')
    return suggestion

def report_problem(module_name, exc):
    sug = analyze_exception(module_name, exc)
    payload = {'module': module_name, 'error': str(exc), 'suggestion': sug, 'time': time.time()}
    # try to notify remote cybra endpoint if configured
    if CYBRA_ENDPOINT:
        try:
            requests.post(CYBRA_ENDPOINT, json=payload, timeout=5)
        except Exception as e:
            with open(LOG,'a',encoding='utf-8') as f:
                f.write(json.dumps({'time':time.time(),'notify_fail':str(e)})+'\n')
    print(f'[AI_AGENT] {module_name}: {sug}')
    return sug

def attempt_autofix(module_name, exc, attempt=1):
    # Simple autofix heuristics: if module missing, pip install the package name if extractable
    msg = str(exc)
    if ('No module named' in msg or 'ModuleNotFoundError' in msg) and attempt <= MAX_AUTOFIX:
        # extract package name
        try:
            pkg = msg.split('No module named')[1].strip().strip("'\"")
            # try pip install
            import subprocess, sys
            subprocess.run([sys.executable,'-m','pip','install',pkg],check=False)
            return True
        except Exception as e:
            return False
    return False
