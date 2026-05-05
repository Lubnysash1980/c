def validate_cvv_date(card, cvv, date):
    return card.cvv == cvv and card.expiry_date == date
