from sqlalchemy import Column, Integer, String, Float
from database import Base

class VirtualCard(Base):
    __tablename__ = "cards"
    id = Column(Integer, primary_key=True, index=True)
    card_number = Column(String, unique=True, index=True)
    expiry_date = Column(String)
    cvv = Column(String)
    iban = Column(String, unique=True)
    balance = Column(Float, default=0.0)
