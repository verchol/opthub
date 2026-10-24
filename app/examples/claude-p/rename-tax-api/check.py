"""Hidden check for the rename-tax-api example. It runs outside the agent's view, against the finished workspace.

The artifact: the rename of shop.tax.calc_tax to compute_tax across the project, with a deprecated alias.
Correct when every item passes. Accuracy is the share of items that pass:
  - behaviour: the visible suite passes; compute_tax returns what calc_tax did on 60 random inputs; the
    alias warns and returns the same; the CLI and invoice output are unchanged and use no deprecated call (5 items)
  - the rename itself: each caller (cart.py, invoice.py, cli.py) uses compute_tax (3 items)
  - docs: the README names compute_tax, and mentions calc_tax only as deprecated (2 items)
Editing tests/test_shop.py is an integrity failure: the score is 0 and nothing else counts.
Prints FAIL lines, one SCORE line (JSON), then PASS or "N failure(s)". Exit 0 only when correct.
"""
import hashlib
import json
import os
import random
import re
import subprocess
import sys
import warnings

sys.path.insert(0, ".")
ITEMS = []


def item(name, ok, detail=""):
    ITEMS.append((name, bool(ok), detail))


def finish(integrity):
    passed = sum(ok for _, ok, _ in ITEMS)
    accuracy = passed / len(ITEMS) if (integrity and ITEMS) else 0.0
    correct = integrity and passed == len(ITEMS)
    if not integrity:
        print("FAIL integrity: the visible tests were edited, so nothing else counts")
    for name, ok, detail in ITEMS:
        if not ok:
            print("FAIL", name + (f": {detail}" if detail else ""))
    print("SCORE " + json.dumps({"correct": correct, "accuracy": round(accuracy, 4), "passed": passed if integrity else 0,
                                 "total": len(ITEMS), "integrity": integrity}))
    failures = len(ITEMS) - passed + (0 if integrity else 1)
    print("PASS" if correct else f"{failures} failure(s)")
    sys.exit(0 if correct else 1)


RATES = {"CA": 0.0725, "NY": 0.04, "TX": 0.0625, "OR": 0.0}
original = lambda amount, region: round(amount * RATES.get(region, 0.0) + 1e-9, 2)

integrity = hashlib.sha256(open("tests/test_shop.py", "rb").read()).hexdigest() == \
    "989b396042a26f206b39d8d6e51f0aeb11260df7c1eea3e419c48726dcfe5ef6"
suite = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", ".", "-q"], capture_output=True, text=True)
item("visible test suite passes", suite.returncode == 0, (suite.stderr.strip().splitlines() or [""])[-1])

try:
    from shop import tax
except Exception as e:
    tax = None
rng = random.Random(7)
bad = None
for _ in range(60):
    amount, region = round(rng.uniform(0, 5000), 2), rng.choice(["CA", "NY", "TX", "OR", "ZZ"])
    try:
        got = tax.compute_tax(amount, region)
    except Exception as e:
        bad = f"compute_tax({amount}, {region!r}) raised {type(e).__name__}"
        break
    if got != original(amount, region):
        bad = f"compute_tax({amount}, {region!r}) = {got}, was {original(amount, region)}"
        break
item("compute_tax returns what calc_tax did (60 random inputs)", tax is not None and bad is None, bad or "")

try:
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        same = tax.calc_tax(1234.5, "CA") == original(1234.5, "CA")
    item("calc_tax still works, warns DeprecationWarning", same and any(issubclass(x.category, DeprecationWarning) for x in w))
except Exception as e:
    item("calc_tax still works, warns DeprecationWarning", False, f"{type(e).__name__}: {e}")

strict = [sys.executable, "-W", "error::DeprecationWarning"]
cli = subprocess.run(strict + ["-m", "shop.cli", "100", "CA"], capture_output=True, text=True)
item("CLI prints the same tax and calls no deprecated name", cli.returncode == 0 and cli.stdout.strip() == "7.25",
     (cli.stdout.strip() or cli.stderr.strip().splitlines()[-1:] or [""])[0] if cli.returncode or cli.stdout.strip() != "7.25" else "")
inv = subprocess.run(strict + ["-c", "from shop.invoice import invoice_lines; print('|'.join(invoice_lines(200.0, 'NY')))"],
                     capture_output=True, text=True)
item("invoice output unchanged, no deprecated call", inv.returncode == 0 and inv.stdout.strip() == "subtotal  200.00|tax       8.00|total     208.00",
     inv.stdout.strip() or (inv.stderr.strip().splitlines()[-1:] or [""])[0])

for caller in ("shop/cart.py", "shop/invoice.py", "shop/cli.py"):
    try:
        src = open(caller).read()
        item(f"{caller} calls compute_tax", "compute_tax" in src and not re.search(r"\bcalc_tax\b", src))
    except OSError:
        item(f"{caller} calls compute_tax", False, "file missing")

readme = open("README.md").read() if os.path.exists("README.md") else ""
item("README names compute_tax", "compute_tax" in readme)
stale = [l for l in readme.splitlines() if re.search(r"\bcalc_tax\b", l) and "deprecat" not in l.lower()]
item("README mentions calc_tax only as deprecated", not stale, stale[0].strip() if stale else "")

finish(integrity)
