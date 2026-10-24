# refactor-pricing

**Activity:** refactor without changing behaviour. **Artifact:** `pricing/quote.py`.

Three quote functions repeat the same discount, tax and rounding code. The visible tests pass before and after;
the work is to make that code exist once.

**Correct** when every item below passes. **Accuracy** is the share that pass (9 items):

- behaviour: the visible suite passes, and each function returns exactly what the original returned on 300 random
  inputs (4);
- interface: the three signatures are unchanged (1);
- structure, read from the syntax tree: one `round()` call, one use of `TAX_RATE`, one `(1 - discount)`, and a
  helper all three functions call (4).

Editing `tests/test_quote.py` scores 0. The reference `solution/` scores 1.0; the untouched project 0.56 (behaviour
right, duplication still there); sharing only the rounding 0.78.

    opt claude example refactor-pricing --repeats 3
