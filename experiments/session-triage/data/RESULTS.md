# J3 — session triage: results

*Generated 2026-09-29T06:59Z by `src/run.py` over `e1b-sessions.csv` — 214 sessions, $508.80 at API list rates.*

Every figure is a headroom estimate from measured tokens under the lever's stated rate (`src/savings.py`). Nothing here was re-run; the experiment loop is what turns a ceiling into a measurement.


## Size of the prize — every session given the class

The most each class could be worth on this ledger if it were true of every session. No classifier is involved; this is the ceiling the arms below compete for.

| if every session were… | lever | saving (floor → ceiling) | % of spend |
|---|---|--:|--:|
| capability = mid | route-mid | $302.93 → $302.93 | 59.5% → 59.5% |
| capability = small | route-small | $344.95 → $344.95 | 67.8% → 67.8% |
| context = separable | context-split | $104.51 → $104.51 | 20.5% → 20.5% |
| deferral = overnight, unattended | batch | -$854.31 → $254.40 | -167.9% → 50.0% |

## Arm `rules-C0`

### Where the money sits, and what each class saves

Saving is the stacked floor → ceiling over the sessions in that class (`src/savings.py`).

| axis | class | sessions | spend | % | saving (floor → ceiling) |
|---|---|--:|--:|--:|--:|
| urgency | `unclear` | 214 | $508.80 | 100% | -$3.28 → $4.51 |
| latency | `interactive` | 28 | $501.31 | 99% | $0.00 → $0.00 |
| latency | `unattended` | 186 | $7.49 | 1% | -$3.28 → $4.51 |
| deferral | `unclear` | 28 | $501.31 | 99% | $0.00 → $0.00 |
| deferral | `within-hours` | 186 | $7.49 | 1% | -$3.28 → $4.51 |
| capability | `frontier` | 58 | $437.83 | 86% | -$2.80 → $1.89 |
| capability | `unclear` | 17 | $68.27 | 13% | -$0.67 → $0.50 |
| capability | `small` | 139 | $2.71 | 1% | $0.19 → $2.12 |
| context | `continuous` | 2 | $274.37 | 54% | $0.00 → $0.00 |
| context | `unclear` | 23 | $226.25 | 44% | -$1.09 → $1.03 |
| context | `short` | 189 | $8.17 | 2% | -$2.20 → $3.47 |

### What the classes unlock

| lever | sessions | saving | % of spend | label |
|---|--:|--:|--:|---|
| route to mid/small tier | 139 | $1.52 | 0.3% | priced |
| split separable sessions | 0 | $0.00 | 0.0% | guess |
| batch — cache holds | 186 | $2.98 | 0.6% | priced ceiling |
| batch — cache lost | 186 | -$4.81 | -0.9% | guess floor |
| all levers, stacked — ceiling |  | $4.51 | 0.9% |  |
| all levers, stacked — floor |  | -$3.28 | -0.6% |  |

**Spend, not saving:** 0 sessions are `blocking-now` + `interactive` on Opus — fast mode there would add $0.00. Classification is also how you decide where paying more is right.


### Ten most expensive sessions

| session | kind | cost | urgency | latency | deferral | capability | context | levers | saving (floor → ceiling) |
|---|---|--:|---|---|---|---|---|---|--:|
| s000 | generated-output | $137.49 | unclear | interactive | unclear | frontier | continuous | — | $0.00 → $0.00 |
| s001 | agent-tooling | $136.88 | unclear | interactive | unclear | frontier | continuous | — | $0.00 → $0.00 |
| s002 | agent-tooling | $37.61 | unclear | interactive | unclear | frontier | unclear | — | $0.00 → $0.00 |
| s003 | knowledge-base | $29.16 | unclear | interactive | unclear | frontier | unclear | — | $0.00 → $0.00 |
| s004 | product-repo | $23.96 | unclear | interactive | unclear | frontier | unclear | — | $0.00 → $0.00 |
| s005 | agent-tooling | $16.63 | unclear | interactive | unclear | frontier | unclear | — | $0.00 → $0.00 |
| s006 | agent-tooling | $16.47 | unclear | interactive | unclear | unclear | unclear | — | $0.00 → $0.00 |
| s007 | agent-tooling | $14.65 | unclear | interactive | unclear | unclear | unclear | — | $0.00 → $0.00 |
| s008 | agent-tooling | $10.95 | unclear | interactive | unclear | unclear | unclear | — | $0.00 → $0.00 |
| s009 | product-repo | $10.43 | unclear | interactive | unclear | frontier | unclear | — | $0.00 → $0.00 |

## Arm `jev-C0`

Call outcomes: ok 214

### Where the money sits, and what each class saves

Saving is the stacked floor → ceiling over the sessions in that class (`src/savings.py`).

| axis | class | sessions | spend | % | saving (floor → ceiling) |
|---|---|--:|--:|--:|--:|
| urgency | `unclear` | 214 | $508.80 | 100% | $0.00 → $0.00 |
| latency | `unclear` | 28 | $501.31 | 99% | $0.00 → $0.00 |
| latency | `unattended` | 186 | $7.49 | 1% | $0.00 → $0.00 |
| deferral | `unclear` | 214 | $508.80 | 100% | $0.00 → $0.00 |
| capability | `unclear` | 214 | $508.80 | 100% | $0.00 → $0.00 |
| context | `unclear` | 183 | $508.66 | 100% | $0.00 → $0.00 |
| context | `short` | 31 | $0.14 | 0% | $0.00 → $0.00 |

### What the classes unlock

| lever | sessions | saving | % of spend | label |
|---|--:|--:|--:|---|
| route to mid/small tier | 0 | $0.00 | 0.0% | priced |
| split separable sessions | 0 | $0.00 | 0.0% | guess |
| batch — cache holds | 0 | $0.00 | 0.0% | priced ceiling |
| batch — cache lost | 0 | $0.00 | 0.0% | guess floor |
| all levers, stacked — ceiling |  | $0.00 | 0.0% |  |
| all levers, stacked — floor |  | $0.00 | 0.0% |  |

**Spend, not saving:** 0 sessions are `blocking-now` + `interactive` on Opus — fast mode there would add $0.00. Classification is also how you decide where paying more is right.


### Ten most expensive sessions

| session | kind | cost | urgency | latency | deferral | capability | context | levers | saving (floor → ceiling) |
|---|---|--:|---|---|---|---|---|---|--:|
| s000 | generated-output | $137.49 | unclear | unclear | unclear | unclear | unclear | — | $0.00 → $0.00 |
| s001 | agent-tooling | $136.88 | unclear | unclear | unclear | unclear | unclear | — | $0.00 → $0.00 |
| s002 | agent-tooling | $37.61 | unclear | unclear | unclear | unclear | unclear | — | $0.00 → $0.00 |
| s003 | knowledge-base | $29.16 | unclear | unclear | unclear | unclear | unclear | — | $0.00 → $0.00 |
| s004 | product-repo | $23.96 | unclear | unclear | unclear | unclear | unclear | — | $0.00 → $0.00 |
| s005 | agent-tooling | $16.63 | unclear | unclear | unclear | unclear | unclear | — | $0.00 → $0.00 |
| s006 | agent-tooling | $16.47 | unclear | unclear | unclear | unclear | unclear | — | $0.00 → $0.00 |
| s007 | agent-tooling | $14.65 | unclear | unclear | unclear | unclear | unclear | — | $0.00 → $0.00 |
| s008 | agent-tooling | $10.95 | unclear | unclear | unclear | unclear | unclear | — | $0.00 → $0.00 |
| s009 | product-repo | $10.43 | unclear | unclear | unclear | unclear | unclear | — | $0.00 → $0.00 |

## Arm `hybrid-C0`

### Where the money sits, and what each class saves

Saving is the stacked floor → ceiling over the sessions in that class (`src/savings.py`).

| axis | class | sessions | spend | % | saving (floor → ceiling) |
|---|---|--:|--:|--:|--:|
| urgency | `unclear` | 214 | $508.80 | 100% | -$3.28 → $4.51 |
| latency | `interactive` | 28 | $501.31 | 99% | $0.00 → $0.00 |
| latency | `unattended` | 186 | $7.49 | 1% | -$3.28 → $4.51 |
| deferral | `unclear` | 28 | $501.31 | 99% | $0.00 → $0.00 |
| deferral | `within-hours` | 186 | $7.49 | 1% | -$3.28 → $4.51 |
| capability | `frontier` | 58 | $437.83 | 86% | -$2.80 → $1.89 |
| capability | `unclear` | 17 | $68.27 | 13% | -$0.67 → $0.50 |
| capability | `small` | 139 | $2.71 | 1% | $0.19 → $2.12 |
| context | `continuous` | 2 | $274.37 | 54% | $0.00 → $0.00 |
| context | `unclear` | 23 | $226.25 | 44% | -$1.09 → $1.03 |
| context | `short` | 189 | $8.17 | 2% | -$2.20 → $3.47 |

### What the classes unlock

| lever | sessions | saving | % of spend | label |
|---|--:|--:|--:|---|
| route to mid/small tier | 139 | $1.52 | 0.3% | priced |
| split separable sessions | 0 | $0.00 | 0.0% | guess |
| batch — cache holds | 186 | $2.98 | 0.6% | priced ceiling |
| batch — cache lost | 186 | -$4.81 | -0.9% | guess floor |
| all levers, stacked — ceiling |  | $4.51 | 0.9% |  |
| all levers, stacked — floor |  | -$3.28 | -0.6% |  |

**Spend, not saving:** 0 sessions are `blocking-now` + `interactive` on Opus — fast mode there would add $0.00. Classification is also how you decide where paying more is right.


### Ten most expensive sessions

| session | kind | cost | urgency | latency | deferral | capability | context | levers | saving (floor → ceiling) |
|---|---|--:|---|---|---|---|---|---|--:|
| s000 | generated-output | $137.49 | unclear | interactive | unclear | frontier | continuous | — | $0.00 → $0.00 |
| s001 | agent-tooling | $136.88 | unclear | interactive | unclear | frontier | continuous | — | $0.00 → $0.00 |
| s002 | agent-tooling | $37.61 | unclear | interactive | unclear | frontier | unclear | — | $0.00 → $0.00 |
| s003 | knowledge-base | $29.16 | unclear | interactive | unclear | frontier | unclear | — | $0.00 → $0.00 |
| s004 | product-repo | $23.96 | unclear | interactive | unclear | frontier | unclear | — | $0.00 → $0.00 |
| s005 | agent-tooling | $16.63 | unclear | interactive | unclear | frontier | unclear | — | $0.00 → $0.00 |
| s006 | agent-tooling | $16.47 | unclear | interactive | unclear | unclear | unclear | — | $0.00 → $0.00 |
| s007 | agent-tooling | $14.65 | unclear | interactive | unclear | unclear | unclear | — | $0.00 → $0.00 |
| s008 | agent-tooling | $10.95 | unclear | interactive | unclear | unclear | unclear | — | $0.00 → $0.00 |
| s009 | product-repo | $10.43 | unclear | interactive | unclear | frontier | unclear | — | $0.00 → $0.00 |

## Agreement between arms (answered axes only)

| pair | urgency | latency | deferral | capability | context |
|---|--:|--:|--:|--:|--:|
| rules-C0 vs jev-C0 | — | 1.00 (n=186) | — | — | 1.00 (n=31) |
