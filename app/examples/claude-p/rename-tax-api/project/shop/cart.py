from shop.tax import calc_tax


def cart_total(items, region):
    """items: [(price, qty)]. Returns subtotal + tax."""
    subtotal = sum(price * qty for price, qty in items)
    return round(subtotal + calc_tax(subtotal, region), 2)
