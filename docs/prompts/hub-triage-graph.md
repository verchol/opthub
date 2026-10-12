# Prompt — add the session graph to Hub → Triage

Paste everything below the line into Claude Code, started in the **`sandbox/e2b`** checkout (the
repo that holds `hub.mjs` and `lib/hub-page.mjs`). It assumes an opthub checkout on branch
`claude/clever-clarke-7l8f79` ([verchol/opthub#2](https://github.com/verchol/opthub/pull/2)), or `main`
once that is merged. Background: [`docs/session-graph.md`](../session-graph.md) §6.

---

Add a **Graph** view to the Hub's Triage tab, one per session. The graph is already built by
opthub; this repo only has to find it, serve it and link to it. Keep the change small and in the
style of the surrounding code, and don't add dependencies.

## What already exists (in the opthub repo, not this one)

- `tools/sessiongraph.py` (stdlib Python) turns one Claude Code transcript into a graph of tasks.
  Each task is one person's prompt, linked to the models, context, tools, files, command families
  and subagents it used. Output is JSON, stripped of prompt text and absolute paths by default.
  - `python3 tools/sessiongraph.py <session-id-or-prefix> -o <file.json>` writes the JSON.
  - `--root` defaults to `~/.claude/projects`.
  - It exits non-zero with a message when no transcript matches.
- `experiments/session-triage/src/export_hub.py` writes `results/triage.json`, which this Hub
  already reads. It now also writes `results/graphs/<session>.json` and gives every session
  record a `graph` field: that relative path, or `null` when the transcript has expired or
  the session has no id.
- `docs/preview/session-graph/triage-graph.template.html` is a self-contained page: inline CSS
  and JS, Google Fonts only, no build step. It renders a graph once the literal `/*GRAPH*/null`
  is replaced with the graph JSON.
  - It has Classes / Tasks / Graph tabs, a node detail panel, layer toggles, and light and dark
    themes.
  - Inside an iframe, or with `#embed` / `?embed` in the URL, it hides its own mock sidebar so
    the Hub's navigation wins.
  - Its "Triage" breadcrumb calls `history.back()`.

## Do

1. **Locate opthub.** Read the opthub checkout path from an `OPTHUB_DIR` env var, falling back
   to `../opthub` beside this repo. Resolve it once at hub start and log it. If the template
   file is missing, log one clear warning and leave the Graph link disabled. Never crash the hub.

2. **`GET /api/triage/:sid/graph`** in `hub.mjs` returns the graph JSON.
   - Find the session's record in `results/triage.json` and read `results/<record.graph>`.
   - If `graph` is null or the file is missing, fall back to running
     `python3 $OPTHUB_DIR/tools/sessiongraph.py <sid> -o results/graphs/<sid>.json` once,
     with a 20 s timeout and no shell interpolation of `sid`. Cache the file it writes.
   - Validate `sid` against `^[0-9a-f-]{8,36}$` before using it in a path or argv. Return 400
     otherwise.
   - Return 404 with `{ "error": "no transcript for this session (expired or never recorded)" }`
     when the fallback can't produce a file.
   - Never pass `--keep-text`. The Hub only ever serves stripped graphs.

3. **`GET /triage/:sid/graph`** in `hub.mjs` serves the page.
   - Read the template on each request so edits show without a restart. Get the JSON the same
     way as route 2.
   - Replace `/*GRAPH*/null` with `JSON.stringify(graph).replace(/<\//g, '<\\/')`. The escape
     keeps a `</script>` inside a file name from ending the script block early.
   - Serve the result as `text/html; charset=utf-8`.
   - On 404, serve a small HTML page with the same message and a link back to Triage.

4. **Link it from Triage** in `lib/hub-page.mjs`.
   - In the Triage session detail, next to the classes, add a **Graph** button.
   - It opens `/triage/:sid/graph#embed` full width, the same way Sessions → Analytics opens
     from a row (screen 06 in opthub's `docs/screens/INDEX.md`). The graph does not fit the
     narrow detail pane.
   - Disable the button, with a tooltip saying why, only when the record has no session id.
   - A null `graph` is fine, because route 2 can rebuild it from the transcript.
   - If Triage has a per-row actions column, add a small "graph" link there as well.

5. **Tests.** If the repo has `npm test` (it has, e.g. `test/ult.test.mjs`), add checks in the
   existing style:
   - The two routes return 200 for a fixture session.
   - They return 404 for an unknown id and 400 for an id with `../`.
   - The served HTML contains no `/*GRAPH*/null` and parses as one `<script>` block.
   - Use a tiny fixture graph JSON. Don't depend on real transcripts.

## Check before you finish

- Run `npm test`.
- In opthub, run `cd experiments/session-triage && python3 src/export_hub.py --out <this repo>/results/triage.json`.
- Start the hub (`opt hub start` or however it starts here). Open Triage, pick a session that
  ran in the last few days, and click Graph. The page should show tasks along the middle,
  models above, tools and files below, and a detail panel on the right. Clicking a task
  should highlight its connections.
- Switch the Hub to dark mode and check that the graph follows.
- Grep the served HTML for `/Users/`, `/home/` and the session's first prompt. All must be
  absent, because only stripped graphs may reach the Hub.
- Report what you changed (files and routes), the test output, and one screenshot of the Graph
  page. Do not commit secrets from `.env`.
