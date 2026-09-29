# J1 — judge calibration on a planted regression

*Spec draft, 2026-09-25. Series **J** (judge calibration), deliberately separate from the
**E** series (cost levers). Nothing here proposes a saving; this measures whether a judge's
verdict can be trusted at all.*

---

## 1. Motivation

opthub's accuracy gate (`SPEC.md` §6.1) ends in a judgement. Deterministic checks decide what
they can — schema, arity, regex — and everything left over goes to an LLM judge that scores six
criteria and picks a winner. Every headline this project produces rests on that judge:
*"7.1× cheaper and 18 points worse"* is a judge's opinion, expressed as a number.

**The judge has never been tested against a known answer.** It cannot be, on the normal
workload: when two agent arms both write a plausible patch, nobody knows which is genuinely
better, so the judge's score is the only evidence and there is nothing to check it against.
`README.md` concedes the blind judge is "a weaker signal" without saying how much weaker.
`SPEC.md` §6.1.1 sets `judge.min_agreement: 0.85` for promoting a shadow judge — a number with
nothing behind it, chosen the way v0.1's percentages were chosen.

This experiment builds the missing instrument: a task where **we plant the difference, so we
know the truth**, and then ask the judge to find it blind.

A microservice under load is the right vehicle because the ground truth is a dial, not a coin
flip. A regression can be made arbitrarily small, made to appear only in the tail, or made to
vanish entirely — and the correct verdict is known in advance for every setting. That turns a
yes/no question ("is the judge good?") into a curve: **at what size of real difference does the
judge start seeing it, and how often does it see one that is not there?**

### 1.1 What this is not

**This is not a proposal to replace load testing with an LLM.** Detecting that p95 moved from
100 ms to 115 ms is arithmetic; a benchmark with a bootstrap CI does it deterministically, for
free, and without a vendor in the path. Any framing of the form *"ask a model whether your
service got slower"* is a worse tool than the one it replaces, and this spec does not argue for
it. The deterministic benchmark runs **first and always**, and its result is ground truth for
scoring the judge — never the other way round.

What is genuinely uncertain, and therefore worth measuring, is the **verdict layer**: given
honest evidence that a difference exists, can a model be trusted to call it *material* or
*noise*? That is the judgement opthub's gate already delegates, on every run, with no
calibration behind it.

### 1.2 Does it improve the regular experience — honestly

**Yes, in three specific ways.**

1. **It puts a number on `min_agreement`.** Today 0.85 is a guess. After J1 it is either
   justified or replaced by a measured threshold, and §6.1.1's promotion rule stops being
   decoration.
2. **It gives every judge backend a comparable score.** The same harness runs against the pinned
   Opus judge, Jev, and the free local Ollama judge from §6.1.1. For the first time the choice
   between them is a measurement (`detector`-grade), not a preference.
3. **It measures the false-positive rate, which nothing currently does.** The A/A arm — the same
   build compared against itself under different labels — is the single most valuable row in the
   result table. A judge that declares a winner on identical inputs is not a weak signal, it is
   an anti-signal, and today nothing in opthub would notice.

**No, in one way worth stating.** A judge calibrated on *service latency evidence* is not
thereby calibrated on *agent code output*. The evidence bundles look nothing alike, and skill at
one does not transfer to the other. J1 measures the judge's behaviour on a numeric,
well-posed comparison — which is the **easiest** case. A judge that fails J1 certainly cannot be
trusted on agent transcripts; a judge that passes J1 has cleared a low bar, not a high one.
The spec must say this in its verdict, and §9 records it as a limit rather than a caveat.

### 1.3 Why it connects to work already done

The loop already flags **an arm that varies nothing** (`README.md`) — a planner once proposed an
arm identical to the baseline and the report called the delta a noise floor rather than a
finding. J1's A/A arm is that same rule, turned into a deliberate instrument instead of an
accident. And the failure mode being tested is one this project has already documented in
another codebase: Alexei's `pi-model-router` moved Jev's confidence from ~30% to ~90% on
identical inputs by rewording the option descriptions (`docs/router-comparison.md` §1). J1
therefore treats **criteria wording as a measured variable**, not a fixed part of the harness.

---

## 2. Hypothesis, and what would falsify it

**H1.** A Choice-model judge, given a blinded evidence bundle from two builds under an identical
workload, separates real regressions from noise well enough to be worth its cost.

**Falsified if any of:**

- **FPR on A/A > 0.10** — it declares a winner on identical builds more than one run in ten.
- **It cannot see a gross regression** (p95 +60%) at ≥ 0.90 true-positive rate.
- **Its verdict flips** between the two position-swapped calls on more than 15% of pairs.
- **Its verdict changes with criteria wording alone** by more than the A/A false-positive rate —
  i.e. rewording moves it more than real evidence does.

Any one of these is a publishable negative result and ends the promotion path in §6.1.1 for that
backend. A negative result here is as useful as a positive one and costs the same to obtain.

---

## 3. System under test — `eventd`

A small ingest-and-aggregate service, chosen because throughput and tail latency are its whole
job, and because a realistic regression can be hidden in one line.

**Contract**

| route | behaviour |
|---|---|
| `POST /v1/events` | accepts a batch of `{id, ts, key, value}`; drops duplicate `id` seen within the 60 s dedupe window; returns `{accepted, deduped}` |
| `GET /v1/agg?key=` | current 10 s rolling-window sum and count for `key` |
| `GET /healthz` | liveness |

**Correctness invariants** (deterministic, checked every run — a violation aborts before any
judge is called):

- `sum(accepted values per key)` equals the aggregate reported for that window
- a duplicate `id` inside the window is counted exactly once
- no value leaks across window boundaries
- zero 5xx responses, zero dropped connections

### 3.1 The planted regression

`v-stable` dedupes through a hash set. `v-regress` keeps the same behaviour and the same output,
byte for byte, but changes the lookup for a *subset* of traffic:

```diff
 const seen = new Map();           // id -> expiry
 
 const isDuplicate = (event) => {
-  return seen.has(event.id);
+  // Events carrying a traceparent take the ordered path so the
+  // dedupe decision can be attributed in the trace. ~8% of traffic.
+  if (event.traceparent) {
+    return window.ids.includes(event.id);   // O(n) over the live window
+  }
+  return seen.has(event.id);
 };
```

This is the shape worth testing, not a crude slowdown:

- **output is identical** — every correctness invariant still passes, so no deterministic check
  catches it
- **it is load-dependent** — at batch 50 the window holds a few thousand ids and the scan is
  free; at batch 1000 it holds ~200k and the scan dominates
- **it is tail-only at small sizes** — 8% of requests take the slow path, so p50 does not move
  and a p95 threshold gate can miss it entirely
- **it looks like a reasonable commit** — the comment explains why, which is exactly how real
  regressions arrive

**Severity is a dial**, set by the fraction of traffic on the slow path:

| arm | slow-path share | expected effect | correct verdict |
|---|---|---|---|
| `A/A` | — (same build, both sides) | none | `equivalent` |
| `tail` | 2% | p99 +8%, p50/p95 flat | `b_worse` — hard |
| `small` | 8% | p95 +15%, p99 +40% | `b_worse` — the interesting case |
| `gross` | 35% | p95 +60%, throughput −20% | `b_worse` — must be caught |
| `improve` | stable vs stable with the set pre-sized | p95 −6% | `a_worse` — tests directional bias |

The `improve` arm exists because a judge biased toward "B is worse" scores well on four arms for
the wrong reason. Without it the harness cannot tell skill from pessimism.

---

## 4. The client — `loadgen` (in the sandbox)

A closed-loop generator, run in the Docker sandbox (`e2b/template/docker/`) alongside both
service versions. Same container image, same CPU allocation, both versions started for every
trial and warmed identically.

**It records, per trial:** per-request latency samples, achieved vs offered RPS, error counts by
class, the correctness-invariant results, and process RSS at fixed intervals.

**It controls for the things that would otherwise explain the result:**

- **interleaved trials**, not sequential — A, B, A, B … so drift in the host machine hits both
- **n ≥ 30 trials per arm** (matching `accuracy.min_samples`), each 60 s after a 30 s warm-up
- **fixed offered load**, open-loop arrival, so a slower build shows as latency rather than
  quietly reducing its own throughput
- **the batch-size sweep is the independent variable**: 50 / 200 / 1000, because the regression
  only exists at scale and a harness that tests one size would report "no difference" honestly
  and wrongly

**Deterministic verdict** (ground truth for scoring the judge): Mann–Whitney U on per-trial p95,
plus a bootstrap CI on the median difference. This is computed before any judge runs and is
never shown to the judge.

---

## 5. What the judge is allowed to see

The evidence bundle is the experiment's most important design decision. Give too little and the
judge is guessing; give the CI and the p-value and the task collapses into reading one number,
which measures nothing.

**Blinding rules**

- builds are `A` and `B`; which is stable is randomised per call
- no version strings, git SHAs, image tags, file names or timestamps
- **no source diff** in the default variant — with the patch in hand the judge reads the answer
  off the code, not the measurements
- no p-value, no CI, no significance verdict — that is the thing being predicted
- summary statistics only, never raw sample arrays, so the bundle stays bounded and comparable
  across backends

**Bundle** (identical shape for every backend):

```json
{
  "workload": {
    "duration_s": 60, "offered_rps": 2000, "batch_size": 1000,
    "trials_per_build": 30, "interleaved": true
  },
  "correctness": { "invariants_passed": true, "http_5xx": 0, "dropped": 0 },
  "A": {
    "latency_ms": { "p50": 41.2, "p95": 96.8, "p99": 180.4, "max": 402.1 },
    "latency_ms_trial_spread": { "p95_min": 92.1, "p95_max": 103.7 },
    "throughput_rps": { "mean": 1994.0 },
    "rss_mb": { "mean": 310, "max": 355 },
    "errors": { "timeout": 0, "conn_reset": 0 }
  },
  "B": {
    "latency_ms": { "p50": 41.9, "p95": 111.3, "p99": 252.6, "max": 690.8 },
    "latency_ms_trial_spread": { "p95_min": 104.4, "p95_max": 121.0 },
    "throughput_rps": { "mean": 1991.0 },
    "rss_mb": { "mean": 316, "max": 361 },
    "errors": { "timeout": 0, "conn_reset": 0 }
  }
}
```

`latency_ms_trial_spread` carries the run-to-run variation, which is what makes "material vs
noise" answerable at all without handing over the statistics. A judge that ignores it and fires
on a difference smaller than the spread has told us something specific about how it fails.

**Input variants** (the second independent variable, after Alexei's finding that wording moves
the answer more than evidence does):

| variant | bundle | criteria wording |
|---|---|---|
| `V1` | as above | neutral, symmetric |
| `V2` | as above | explicit noise guidance: *"treat a difference within the reported trial spread as equivalent"* |
| `V3` | + source diff | neutral |
| `V4` | summary without `trial_spread` | neutral |

`V1` is the score of record. `V2` measures how much of the judge's skill is really the prompt
author's. `V4` is the ablation showing whether the spread field is load-bearing.

---

## 6. The Jev request

Jev exposes a **Choice** primitive: it selects among supplied options and returns a probability
per option plus a confidence. It cannot produce a six-criteria 1–10 rubric, so J1 uses the
pairwise form only — consistent with the role recorded for it in `SPEC.md` §6.1.1.

**Request**

```json
{
  "model": "jev-1.13.0",
  "state": {
    "task": "Two builds of one service were measured under an identical workload on the same host, with trials interleaved.",
    "evidence": { "...": "the bundle from §5, verbatim" }
  },
  "questions": {
    "verdict": {
      "type": "choice",
      "instructions": "Compare build A and build B on the supplied measurements only. Decide whether either build is materially worse for a service whose job is sustained throughput with a bounded tail. Judge materiality against the reported trial-to-trial spread, not against the absolute difference. Choose uncertain if the evidence does not support any of the other options.",
      "criteria": {
        "equivalent": "No material difference. Any gap is comparable to the trial-to-trial spread of the same build, or is confined to a metric that does not affect sustained throughput or tail latency.",
        "a_worse": "Build A is materially worse: its latency tail, throughput or memory is degraded beyond the reported spread in a way that would affect this service in production.",
        "b_worse": "Build B is materially worse, by the same standard.",
        "uncertain": "The supplied evidence is insufficient to distinguish these cases."
      }
    }
  }
}
```

**Response** — the shape the adapter must validate (`extensions/jev.ts` in Alexei's repo is a
working reference for strict validation):

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "verdict": {
      "type": "choice",
      "choice": "b_worse",
      "probabilities": { "equivalent": 0.09, "a_worse": 0.02, "b_worse": 0.86, "uncertain": 0.03 },
      "confidence": 0.81
    }
  },
  "usage": { "input_tokens": 612, "output_tokens": 28 }
}
```

**Rules binding the request**

- **Position swap.** Every pair is sent twice, with A and B exchanged, and the two verdicts must
  agree to count as one decision. Disagreement is recorded as `unstable` — a distinct outcome,
  not a coin toss resolved by picking one.
- **`uncertain` is always an option**, and abstaining is scored as neither right nor wrong. A
  judge that abstains often but is right when it speaks is a usable gate component; one that is
  confidently wrong is not.
- **Confidence is never a gate input.** It is decisiveness across options, not the probability of
  being correct — Alexei's README states this, and J1 is the experiment that shows whether it
  correlates with correctness at all. Reporting that correlation is a secondary output.
- **No retry, no second advisor**, fixed timeout. A failed call is recorded as `unavailable` and
  excluded from accuracy, counted in cost and reliability.
- **Key in user config only**, never in the sandbox image; `api.typesafe.ai` added to the egress
  allowlist for the judge step only.

### 6.1 The same question to a rubric judge

Opus and the local Ollama judge get the identical bundle and must answer the same four options,
so verdicts are comparable. They additionally return the six-criteria rubric, which is recorded
but not used for scoring in J1 — the comparison is on the choice.

---

## 7. What is measured

Per backend, per arm, per input variant:

| metric | definition |
|---|---|
| **TPR** | correct `a_worse`/`b_worse` on arms where a regression was planted |
| **FPR** | any non-`equivalent`, non-`uncertain` verdict on the `A/A` arm |
| **MDR** | minimum detectable regression — smallest planted arm caught at ≥ 0.90 TPR |
| **swap stability** | share of pairs where both orderings agree |
| **wording sensitivity** | verdict change between `V1` and `V2` on identical evidence |
| **directional bias** | TPR on `improve` vs TPR on `small` |
| **abstention rate** | share of `uncertain`, and accuracy on the non-abstained remainder |
| **confidence calibration** | accuracy bucketed by reported confidence |
| **cost / latency** | USD and ms per decision, charged to the verify budget (§6.4) |

**Promotion condition** — a shadow judge is promoted only with `FPR ≤ 0.10`, `swap stability
≥ 0.85`, gross-arm `TPR ≥ 0.90`, and agreement with the pinned judge ≥ `judge.min_agreement`
across all arms. `min_agreement` itself is re-derived from this run rather than assumed.

---

## 8. Cost

Judge calls only; no agent generation. 5 arms × 4 variants × 30 pairs × 2 (swap) = **1,200
decisions per backend**. At ~600 input tokens each this is small for Jev and Opus, and free for
the local Ollama backend. The `loadgen` trials are compute, not API spend — they run in the local
Docker sandbox, which is why `template/docker/` rather than E2B is the right home.

---

## 9. Limits — written as limits, not caveats

- **One service, one regression shape.** An O(n) scan in a hot path is a friendly regression:
  monotonic, load-proportional, visible in the tail. Lock contention, GC pauses and cache-line
  effects are not, and J1 says nothing about them.
- **A numeric bundle is the easy case.** Passing J1 does not transfer to grading agent output.
  §1.2 states this and the report must repeat it in the verdict.
- **The bundle is authored.** Which fields appear is a choice made by whoever writes the harness,
  and `V4` shows one such choice is load-bearing. The judge is being tested on our summary, not
  on reality.
- **n = 1 machine**, the standing limit of everything in this repo. The regression's magnitude
  depends on the host; interleaving controls drift, not machine specificity.
- **The ground truth is statistical, not absolute.** Mann–Whitney on p95 is a good referee, not
  an oracle; on the `tail` arm it may itself be marginal, and where it is, that arm's TPR means
  less than the others.

---

## 10. Open questions

1. Should `unstable` (swap disagreement) count against the judge, or be reported separately?
   Leaning: against, because a gate cannot use a verdict that depends on argument order.
2. Is `improve` enough to detect directional bias, or does the harness need a matched set of
   improvements at each severity?
3. Does the rubric judge's six-criteria output add anything over the choice on this task, or is
   it ceremony? J1 records both and can answer it cheaply.
4. Should J1's A/A arm become a **permanent fixture** of every opthub run — one identical pair
   smuggled into each grading batch as a continuous check on the judge? Leaning yes; it is the
   cheapest possible guard against judge drift (`SPEC.md` §13).
