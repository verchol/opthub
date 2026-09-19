# opthub — experiments

Running log of every experiment run to prioritize Phase 1 use cases. One section per
experiment, newest last. Each one states the question, the method, the raw numbers, and the
findings that change what we build — including the ones that argue *against* something in
`SPEC.md`.

**Rule for this doc:** every number is produced by a script in `tools/`, and the exact command
is quoted in the experiment. No hand-typed figures. If an experiment contradicts an earlier
claim, the contradiction is written down, not silently fixed.

| # | Experiment | Date | Verdict for prioritization |
|---|------------|------|----------------------------|
| E1 | [1 month of local Claude Code history — find the loops](#e1--one-month-of-local-loops) | 2026-08-30 | Cost is in long interactive sessions, not loops. Cache-priming is dead here; context lifecycle and prefix size are the live levers; the gate earns its keep on a lever that *loses*. |
| E1b | [Re-run — the evidence base deletes itself](#e1b--re-run--the-evidence-base-deletes-itself) | 2026-09-03 | E1 is unreproducible: 30-day retention removed 8.9% of its spend mid-analysis. The TTL lever's sign flipped twice in an hour. Adds the **stability gate** and the **population rule** to SPEC. |

**Scored use cases → [E1 § use cases, scored](#use-cases-scored).** That table is the seed for
the backlog; nothing there is committed yet.

---

## E1 — one month of local loops

**Question.** Over the last month of real Claude Code / local Claude usage on this laptop:
which recurrent or event-based loops actually ran, what was each one's intent, model, context
size, and cost? The Phase-1 spec assumes recurring workloads are the thing worth optimizing —
this is the first check of whether that's true of a real machine.

**Method.** `tools/loopscan.py` walks `~/.claude/projects/*/*.jsonl`, the local transcript
store. Every assistant record carries `message.usage`, so token counts are billed values, not
estimates. Cost is computed at Anthropic list price ($5/$25 per MTok for Opus 5 / 4.8, $2/$10
Sonnet 5, $1/$5 Haiku 4.5; cache read 0.1x, cache write 1.25x at 5m TTL and 2.0x at 1h).
Loops are detected three ways: transcript entrypoint (`sdk-cli` = programmatic, `cli` =
human), prompt signatures that identify a machine-issued turn, and inter-arrival periodicity.
`tools/savings.py` then re-walks the same records to produce the per-session ledger below.

```bash
python3 tools/loopscan.py --since 2026-07-30
python3 tools/savings.py  --since 2026-07-30 --top 15 --csv docs/data/e1-sessions.csv
```

**Two things to know before reading any dollar figure.**

1. This traffic ran on a Claude Code subscription and was **not billed per token**. Every
   dollar is API-list-price *equivalent* — the right unit for deciding what an optimizer is
   worth, the wrong unit for reading as a bill.
2. The window ends at `now`, and the session writing this doc is inside it. Totals drift by a
   few dollars between runs; the run of record for the figures below is 2026-08-30.

### The month

| | |
|---|---|
| Window | 2026-07-30 → 2026-08-30 (32 days, 14 with traffic) |
| Sessions | 215 with billable requests · +18 prompt-only · +~355 title-generation shells (L1) |
| Billable requests | 3,479 |
| Cost (API-list equivalent) | **$518.18** |
| Tokens | cache-read 514.7M · cache-write 17.0M (all 1h TTL) · raw input 7.4k · output 3.90M (1.04M thinking) |
| Cache hit rate | **96.8%** |
| Cost mix | cache-read $257.37 (50%) · cache-write $170.27 (33%) · output $97.41 (19%) |
| Requests by model | Opus 5 3,116 (89.6%) · Sonnet 5 235 · Opus 4.8 92 · Haiku 4.5 28 |
| Scheduled jobs | **zero** — no crontab, no LaunchAgents, no routines, no `/loop` |

Cost by session context size — this is the single sharpest number in E1:

| Session median context | Requests | Cost | Share |
|---|---|---|---|
| < 20k | 26 | $0.04 | 0.0% |
| 20–60k | 631 | $31.18 | 6.0% |
| 60–120k | 1,071 | $127.64 | 24.6% |
| 120–250k | 604 | $85.50 | 16.5% |
| **≥ 250k** | **1,142** | **$274.37** | **52.9%** |

### The loops

Every loop found. "Fires" is invocations, not requests.

| # | Loop | Trigger | Fires | Model | Context / fire | Cost (32d) | Headroom |
|---|------|---------|-------|-------|----------------|------------|----------|
| L1 | Claude Code session-title generation | event: session start | **381** | not recorded (Haiku-class) | ~2.3k tok, p90 4.4k, **0% cached** | **not logged** | can't be run — see below |
| L2 | lightllm gateway shim — one CC session per gateway request | event: inbound gateway request | 186 sessions / 322 req | Sonnet 5, Haiku 4.5, Opus 5 | p50 34.8k | $7.49 (1.4%) | A $1.47 · B $0.28 |
| L3 | lightllm intent classifier (router stage 1) | event: per inbound request | 13–25 | Haiku 4.5 / Sonnet 5 | ~515–850 tok | <$0.05 | negligible |
| L4 | LangSmith tracing hooks (9 hook points/turn) | event: every prompt, tool call, stop, compact | ~4k tool events | none — non-LLM | — | $0 (2 export failures: no API key) | n/a |
| L5 | canarian-kb-sync document watcher | event: file change under `~/Documents/canarianKB` | 1 session observed | Opus 5 | p50 87.2k | $10.42 | A $1.99 · B $0.38 |
| L6 | graphify query → visualize | manual repeat, 3x in one session | 3 | Opus 5 | p50 302.4k | inside session #1 | see ledger row 1 |

**Why the savings model can't be run on L1 — the answer to "at least provide explanation."**
Every lever in `tools/savings.py` is arithmetic over `message.usage`. L1 writes a `user` record
with **no matching assistant record**: no model, no token counts, no cost, anywhere in the
local store. The only measurable quantity is the prompt's character count (381 fires ×
p50 8,951 chars ≈ 885k prompt tokens/month), and even that has to be divided by an assumed
chars-per-token ratio. At Haiku-class rates that is roughly **$0.9–1.8 for the month** — small
in dollars, and the *ratio* is the finding: the session text is a minority of each fire, the
rest is injected `CLAUDE.md` and system reminders, re-sent whole with **zero cache reuse**
because every fire is a fresh session. This is precisely the workload a transcript-scraping
capture layer cannot cost, price, or optimize. It is the strongest evidence in E1 for
wire-level capture (SPEC §5).

L2 has the same structural waste at a scale we *can* measure: one fresh Claude Code session
per gateway request means the prefix is written cold every time and never read back. The
levers below score it at $1.75 combined, but the real lever — reuse the prefix across fires —
cannot be sized without knowing what the prefix contains, which is E2.

### Per-session ledger

Full table: [`docs/data/e1-sessions.csv`](data/e1-sessions.csv) (215 rows). Top 15 by cost —
they are 92.9% of the month. All figures in $.

| # | cost | req | ctx p50 | read | write | out | *think* | **A** trim | **B** effort | **C** ttl-5m | **D** sonnet | where |
|---|------|-----|---------|------|-------|-----|---------|--------|----------|----------|----------|-------|
| 1 | 137.49 | 593 | 302,409 | 87.26 | 31.31 | 18.92 | 8.01 | **29.64** | 4.01 | −2.51 | 82.50 | graphify demo: *"use graphify query … and create a visual output"* |
| 2 | 136.88 | 549 | 273,048 | 73.72 | 48.31 | 14.85 | 3.89 | **30.51** | 1.95 | +5.52 | 82.13 | lightllm: *"summarize lasted demo additioanl and general flow"* |
| 3 | 39.70 | 174 | 178,968 | 12.99 | 16.93 | 9.78 | 0.00 | 7.48 | 0.00 | −5.09 | 23.82 | lightllm: product spec / use cases |
| 4 | 29.16 | 259 | 133,022 | 16.47 | 5.42 | 7.26 | 2.36 | 5.47 | 1.18 | +0.22 | 17.50 | KB: global KB restructure |
| 5 | 23.96 | 263 | 114,765 | 13.73 | 4.74 | 5.49 | 1.69 | 4.62 | 0.85 | +1.14 | 14.38 | proddna: k8s manifest → graph |
| 6 | 16.63 | 171 | 122,405 | 9.35 | 4.12 | 3.16 | 1.14 | 3.37 | 0.57 | +1.11 | 9.98 | lightllm |
| 7 | 16.47 | 43 | 93,254 | 1.51 | 8.94 | 6.03 | 0.00 | 2.61 | 0.00 | +2.61 | 9.88 | lightllm: recurrent-prompt demo spec |
| 8 | 14.65 | 59 | 95,802 | 2.33 | 7.50 | 4.81 | 1.42 | 2.46 | 0.71 | +1.56 | 8.79 | **opthub** (spec work) |
| 9 | 10.55 | 64 | 86,836 | 2.26 | 6.74 | 1.55 | 0.58 | 2.25 | 0.29 | +1.27 | 6.33 | langsmith |
| 10 | 10.43 | 124 | 100,144 | 5.72 | 2.51 | 2.20 | 0.91 | 2.06 | 0.45 | −1.03 | 6.26 | canarian-mvp |
| 11 | 10.42 | 129 | 87,180 | 5.43 | 2.51 | 2.47 | 0.76 | 1.99 | 0.38 | +0.37 | 6.25 | canarianKB (**L5**) |
| 12 | 10.05 | 59 | 111,141 | 2.75 | 2.94 | 4.37 | 0.08 | 1.42 | 0.04 | +1.10 | 6.03 | KB: `/graphify` |
| 13 | 9.09 | 93 | 66,983 | 3.08 | 2.80 | 3.20 | 1.08 | 1.47 | 0.54 | −0.98 | 5.45 | ollama |
| 14 | 8.54 | 67 | 103,205 | 3.03 | 3.02 | 2.49 | 0.75 | 1.51 | 0.38 | +1.13 | 5.12 | **opthub** (this experiment) |
| 15 | 7.81 | 96 | 80,789 | 3.44 | 1.61 | 2.75 | 0.92 | 1.26 | 0.46 | −0.16 | 4.68 | deepagents |
| … | 36.91 | 731 | — | 12.18 | 17.83 | 6.90 | 1.65 | 7.50 | 0.82 | −10.48 | 19.38 | remaining 200 sessions |
| **ALL** | **518.73** | **3,474** | — | 255.25 | 167.24 | 96.24 | 25.24 | **105.62** | **12.62** | **−4.24** | **308.47** | |
| | | | | | | | **% of spend** | **20.4%** | **2.4%** | **−0.8%** | 59.5% | |

`think` is a subset of `out`, shown because it is the part effort controls.

**What each lever is, and how much to trust it.** Exactly one is measured.

| | Lever | Kind | Computation | Trust |
|---|-------|------|-------------|-------|
| **A** | prefix-trim | **scenario** | 25% less re-sent prefix → 25% of (read$ + write$) | Headroom is measured; the 25% is invented. **E2 replaces it.** |
| **B** | effort-tune | **scenario** | 50% fewer thinking tokens at output rates | Thinking tokens are measured exactly per session; the 50% is invented, and it is a **floor** — effort also shortens non-thinking output and consolidates tool calls, neither of which is counted here. **E3 replaces it.** |
| **C** | ttl-5m | **MEASURED** | replay each request's real inter-arrival gap; a gap > 300s expires a 5m entry and forces a full prefix re-write at 1.25x | Arithmetic over the actual trace. Not a replay against the API, but the semantics are the documented ones. |
| **D** | sonnet-ceiling | **CEILING** | identical token counts repriced at Sonnet 5 list rates | The "identical tokens" assumption is the flaw: a smaller model may need more turns. Sizes the prize; is not a proposal. |

A and B act on opposite sides of the request (input prefix vs output tokens) and stack to
**$118.24, 22.8%**. C and D do not stack with anything — C is a config choice, D swaps the
price table under everything.

**Concentration matters more than any lever.** The top 2 sessions are 52.9% of the month, the
top 5 are 70.8%, the top 15 are 92.9%. 73.6% of lever A's total headroom sits in 5 sessions.
An optimizer that only fires on the long tail is optimizing 7% of the bill.

### Findings

**E1-F1 · There are no scheduled loops on this machine. Not one.** No crontab, no
LaunchAgents, no Claude routines, no `/loop`. Every loop above is *event*-triggered — a session
starting, a request arriving, a file changing. Phase 1 should stop saying "recurring workload"
and say **"machine-issued turn"**: what they have in common is that no human read the output,
not that a clock fired.

**E1-F2 · Loops are 1.4% of the spend. One human is 98.6%.** All programmatic traffic
(`sdk-cli`) is $7.49 of $518.18. Two interactive sessions are $274.37 — **52.9%** of the month.
If opthub only governs loops, it governs 1.4% of this laptop. The demo's `supportbot` framing
assumes a shape this machine does not have.

**E1-F3 · The highest-frequency loop is invisible to cost telemetry.** L1 fires 381 times and
leaves no assistant record, no `usage`, no model, no cost, in the only local store there is.
A capture layer that reads transcripts cannot see this workload — capture has to sit at the
wire, which is what SPEC §5 already says. This is the first hard evidence for it.

**E1-F4 · Cache-priming has nothing left to win here — the headline optimizer is dead on this
workload.** `docs/optimizers.md` puts cache-priming at −64.4%, the largest single win in the
cookbook. Measured hit rate on a real month: **96.8%**. Claude Code already caches the whole
prefix at 1h TTL. The −64.4% figure is real for a *naïve* client and worth ~nothing for a
well-configured one. Phase 1 must say which world it optimizes, and the ROI gate must measure
current hit rate *before* proposing the optimizer, not after.

**E1-F5 · Re-sent bytes are 96.8% of input and still 50% of the bill.** Caching moved this
traffic from 1.0x to 0.1x, not to zero: $257.37 of cache *reads*. The remaining lever is not
"cache the prefix" — it is **how much prefix gets re-sent per turn**, and how long a session is
allowed to grow before that prefix is reset. 52.9% of the bill comes from requests whose
session median context is ≥250k tokens. None of the five candidate optimizers addresses this.

**E1-F6 · The obvious TTL optimizer loses money — and the gate is what catches it.** Measured
inter-request gaps: p50 **4s**, p90 29s, p95 93s, p99 1,168s; only **2.6%** exceed 5 minutes.
Read naively, the 1h TTL (2.0x write) looks over-provisioned and 5m (1.25x) looks like a ~$50
win. Simulated properly, the 2.6% of long gaps force **253 full prefix re-writes** totalling
14.6M tokens, and 5m TTL costs **$4.03 more**, not less — and it loses in **168 of 215
sessions**:

| TTL | Cost over the window |
|-----|----------------------|
| 1h (actual) | $422.02 |
| 5m (counterfactual) | $426.05 (**+$4.03**) |

The best argument in the repo for the non-optional gate: a lever that is obviously right from
the summary statistic and wrong from the trace. Worth a T2 tier and a cookbook entry.

**E1-F7 · Output is 19% of the bill and 27% of output is thinking — an untested lever.**
1.04M of 3.90M output tokens are thinking tokens, at $25/MTok. Effort (`low`…`max`) is a
first-class knob on Opus 5 that no candidate optimizer touches. It is a *within-model* trade,
so unlike a model cascade it does not fragment the cache namespace — though changing effort
mid-conversation does invalidate the messages cache, which the gate has to price.

**E1-F8 · Model choice is not a live lever here.** 89.6% of requests are already Opus 5 by
harness policy, on interactive coding — the workload where downgrade risk is highest and the
eval harness weakest. D's $308.47 ceiling is the largest number in the ledger and the one
least likely to survive G2.

### Use cases, scored

Scored from E1 only. **Nothing here is committed** — this is the seed for the backlog.

Each dimension 0–5. `Score = 2 × (0.40·Value + 0.25·Evidence + 0.20·GateEase + 0.15·BuildEase)`,
so the scale is 0–10.

- **Value** — measured headroom as a share of spend, discounted for how invented the assumption is.
- **Evidence** — how directly E1 measured it, versus how much is still scenario.
- **GateEase** — how cheaply a proposal can be proven safe under G1–G4. 5 = pure config, no accuracy surface. 1 = touches what the model sees on the traffic that dominates the bill.
- **BuildEase** — how cheaply Phase 1 can ship it. 5 = arithmetic we already have. 1 = needs new capture infrastructure.

| Rank | UC | Use case | V | E | G | B | **Score** | Measured basis |
|---|---|---|---|---|---|---|---|---|
| 1 | **UC-8** | **Context lifecycle** — cap session growth; compact / split / reset before the prefix ratchets past ~120k | 4 | 4 | 3 | 3 | **7.3** | 52.9% of spend is requests at ≥250k session context; top 2 sessions are 52.9% |
| 2 | **UC-1** | **Prefix trim** — cut what is re-sent per turn (tool schemas, stale tool results, dead CLAUDE.md) | 5 | 3 | 2 | 2 | **6.9** | lever A = $105.62 (20.4%) at a 25% trim; 73.6% of it in 5 sessions |
| 3 | **UC-4** | **Model routing** — Opus 5 → Sonnet 5 on the subset that can prove it | 5 | 3 | 1 | 3 | **6.8** | lever D ceiling = $308.47 (59.5%); 89.6% of requests are Opus 5 |
| 4 | **UC-5** | **Wire-level capture** — cost every call including ones with no transcript record | 2 | 5 | 5 | 2 | **6.7** | E1-F3: L1's 381 fires have no usage record anywhere local |
| 5 | **UC-2** | **Effort tuning** — `low`/`medium` where quality holds, within-model | 2 | 4 | 3 | 4 | **6.0** | lever B = $12.62 (2.4%) measured floor; 27% of output is thinking |
| 6 | **UC-3** | **Cache-config gate** — verify TTL / breakpoint changes against the trace before applying | 0 | 5 | 5 | 4 | **5.7** | E1-F6: the obvious change costs +$4.03 and loses in 168/215 sessions |
| 7 | **UC-7** | **Cache-priming** — the current headline optimizer | 0 | 5 | 4 | 4 | **5.3** | E1-F4: 96.8% hit rate already; nothing left to win |
| 8 | **UC-6** | **Machine-issued-turn governance** — the recurring-agent story in SPEC | 0 | 5 | 4 | 3 | **5.0** | E1-F2: all `sdk-cli` traffic is $7.49, 1.4% of spend |

**Reading the table.**

- **UC-8 wins on evidence, not on ceiling.** It is the only top-ranked use case whose headroom
  needs no invented assumption — the concentration is a measured fact, and the intervention
  (reset the session) needs no knowledge of what is inside the prefix. It is also the one a
  user can act on today, which makes it the natural first gate to build against.
- **UC-4 has the biggest prize and the worst odds.** $308.47 is more than half the month, and
  G2 will fight it on 89.6% of requests. Keep it, size it, expect the gate to block it — and
  treat a *blocked* UC-4 as a successful demo, not a failure.
- **UC-3 and UC-7 score mid-table with zero savings.** That is the rubric working. Their value
  is as gate evidence and as a detector: UC-7 should ship as "measure the hit rate and say
  nothing when it is already 96.8%", which is a different product than "prime the cache".
- **UC-6 is the current spec's centre of gravity and ranks last.** On this machine. It may rank
  first on a machine with real recurring agents — E4 is the test, and until it runs, the
  demo's framing rests on an untested assumption.

### Threats to validity

- **n=1 machine, 14 active days, and it is the machine building opthub.** The workload is
  spec-writing and demo-building, not production service traffic. F2's 98.6%-interactive split
  is a fact about this laptop, not about the market — but it *is* a fact about the Phase-1
  demo's own dogfood environment.
- Two sessions carry 52.9% of the cost, so distribution-level claims are thin. Per-request
  claims (gaps, hit rate, context distribution, TTL simulation) draw on all 3,479 requests and
  are sturdier.
- Levers A, B and D are **not forecasts.** A and B are headroom under an invented percentage;
  D is a ceiling under an assumption ("same tokens on a smaller model") that is probably false.
  Only C is measured. Do not quote A/B/D as savings until E2/E3 replace their assumptions.
- L1's cost is estimated from character count at ~3.7 chars/token — the one unmeasured number
  in E1, and that is itself F3.
- `Bash` (1,258 calls) dwarfs `Read` (77) because this session's auto-mode instructs shell
  reads. Tool-mix numbers are an artifact of harness config, not a finding.
- The window ends at `now` and includes the sessions that produced this document (ledger rows
  8 and 14, $23.19 combined, 4.5% of the month). Re-running drifts the totals.

### Reproduce

```bash
python3 tools/loopscan.py --since 2026-07-30                 # month aggregate + loop detection
python3 tools/savings.py  --since 2026-07-30 --top 15 \
        --csv docs/data/e1-sessions.csv                      # per-session ledger + levers
```

`loopscan` prints the aggregate block, per-model and per-entrypoint splits, loop-signature fire
counts, gap percentiles, the TTL counterfactual and the top sessions. `savings` prints the
ledger and writes all 215 rows to CSV with per-session lever columns.

### Next experiments

- **E2 — prefix anatomy.** Of the 514.7M cache-read tokens, how much is system prompt / tool
  schemas / CLAUDE.md / conversation history / tool results? Replaces lever A's invented 25%
  and ranks UC-1. Needs wire capture, which also tests F3 (UC-5).
- **E3 — effort sweep.** Same prompts at `low`/`medium`/`high`/`xhigh` against a golden set.
  Replaces lever B's invented 50%, ranks UC-2, and is the first real exercise of the G2 gate.
- **E4 — does F6 invert on loop-shaped traffic?** L2's shape is one fresh session per request
  with gaps of minutes. The 1h TTL may lose there for exactly the reason it wins here. Also
  the test of whether UC-6 deserves its place in the spec.
- **E5 — context lifecycle simulation.** Replay the two 250k+ sessions with a compaction /
  reset policy at 120k and price the result. Ranks UC-8 without needing prefix anatomy.

---

## E1b — re-run: the evidence base deletes itself

**Question.** Re-run E1's exact pinned command four days later. Which findings survive, and does
anything move? This was intended as a cheap robustness check on E1 before rebuilding `SPEC.md`.
It did not stay cheap.

**Method.** Identical to E1 — same scripts, same pinned `--since 2026-07-30`. Run twice on
2026-09-03, roughly thirty minutes apart, with no intervening change to the tools.

```bash
python3 tools/loopscan.py --since 2026-07-30
python3 tools/savings.py  --since 2026-07-30 --top 15 --csv docs/data/e1b-sessions.csv
```

### The month, re-measured (run of record: 2026-09-03, run 2)

| | E1 · 2026-08-30 | E1b · 2026-09-03 |
|---|---|---|
| Sessions (billable) | 215 | 214 |
| Billable requests | 3,479 | 3,370 |
| Cost (API-list equivalent) | $518.18 | **$508.39** |
| Cache hit rate | 96.8% | **96.6%** |
| ≥250k-context share of spend | 52.9% | **53.9%** |
| Opus 5 share of requests | 89.6% | **89.0%** |
| `sdk-cli` (programmatic) spend | $7.49 | **$7.49** |
| Lever A prefix-trim | 20.4% | **20.5%** |
| Lever B effort | 2.4% | **2.7%** |
| Lever D Sonnet ceiling | 59.5% | **59.5%** |

**Four days passed and the window got smaller.** That is the whole experiment.

### E1b-F1 · The local transcript store is on a 30-day timer, and it fired mid-analysis

`cleanupPeriodDays` is unset in every settings file, so Claude Code's 30-day default applies.
Between run 1 and run 2 on the same afternoon:

| | run 1 | run 2 | Δ |
|---|---|---|---|
| `.jsonl` files under `~/.claude/projects` | 567 | 561 | **−6** |
| sessions in ledger | 216 | 214 | −3 deleted, +1 new |
| window cost | $549.98 | $508.39 | **−$41.59** |

The three deleted sessions all started **2026-07-31** and totalled **$46.25**. The oldest surviving
transcript is 2026-08-05 — 29 days old. Nothing older than the retention boundary exists.

Diffed against E1's pinned CSV:

| | |
|---|---|
| E1 run of record | 215 sessions · $518.73 |
| Still on disk 2026-09-03 | 212 sessions · $472.47 |
| **Deleted by retention** | **3 sessions · $46.25 — 8.9% of E1's spend** |
| Mutated (same session, resumed and grew) | 2 sessions |

**E1's totals can never be reproduced.** The reproduce block printed in E1 returns a different
answer every day, and the difference is not new traffic — it is old traffic being destroyed. The
doc's own rule ("every number is produced by a script, the exact command is quoted") turns out not
to be sufficient for reproducibility when the script reads a store that deletes its inputs.

### E1b-F2 · The TTL lever's sign flipped twice in one hour — E1-F6 is overturned

| run | 1h TTL (actual) | 5m TTL (counterfactual) | verdict |
|---|---|---|---|
| E1 · 2026-08-30 | $422.02 | $426.05 | 1h wins by **$4.03** |
| E1b · 2026-09-03 run 1 | $449.43 | $445.12 | 5m wins by **$4.31** |
| E1b · 2026-09-03 run 2 | $417.71 | $406.25 | 5m wins by **$11.46** |

The first flip came from four days of new traffic. **The second flip came from deletion.** No
workload changed between run 1 and run 2.

E1-F6 claimed "the obvious TTL win loses, and the gate is what catches it." That claim was *true of
one window and false of the next two*. The corrected finding is stronger, not weaker: **the lever's
month-level sign is a sampling artifact, and no point estimate over a rolling window can be trusted
to have the right sign.**

### E1b-F3 · Why it was unstable — two populations that want opposite settings

The aggregate is a near-cancellation. Splitting the same 214 sessions by measured cache
**write:read ratio**:

| write:read | sessions | spend | 5m TTL delta |
|---|---|---|---|
| **> 2.0** — writes the prefix, rarely reads it back | 95 | $86.81 | **+$12.75** (5m wins) |
| 1.0 – 2.0 | 5 | $12.50 | +$0.59 |
| 0.5 – 1.0 | 10 | $172.34 | +$6.27 |
| **< 0.5** — long sessions that amortize the write | 104 | $237.15 | **−$8.56** (1h wins) |
| **net** | 214 | $508.80 | **+$11.05** |

Two large opposed effects summing to a small residual whose sign is set by which sessions survive on
disk. The mechanism is not subtle: a session that writes cache and never reads it back is paying a
2.0× write premium it never amortizes, and a session that reads for hours is doing the opposite.

The same split held in run 1 (+$12.90 / −$10.43), so the *populations* are stable even though the
*aggregate* is not. **The population is the finding; the aggregate was never the signal.**

### What this changed in SPEC

| # | Change | SPEC §|
|---|---|---|
| E1b-F1 | Capture must own durable storage; retention is opthub's policy, never inherited from a host app | §5.2 |
| E1b-F1 | Baselines pinned by content hash; `baseline verify`; proposals over vanished inputs marked `STALE`; exit code `15` | §4, §6.5, §10 |
| E1b-F2 | **Stability gate** — a candidate's sign must not flip across k sub-windows; exit code `14` | §6.5 |
| E1b-F3 | **Population rule** — propose against the segment the lever helps, never the portfolio aggregate | §6.6 |
| E1b-F3 | The TTL proposal is segmented by write:read ratio, not global | §6.6, §11 Act 4 |
| — | E1-F6 superseded: not "the obvious lever loses" but "the aggregate's sign is noise" | §2.3 |

### What survived unchanged

E1-F1 (no scheduled loops), E1-F2 (loops are ~1.5% of spend), E1-F3 (title-gen has no usage record
— still 381 fires, still uncostable), E1-F4 (cache-priming dead at 96.6%), E1-F5 (spend concentrated
in ≥250k-context sessions), E1-F7 (output ~19%, thinking ~30% of it), E1-F8 (Opus 5 already at 89%).
All moved by less than a point across a four-day gap. These are the findings `SPEC.md` §2.2 builds on.

### Threats to validity

- Still n=1 machine, still the machine building opthub. E1b inherits every one of E1's caveats.
- The retention boundary is inferred from an unset `cleanupPeriodDays` plus the observed 29-day floor
  on surviving transcripts. It was not read from Claude Code's source, and the deletion was observed
  once, not instrumented.
- Run 1 and run 2 differ by both deletion *and* ~30 minutes of this session's own traffic. The
  $41.59 delta is dominated by the $46.25 of deletions, but is not purely deletion.
- The write:read population split is a *correlational* explanation of the sign flip. It is
  mechanically plausible and stable across both runs, but no counterfactual replay against the API
  was run to confirm it.

### Reproduce

```bash
python3 tools/loopscan.py --since 2026-07-30
python3 tools/savings.py  --since 2026-07-30 --top 15 --csv docs/data/e1b-sessions.csv
```

**This block will not reproduce the numbers above**, and that is E1b-F1. `docs/data/e1b-sessions.csv`
is the pinned run of record; treat it, not the command, as the evidence.
