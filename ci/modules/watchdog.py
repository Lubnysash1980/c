import time, os
LOG = os.path.join(os.path.dirname(__file__),'..','watchdog.log')
def log(msg):
    with open(LOG,'a',encoding='utf-8') as f:
        f.write(str(time.time())+' '+msg+'\n')
def check_and_report(name,status):
    log(f'{name} status {status}')
