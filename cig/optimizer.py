# optimizer.py - try to run quick iterative "improvements" up to N times.
import time, subprocess, os
from ai_agent import report_problem, attempt_autofix

def single_pass():
    # very small checks: pip freeze, disk space, connectivity to flask
    try:
        import requests, shutil, sys
        free = shutil.disk_usage('/').free
        print('Free bytes:', free)
        try:
            r = requests.get('http://127.0.0.1:5000/status', timeout=1)
            print('Flask OK')
        except Exception as e:
            report_problem('optimizer_single_pass', e)
        return True
    except Exception as e:
        report_problem('optimizer_single_pass', e)
        return False

def run_iterations(n=50):
    for i in range(n):
        print('Optimizer pass', i+1)
        ok = single_pass()
        if not ok:
            # try simple autofix, like pip install requests
            try:
                attempt_autofix('optimizer', Exception('No requests'))
            except:
                pass
        time.sleep(1)
    print('Optimizer finished')

if __name__ == '__main__':
    run_iterations(50)
