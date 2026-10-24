# opt claude -p examples

Each example is the same input run two ways, then audited:

    opt claude example [name] [--repeats 3]

- **plain**: `claude -p` as you would run it.
- **optimize mode**: the same `claude -p` behind the LLM Ultra Light gateway, on the project's profile rung.

Both sides run in the local Docker sandbox, from the same read-only tree, on the same model and the same kind of credential. Each side gets a one-turn cache warm-up first. A hidden check, kept outside the agent's view, grades every result. Then `lib/claims.mjs` checks every claim the comparison makes against the evidence the run left on disk: never against the summary it printed.

An example is a directory with:

| file | what it is |
| --- | --- |
| `project/` | the source tree the agent works on (mounted read-only; each run edits its own copy) |
| `task.md` | the input, identical for both sides |
| `check.py` | the hidden check: exit 0 means the result is right |
| `audited-run/` | the last run we pinned: `run.json`, `claims.json`, `claims.md` |
