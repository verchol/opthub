# Epic MOD — capture and shadow routing inside Claude Code

**Status:** draft v0.1 · **Date:** 2026-10-08 · **Owner:** oleg@canarian.io · **Track:** [O]
**Spec:** `SPEC.md` §17 points here. **Kickoff prompt for Claude Code:** [`docs/prompts/epic-mod-kickoff.md`](prompts/epic-mod-kickoff.md)
**Learned from:** [`alexei-led/claude-router`](https://github.com/alexei-led/claude-router) at commit
`7599fb5` (router 1.3.0, 2026-10-06), MIT. Every figure from that repo below names the file it comes from.

---

## 1. In one paragraph

Alexei's router moved from a proxy to a **Claude Code Mod**: a plugin hook that changes only the
model and effort of each model request, while Claude Code keeps building the request, holding the
credentials and running the tools. That move removed the problems ULT is blocked on today. This
epic copies the move for the part of opthub that needs it most — **capturing every request into a
journal opthub owns** — and runs routing in **shadow** inside the same Mod. It also tests his
router in our replay loop, because he says himself that his savings are not measured, and
measuring them is what opthub is for.

## 2. What we learned from claude-router

| # | Lesson | Evidence (claude-router @ `7599fb5`) | What it means for opthub |
|---|---|---|---|
| L1 | **Hook in, don't proxy.** | `CHANGELOG.md` 1.0.0: gateway, proxy, launcher and status-line script removed; the Mod changes only `model` and `effort` in `turn.step`. | ULT's open blockers are proxy problems: the expired OAuth token (`docs/runtime-optimization.md` §8), four Haiku `400`s that forced a model adapter (§9.3), Docker preflight, orphan routers (§4.1). A Mod has none of them. |
| L2 | **Price a switch from the cache you actually have.** | `lib/policy.mjs`, `lib/native-cost.mjs`: switch cost = candidate's worst-case cache write minus incumbent's best-case cache read, from the last response's `cache_read + cache_creation`; the bar to switch rises with that cost; an upgrade needs repeated votes; a downgrade must pay back within N turns; a model is dropped at 80% of its window. | ULT's size estimate read 100k where 152k was billed (`docs/runtime-optimization.md` §9.4). Use observed usage instead. |
| L3 | **Per-turn routing is a small lever on this workload.** | `docs/evaluation.md`: router 15.5% below "always Opus at xhigh" but only **4.1%** below "strongest model per whole session" (26 sessions, 1,611 requests, ~21 h, one developer, list prices, no quality check). Native replay: 11,619 main decisions, 37 with advice, **0 of 37** routed differently. `CHANGELOG.md` 0.8.0: 15 of 16 escalations from Sonnet stayed on Opus for good, about $31.6 in cold cache writes, mostly set off by environment or hook errors. | Agrees with `SPEC.md` §7: `context-lifecycle` first, `model-routing` built to be blocked. Do not escalate on tool or environment errors. Label: `published` by a third party, `n` small. |
| L4 | **The router is free now.** | MIT, installed with two commands; the classifier can be Jev or Cloudflare's open-source Clef. README: "Current savings are not measured." | Don't compete on the router. Compete on the proof: blind-graded replay. |
| L5 | **Ship small, often, tested in the real engine.** | 23 versions from 0.1.1 (2026-09-22) to 1.3.0 (2026-10-06), from `git log`. CI runs `claude plugin validate` and loads the Mod in Claude Code; acceptance results are checked in as JSON under `experiments/mod-router/results/`. | Our implementation repo is unpublished and every comparison is `n = 1`. Copy the habit. |

**What we do not copy:**
- **Prompt text to the classifier.** He sends the prompt and up to six recent messages, 1,200 characters each
  (`docs/architecture.md`). opthub sends counts and flags only (`CLAUDE.md` privacy rules). Keep ours.
- **Acting without a shadow phase.** His router has no shadow mode. Ours stays shadow-first (`SPEC.md` §16 rule 1).
- **Escalating on errors** (L3).

## 3. What the Mod API gives us — checked against Claude Code 2.1.293's types

Mods are early access, and the API moves between releases. claude-router requires Claude Code 2.1.289 or newer.
Re-read the types file on the build you run before you trust any line below.

| Need | Mod API | Notes |
|---|---|---|
| One record per model request | `turn.step` (a streaming hook). Input: `turnId`, `index`, `model`, `effort`, `messageCount`, `agentId` (absent on the main thread). Result: `usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `model`), `stopReason`, `toolUses`. | A hook may rewrite only `model` and `effort`. |
| Session identity | `$.session.id()`, `$.session.cwd()`, `$.session.model()` | |
| Durable storage we own | `$.fs.write(path, text)` (whole file, creates directories, 4 MiB cap per read or write), `$.store` across sessions | No append call: write one file per session and roll it before 4 MiB. |
| Hash chain | global `crypto.subtle.digest` | Same chain as `SPEC.md` §9.2. |
| Visible state | `$.ui.status`, an `AbovePrompt` band, `$.ui.toast` | |

**What the Mod does not give us**, so the journal **adds to** the transcripts and does not replace them:
- no 5-minute / 1-hour split of cache writes (claude-router `docs/native-router.md` says the same);
- no thinking-token split and no `diagnostics.cache_miss_reason`, which `tools/lenops.py` reads from transcripts;
- **unknown:** whether background calls (title generation, compaction) pass through `turn.step`. E1-F3 found
  381 title-generation calls with no usage record anywhere local. MOD-0 answers this.

## 4. The work

Each task has a "done when" and, where it can fail, a kill test.

### MOD-0 · Probe the hook (half a day)
A Mod of about 30 lines that writes each `turn.step` input and result to a file. Run one real session
with a subagent and a compaction in it. Answer, in `PROGRESS.md`:
1. Do subagent steps carry `agentId` and `usage`?
2. Do background calls (title generation, compaction) appear? If not, does `telemetry.log` with
   `{ to: 'collector' }` carry them when OpenTelemetry export is on?
3. Does `usage` match the transcript's usage for the same request? (Count matching requests; report the gap.)
4. How long does the hook add per step?

**Kill test:** if `usage` is missing or wrong for main-thread steps, stop MOD-1 and keep wire capture on the proxy.

### MOD-1 · `opthub-capture` — the journal
- One JSONL per session at `$OPT_HOME/journal/<YYYY-MM>/<session-id>.jsonl`, hash-chained, rolled before 4 MiB.
- Record: `seq`, `ts`, `session`, `turn`, `index`, `agent` (or `main`), `model_requested`, `model_answered`,
  `effort`, `message_count`, the four usage counts, `stop_reason`, `tool_use_count`, `hook_ms`, `prev_hash`, `hash`.
- **No prompt text, no tool inputs, no file paths.** `cwd` is stored only as a hash.
- `tools/journal.py` (stdlib, read-only): `verify` checks the chain; `reconcile` compares journal usage with
  transcript usage per session and prints the gap; `price` prices the journal through `tools/costmodel.py`.
- **Done when:** one week of real sessions are journaled, `verify` passes, and `reconcile` is within 1% on
  main-thread usage, or the gap is explained in `PROGRESS.md`.

### MOD-2 · Shadow routing in the Mod
- Reuse ULT's rules classifier and the policy from MOD-3. Jev is off by default and, when on, gets features and
  flags only — the same contract as `experiments/session-triage`.
- Never change `model` or `effort` in this epic. Write `would_route`, `target`, `reason`, `est_keep_usd`,
  `est_route_usd` into the same journal record.
- Status line: `opthub SHADOW · would route → <model> · est <±$>`.
- **Done when:** a week of shadow decisions, and a `tools/journal.py shadow` report: how many main-thread
  decisions would switch, and the estimated net after the cache cost of switching. Label it `priced`, not measured.

### MOD-3 · Cache-cost policy in ULT (`sandbox/e2b/lib/ult/policy.mjs`)
- Replace the size estimate with the observed `cache_read + cache_creation` of the thread's last response.
- Add the switch-cost bar, repeated votes for upgrades, a payback horizon for downgrades, and the 80% context fit.
- Remove any escalation that fires on tool or environment errors.
- Credit claude-router (MIT) in the file header.
- **Done when:** ULT's `npm test` passes with new cases for each rule, and replaying the 2026-09-30 audit log
  shows the estimate against the billed input.

### MOD-4 · Experiment E-R1: claude-router as an arm
- In the experiment loop, `exp1` = baseline plus `claude --plugin-dir <claude-router at 7599fb5>`. Pin the commit.
- Pick three sessions still on disk from the top of the cost ranking. Run **three repeats per arm**, grade blind,
  and charge the classifier's cost and time against the saving.
- Allow egress to `api.typesafe.ai`, or to Cloudflare for Clef. Assert in the report that the classifier was
  actually reached, because without a key the router silently keeps the baseline model.
- **Kill test:** if the graded saving is under 5%, or the blind score drops beyond the noise floor,
  `model-routing` stays "built to be blocked" in `SPEC.md` §7. Record the number either way.

### MOD-5 · Ship it the way Alexei does
- Add `.claude-plugin/marketplace.json` so a design partner installs with one line:
  `/plugin install opthub-capture --marketplace verchol/opthub`.
- CI runs `claude plugin validate` and `claude plugin test` on the Mod.
- Check acceptance results into `mod/results/*.json`. Keep a `mod/CHANGELOG.md` with upgrade steps.

### MOD-6 · Docs
- `docs/router-comparison.md` row for claude-router (done with this file).
- `SPEC.md` §17 and the README roadmap (done with this file).
- After MOD-0, update this file's §3 with what the probe found.

## 5. Decisions for the owner

| id | question | default if nobody answers |
|---|---|---|
| D1 | Where does the Mod live? | `mod/` in this repo: it is public, so a design partner can install it, and it spends nothing. |
| D2 | Which classifier does shadow mode ask? | Rules only. Jev only with features and flags. Clef only after checking what it needs to be sent. |
| D3 | Does the Mod ever act (route mode)? | Not in this epic. MOD-4's result decides. |

## 6. How ULT and the Mod split the work

| | Mod (this epic) | ULT (epic RO) |
|---|---|---|
| Agent | Claude Code only | any agent that takes `ANTHROPIC_BASE_URL` |
| Credentials | Claude Code's own; the Mod never sees them | ULT holds them |
| Local models (Ollama) | no | yes |
| Sandbox isolation | no | yes |
| Model adapter | not needed: Claude Code builds the request for the chosen model | needed |
| Cache-write TTL split | no | yes |

## 7. The crux

Does a blind-graded replay show per-turn routing saving more than about 10% on real sessions with no quality loss?
**Unknown today.** MOD-4 is the test. If the answer is no, routing is a feature and not the wedge, and opthub
leads with capture that does not decay, `context-lifecycle`, and proof.

## 8. Not in this epic

Route mode in the Mod · local models through the Mod · team aggregation · tying a step to a ticket or branch.
The Mod could read the git branch through `$.process.run`, which is a cheap probe for the [V] unit-of-work join
key, but that belongs to a separate [V] epic.
