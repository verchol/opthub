# opthub

Measures whether a cheaper way of running a coding agent does the same job, by replaying real
Claude Code sessions and grading them blind. This repo holds the spec, the measurements, and
read-only analysis tools; the runnable implementation (hub, experiment loop, sandboxes) lives in
`sandbox/e2b`, which is not published yet. Nothing in this repo spends money.

## Layout

- `SPEC.md` — the spec, versioned (currently **v0.4**). §2 lists what v0.1 claimed that measurement killed.
- `PROGRESS.md` — dated log, newest **last**. Add an entry when a measurement changes a claim.
- `README.md` — front door and roadmap.
- `docs/` — `experiments.md` (E1/E1b), `optimizers.md` + `optimizers-cookbook.md` (levers),
  `router-comparison.md`, `demo-mock-spec.md` (four-terminal demo, source of all demo numbers),
  `demo-thesis.md` + `demo-diagrams.md` (developer demo), `ARTIFACTS.md` (shared-page index).
- `docs/data/` — pinned ledgers `e1-sessions.csv` (215 sessions) and `e1b-sessions.csv`
  (214 sessions, $508.80). Prompts and absolute paths are stripped; keep it that way.
- `docs/screens/` — hub screenshots (`INDEX.md`) and rendered demo diagrams (`diagrams/`).
- `tools/` — stdlib Python, read-only: `sessions.py`, `lenops.py`, `loopscan.py`, `savings.py`,
  `costmodel.py`, `ctxwatch.py`. They are the source of every number in `docs/`.
- `experiments/` — J-series classifier experiments (`email-triage` = J2, `session-triage` = J3, Jev).

## Commands

```sh
python3 tools/lenops.py view                 # session ops report (also /lenops)
python3 tools/savings.py --days 30           # per-session lever headroom
python3 tools/costmodel.py                   # run before editing any number in docs/optimizers.md
cd experiments/session-triage && python3 src/run.py          # rules arm, pinned ledger, no egress
mmdc -i docs/demo-diagrams.md -o docs/screens/diagrams/demo.png -b white -s 2   # re-render diagrams
```

No test suite, no dependencies beyond the Python stdlib (and `mmdc` for diagrams).

## Rules for numbers

- **Every figure comes from a tool or a pinned file.** Never type a number into a doc that a
  script did not produce; cite the source.
- **Label every saving estimate**: `priced` (tokens re-priced at list rates — a ceiling),
  `guess` (stated basis, no measurement), `detector` (measured, and it says no), or measured.
- **Attribution is marginal, in applied order** (SPEC R1). Never quote a standalone saving as if
  it stacks.
- **Arms are compared to each other, never to the original session.**
- **n = 1 is not a finding.** Say so when quoting a single run; three repeats is the minimum.
- Cache-priming is a **detector** (hit rate 96.8%), not a lever. `context-lifecycle` is the top lever.
- Demo numbers live in `docs/demo-mock-spec.md` §5 — change them there first, then everywhere else.

## Privacy

- Session transcripts (`~/.claude/projects`) contain prompts and paths. Anything derived from live
  sessions goes to a gitignored `data/private/`; only stripped, pinned CSVs are committed.
- Nothing sent to an external classifier (Jev) may contain cost, paths, or prompt text — booleans
  and counts only.

## Git

- Branch `public` tracks `origin/main` (https://github.com/verchol/opthub). The repo is **public**:
  scan for credentials and personal data before committing.
- `.claude/settings.local.json` is machine-specific and gitignored.
