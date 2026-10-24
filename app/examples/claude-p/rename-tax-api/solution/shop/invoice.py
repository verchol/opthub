from shop import tax


def invoice_lines(amount, region):
    t = tax.compute_tax(amount, region)
    return [f"subtotal  {amount:.2f}", f"tax       {t:.2f}", f"total     {amount + t:.2f}"]
