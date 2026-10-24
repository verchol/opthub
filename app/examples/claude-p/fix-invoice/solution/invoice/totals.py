"""Invoice arithmetic. Money is rounded to cents, half up, the way the accounts team does it."""
from decimal import Decimal, ROUND_HALF_UP


def to_cents(amount):
    """Round a money amount to cents, half up (2.675 -> 2.68)."""
    return float(Decimal(str(amount)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def line_total(qty, unit_price, discount_pct=0):
    """One invoice line: quantity times unit price, less a percentage discount (10 means 10%)."""
    gross = qty * unit_price
    return to_cents(gross - gross * discount_pct / 100)


def invoice_total(lines, tax_rate):
    """Every line's total, plus tax on the sum (tax_rate 0.2 means 20%), in cents."""
    subtotal = sum(line_total(**line) for line in lines)
    return to_cents(subtotal + subtotal * tax_rate)
