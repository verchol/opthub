# spec-parse-duration

**Activity:** build a feature from a written spec. **Artifact:** `durations/parse.py` (`parse_duration`).

`SPEC.md` describes duration strings (`1h30m`, `2d 4h`, `90`, `1.5h`) and the inputs that must raise `ValueError`.
Six visible tests fail until the function exists.

**Correct** when every item below passes. **Accuracy** is the share that pass (25 items):

- the visible test suite passes (1);
- 24 cases from the spec the agent never sees: 12 valid inputs with their exact seconds, 12 invalid ones that must
  raise `ValueError` (24).

Editing `tests/test_parse.py` scores 0. The reference `solution/` scores 1.0; the untouched project 0.

    opt claude example spec-parse-duration --repeats 3
