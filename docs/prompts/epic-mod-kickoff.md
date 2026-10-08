# Kickoff prompt — epic MOD (for local Claude Code)

Run it from the root of this repo:

```sh
claude "$(sed -n '/^---8<---$/,$p' docs/prompts/epic-mod-kickoff.md | tail -n +2)"
```

Or paste everything below the scissors line into a new Claude Code session started in this repo.

---8<---
You are working on **opthub** with Oleg (oleg@canarian.io). opthub measures whether a cheaper way
of running a coding agent does the same job, by replaying real Claude Code sessions and grading
them blind. Today we start **epic MOD**: capture every model request into a journal opthub owns,
and run routing in shadow mode, from inside Claude Code as a **Mod** instead of through a proxy.

## Read first, in this order, before you write anything
1. `CLAUDE.md` — the rules for numbers, privacy and git. They apply to everything you do here.
2. `docs/epic-mod.md` — the epic: why, what we copy from claude-router, the tasks MOD-0…MOD-6,
   the decisions D1–D3, and the crux.
3. `docs/runtime-optimization.md` §4, §8 and §9 — ULT, the proxy router. Note what blocks it.
4. `SPEC.md` §7 (optimizer catalog), §9.2 (hash chain), §16 (epic RO) and §17 (this epic).
5. claude-router at the pinned commit:
   `git clone https://github.com/alexei-led/claude-router /tmp/claude-router && git -C /tmp/claude-router checkout 7599fb5`
   Read `hooks/native-router.mjs` (the `turn.step` hook), `lib/policy.mjs`, `lib/native-cost.mjs`,
   `docs/architecture.md` and `docs/evaluation.md`.
6. The Mod API for **this** Claude Code build. If a `plugin-authoring` skill is listed, load it and
   read the types file it names. Grep it for `TurnStepInput`, `TurnStepResult`, `ModelUsage`,
   `fs: {`, `crypto` and `telemetry.log`. The API is early access: trust the types file over
   `docs/epic-mod.md` §3, and say where they differ.

## Where things live
- This repo (public): spec, docs, read-only stdlib Python tools. The Mod goes in `mod/` here (decision
  D1, the default). It must spend nothing.
- `sandbox/e2b` (private, not yet published): the hub, the experiment loop, ULT (`lib/ult/`). Ask Oleg for
  its path on this machine if you can't find it next to this repo. MOD-3 and MOD-4 happen there.
- The journal lives under `$OPT_HOME/journal/` (default `~/.opthub/journal/`), **never** in a repo.

## What to do now
Do **MOD-0** only, then stop and report. Do not start MOD-1 until Oleg has read the report.

1. Write a probe Mod in `mod/probe/`: `.claude-plugin/plugin.json`, `hooks/hooks.json`,
   `hooks/register.ts`. On every `turn.step`, record the input (`turnId`, `index`, `model`,
   `effort`, `messageCount`, `agentId`) and, after `yield* next(e)`, the result's `usage`,
   `stopReason`, the number of `toolUses`, and the time the hook took. Write the records to
   `$OPT_HOME/journal/probe/<session-id>.jsonl` with `$.fs.write`. No prompt text, no tool inputs,
   no paths.
2. Run `claude plugin validate mod/probe` until it is clean.
3. Ask Oleg to run one real session with `claude --plugin-dir mod/probe`. The session should use a
   subagent and run `/compact` once.
4. Answer the four MOD-0 questions in `docs/epic-mod.md` from the records and the session's transcript
   in `~/.claude/projects/`:
   - Do subagent steps carry `agentId` and `usage`?
   - Do background calls (title generation, compaction) appear? If not, does `telemetry.log` with
     `{ to: 'collector' }` carry them when OpenTelemetry export is on?
   - How many requests have matching usage in journal and transcript? Report the gap.
   - How long does the hook add per step (median and worst)?
5. Write the answers as a dated entry at the **end** of `PROGRESS.md`, and update `docs/epic-mod.md` §3.
   Apply MOD-0's kill test and state the result in one line.
6. Commit on a branch named `mod/probe`, open a PR, and stop.

## Rules you must not break
- **Numbers:** every figure in a doc comes from a tool, a pinned file or a cited source. Label each saving
  `priced`, `guess`, `detector` or measured. One run is `n = 1` and is not a finding: say so.
- **Privacy:** nothing committed contains prompt text, tool inputs, absolute paths, costs tied to a named
  person, or credentials. The repo is public: scan the diff before every commit.
- **Shadow only:** in this epic the Mod never changes `model` or `effort`. If a hook rewrites either, that is a bug.
- **Credit:** where code or logic comes from claude-router, say so in the file header (MIT, commit `7599fb5`).
- **Small steps:** one task per branch and PR. When something surprises you, stop and write it in `PROGRESS.md`
  before you work around it.

## When you are unsure
Ask Oleg one short question. Decisions D1–D3 in `docs/epic-mod.md` §5 have defaults: use them unless he says
otherwise. Don't widen scope: route mode, local models through the Mod, team views and ticket/branch tracking
are out of this epic.

## The question behind all of this
Does a blind-graded replay show per-turn routing saving more than about 10% with no quality loss? Today the
answer is unknown. MOD-4 will test it. Until then, treat every routing saving as `priced` at best.
