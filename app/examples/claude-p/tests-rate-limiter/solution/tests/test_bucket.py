import unittest

from ratelimit import TokenBucket


class Clock:
    def __init__(self, t=0.0):
        self.t = t

    def __call__(self):
        return self.t


class TokenBucketTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.b = TokenBucket(capacity=3, rate=1, clock=self.clock)

    def test_starts_full(self):
        self.assertTrue(all(self.b.allow() for _ in range(3)))
        self.assertFalse(self.b.allow())

    def test_refills_with_time(self):
        for _ in range(3):
            self.b.allow()
        self.clock.t = 2
        self.assertTrue(self.b.allow())
        self.assertTrue(self.b.allow())
        self.assertFalse(self.b.allow())

    def test_never_above_capacity(self):
        self.clock.t = 100
        self.assertTrue(all(self.b.allow() for _ in range(3)))
        self.assertFalse(self.b.allow())

    def test_exact_cost_is_allowed(self):
        self.assertTrue(self.b.allow(3))
        self.assertFalse(self.b.allow(0.5))

    def test_refusal_takes_nothing(self):
        self.b.allow(2)
        self.assertFalse(self.b.allow(2))
        self.assertTrue(self.b.allow(1))

    def test_cost_above_capacity_never_allowed(self):
        self.clock.t = 100
        self.assertFalse(self.b.allow(4))

    def test_negative_cost_raises(self):
        with self.assertRaises(ValueError):
            self.b.allow(-1)

    def test_clock_going_backwards_adds_nothing(self):
        for _ in range(3):
            self.b.allow()
        self.clock.t = -50
        self.assertFalse(self.b.allow())

    def test_rate_is_respected(self):
        b = TokenBucket(capacity=10, rate=2, clock=self.clock)
        for _ in range(10):
            b.allow()
        self.clock.t = 1
        self.assertTrue(b.allow(2))
        self.assertFalse(b.allow())


if __name__ == "__main__":
    unittest.main()
