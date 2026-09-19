# Optimization Hub — every view

22 screenshots, one per view, captured 2026-09-14 from a live hub on
`127.0.0.1:8899` reading 154 real sessions ($4,588 at list prices). Light theme,
1400px-wide app, sidebar open in every shot so the navigation hierarchy is visible.

Filenames encode the path through the app:
`NN_<section>[-<subtab>]__<state>.jpg`

## The hierarchy

```
Sessions                          01  reports only — never spends
  └ detail (right pane)           02  classification, context window
    └ scrolled                    03  saving potential, per estimate
  ├ watch live (toggle)           04  all 154 kept, STATE column appears
  ├ created-date filter           05  26 of 154 shown
  └ Analytics (per session)       06  four charts, opened from a row
    └ scrolled                    07  where this session ranks
Optimization                          the only section that spends
  ├ Sessions                      08  same list, RUN column added
  │ └ detail                      09  strategy picker + run button
  ├ Catalog                       10  13 strategies, 8 runnable
  │ └ detail                      11  hypothesis, risk, gate, Kong plugin
  └ Runs                          12  9 runs, each with its answer
    └ detail                      13  verdict, plan, how to read it
      └ scrolled                  14  the three runs compared
      └ report.html               16  the artifact a run leaves behind
         ├ radar                  17  six metrics, one outline per run
         ├ what changed           18  parameter diff — flags a no-op run
         ├ raw numbers            19  every metric, per run, with deltas
         ├ delivered              20  files, lines, bytes, tests
         ├ blind score            21  six criteria, identities withheld
         └ caveats                22  n = 1 per run, stated on the page
ROI                               15  artifact value per dollar, ranked
```

## The views

| # | file | view | what it shows |
|---|---|---|---|
| 01 | `01_sessions.jpg` | Sessions | 154 sessions, 2 live, 1 open, $4,586, 44 high-potential. Context, cost, turns, artifacts, potential per row. |
| 02 | `02_sessions__detail-classification.jpg` | Sessions → detail | Session 277953fe: $1,254, 1,205 turns, 124.4h. Five tag groups (work / shape / cost / tools / flag) and the context-window block — 487k median per request, 97.0% cache reuse. |
| 03 | `03_sessions__detail-saving-potential.jpg` | Sessions → detail, scrolled | 49–98% · $617–$1,234 of $1,253.85, each estimate labelled `priced`, `guess` or `detector`. Caching reads "no" because the hit rate is already 97%. |
| 04 | `04_sessions__watch-live.jpg` | Sessions, watch live on | "watching every 2s · 3 running". All 154 sessions stay; a STATE column adds `live` / `open` / `closed`. |
| 05 | `05_sessions__filter-created-date.jpg` | Sessions, date filter | Custom range 2026-09-01 → 2026-09-14: 26 of 154, $3,471.61 shown of $4,587.11. |
| 06 | `06_sessions__analytics.jpg` | Sessions → Analytics | Opened from a row, so it names the session. Context carried per request, cumulative cost, the input mix (cache reads $817.27, 65%), output with thinking split out. |
| 07 | `07_sessions__analytics-rank.jpg` | Analytics, scrolled | Every session by cost with this one marked — rank 1 of 154. |
| 08 | `08_optimization-sessions.jpg` | Optimization → Sessions | The same list plus a RUN column, and the ROI gate: 108 of 154 are below it. |
| 09 | `09_optimization-sessions__detail-run.jpg` | ↳ detail | The strategy dropdown (Auto, or a named one), the run button, the last run's outcome, and "what run does". |
| 10 | `10_optimization-catalog.jpg` | Optimization → Catalog | 13 strategies from `config/optimizations.json`: family, what it changes, runnable vs needs-gateway, and the Kong plugin that owns it. |
| 11 | `11_optimization-catalog__detail-lever.jpg` | ↳ detail | Route to open weights: hypothesis, risk, gate, the run's parameters, the Kong config, and how to run it. |
| 12 | `12_optimization-runs.jpg` | Optimization → Runs | 9 runs. Verdicts include failures — "every run failed (3)", "only 1 of 2 delivered — no comparison", "run died — process gone". |
| 13 | `13_optimization-runs__detail-verdict.jpg` | ↳ detail | optrun-0af9622d: $0.67, 3 runs, verdict, plan, and "how to read this" — why runs are compared with each other, not with the original session. |
| 14 | `14_optimization-runs__detail-runs-compared.jpg` | ↳ detail, scrolled | Baseline $0.38 (BEST) · cheap open-weights $0.0534 · frontier-no-compaction $0.24. |
| 15 | `15_roi.jpg` | ROI | Artifact value per dollar, 1–100, for the 21 sessions that produced a file. |
| 16 | `16_optimization-runs__report-header.jpg` | ↳ report.html | The standalone report a run writes. Same builder the CLI uses. |
| 17 | `17_optimization-runs__report-radar.jpg` | ↳ report | Six metrics at once. Amber `baseline`, teal `exp1 · cheap`, violet `exp2 · no change`; each spoke prints its three real values. |
| 18 | `18_optimization-runs__report-what-changed.jpg` | ↳ report | The parameter diff. `exp2` reads "nothing — identical to baseline", so its gap is called a noise floor rather than a result. |
| 19 | `19_optimization-runs__report-raw-numbers.jpg` | ↳ report | Every metric per run with deltas: quality 54 / 36 / 51, cost −86.0% / −37.5%, turns, tokens, cache. |
| 20 | `20_optimization-runs__report-delivered.jpg` | ↳ report | Files changed, lines, bytes, tests — measured from the diff, not claimed. |
| 21 | `21_optimization-runs__report-blind-score.jpg` | ↳ report | Six criteria out of 60. Winner: baseline by 3 points. The judge saw randomised order and no prices. |
| 22 | `22_optimization-runs__report-caveats.jpg` | ↳ report | "n = 1 per run" and what that does not support, printed on the report itself. |

## Notes on capture

- **Sidebar open in all 22.** `Optimization` expands to its three sub-tabs only while
  that section is active (08–14), and `Analytics` appears as a fourth entry only while
  a session is being analysed (06–07) — the rail is the hierarchy, so both are visible
  where they exist.
- **Two views need scrolling to see whole**, so they get two frames each: the session
  detail pane (02/03) and the analytics column (06/07).
- The app is pinned to 1400px for these shots. Wider than ~1376px is what it takes to
  show sidebar, table and detail pane at once without the table scrolling.
