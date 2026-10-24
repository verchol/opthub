import unittest

from durations import parse_duration


class ParseDuration(unittest.TestCase):
    def test_hours_and_minutes(self):
        self.assertEqual(parse_duration("1h30m"), 5400)

    def test_bare_seconds(self):
        self.assertEqual(parse_duration("90"), 90)

    def test_spaces_between_parts(self):
        self.assertEqual(parse_duration("2d 4h"), 187200)

    def test_decimal_hours(self):
        self.assertEqual(parse_duration("1.5h"), 5400)

    def test_out_of_order_is_an_error(self):
        with self.assertRaises(ValueError):
            parse_duration("30m1h")

    def test_empty_is_an_error(self):
        with self.assertRaises(ValueError):
            parse_duration("")


if __name__ == "__main__":
    unittest.main()
