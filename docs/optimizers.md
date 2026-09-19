# The five optimization candidates

> **⚠ Superseded in part — read `SPEC.md` §2 first.** The headline here, `cache-priming` at
> **−64.4%**, is a *naive-client* number. Measured hit rate on a real month is **96.6%**
> (E1-F4): there is nothing left to win, and the optimizer is demoted to a **detector** in
> SPEC v0.2. The marginal-attribution rules (§1–§2) and the per-optimizer mechanics still hold.

**Status:** v0.1 · **Date:** 2026-08-24 · Supersedes the candidate numbers in SPEC.md §09.

All dollar figures are produced by `tools/costmodel.py`. Run it before editing any number here.

**Worked examples — before/after requests, `usage` proofs, per-line arithmetic, and a reproducible
failure for each optimizer — are in [`optimizers-cookbook.md`](./optimizers-cookbook.md).** That
document supersedes this one where they overlap; it added findings F5–F7 (ADR-0007 … ADR-0009).

---

## 0. The workload under test

`supportbot/draft-reply`, the most expensive of the three seeded workloads. Captured shape:

| Segment | Tokens | Stability | Cacheable |
|---|---:|---|---|
| Tool definitions (30 tools) | 1,200 | byte-stable | yes — renders at position 0 |
| System preamble | 8,000 | byte-stable | yes |
| Ticket + conversation history | 1,500 | varies per request | **no** |
| Output | 400 | — | — |

Model `claude-opus-5` at $5.00 / $25.00 per MTok. Cache reads cost 0.10×, cache writes 1.25×
(5-minute TTL). Baseline: **$63.50 per 1,000 requests**, of which $53.50 is input and $10.00 output.

That split is the single most important fact about this workload: **84% of the spend is input
tokens, and 9,200 of the 10,700 input tokens are byte-identical on every request.**

---

## 1. Applied in order, with marginal attribution

```
step                                   $/1k   marginal  cumulative
------------------------------------------------------------------
baseline (no caching)                 63.50          —           —
+ cache-priming              [T0]     22.63     −64.4%      −64.4%
+ context-pruning            [T1]     19.63     −13.3%      −69.1%
+ tool-schema-slimming       [T1]     19.10      −2.7%      −69.9%
+ model-routing 60% Haiku    [T2]      9.93     −48.0%      −84.4%
prompt-compaction            [T1]         —   REJECTED           —
```

**Correction to SPEC.md §09.** The published table understated this badly — it showed cache-priming
at −31% and a −41% cumulative. Doing the arithmetic gives −64.4% and −84.4%. The published figures
were plausible-looking placeholders, not computed ones; every number in this document now comes out
of a script that ships with the repo.

---

## 2. Why order and attribution are a spec problem, not an implementation detail

Run `tools/costmodel.py` and look at the ordering section:

```
tool-schema-slimming applied FIRST  (uncached):  −7.4%
tool-schema-slimming applied AFTER cache-priming: −2.7%
```

The identical change — deleting 940 tokens of unused tool schema — is worth **2.7× more** when
measured on its own than when measured after caching is on. The reason is mechanical: caching drops
the price of every prefix token from $5.00/MTok to $0.50/MTok, so any optimizer whose job is
*shrinking the prefix* has 90% of its value taken away by the optimizer that ran before it.

This produces three rules the implementation has to obey.

> **R1 — Attribution is marginal, in applied order.** A proposal reports what it saves *given what is
> already applied*, never its standalone number. Standalone figures sum to more than 100% of the
> actual saving and would let a proposal claim credit for money another proposal already saved.

> **R2 — T0 runs first, always.** Cache-priming is free of accuracy risk and captures the largest
> share of the win. Running it first also correctly deflates every prefix-shrinking candidate behind
> it, which is exactly what we want: it stops the system from taking accuracy risk for a win that
> caching already banked.

> **R3 — After caching, only the uncached suffix and the output are worth risk.** Post-cache, prefix
> tokens cost $0.50/MTok and output tokens cost $25/MTok — a 50× difference. An optimizer that
> touches the suffix or the output is worth far more per unit of accuracy risk than one that touches
> the prefix.

R3 is why `context-pruning` (−13.3%, touches the uncached suffix) beats `tool-schema-slimming`
(−2.7%, touches the cached prefix) by 5× despite removing fewer tokens.

---

## 3. The candidates

### 3.1 `cache-priming` — T0, auto-applied

**What it does.** Inserts `cache_control: {type: "ephemeral"}` breakpoints at stability boundaries in
the rendered prompt. For this workload: one breakpoint on the last system text block, which caches
tools + system together (render order is `tools` → `system` → `messages`, so a marker on the last
system block covers both).

**Why it is T0.** The breakpoint is metadata about *how the API should treat the prefix*. It does not
add, remove, or reorder a single token the model sees. The sampled distribution is provably identical.
This is the only optimizer in the catalog where "accuracy unchanged" is a statement about the API
contract rather than an eval result — the gate still runs, but it is confirming a proof, not
discovering a fact.

**Cost: −64.4%.** 9,200 tokens/request move from $5.00/MTok to $0.50/MTok. With ~1% of requests paying
the 1.25× write premium to re-warm a 5-minute TTL window under continuous traffic, input spend falls
from $53.50 to $12.63 per 1k.

**Latency: this is where the spec was wrong.** Caching eliminates prefill of 9,200 tokens, which is a
large TTFT win — roughly −60% to −70% time-to-first-token. But total wall-clock is dominated by
*generation*: 400 output tokens at ~60 tok/s is ~6.7 seconds, against maybe 0.6s of saved prefill.
The honest total-p95 improvement is **−8% to −12%, not the −22% published in SPEC.md.**

> **Finding F1 — the latency gate measures the wrong thing.** A single p95-of-total-wall-clock number
> hides the entire benefit of caching and would let a change that wrecks TTFT pass as long as
> generation time held. The gate must record **TTFT and total latency as separate series**, and
> `cache-priming`'s headline latency claim is TTFT. Filed as ADR-0003.

**Failure modes the optimizer must check before proposing:**

- **Minimum cacheable prefix is model-dependent and not monotonic across generations** — 512 tokens
  on Opus 5, 1,024 on Opus 4.8 and Sonnet 5, 4,096 on Haiku 4.5 and Opus 4.6. Below the minimum
  nothing caches and there is *no error* — `cache_creation_input_tokens` is simply 0. The optimizer
  must look up the target model's minimum, not assume one.
- **Silent invalidators upstream of the breakpoint.** A `datetime.now()` in the system prompt, an
  unsorted `json.dumps`, a user ID interpolated into the preamble, or a per-user tool list means the
  prefix bytes differ every request and the breakpoint writes a fresh entry that is never read — you
  pay the 1.25× premium forever and read nothing. **The optimizer must verify empirically, not
  statically:** replay two captured requests and assert `cache_read_input_tokens > 0` on the second.
  A proposal that cannot demonstrate a cache read is not a proposal.
- **20-block lookback.** Each breakpoint walks back at most 20 content blocks to find a prior entry.
  Agentic turns that emit more than 20 tool_use/tool_result blocks silently miss. Needs an
  intermediate breakpoint roughly every 15 blocks.
- **Max 4 breakpoints per request.** The placement search is bounded at 4; it must choose, not spray.
- **Concurrent fan-out.** An entry is readable only once the first response *begins streaming*. N
  parallel identical requests all pay full price. If the capture shows fan-out, the proposal must
  include the send-one-then-fan-out change or its predicted saving is fiction.

---

### 3.2 `context-pruning` — T1, auto-applied

**What it does.** Drops stale turns and tool results from the conversation history — the portion after
the last breakpoint, which is never cacheable. Here: 1,500 → 900 tokens.

**Cost: −13.3%.** It removes only 600 tokens against tool-schema-slimming's 940, yet saves 5× more,
because those 600 tokens are billed at the full $5.00/MTok while the prefix is billed at $0.50. This
is R3 in one line.

**Latency: −3%.** Small; the suffix was never the bottleneck.

**Accuracy risk: medium.** The failure is deleting a turn that carried the answer — a tool result from
six turns back that the current turn still references. Guardrails:

- Prune only tool results older than K turns
- Skip any block whose content has token overlap with later turns (cheap string-containment check)
- Never prune the most recent tool result of any given tool
- Prefer the API's own `context_management` clearing strategies over hand-rolled pruning where the
  shape fits, so the semantics are the server's rather than ours

**Interaction to watch.** Pruning changes the *suffix*, which sits after the breakpoint — so it does
not invalidate the cache. This is precisely why it composes cleanly with `cache-priming` and can be
auto-applied alongside it. An optimizer that changed the *prefix* would invalidate every warm entry
on deploy and eat a one-time re-warm cost that the ROI gate has to account for.

---

### 3.3 `tool-schema-slimming` — T1, auto-applied

**What it does.** Removes tool definitions the workload never invokes. Capture showed 4 of 30 tools
used; the other 26 are 940 tokens of dead prefix.

**Cost: −2.7%.** Real but small, for the reason in §2. Standalone it would report −7.4%, and reporting
that number would be a lie by omission.

**The actual case for it is not cost.** Two better reasons:

1. **Accuracy.** Distractor tools cause wrong tool selection. Slimming 30 → 4 typically *improves*
   the deterministic tool-call-match score rather than holding it flat. The eval should be watched for
   an improvement here, and if none appears, that is evidence the capture window missed a code path.
2. **Headroom.** Tool definitions render at position 0. Every byte there is a byte that must stay
   byte-stable forever or the entire cache dies. A smaller tool block is a smaller surface for
   accidental invalidation.

**Accuracy risk: low but not zero.** The failure is removing a tool used on a rare path the capture
window never saw — a monthly reconciliation job, an error-handling branch. Guardrails:

- Zero invocations across the **full** captured window, not the golden set (the golden set is 50
  samples; the window is 400+)
- Tool name not referenced in the system prompt text (a prompt that says "use `escalate_to_human` when
  unsure" pins that tool even at zero observed invocations)
- Capture window must exceed a policy-configured minimum duration before this optimizer may run at all
- Removal is reversible and journaled; rollback restores the exact prior tool block

> **Finding F2 — "unused" is a claim about the observation window, not the code.** This optimizer is
> the one most likely to be *silently* wrong, because its failure only shows up on traffic that has
> not happened yet. It should carry a mandatory minimum-observation-window gate that the other
> optimizers do not need. Filed as ADR-0004.

---

### 3.4 `model-routing` → Haiku 4.5 — T2, requires approval

**What it does.** Classifies each request by difficulty and sends the easy ones to
`claude-haiku-4-5` ($1.00 / $5.00 per MTok) while hard ones stay on `claude-opus-5`. Demo assumes a
60/40 split.

**Cost: −48.0%**, taking the workload to $9.93/1k and −84.4% cumulative. The largest single win after
caching, and the reason it is worth the approval friction.

**Why −48% and not the naive −58%.** Three deductions the estimator must model:

1. **Caches are model-scoped.** Splitting traffic across two models creates two cache entries. Each
   gets fewer reads, and you pay two sets of writes. There is *no* escape hatch for this — unlike
   tool changes or system-prompt edits, a model switch invalidates all three cache tiers with no
   cache-preserving form.
2. **Output dominates on the routed traffic.** Haiku's output is $5/MTok against Opus's $25 — a real
   4× saving — but the 400 output tokens are the largest single line item post-caching, so the blend
   is set by how much traffic actually routes, not by the headline price ratio.
3. **`never_downgrade` carve-outs.** `supportbot/pii-extract` is pinned to Opus by policy and is
   excluded from the routable pool entirely.

**The Haiku cache-minimum trap.** Haiku 4.5's minimum cacheable prefix is **4,096 tokens** against
Opus 5's **512**. A workload with a 2,000-token prefix caches on Opus 5 and *silently does not cache*
on Haiku 4.5. Our 8,260-token prefix clears both, so the demo is unaffected — but a naive estimator
that assumes the source model's cache behavior carries over would over-predict the saving on any
workload with a prefix between 512 and 4,096 tokens.

> **Finding F3 — the cost estimator must model per-model cache minimums.** Otherwise the ROI gate
> (§06) approves verification spend against a saving that will not materialize. Filed as ADR-0005.

**How the router decides — and why not the obvious way.** Three designs, in order of how tempting
they are:

| Design | Marginal latency | Marginal cost | Verdict |
|---|---|---|---|
| Cheap classifier model call per request | +1 round trip | +1 request | **No.** Adds a call to save a call |
| Speculative: try Haiku, judge, escalate on low confidence | +100% on escalations | +1.x requests on escalations | Tail safety net only |
| Offline-fitted classifier on cheap request features | ~0 | ~0 | **Yes** |

Recommended: fit a small classifier offline from captured traces on features that cost nothing to
compute at request time — ticket length, attachment presence, number of distinct tools the trace
needed, presence of policy keywords, thread depth. It runs in the daemon in microseconds and adds no
API call. The speculative escalation path stays available as a configurable safety net for the tail,
where its latency cost is paid only on the requests that need it.

**Accuracy risk: medium-high, but measurable.** 0.96 → 0.95 in the demo. This is the one candidate
where the accuracy cost is real and the human is being asked to accept it in exchange for −48%. That
is exactly the trade a policy file should not make silently, which is the whole argument for T2.

**Why T2 exists at all.** Every other optimizer changes *how* a model is asked. This one changes *who
answers*. A regression here is not a degraded response — it is a different system. That is a category
difference, not a magnitude difference, and no eval score should be allowed to auto-approve it.

---

### 3.5 `prompt-compaction` (aggressive) — T1, **REJECTED**

**What it does.** Rewrites the 8,000-token system preamble down to 4,500 — deduping repeated
instructions, trimming few-shot examples, collapsing redundant formatting rules.

**Accuracy: 0.96 → 0.89.** Seven points. The gate kills it. `relative_drop_max` is `0.00`; there is no
override flag.

**And the reward was never as good as it looked.** Measured against the post-caching state, compaction
is worth **−12.6%** — because it shrinks the prefix, and the prefix now costs $0.50/MTok. Standalone,
against an uncached baseline, the same edit would report roughly −33%. So the candidate that carries
by far the highest accuracy risk in the catalog also delivers, in its correct marginal position, less
than model-routing and barely more than context-pruning.

> **Finding F4 — the rejection is economically overdetermined, not just an eval failure.** Under R1/R3
> this candidate is a bad trade *before* the eval runs: highest risk class, mid-tier reward, and it
> invalidates every warm cache entry on deploy. The optimizer should be able to reason about that
> ex ante and deprioritize it, rather than spending verification budget to discover it. Filed as
> ADR-0006.

**Why it fails, mechanically.** Deleting instructions is deleting behavior. The instruction that
matters may fire on 2% of traffic — an escalation rule, a refusal boundary, a formatting requirement
for one ticket category. A 50-sample golden set drawn from typical traffic systematically undersamples
exactly those paths. The candidate looks fine on the common case and fails on the tail, and the tail
is where the 7 points went.

This is also the strongest argument for the held-out-slice mitigation in SPEC.md §11: a compaction
candidate is precisely the shape of change that overfits a golden set.

**Three extra costs the naive version ignores:**

- **Cache invalidation on deploy.** Rewriting the preamble changes the prefix, killing every warm
  entry. One-time, but the ROI gate must include the re-warm.
- **It fights `cache-priming`.** Every future compaction re-invalidates. Two optimizers that both
  target the prefix but with opposite stability requirements — one wants it frozen forever, the other
  wants to keep editing it.
- **It is the least reversible.** Rolling back a routing table is a config change. Rolling back a
  rewritten prompt means restoring prose that a human may have since edited on top of.

**Is there a version that passes?** Probably — a conservative variant that only removes *provably*
dead text (an instruction referencing a tool that no longer exists, a duplicated paragraph) rather
than rewriting for concision. That is a different optimizer with a different risk profile, and it
should be catalogued separately rather than as a "less aggressive" knob on this one.

---

## 4. Summary

| Optimizer | Tier | Marginal $ | Latency | Accuracy risk | Why the tier |
|---|---|---:|---|---|---|
| `cache-priming` | T0 | **−64.4%** | TTFT −65%, total −10% | **none — provable** | Metadata only; no token the model sees changes |
| `context-pruning` | T1 | −13.3% | −3% | medium | Touches the uncached suffix; can delete a needed turn |
| `tool-schema-slimming` | T1 | −2.7% | ~−1% | low | "Unused" is a claim about the observation window |
| `model-routing` | T2 | −48.0% | −25% blended | medium-high | Changes *who answers*, not how they are asked |
| `prompt-compaction` | T1 | −12.6% | −5% | **high** | Deleting instructions is deleting behavior |

**Cumulative, gates passed: $63.50 → $9.93 per 1k requests, −84.4%.**

---

## 5. What this analysis changed in the spec

| # | Change | ADR |
|---|---|---|
| F1 | Latency gate must track TTFT and total as separate series | ADR-0003 |
| F2 | `tool-schema-slimming` needs a minimum-observation-window gate | ADR-0004 |
| F3 | Cost estimator must model per-model cache minimums | ADR-0005 |
| F4 | Optimizers need ex-ante risk/reward ranking to spend verification budget well | ADR-0006 |
| R1 | Attribution is marginal, in applied order | ADR-0002 |
| R2 | T0 runs first, always | ADR-0002 |
| R3 | Post-cache, only the uncached suffix and output are worth accuracy risk | ADR-0002 |
