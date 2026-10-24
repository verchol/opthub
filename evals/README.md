# evals

Tests for the use cases in [`docs/use-cases.md`](../docs/use-cases.md): deterministic checks and
Claude-run evals, both on one synthetic workspace, both free.

| file | what |
|---|---|
| `fixture.py` | the workspace: four transcripts (three golden, one with a planted prompt and path), empty `HOME`, fake `.env`, no credentials, an egress trap |
| `test_usecases.py` | deterministic, one test per claim, named `test_ucNN_*`; fails if a run writes into `data/private/`, `app/results/` or `app/audit/` |
| `cases/EV-*.json` | eval cards: the commands that make the artifacts, the task, deterministic checks on the answer, the rubric, the pass threshold |
| `run.py` | `list`, `prepare`, `check`, `record`, `report`; work goes to `data/private/evals/<EV>/` (`OPTHUB_EVALS` moves it) |
| `RESULTS.md` | the last result of every card, written by `run.py report` |

```sh
python3 -m unittest evals/test_usecases.py -v
python3 evals/run.py prepare all
```

## Running an eval with Claude

1. `python3 evals/run.py prepare EV-03` writes `task.md`, `rubric.md`, `env.sh` and `artifacts/`.
2. **Answerer**: a fresh agent is given only `task.md`; it may run free commands after `source env.sh`
   and writes `answer.md`.
3. `python3 evals/run.py check EV-03`: the card's checks. `provenance` fails on any `$` figure, percentage or
   thousands-separated number that appears in no artifact (the repo's rule: every figure comes from a tool).
4. **Grader**: a second fresh agent, which never saw the answerer's work, is given `rubric.md`, verifies each
   claim against the artifacts, and writes `grade.json` (`{"R1": {"score": 0|0.5|1, "why": "…"}}`).
5. `python3 evals/run.py record EV-03`, then `report`.

A card passes when the weighted score (checks count 1 each, rubric items their weight) clears its threshold
and every critical check and criterion scores in full.

Even a careless answerer cannot spend: `env.sh` unsets every credential and points every proxy at a closed
port. The fixture is synthetic, so no figure in an answer may be quoted outside `evals/`.

## `opt claude -p --compare` evals (`claude_p.py`)

Live evals of optimize mode against plain `claude -p`, one per example in `app/examples/claude-p/`.
`run` spends (each case is `opt claude example <case> --repeats 3 --level balanced`, on your subscription);
everything else is free.

```sh
python3 evals/claude_p.py preflight          # Docker, credential, image; each case's check fails untouched, passes solution/
python3 evals/claude_p.py run all --yes      # spends
python3 evals/claude_p.py check all          # deterministic: finished, n >= 3, one model, hidden check, audit, no credential in files
python3 evals/claude_p.py blind all          # packet.md per case: each pair's diffs as A/B, shuffled; key.json kept back
#   a grader agent reads packet.md only and writes grade.json
python3 evals/claude_p.py record all && python3 evals/claude_p.py report    # -> CLAUDE-P-RESULTS.md
```

Optimize mode "does the same job" on a case when every deterministic check passes and the blind grader
prefers plain in no more than half the pairs. `--level` is pinned so a run never moves the project's rung.

## Adding a use case

Add its row to `docs/use-cases.md`, a `test_ucNN_*` for whatever has one right answer, and a card when a
person has to read the output to act on it. A card's rubric names what the artifacts actually show, so
re-check it when a tool's output changes.
