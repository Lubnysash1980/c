# Cards.py - unchanged core
import csv, json, os
from typing import List, Dict, Optional

class CardStore:
    def __init__(self, path=None):
        self.path = path or os.path.join(os.path.dirname(__file__), 'cards.csv')
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
