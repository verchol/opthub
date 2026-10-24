# Scenarios

One file per optimization strategy. The control arm is fixed and never changes,
so an experiment file *is* the independent variable.

    opt demo scenarios           # what's available
    opt demo run --scenarios plan-first       # control vs plan-first
    opt demo run --scenarios                  # control vs uber-factory (default)

## The minimum experiment is a prompt

Create `scenarios/my-idea.md`:

```markdown
---
description: Make the agent state its assumptions before writing code.
---

Before you write any code, list every assumption you are making about SPEC.md
that the spec does not settle. Resolve each one by re-reading the spec, then
implement.
```

That's a complete, runnable experiment. The body is appended to the shared task
prompt under a heading; the control arm gets the same task prompt *without* it.

## Frontmatter — every key optional

| key | meaning |
|---|---|
| `description` | one line, shown in the report |
| `flags` | extra CLI flags, space-separated |
| `files` | files to copy from `assets/` into the workspace |
| `agents` | an asset file to pass to `--agents` (implies `files`) |

```markdown
---
description: Batch every check into one process call.
flags: --effort medium --setting-sources project
files: CLAUDE.md factory .claude/skills/verify/SKILL.md
---

Run `./factory verify` instead of ad-hoc checks. One call replaces six.
```

Notes:

* `files` paths are relative to `assets/` and land at the same path in the
  workspace. A copied file with no dot in its name is made executable.
* `flags` are appended after `--model`. Measurement plumbing (`-p`,
  `--output-format json`, `--max-budget-usd`, …) is added to both arms and is
  not yours to set.
* Anything you *don't* specify stays at the control's value. That is the point:
  one file, one variable.

## What stays constant

Both sandboxes get the same base image, the same `SPEC.md`, the same
`task/BASE_PROMPT.md`, the same model, and the same hidden 47-test grader
injected after the agent exits. If you change the model, change it for both
(`BENCH_MODEL=sonnet`) — a per-arm model change makes the comparison measure
model routing instead of your strategy.
