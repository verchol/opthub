# Claims audit · cp-20261020-084341-d9b9

13 verified · 0 failed · 0 not proven · 2 notes

## ✓ verified — Both sides were given the same task and the same source tree.

- task.md sha256 849ff468ec6d across 6 runs
- source tree sha256 d5a91114aef9 (one read-only mount for every run)

## ✓ verified — Both sides ran the same main model.

- optimized-1: claude-opus-5-5 (Claude Code's init event)
- optimized-2: claude-opus-5-5 (Claude Code's init event)
- optimized-3: claude-opus-5-5 (Claude Code's init event)
- plain-1: claude-opus-5-5 (Claude Code's init event)
- plain-2: claude-opus-5-5 (Claude Code's init event)
- plain-3: claude-opus-5-5 (Claude Code's init event)

## ✓ verified — Claude Code loaded the same tools and version on both sides.

- tools: 22 plain, 22 optimized
- Claude Code 2.1.289

## ✓ verified — Every run finished without an error.

- optimized-1: result after 5 turns
- optimized-2: result after 5 turns
- optimized-3: result after 6 turns
- plain-1: result after 6 turns
- plain-2: result after 5 turns
- plain-3: result after 5 turns

## ✓ verified — The optimized side cost less than plain claude -p (reported 10% cheaper).

- both sides priced the same way: Claude Code's final token totals (result.modelUsage) at list rates
- baseline $0.0930 · optimized $0.0838 · medians of 3 and 3
- meter cross-check, optimized side: Claude Code's totals $0.0838 vs the gateway's own per-request sum $0.0838
- recomputed from the files: 9.9% cheaper; the run reported 9.9% cheaper
- Claude Code's own estimate (its price list): baseline $0.0778, optimized $0.0685

## ✓ verified — The optimized side's result passes the same hidden check as the baseline (check.py).

- check check.py sha256 30d9b549530d, run in its own sandbox against each finished workspace
- baseline 3/3 pass · optimized 3/3 pass

## ✓ verified — Every measured run started the same way: system prompt and tools warm, the task itself not cached.

- optimized-1: first request read 11,683 cached tokens, wrote 3,666
- optimized-2: first request read 11,683 cached tokens, wrote 3,666
- optimized-3: first request read 11,683 cached tokens, wrote 3,666
- plain-1: first request read 11,579 cached tokens, wrote 3,666
- plain-2: first request read 11,579 cached tokens, wrote 3,666
- plain-3: first request read 11,579 cached tokens, wrote 3,666
- warm-up: one turn a side beforehand (plain $0.0450, optimized $0.0488), not in the comparison

## · note — Wall time of each side.

- baseline 30s · optimized 22s (28% faster)

_the optimized side also waits for the router and, on local routes, for Ollama_

## ✓ verified — optimized-1: every model request went through the router, and its log is intact.

- router audit: 5 requests, hash chain intact (5 entries)
- Claude Code received 5 messages; the router must have seen at least as many requests
- decisions: keep 5 · nothing was moved off the requested model

## ✓ verified — optimized-2: every model request went through the router, and its log is intact.

- router audit: 5 requests, hash chain intact (5 entries)
- Claude Code received 5 messages; the router must have seen at least as many requests
- decisions: keep 5 · nothing was moved off the requested model

## ✓ verified — optimized-3: every model request went through the router, and its log is intact.

- router audit: 6 requests, hash chain intact (6 entries)
- Claude Code received 6 messages; the router must have seen at least as many requests
- decisions: keep 6 · nothing was moved off the requested model

## ✓ verified — The optimized agent never held your real credential; only the router did.

- optimized-1: sha256 of the key inside the container 25d107cbdd83 = the placeholder
- optimized-2: sha256 of the key inside the container 25d107cbdd83 = the placeholder
- optimized-3: sha256 of the key inside the container 25d107cbdd83 = the placeholder

## ✓ verified — The optimized side ran on the balanced profile: --effort medium, lean rules, skills none.

- skills loaded (Claude Code's init event): —
- skills invoked: none (attached, not used on this task)
- flags and rules: recorded in run.json and the task trail (rules sha256 d1ccfcaa9cab)

## ✓ verified — The run is in the hash-chained task trail, and no log holds the task text.

- tasks.jsonl: chain intact (123 entries), 8 entries for claude-p-20261020084341-68645c
- task text not found in tasks.jsonl or the router audit

## · note — n = 3 per side.

- 3 runs a side, compared by median

---
Re-run this audit from the files alone: `opt claude audit cp-20261020-084341-d9b9`
