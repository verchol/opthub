# What a run report is, and what has to be on it

One contract, two producers. `opt demo run` writes a benchmark report;
the hub writes a session-replay report. Both go through `buildHtml` in
[`report.mjs`](../report.mjs) from a `run.json` in the same schema, so a reader
who can read one can read the other. The only permitted difference is how the
work was graded.

## Naming: baseline, exp1, exp2

Arms are ordinal and the order is fixed.

| id | what it is |
|---|---|
| `baseline` | index 0, always. The control: the session's own model tier, no lever changed. It defines what "the same job" means for this run. |
| `exp1`, `exp2`, … | one variant each, in the order they were planned. |

Each variant carries a **tag** — one phrase naming what it varies, short enough
for a chart axis: `cheap`, `cheaper`, `stronger`, `compaction`, `effort`,
`prompt`, or several joined with `+`. A chart legend reads `exp1 · cheap`, never
`Cheap open-weights` and never `arm 2`.

**The tag is derived from parameters, never from the label.** Labels are prose a
model wrote. On the run this spec was written from, a model proposed an arm it
called *"Frontier no compaction"* — and the baseline already had compaction off,
so the arm varied nothing. Its tag reads `no change`, because that is what the
parameters say.

## The eight blocks, in order

**1 · Header.** Run id, experiment, task, auth, `n = 1 per arm`. One sentence
naming the control's model and how many variants ran.

**2 · The arms.** *Before any number.* One row per arm: model, compaction,
effort, and **what it changed against the baseline**, computed by diffing
parameters. An arm that changed nothing is flagged in red and called out below
the table — its delta is run-to-run variance on one configuration, which is a
useful noise floor and is not a result.

**3 · The radar.** Six axes: quality, cost efficiency, token economy, turn
economy, cache reuse, speed. One outline per arm, one colour per arm, a legend
naming every one. Each axis is normalised independently so the best arm on it
touches the outer ring; the four axes where a lower raw number wins invert to
`best ÷ value`. **Outward is better on every axis.** Rings are ratios within an
axis, so distances only compare along one spoke. Raw values sit beside each
label, colour-matched, in arm order.

**4 · Raw numbers.** One value column per arm, plus a Δ column per variant
against the baseline. Δ is coloured only by direction-of-good, never by sign.
Cost appears three ways and all three are labelled: the provider rate, the
harness's own priced figure, and Claude Code's Anthropic-priced guess — which is
wrong by an order of magnitude for a non-Anthropic model and is shown anyway so
nobody quotes it by accident.

**5 · What each arm was given.** The levers, verbatim, per arm, with its sandbox
id. This is the block someone copies to reproduce a result.

**6 · Grading.** Exactly one of:
- *suite* — a hidden test suite the arms could not see. Reports `52/69`, plus
  which tests each arm missed.
- *rubric* — no suite exists (every session replay). Six criteria scored 1–10 by
  a second model, arms presented in randomised order with identities withheld.
  Reports `36/60`, the per-criterion table, the winner, the margin, the one
  sentence naming the deciding difference, and which arm the judge saw first.

`grade.kind` in `run.json` decides; the report never guesses.

**7 · What each arm delivered.** Files changed, lines added and removed, bytes,
tests written.

**8 · Read this carefully.** `n = 1 per arm`; three repeats is the minimum before
quoting a figure. Whether the run measured model routing (arms differ in model)
or held it fixed. Any arm that varied nothing. What the comparison is *not*: arms
are compared against each other, never against the original session, which
reached its answer over far more turns than a replay takes.

## Rules the report may not break

1. **Arm against arm.** Never against the original session's cost. A replay is
   not a reproduction, and "N× cheaper than the original" measures the replay's
   incompleteness.
2. **A failed arm is never a winner.** An arm that errored or produced no file
   spent less because it did less. It reports `—`, not a cost saving.
3. **Every arm appears in every block.** No block may show a subset.
4. **Say what was graded.** A rubric score is never presented as a test result.
5. **Colour carries identity, not judgement.** One hue per arm throughout;
   good/bad colouring is reserved for Δ cells and gate verdicts.
