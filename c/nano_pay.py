# nano_pay.py
# Moves cards with nominal (preset payment-able cards) into nano_pay.csv and handles quick-pay operations.
import csv
import os
from typing import List, Dict

NANOPAY = 'nano_pay.csv'

def extract_nominal_cards(source='cards.csv', min_nominal=0.01):
    if not os.path.exists(source):
        return []
    out = []
    with open(source, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for r in reader:
            try:
                bal = float(r.get('balance', 0))
            except:
                bal = 0.0
            if bal >= min_nominal:
                out.append(r)
    if out:
        with open(NANOPAY, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=out[0].keys())
            writer.writeheader()
            writer.writerows(out)
    return out

def load_nanopay():
    if not os.path.exists(NANOPAY):
        return []
    with open(NANOPAY, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        return [dict(r) for r in reader]

def pay_from_nanopay(card_number, amount):
    cards = load_nanopay()
    for c in cards:
        if c.get('number') == card_number:
            bal = float(c.get('balance', 0))
            if bal >= amount:
                c['balance'] = str(round(bal - amount, 2))
                # save back
                with open(NANOPAY, 'w', newline='', encoding='utf-8') as f:
                    writer = csv.DictWriter(f, fieldnames=cards[0].keys())
                    writer.writeheader()
                    writer.writerows(cards)
                return True
            return False
    return False

if __name__ == '__main__':
    print('Extracting nominal cards to nano_pay.csv...')
    found = extract_nominal_cards()
    print('Found', len(found), 'cards')
