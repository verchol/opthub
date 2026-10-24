# Examples

## `golden/` — the whole pipeline on synthetic sessions, best vs dynamic parameters

```sh
python3 examples/golden/demo.py              # free, offline, deterministic, ~2 s
python3 examples/golden/demo.py --check      # same, then diff every step against golden/expected/
open examples/golden/how-it-works.html       # the "how it works" page, with this run's numbers
```

Three synthetic Claude Code sessions, written by `golden/synth.py` against a small fixture
repo (`golden/repo/`, an invoicing package with three planted problems). Their shapes are chosen
so a single fixed setting cannot be right for all of them:

| session | shape | what it is for |
|---|---|---|
| `fix-rounding` | 9 requests, one file, mostly thinking | dynamic picks a smaller model than the preset |
| `csv-export` | 24 requests, four files | dynamic and the preset are close; the preset is cheaper |
| `slow-report` | 44 requests, median context above 150k | the preset's model downgrade costs quality; dynamic keeps the model |

The demo then runs the real tools on them, in order. Every command it prints is one you can run on
your own sessions by dropping `--root`:

| step | tool | what it shows |
|---|---|---|
| 1 inspect | `tools/sessions.py` | what ran, what it cost |
| 2 classify | `tools/savings.py` | where the money went; headroom per lever (`priced` / `guess`) |
| 3 decide | `tools/tune.py` | **dynamic** flags for each session, with one reason per decision |
| 4 verify | `tools/rerun.py plan --dynamic` | three arms: `baseline`, `cost` (the **best** preset), `dynamic` |
| 5 compare | `tools/rerun.py report` | one verdict per candidate arm, against the baseline arm |

**Best** is the goal's preset in `tools/rerun.py` (`GOALS["cost"]`: `--model claude-sonnet-5 --effort medium`), the same
for every session. **Dynamic** is what `tools/tune.py` picks from the session's own measurements: median
context, thinking share of output, files edited, request count. Its thresholds are `guess`es and its
docstring lists them; the replay is what measures them.

### What is real and what is simulated

Offline, step 4 does not call `claude`: `synth.simulate()` writes each arm's replay transcript, diff and
judge scores from a stated toy model (its docstring). Everything downstream is the real code:
`rerun.measure()` prices the transcripts, `rerun.collect()` takes medians, `rerun.verdict()` decides.
The terminal output, the reports and the page all say **SIMULATED**. Use the numbers to learn how a verdict
is reached. Never quote them (CLAUDE.md, Rules for numbers).

```sh
python3 examples/golden/demo.py --live --yes   # real replays in the Docker sandbox: spends money
```

`--live` runs `rerun.py run` and `judge` for real against the fixture repo: 3 sessions × 3 arms × 3 repeats.
It needs Docker and `CLAUDE_CODE_OAUTH_TOKEN` (see `.env.example`). `rerun.py plan` prints the spend
ceiling for each session first.

### Golden files

`golden/expected/` holds the output of each step and `summary.json`. `--check` regenerates
everything and diffs; it exits non-zero on any difference. After a deliberate change to a tool or to the
generator, run `--update` and review the diff in git. Output goes to `golden/out/` (gitignored); the
synthetic transcripts never touch `~/.claude/projects` (`OPTHUB_PROJECTS` and `OPTHUB_RERUNS` redirect the tools).
