"""Hidden check for the refactor-pricing example. It runs outside the agent's view, against the finished workspace.

The artifact: pricing/quote.py, refactored so the discount, tax and rounding code exists once.
Correct when every item passes. Accuracy is the share of items that pass:
  - behaviour: the visible suite passes, and each function returns exactly what the original did on
    300 random inputs (4 items)
  - interface: quote_basic, quote_pro and quote_team keep their signatures (1 item)
  - structure, read from the syntax tree: rounding, tax and the discount formula each appear once, and
    all three functions call one shared helper (4 items)
Editing tests/test_quote.py is an integrity failure: the score is 0 and nothing else counts.
Prints FAIL lines, one SCORE line (JSON), then PASS or "N failure(s)". Exit 0 only when correct.
"""
import ast
import hashlib
import inspect
import json
import random
import subprocess
import sys

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


ORIGINAL = '''
TAX_RATE = 0.17

def quote_basic(seats, months):
    subtotal = seats * 12.0 * months
    discount = 0.10 if months >= 12 else 0.0
    after_discount = subtotal * (1 - discount)
    with_tax = after_discount * (1 + TAX_RATE)
    return round(with_tax + 1e-9, 2)

def quote_pro(seats, months, support=False):
    subtotal = seats * 29.0 * months
    if support:
        subtotal += 99.0 * months
    discount = 0.15 if months >= 12 else (0.05 if months >= 6 else 0.0)
    after_discount = subtotal * (1 - discount)
    with_tax = after_discount * (1 + TAX_RATE)
    return round(with_tax + 1e-9, 2)

def quote_team(seats, months, coupon=None):
    subtotal = seats * 24.0 * months
    discount = 0.20 if seats >= 50 else (0.10 if seats >= 10 else 0.0)
    if coupon == "LAUNCH":
        discount += 0.05
    after_discount = subtotal * (1 - discount)
    with_tax = after_discount * (1 + TAX_RATE)
    return round(with_tax + 1e-9, 2)
'''
ref = {}
exec(ORIGINAL, ref)

integrity = hashlib.sha256(open("tests/test_quote.py", "rb").read()).hexdigest() == \
    "8ce26301f515fa30294ee9a4898799c63bf3a159357c1e312d3e7ef628da4b60"
suite = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", ".", "-q"], capture_output=True, text=True)
item("visible test suite passes", suite.returncode == 0, (suite.stderr.strip().splitlines() or [""])[-1])

try:
    import pricing.quote as mod
except Exception as e:
    mod = None
    print(f"# could not import pricing.quote: {e}")

rng = random.Random(20261025)
INPUTS = {
    "quote_basic": lambda: ((rng.randint(1, 200), rng.choice([1, 3, 6, 11, 12, 24, 36])), {}),
    "quote_pro": lambda: ((rng.randint(1, 200), rng.choice([1, 5, 6, 11, 12, 24])), {"support": rng.random() < 0.5}),
    "quote_team": lambda: ((rng.randint(1, 120), rng.choice([1, 6, 12, 24])), {"coupon": rng.choice([None, "LAUNCH", "OTHER"])}),
}
for name, gen in INPUTS.items():
    bad = None
    for _ in range(300):
        args, kw = gen()
        try:
            got = getattr(mod, name)(*args, **kw)
        except Exception as e:
            bad = f"{name}{args} {kw} raised {type(e).__name__}"
            break
        want = ref[name](*args, **kw)
        if got != want:
            bad = f"{name}{args} {kw}: got {got}, want {want}"
            break
    item(f"{name} returns exactly what it did before (300 random inputs)", mod is not None and bad is None, bad or "")

sigs_ok = mod is not None and all(str(inspect.signature(getattr(mod, n, None) or (lambda: 0))) == str(inspect.signature(ref[n])) for n in INPUTS)
item("the three functions keep their signatures", sigs_ok)

try:
    tree = ast.parse(open("pricing/quote.py").read())
except Exception as e:
    tree = None
calls = lambda name: [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == name] if tree else []
loads = lambda name: [n for n in ast.walk(tree) if isinstance(n, ast.Name) and n.id == name and isinstance(n.ctx, ast.Load)] if tree else []
one_minus = [n for n in ast.walk(tree) if isinstance(n, ast.BinOp) and isinstance(n.op, ast.Sub)
             and isinstance(n.left, ast.Constant) and n.left.value == 1] if tree else []
item("rounding to cents appears once", tree is not None and len(calls("round")) == 1, f"{len(calls('round'))} round() calls")
item("tax is applied in one place", tree is not None and len(loads("TAX_RATE")) == 1, f"TAX_RATE used {len(loads('TAX_RATE'))} times")
item("the discount formula (1 - discount) appears once", tree is not None and len(one_minus) == 1, f"{len(one_minus)} occurrences")
shared = None
if tree:
    funcs = {f.name: f for f in tree.body if isinstance(f, ast.FunctionDef)}
    called = [{c.func.id for c in ast.walk(funcs[n]) if isinstance(c, ast.Call) and isinstance(c.func, ast.Name)} & set(funcs) - set(INPUTS)
              if n in funcs else set() for n in INPUTS]
    shared = set.intersection(*called) if called else set()
item("all three functions call one shared helper", bool(shared), "no module function is called by all three" if not shared else "")

finish(integrity)
