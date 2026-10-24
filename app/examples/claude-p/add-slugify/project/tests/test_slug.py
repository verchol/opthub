import unittest

from textkit.slug import slugify


class SlugTest(unittest.TestCase):
    def test_lowercases_and_joins_words(self):
        self.assertEqual(slugify("Hello World"), "hello-world")

    def test_collapses_punctuation(self):
        self.assertEqual(slugify("Q3 -- results!!"), "q3-results")

    def test_folds_accents(self):
        self.assertEqual(slugify("Crème brûlée"), "creme-brulee")

    def test_cuts_at_a_separator(self):
        self.assertEqual(slugify("one two three", max_length=9), "one-two")

    def test_untitled(self):
        self.assertEqual(slugify("!!!"), "untitled")


if __name__ == "__main__":
    unittest.main()
