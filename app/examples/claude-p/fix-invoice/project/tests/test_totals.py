import unittest

from invoice.totals import invoice_total, line_total, to_cents


class TotalsTest(unittest.TestCase):
    def test_to_cents_rounds_half_up(self):
        self.assertEqual(to_cents(2.675), 2.68)

    def test_line_without_discount(self):
        self.assertEqual(line_total(3, 4.5), 13.5)

    def test_line_with_percentage_discount(self):
        self.assertEqual(line_total(2, 10.0, 10), 18.0)

    def test_line_rounds_half_up(self):
        self.assertEqual(line_total(1, 2.675), 2.68)

    def test_invoice_adds_tax_on_discounted_lines(self):
        lines = [dict(qty=2, unit_price=10.0, discount_pct=10), dict(qty=1, unit_price=5.0)]
        self.assertEqual(invoice_total(lines, 0.2), 27.6)


if __name__ == "__main__":
    unittest.main()
