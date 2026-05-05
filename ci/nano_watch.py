import time
from modules.pay import extract_nominals
while True:
    try:
        res = extract_nominals(min_nominal=0.01)
        if res:
            print('extracted',len(res))
    except Exception as e:
        print('err',e)
    time.sleep(10)
