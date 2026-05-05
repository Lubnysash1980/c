Termux NFC Terminal - quickstart
Files:
- Cards.py        : card storage / ops
- nano_pay.py     : extract nominal cards and quick-pay
- nfc_reader.py   : NFC abstraction (console emulator by default)
- flask_app.py    : minimal Flask API
- terminal_main.py: orchestrator / multiprocessing / watchdog
- installer.sh    : run in Termux to install prerequisites
- run.sh          : start terminal in background
- cards.csv       : sample cards
- requirements.txt: python deps

Notes & limitations:
- This bundle uses an emulator for NFC input by default (console input) so it runs 'out of the box' in Termux.
- Real NFC hardware support (nfcpy, PN532, libnfc drivers) requires device support, OTG, and native drivers on Android/Termux — that can be added by uncommenting/installing nfcpy and implementing hardware code in nfc_reader.py.
- The orchestrator has a simple watchdog; modules run as separate processes and will be restarted if they die.
- For security: do not store real card PAN/CVV data unless you control the data securely and it's legal to do so.
- To run: in Termux, place this folder somewhere accessible and run 'bash installer.sh' then './run.sh'
