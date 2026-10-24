# Task: `sheet.py` — a mini spreadsheet formula engine

Implement a single module `sheet.py` in the repository root. Pure Python 3
standard library only. No third-party packages. No network.

## Public API

```python
class CircularReference(Exception): ...

class Sheet:
    def set(self, ref: str, raw: str) -> None: ...
    def get(self, ref: str) -> float | str: ...
```

* `set(ref, raw)` stores the *raw* string a user typed into a cell.
  `ref` is a cell reference such as `"A1"`, `"b2"` (case-insensitive), `"AB12"`.
* `get(ref)` returns the *evaluated* value of that cell, recomputed from the
  current state of the sheet every time it is called (no stale caching).

## Cell content rules

A raw string is classified as:

1. **Empty** — `""` or whitespace only. `get` returns `0.0`.
   An unset cell is also empty.
2. **Formula** — starts with `=` (after stripping surrounding whitespace).
   `get` returns the evaluated `float`.
3. **Number** — the whole raw string parses as a Python float
   (`"12"`, `" -3.5 "`, `"1e3"`). `get` returns that `float`.
4. **Text** — anything else. `get` returns the raw string **stripped of
   surrounding whitespace**.

## Formula grammar

```
expr    := term (("+" | "-") term)*
term    := factor (("*" | "/") factor)*
factor  := "-" factor | primary
primary := NUMBER | FUNC "(" args ")" | REF | "(" expr ")"
args    := arg ("," arg)*
arg     := RANGE | expr
REF     := [A-Za-z]+[0-9]+
RANGE   := REF ":" REF
FUNC    := SUM | AVG | MIN | MAX | COUNT      (case-insensitive)
NUMBER  := standard decimal / scientific float literal
```

* All whitespace inside a formula is insignificant.
* Standard precedence: unary minus binds tighter than `*` `/`, which bind
  tighter than `+` `-`. Parentheses override.
* Column letters are base-26 bijective: `A`..`Z`, `AA`, `AB`, ... Rows are
  1-based positive integers.

## Evaluation semantics

* A **reference to an empty cell** evaluates to `0.0`.
* A **reference to a text cell** used in arithmetic raises `TypeError`.
* **Division by zero** raises `ZeroDivisionError`.
* A reference cycle (direct or indirect, including a cell referring to itself)
  raises `CircularReference`.
* A malformed formula raises `ValueError`.
* A malformed `ref` passed to `set` or `get` raises `ValueError`.

## Range functions

A `RANGE` argument expands to every cell in the rectangle between its two
corners. Corner order does not matter: `A3:B1` covers the same cells as
`A1:B3`.

Within range aggregation:

* Empty cells are **skipped**.
* Text cells are **skipped** (they do *not* raise inside a range).
* Formula cells contribute their numeric value.

| Function | Behaviour |
|---|---|
| `SUM`   | sum of contributing values; `0.0` if none |
| `AVG`   | mean of contributing values; `0.0` if none |
| `MIN`   | minimum; `0.0` if none |
| `MAX`   | maximum; `0.0` if none |
| `COUNT` | how many cells contributed (a count, always a float) |

Functions also accept plain scalar expression arguments and may mix them with
ranges: `=SUM(A1:A3, 10, B1*2)`. Scalar arguments are **never** skipped — a
scalar argument that resolves to a text cell raises `TypeError`.

## Return types

Every numeric result is a `float`. `COUNT` returns a `float`.

## Done means

`python3 -m unittest discover -s tests -v` passes, and the module imports
cleanly with no side effects at import time.
