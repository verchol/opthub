"""Invoice totals."""
from decimal import Decimal, ROUND_HALF_UP

CENT = Decimal("0.01")


def line_total(price, qty, tax_rate):
    return Decimal(str(price)) * qty * (1 + Decimal(str(tax_rate)))


def total(lines, tax_rate=0.17):
    # Bug (session fix-rounding): rounds every line, so the sum drifts by a cent.
    return sum((line_total(p, q, tax_rate).quantize(CENT, ROUND_HALF_UP) for p, q in lines), Decimal("0"))
