import time, json, os
LOG = os.path.join(os.path.dirname(__file__),'..','ai_agent.log')
def analyze(e, module_name='unknown'):
    s = str(e)
    suggestion = 'Restart module and check dependencies.'
    if 'ModuleNotFoundError' in s or 'No module named' in s:
        suggestion = 'Missing package. Try pip install <package>.'
    entry = {'time':time.time(),'module':module_name,'error':s,'suggestion':suggestion}
    with open(LOG,'a',encoding='utf-8') as f:
        f.write(json.dumps(entry,ensure_ascii=False)+'\n')
    return suggestion
