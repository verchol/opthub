# Task: `roman.py`

Implement `roman.py` in this directory. Python 3 standard library only.

```python
def to_roman(n: int) -> str: ...
def from_roman(s: str) -> int: ...
```

## Rules

* `to_roman` accepts `1..3999` and returns standard uppercase Roman numerals
  using subtractive notation: `4` is `IV` (not `IIII`), `9` is `IX`, `40` is
  `XL`, `90` is `XC`, `400` is `CD`, `900` is `CM`.
* `to_roman` raises `ValueError` outside `1..3999`, and for a non-integer.
* `from_roman` accepts a valid uppercase numeral and returns its integer value.
* `from_roman` raises `ValueError` for an invalid numeral — an unknown letter,
  a bad repeat such as `IIII` or `VV`, or an illegal subtraction such as `IL`.
* Round trip: `from_roman(to_roman(n)) == n` for every `n` in range.

Keep it short. Write tests under `tests/`.
Work autonomously. Print DONE when finished.
