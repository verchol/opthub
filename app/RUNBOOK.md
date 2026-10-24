# Demo runbook

Everything you type, in order, with what to expect and what to say. Read this
once before running it in front of anyone.

**Total live time: ~12–25 min**, dominated by one agent run whose length you do
not control. The section *"The long pole"* below is the single most important
part of this document.

---

## 0. One-time setup (do this days before, not in the room)

```bash
cd opthub          # the repo root
npm install
```

**E2B key** — https://console.e2b.dev/?tab=keys (free tier, no card, $100 credit):

```bash
read -rs 'k?E2B_API_KEY: ' && printf 'E2B_API_KEY=%s\n' "$k" >> .env && unset k
```

**Claude login** — browser pops, approve, paste the code back:

```bash
node auth.mjs
```

It captures the token, verifies it with a live call *from inside a sandbox*, and
only then writes `.env`. If it reports a failure, nothing was written — run it
again. Do this in a terminal whose output is not being recorded; the login flow
echoes the token.

**Confirm the whole chain:**

```bash
node preflight.mjs
```

Expect, in about 30 seconds:

```
1. credentials          ✓ ✓ ✓
2. E2B: booting a VM    ✓ sandbox … up in ~1.0s
3. installing           ✓ 2.1.26x in ~6s
4. authenticating       ✓ round trip complete
pre-flight PASSED
```

Anything short of `PASSED` means do not proceed. The failure mode this catches
is a token that looks right and is not.

---

## 1. Rehearse (day before)

Do a **complete** run end to end and keep the output:

```bash
node run-demo.mjs uber-factory
```

This gives you `results/<runId>/report.html` — a real result, in hand, as your
fallback if the live run misbehaves. It also tells you how long the agent
actually takes on your account, which is the number this runbook cannot predict
for you.

Write that duration down. It is your talk-track budget.

---

## 2. The demo

### Act 1 — the premise (1 min, no terminal)

> Everyone comparing coding agents compares *models*. The model is the one thing
> you don't control — it ships when it ships. What you do control is the harness
> around it: the context you hand it, how it verifies its own work, what gates
> "done". This measures that, with the model held fixed.

### Act 2 — the experiment is one file (2 min)

```bash
cat experiments/plan-first.md
```

```markdown
---
description: Prompt only — force an explicit behaviour checklist before any code is written.
---

Before you write a single line of `sheet.py`, write `PLAN.md` containing a
numbered checklist of every distinct behaviour SPEC.md requires …
```

> That's a complete, runnable experiment. Frontmatter is optional. The body is
> appended to a task prompt both sandboxes share — so for this one, that
> paragraph is the *entire* difference between the two machines.

```bash
node run-demo.mjs --list
```

Six shipped strategies, from one flag to the full stack.

### Act 3 — show both machines before booting either (2 min)

```bash
node run-demo.mjs uber-factory --dry
```

Prints each arm's exact `claude` invocation, its full workspace with byte counts,
and its complete prompt. Boots nothing, bills nothing.

> Control is `claude -p --model opus` and nothing else — stock defaults, an empty
> workspace, and no gate on completion. The optimized arm adds five flags, four
> files, and a strategy prompt. Everything I don't set stays at the control's
> value, so this is one variable.

### Act 4 — run it (this is the long pole — see below)

```bash
node run-demo.mjs uber-factory
```

Live log, both arms interleaved:

```
[control       ] sandbox ikrhu… up
[uber-factory  ] sandbox i04fw… up
[control       ] claude installed in 5.5s → 2.1.261
[control       ] running agent (budget $8, cap 30m)…
```

The point to make while it runs:

> The grader isn't in either machine yet. Forty-seven tests, written in only
> after the agent process exits. Neither run can be tuned against the thing that
> scores it. It was validated at 47/47 against a reference implementation before
> any of this ran, so I know the tests are winnable and the spec is unambiguous.

### Act 5 — the result (3 min)

```bash
open results/<runId>/report.html
```

A six-axis spider chart, both sessions overlaid. Correctness, cost efficiency,
token economy, turn economy, cache reuse, speed.

> Each axis is normalised independently so the better session touches the outer
> ring — outward is always better, including on the four where a lower raw number
> wins. Raw values sit beside every label, and the unnormalised table is directly
> underneath, because a radar chart flatters whichever shape encloses more area.

Then scroll to the failure breakdown — which of the 47 each arm missed, by
category. That's usually the most interesting slide in the deck: the two arms
tend to fail *differently*, not just more or less.

---

## The long pole

**Act 4 is 5–20 minutes and you cannot shorten it.** Two agents are doing real
work. Plan for it:

| approach | when |
|---|---|
| **Launch live, talk over it** | Default. Launch at the start of Act 2 in a second terminal, do Acts 2–3 while it runs, come back to it. |
| **Show a rehearsed result** | Short slot, or a room that won't sit through a progress log. Launch live anyway for credibility, then open yesterday's report while it finishes. |
| **`BENCH_MODEL=sonnet`** | Faster and cheaper, same mechanism. The comparison still holds; absolute numbers are smaller. |

Never let the room watch a silent log. Either you're talking, or you're showing
a finished result.

---

## If something goes wrong

| symptom | cause | do this |
|---|---|---|
| `401 OAuth access token is invalid` | token expired or bad | `node auth.mjs` again |
| `E2B_API_KEY is not set` | `.env` missing/unreadable | check `.env` is in the project root |
| Agent exits in seconds, `$0` cost | auth failed inside the VM | `node preflight.mjs` to see the real error |
| Grading says `No module named 'sheet'` | agent never produced the file | real result — the arm failed the task, report it as such |
| One arm hangs | agent stuck | `AGENT_MS` caps it; the other arm still completes |
| Run exceeds an hour | E2B hobby tier caps sandbox life at 1h | `SANDBOX_MS` default 40m keeps you under it |

**Cost per full run:** 2 sandboxes × ~10–25 min (cents, off the $100 E2B credit)
plus the agent tokens, capped at `MAX_BUDGET_USD` per arm (default $8, so $16
worst case) against your Claude subscription.

---

## Variations to have ready

```bash
node run-demo.mjs medium-effort     # one flag. cheapest possible intervention
node run-demo.mjs plan-first        # prompt only, zero scaffolding
node run-demo.mjs batch-checks      # prompt only, verification discipline
node run-demo.mjs cheap-reviewer    # a sonnet reviewer gates completion
node run-demo.mjs uber-factory      # everything (default)
```

If asked *"what if I want to test my own idea?"* — write four lines of markdown
into `experiments/`, and run it. That is the whole answer, and it's the most
persuasive moment available. Have a blank terminal ready to do it live.

```bash
cat > experiments/live-idea.md <<'EOF'
---
description: Written live in the room.
---

<their idea, in plain English>
EOF
node run-demo.mjs live-idea --dry
```

---

## What to say about rigour, unprompted

Say this before anyone asks, because it is the first thing a careful person will
think:

> This is **n=1 per arm**. Agent runs vary a lot pass to pass. What you're
> seeing is the shape of a difference, not a number I'd defend — three repeats
> per arm is the floor for a real claim. The optimized arm is *expected* to win
> on cost; that's the hypothesis, not a finding. The interesting question is
> whether correctness survives, and by how much the gap moves.

Saying it first is worth more than being caught not having said it.

## Repeats

```bash
for i in 1 2 3; do node run-demo.mjs uber-factory; done
```

Each run writes its own `results/<runId>/`. Nothing is overwritten.
