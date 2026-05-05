import threading
def start_reader(on_tag):
    def loop():
        try:
            while True:
                num = input('EMULATOR: enter tag id (or exit): ').strip()
                if not num:
                    continue
                if num in ('exit','quit'):
                    break
                on_tag({'number':num})
        except Exception:
            pass
    t = threading.Thread(target=loop,daemon=True)
    t.start()
    return t
