# module_manager.py - strong self-healing manager with ai_agent support and optimizer loop
import multiprocessing as mp, threading, time, os, subprocess, sys, traceback
from ai_agent import report_problem, attempt_autofix
from Cards import CardStore
from nano_pay import extract_nominal_cards

BASE_DIR = os.path.dirname(__file__)
STORE_PATH = os.path.join(BASE_DIR,'cards.csv')

def start_subprocess_target(target, name, args=()):
    p = mp.Process(target=target, args=args, daemon=True)
    p.start()
    print('Started', name, 'pid', p.pid)
    return p

def nfc_worker(q):
    try:
        import nfc_reader
        def on_tag(t): q.put(t)
        nfc_reader.start_reader(on_tag, emulate_if_missing=True)
        while True: time.sleep(1)
    except Exception as e:
        report_problem('nfc_worker', e)
        # try autofix and continue loop after delay
        for i in range(1,4):
            try:
                fixed = attempt_autofix('nfc_worker', e, attempt=i)
                if fixed:
                    time.sleep(2)
                    return nfc_worker(q)
            except:
                pass
        raise

def flask_worker():
    try:
        subprocess.run([sys.executable, os.path.join(BASE_DIR,'flask_app.py')])
    except Exception as e:
        report_problem('flask_worker', e)
        raise

def optimizer_loop(shared, iterations=50):
    # Attempts automated checks and mild fixes repeatedly to "improve" system.
    from ai_agent import report_problem, attempt_autofix
    for i in range(iterations):
        try:
            # check flask is responsive
            import requests
            try:
                resp = requests.get('http://127.0.0.1:5000/status', timeout=1)
            except Exception:
                # try restarting flask
                if 'flask' in shared and shared['flask'] is not None:
                    try:
                        shared['flask'].terminate()
                    except: pass
                shared['flask'] = start_subprocess_target(flask_worker,'flask')
            # check for missing dependencies in logs (simple)
            time.sleep(2)
        except Exception as e:
            report_problem('optimizer', e)
        time.sleep(1)

def main():
    manager = mp.Manager()
    q = manager.Queue()
    shared = manager.dict()
    # start workers
    shared['nfc'] = start_subprocess_target(nfc_worker, 'nfc', args=(q,))
    shared['flask'] = start_subprocess_target(flask_worker, 'flask')
    # watchdog thread to maintain processes
    def watchdog():
        while True:
            for name in list(shared.keys()):
                p = shared.get(name)
                if p is None or not p.is_alive():
                    print('Watchdog: restarting', name)
                    try:
                        if name == 'nfc':
                            shared['nfc'] = start_subprocess_target(nfc_worker,'nfc', args=(q,))
                        elif name == 'flask':
                            shared['flask'] = start_subprocess_target(flask_worker,'flask')
                    except Exception as e:
                        report_problem('watchdog', e)
            time.sleep(3)
    threading.Thread(target=watchdog,daemon=True).start()
    # start optimizer in background
    threading.Thread(target=optimizer_loop, args=(shared,50), daemon=True).start()
    store = CardStore(STORE_PATH)
    extract_nominal_cards(STORE_PATH)
    print('Module manager running. Waiting for NFC tags...')
    try:
        while True:
            try:
                tag = q.get(timeout=1)
                num = tag.get('number')
                print('Tag read:', num)
                card = store.find_by_number(num)
                if card:
                    print('Found', num, 'bal=', card.get('balance'))
                    ok = store.deduct(num,0.01)
                    print('Auto-deduct 0.01 ->', ok)
                else:
                    print('Card not found')
            except Exception:
                pass
            time.sleep(0.1)
    except KeyboardInterrupt:
        print('Shutting down...')
        for v in shared.values():
            try: v.terminate()
            except: pass

if __name__ == '__main__': main()
