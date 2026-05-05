#!/usr/bin/env python3
import threading, time, os, json
class Monitor:
    def __init__(self, state, logdir, history_size=512):
        self.state = state
        self.logdir = logdir
        self.history_size = history_size
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._running = False
        os.makedirs(self.logdir, exist_ok=True)

    def start(self):
        if not self._thread.is_alive():
            self._running = True
            self._thread.start()

    def _loop(self):
        while self._running:
            try:
                # scan module logs for errors and update state events
                for fn in os.listdir(self.logdir):
                    if fn.endswith('.log'):
                        path = os.path.join(self.logdir, fn)
                        try:
                            with open(path,'r') as f:
                                data = f.read()
                            if 'Traceback' in data or 'ERROR' in data:
                                # record event
                                item = {'event':'log_error','file':fn,'time': time.time()}
                                # append to shared history (cap to history_size)
                                hist = list(self.state['history'])
                                hist.append(item)
                                if len(hist) > self.history_size:
                                    hist = hist[-self.history_size:]
                                self.state['history'][:] = hist
                        except Exception:
                            pass
            except Exception as e:
                print('[monitor] loop error', e, flush=True)
            time.sleep(2.0)

    def summary(self):
        return {'log_files': os.listdir(self.logdir) if os.path.isdir(self.logdir) else []}
