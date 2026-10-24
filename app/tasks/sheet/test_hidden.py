"""Hidden grading suite. Never shown to the agent. One assert-cluster per test."""
import math
import unittest

from sheet import Sheet, CircularReference


def S(**cells):
    s = Sheet()
    for ref, raw in cells.items():
        s.set(ref, raw)
    return s


class Literals(unittest.TestCase):
    def test_unset_cell_is_zero(self):
        self.assertEqual(Sheet().get("A1"), 0.0)

    def test_empty_and_whitespace_are_zero(self):
        s = S(A1="", A2="   ")
        self.assertEqual(s.get("A1"), 0.0)
        self.assertEqual(s.get("A2"), 0.0)

    def test_number_literals(self):
        s = S(A1="12", A2=" -3.5 ", A3="1e3")
        self.assertEqual(s.get("A1"), 12.0)
        self.assertEqual(s.get("A2"), -3.5)
        self.assertEqual(s.get("A3"), 1000.0)

    def test_number_returns_float_type(self):
        self.assertIsInstance(S(A1="12").get("A1"), float)

    def test_text_is_stripped(self):
        self.assertEqual(S(A1="  hello  ").get("A1"), "hello")

    def test_ref_is_case_insensitive(self):
        s = S(a1="5")
        self.assertEqual(s.get("A1"), 5.0)
        self.assertEqual(s.get("a1"), 5.0)


class Arithmetic(unittest.TestCase):
    def test_addition_and_subtraction(self):
        self.assertEqual(S(A1="=1+2-4").get("A1"), -1.0)

    def test_precedence(self):
        self.assertEqual(S(A1="=2+3*4").get("A1"), 14.0)

    def test_parentheses(self):
        self.assertEqual(S(A1="=(2+3)*4").get("A1"), 20.0)

    def test_unary_minus_binds_tighter_than_mul(self):
        self.assertEqual(S(A1="=-2*3").get("A1"), -6.0)

    def test_double_unary_minus(self):
        self.assertEqual(S(A1="=--5").get("A1"), 5.0)

    def test_whitespace_is_insignificant(self):
        self.assertEqual(S(A1="=  1 +   2 * ( 3 - 1 ) ").get("A1"), 5.0)

    def test_division(self):
        self.assertAlmostEqual(S(A1="=7/2").get("A1"), 3.5)

    def test_division_by_zero_raises(self):
        with self.assertRaises(ZeroDivisionError):
            S(A1="=1/0").get("A1")

    def test_division_by_empty_cell_raises(self):
        with self.assertRaises(ZeroDivisionError):
            S(A1="=1/B9").get("A1")

    def test_formula_returns_float_type(self):
        self.assertIsInstance(S(A1="=1+1").get("A1"), float)


class References(unittest.TestCase):
    def test_simple_reference(self):
        self.assertEqual(S(A1="4", B1="=A1*2").get("B1"), 8.0)

    def test_chained_references(self):
        s = S(A1="2", A2="=A1+1", A3="=A2*10")
        self.assertEqual(s.get("A3"), 30.0)

    def test_reference_to_empty_is_zero(self):
        self.assertEqual(S(A1="=Z99+5").get("A1"), 5.0)

    def test_reference_to_text_in_arithmetic_raises(self):
        with self.assertRaises(TypeError):
            S(A1="hello", B1="=A1+1").get("B1")

    def test_no_stale_cache(self):
        s = S(A1="1", B1="=A1*10")
        self.assertEqual(s.get("B1"), 10.0)
        s.set("A1", "3")
        self.assertEqual(s.get("B1"), 30.0)

    def test_multiletter_columns(self):
        s = S(AA1="7", AB1="=AA1+1")
        self.assertEqual(s.get("AB1"), 8.0)

    def test_lowercase_refs_inside_formula(self):
        self.assertEqual(S(A1="3", B1="=a1*a1").get("B1"), 9.0)


class Cycles(unittest.TestCase):
    def test_self_reference(self):
        with self.assertRaises(CircularReference):
            S(A1="=A1").get("A1")

    def test_direct_cycle(self):
        s = S(A1="=B1", B1="=A1")
        with self.assertRaises(CircularReference):
            s.get("A1")

    def test_indirect_cycle(self):
        s = S(A1="=B1+1", B1="=C1+1", C1="=A1+1")
        with self.assertRaises(CircularReference):
            s.get("B1")

    def test_cycle_via_range(self):
        s = S(A1="=SUM(A1:A3)", A2="1", A3="2")
        with self.assertRaises(CircularReference):
            s.get("A1")

    def test_sheet_usable_after_cycle_broken(self):
        s = S(A1="=B1", B1="=A1")
        with self.assertRaises(CircularReference):
            s.get("A1")
        s.set("B1", "5")
        self.assertEqual(s.get("A1"), 5.0)


class RangeFunctions(unittest.TestCase):
    def setUp(self):
        self.s = S(A1="1", A2="2", A3="3", B1="10", B2="", B3="text")

    def test_sum_range(self):
        self.assertEqual(S(A1="1", A2="2", A3="3", C1="=SUM(A1:A3)").get("C1"), 6.0)

    def test_sum_skips_empty_and_text(self):
        self.s.set("C1", "=SUM(B1:B3)")
        self.assertEqual(self.s.get("C1"), 10.0)

    def test_avg_skips_empty_and_text(self):
        self.s.set("C1", "=AVG(A1:B3)")
        self.assertAlmostEqual(self.s.get("C1"), 16.0 / 4.0)

    def test_count_counts_contributors(self):
        self.s.set("C1", "=COUNT(A1:B3)")
        self.assertEqual(self.s.get("C1"), 4.0)

    def test_count_returns_float(self):
        self.s.set("C1", "=COUNT(A1:A3)")
        self.assertIsInstance(self.s.get("C1"), float)

    def test_min_and_max(self):
        self.s.set("C1", "=MIN(A1:B3)")
        self.s.set("C2", "=MAX(A1:B3)")
        self.assertEqual(self.s.get("C1"), 1.0)
        self.assertEqual(self.s.get("C2"), 10.0)

    def test_empty_range_aggregates_to_zero(self):
        s = S(C1="=SUM(X1:Y5)", C2="=AVG(X1:Y5)", C3="=MIN(X1:Y5)",
              C4="=MAX(X1:Y5)", C5="=COUNT(X1:Y5)")
        for ref in ("C1", "C2", "C3", "C4", "C5"):
            self.assertEqual(s.get(ref), 0.0, ref)

    def test_reversed_corners(self):
        s = S(A1="1", A2="2", A3="3", B1="4", B2="5", B3="6")
        s.set("D1", "=SUM(B3:A1)")
        s.set("D2", "=SUM(A1:B3)")
        self.assertEqual(s.get("D1"), 21.0)
        self.assertEqual(s.get("D1"), s.get("D2"))

    def test_single_cell_range(self):
        self.assertEqual(S(A1="9", C1="=SUM(A1:A1)").get("C1"), 9.0)

    def test_function_case_insensitive(self):
        self.assertEqual(S(A1="1", A2="2", C1="=sUm(A1:A2)").get("C1"), 3.0)

    def test_mixed_scalar_and_range_args(self):
        s = S(A1="1", A2="2", A3="3", B1="5")
        s.set("C1", "=SUM(A1:A3, 10, B1*2)")
        self.assertEqual(s.get("C1"), 26.0)

    def test_scalar_text_arg_raises(self):
        s = S(A1="text")
        s.set("C1", "=SUM(A1, 1)")
        with self.assertRaises(TypeError):
            s.get("C1")

    def test_nested_functions(self):
        s = S(A1="1", A2="2", A3="3", B1="4", B2="5")
        s.set("C1", "=MAX(SUM(A1:A3), AVG(B1:B2))")
        self.assertEqual(s.get("C1"), 6.0)

    def test_function_result_in_arithmetic(self):
        s = S(A1="1", A2="2", C1="=SUM(A1:A2)*3+1")
        self.assertEqual(s.get("C1"), 10.0)


class Errors(unittest.TestCase):
    def test_malformed_formula_raises_value_error(self):
        for bad in ("=1+", "=(1+2", "=*3", "=1++", "=SUM(", "=FOO(A1:A2)", "=SUM(A1:)", "=1,2", "=Q1(2)"):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    S(A1=bad).get("A1")

    def test_bad_ref_to_set_raises(self):
        for bad in ("1A", "A", "1", "A0", "", "A1:B2"):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    Sheet().set(bad, "1")

    def test_bad_ref_to_get_raises(self):
        with self.assertRaises(ValueError):
            Sheet().get("$$")

    def test_circular_reference_is_an_exception_subclass(self):
        self.assertTrue(issubclass(CircularReference, Exception))


class Import(unittest.TestCase):
    def test_module_has_no_stdout_side_effects(self):
        import io, contextlib, importlib, sheet
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            importlib.reload(sheet)
        self.assertEqual(buf.getvalue(), "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
