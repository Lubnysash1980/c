# Cards.py
# Module to load / save cards from CSV/JSON and basic operations.
import csv
import json
import os
from typing import List, Dict, Optional

class CardStore:
    def __init__(self, path='cards.csv'):
        self.path = path
        self.cards = self._load()

    def _load(self) -> List[Dict]:
        if not os.path.exists(self.path):
            return []
        _, ext = os.path.splitext(self.path)
        if ext.lower() == '.json':
            with open(self.path, 'r', encoding='utf-8') as f:
                return json.load(f)
        else:
            with open(self.path, newline='', encoding='utf-8') as f:
                reader = csv.DictReader(f)
                return [dict(row) for row in reader]

    def save(self):
        if not self.cards:
            return
        _, ext = os.path.splitext(self.path)
        if ext.lower() == '.json':
            with open(self.path, 'w', encoding='utf-8') as f:
                json.dump(self.cards, f, indent=2, ensure_ascii=False)
        else:
            with open(self.path, 'w', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=self.cards[0].keys())
                writer.writeheader()
                writer.writerows(self.cards)

    def find_by_number(self, number: str) -> Optional[Dict]:
        for c in self.cards:
            if c.get('number') == number:
                return c
        return None

    def list(self) -> List[Dict]:
        return self.cards

    def deduct(self, number: str, amount: float) -> bool:
        c = self.find_by_number(number)
        if not c:
            return False
        bal = float(c.get('balance', 0))
        if bal < amount:
            return False
        c['balance'] = str(round(bal - amount, 2))
        self.save()
        return True

    def add_card(self, card: Dict):
        self.cards.append(card)
        self.save()

if __name__ == '__main__':
    store = CardStore('cards.csv')
    print('Loaded', len(store.list()), 'cards')
    while True:
        num = input('Поднесите карту (введите номер) or "exit": ')
        if num in ('exit', 'quit'):
            break
        card = store.find_by_number(num)
        if card:
            print('Card:', card)
            pay = input('Списать сумму (или skip): ')
            if pay.lower() != 'skip':
                try:
                    amt = float(pay)
                    ok = store.deduct(num, amt)
                    print('OK' if ok else 'Failed (insufficient or error)')
                except:
                    print('Некорректная сумма')
        else:
            print('Карта не найдена')
