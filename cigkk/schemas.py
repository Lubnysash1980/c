from pydantic import BaseModel

class CardBase(BaseModel):
    card_number: str
    expiry_date: str
    iban: str

class CardOut(CardBase):
    balance: float

class CardCheck(BaseModel):
    cvv: str
    expiry_date: str

class UpdateBalance(BaseModel):
    amount: float
