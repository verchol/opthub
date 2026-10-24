import time
import unittest

from ledger.merge import dedupe


def rec(i, date, amount=1.0):
    return {"id": i, "date": date, "amount": amount}


class DedupeTest(unittest.TestCase):
    def test_keeps_order_and_first_seen(self):
        rows = [rec(1, "2026-10-01", 5.0), rec(2, "2026-10-01"), rec(1, "2026-10-01", 9.0)]
        self.assertEqual(dedupe(rows), [rec(1, "2026-10-01", 5.0), rec(2, "2026-10-01")])

    def test_same_id_on_another_date_is_another_transaction(self):
        rows = [rec(1, "2026-10-01"), rec(1, "2026-10-02")]
        self.assertEqual(len(dedupe(rows)), 2)

    def test_large_feed_is_fast(self):
        rows = [rec(i % 15000, f"2026-10-{(i // 15000) % 2 + 1:02d}") for i in range(40000)]
        t0 = time.perf_counter()
        out = dedupe(rows)
        self.assertEqual(len(out), 30000)
        self.assertLess(time.perf_counter() - t0, 1.0)


if __name__ == "__main__":
    unittest.main()
