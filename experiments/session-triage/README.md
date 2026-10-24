# J3 — session triage with Jev

*Spec + working harness, 2026-09-29. Series **J**, after [J2](../email-triage/) (email
triage) — same Jev contract, same privacy rules, a different workload: Claude Code
sessions.*

**The question.** If every session were labelled for *how urgent it was, whether anyone
was waiting, whether it could have waited, how hard it was, and whether it needed its
history* — how much money would those labels move, and can a decision model supply
them where rules cannot?

---

## 1. The finding the harness is built around

Run it with no model at all and the ledger answers half the question:

| | sessions | spend |
|---|--:|--:|
| launched by the SDK (`sdk-cli`), already on Sonnet/Haiku | 186 | **$7.49** |
| interactive terminal (`cli`), on Opus | 28 | **$501.31** |

The rules arm settles the 186 cheap sessions from the entry point alone, and on those it
finds **at most $4.51** — with a batch *floor* of **−$4.81**. For the 28 sessions that are
99% of the money it answers `unclear` on urgency and deferral, because nothing in a cost
ledger says whether someone was waiting. **That gap is the job for a classifier**, and it
is the only place one can earn anything.

And the prize it competes for, with no classifier involved — every session forced into
one class (`data/RESULTS.md`, top table):

| if every session were… | lever | saving floor → ceiling |
|---|---|--:|
| `capability = mid` | route to Sonnet 5 | $302.93 (59.5%) |
| `capability = small` | route to Haiku 4.5 (≤200k ctx only) | $344.95 (67.8%) |
| `context = separable` | split / compact | $104.51 (20.5%) |
| `deferral = overnight`, unattended | Batch API −50% | **−$854.31 → $254.40** |

**The lever with the biggest-sounding discount is the only one that can cost more.**
Batch halves the price, but batch requests are single-shot and cache hits inside a batch
are best-effort. This workload reads 96.8% of its input from cache (E1-F4), so losing
the cache costs 10× on the dominant line item. "Could be delayed" is worth money only for
sessions whose cost is *not* cache reads — the classifier has to be right *and* the
session has to have the right cost shape.

---

## 2. The taxonomy — five axes, one Jev request

`taxonomy.json`. Every axis has `unclear`, and an `unclear` never unlocks a lever.

| axis | question | options | what it unlocks |
|---|---|---|---|
| `urgency` | How soon was the result needed? | `blocking-now` · `same-day` · `no-deadline` | guard on batch; `blocking-now` + interactive → **fast mode, as spend** |
| `latency` | Was a person waiting on each reply? | `interactive` · `checks-in` · `unattended` | guard on batch: only `checks-in` / `unattended` pass |
| `deferral` | Could the whole session have been queued? | `run-now` · `within-hours` · `overnight` | **batch** (−50%) |
| `capability` | Least capable tier that does it to the same standard? | `frontier` · `mid` · `small` | **route** to Sonnet 5 / Haiku 4.5 |
| `context` | Did later turns need the whole history? | `continuous` · `separable` · `short` | **context-split** (25% of cache $, = `savings.py` lever A) |

`urgency`, `latency` and `deferral` overlap on purpose — they are the three things a person
means by "could this wait?", asked separately so that a classifier contradicting itself is
visible. The report counts contradictions (`blocking-now` but `overnight`, …) rather than
correcting them.

Wording is a measured variable (J1/J2: rewording moved Jev's confidence 30% → 90%). Vary
`taxonomy.json`, never the evidence.

## 3. The savings model

`src/savings.py`. One lever per class, priced from list rates or a stated assumption, each
figure labelled like `config/optimizations.json`:

| lever | rate | label |
|---|---|---|
| route-mid / route-small | Sonnet 5 $2/$10, Haiku 4.5 $1/$5 vs current model | `priced` |
| context-split | 25% of cache read + write $ | `guess` |
| batch | −50% (ceiling, cache holds) · cache reads repriced at 1× input (floor) | `priced` / `guess` |
| fast mode | Opus 5 $10/$50, i.e. +100% | `priced`, **reported as spend, never netted** |

Stacking: route first, then context-split on the routed cache dollars, then batch on what
is left, so no dollar is saved twice. Per-model cost is apportioned by request count
(211 of 214 sessions ran on a single model).

These are headroom figures from measured tokens. None of them is a measurement of
quality; the experiment loop is what turns one into a finding.

## 4. Evidence, and what leaves the machine

`src/evidence.py` keeps two dicts per session and never merges them:

- **ledger** — the money. Used by `savings.py`. **Never sent**: a model shown "$137" calls
  the session `frontier` because of the price, and the savings figure then measures itself.
- **evidence** — what a classifier sees.
  - **C0** (pinned ledger only): entry point, a project *kind* (`agent-tooling`,
    `knowledge-base`, … — never the path), request count, median/max context, thinking
    share of output, local start time.
  - **C1** (adds `src/extract.py`, run locally over `~/.claude/projects`): reply gaps,
    topic breaks, span, tool mix, subagent share, and seven **prompt flags**
    (`mentions_deadline`, `mentions_prod_or_incident`, `mentions_background_or_later`, …).
    Prompt text is matched locally and dropped; only the booleans leave.

The hypothesis is the same as J2's: **C1 is what matters.** C0 cannot tell a 3 a.m.
graph build from a 3 a.m. production fix. If `jev-C1` does not beat `rules-C1`, the model is
not earning its call.

## 5. Arms

| arm | model | evidence | cost | question |
|---|---|---|---|---|
| `rules-C0` | none | ledger | $0 | what the entry point alone decides |
| `rules-C1` | none | + transcript features | $0 | what keyword flags and reply gaps decide |
| `jev-C0` | Jev `jev-1.13.0` | ledger | paid | can a decision model read a session from its metadata? |
| `jev-C1` | Jev `jev-1.13.0` | + features | paid | does local activity change its mind? |
| `hybrid-C0/C1` | derived | — | — | rules answer, Jev fills only the axes rules left `unclear` (SPEC §6.7, detector-first) |

There is no gold label for "could this have waited", so no arm gets an F1. The report gives,
per arm: spend and saving per class, saving per lever, contradictions, and agreement
between arms. Gold comes from the person who ran the sessions — §7.

## 6. Running it

```sh
cd experiments/session-triage

python3 src/run.py                                  # rules only, pinned E1b ledger, no egress
python3 src/run.py --dry-run                        # the exact Jev payload for the top session
JEV_API_KEY=... python3 src/run.py --arms rules,jev # + jev-C0 and hybrid-C0 (214 calls, one per session)

# C1 — live transcripts on this machine; everything lands in data/private/ (gitignored)
python3 ../../tools/savings.py --days 30 --csv data/private/ledger.csv
python3 src/extract.py --days 30
python3 src/tasks.py --days 30      # tasks per session (prompt titles, scrubbed; local only, never sent to Jev)
python3 src/export_hub.py           # -> app/results/triage.json, shown in Hub → Triage
```

**When Jev cannot answer the model question** (`capability = unclear`), no route saving is
counted and `export_hub.py` queues the session for a re-run on Sonnet in the sandbox
(`route-cheaper-frontier`: baseline vs Sonnet, blind-judged). The verdict is reported next to
the classes and is never fed back to Jev as a signal. The queue runs from the hub (Triage →
"re-run 3 on Sonnet") or from the e2b repo:

```sh
node triage-rerun.mjs                  # plan only, spends nothing
node triage-rerun.mjs --go --limit=3   # ≤ $6 per session, $20 batch cap by default
JEV_API_KEY=... python3 src/run.py --ledger data/private/ledger.csv \
    --features data/private/features.jsonl --arms rules,jev
```

Stdlib only. Outputs `RESULTS.md` + `results.json` (results.json is gitignored). A run
over the pinned ledger writes to `data/`; a run with `--features` writes to
`data/private/`, since it describes live sessions.

Tested: the rules arm over the pinned ledger (the numbers above); `extract.py` over a
synthetic transcript; the Jev adapter against a local mock that asserts no cost and no
path reach the payload and that returns malformed answers to check they are rejected.
**Not yet run against the real Jev API.**

## 7. Per-method scores and the Hub's "Score with Jev" button

*Added 2026-10-13.* `src/methods.py` turns Jev's answers into one row per optimization method,
and `src/score.py` runs the whole pass. The Hub's Triage tab calls it (`POST /api/triage/score`).

**Two new questions** (taxonomy 0.2), one for each Claude Code lever that had none:
`reasoning` (deep · moderate · light) unlocks `--effort medium`, and `delegation`
(small-enough · needs-main-model · no-delegation) unlocks `CLAUDE_CODE_SUBAGENT_MODEL=haiku`.
All seven questions still go in **one Jev call per session**. Each method has its own question
because levers stack, and a single "which method?" choice could only ever pick one.

**Claude Code settings are now session attributes.** `extract.py` reads them from the transcript's
own fields: entry point, version, model, effort and its high share, permission mode, fast-mode
share, advisor, compactions, hooks, MCP servers and subagent share. They are enums and counts, so
they go to Jev with the C1 evidence, and the page shows them per session.

| method | question | Claude Code knob | rate | label |
|---|---|---|---|---|
| Model routing | capability | `--model sonnet \| haiku` | Sonnet 5 / Haiku 4.5 list vs current | priced |
| Subagents on a small model | delegation | `CLAUDE_CODE_SUBAGENT_MODEL=haiku` | subagent request share → Haiku | priced |
| Context compaction / split | context | `--autocompact` · `/clear` between tasks | 25% of cache $ (lever A) | guess |
| Lower reasoning effort | reasoning | `--effort medium` | 50% of thinking $, only if effort was high (lever B) | guess |
| Defer to batch | deferral × latency × urgency | `claude -p` + Batch API | −50% ceiling, cache at 1× floor | priced / guess |
| Fast mode | urgency × latency | `/fast` | +100% | spend, never netted |

- **score** is the probability Jev put on the options that unlock the method. Batch and fast mode
  multiply the marginals, which assumes independence. Rules score 0 or 1. Runs before this date
  stored no probabilities, so their score falls back to the confidence of the chosen option.
  A score is not a gate (SPEC §6.1.1).
- **saving** is marginal, in applied order: route, subagents, context, effort, batch. Only
  methods whose chosen option unlocks them stack into best/worst.
- **expected** is score × saving: a ranking of what to try first, not a forecast.

```sh
python3 src/score.py --days 30            # rules only without JEV_API_KEY; with it, one Jev call per session (C1)
```

Before overwriting anything, `score.py` copies the previous run to
`data/private/archive-<timestamp>/`. The hub reads `JEV_API_KEY` from its environment or from
e2b's `.env` (a literal or an `op://` reference). `OPTHUB_HOME` and `OPT_TRIAGE_DIR` relocate the repo and
the working files.

## 8. Open questions

1. **Gold.** Twenty of the 28 interactive sessions, labelled by the person who ran them
   in about ten minutes, is enough to tell whether `jev-C1` is better than rules. Without
   it, agreement between arms is all there is.
2. **Is `deferral` real for an interactive session?** It may be that nothing typed at a
   terminal could have waited, and the honest batch lever is "launch it headless next
   time" — a behaviour change, not a routing change.
3. **Cache shape as an eligibility rule.** Should batch eligibility require
   `read$ / cost` below a threshold, so the floor cannot go negative? It is arithmetic,
   not judgement, so it belongs in rules, not in a question to Jev.
4. **Confidence** is recorded and never gates (SPEC §6.1.1): it is decisiveness, not
   correctness.

## 9. Interactive labelling, and turning a run into settings

*Added 2026-10-18.*

**Classification mode.** `run.py` and `score.py` take `--mode auto|interactive`. `auto` (the
default, and what the hub calls) runs the classifiers only. `interactive` also asks you, at the
terminal, to label the most expensive sessions (`--limit`, default 20) — the gold of §8.1. Each
session shows the evidence a classifier sees and the rules (or hybrid) answer; Enter keeps it, a
number or prefix picks an option, `u` unclear, `?` the option wording, `s` skip, `q` stop. Answers
are appended to `data/private/gold.jsonl` as you go, so a pass can stop and resume, and any later
`auto` run loads them as the `human` arm. Every other arm's agreement with `human` is the nearest
thing to an accuracy this experiment has — and with one labelled session it is n = 1, not a finding.

```sh
python3 src/run.py --mode interactive --limit 20 --ledger data/private/ledger.csv \
    --features data/private/features.jsonl --out-dir data/private
```

**Recommendations.** `src/recommend.py` prices a run's labels with `methods.py` (as `export_hub.py`
does) and recommends a method for a project when the sessions it unlocks hold ≥ `--share` (0.5) of
that project's spend and it saves money at its floor. It writes to `data/private/recommend/`:

- `settings.json` — the fragment that holds across all sessions (`model`, `env.CLAUDE_CODE_SUBAGENT_MODEL`).
  `--copy settings` puts it on the clipboard.
- `apply.sh` — runs in plan mode by default and changes nothing; `apply.sh apply [claude] [llm] [other]` acts.
  - **claude**: merges per-project settings into `<project>/.claude/settings.local.json`, backing up first.
    Effort and context have no settings key we have verified, so they are printed as launch flags.
  - **llm**: re-classify with `score.py` (+ Jev when `JEV_API_KEY` is set, paid), the interactive gold
    pass when at a terminal, and the recommender again.
  - **other**: the sandbox re-run plan for sessions with no answer to the model question (plan only),
    batch candidates, and the follow-up comparison.
- `recommend.json` — the same per project, for the hub.

Savings are per-method headroom with the method's label, not measurements, and are not totalled
across methods. Tested: plan output over the live run, the settings merge on a scratch file, the
labeller with scripted input. **Not tested: `apply` against a real project.**
