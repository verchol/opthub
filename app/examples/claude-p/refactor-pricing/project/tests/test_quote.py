import unittest

from pricing import quote_basic, quote_pro, quote_team


class Quotes(unittest.TestCase):
    def test_basic_monthly(self):
        self.assertEqual(quote_basic(3, 1), 42.12)

    def test_basic_yearly_discount(self):
        self.assertEqual(quote_basic(1, 12), 151.63)

    def test_pro_with_support(self):
        self.assertEqual(quote_pro(2, 6, support=True), 1047.03)

    def test_team_with_coupon(self):
        self.assertEqual(quote_team(12, 12, coupon="LAUNCH"), 3436.99)


if __name__ == "__main__":
    unittest.main()
