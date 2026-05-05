from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from database import SessionLocal
from models import VirtualCard
from schemas import CardOut, CardCheck, UpdateBalance
from utils import validate_cvv_date

router = APIRouter()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

@router.get("/cards", response_model=list[CardOut])
def list_cards(db: Session = Depends(get_db)):
    return db.query(VirtualCard).all()

@router.get("/cards/{card_number}", response_model=CardOut)
def get_card(card_number: str, db: Session = Depends(get_db)):
    card = db.query(VirtualCard).filter_by(card_number=card_number).first()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")
    return card

@router.post("/cards/{card_number}/validate")
def validate_card(card_number: str, data: CardCheck, db: Session = Depends(get_db)):
    card = db.query(VirtualCard).filter_by(card_number=card_number).first()
    if not card or not validate_cvv_date(card, data.cvv, data.expiry_date):
        raise HTTPException(status_code=400, detail="Invalid CVV or expiry")
    return {"status": "valid"}

@router.post("/cards/{card_number}/update")
def update_balance(card_number: str, data: UpdateBalance, db: Session = Depends(get_db)):
    card = db.query(VirtualCard).filter_by(card_number=card_number).first()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")
    card.balance += data.amount
    db.commit()
    return {"status": "updated", "new_balance": card.balance}
