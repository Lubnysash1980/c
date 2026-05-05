# nfc_reader.py - tries nfcpy -> pn532 serial -> emulator
import threading, time, os

def _console_emulator(on_tag):
    try:
        while True:
            num = input('EMULATOR: Поднесите карту (введите номер) or "exit": ')
            if num in ('exit','quit'):
                break
            on_tag({'number': num})
    except KeyboardInterrupt:
        pass

def _nfcpy_backend(on_tag):
    import nfc
    clf = nfc.ContactlessFrontend('usb')
    while True:
        tag = clf.connect(rdwr={'on-connect': lambda tag: False})
        if tag:
            try:
                tid = tag.identifier.hex()
            except:
                tid = str(tag)
            on_tag({'number': tid})

def _pn532_serial_backend(on_tag):
    import serial
    ports = ['/dev/ttyUSB0','/dev/ttyS0','/dev/ttyACM0']
    for p in ports:
        if os.path.exists(p):
            ser = serial.Serial(p,115200,timeout=1)
            while True:
                line = ser.readline().decode(errors='ignore').strip()
                if line:
                    on_tag({'number': line})
    raise RuntimeError('No serial port found for PN532')

def start_reader(on_tag, emulate_if_missing=True):
    def runner():
        backends = [(_nfcpy_backend,'nfcpy'),(_pn532_serial_backend,'pn532-serial')]
        for fn,name in backends:
            try:
                fn(on_tag)
                return
            except Exception as e:
                print('nfc_reader backend', name, 'failed ->', e)
        print('nfc_reader falling back to console emulator')
        _console_emulator(on_tag)
    t = threading.Thread(target=runner,daemon=True)
    t.start()
    return t
