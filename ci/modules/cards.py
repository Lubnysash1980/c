import csv, os
BASE = os.path.dirname(__file__)
PATH = os.path.join(BASE, '..', 'cards.csv')

def load_cards():
    p = os.path.normpath(PATH)
    if not os.path.exists(p):
        return []
    with open(p, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        return [dict(r) for r in reader]

def find_card_by_number(number):
    for c in load_cards():
        if c.get('number') == number:
            return c
    return None
