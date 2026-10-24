import unittest
import warnings

from shop.cart import cart_total
from shop.tax import compute_tax


class Shop(unittest.TestCase):
    def test_compute_tax(self):
        self.assertEqual(compute_tax(100, "CA"), 7.25)

    def test_cart_total(self):
        self.assertEqual(cart_total([(10.0, 2), (5.0, 1)], "NY"), 26.0)

    def test_old_name_still_works_and_warns(self):
        from shop.tax import calc_tax
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            self.assertEqual(calc_tax(100, "TX"), 6.25)
        self.assertTrue(any(issubclass(x.category, DeprecationWarning) for x in w))


if __name__ == "__main__":
    unittest.main()
