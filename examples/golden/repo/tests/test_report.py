import unittest

import ledger
import report


class MonthlyTest(unittest.TestCase):
    def test_totals_match_entries(self):
        entries = ledger.sample(300)
        rows = report.monthly(entries)
        self.assertAlmostEqual(sum(t for _, t, _ in rows), sum(a for _, _, a in entries), places=1)
