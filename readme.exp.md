# opthub — explained: what it is for, what it gives you, how to use it

This is the explanatory companion to [`README.md`](README.md). The README is the front door and roadmap;
this file answers three questions: **why would I care, what do I get, and what do I type.**
Every figure below is quoted from `README.md`, `SPEC.md` or `PROGRESS.md`, which cite the tool or pinned file that produced it.

---

## 1. The problem

Coding agents like Claude Code are expensive, and most advice on making them cheaper is a spreadsheet of list prices
plus a confident opinion: "route to a smaller model", "turn on caching", "lower effort". Each of those can make the
result **worse**, and nobody finds out until later.

## 2. What opthub does

1. **Reads** the transcripts Claude Code already leaves on your machine (`~/.claude/projects/*/*.jsonl`).
2. **Works out where the money went**: context size, cache behaviour, model mix, loops, cost per session.
3. **Proposes** a cheaper configuration (a "lever").
4. **Re-runs the real session** under that configuration in a sandbox, as separate arms: a `baseline` arm and one or more goal arms.
5. **Grades the outputs blind**: a second model scores each arm on six criteria, with arm identities hidden and order randomised.
6. **Reports** cheaper-and-worse as cheaper-and-worse.

## 3. The value

| You get | Because |
|---|---|
| A cost breakdown from your own sessions, not generic benchmarks | the analysis tools read your transcripts, read-only, free |
| A ranked list of levers for *your* usage | savings are priced per session and labelled by how much to trust them |
| Evidence a change is safe before you adopt it | replayed arms are graded blind and compared to each other |
| Protection from false wins | no-op arms are flagged, single runs are not called findings, standalone savings are not presented as stacking |
| A record of what already failed | the spec lists claims that measurement killed (`SPEC.md` §2) |

### What the measurements found so far (E1 / E1b, one month of real transcripts)

- **Cost concentrates in long sessions.** 52.9% of the month's spend was in requests whose session median context was ≥250k tokens, so `context-lifecycle` is the top lever.
- **Cache-priming does not help here.** Measured hit rate is 96.8%, so it is demoted to a *detector*.
- **The TTL lever flips sign** depending on cache write:read ratio. This produced the stability gate (§6.5) and population rule (§6.6).
- **Loops are 1.4% of spend.** A human at a keyboard is 98.6%.
- **The local transcript store deletes itself** after 30 days by default, which destroyed part of the first run of record.

The point is less these numbers than the habit: the first version of the spec made headline claims that did not survive measurement, and the repo keeps the record.

## 4. How to read a saving estimate

Every estimate carries one label (see `CLAUDE.md`, "Rules for numbers"):

| label | meaning |
|---|---|
| `priced` | your tokens re-priced at another rate. Arithmetic, and a **ceiling** nobody reaches |
| `guess` | a range with a stated basis and no measurement |
| `detector` | measured, and it says there is nothing to win |
| measured | an actual replay, graded |

Other rules that protect you from over-reading:

- Attribution is **marginal, in applied order** — never add standalone savings together.
- Arms are compared **to each other, never to the original session** (a replay may finish in five turns where the original took hundreds).
- **n = 1 is not a finding.** Three repeats is the minimum before quoting a figure.

## 5. Usage

### 5.1 Free, read-only (start here)

Needs Python 3.10+ and nothing else.

```sh
git clone https://github.com/verchol/opthub.git && cd opthub

python3 tools/lenops.py view            # session ops report: context, cost, cache misses, models, levers (also /lenops in Claude Code)
python3 tools/savings.py --days 30      # per-session lever headroom
python3 tools/costmodel.py              # re-derive the pinned-ledger numbers (run before editing any figure in docs/optimizers.md)
cd experiments/session-triage && python3 src/run.py   # classifier experiment, rules arm, no network
```

Other tools in `tools/`: `sessions.py` (session listing), `loopscan.py` (loop detection), `ctxwatch.py` (context size over time without the cost of looping `/context`).

`lenops` and `savings` report on sessions found for **your** machine; they are empty until Claude Code has been run there. `costmodel` uses the pinned ledgers in `docs/data/` and needs no transcripts.

### 5.2 Spends money: replay a session

`tools/rerun.py` replays a real session's prompts as new sessions with different flags.

```sh
python3 tools/rerun.py plan <session-id> --goal cost    # free: shows what would run
python3 tools/rerun.py run   <session-id> --goal cost --yes
python3 tools/rerun.py judge <session-id> --yes         # blind grading
python3 tools/rerun.py report <session-id>              # radar report under data/private/reruns/
```

- `run`, `judge` and `go` refuse to start without `--yes`. `plan` and `report` are free.
- Goals: `cost`, `speed`, `quality`, or custom `--flags`.
- Each arm starts from a fresh copy of the repo at the session's start commit and runs in the local Docker sandbox (`sandbox/docker/`). `--sandbox host` opts out.
- Needs Docker running and `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`). **Do not** export `ANTHROPIC_API_KEY`: it moves runs onto API billing.

### 5.3 Optional pieces

| for | what |
|---|---|
| diagrams in `docs/demo-diagrams.md` | `mmdc -i docs/demo-diagrams.md -o docs/screens/diagrams/demo.png -b white -s 2` |
| Jev classifier arms | `export JEV_API_KEY=…` |
| keeping session history longer than 30 days | `"cleanupPeriodDays": 3650` in `~/.claude/settings.json` |

### 5.4 Not in this repo

The hub (`opt hub start`), `opt watch`, the E2B experiment loop and the `opt claude optimize` router live in `app/`, and the sandbox providers in `sandbox/`. Check the README's status section before depending on them.

## 6. Where to find things

| path | contents |
|---|---|
| `SPEC.md` | the spec (v0.4); §2 is what v0.1 claimed that measurement killed |
| `PROGRESS.md` | dated log, newest last |
| `docs/experiments.md` | E1 / E1b measurements |
| `docs/optimizers.md`, `docs/optimizers-cookbook.md` | the levers, with before/after requests and cost arithmetic |
| `docs/router-comparison.md` | prior art on model routers |
| `docs/atlas/` | Optimization Atlas: 38 scenarios priced best/worst case |
| `docs/evidence-catalog.md` | 110 public savings claims checked against these measurements |
| `docs/data/` | pinned ledgers `e1-sessions.csv`, `e1b-sessions.csv` (prompts and paths stripped) |
| `docs/screens/` | hub screenshots and rendered diagrams |
| `docs/ARTIFACTS.md` | index of shareable pages |
| `experiments/` | J-series classifier experiments (J2 email triage, J3 session triage) |

## 7. Who it is for

- **A heavy Claude Code user** who wants to know where the bill comes from and which changes are safe.
- **A team lead** deciding whether a cheaper model or setting is acceptable, who wants evidence rather than opinion.
- **Someone building an optimizer or router** who needs a harness that can say no.

## 8. Limits to keep in mind

- Every comparison so far is `n = 1` per arm; sub-15% differences are noise.
- Only the TTL lever is measured. Prefix-trim and effort figures are headroom under assumed percentages, and the Sonnet ceiling is a `priced` ceiling.
- A replay reproduces the prompt, not the machine: anything the session read outside its files is missing.
- Without a hidden test suite, grading falls back to the blind judge, which is a weaker signal.

## 9. Privacy and cost safety

- Transcripts contain prompts and paths. Anything derived from live sessions goes to gitignored `data/private/`; only stripped, pinned CSVs are committed.
- Nothing sent to an external classifier contains cost, paths or prompt text: booleans and counts only.
- Nothing in this repo spends money except `tools/rerun.py run|judge|go`, and those need `--yes`.
- The repo is public: scan for credentials and personal data before committing.

## 10. License

MIT — see [`LICENSE`](LICENSE).
