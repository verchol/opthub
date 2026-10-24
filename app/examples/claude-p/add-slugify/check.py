"""Hidden check for the add-slugify example. It runs outside the agent's view, against the finished workspace.

Passes when: the visible tests were not edited, the whole suite passes, and ten cases the agent never
saw hold. Each case follows from slugify's docstring alone.
"""
import hashlib
import subprocess
import sys

sys.path.insert(0, ".")
failures = []

if hashlib.sha256(open("tests/test_slug.py", "rb").read()).hexdigest() != "8011b6ed9406042b202bf674db70cd2d31a62fb2aa545d59510878d880bead23":
    failures.append("tests/test_slug.py was edited")

suite = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-q"], capture_output=True, text=True)
if suite.returncode != 0:
    failures.append("the test suite fails: " + suite.stderr.strip().splitlines()[-1])

try:
    from textkit.slug import slugify
    cases = [
        (slugify("Ångström 2026"), "angstrom-2026", "accents beyond the visible test"),
        (slugify("--Leading and trailing--"), "leading-and-trailing", "no dash at either end"),
        (slugify("a_b.c/d"), "a-b-c-d", "underscore, dot and slash are separators"),
        (slugify("abcdefghij", max_length=4), "abcd", "no separator to cut at: cut exactly"),
        (slugify("one two", max_length=7), "one-two", "an exact fit is not cut"),
        (slugify("ab cd", max_length=2), "ab", "a separator right at the limit"),
        (slugify("日本語"), "untitled", "no ASCII letters or digits"),
        (slugify("Hello\u2014World"), "hello-world", "a non-ASCII dash is a separator, not deleted"),
        (slugify("Cre\u0300me"), "creme", "an accent stored as a combining mark still folds"),
        (slugify("x\u00b2 + y\u00b2"), "x-y", "a superscript is not an accented letter: a separator"),
    ]
    for got, want, what in cases:
        if got != want:
            failures.append(f"{what}: got {got!r}, want {want!r}")
except Exception as e:  # an import error or NotImplementedError is a failure, not a crash
    failures.append(f"could not run the hidden cases: {e!r}")

for f in failures:
    print("FAIL", f)
print("PASS" if not failures else f"{len(failures)} failure(s)")
sys.exit(1 if failures else 0)
