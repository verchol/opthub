# Engineering context for this repo

This is a single-module Python library. Read this file before touching anything;
it is the grounded context for the repo and saves you from exploring.

## Layout (do not invent other locations)
- `sheet.py`         — the one module you implement. Repo root. Nothing else ships.
- `tests/`           — your unittest files, discovered by `unittest discover -s tests`.
- `SPEC.md`          — the authoritative requirements. It is complete; if the spec
                       and your intuition disagree, the spec wins.
- `./factory`        — the repo CLI. Every check runs through it. See below.

## Conventions
- Python 3 standard library only. No third-party imports, no network, no I/O at
  import time (importing `sheet` must print nothing and touch no files).
- Public surface is exactly `Sheet` and `CircularReference`. Everything else is
  private and prefixed with `_`.
- Every numeric result is a `float`, never an `int`.
- Errors are raised, never returned as sentinel strings.

## The repo CLI — use it instead of ad-hoc commands
`./factory` batches every check into one process so you spend one tool call, not
six. Do not run `python3 -m unittest`, `python3 -c ...`, or `ruff` directly.

    ./factory verify        # syntax + import purity + public API + your tests + smoke matrix
    ./factory smoke         # just the fast spec smoke matrix
    ./factory tests         # just your tests under tests/

`./factory verify` prints a single machine-readable summary block. Read that
block; do not re-run individual checks to find out what it already told you.

## Definition of done
`./factory verify` exits 0 with zero failures, and the reviewer subagent has
signed off on a diff-level pass. Both, not either.

## Known traps in this spec (institutional knowledge — these are the bugs that
## historically get shipped here)
1. Whitespace inside a formula is insignificant, so `"= 1 + 2"` is valid. But a
   raw cell of `" -3.5 "` is a *number*, not text — strip before classifying.
2. `-2*3` is `-6`: unary minus binds tighter than `*`, so parse it in `factor`.
3. Range aggregation *skips* empty and text cells; a *scalar* argument that is a
   text cell *raises* `TypeError`. Same value, two different behaviours by position.
4. Corner order in a range is free: `A3:B1` == `A1:B3`. Normalise with min/max.
5. Cycle detection must be per-evaluation, not a persistent flag — after the cycle
   is broken by a later `set`, the sheet must work again.
6. `get` must never serve a cached value. Recompute every call.
7. Column letters are bijective base-26: `Z`=26, `AA`=27.
8. Empty-range `MIN`/`MAX`/`AVG` are `0.0`, not an exception and not `inf`.
