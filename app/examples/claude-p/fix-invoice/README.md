# fix-invoice

An invoice module with two bugs:

- the discount is a percentage but is applied as a fraction;
- the rounding is not half-up.

Three of the five visible tests fail. The task asks for a fix without touching the tests.

The hidden check (`check.py`) passes only if all of these hold:

- the visible tests are unedited (sha256 pinned);
- the whole suite passes;
- three cases the agent never sees hold.

    opt claude example fix-invoice --repeats 3

## The pinned run (`audited-run/`)

Run `cp-20261020-084341-d9b9`, Opus 5.5 on both sides, 3 runs a side, balanced rung (`--effort medium` and lean rules; no skills):

| | plain `claude -p` | optimize mode |
| --- | --- | --- |
| cost per run (median, list prices) | $0.0930 | $0.0838 (10% less) |
| wall time (median) | 30 s | 22 s |
| turns | 5 | 5 |
| hidden check | 3/3 pass | 3/3 pass |

All 13 claims verified, none failed. See `audited-run/claims.md` for each one with its evidence. Read it with these limits in mind:

- **n = 3 a side, on one small task.** It is a direction for this task, not a promise for yours. Run `opt claude -p "…" --compare --repeats 3` on your own work.
- **The saving came from the profile** (effort and lean rules), not from routing. The gateway kept all 16 requests on Opus. `claude -p` on a task this small makes no side calls it could move.
- **Cost is priced, not billed.** Each side's final token totals (Claude Code's `modelUsage`) at list rates. On the optimized side this matched the gateway's own per-request sum to the cent.

## What earlier runs got wrong, and the check that now catches it

Each of these made an early comparison unfair. Each is now a claim in the audit, so an unfair run fails it instead of passing silently:

| what went wrong | claim that catches it |
| --- | --- |
| The two sides ran different default models: a subscription login vs the API-key look of the gateway. | `same-model` |
| Behind a custom base URL, Claude Code dropped tool search and sent every tool schema on every request (+8k tokens). | `same-client` |
| A placeholder API key on the gateway side gave it a 5-minute prompt cache against the plain side's 1-hour cache. | the gateway side now holds a placeholder subscription token |
| The plain side found this exact task already cached from an earlier run. | `warm`; each comparison also uses its own workspace path |
| Stream-json message usage undercounts output tokens. | both sides are now priced from the final totals |
