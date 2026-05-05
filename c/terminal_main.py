# terminal_main.py
# Orchestrator: starts NFC reader, Flask server, watchdog and simple multiprocessing auto-reloader.
import multiprocessing as mp
import time
import os
import signal
from Cards import CardStore
from nano_pay import extract_nominal_cards, pay_from_nanopay
import nfc_reader
import threading
import subprocess

STORE_PATH = 'cards.csv'

def nfc_worker(queue):
    # Called in separate process/thread: reads tags and puts into queue
    def on_tag(tag):
        queue.put(tag)
    nfc_reader.start_reader(on_tag, emulate=True)
    # keep alive
    while True:
        time.sleep(1)

def flask_worker():
    # Run flask in subprocess to avoid dealing with flask app context here.
    subprocess.run(['python3', 'flask_app.py'])

def watchdog(workers):
    # Very simple: restart any process that died
    while True:
        for name, proc in list(workers.items()):
            if not proc.is_alive():
                print('Watchdog: restarting', name)
                if name == 'nfc':
                    q = mp.Queue()
                    p = mp.Process(target=nfc_worker, args=(q,), daemon=True)
                    p.start()
                    workers['nfc'] = p
                elif name == 'flask':
                    p = mp.Process(target=flask_worker, daemon=True)
                    p.start()
                    workers['flask'] = p
        time.sleep(5)

def main():
    manager = mp.Manager()
    q = manager.Queue()
    workers = {}
    # start NFC worker
    p_nfc = mp.Process(target=nfc_worker, args=(q,), daemon=True)
    p_nfc.start()
    workers['nfc'] = p_nfc
    # start flask worker
    p_flask = mp.Process(target=flask_worker, daemon=True)
    p_flask.start()
    workers['flask'] = p_flask

    wd = threading.Thread(target=watchdog, args=(workers,), daemon=True)
    wd.start()

    store = CardStore(STORE_PATH)
    print('Terminal orchestrator started. Ctrl-C to stop.')
    try:
        while True:
            try:
                tag = q.get(timeout=1)
                number = tag.get('number')
                print('Tag read:', number)
                card = store.find_by_number(number)
                if card:
                    print('Found card. Balance:', card.get('balance'))
                    # auto-process with nano_pay if present
                    # For demo: try to deduct a small amount (0.01)
                    ok = store.deduct(number, 0.01)
                    print('Auto-deduct 0.01 ->', ok)
            except Exception:
                pass
            time.sleep(0.1)
    except KeyboardInterrupt:
        print('Shutting down...')
        for p in workers.values():
            try:
                p.terminate()
            except:
                pass

if __name__ == '__main__':
    main()
