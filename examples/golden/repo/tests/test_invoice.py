import unittest
from decimal import Decimal

import invoice


class TotalTest(unittest.TestCase):
    def test_round_the_sum_not_the_lines(self):
        # 3 x 0.13 at 17% tax = 0.4563 -> 0.46; rounding each line first gives 3 x 0.15 = 0.45
        self.assertEqual(invoice.total([(0.13, 1), (0.13, 1), (0.13, 1)]), Decimal("0.46"))
