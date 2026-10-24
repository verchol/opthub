import unittest
from roman import to_roman, from_roman


class ToRoman(unittest.TestCase):
    def test_basic_digits(self):
        for n, s in [(1, "I"), (5, "V"), (10, "X"), (50, "L"), (100, "C"), (500, "D"), (1000, "M")]:
            self.assertEqual(to_roman(n), s, n)

    def test_subtractive(self):
        for n, s in [(4, "IV"), (9, "IX"), (40, "XL"), (90, "XC"), (400, "CD"), (900, "CM")]:
            self.assertEqual(to_roman(n), s, n)

    def test_composites(self):
        for n, s in [(3, "III"), (14, "XIV"), (44, "XLIV"), (1987, "MCMLXXXVII"), (3999, "MMMCMXCIX")]:
            self.assertEqual(to_roman(n), s, n)

    def test_no_four_repeats(self):
        for n in (4, 9, 40, 400, 3999):
            self.assertNotIn("IIII", to_roman(n))
            self.assertNotIn("XXXX", to_roman(n))

    def test_out_of_range_raises(self):
        for n in (0, -1, 4000, 10000):
            with self.assertRaises(ValueError, msg=n):
                to_roman(n)

    def test_non_integer_raises(self):
        for bad in ("5", 1.5, None):
            with self.assertRaises((ValueError, TypeError), msg=bad):
                to_roman(bad)


class FromRoman(unittest.TestCase):
    def test_basic(self):
        for s, n in [("I", 1), ("IV", 4), ("IX", 9), ("XIV", 14), ("MCMLXXXVII", 1987), ("MMMCMXCIX", 3999)]:
            self.assertEqual(from_roman(s), n, s)

    def test_invalid_letter(self):
        for s in ("A", "IIA", "1V"):
            with self.assertRaises(ValueError, msg=s):
                from_roman(s)

    def test_bad_repeats(self):
        for s in ("IIII", "VV", "LL", "DD", "XXXX"):
            with self.assertRaises(ValueError, msg=s):
                from_roman(s)

    def test_illegal_subtraction(self):
        for s in ("IL", "IC", "VX", "IM"):
            with self.assertRaises(ValueError, msg=s):
                from_roman(s)

    def test_empty_raises(self):
        with self.assertRaises(ValueError):
            from_roman("")


class RoundTrip(unittest.TestCase):
    def test_round_trip_sample(self):
        for n in (1, 2, 3, 4, 9, 14, 40, 90, 246, 789, 1009, 1987, 2421, 3999):
            self.assertEqual(from_roman(to_roman(n)), n, n)

    def test_round_trip_dense(self):
        for n in range(1, 500):
            self.assertEqual(from_roman(to_roman(n)), n, n)
