"""Hidden check for the tests-rate-limiter example. It runs outside the agent's view, against the finished workspace.

The artifact: tests/test_bucket.py, tests for ratelimit.TokenBucket.
Correct when every item passes. Accuracy is the share of items that pass:
  - tests/test_bucket.py exists and defines at least one test (1 item)
  - the tests pass on the real TokenBucket (1 item)
  - mutation score: 8 planted bugs, each one behaviour from the docstring broken; the tests must fail on each (8 items)
Editing ratelimit/bucket.py is an integrity failure: the score is 0 and nothing else counts.
Prints FAIL lines, one SCORE line (JSON), then PASS or "N failure(s)". Exit 0 only when correct.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ITEMS = []


def item(name, ok, detail=""):
    ITEMS.append((name, bool(ok), detail))


def finish(integrity):
    passed = sum(ok for _, ok, _ in ITEMS)
    accuracy = passed / len(ITEMS) if (integrity and ITEMS) else 0.0
    correct = integrity and passed == len(ITEMS)
    if not integrity:
        print("FAIL integrity: ratelimit/bucket.py was edited, so nothing else counts")
    for name, ok, detail in ITEMS:
        if not ok:
            print("FAIL", name + (f": {detail}" if detail else ""))
    print("SCORE " + json.dumps({"correct": correct, "accuracy": round(accuracy, 4), "passed": passed if integrity else 0,
                                 "total": len(ITEMS), "integrity": integrity}))
    failures = len(ITEMS) - passed + (0 if integrity else 1)
    print("PASS" if correct else f"{failures} failure(s)")
    sys.exit(0 if correct else 1)


SOURCE = "ratelimit/bucket.py"
original = open(SOURCE).read()
integrity = hashlib.sha256(original.encode()).hexdigest() == "bfeeec0e58236314bc8e3254c89312175ecb2fb081197fa02aa89bd6bfbfe828"


def run_tests(root):
    r = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", ".", "-q"],
                       cwd=root, capture_output=True, text=True, timeout=120)
    ran = re.search(r"Ran (\d+) test", r.stderr)
    return r.returncode, int(ran.group(1)) if ran else 0, (r.stderr.strip().splitlines() or [""])[-1]


exists = os.path.exists("tests/test_bucket.py")
code, ran, last = run_tests(".") if exists else (1, 0, "no tests/test_bucket.py")
item("tests/test_bucket.py exists and defines tests", exists and ran > 0, f"{ran} tests ran")
item("the tests pass on the real TokenBucket", exists and ran > 0 and code == 0, last)

MUTANTS = [
    ("refill is not capped at capacity", "self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)",
     "self.tokens = self.tokens + elapsed * self.rate"),
    ("an allowed request takes no tokens", "self.tokens -= cost", "pass"),
    ("exactly `cost` tokens is refused", "self.tokens < cost", "self.tokens <= cost"),
    ("the refill rate is ignored", "elapsed * self.rate)", "elapsed * self.capacity)"),
    ("a refused request still empties the bucket", "            return False\n        self.tokens -= cost",
     "            self.tokens = 0.0\n            return False\n        self.tokens -= cost"),
    ("a negative cost is accepted", 'raise ValueError("cost must not be negative")', "cost = 0"),
    ("the bucket starts empty", "self.tokens = float(capacity)", "self.tokens = 0.0"),
    ("a clock going backwards adds tokens", "elapsed = max(0.0, now - self.last)", "elapsed = abs(now - self.last)"),
]
for what, old, new in MUTANTS:
    if not (exists and ran and code == 0):
        item(f"catches: {what}", False, "the tests do not pass on the real code, so they catch nothing")
        continue
    assert original.count(old) == 1, f"mutant does not apply: {what}"
    with tempfile.TemporaryDirectory() as t:
        shutil.copytree(".", t, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__", ".git"))
        with open(os.path.join(t, SOURCE), "w") as fh:
            fh.write(original.replace(old, new))
        try:
            mcode, _, _ = run_tests(t)
        except subprocess.TimeoutExpired:
            mcode = 1                       # a hang under the bug counts as caught
        item(f"catches: {what}", mcode != 0, "the tests still pass with this bug planted")

finish(integrity)
