"""Hidden grading suite for rex.py. Semantics mirror Perl-style backtracking."""
import unittest
import rex


def S(p, t):
    m = rex.compile(p).search(t)
    return None if m is None else m.group(0)


class Literals(unittest.TestCase):
    def test_plain_literal(self):
        self.assertEqual(S("abc", "xxabcxx"), "abc")

    def test_no_match_returns_none(self):
        self.assertIsNone(S("abc", "abd"))

    def test_dot_matches_any_but_newline(self):
        self.assertEqual(S("a.c", "abc"), "abc")
        self.assertIsNone(S("a.c", "a\nc"))

    def test_empty_pattern_matches_empty(self):
        m = rex.compile("").search("abc")
        self.assertEqual((m.group(0), m.start(), m.end()), ("", 0, 0))

    def test_leftmost(self):
        m = rex.compile("a+").search("bbaaab")
        self.assertEqual((m.start(), m.end(), m.group(0)), (2, 5, "aaa"))

    def test_escaped_metacharacters(self):
        self.assertEqual(S(r"a\.c", "a.c"), "a.c")
        self.assertIsNone(S(r"a\.c", "abc"))
        self.assertEqual(S(r"a\\b", "a\\b"), "a\\b")

    def test_escaped_whitespace(self):
        self.assertEqual(S(r"a\nb", "a\nb"), "a\nb")
        self.assertEqual(S(r"a\tb", "a\tb"), "a\tb")


class Classes(unittest.TestCase):
    def test_simple_class(self):
        self.assertEqual(S("[abc]+", "xxbcabxx"), "bcab")

    def test_range(self):
        self.assertEqual(S("[a-f]+", "zzabcfzz"), "abcf")

    def test_negated(self):
        self.assertEqual(S("[^0-9]+", "12abc34"), "abc")

    def test_dash_literal_at_edges(self):
        self.assertEqual(S("[-a]+", "b-ab"), "-a")
        self.assertEqual(S("[a-]+", "b-ab"), "-a")

    def test_class_escapes(self):
        self.assertEqual(S(r"[\d]+", "ab123cd"), "123")
        self.assertEqual(S(r"[^\s]+", "  hi  "), "hi")
        self.assertEqual(S(r"[\.]+", "a..b"), "..")

    def test_shorthand_classes(self):
        self.assertEqual(S(r"\d+", "ab123"), "123")
        self.assertEqual(S(r"\w+", " a_1 "), "a_1")
        self.assertEqual(S(r"\s+", "a \t b"), " \t ")

    def test_negated_shorthands(self):
        self.assertEqual(S(r"\D+", "12ab34"), "ab")
        self.assertEqual(S(r"\W+", "ab..cd"), "..")
        self.assertEqual(S(r"\S+", "  ab  "), "ab")

    def test_class_with_metachars_inside(self):
        self.assertEqual(S("[.*+]+", "a.*+b"), ".*+")


class Quantifiers(unittest.TestCase):
    def test_star_greedy(self):
        self.assertEqual(S("a*", "aaa"), "aaa")
        self.assertEqual(S("a*", "bbb"), "")

    def test_plus(self):
        self.assertEqual(S("a+", "aaa"), "aaa")
        self.assertIsNone(S("a+", "bbb"))

    def test_question(self):
        self.assertEqual(S("ab?c", "ac"), "ac")
        self.assertEqual(S("ab?c", "abc"), "abc")

    def test_greedy_backtracks(self):
        self.assertEqual(S("a.*c", "abcxxc"), "abcxxc")
        self.assertEqual(S("<.*>", "<a><b>"), "<a><b>")

    def test_lazy_star(self):
        self.assertEqual(S("<.*?>", "<a><b>"), "<a>")

    def test_lazy_plus_and_question(self):
        self.assertEqual(S("a+?", "aaa"), "a")
        self.assertEqual(S("ab??c", "abc"), "abc")

    def test_counted_exact(self):
        self.assertEqual(S("a{3}", "aaaaa"), "aaa")
        self.assertIsNone(S("a{3}", "aa"))

    def test_counted_open_ended(self):
        self.assertEqual(S("a{2,}", "aaaa"), "aaaa")
        self.assertIsNone(S("a{2,}", "a"))

    def test_counted_range_greedy(self):
        self.assertEqual(S("a{2,3}", "aaaa"), "aaa")

    def test_counted_range_lazy(self):
        self.assertEqual(S("a{2,3}?", "aaaa"), "aa")

    def test_brace_not_quantifier_is_literal(self):
        self.assertEqual(S("a{b", "xa{b"), "a{b")
        self.assertEqual(S("a{2,x", "za{2,x"), "a{2,x")

    def test_quantified_class(self):
        self.assertEqual(S("[0-9]{2,4}", "ab12345"), "1234")


class Groups(unittest.TestCase):
    def test_capture(self):
        m = rex.compile(r"(\d+)-(\d+)").search("x 12-34 y")
        self.assertEqual(m.group(0), "12-34")
        self.assertEqual((m.group(1), m.group(2)), ("12", "34"))

    def test_groups_tuple(self):
        m = rex.compile(r"(a)(b)(c)").search("abc")
        self.assertEqual(m.groups(), ("a", "b", "c"))

    def test_group_positions(self):
        m = rex.compile(r"a(b+)c").search("xxabbbcyy")
        self.assertEqual((m.start(0), m.end(0)), (2, 7))
        self.assertEqual((m.start(1), m.end(1)), (3, 6))

    def test_non_capturing(self):
        m = rex.compile(r"(?:ab)+(c)").search("ababc")
        self.assertEqual(m.group(0), "ababc")
        self.assertEqual(m.groups(), ("c",))

    def test_nested_groups_numbered_by_open_paren(self):
        m = rex.compile(r"((a)(b))c").search("abc")
        self.assertEqual(m.groups(), ("ab", "a", "b"))

    def test_unparticipating_group_is_none(self):
        m = rex.compile(r"(a)|(b)").search("b")
        self.assertEqual(m.group(1), None)
        self.assertEqual(m.group(2), "b")
        self.assertEqual(m.start(1), -1)

    def test_repeated_group_keeps_last(self):
        m = rex.compile(r"(ab)+").search("abab")
        self.assertEqual(m.group(0), "abab")
        self.assertEqual(m.group(1), "ab")

    def test_repeated_group_last_iteration(self):
        m = rex.compile(r"(a|b)+").search("ab")
        self.assertEqual((m.group(0), m.group(1)), ("ab", "b"))

    def test_bad_group_number_raises(self):
        m = rex.compile(r"(a)").search("a")
        with self.assertRaises(IndexError):
            m.group(2)

    def test_quantified_group_backtracks(self):
        self.assertEqual(S(r"(ab)+b", "ababb"), "ababb")


class Alternation(unittest.TestCase):
    def test_simple(self):
        self.assertEqual(S("cat|dog", "hotdog"), "dog")

    def test_prefers_left(self):
        self.assertEqual(S("a|ab", "ab"), "a")

    def test_backtracks_into_second_branch(self):
        self.assertEqual(S("(a|ab)c", "abc"), "abc")

    def test_lowest_precedence(self):
        self.assertEqual(S("^ab|cd$", "cd"), "cd")

    def test_alternation_inside_group(self):
        self.assertEqual(S("x(a|b)y", "xby"), "xby")

    def test_empty_branch(self):
        self.assertEqual(S("(a|)b", "b"), "b")


class Anchors(unittest.TestCase):
    def test_caret(self):
        self.assertEqual(S("^ab", "abc"), "ab")
        self.assertIsNone(S("^bc", "abc"))

    def test_dollar(self):
        self.assertEqual(S("bc$", "abc"), "bc")
        self.assertIsNone(S("ab$", "abc"))

    def test_both(self):
        self.assertEqual(S("^abc$", "abc"), "abc")
        self.assertIsNone(S("^abc$", "abcd"))

    def test_dollar_not_multiline(self):
        self.assertIsNone(S("a$", "a\nb"))

    def test_anchor_with_star(self):
        m = rex.compile("^a*$").search("")
        self.assertEqual(m.group(0), "")


class MatchVsSearch(unittest.TestCase):
    def test_match_is_anchored_at_zero(self):
        self.assertIsNotNone(rex.compile("ab").match("abc"))
        self.assertIsNone(rex.compile("bc").match("abc"))

    def test_search_is_not(self):
        self.assertIsNotNone(rex.compile("bc").search("abc"))

    def test_match_need_not_reach_end(self):
        m = rex.compile("ab").match("abcdef")
        self.assertEqual((m.group(0), m.end()), ("ab", 2))


class FindAll(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(rex.compile(r"\d+").findall("a1b22c333"), ["1", "22", "333"])

    def test_non_overlapping(self):
        self.assertEqual(rex.compile("aa").findall("aaaa"), ["aa", "aa"])

    def test_empty_matches_advance(self):
        self.assertEqual(rex.compile("a*").findall("bab"), ["", "a", "", ""])

    def test_no_matches(self):
        self.assertEqual(rex.compile(r"\d").findall("abc"), [])

    def test_findall_returns_whole_match(self):
        self.assertEqual(rex.compile(r"(a)(b)").findall("abab"), ["ab", "ab"])


class Errors(unittest.TestCase):
    def test_unbalanced_parens(self):
        for p in ["(ab", "ab)", "((a)", "(?:a"]:
            with self.subTest(p=p):
                with self.assertRaises(rex.RegexError):
                    rex.compile(p)

    def test_unterminated_class(self):
        for p in ["[abc", "[a-"]:
            with self.subTest(p=p):
                with self.assertRaises(rex.RegexError):
                    rex.compile(p)

    def test_nothing_to_repeat(self):
        for p in ["*ab", "+a", "?a", "a|*b", "(*a)"]:
            with self.subTest(p=p):
                with self.assertRaises(rex.RegexError):
                    rex.compile(p)

    def test_bad_counted_repetition(self):
        for p in ["a{2,1}", "a{3,2}"]:
            with self.subTest(p=p):
                with self.assertRaises(rex.RegexError):
                    rex.compile(p)

    def test_trailing_backslash(self):
        with self.assertRaises(rex.RegexError):
            rex.compile("ab\\")

    def test_regexerror_is_exception(self):
        self.assertTrue(issubclass(rex.RegexError, Exception))


class Integration(unittest.TestCase):
    def test_email_ish(self):
        m = rex.compile(r"([\w.]+)@([\w]+)\.([a-z]{2,4})").search("mail me at a.b@example.com ok")
        self.assertEqual(m.group(0), "a.b@example.com")
        self.assertEqual(m.groups(), ("a.b", "example", "com"))

    def test_date_ish(self):
        m = rex.compile(r"(\d{4})-(\d{2})-(\d{2})").search("on 2026-09-05.")
        self.assertEqual(m.groups(), ("2026", "09", "05"))

    def test_quoted_string_lazy(self):
        self.assertEqual(S(r'"[^"]*"', 'say "hi" and "bye"'), '"hi"')

    def test_nested_quantified_group(self):
        self.assertEqual(S(r"(a+b)+", "aabaab"), "aabaab")

    def test_catastrophic_shape_terminates(self):
        self.assertIsNone(S("(a+)+b", "aaaaaaaaaaaaac"))


class Import(unittest.TestCase):
    def test_no_stdout_at_import(self):
        import io, contextlib, importlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            importlib.reload(rex)
        self.assertEqual(buf.getvalue(), "")

    def test_does_not_use_re_module(self):
        import inspect, os
        src = inspect.getsource(rex)
        self.assertNotIn("import re", src.replace("import rex", ""))


if __name__ == "__main__":
    unittest.main(verbosity=2)
