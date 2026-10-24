# opt claude -p examples

Each example is the same input run two ways, then audited:

    opt claude example [name] [--repeats 3]

- **plain**: `claude -p` as you would run it.
- **optimize mode**: the same `claude -p` behind the LLM Ultra Light gateway, on the project's profile rung.

Both sides run in the local Docker sandbox, from the same read-only tree, on the same model and the same kind of credential. Each side gets a one-turn cache warm-up first. A hidden check, kept outside the agent's view, grades every result. Then `lib/claims.mjs` checks every claim the comparison makes against the evidence the run left on disk: never against the summary it printed.

Examples, one per kind of coding work, each with one clear artifact:

| example | activity | the artifact | scored |
| --- | --- | --- | --- |
| `fix-invoice` | fix bugs | `invoice/totals.py` | pass/fail |
| `add-slugify` | build a function from its docstring | `textkit/slug.py` | pass/fail |
| `speed-dedupe` | make code fast without changing its output | `ledger/merge.py` | pass/fail |
| `spec-parse-duration` | build a feature from a written spec | `durations/parse.py` | 25 items |
| `tests-rate-limiter` | write tests for existing code | `tests/test_bucket.py` | 10 items (mutation score) |
| `refactor-pricing` | refactor without changing behaviour | `pricing/quote.py` | 9 items |
| `rename-tax-api` | change an API across files | `shop/`, `README.md` | 10 items |

`evals/claude_p.py` runs all of them as evals.

## Correctness and accuracy

A scored check grades a list of items: behaviour the hidden cases pin down, the interface, the structure of the
code, the docs, whatever the activity's artifact must get right. It prints one line,

    SCORE {"correct": true, "accuracy": 0.96, "passed": 24, "total": 25, "integrity": true}

- **Correct**: every item passes. This is the check's exit code, and what the comparison's verdict uses.
- **Accuracy**: the share of items that pass, 0 to 1. It says how close a result that is not correct came, and
  separates two results that both fail.
- **Integrity**: editing what the task says not to touch (the visible tests, or the code under test) scores 0,
  because nothing else in that result can be trusted.

`opt claude -p` reads the line from each run's `check/check.log`; the report's quality axis then counts items right,
and its summary gives the median accuracy per side. `evals/claude_p.py` adds an accuracy column, and counts optimize
mode as doing the same job only if its median accuracy is no lower than plain's. A pass/fail check (the first three)
shows no accuracy.

Each scored example's `solution/` scores 1.0 and its untouched `project/` does not;
`evals/claude_p.py preflight` checks both.

An example is a directory with:

| file | what it is |
| --- | --- |
| `project/` | the source tree the agent works on (mounted read-only; each run edits its own copy) |
| `task.md` | the input, identical for both sides |
| `check.py` | the hidden check: exit 0 means the result is right |
| `solution/` | a reference fix laid over `project/`; `evals/claude_p.py preflight` proves the check fails without it and passes with it |
| `audited-run/` | the last run we pinned: `run.json`, `claims.json`, `claims.md` |
