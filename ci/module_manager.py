import subprocess, time, os, sys
from modules.ai_helper import analyze
from modules.cards import find_card_by_number
from modules.pay import pay, extract_nominals

BASE = os.path.dirname(__file__)
def start_process(script):
    return subprocess.Popen([sys.executable,'-u',script])

def nfc_event_handler(tag):
    num = tag.get('number')
    print('Tag read:',num)
    card = find_card_by_number(num)
    if card:
        print('Card found:',card.get('holder'),'balance:',card.get('balance'))
        ok,msg = pay(num,0.01)
        print('Auto-pay:',ok,msg)
    else:
        print('Card not found')

def main():
    extract_nominals()
    # Run a simple interactive reader in same process
    from modules.nfc_reader import start_reader
    start_reader(nfc_event_handler)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print('manager stopping')

if __name__=='__main__':
    main()
