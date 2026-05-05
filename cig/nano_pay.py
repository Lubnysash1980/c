# nano_pay.py - unchanged core
import csv, os
NANOPAY = os.path.join(os.path.dirname(__file__), 'nano_pay.csv')

def extract_nominal_cards(source=None, min_nominal=0.01):
    source = source or os.path.join(os.path.dirname(__file__), 'cards.csv')
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
                with open(NANOPAY, 'w', newline='', encoding='utf-8') as f:
                    writer = csv.DictWriter(f, fieldnames=cards[0].keys())
                    writer.writeheader()
                    writer.writerows(cards)
                return True
            return False
    return False
