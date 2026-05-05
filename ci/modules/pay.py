import os, csv
BASE = os.path.dirname(__file__)
NANOPAY = os.path.join(BASE,'..','nano_pay.csv')

def extract_nominals(src_path=None, min_nominal=0.01):
    src = src_path or os.path.join(BASE,'..','cards.csv')
    if not os.path.exists(src):
        return []
    out = []
    with open(src, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for r in reader:
            try:
                bal = float(r.get('balance',0))
            except:
                bal = 0.0
            if bal >= min_nominal:
                out.append(r)
    if out:
        with open(NANOPAY,'w',newline='',encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=out[0].keys())
            writer.writeheader()
            writer.writerows(out)
    return out

def pay(card_number, amount):
    if not os.path.exists(NANOPAY):
        return False,'nano_pay missing'
    cards = []
    with open(NANOPAY,newline='',encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for r in reader:
            cards.append(r)
    for c in cards:
        if c.get('number')==card_number:
            bal = float(c.get('balance',0))
            if bal>=amount:
                c['balance']=str(round(bal-amount,2))
                with open(NANOPAY,'w',newline='',encoding='utf-8') as f:
                    writer = csv.DictWriter(f, fieldnames=cards[0].keys())
                    writer.writeheader()
                    writer.writerows(cards)
                return True,'paid'
            return False,'insufficient'
    return False,'not found'
