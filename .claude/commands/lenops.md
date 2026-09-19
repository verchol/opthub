---
description: Session ops report — context, preload floor, models, cost, cache misses, latency, levers
argument-hint: "view [--all | --session <uuid>]"
allowed-tools: Bash(python3 tools/lenops.py:*)
---

!`python3 tools/lenops.py ${ARGUMENTS:-view}`

The report above is the whole answer. Relay it as-is — do not re-run the tool,
re-derive any figure, or restate the table in prose.

Add at most three lines underneath, and only if something in *this* run warrants it:

- context past 50% of the window, or growth that reaches 80% within ~100 requests
- a named `WHY THE CACHE MISSED` cause that is large enough to be worth acting on —
  this is the API's own attribution, so it names the culprit instead of guessing
- `write:read` and the measured `C ttl-5m` pointing opposite ways — the dollar bucket is a
  heuristic, the counterfactual is the measurement, and §6.5 says an unstable sign is a
  reason to propose nothing

Never quote levers A, B or D as savings: A and B are headroom under invented percentages,
D is a ceiling under an assumption that is probably false. Only C is measured.
`LATENCY` is turn duration — user message to final response, including tool execution —
not model latency. See `docs/experiments.md` § E1.
