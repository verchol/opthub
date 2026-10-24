# tests-rate-limiter

**Activity:** write tests for existing code. **Artifact:** `tests/test_bucket.py`.

`ratelimit.TokenBucket` works and has no tests. The agent writes them.

**Correct** when every item below passes. **Accuracy** is the share that pass (10 items):

- the test file exists and defines tests (1);
- the tests pass on the real `TokenBucket` (1);
- mutation score: 8 bugs are planted one at a time, each breaking one behaviour the docstring describes
  (uncapped refill, no token taken, `<` for `<=`, rate ignored, a refusal that empties the bucket, negative cost
  accepted, starting empty, a backwards clock adding tokens). The tests must fail on each (8).

Editing `ratelimit/bucket.py` scores 0. The reference `solution/` scores 1.0; a one-test suite scores 0.5; no tests 0.

    opt claude example tests-rate-limiter --repeats 3
