"""Price quotes for the three plans. Amounts are in dollars, rounded to cents."""

TAX_RATE = 0.17


def _price(subtotal, discount):
    """Apply a discount, then tax, then round to cents."""
    return round(subtotal * (1 - discount) * (1 + TAX_RATE) + 1e-9, 2)


def quote_basic(seats, months):
    discount = 0.10 if months >= 12 else 0.0
    return _price(seats * 12.0 * months, discount)


def quote_pro(seats, months, support=False):
    subtotal = seats * 29.0 * months + (99.0 * months if support else 0.0)
    discount = 0.15 if months >= 12 else (0.05 if months >= 6 else 0.0)
    return _price(subtotal, discount)


def quote_team(seats, months, coupon=None):
    discount = 0.20 if seats >= 50 else (0.10 if seats >= 10 else 0.0)
    if coupon == "LAUNCH":
        discount += 0.05
    return _price(seats * 24.0 * months, discount)
