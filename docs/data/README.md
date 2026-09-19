# Pinned ledgers

| file | run | sessions | total |
|---|---|---|---|
| `e1-sessions.csv` | E1, 2026-08-30 | 215 | $518 |
| `e1b-sessions.csv` | E1b, 2026-09-03 | 214 | $508.80 |

One row per Claude Code session in the window: start time, working directory, entry
point, request count, model mix, median and max context, cost split into cache reads /
writes / output / thinking, and the four per-session lever headrooms (`A_trim25`,
`B_effort50`, `C_ttl5m`, `D_sonnet_ceiling`). Written by `tools/savings.py`; every
figure in `docs/experiments.md` and `SPEC.md` §2 comes from these two files.

**What was removed before publishing.** `savings.py` also emits a `first_prompt`
column — the opening prompt of each session — and absolute working-directory paths.
Both are stripped here: the column is dropped and `/Users/<name>` is rewritten to `~`.
Nothing that is costed or ranked depends on either; the totals are unchanged.

**These files are the run of record, not a live view.** The transcript store they were
built from expires after 30 days (`cleanupPeriodDays` default) and had already deleted
three sessions between E1 and E1b. See `PROGRESS.md` 2026-09-03.
