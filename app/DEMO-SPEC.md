# Demo spec — *Two sandboxes, one task, two harnesses*

A head-to-head benchmark: two identical cloud VMs each run Claude Code on the
**same** software task under **different harness configurations**, and a hidden
test suite grades both. The question it answers: *does the Uber "efficient
software factory" playbook actually buy you anything, and what does it cost?*

> **Status: built and pre-flighted, not yet run.**
> Every number in §9 marked *MEASURED* is real. Every number in §10 is
> **fabricated placeholder data** for laying out the UI. No arm has executed, so
> there are no results yet. Do not present §10 as findings.

---

## 1. Premise

Most "AI coding agent" comparisons change the *model* and measure quality. This
changes the **harness** — the scaffolding around the model — and holds the model
fixed. That isolates a variable teams actually control.

Arm B implements the levers from
[Uber's *Efficient Software Factory*](https://www.uber.com/us/en/blog/efficient-software-factory/)
(Feb–Aug 2026: 7× weekly active users, 34% lower cost per 1,000 requests, 70% of
PRs agent-authored). Arm A is the naive alternative: same model, maximum effort,
no scaffolding.

---

## 2. Architecture

```
   your Mac                          E2B cloud (Firecracker microVMs)
   ─────────                         ────────────────────────────────
   run-demo.mjs                      ┌─ sandbox A ──────────┐  ┌─ sandbox B ──────────┐
     │                               │  Node 20.9           │  │  Node 20.9           │
     ├── E2B_API_KEY ───────────────▶│  Python 3.11.6       │  │  Python 3.11.6       │
     │   (boot 2 VMs, parallel)      │  2 vCPU / 478 MB     │  │  2 vCPU / 478 MB     │
     │                               │                      │  │                      │
     ├── writes workspace ──────────▶│  SPEC.md             │  │  SPEC.md             │
     │                               │  PROMPT.md           │  │  PROMPT.md           │
     │                               │                      │  │  CLAUDE.md           │
     │                               │                      │  │  ./factory           │
     │                               │                      │  │  .claude/skills/     │
     │                               │                      │  │  agents.json         │
     │                               │        ↓             │  │        ↓             │
     │                               │  claude -p  ─────────┼──┼──────────────┐       │
     │                               │  effort: HIGH        │  │  effort: MED │       │
     │                               └──────────────────────┘  └──────────────┼───────┘
     │                                                                        │
     │                                    CLAUDE_CODE_OAUTH_TOKEN ────────────┤
     │                                    (your Max subscription)             ▼
     │                                                            api.anthropic.com
     │
     └── after agent stops: inject hidden 47-test suite ──▶ grade both ──▶ report
```

**Key property:** the hidden test suite is written into the VM **only after the
agent process has exited.** Neither arm can see, read, or optimise against it.

---

## 3. The task

`task/spec/SPEC.md` — implement `sheet.py`, a mini spreadsheet formula engine.
Python 3 stdlib only, no network, no third-party packages.

| requirement | why it's there |
|---|---|
| Recursive-descent expression parser | real parsing work, not boilerplate |
| Correct precedence + unary minus (`-2*3 == -6`) | classic off-by-one-rule bug |
| Bijective base-26 columns (`Z`=26, `AA`=27) | easy to get subtly wrong |
| Cell refs, case-insensitive, multi-letter | state management |
| Ranges with free corner order (`A3:B1 == A1:B3`) | normalisation |
| `SUM / AVG / MIN / MAX / COUNT`, nestable | aggregation + recursion |
| Ranges **skip** text/empty; scalars **raise** on text | same value, two behaviours by position |
| Cycle detection, recoverable after the cycle breaks | per-evaluation state, not a sticky flag |
| No caching — `get()` always recomputes | invalidation trap |
| Four exact exception types | `ValueError`, `TypeError`, `ZeroDivisionError`, `CircularReference` |

Chosen because it is unambiguous enough to grade mechanically, deep enough that
scaffolding could plausibly matter, and small enough to finish inside one
session.

---

## 4. The hidden grader

`task/grader/test_hidden.py` — **47 tests**, injected post-hoc.

| class | tests | covers |
|---|---:|---|
| `RangeFunctions` | 14 | aggregation, skipping, reversed corners, nesting |
| `Arithmetic` | 10 | precedence, unary minus, div-by-zero |
| `References` | 7 | chains, empty cells, staleness, multi-letter cols |
| `Literals` | 6 | number/text/empty classification |
| `Cycles` | 5 | self, direct, indirect, via-range, recovery |
| `Errors` | 4 | each exception type, malformed input |
| `Import` | 1 | no stdout side effects at import |

**Validated:** a throwaway reference implementation scores **47/47**, so the spec
and grader are provably self-consistent — no unwinnable tests, no ambiguity that
only one arm could resolve.

---

## 5. The rig — one control, one variable

The rig is built so a configuration change is a **file**, not a code change.

**Sandbox 1 · `control`** is fixed and defined once in `run-demo.mjs`. It is
exactly what a developer gets by typing `claude -p`:

```
claude -p --model opus --output-format json --dangerously-skip-permissions
```

No `CLAUDE.md`, no skills, no subagents, no repo CLI. Default effort, default
compaction. The agent explores the workspace, invents its own verification
commands, and alone decides when it is done.

**Sandbox 2 · `<experiment>`** is the control plus one strategy, loaded from
`experiments/<name>.md`. Anything the experiment does not set stays at the
control's value — that is what makes it one variable.

### An experiment is a markdown file

The minimum is a prompt with no frontmatter at all:

```markdown
---
description: Make the agent state its assumptions before writing code.
---

Before you write any code, list every assumption you are making about SPEC.md
that the spec does not settle. Resolve each one, then implement.
```

The body is appended to the shared `task/BASE_PROMPT.md` under an
`# Optimization strategy` heading. The control gets that same base prompt
*without* it — so for a prompt-only experiment, the appended text is the entire
difference between the two sandboxes.

| frontmatter key | effect | required |
|---|---|---|
| `description` | one line, carried into the report | no |
| `flags` | extra CLI flags, space-separated | no |
| `files` | files copied from `assets/` into the workspace | no |
| `agents` | an asset file passed to `--agents` | no |

A copied file with no dot in its basename is made executable. Flags are appended
after `--model`; measurement plumbing (`-p`, `--output-format json`,
`--max-budget-usd`, …) is applied to both arms and is not the experiment's to set.

### Held constant across arms

Same base image, same `SPEC.md`, same `task/BASE_PROMPT.md`, same model, same
hidden grader injected post-exit. `BENCH_MODEL` changes the model for **both**
arms — a per-arm model change would measure model routing rather than the
strategy under test.

### Commands

```bash
node run-demo.mjs --list             # experiments and what each one changes
node run-demo.mjs plan-first --dry   # print both arms in full, boot nothing
node run-demo.mjs plan-first         # run
node report.mjs [runId]              # regenerate the spider chart
```

`--dry` prints each arm's exact `claude` invocation, its full workspace file
list with byte counts, its complete `PROMPT.md`, and a delta line. It warns when
an experiment leaves the two arms textually identical.

### Shipped experiments

| name | changes | idea |
|---|---|---|
| `medium-effort` | flags | the single cheapest lever, nothing else |
| `plan-first` | prompt | explicit behaviour checklist before any code |
| `batch-checks` | prompt | one scripted check instead of N probes |
| `terse-context` | prompt | explicit context discipline |
| `cheap-reviewer` | flags+files+prompt | a sonnet reviewer gates completion |
| `uber-factory` | flags+files+prompt | the full stack (default) |

---

## 6. The `uber-factory` experiment

Each lever maps to a specific claim in the Uber post.

| # | Lever | Uber's claim |
|---|---|---|
| 1 | `--effort medium` | "Medium by default" — output tokens bill at a multiple of input |
| 2 | `reviewer` subagent pinned to **sonnet** | Subagent downgrade: cheap models for well-defined subtasks, flagship for orchestration |
| 3 | `./factory verify` — 5 checks, **1 process** | Code-mode: batch tool ops into one script; 55–71% token reduction |
| 4 | `verify` skill wrapping that CLI | CLI tool resolution instead of loading tool schemas |
| 5 | `--strict-mcp-config` | No MCP schema preload (they measured 50–70K tokens/session) |
| 6 | `CLAUDE.md` with layout, conventions, 8 known traps | AI Context Graph: grounded context beats exploration (38s vs 20m9s) |
| 7 | Reviewer gates "done" | uReview — the managed code-review agent |
| 8 | `--autocompact 400000` | Compact at 400K despite larger windows |
| 9 | `--exclude-dynamic-system-prompt-sections` | Raise prompt-cache hit rate |

**Enforced workflow:** `PLAN.md` → implement → `./factory verify` → reviewer
subagent → fix → re-verify.

### `./factory` — the code-mode CLI

One command, one process, five checks, one summary block:

```
=== FACTORY SUMMARY ===
[PASS] syntax:        sheet.py parses
[PASS] import-purity: imports cleanly, no stdout
[PASS] public-api:    public API present
[PASS] spec-smoke:    25 spec smoke assertions pass
[PASS] your-tests:    OK
result: CLEAN
=== END SUMMARY ===
```

**Fairness note:** the 25 smoke assertions restate only behaviour written
verbatim in `SPEC.md`. They are not the hidden tests and were not derived from
them. Arm B's advantage is *scaffolding*, which is the whole hypothesis — but it
is not *answer leakage*.

---

## 7. Execution flow

| # | step | arm A | arm B |
|---|---|---|---|
| 1 | Boot microVM | ✅ ~1.0s *(MEASURED)* | ✅ ~1.0s *(MEASURED)* |
| 2 | `npm i -g @anthropic-ai/claude-code` | ✅ ~6.1s *(MEASURED)* | ✅ ~6.1s *(MEASURED)* |
| 3 | Write workspace files | 2 files | 6 files + `chmod +x factory` |
| 4 | Run agent (`--max-budget-usd` capped) | pending | pending |
| 5 | Inject hidden suite, grade | pending | pending |
| 6 | Download `sheet.py`, `PLAN.md`, agent tests, raw result JSON | | |
| 7 | Kill VM | | |

Both arms run **concurrently** via `Promise.all`, so wall time ≈ the slower arm.

---

## 8. Metrics

Parsed from Claude Code's `--output-format json`:

| metric | source | why it's here |
|---|---|---|
| hidden suite passed | grader | **quality** |
| cost (USD) | `total_cost_usd` | **spend** |
| **cost per passing test** | derived | Uber's outcome-denominated unit economics |
| assistant turns | `num_turns` | turns/session in their cost model |
| output tokens | `usage.output_tokens` | billed at a multiple of input |
| input tokens (fresh) | `usage.input_tokens` | |
| cache writes / reads | `usage.cache_*` | |
| prompt-cache hit rate | `reads / (fresh + writes + reads)` | their cache-efficiency metric |
| agent wall time | `duration_ms` | latency |
| sandbox wall time | harness | infra cost driver |
| delivered lines | `wc -l` | |

Uber's decomposition — `Users × Sessions × Turns × Requests × Tokens × Price` —
is what the turn and token columns exist to expose.

---

## 9. MEASURED so far

Everything except the agent runs is verified working:

| fact | value |
|---|---|
| E2B VM cold boot | **1.0 s** |
| Sandbox specs | Node 20.9.0, npm 10.1.0, Python 3.11.6, 2 vCPU, 478 MB |
| Claude Code install in VM | **6.1 s**, v2.1.260 |
| Hidden suite size | **47 tests** |
| Reference impl score | **47 / 47** |
| Factory smoke assertions | **25** |
| Account | Max subscription |
| **Blocker** | `setup-token` returned a token that 401s; E2B side fully green |

---

## 10. Screens to build — with PLACEHOLDER data

> ⚠️ Numbers below are **invented for layout purposes only.** Replace with
> `results/<runId>/run.json` once a real run lands.

### Screen 1 — Setup / the two arms
Side-by-side config cards. Arm A: one flag list, mostly empty. Arm B: nine
levers, each with its Uber citation. The visual point is *asymmetry of scaffolding*.

### Screen 2 — Live run
Two parallel timelines: boot → install → agent turns → grade. Per-arm running
cost counter (Uber ships a live status-line cost counter; this is that idea).

### Screen 3 — Results (the money shot)
**A six-axis spider/radar chart**, both sessions overlaid. This is what
`report.mjs` already generates into `results/<runId>/report.html`, so the shape
is fixed:

| axis | direction | raw metric |
|---|---|---|
| Correctness | higher better | hidden suite pass rate |
| Cost efficiency | lower better | `total_cost_usd` |
| Token economy | lower better | output tokens |
| Turn economy | lower better | `num_turns` |
| Cache reuse | higher better | cache reads / total billed input |
| Speed | lower better | agent wall time |

Each axis is normalised independently so the better session touches the outer
ring — **outward is always better**, including on the four axes where a lower
raw number wins. Raw values are printed beside every axis label, and the
unnormalised table sits directly beneath the chart. A radar chart alone can
flatter whichever shape encloses more area, so the table is not optional.

### Screen 4 — Failure detail
Which of the 47 tests each arm missed, grouped by class. Shows *how* they fail
differently, not just how much.

### Data contract

```json
{
  "runId": "2026-09-04T09-12-33-000Z",
  "model": "opus",
  "auth": "subscription (CLAUDE_CODE_OAUTH_TOKEN)",
  "arms": [
    {
      "arm": "a-regular",
      "label": "A · regular (out-of-the-box Claude Code)",
      "sandboxId": "i3cn40exc9v6jl2hyskys",
      "levers": ["stock defaults — no flags beyond --model", "agent alone decides when it is done"],
      "result": {
        "total_cost_usd": 0.0000,
        "num_turns": 0,
        "duration_ms": 0,
        "usage": {
          "input_tokens": 0,
          "output_tokens": 0,
          "cache_creation_input_tokens": 0,
          "cache_read_input_tokens": 0
        }
      },
      "grade": { "total": 47, "passed": 0, "failed": 0, "errors": 0,
                 "import_ok": true, "failures": ["Cycles.test_cycle_via_range"] },
      "linesOfCode": "0 total",
      "totalWallSec": 0
    }
  ]
}
```

Derived in the UI: `costPerPass = total_cost_usd / grade.passed`,
`cacheHit = cache_read / (input + cache_creation + cache_read)`.

---

## 11. Honest caveats — put these on the page

1. **n = 1 per arm.** Agent runs vary a lot. A single pass shows the *shape* of a
   difference, not a defensible number. Three repeats per arm is the minimum for
   a claim.
2. **Arm B is supposed to win on cost.** That's the hypothesis, not a surprise.
   The genuinely interesting outcomes are (a) whether correctness *holds* at
   medium effort, and (b) the size of the gap.
3. **One task.** A parser task rewards planning and spec-discipline. A debugging
   or refactoring task might rank the harnesses differently.
4. **Arm B's scaffolding cost a human time to write.** The comparison prices the
   tokens, not the engineering that produced `CLAUDE.md` and `./factory`.
5. **Same model both arms**, deliberately. Uber's largest lever was model
   routing; this demo excludes it to isolate harness effects.

---

## 12. Repo map

```
run-demo.mjs                 orchestrator — control vs one experiment, parallel
report.mjs                   run.json → report.html with the spider chart
preflight.mjs                proves E2B + token + install before spending
set-token.sh                 clipboard → .env, validated, never echoed

task/BASE_PROMPT.md          the task prompt BOTH arms get, verbatim
task/spec/SPEC.md            the benchmark task
task/grader/test_hidden.py   47 hidden tests, injected post-exit
task/grader/grade.py         runs them, emits JSON

experiments/README.md        how to author one
experiments/*.md             one file per optimization strategy
assets/                      scaffolding experiments may copy in:
                               CLAUDE.md, factory, agents.json,
                               .claude/skills/verify/SKILL.md

results/<runId>/             report.html, report.txt, run.json, per-arm artifacts
results/0000-SYNTHETIC-…/    invented numbers for chart development, not a result
```
