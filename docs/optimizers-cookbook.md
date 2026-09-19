# Optimizer cookbook — worked examples

> **⚠ Read `SPEC.md` §2 first.** The worked mechanics below are current, but two framings moved:
> `cache-priming` is a **detector**, not the headline optimizer (E1-F4, 96.6% measured hit rate),
> and the TTL economics in §1 are now known to be **population-dependent** — the month-level sign
> flips with sampling (E1b-F2/F3). See SPEC §6.6, the population rule.

**Status:** v0.1 · **Date:** 2026-08-25 · Companion to `docs/optimizers.md`.

`optimizers.md` argues *which* optimizers are worth running and *why* the tiers are what they are.
This file shows *what each one actually does to the wire* — the request before, the request after,
the `usage` numbers that prove it worked, the arithmetic that turns those numbers into dollars, and a
concrete failure you can reproduce.

Every dollar figure is reproduced here line-by-line from `tools/costmodel.py`. If a number here
disagrees with the script, the script wins.

**Conventions.** Python, `anthropic` SDK, model `claude-opus-5` at $5.00 / $25.00 per MTok. Cache
reads 0.10×, cache writes 1.25× (5-minute TTL). The workload is `supportbot/draft-reply`:
9,200 cacheable prefix tokens (1,200 tools + 8,000 system), 1,500 volatile suffix tokens, 400 output
tokens.

---

## Contents

| § | Optimizer | Tier | Marginal |
|---|---|---|---:|
| [1](#1-cache-priming--t0) | `cache-priming` | T0 | −64.4% |
| [2](#2-context-pruning--t1) | `context-pruning` | T1 | −13.3% |
| [3](#3-tool-schema-slimming--t1) | `tool-schema-slimming` | T1 | −2.7% |
| [4](#4-model-routing--t2) | `model-routing` | T2 | −48.0% |
| [5](#5-prompt-compaction--t1-rejected) | `prompt-compaction` | T1 | **rejected** |
| [6](#6-what-the-worked-examples-changed) | New findings F5–F7 | | |

---

## 0. The baseline request

This is what the workload sends today. Nothing is cached; every request pays full price for 10,700
input tokens, 9,200 of which are byte-identical to the last request.

```python
import anthropic

client = anthropic.Anthropic()

response = client.messages.create(
    model="claude-opus-5",
    max_tokens=1024,
    thinking={"type": "adaptive"},
    tools=TOOLS,                      # 30 definitions, ~1,200 tok
    system=[
        {"type": "text", "text": SUPPORT_PREAMBLE},     # ~8,000 tok
    ],
    messages=[
        {"role": "user", "content": render_ticket(ticket)},   # ~1,500 tok
    ],
)
```

Reported usage:

```
usage.input_tokens                 = 10700
usage.cache_creation_input_tokens  = 0
usage.cache_read_input_tokens      = 0
usage.output_tokens                = 400
```

**Cost per 1,000 requests**

| Line | Tokens | Rate | $/1k |
|---|---:|---:|---:|
| prefix (tools + system) | 9,200 | $5.00/MTok | $46.00 |
| suffix (ticket) | 1,500 | $5.00/MTok | $7.50 |
| output | 400 | $25.00/MTok | $10.00 |
| | | | **$63.50** |

84% of the spend is input. That single fact determines the whole ordering that follows.

---

## 1. `cache-priming` — T0

### The change

One line. A `cache_control` marker on the last system block. Render order is `tools` → `system` →
`messages`, so a marker on the last system block covers tools *and* system together — you do not need
a second marker on the tool list.

```diff
     system=[
-        {"type": "text", "text": SUPPORT_PREAMBLE},
+        {
+            "type": "text",
+            "text": SUPPORT_PREAMBLE,
+            "cache_control": {"type": "ephemeral"},   # 5-minute TTL
+        },
     ],
```

The marker goes at the end of the **shared** portion, not at the end of the whole prompt. Marking the
ticket block instead would write a distinct cache entry per request and read none of them — you would
pay the 1.25× write premium forever and never see a read.

### The wire proof

Request 1 (cold):

```
usage.input_tokens                 = 1500     # the ticket only
usage.cache_creation_input_tokens  = 9200     # written, billed at 1.25x
usage.cache_read_input_tokens      = 0
```

Request 2 (warm), same prefix, different ticket:

```
usage.input_tokens                 = 1500
usage.cache_creation_input_tokens  = 0
usage.cache_read_input_tokens      = 9200     # billed at 0.10x
```

Note `input_tokens` is the **uncached remainder only**. Total prompt size is
`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. A gate that reads
`input_tokens` alone and reports "input dropped from 10,700 to 1,500, −86%" is reading the wrong
field and will overstate every caching proposal.

### The money

At a 1% write rate — continuous traffic re-warming one 5-minute window roughly every 100 requests:

| Line | Calculation | $/1k |
|---|---|---:|
| prefix reads | 990 × 9,200 tok × $0.50/MTok | $4.554 |
| prefix writes | 10 × 9,200 tok × $6.25/MTok | $0.575 |
| suffix | 1,000 × 1,500 tok × $5.00/MTok | $7.500 |
| output | 1,000 × 400 tok × $25.00/MTok | $10.000 |
| | | **$22.63** |

**$63.50 → $22.63, −64.4%.** The prefix line went from $46.00 to $5.13 — a 9× reduction on 84% of
the bill.

That 1% write rate is the load-bearing assumption. It is a claim about *arrival rate*, not about the
prompt: it holds only if requests arrive more often than every 5 minutes. At one request every 10
minutes every request is a cold write, the prefix line becomes $57.50/1k, and caching makes the
workload **more** expensive than the baseline. The proposal must read the arrival distribution out of
the capture, not assume continuous traffic.

For genuinely bursty traffic, `{"type": "ephemeral", "ttl": "1h"}` keeps entries alive across the
gaps — but the write premium doubles to 2×, so break-even moves from two requests to three.

### How the gate verifies it

Static inspection is not enough. A prefix can look byte-stable in the source and differ on the wire.
The gate replays two captured requests and asserts a read:

```python
def verify_cache_priming(replay_a, replay_b):
    """A proposal that cannot demonstrate a cache read is not a proposal."""
    first  = send(replay_a)
    second = send(replay_b)          # different ticket, identical prefix

    assert first.usage.cache_creation_input_tokens >= 512, \
        "nothing was written — prefix is below claude-opus-5's 512-token minimum"
    assert second.usage.cache_read_input_tokens > 0, \
        "written but never read — a silent invalidator is in the prefix"
    assert second.usage.cache_read_input_tokens == first.usage.cache_creation_input_tokens, \
        "partial read — the prefix is only stable up to some earlier byte"
```

The third assertion is the one that catches the subtle cases. A *partial* read means the prefix is
stable for the first N tokens and diverges after — typically a variable interpolated halfway through
the preamble. You get a cache hit, the naive check passes, and you are saving a fraction of what the
proposal claimed.

### Worked failure: the silent invalidator

The single most common way this optimizer produces a proposal that is correct in form and worth $0:

```python
SUPPORT_PREAMBLE = f"""You are a support agent for Acme.
Current date: {datetime.now():%Y-%m-%d %H:%M}      # <-- invalidates everything after it
...8,000 tokens of stable instructions...
"""
```

Symptom: `cache_creation_input_tokens = 9200` on **every** request, `cache_read_input_tokens = 0` on
every request. No error is raised. The bill goes **up** 25% on the prefix line — $46.00 → $57.50 per
1k — because you now pay the write premium on every request and never read.

The fix is not to remove the date but to move it after the last breakpoint:

```diff
     system=[
         {"type": "text", "text": SUPPORT_PREAMBLE, "cache_control": {"type": "ephemeral"}},
     ],
     messages=[
+        {"role": "user", "content": f"Current date: {datetime.now():%Y-%m-%d}"},
         {"role": "user", "content": render_ticket(ticket)},
     ],
```

The same shape, in rough order of how often it shows up: `json.dumps(schema)` without
`sort_keys=True`; iterating a `set` to build the tool list; a user ID f-stringed into the preamble
(which gives you a per-user cache that never shares); and `if flag: system += ...`, where every flag
combination is a separate prefix.

### Worked failure: the fan-out that pays full price

```python
# 8 parallel drafts, identical prefix
results = await asyncio.gather(*[draft(t) for t in tickets])
```

A cache entry becomes readable only once the first response **begins streaming**. Eight simultaneous
requests all miss and all write. The fix is to send one, await the first streamed token — not the
full response — then fire the remaining seven:

```python
async with client.messages.stream(**build(tickets[0])) as stream:
    await anext(aiter(stream))               # first event is enough; the entry is now readable
    rest = await asyncio.gather(*[draft(t) for t in tickets[1:]])
    first = await stream.get_final_message()
```

If the capture shows fan-out and the proposal does not include this change, its predicted saving is
fiction.

### Related: pre-warming

Distinct from cache-priming and worth cataloguing separately. `max_tokens: 0` runs prefill, writes the
entry, and returns immediately with `content: []` and `stop_reason: "max_tokens"` — zero output tokens
billed:

```python
client.messages.create(
    model="claude-opus-5",
    max_tokens=0,
    system=[{"type": "text", "text": SUPPORT_PREAMBLE,
             "cache_control": {"type": "ephemeral"}}],
    messages=[{"role": "user", "content": "warmup"}],
)
```

This buys **latency, not cost** — it moves the cold-write penalty off the first real request. For
`supportbot/draft-reply` it is the wrong tool: traffic is continuous, so the first real request warms
the cache anyway and a separate warm call is a pure extra write. It earns its place only where
first-request latency is user-visible and there is a quiet moment before traffic — app startup,
worker boot, post-deploy. Put the marker on the block shared with the real request, never on the
placeholder user message.

---

## 2. `context-pruning` — T1

### The change

The suffix — everything after the last breakpoint — is never cacheable and always billed at the full
$5.00/MTok. That is where the remaining input money is.

```diff
     messages=[
-        *history,                                    # ~1,500 tok, grows unbounded
+        *prune(history, keep_turns=6),               # ~900 tok
         {"role": "user", "content": render_ticket(ticket)},
     ],
```

```python
def prune(history, keep_turns=6):
    """Drop stale tool results. Three guardrails, each protecting a real failure."""
    kept, seen_tools = [], set()
    for i, msg in enumerate(reversed(history)):
        recent = i < keep_turns
        is_tool_result = _is_tool_result(msg)
        first_of_tool = is_tool_result and _tool_name(msg) not in seen_tools
        referenced = _referenced_later(msg, history[len(history) - i:])

        if recent or not is_tool_result or first_of_tool or referenced:
            kept.append(msg)
        if is_tool_result:
            seen_tools.add(_tool_name(msg))
    return list(reversed(kept))
```

- `recent` — never prune inside the last K turns.
- `first_of_tool` — never prune the most recent result of any given tool; that is usually the current
  state of something.
- `referenced` — a cheap string-containment check. If a later turn quotes the content, it is load-
  bearing. This is the check that catches the actual failure mode.

### Prefer the server's semantics where the shape fits

Hand-rolled pruning means you own the correctness of "what is safe to drop." The API has clearing
strategies that do this server-side, with the server's semantics rather than yours:

```python
response = client.beta.messages.create(
    betas=["context-management-2025-06-27"],
    model="claude-opus-5",
    max_tokens=1024,
    context_management={"edits": [{"type": "clear_tool_uses_20250919"}]},
    tools=TOOLS,
    messages=messages,
)
```

`clear_tool_uses_20250919` clears old tool results; `clear_thinking_20251015` clears thinking blocks.
This is *clearing*, not compaction — nothing is summarized, so nothing is fabricated. Where the
workload's shape fits one of these, the optimizer should propose it over a custom pruner: the risk
surface is the API's, not ours, and there is no local code to get wrong.

### The money

| Line | Calculation | $/1k |
|---|---|---:|
| prefix (unchanged) | reads + writes as §1 | $5.129 |
| suffix | 1,000 × 900 tok × $5.00/MTok | $4.500 |
| output | 1,000 × 400 tok × $25.00/MTok | $10.000 |
| | | **$19.63** |

**$22.63 → $19.63, −13.3%.**

Now put that next to the next optimizer, because this comparison is the entire argument of the
document:

| | Tokens removed | Where | Marginal |
|---|---:|---|---:|
| `context-pruning` | 600 | uncached suffix @ $5.00/MTok | **−13.3%** |
| `tool-schema-slimming` | 940 | cached prefix @ $0.50/MTok | −2.7% |

Fewer tokens, 5× the saving. Post-caching, *where* a token lives matters more than *how many* there
are. An optimizer ranked by tokens-removed would get this backwards.

### The cache interaction that makes this safe

Pruning touches only content after the breakpoint. The cached prefix is untouched, so no warm entry
is invalidated and there is no re-warm cost on deploy. That is why it can be auto-applied alongside
`cache-priming` — and it is the property `prompt-compaction` lacks (§5).

### Worked failure: pruning the turn that carried the answer

```
turn 3   tool_result: fetch_order(#88213) → {"status": "refunded", "amount": 240.00}
turn 4-8 ... unrelated back-and-forth ...
turn 9   user: "so how much was that refund again?"
```

Prune with `keep_turns=6` and turn 3 is gone. The model does not error — it re-calls `fetch_order`
(latency and cost, the benign case) or answers from context that no longer contains the number (the
bad case). The eval catches this only if the golden set contains a long thread with a late callback,
which typical traffic sampling undersamples. Hence the `referenced` guardrail: cheap, and it catches
exactly this.

**Accuracy: 0.96 → 0.96 on the demo golden set. Risk class: medium.** The score being flat is not
proof of safety here — it is proof the golden set did not contain the failure shape.

---

## 3. `tool-schema-slimming` — T1

### The change

The capture shows 4 of 30 tools ever invoked. The other 26 are 940 tokens of dead prefix.

```diff
-    tools=TOOLS,                       # 30 definitions, 1,200 tok
+    tools=[t for t in TOOLS if t["name"] in ACTIVE],   # 4 definitions, 260 tok
```

### The money

| Line | Calculation | $/1k |
|---|---|---:|
| prefix reads | 990 × 8,260 tok × $0.50/MTok | $4.089 |
| prefix writes | 10 × 8,260 tok × $6.25/MTok | $0.516 |
| suffix | 1,000 × 900 tok × $5.00/MTok | $4.500 |
| output | 1,000 × 400 tok × $25.00/MTok | $10.000 |
| | | **$19.10** |

**$19.63 → $19.10, −2.7%.**

Run the same change first, against the uncached baseline, and it reports **−7.4%** ($63.50 → $58.80).
Identical diff, 2.7× the headline. The prefix costs $0.50/MTok after caching and $5.00 before, so
`cache-priming` took 90% of this optimizer's value before it ran. Reporting the standalone number
would be a lie by omission — and if every optimizer reported standalone, the claimed savings would
sum past 100% of the actual bill.

### The case for it is not cost

1. **Accuracy.** Distractor tools cause wrong tool selection. Going 30 → 4 usually *improves* the
   deterministic tool-call-match score. If the eval shows it flat, that is weak evidence the capture
   window missed a code path.
2. **Headroom.** Tool definitions render at position 0. Every byte there must stay byte-stable
   forever or the entire cache dies. A smaller tool block is a smaller invalidation surface.

### Worked failure: "unused" is a claim about the window

```python
{"name": "escalate_to_human",
 "description": "Escalate when the customer explicitly requests a human, "
                "or when the ticket mentions legal action."}
```

Zero invocations in a 400-request window. It fires on maybe 0.5% of traffic — and on that 0.5% it is
the only correct action. Delete it and the model does the next best thing it can see: drafts a reply
itself. No error, no eval regression (the golden set has 50 samples; the path is 1-in-200), and a
legal-escalation ticket gets an autodrafted reply. This is the failure mode that shows up in
production three weeks later.

Guardrails, all of which must pass:

```python
def may_remove(tool, window, system_prompt):
    return (
        window.invocations(tool.name) == 0
        and window.duration >= POLICY.min_observation_window     # not the golden set — the window
        and tool.name not in system_prompt                       # a prompt mention pins the tool
        and window.request_count >= POLICY.min_observations
    )
```

The `tool.name not in system_prompt` check is the cheap one that catches `escalate_to_human`: a
preamble that says *"use `escalate_to_human` when unsure"* pins that tool regardless of observed
invocations. Zero invocations plus a prompt mention means your prompt and your traffic disagree, and
that is a finding to surface, not a tool to delete.

### The cache-preserving form

Removing a tool from `tools[]` changes position 0, which invalidates all three cache tiers. On a
deploy that means every warm entry dies and you pay a one-time re-warm the ROI gate has to account
for. On `claude-opus-5` there is a form that does not:

```python
tools = [
    *ACTIVE_TOOLS,
    # Kept in the request, not loaded into the model's context:
    {**escalate_to_human, "defer_loading": True},
]
```

Deferred tools are known to the request but not loaded into context until surfaced. Combined with a
tool-search tool, Claude retrieves what it needs from the deferred library on its own — which turns
"we deleted a tool the model needed" into "the model spent one search to find it." At least one tool
must remain non-deferred, and the search tool itself must never be deferred, or the API returns 400.

Mid-conversation, tools can also be added and removed without touching the prefix, behind
`mid-conversation-tool-changes-2026-07-01`:

```python
{"role": "system", "content": [
    {"type": "tool_removal", "tool": {"type": "tool_reference", "name": "get_weather"}},
]}
```

This changes the shape of the optimizer. See F5 in §6.

---

## 4. `model-routing` — T2

### The change

```python
def route(request) -> str:
    if request.workload in POLICY.never_downgrade:      # supportbot/pii-extract
        return "claude-opus-5"
    return "claude-haiku-4-5" if CLASSIFIER.predict(features(request)) == "easy" \
                              else "claude-opus-5"
```

`features()` must be computable at request time for free — ticket length, attachment presence,
thread depth, distinct-tool count from the trace, policy keyword hits. Fit the classifier offline
from captured traces.

### Why not the obvious designs

| Design | Marginal latency | Marginal cost | Verdict |
|---|---|---|---|
| Cheap classifier model call per request | +1 round trip | +1 request | **No** — adds a call to save a call |
| Speculative: try Haiku, judge, escalate | +100% on escalations | +1.x requests on escalations | Tail safety net only |
| Offline-fitted classifier on request features | ~0 | ~0 | **Yes** |

Keep speculative escalation available as a configurable safety net for the tail, where its latency
cost is paid only by the requests that need it.

### The money

Caches are **model-scoped**. Splitting traffic creates two entries, each getting fewer reads, and you
pay two sets of writes. Both segments must be costed separately — this is why the estimator cannot
just scale the blended rate.

Haiku 4.5 at 60% ($1.00 / $5.00 per MTok):

| Line | Calculation | $/1k |
|---|---|---:|
| prefix reads | 594 × 8,260 tok × $0.10/MTok | $0.491 |
| prefix writes | 6 × 8,260 tok × $1.25/MTok | $0.062 |
| suffix | 600 × 900 tok × $1.00/MTok | $0.540 |
| output | 600 × 400 tok × $5.00/MTok | $1.200 |
| | | $2.293 |

Opus 5 at 40%:

| Line | Calculation | $/1k |
|---|---|---:|
| prefix reads | 396 × 8,260 tok × $0.50/MTok | $1.635 |
| prefix writes | 4 × 8,260 tok × $6.25/MTok | $0.206 |
| suffix | 400 × 900 tok × $5.00/MTok | $1.800 |
| output | 400 × 400 tok × $25.00/MTok | $4.000 |
| | | $7.641 |

**$19.10 → $9.93, −48.0%.** Cumulative from baseline: **−84.4%.**

Not the naive −58%, for three reasons visible in the tables: the doubled cache-write overhead, the
fact that output is the largest post-caching line item so the blend is set by how much traffic
actually routes, and the `never_downgrade` carve-out removing `pii-extract` from the pool entirely.

### Worked failure: the Haiku cache-minimum trap

The minimum cacheable prefix is model-dependent and **not monotonic across generations**:

| Model | Minimum |
|---|---:|
| Claude Opus 5 | 512 |
| Opus 4.8, Sonnet 5 | 1,024 |
| Opus 4.7 | 2,048 |
| Opus 4.6, **Haiku 4.5** | 4,096 |

A workload with a 2,000-token prefix caches on Opus 5 and **silently does not cache** on Haiku 4.5 —
no error, `cache_creation_input_tokens` is simply 0. Routing it "saves money" on paper and the
prefix line quietly reverts to full price:

```
2,000-token prefix, 60% routed to Haiku 4.5
  estimator assumes source-model cache behaviour carries over:   $0.22 /1k on the Haiku segment
  actual (below the 4,096 minimum, silently uncached):           $2.00 /1k
  over-prediction:                                               9x
```

Our 8,260-token prefix clears both minimums, so the demo is unaffected. Any workload with a prefix
between 512 and 4,096 is not. The estimator must look up the **target** model's minimum:

```python
inp, out, min_prefix = PRICING[target_model]
if cached and workload.prefix_tok < min_prefix:
    cached = False        # silently does not cache — cost the segment uncached
```

That guard is already in `tools/costmodel.py:42`. It is the reason the trap is a documented finding
rather than a bug in our own numbers.

### Why this is T2 and nothing else is

**Accuracy: 0.96 → 0.95.** Real, measured, and the human is being asked to accept it for −48%.

Every other optimizer changes *how* a model is asked. This one changes *who answers*. A regression
here is not a degraded response, it is a different system — a category difference, not a magnitude
difference. No eval score should auto-approve it, which is the entire argument for the tier.

---

## 5. `prompt-compaction` — T1, REJECTED

### The change

```diff
-    system=[{"type": "text", "text": SUPPORT_PREAMBLE,          # 8,000 tok
+    system=[{"type": "text", "text": SUPPORT_PREAMBLE_COMPACT,  # 4,500 tok
              "cache_control": {"type": "ephemeral"}}],
```

Deduped instructions, trimmed few-shot examples, collapsed formatting rules.

### The verdict

**Accuracy 0.96 → 0.89.** Seven points. `relative_drop_max` is `0.00`; there is no override flag. The
gate kills it.

### The reward was never what it looked like

| Measured against | Marginal |
|---|---:|
| uncached baseline (standalone) | −33% |
| post-caching state (correct position) | **−12.6%** |

$19.63 → $17.15:

| Line | Calculation | $/1k |
|---|---|---:|
| prefix reads | 990 × 4,760 tok × $0.50/MTok | $2.356 |
| prefix writes | 10 × 4,760 tok × $6.25/MTok | $0.298 |
| suffix | 1,000 × 900 tok × $5.00/MTok | $4.500 |
| output | 1,000 × 400 tok × $25.00/MTok | $10.000 |
| | | **$17.15** |

So the highest-risk candidate in the catalogue delivers less than `model-routing` and barely more
than `context-pruning`. It was a bad trade *before* the eval ran.

### Why it fails, mechanically

Deleting instructions is deleting behavior. The instruction that matters fires on 2% of traffic — an
escalation rule, a refusal boundary, a formatting requirement for one ticket category. A 50-sample
golden set drawn from typical traffic systematically undersamples exactly those paths. The candidate
looks fine on the common case and fails on the tail, and the tail is where the seven points went.

```
compacted away:  "If the ticket references a chargeback, do not offer a refund;
                  route to billing-ops and state that a chargeback is already in progress."

golden set:      0 chargeback tickets in 50
production:      ~1.8% of tickets
result:          eval flat on that rule, wrong behaviour on every chargeback
```

This is the strongest argument for the held-out-slice mitigation in SPEC.md §11: compaction is
precisely the shape of change that overfits a golden set.

### Three costs the naive version ignores

- **Cache invalidation on deploy.** Rewriting the preamble changes the prefix and kills every warm
  entry. One-time, but the ROI gate must include the re-warm.
- **It fights `cache-priming`.** Two optimizers targeting the same bytes with opposite stability
  requirements — one wants the prefix frozen forever, the other wants to keep editing it. Every
  future compaction re-invalidates.
- **It is the least reversible.** Rolling back a routing table is a config change. Rolling back a
  rewritten prompt means restoring prose a human may have since edited on top of.

### The dynamic-instruction case, which is not compaction

Teams often reach for compaction when the real problem is that the preamble is *edited at runtime* —
a mode switch, injected state, an operator override. Doing that at top level invalidates the prefix
ahead of the entire conversation. On Opus 5 there is a channel that does not:

```python
messages=[
    *history,
    {"role": "user", "content": render_ticket(ticket)},
    {"role": "system", "content": "Terse mode — keep replies under 40 words."},
]
```

The `role: "system"` message sits after the cached history, so the prefix survives. It is also the
non-spoofable operator channel — unlike an instruction embedded as text in a user turn, which
anything that writes to user-visible input can forge. Must follow a user message, cannot be
`messages[0]`, and unsupported models return 400 `role 'system' is not supported on this model`.

### Is there a version that passes?

Probably — a conservative variant that removes only *provably* dead text: an instruction referencing
a tool that no longer exists, a duplicated paragraph, a formatting rule superseded by a structured
output schema. That is a different optimizer with a different risk profile and belongs in the
catalogue separately, not as a "less aggressive" knob on this one.

---

## 6. What the worked examples changed

Writing the examples surfaced three findings that the conceptual pass in `optimizers.md` missed.

> **F5 — `tool-schema-slimming` has a non-destructive form, and the optimizer should prefer it.**
> `defer_loading: True` plus a tool-search tool keeps a rarely-used tool *available* while removing it
> from the loaded context. That converts F2's failure mode — permanently deleting a tool the model
> needed on an unobserved path — from a silent production incident into one extra search call. It
> does not eliminate the minimum-observation-window gate, but it changes the cost of being wrong from
> unbounded to one round trip. Where the model supports it, the destructive form should require a
> justification the deferred form does not. Filed as **ADR-0007**.

> **F6 — cache invalidation is now avoidable for two of the three tiers, so "invalidates the cache"
> is a property of the *chosen form*, not of the change.** A system-prompt edit has a cache-preserving
> form (a `role: "system"` message in `messages[]`, available today on Opus 5). A tool-set change has
> one behind `mid-conversation-tool-changes-2026-07-01`. A model switch does **not** — caches are
> model-scoped, with no escape hatch. A proposal that invalidates the prefix when a preserving form
> exists should be rejected as under-specified rather than costed with a re-warm penalty. Filed as
> **ADR-0008**.

> **F7 — the gate needs a first-class cache verifier, not a two-request replay heuristic.** The
> `verify_cache_priming` assertions in §1 detect *that* a prefix diverged, not *where*. The
> cache-diagnosis beta (`cache-diagnosis-2026-04-07`, `client.beta.messages.*`, passing
> `diagnostics={"previous_message_id": <id>}` and reading `response.diagnostics`) reports the miss
> against the previous message directly. Adopting it turns "cache read was 0, go diff the rendered
> bytes by hand" into a machine-readable reason the proposal can carry. **The exact `diagnostics`
> payload shape must be read off a live response before the gate parses it — do not code against a
> guessed schema.** Filed as **ADR-0009.**

### Full finding index

| # | Finding | ADR |
|---|---|---|
| R1 | Attribution is marginal, in applied order | ADR-0002 |
| R2 | T0 runs first, always | ADR-0002 |
| R3 | Post-cache, only the uncached suffix and output are worth accuracy risk | ADR-0002 |
| F1 | Latency gate must track TTFT and total as separate series | ADR-0003 |
| F2 | `tool-schema-slimming` needs a minimum-observation-window gate | ADR-0004 |
| F3 | Cost estimator must model per-model cache minimums | ADR-0005 |
| F4 | Optimizers need ex-ante risk/reward ranking to spend verification budget well | ADR-0006 |
| F5 | Prefer `defer_loading` over destructive tool removal | ADR-0007 |
| F6 | Prefer the cache-preserving form of any prefix change | ADR-0008 |
| F7 | Adopt cache diagnostics as the gate's cache verifier | ADR-0009 |

---

## 7. Reproducing every number here

```
python3 tools/costmodel.py
```

The per-line tables in this document expand what that script computes. The script is the source of
truth; these tables exist so a reviewer can check the arithmetic without reading Python.
