#!/usr/bin/env python3
import os, sys, subprocess, time, signal, hashlib, threading
from multiprocessing import Process, current_process
class ModuleWrapper:
    def __init__(self, path, name, sha512, state, config):
        self.path = path
        self.name = name
        self.sha512 = sha512
        self.state = state
        self.config = config

    def _run_child(self):
        # exec the module in its own process group
        try:
            # ensure file integrity before running
            with open(self.path,'rb') as f:
                sha = hashlib.sha512(f.read()).hexdigest()
            if sha != self.sha512:
                print(f'[module_wrapper] SHA mismatch for {self.name}', flush=True)
                return 2
            # run module as subprocess; keep output in module log
            logdir = os.path.join(os.path.dirname(self.path),'..','data','logs')
            os.makedirs(logdir, exist_ok=True)
            logfile = os.path.join(logdir, f'{self.name}.log')
            with open(logfile,'a') as out:
                # create new process group for isolation
                p = subprocess.Popen([sys.executable, self.path], stdout=out, stderr=out, preexec_fn=os.setsid)
                p.wait()
                return p.returncode
        except SystemExit:
            return 0
        except Exception as e:
            print(f'[module_wrapper] child exception {e}', flush=True)
            return 1

    def start_process(self):
        # start a monitor process that restarts child on crash
        proc = Process(target=self._monitor_loop, daemon=True)
        proc.start()
        return proc

    def _monitor_loop(self):
        # supervise child: if it exits, restart after delay
        while True:
            code = self._run_child()
            print(f'[module_wrapper] child for {self.name} exited with code {code}', flush=True)
            # push status to shared state
            # ensure state present
            try:
                mods = self.state['modules']
                entry = mods.get(self.name, {})
                pids = entry.get('pids', [])
                # remove any dead pids later via supervisor stop
            except Exception:
                pass
            if not self.config.get('auto_restart', True):
                break
            time.sleep(self.config.get('restart_delay', 1))
