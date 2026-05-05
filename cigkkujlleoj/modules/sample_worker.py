#!/usr/bin/env python3
import time, random
print('[sample_worker] started', flush=True)
cnt = 0
while True:
    cnt += 1
    if random.random() < 0.01:
        raise RuntimeError('simulated random failure')
    print(f'[sample_worker] heartbeat {cnt}', flush=True)
    time.sleep(1)
