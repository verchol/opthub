"""Price quotes for the three plans. Amounts are in dollars, rounded to cents."""

TAX_RATE = 0.17


def quote_basic(seats, months):
    subtotal = seats * 12.0 * months
    discount = 0.10 if months >= 12 else 0.0
    after_discount = subtotal * (1 - discount)
    with_tax = after_discount * (1 + TAX_RATE)
    return round(with_tax + 1e-9, 2)


def quote_pro(seats, months, support=False):
    subtotal = seats * 29.0 * months
    if support:
        subtotal += 99.0 * months
    discount = 0.15 if months >= 12 else (0.05 if months >= 6 else 0.0)
    after_discount = subtotal * (1 - discount)
    with_tax = after_discount * (1 + TAX_RATE)
    return round(with_tax + 1e-9, 2)


def quote_team(seats, months, coupon=None):
    subtotal = seats * 24.0 * months
    discount = 0.20 if seats >= 50 else (0.10 if seats >= 10 else 0.0)
    if coupon == "LAUNCH":
        discount += 0.05
    after_discount = subtotal * (1 - discount)
    with_tax = after_discount * (1 + TAX_RATE)
    return round(with_tax + 1e-9, 2)
