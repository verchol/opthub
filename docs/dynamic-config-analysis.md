# Dynamic Claude Code configuration: per-session savings (preliminary)

**Status:** preliminary, 2026-10-23. Nothing here has been replayed. Every saving is labelled
`measured`, `priced` or `guess` (CLAUDE.md, Rules for numbers).
**Source:** `python3 tools/dynconfig.py` over every Claude Code transcript on the development machine
(`~/.claude/projects`). That is 134 sessions and 7,592 requests (deduplicated), 2026-08-24 to 2026-10-22,
including subagent transcripts. The per-session table is `data/private/dynconfig/sessions.csv`
(gitignored: it has project names).
**Lever catalog:** [Claude Config & Routing Levers](https://claude.ai/artifact/Knx3AXQiQYjzvkNKDngRje),
both tabs.

The question: had each session started with a Claude Code configuration chosen for *that* session,
what would it have cost?

---

## 1. Answer

| window | sessions | cost (list price) | saved by per-session config | of which measured | median session |
|---|---|---|---|---|---|
| everything on disk, 08-24 to 10-22 | 134 | $1,349.57 | **$263.31 (19.5%)** | $47.48 (3.5%) | 24.8% |
| last two weeks, 10-09 to 10-22 | 50 | $235.70 | **$30.21 (12.8%)** | $12.67 (5.4%) | 19.1% |

- **Most of the all-time saving has already been taken.** $174.28 of the $263.31 is moving from Opus 5
  to Opus 5.5 (`priced`), and every session since 2026-09-23 already runs on Opus 5.5. Without it the
  all-time saving is $89.02 (6.6%).
- **Going forward, expect about 13% from configuration alone.** That's the two-week figure. The one
  measured part is the cache TTL (5.4%). The rest is priced or a guess until replays measure it.
- **The biggest lever is not configuration.** Starting a new session per task (`/clear`) has a
  ceiling of 21.5% in the last two weeks and 40.1% overall (`priced`). It needs the user, or a product
  that prompts at task boundaries.
- **A cheaper main-loop model looks big on paper and loses in practice.** The ceiling is 20.8% over the
  last two weeks, but replays measured Sonnet 2.4–3.9× *more* expensive per task (n=2). It is not in
  the total.

## 2. The levers, per session, in applied order

Attribution is marginal, in applied order (SPEC R1): each lever acts on what the levers before it left,
so the rows add up to the total. "Sessions" counts sessions where the lever saved more than half a cent.

| # | lever | what to set | fires when | evidence | all-time | % | sessions | last 2 weeks | % |
|---|---|---|---|---|---|---|---|---|---|
| 1 | fast mode off | `/fast`, `fastModePerSessionOptIn`, `CLAUDE_CODE_DISABLE_FAST_MODE=1` | a request ran fast | measured | $0.00 | 0.0 | 0 | $0.00 | 0.0 |
| 2 | no model switch mid-session | choose `--model` at launch | the main chain changed model | measured | $5.74 | 0.4 | 2 | $0.00 | 0.0 |
| 3 | cache TTL per session | `promptCacheTtl` / `CLAUDE_CODE_PROMPT_CACHE_TTL` | the other TTL is cheaper on the session's real gaps | measured (simulation) | $41.74 | 3.1 | 103 | $12.67 | 5.4 |
| 4 | drop unused tools at launch | `--strict-mcp-config`, `--disallowed-tools` | tools offered but never called | priced | $5.19 | 0.4 | 32 | $5.20 | 2.2 |
| 5 | output-filter hook | `PreToolUse` hook on test and log commands | Bash results over 8,000 chars | guess | $23.87 | 1.8 | 61 | $7.49 | 3.2 |
| 6 | effort down one level | `--effort`, `CLAUDE_CODE_EFFORT_LEVEL` | thinking ≥ 50% of output tokens | guess | $1.38 | 0.1 | 4 | $0.00 | 0.0 |
| 7 | subagents on Haiku | `CLAUDE_CODE_SUBAGENT_MODEL`, subagent `model: haiku` | the session used subagents | priced | $11.11 | 0.8 | 3 | $4.86 | 2.1 |
| 8 | Opus 5 / 4.8 → Opus 5.5 | `--model`, `ANTHROPIC_DEFAULT_OPUS_MODEL` | the session ran on an older Opus id | priced | $174.28 | 12.9 | 54 | $0.00 | 0.0 |
| | **dynamic configuration, total** | | | | **$263.31** | **19.5** | | **$30.21** | **12.8** |

Standalone ceilings, **not** added to the total:

| | lever | what to do | evidence | all-time | % | last 2 weeks | % |
|---|---|---|---|---|---|---|---|
| X1 | new session per task | `/clear` between tasks, `/rewind` instead of arguing forward | priced ceiling | $540.69 | 40.1 | $50.71 | 21.5 |
| X2 | main loop on Sonnet or Haiku | `--model` per the `tools/tune.py` rule | priced ceiling; replays measured the opposite | $156.68 | 11.6 | $49.10 | 20.8 |

How each lever is priced:

- **1, fast mode:** fast requests bill 2× standard. No request on this machine ran fast
  (`usage.speed` is `standard` or absent on all of them), so the lever is worth $0 here.
- **2, model switch:** the first request on the new model writes the whole context to the cache.
  Without the switch that write would have been a read; the difference is the saving.
- **3, cache TTL:** both TTLs are simulated against the session's real gaps between requests. A gap
  longer than the TTL rewrites the whole prefix. Writes cost 1.25× the input price on 5m and 2× on 1h;
  reads cost 0.1×. The saving is the difference between the TTL the session used and the cheaper one.
  All 103 sessions it fired on ran with the 1-hour TTL and would have been cheaper on 5 minutes.
- **4, unused tools:** tool definitions come from the `api-request-shape` records Claude Code keeps,
  which only 32 sessions have. Tools offered but never called are converted at chars/4 to tokens, written
  once and re-read on every later request. The median is 5,779 unused-definition tokens per session.
- **5, output-filter hook:** each Bash result over 8,000 characters is cut to 2,000 (failures only). The
  cut tokens (chars/4) are written once and re-read on every later request until a compaction or the
  end of the session. Both thresholds are guesses.
- **6, effort:** the rule is `tools/tune.py`'s: lower effort one level when thinking is at least half
  the output tokens, assuming 50% fewer thinking tokens. Thinking is a median 18.9% of output here, and
  only 5 sessions reach 50%, so the lever is small on this machine. By request, effort was
  `high` 5,450 times, `medium` 1,941 and `xhigh` 3.
- **7, subagents:** subagent spend re-priced at Haiku 4.5 list rates. Only 3 sessions used subagents
  (197 requests).
- **8, Opus 5.5:** the same tokens at Opus 5.5 list rates, which assumes Opus 5.5 would use the same
  number of tokens.
- **X1, new session per task:** for every request whose context exceeded 150k tokens, the share of its
  input above 150k. This is a ceiling: it assumes everything above 150k belonged to earlier, separable
  tasks.
- **X2, cheaper main loop:** the `tools/tune.py` model rule. Keep the model when the median context is at
  least 150k; switch to Haiku for small sessions (≤ 2 files edited, ≤ 12 requests); otherwise Sonnet. The
  same tokens are re-priced, minus thinking.

## 3. Per session

| percentile of per-session saving | all-time | last 2 weeks |
|---|---|---|
| p25 | 17.9% | 14.3% |
| median | 24.8% | 19.1% |
| p75 | 30.1% | 24.0% |
| p90 | 36.9% | 29.2% |
| max | 54.9% | 54.9% |

By session cost, all-time:

| session cost | sessions | cost | saved | % | X1 ceiling |
|---|---|---|---|---|---|
| under $1 | 41 | $15.14 | $4.45 | 29.4% | $0.00 |
| $1 to $10 | 74 | $252.80 | $56.56 | 22.4% | $6.27 |
| $10 to $50 | 11 | $180.91 | $46.19 | 25.5% | $35.74 |
| $50 and over | 8 | $900.72 | $156.11 | 17.3% | $498.68 |

Eight sessions over $50 are two-thirds of all spend, and they carry 92% of the X1 ceiling. Long
interactive sessions are where a new session per task matters. Small sessions gain proportionally more
from configuration, but the dollars are small.

By how the session was started:

| entry point | sessions | cost | saved | % |
|---|---|---|---|---|
| `cli` (interactive) | 55 | $1,151.16 | $216.41 | 18.8% |
| `sdk-cli` (`claude -p`: opt's own runs and replay arms) | 77 | $197.63 | $46.49 | 23.5% |
| `claude-desktop` | 2 | $0.77 | $0.40 | 52.1% |

Top sessions by cost, all-time (the full table is in the private CSV):

| session | cost | after | saved | levers that fired |
|---|---|---|---|---|
| e0c2b950 | $241.70 | $190.22 | 21.3% | hook, Opus 5.5 |
| 277953fe | $222.29 | $172.89 | 22.2% | switch, hook, Opus 5.5 |
| f95d2814 | $106.72 | $96.55 | 9.5% | tools, hook, subagents |
| 613906e2 | $106.21 | $84.08 | 20.8% | hook, Opus 5.5 |
| 8b28d80d | $59.75 | $57.83 | 3.2% | hook, subagents |
| 22eb52d3 | $57.60 | $55.15 | 4.2% | hook |
| 20a364b9 | $54.31 | $48.60 | 10.5% | hook, subagents |
| 8f8a07f9 | $52.14 | $39.28 | 24.7% | hook, Opus 5.5 |
| 43968fbd | $43.65 | $32.48 | 25.6% | TTL, Opus 5.5 |
| 2c2ef2b1 | $21.96 | $20.53 | 6.5% | hook |

## 4. Every flag in the catalog, and what this analysis did with it

| flag or setting | lever | here |
|---|---|---|
| `/model`, `--model`, `ANTHROPIC_MODEL`, `model` | model choice | evaluated: 2, 8, X2 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` / `_SONNET_` / `_HAIKU_` | pinned old ids | evaluated: 8; no session pinned an old Haiku |
| `CLAUDE_CODE_SUBAGENT_MODEL`, subagent `model:` | subagents on Haiku | evaluated: 7 |
| `/model opusplan` | plan on Opus, execute on Sonnet | not measurable: transcripts don't mark plan versus execute turns |
| `/advisor` | Opus only on hard steps | not measurable: no session used an advisor |
| router cascade, open-weights model (`ANTHROPIC_BASE_URL`) | per-request routing | not evaluated: a router decision per request, see `docs/runtime-optimization.md` and `docs/local-inference-capacity.md` |
| `/effort`, `--effort`, `effortLevel`, `CLAUDE_CODE_EFFORT_LEVEL`, `effort:` | effort | evaluated: 6 |
| `maxEffortLevel` | org ceiling on effort | covered by 6: only 3 requests ran above `high` |
| `MAX_THINKING_TOKENS` | thinking cap | not applicable: the 5.5 models ignore it, and older ones overlap with 6 |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | output cap | not measurable: a truncated answer's retry cost can't be priced from transcripts |
| `output_config.task_budget` | stop runaway tasks | not evaluated: loops were 1.4% of spend in E1 (`tools/loopscan.py`) |
| `--max-turns`, `--max-budget-usd` | tail guard | a guard, not a saving (same 1.4% bound) |
| `/clear`, `/rewind` | new session per task | ceiling X1 |
| `/compact`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `idleCompaction` | compaction timing | not evaluated: can be negative (a summary plus a new cache write); only 6 compactions on disk |
| `context_management` → `clear_tool_uses` | drop old tool results | not evaluated: rewrites cached history, ~0 or negative per the catalog |
| `--strict-mcp-config`, `--disallowed-tools`, `/mcp` | unused tools | evaluated: 4 |
| slim `CLAUDE.md`, workflows as skills | smaller prefix | partly inside 4; the rest is not measurable from transcripts |
| `PreToolUse` hook | output filter | evaluated: 5 |
| verbose work in a subagent | raw output out of the main context | overlaps 5 and 7, so not counted twice |
| LSP plugin | navigation instead of grep | not measurable |
| `DISABLE_PROMPT_CACHING` | caching | not set anywhere; caching works (a detector, not a lever) |
| `promptCacheTtl`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, `subagentPromptCacheTtl`, `experimental.cacheTtl` | TTL | evaluated: 3, main chain only |
| choose settings at launch | don't switch mid-task | evaluated: 2 |
| `/fast`, `fastMode`, `fastModePerSessionOptIn`, `CLAUDE_CODE_DISABLE_FAST_MODE` | fast mode | evaluated: 1, zero here |
| Batch API | half price, no tool loop | not applicable to agent sessions |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | team fan-out | not used on this machine |
| `/loop`, `CLAUDE_CODE_GOAL_CHECKIN_MINUTES`, `crossSessionInbound` | idle background turns | not measurable: idle turns are not marked in transcripts |
| residency | 1.1× multiplier | org setting; every request here ran in the standard tier |
| `--settings` | per-run settings without touching files | the vehicle for all launch-time levers above |

## 5. Caveats

- **Priced is not measured.** Levers 4, 7 and 8 re-price the same tokens. A different model or toolset
  would also change how many tokens a session uses. Levers 5 and 6 rest on stated guesses. Only 2 and 3
  come from the transcripts themselves.
- **Dollar figures depend on the price table.** Dollars here use the repo's table
  (`app/config/ult.default.json`). Token counts match Claude Code's own `cost-state` records exactly,
  but Claude Code values Opus 5.5 about 20% lower: on 66 sessions this tool's cost is a median 1.25× Claude
  Code's, while Opus 5 agrees within 5% (0.955×, n=27). Percentages hardly move with the price; dollars
  do, and so does lever 8, which would be larger under Claude Code's prices. Check the table against
  Anthropic's price list before quoting dollars.
- **Haiku 5.5** is not in the price table and is priced at Haiku 4.5 rates. That makes lever 7
  conservative: the catalog cites a lower published price.
- **chars/4** stands in for a tokenizer in levers 4 and 5.
- **The TTL lever covers the main chain only**; subagents keep their own cache.
- **`sdk-cli` sessions are automated runs** (opt's `claude -p` and replay arms), not someone at a
  keyboard.
- **Nothing has been replayed yet.** The next step is `tools/rerun.py plan <session> --goal cost --dynamic`
  on the top sessions, three repeats a side, judged blind.

## 6. Found on the way: transcript usage was counted about twice

Claude Code writes one transcript record per content block and repeats the API response's usage on
each one: in the main transcripts on this machine, 15,835 records with usage are 7,323 distinct
requests. Every Claude Code
version on disk (2.1.241 to 2.1.305) does this, at 1.4 to 3.4 records per request.

`tools/dynconfig.py` counts usage once per request. With that, its token counts match Claude Code's own
`cost-state` records exactly (§5).

These tools add usage once per *record* and so overstate tokens and cost on these transcripts:

- `tools/savings.py` (it reports $2,951.04 over the same window, against $1,349.57 here);
- `tools/sessions.py` and `tools/lenops.py`;
- the hub's session cost in `app/lib/sessions-index.mjs`.

`tools/sessiongraph.py` already dedupes. Numbers published from the other four on recent transcripts
need re-checking. Whether the pinned E1 ledgers in `docs/data/` are affected is unverified: their
transcripts are no longer on disk.

## 7. Reproduce

```sh
python3 tools/dynconfig.py                       # everything on disk; writes data/private/dynconfig/sessions.csv
python3 tools/dynconfig.py --since 2026-10-09 --out data/private/dynconfig/since-2026-10-09
```
