# flask_app.py
# Minimal Flask API which Termux scripts can call to trigger actions or check status.
from flask import Flask, jsonify, request
from threading import Thread
import time
app = Flask(__name__)

STATUS = {'running': True, 'last_tag': None}

@app.route('/status')
def status():
    return jsonify(STATUS)

@app.route('/trigger_payment', methods=['POST'])
def trigger_payment():
    data = request.json or {}
    card = data.get('card')
    amount = float(data.get('amount', 0))
    # This is a stub: in the integrated system the main process will listen on a queue or DB
    # For demo we just echo back.
    return jsonify({'ok': True, 'card': card, 'amount': amount})

def run(port=5000):
    app.run(host='0.0.0.0', port=port, debug=False)

if __name__ == '__main__':
    run()
