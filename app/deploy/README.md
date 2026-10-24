# Deploying the hub

A read-only copy of the Optimization Hub: same page, same URLs, a frozen
snapshot instead of a transcript store, and every run disabled.

## What is deployed

| | |
|---|---|
| **served** | the SPA from `lib/hub-page.mjs`, the snapshot under `/api/*`, 8 run reports, 3 documents, the lever catalog |
| **not served** | transcripts, run logs, `results/` beyond the reports, anything else in `docs/` |
| **not possible** | launching a run — every POST returns 403 and the run button renders disabled |

The snapshot carries each session's opening prompt, its cost and token counts,
artifact filenames and tags. Absolute home paths are rewritten to `~`. It does
**not** carry message bodies: the hub never read them, so there is nothing to
strip. `tools/hub-snapshot.mjs` is the whole of it — 100 lines, worth reading
before a deploy if the audience matters.

## Deploy

```sh
fly auth login                                     # once, interactive
fly launch --no-deploy --copy-config --name opthub-demo
fly secrets set HUB_PASSWORD='something-shared'    # required; no password = open to the internet
./build.sh && fly deploy ./build
```

`build.sh` re-freezes the snapshot from the live store every time, so a deploy
always ships current numbers. To refresh the data without touching the code,
run the same two commands again.

## Costs and scale

`shared-cpu-1x`, 256 MB, `min_machines_running = 0`. The machine suspends when
idle and resumes on the next request, so a demo nobody is watching costs
nothing and a cold hit waits a second or two. The image is ~5 MB of data and
has no dependencies — no `npm install` in the build.

## Refusing to spend

Three separate guards, because one is not enough when the button is right there
on screen:

1. `hub-demo.mjs` answers every POST with 403 and a readable reason.
2. The page renders the run control disabled, with a tooltip saying why.
3. The image carries no E2B or AWS credentials, so a request that got through
   would fail at the SDK.
