# flask_app.py - receives NFC posts and problem reports
from flask import Flask, request, jsonify
import os, threading, time
app = Flask(__name__)
STATUS = {'running': True, 'last_tag': None, 'problems': []}

@app.route('/nfc', methods=['POST'])
def nfc():
    data = request.json or {}
    card = data.get('card_id') or data.get('card')
    STATUS['last_tag'] = card
    print('Received NFC:', card)
    # optionally push into a local queue/file for module_manager to process
    # append to a simple file
    p = os.path.join(os.path.dirname(__file__),'incoming.log')
    with open(p,'a',encoding='utf-8') as f:
        f.write(str({'time':time.time(),'card':card})+'\n')
    return jsonify({'ok':True})

@app.route('/report', methods=['POST'])
def report():
    data = request.json or {}
    STATUS['problems'].append(data)
    print('Problem report:', data)
    return jsonify({'ok':True})

@app.route('/status')
def status():
    return jsonify(STATUS)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
