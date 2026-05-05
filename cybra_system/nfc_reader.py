# nfc_reader.py
# NFC reader abstraction: tries to use nfcpy; if not available, falls back to console emulation.
import time
import threading

def _console_emulator(on_tag):
    # simple loop that asks for card number input
    try:
        while True:
            num = input('EMULATOR: Поднесите карту (введите номер) or "exit": ')
            if num in ('exit', 'quit'):
                break
            on_tag({'number': num})
    except KeyboardInterrupt:
        pass

def start_reader(on_tag, emulate=True):
    """Start NFC reader in a thread. on_tag is called with a dict {'number': ...} when card is read.
    If 'emulate' True or nfc library not available, use console emulator."""
    try:
        if not emulate:
            import nfc
            # A full nfcpy implementation requires hardware; we keep it minimal here.
            # If you have nfcpy working on Termux with appropriate drivers, implement tag reading here.
            raise ImportError('nfcpy mode not implemented in this template; falling back to emulator')
    except Exception:
        t = threading.Thread(target=_console_emulator, args=(on_tag,), daemon=True)
        t.start()
        return t

    # If we had a native implementation we'd start it and return the thread/handle.
    return None

if __name__ == '__main__':
    def on_tag(tag):
        print('Tag seen:', tag)
    start_reader(on_tag, emulate=True)
    while True:
        time.sleep(1)
