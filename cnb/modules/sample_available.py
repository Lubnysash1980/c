#!/usr/bin/env python3
import time
i=0
while True:
    i+=1
    if i%5==0:
        print('[sample] heartbeat', i, flush=True)
    time.sleep(1)
