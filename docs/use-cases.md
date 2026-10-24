# Use cases, and how each one is tested

What a person does with opthub, in the order they do it: install it, see what ran, find where the
money went, pick a cheaper configuration, prove it does the same job. Each use case is covered by
**deterministic tests** (same input, same answer: exit codes, files, numbers that must agree, text that
must never appear) and, where a person has to *read* the output to act on it, by an **eval**: a task a
developer would hand Claude, answered by one agent and graded blind by another against a rubric.

Both run for free on one synthetic workspace (`evals/fixture.py`): four transcripts, one of them carrying
a planted prompt and path, an empty `HOME`, a fake `.env`, no credentials, and an egress trap (every
proxy points at a closed port, so a "free" command that reaches the network fails instead of passing).
Nothing here starts an arm, calls a model API or boots a sandbox.

```sh
python3 -m unittest evals/test_usecases.py -v     # deterministic, ~3 s; fails if anything writes into data/private/
python3 evals/run.py list                         # the evals and their last result
python3 evals/run.py prepare all                  # fixture + each card's commands -> data/private/evals/<EV>/
python3 evals/run.py check EV-02 && python3 evals/run.py record EV-02 && python3 evals/run.py report
```

How Claude runs an eval: `prepare` writes `task.md`; an answerer agent reads only that and writes
`answer.md`; `check` runs the card's deterministic checks on the answer (every figure must come from a
tool's output, word limit, text that must not appear); a grader agent that never saw the answerer's work
reads `rubric.md`, verifies each claim against the artifacts and writes `grade.json`; `record` combines
them. An eval passes when its weighted score clears the card's threshold **and** every critical check and
criterion scores in full. Results: [`evals/RESULTS.md`](../evals/RESULTS.md).

Legend for coverage: **D** deterministic test in `evals/test_usecases.py` (by test name), an existing
suite by file, **E** eval card in `evals/cases/`. *spends* means the use case cannot run without money
and is covered only up to its spend guard.

## A. Install and initialize

| id | as a developer, I want to… | command | coverage |
|---|---|---|---|
| UC-01 | install opthub from a fresh clone and get a working CLI and hub page | `npm install`, `npm run build:web`, `ln -s "$PWD/opt" …`, `opt --help` | D `test_uc01_*` · E EV-01, EV-07 |
| UC-02 | put my credentials in one place and see which are set without printing them | `cp .env.example .env`, `python3 tools/envfile.py check` | D `test_uc02_*` (every known key in the template, values masked, the API-billing warning) · E EV-01 |
| UC-03 | see whether everything is up: credentials, templates, tracing, runners, sessions | `opt init`, `opt secrets` | E EV-01. Not deterministic: with keys set it calls E2B and LangSmith |
| UC-04 | set up the local tier (Ollama, settings, worker, a bench profile) without anything changing behind my back | `opt install` (then `--yes`), `opt models bench` | `app/test/local-cloud.test.mjs` (the plan from a survey, `--yes` scope, bench caps) |
| UC-05 | know whether my history is complete, or pruned by `cleanupPeriodDays` | `tools/sessions.py` retention line | D `test_uc05_retention_boundary_is_reported` |

## B. Visibility: what ran, and what it cost

| id | as a developer, I want to… | command | coverage |
|---|---|---|---|
| UC-10 | list every session in a window with its cost, and export it | `tools/sessions.py [--since] [--csv]` | D `test_uc10_*` (all four found; CSV rows sum to the header total) |
| UC-11 | read one session's ops report: context, preload, models, cost mix | `tools/lenops.py view --session` | D `test_uc11_*` · E EV-03 |
| UC-12 | see a session as tasks, threads and subagents | `tools/sessiongraph.py <sid>` | D `test_uc12_*` (agrees with the inventory; counts subagents) · E EV-03 |
| UC-13 | watch what is running now, and its context, live | `tools/ctxwatch.py`, `opt session [--watch]` | D `test_uc13_*` (one frame; `opt session` reads only the store it is given) · E EV-03 |
| UC-14 | browse sessions and their optimization potential in a browser | `opt hub start` | D `test_uc14_*` (serves exactly the fixture's sessions, each with a potential; page loads) · `app/test/hub-graph.test.mjs`, `behaviour.test.mjs` |
| UC-15 | trust that every tool prices the same session the same way | `tools/ratecard.py [check]` | D `test_uc15_*` (sessions, savings, sessiongraph and dynconfig agree to the cent; the card has a version) |
| UC-16 | show the product without my own data | `opt hub demo` | `app/test/demo-startup.test.mjs` |

## C. Analysis: where the money could be saved

| id | as a developer, I want to… | command | coverage |
|---|---|---|---|
| UC-20 | see each session's headroom per lever (trim, effort, TTL, model ceiling) | `tools/savings.py` | D `test_uc20_headroom_is_bounded` · E EV-03 |
| UC-21 | price every Claude Code config lever, stacked marginally in applied order | `tools/dynconfig.py` | D `test_uc21_*` (stacked rows sum to the total; standalone ceilings kept apart) · E EV-04 |
| UC-22 | get one scan of settings, routing and the Atlas, and a report I can open | `opt scan [--dry]` | D `test_uc22_*` (three files; under the data floor it says *collect first*; `--dry` writes nothing and prints only JSON) · E EV-02, EV-06 |
| UC-23 | run the day-0 onboarding probes P0–P5 | `tools/onboard.py [--dry]` | `tools/test_onboard.py` (known answers, silent cases) · D `test_uc50_*` · E EV-06 |
| UC-24 | roll several developers' scans into one org view | `opt scan rollup DIR …` | D `test_uc24_rollup_adds_developers` |

## D. Optimization: propose a cheaper configuration

| id | as a developer, I want to… | command | coverage |
|---|---|---|---|
| UC-30 | get flags tuned to one session's own numbers | `tools/tune.py <sid> [--json]` | D `test_uc30_*` (labelled *guess*; only `--model`/`--effort`; a reason per flag) · `app/test/tune.test.mjs` · E EV-04 |
| UC-31 | plan a replay — baseline, goal preset, dynamic arm — before paying for it | `tools/rerun.py plan <sid> --goal cost --dynamic` | D `test_uc31_*` (three arms, three repeats, writes only `plan.json`, prints the `--yes` command) · E EV-04 |
| UC-32 | never spend by accident | `rerun.py run|judge`, `probe_cache.py conformance` without `--yes` | D `test_uc32_*` (non-zero exit, says why, writes nothing) · E EV-04, EV-07 |
| UC-33 | route each live request: keep, cheaper model, or local, with an audit trail | `opt claude optimize` — *spends* | `app/test/ult.test.mjs` (router on mock upstreams) |
| UC-34 | send to local Ollama only what this machine can serve in time | `opt claude optimize --local-cloud` — *spends* | `app/test/local-cloud.test.mjs`, `ult.test.mjs` (capacity guard) |

## E. Verification: does the cheaper configuration do the same job

| id | as a developer, I want to… | command | coverage |
|---|---|---|---|
| UC-40 | replay a session under each arm, judge blind, and read one verdict per arm | `rerun.py run → judge → report` — *spends* | `examples/golden/demo.py --check` (whole pipeline, simulated replays) · E EV-05 |
| UC-41 | get no verdict from too few repeats | `rerun.py report` with `--repeats 1` | D `test_uc41_fewer_than_three_repeats_prints_no_verdict` · E EV-05 |
| UC-42 | run one task headless in optimize mode and have every claim it makes audited | `opt claude -p "…" --compare` — *spends* | `app/test/claude-p.test.mjs` (claims audit on a synthetic run) · `evals/claude_p.py` (three tasks, live: deterministic checks on the run's files + blind A/B review of the diffs; [results](../evals/CLAUDE-P-RESULTS.md)) |
| UC-43 | know a `--compare` task is fair before paying for it: its hidden check fails untouched and passes a reference solution | `python3 evals/claude_p.py preflight` | D `test_uc43_*` (every case well-posed, check and solution outside the agent's view, spend guard, dry run) |

## F. Trust: the rules every use case keeps

| id | rule | coverage |
|---|---|---|
| UC-50 | nothing that leaves the machine carries prompt text or paths | D `test_uc50_*` (`scan --dry`, `onboard --dry` and every scan file, against the planted prompt and path) · `tools/test_onboard.py` · E EV-06 |
| UC-51 | free commands make no network call beyond 127.0.0.1 | D `test_uc51_the_egress_trap_is_armed`, then every D test runs inside the trap · `npm test` |
| UC-52 | the checkout is self-contained and the sandbox providers stay separate | `sandbox/test.mjs` |
| UC-53 | every saving carries its label: priced, guess, detector or measured | D `test_uc53_every_lever_carries_a_label` · E EV-02, EV-03 (checks) |
| UC-54 | a test run never writes into the checkout's own stores | D `tearDownModule` snapshot of `data/private/`, `app/results/`, `app/audit/` |

## Gaps the tests found (2026-10-24)

Fixed in the same change, each a one-line default that now matches the rest of the repo:

- `opt session` read the real `~/.claude/projects` even with `OPT_PROJECTS_DIR` set (the hub's reader
  honoured it; `app/transcripts.mjs` did not). Caught by `test_uc13_opt_session_reads_only_the_store_it_is_given`.
- `sessions.py`, `savings.py`, `sessiongraph.py` and `loopscan.py` ignored `OPTHUB_PROJECTS`, which
  `onboardlib`, `tune`, `rerun` and `dynconfig` honour.
- `scan.py rollup` always wrote to the checkout's `data/private/scan/`, and `dynconfig.py` always
  rewrote `data/private/dynconfig/sessions.csv`: running either on test data overwrote real output.
  New overrides: `OPTHUB_SCAN`, `OPTHUB_DYNCONFIG`, `OPTHUB_ONBOARD` (also read by `probe_cache.py`, so
  a fixture scan no longer picks up this machine's stored P2 result).

Open, tracked by an expected failure:

- **The hub lists subagent transcripts as sessions.** `app/lib/sessions-index.mjs` walks into
  `<sid>/subagents/` and returns each `agent-*.jsonl` as a session of its own
  (`test_uc14_hub_does_not_list_subagents_as_sessions`). The fix folds subagent spend into the parent
  session, which changes the hub's session count and per-session costs, so it needs its own decision.

Found by the evals, confirmed by the grader, not fixed yet:

- `opt tune` and `opt flow run` spend (per `docs/commands.md`) but are missing from
  CLAUDE.md's "What spends money", and `opt --help` marks no command as spending (EV-07).
- `lenops.py view` exits 1 when there are no transcripts and ignores `OPTHUB_PROJECTS` (EV-01).
- `examples/golden/demo.py --check` rewrites `how-it-works.html`; the docs say only `--update` does (EV-01).
- `experiments/session-triage/src/run.py` overwrites the committed `data/RESULTS.md` (EV-01).
- The README says `costmodel.py` reads the pinned ledgers; its workload is hardcoded (EV-01).
- `opt` ignores `OPTHUB_ENV_FILE`, so `opt` and `envfile.py check` can read different files (EV-01).

Found by the `opt claude -p --compare` evals (`evals/CLAUDE-P-RESULTS.md`), open:

- **Parallel arms can share a prompt cache.** All optimized arms of one comparison run at once with the
  same prompt and working directory, so an arm that starts after a sibling's first request can read the
  whole task from the cache: a discount the other side did not get. The claims audit catches it (`warm`
  failed on one of six arms in the first `fix-invoice` run) and the eval marks that comparison unfair.
  Separate workspace names per arm, or staggered starts, would remove it; either changes how runs are cached.

Not covered yet: UC-03 deterministically (needs `opt init` to skip network checks when no key is set),
`opt session --watch` status rules (live/open/idle/closed), the hub's run endpoints (*spends*), and any
live replay (*spends*; three repeats per arm is the minimum, SPEC R-rules).
