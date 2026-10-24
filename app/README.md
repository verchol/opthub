# One control, one optimized — a harness experiment rig

Two E2B sandboxes run Claude Code on the **same** task. One is a plain session.
The other adds exactly one optimization strategy. A hidden test suite neither
session can see grades both, and the run ends in a spider chart.

The model is held fixed across arms, so what gets measured is the **harness** —
the part a team actually controls.

```bash
opt demo scenarios                       # what can be run
opt demo run                             # control vs uber-factory (default)
opt demo run --scenarios plan-first      # control vs any scenario
opt demo run --scenarios plan-first --dry   # show both arms, boot nothing, bill nothing
```

Both sandboxes stream side by side while they work — every tool call, every
result, turns and elapsed time per pane:

```
control · regular session                optimized · uber-factory
────────────────────────────────────     ────────────────────────────────────
▸ Read(/home/user/work/SPEC.md)          ▸ Read(/home/user/work/CLAUDE.md)
  · # Task: sheet.py — a mini spread…    ▸ Write(/home/user/work/PLAN.md)
▸ Bash(python3 -c "import sheet")        ▸ Bash(./factory verify)
  · Traceback (most recent call last)      · [PASS] spec-smoke: 25 assertions
 working · 12 turns · 3m04s               working · 7 turns · 3m01s
```

## The principle

| | sandbox 1 | sandbox 2 |
|---|---|---|
| role | **control** — a regular session | **optimized** — control + one strategy |
| flags | `--model <m>` and nothing else | plus whatever the experiment declares |
| workspace | `SPEC.md`, `PROMPT.md` | plus whatever the experiment copies in |
| prompt | `task/BASE_PROMPT.md` | the same, plus the strategy appended |

The control is defined once in `run-demo.mjs` and never varies. **Everything the
experiment does not set stays at the control's value**, so one experiment file =
one independent variable.

## Defining an experiment

One file in `scenarios/`. The minimum is a prompt:

```markdown
---
description: Make the agent state its assumptions before writing code.
---

Before you write any code, list every assumption you are making about SPEC.md
that the spec does not settle. Resolve each one by re-reading the spec, then
implement.
```

Save as `experiments/assumptions.md`, run `node run-demo.mjs assumptions`. Done.

Frontmatter keys, all optional: `description`, `flags` (extra CLI flags),
`files` (copied from `assets/`), `agents` (an asset passed to `--agents`).
Full authoring guide in [`scenarios/README.md`](scenarios/README.md).

### Shipped scenarios

| name | changes | idea |
|---|---|---|
| `medium-effort` | flags | the single cheapest lever, nothing else |
| `plan-first` | prompt | explicit behaviour checklist before any code |
| `batch-checks` | prompt | one scripted check instead of N probes |
| `terse-context` | prompt | explicit context discipline |
| `cheap-reviewer` | flags+files+prompt | a sonnet reviewer gates completion |
| `uber-factory` | flags+files+prompt | the full stack (default) |

`uber-factory` maps the levers in
[Uber's *Efficient Software Factory*](https://www.uber.com/us/en/blog/efficient-software-factory/):
medium effort by default, subagent model downgrade, code-mode batching, CLI
resolution instead of tool-schema preload, grounded repo context, a uReview-style
reviewer, compaction at 400K, cache-friendly prompt construction.

## Running an experiment against a real session — the hub

`scenarios/` experiments run against a fixed benchmark task. The hub runs the
same idea against **a session you actually had**: it ships that session's own
working directory into a sandbox, replays its request under one changed
parameter, and judges what came out.

    opt hub start          # → http://127.0.0.1:8899/

The mark in the rail and the browser tab ([`lib/icon.mjs`](lib/icon.mjs)) is two
arrows of deliberately unequal length: a short muted one falling — what the work
costs — and a taller accented one rising, which is what you got for it. Less for
more. Reversed, it would say the opposite, so the proportions carry the meaning
rather than decorating it.

Rail on the left, list in the middle, the selected item on the right.

The page is a React app in [`web/`](web/) (Vite, TypeScript, Tailwind with
shadcn/ui; the Analytics → Similar graph is drawn with React Flow). The hub
serves the built copy from `web/dist`, so build it once after a checkout and
again after changing anything under `web/`:

    npm run build:web      # web/dist — the hub answers with a "not built" page until this has run
    npm run dev:web        # hot reload on :5173, proxying /api to a hub on :8899 (HUB_URL to change)

The hub's API is unchanged; `lib/web-dist.mjs` serves the page for both
`hub.mjs` and the read-only `hub-demo.mjs`. Packaging (`packaging/make-dist.sh`,
`deploy/build.sh`) builds the page and ships `web/dist` only, never its
`node_modules`. The pre-React page is still at `/classic` on this branch, for
side-by-side checks.

## Watching what is running — `opt session --watch`

    opt session --watch                # everything, live ones first, redrawn in place
    opt session --watch --live         # only what is live or still open
    opt session --watch --since 7d     # by creation date: 7d, 48h, 90m, today, yesterday
    opt session --watch --on 2026-09-01            # one calendar day
    opt session --watch --since 2026-09-01..09-05  # an inclusive range
    opt session --watch --once         # print once instead of following

`opt watch` still runs; it is deprecated and says so.

```
  opt session --watch  15:50:27   live 2  open 1  idle 0  closed 151
  2 claude process(es): ~/workspace/demos/newyear2026, ~/workspace/demos/opthub

  STATUS   SESSION   LAST    COST   TURNS  CONTEXT  INTENT
  LIVE     e0c2b950     3s   $549.05    643     379k  check why "optimize" didn' work…
  LIVE     2dff77c8     1m     $1.90     11      45k  after completion commit to git…
  OPEN     60c41087   4.7h    $22.11     44      78k  why hebrew prompt is shown wrong…
```

The same thing is in the hub behind the **watch live** button in the Sessions
filter bar. It is a polling switch, not a filter: **the whole list stays**, and
the hub re-reads the transcripts every 2s instead of every 8-30s, so a session
going live — or a brand new one — appears as it happens and its turns and cost
move while you watch. Running rows get a coloured left rail (teal for live,
amber for still-open) and a **State** column, so they stay findable among a
hundred and fifty closed ones. It composes with the date filter.

### Filtering by creation date

Next to it, a date filter — `created today`, `yesterday`, `last 7 days`,
`last 30 days`, or a custom range with two date pickers. It filters on
`startedAt`, and that choice matters: **when a session was created is not when
it last wrote.** A resumed session can be four days old and still going, so it
appears under the day it began, not today. The summary line names the window in
force and shows the cost of what is on screen against the whole store
(`18 of 154 · $2635.64 shown of $3834.11 · created in the last 7 days`).

The same grammar is shared by the CLI and the hub, in
[`lib/daterange.mjs`](lib/daterange.mjs): `today`, `yesterday`, `7d`, `48h`,
`90m`, `2w`, `2026-09-01`, `2026-09-01..2026-09-05`, `..2026-09-05`.

### How it knows, and what it cannot know

Claude Code appends to a transcript and closes it again, so `lsof` on the file
tells you nothing — it is never held open. Two signals do work, and the status
says which one it is standing on:

| status | evidence |
|---|---|
| `live` | wrote to its transcript in the last 90 seconds — producing right now |
| `open` | a `claude` process is running in that directory, and this is its newest session: on screen, waiting on the human |
| `idle` | wrote in the last 30 minutes, but nothing is running there any more |
| `closed` | neither |

The honest limit: two sessions in one directory share a cwd, so `open` goes to
the newest transcript there. It can be wrong about *which* of two sibling
sessions is the one on screen; it is not wrong that one of them is.
`lib/watch.mjs` is the whole rule set.

**Sessions** reports; it does not spend — no run column, no run controls. Every
row carries its median context per request and an estimated optimization
potential, and opening one shows the context window in full — median, peak,
cache reuse, thinking share — plus which levers that session's own numbers point
at. Runs live entirely under Optimization.

The estimate distinguishes three things, and labels each one in place:

| label | means |
|---|---|
| `priced` | this session's own token counts re-priced at another model's published rate. Arithmetic, not a prediction — a cheaper model usually needs more tokens, so it is a ceiling nobody reaches. |
| `guess` | a range with a stated basis and no measurement behind it. A prompt to run the experiment, nothing more. |
| `detector` | measured, and it says no. A 96.8% prompt-cache hit rate means a cache has nothing left to catch. |

A session is also rated against an **ROI gate**: if the best case saves less than
the ~$1 of sandbox time it takes to measure, it reads `below gate` rather than a
percentage, because the experiment would cost more than the win.

**Optimization** is where runs are launched. Its three views nest under it in
the sidebar:

Arms are named `baseline`, `exp1`, `exp2` …, each variant tagged with the one
phrase naming what it varies (`cheap`, `compaction`, `effort`) — derived from the
arm's parameters, not from the label a model wrote for it. An arm whose
parameters match the baseline is flagged in the report as varying nothing, so a
grid that accidentally proposes a duplicate reports a noise floor instead of a
finding.

* **Sessions** — the same list, but the detail pane has the controls. Choose
  from one dropdown: **Auto** asks a model to propose a model/compaction grid
  (with a control arm prepended) and is the right answer when you do not yet
  know which lever to pull; below it are the named levers, ★-marked where the
  session's own numbers point, each running against its own baseline arm so the
  delta is attributable to one variable.
* **Catalog** — the levers themselves, out of [`config/optimizations.json`](config/optimizations.json).
* **Runs** — everything launched, live or finished. A run appears here the
  instant it is asked for and streams its phase; the log is at
  `/optlog?session=<id>`.

Opening a session also shows its **classification** — not one `kind` guess but a
grouped set of tags, each carrying on hover the measurement that produced it:

| group | examples |
|---|---|
| work | `code` `shipped` `no-artifact` `planned` |
| shape | `marathon` `one-shot` `resumed` `mega-context` `compacted` `live` |
| cost | `top-spend` `cheap` `cache-saturated` `cache-cold` `heavy-thinking` `opus` |
| tools | `write-heavy` `search-heavy` `shell-heavy` `web` `subagents` `mcp` `no-tools` |
| flag | `secrets-in-transcript` `long-and-empty` |

There is also a `festive` group with exactly one member. Around Rosh Hashanah a
particular request turns up — *make me a New Year card with pomegranates* — and
this agent cannot draw it: Claude Code writes files, it does not generate
images. So the session always ends the same way, some turns of the model
explaining that and then offering to hand-author an SVG of a pomegranate. The
`shana-tova` detector prices the explanation, in dollars per greeting card and
in pomegranates you could have bought instead. It needs a New Year greeting
*and* an image ask before it fires, so wishing the team `shana tova` in a normal
session costs you nothing. Test any prompt against it:

    node lib/shana-tova.mjs "draw me a shana tova card with pomegranates"

Only `kind` is inferred from wording, and it says so. Everything else is counted:
`cache-saturated` means a measured 95%+ hit rate, `long-and-empty` means forty
turns and no file written. `lib/tags.mjs` is the whole rule set.

**Analytics** is opened from a session — the chart button on any row, or from
the detail pane — never from the sidebar, so it always says which session it is
about. It reads the real per-turn series off the
transcript — context carried per request, cumulative cost, the priced input mix
(cache reads vs writes vs fresh), output with the thinking share separated, and
where the session ranks among all of them. The detail pane closes with `×` and
comes back with the `‹` at the top right; the sidebar does the same with `«`.

### The report

Its contract is written down in [`docs/report-spec.md`](docs/report-spec.md): the
arm naming, the eight blocks in order, and the five rules a report may not break.

`results/<run>/` gets `run.json` and `report.html` — and the HTML is produced by
the same `buildHtml` in [`report.mjs`](report.mjs) that `opt demo run` calls, from
`run.json` written in the same schema. A replay report and a benchmark report are
the same document: the six-axis radar, the raw-numbers table with per-metric
deltas, what each arm was given, what it delivered.

The one real difference is grading. A benchmark run has a hidden suite and
reports 52/69. A replay has no suite, so it carries `grade.kind: "artifacts"` and
is graded by a blind six-criterion rubric — arms presented in randomised order
with their identities withheld — scoring out of 60 exactly as the document judge
does. `report.mjs` reads that flag to swap the correctness row for the rubric and
the measures table for the delivered-files one.

**Arms are compared against each other, never against the original session.** A
replay reaches an answer in a handful of turns where the real session took
hundreds, so any "× cheaper than the original" would be measuring the replay's
incompleteness. The original cost is shown as context and labelled as such.

### The lever catalog

`config/optimizations.json` is the parameter surface, taken from Kong AI
Gateway's AI plugins because Kong has already enumerated what an LLM gateway can
tune. Eight entries are runnable from the client. Four are not — semantic
caching, token rate limiting, response scoring and sanitising all need something
sitting *in* the request path — and those carry the Kong plugin and parameters
that would enable them rather than being left out. They become runnable in the
[`sandbox/e2b/kong`](../sandbox/e2b/kong/README.md) sandbox.

| id | family | runnable | Kong plugin |
|---|---|---|---|
| `route-cheaper-frontier` | model-routing | yes | `ai-proxy-advanced` |
| `route-open-weights` | model-routing | yes | `ai-proxy-advanced` |
| `route-open-weights-small` | model-routing | yes | `ai-proxy-advanced` |
| `context-compaction` | context-lifecycle | yes | — (client-owned state) |
| `compaction-plus-cheap-model` | context-lifecycle | yes | — |
| `effort-medium` / `effort-low` | effort-tuning | yes | — |
| `terse-context` | prompt-compression | yes (approximation) | `ai-prompt-compressor` |
| `semantic-cache` | caching | needs gateway | `ai-semantic-cache` |
| `token-rate-limit` | governance | needs gateway | `ai-rate-limiting-advanced` |
| `gateway-judge` | measurement | needs gateway | `ai-llm-as-judge` |
| `sanitize` | safety | needs gateway | `ai-sanitizer` |

## Templates

| dir | what runs inside |
|---|---|
| `sandbox/e2b/harness/` | Claude Code + LiteLLM + headroom — the A/B arms |
| `sandbox/e2b/openmodel/` | Ollama + an open-weights model, served locally |
| `sandbox/e2b/kong/` | Kong AI Gateway in front of Bedrock, Claude Code pointed at it |

`sandbox/e2b/kong/optimization-params.yaml` is the written spec of the whole
parameter surface: every knob, its default, its range, and what it trades
against — including a `not_available_at_the_gateway` section, because the split
between what a gateway can do and what only the client can do is the useful part.

## Exporting a session into a sandbox

A session in `opt session` is a record of something that already happened.
Exporting it produces a bundle that can happen again, somewhere clean:

```bash
opt session export 3            # write exports/<ref>/
opt replay 3 --runner anthropic # …and run it in a sandbox (was: export --run, deprecated)
```

```
exports/<ref>/
  manifest.json   what this session was, and how faithful the export is
  PROMPT.md       what the agent is asked to do
  SPEC.md         the task spec, for an arm that had one
  workspace/      files the session produced
  run.sh          the exact claude invocation
```

**Fidelity is stated, not assumed.** The manifest carries one of two values,
because the two kinds of session are not equally recoverable:

| | | |
|---|---|---|
| `replay` | e2b arm | every input is still on disk — task spec, prompt, flags, scenario setup. Re-running it is the same experiment. |
| `restart` | local session | the prompts the user typed, the files written through Write/Edit, and the project's `CLAUDE.md`. What the session *read*, and anything Bash wrote, a transcript cannot prove. The prompt survives; the machine does not. |

An arm export is also marked `gradeable` when its task still has a hidden suite,
which is what makes tuning meaningful: there is a number to move.

## The experiment: local session → sandbox → open weights

One task, run twice: once by Claude on this machine, once by an open-weights
model inside a sandbox, graded by the same hidden suite.

```bash
opt replay --new --task mini --runner openmodel
```

Three steps, one command:

1. **Start a local session.** `claude -p` runs the task in a throwaway workspace
   under `local-sessions/<id>/`, using the local CLI's own credential — which is
   separate from whatever `.env` holds. It is a real session: persistence stays
   on, so `opt session` sees it afterwards like any other.
2. **Export it.** The bundle carries the task spec, so `manifest.fidelity` is
   `task-replay` and `gradeable` is true — both sides answer the same questions.
3. **Replay it remotely.** A sandbox boots from the `openmodel-bench` template,
   brings up the model, and runs Claude Code against it.

An existing session replays the same way without step 1:

```bash
opt replay 3 --runner openmodel-bedrock
```

### Runners — what answers Claude Code

`ANTHROPIC_BASE_URL` is the whole trick. Claude Code speaks the Anthropic wire
format; LiteLLM serves that format in front of something else; Claude Code cannot
tell the difference.

| runner | model | where inference happens | billed |
|---|---|---|---|
| `anthropic` | Claude | Anthropic API | credits or subscription |
| `openmodel` | qwen2.5-coder:3b | **inside the sandbox** — Ollama + LiteLLM | nothing — sandbox seconds only |
| `openmodel-bedrock` | Qwen3-Coder-480B | AWS Bedrock, fronted by LiteLLM | AWS |

`openmodel` needs no Anthropic credential at all, which makes it the one runner
that still works when the API key is out of credit.

### Two things the plumbing needs, and why

Both were found the hard way, and both are handled in `runners.mjs`:

* **Ollama defaults a model's context to 2048 tokens.** Claude Code's system
  prompt and tool schemas are several times that, so the stock model cannot hold
  a single turn. The runner rebuilds it from a `Modelfile` with a real window
  before anything else runs.
* **Claude Code asks for thinking; qwen has none.** The request fails with
  `"openmodel-ctx" does not support thinking` at the Ollama layer. LiteLLM's
  `additional_drop_params` removes the parameter, and `MAX_THINKING_TOKENS=0`
  stops it being asked for.

### What the local open model is actually good for

Measured in the sandbox: **8.5 tokens/second** generating, ~29 tok/s reading
prompt, on 4 CPU cores. Every tool schema is prompt the model re-reads each turn,
so the runner narrows the surface to `Bash Read Write Edit` — but a turn still
costs minutes, and a real task costs hours.

That makes `openmodel` a plumbing path, not a performance one: it proves the
whole chain end to end for nothing, on a small task like `mini`. For open weights
that can actually finish work, use `openmodel-bedrock`.

On the `regex` task, Qwen3-Coder-480B reached **65/69** against the 30B
sibling's **11/69** — a wide gap between two open models of the same family. Read
the 65 as a floor rather than a finish, though: that arm ended on
`400 BedrockException … This model's maximum context`, so it was cut off at 28
turns rather than deciding it was done. The 30B arm did finish, printing `DONE`
after 27 turns, and still scored 11.

## Tuning a configuration — `opt tune`

The rig compares two arms a human wrote. `opt tune` closes that loop: it runs
several configurations of the same task, grades them the same way, and asks
Claude to read the results and propose the next set.

```bash
opt tune exports/13_25_27·control        # 2 generations x 3 candidates
opt tune 3 -g 3 -n 4 --budget 4          # a session ref exports itself first
```

Each round is a generation — N sandboxes in parallel, a judgement, then a new
set of candidates informed by what the last one showed:

```
generation 1   baseline + candidates proposed cold
judge          why did this win — signal, or variance?
generation 2   candidates informed by generation 1
```

Two things keep this from being a slot machine:

**The reasoner may only move knobs that exist.** `SEARCH_SPACE` in `tune.mjs` is
the declared list — model, effort, autocompact, dynamic-system-prompt exclusion,
setting sources, tool surface, subagents, appended system prompt, and the task
prompt itself. Every entry is a real Claude Code lever (`claude --help` is the
source of truth). The proposal is schema-checked against that list, because a
flag Claude Code rejects produces a candidate that teaches nothing.

**n = 1 per candidate.** The reasoner is told the sample size and asked to say
when a gap sits inside the noise rather than to crown a winner regardless. On a
single run, a difference under roughly 15% in cost or turns is not
distinguishable from run-to-run variance. `--repeats` exists; it costs linearly.

Results land in `tuning/<id>/tuning.json` — every generation, every candidate's
configuration and rationale, and the reasoner's reading of each round.

## Monitoring — LangSmith project `sandboxes`

Every sandbox run traces to LangSmith whenever `LANGSMITH_API_KEY` is set:

```
run <scenario> · <task>          chain
  arm control                    chain
    sandbox created              tool
    install claude-code          tool
    scenario setup               tool
    agent                        llm    ← tokens, cost, model
    grade                        tool
  arm <scenario>                 chain
```

`opt tune` nests one level deeper — `tune → generation N → candidate → agent` —
with the reasoner's own call as an `llm` span carrying its verdict, so the
reasoning that chose a configuration sits next to the runs that tested it.

`SANDBOX_TRACING=0` turns it off; `SANDBOX_LANGSMITH_PROJECT` renames the
project. Tracing is best-effort by construction: a tracing backend that can take
a run down is worse than no tracing, so every call swallows its own errors and
the harness never waits on one.

It earns its place the first time a run fails for a reason the terminal doesn't
show. The first bundle run in a sandbox came back `1 turn, $0.0000, 17.8s` — the
trace said why: **`Credit balance is too low`**, recorded on the `agent` span.

### Auth, and running out of credit

Two modes, and the choice matters once a key runs dry:

| mode | how | bills |
|---|---|---|
| API key | `ANTHROPIC_API_KEY` | API credits |
| subscription | `CLAUDE_CODE_OAUTH_TOKEN` | your Claude subscription |

Neither is permanent, and both fail the same quiet way: the agent exits
*successfully* after one turn having done nothing. Three guards cover that:

* **Preflight.** `opt session export --run` and `opt tune` ask the API one
  4-token question before booting anything, so a dead credential costs one
  request instead of N sandbox boots:

  ```
  ✗ nothing can run (API key)
  Your credit balance is too low to access the Anthropic API…
  top up at console.anthropic.com/settings/billing, or run with
  AUTH_MODE=subscription to bill your Claude subscription instead
  no sandbox was booted, nothing was billed
  ```

* **In-sandbox retry.** If a key runs dry mid-flight, the run retries on the
  subscription **in the same sandbox** — a command, not another boot — and says
  so. `AUTH_MODE=subscription` forces the token from the start.

* **The trace.** `Credit balance is too low` and `401 OAuth access token is
  invalid` both land on the `agent` span in LangSmith, which is where a run that
  looks merely fast turns out to be a run that never happened.

A subscription token cannot be validated from the host — only Claude Code knows
how to present it — so the preflight reports it as unverified rather than
claiming it is good. When the agent answers `401 OAuth access token is invalid`,
the token has expired; `node auth.mjs` mints a new one.

## Monitoring your own Claude Code — `opt monitor` and Analytics → Behaviour

Two streams describe how a Claude Code session runs, and the hub reads both:

```
Claude Code ── OTLP http/json ──▶ opt collector (127.0.0.1:4320, inside the hub) ──▶ OPT_HOME/otel/<day>.ndjson
            └─ langsmith-tracing plugin ──▶ LangSmith (cloud, or self-hosted via LANGSMITH_ENDPOINT)
                                                   │
hub /api/behaviour ◀── reads both, one session = a list of turns ◀┘
```

    opt monitor on        # Claude Code's OTEL settings into ~/.claude/settings.json (backed up first)
    opt monitor status    # settings, collector, the LangSmith plugin, what has arrived
    opt monitor off       # puts back exactly what `on` changed
    opt monitor collect   # the receiver alone, when the hub is not running

`on` turns on metrics, events and Claude Code's beta spans (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`),
over `http/json` to the local collector; `--endpoint URL` sends them to any other OTLP collector
instead. The `OTEL_LOG_*` gates stay off, so no prompt text, tool input or file content is exported.
Only new Claude Code sessions pick the settings up. `--langsmith-endpoint URL` points the tracing
plugin at a self-hosted LangSmith; LangChain only licenses that as part of an Enterprise plan,
so there is no free local LangSmith.

**Analytics → Behaviour** turns either source into the same numbers, per session and across them:

* **Claude working vs you idle.** A turn runs from prompt to Claude's last word. Idle is the time
  from one turn's end to the next prompt. Gaps over 30 minutes count as breaks, not idle.
* **Cold cache restarts.** A turn whose first model call wrote more prompt cache than it read.
  After a gap past the cache's 5-minute life, that re-write is what the idle cost. It is **priced**:
  the write at 1.25x input minus the read at 0.1x it would otherwise have been.
* **Interrupts.** LangSmith records "User interrupt" when you press Esc.
* **Waiting on you.** Permission prompts (OTEL `tool.blocked_on_user`) and the time Claude spent
  on `AskUserQuestion` / `ExitPlanMode`.
* **Tool latency and errors** (p50 / p95), **gap histogram**, **weekday × hour heatmap**, and a
  strip per session showing each turn's length.
* **From OTEL only:**
  * active time, you vs Claude
  * permission decisions by source
  * API errors by status, and retries
  * time to first token
  * compactions
  * lines changed

A session traced by both sources is read from OTEL. LangSmith runs are read with names, times, token
counts and statuses only (v2 query, cached a minute); prompts never come back. The plugin itself does
send prompts and tool results to LangSmith; `opt monitor status` says so when it is on.

## Optimize mode: `opt claude -p`

`opt claude -p "<task>"` runs Claude Code headless, the same as `claude -p`, but in optimize mode:

- **Sandbox.** The local Docker sandbox: a read-only source tree, a copy to work in, and an egress allowlist.
- **Gateway.** LLM Ultra Light, provisioned per run in its own container in route mode. It classifies every request and moves side calls to a cheaper or local model. It holds your credential; the agent holds a placeholder of the same kind, so Claude Code behaves exactly as it does with your login.
- **Profile.** The project's rung on a ladder (`lib/claude-profile.mjs`):

  | rung | adds |
  | --- | --- |
  | guarded | lean working rules |
  | balanced | + `--effort medium` |
  | aggressive | + `--effort low`, subagents on Haiku |

  Every compared run moves it: two kept comparisons step it up, one dropped comparison steps it down. `opt claude profile` shows where a project is and why.
- **Skills.** The project's `.opthub/skills` are attached, plus any `--skill` (opt's own: `--skill opt-lean`).

```
opt claude example [name] [--repeats 3]     the repo's example (examples/claude-p/), plain and optimized, audited
opt claude -p "…" --compare [--check f]     your task both ways; the check runs outside the agent's view
opt claude runs · audit [run] · profile     history, re-audit from files, the profile ladder
opt models                                  Anthropic, local Ollama (live), Hugging Face cache (listed)
```

`--compare` runs plain `claude -p` beside it on the same model and the same kind of credential. Each side gets a one-turn cache warm-up first, and each comparison gets its own workspace path, so neither side starts with the prompt cached from an earlier run. Then `lib/claims.mjs` audits every claim against the files the run left:

- the same input, model, client (tools and version) and warm start on both sides;
- the cost, re-priced from Claude Code's final token totals and cross-checked against the gateway's log;
- the hidden check;
- every request through the gateway, with its hash chain intact;
- the placeholder key inside the agent, proven by a hash taken in the container;
- the profile and skills actually loaded;
- no prompt text in any log.

A run that fails any claim is not counted as proof: `opt claude runs`, the hub's Overview and the audit all re-derive this from the files every time. `examples/claude-p/fix-invoice/` holds the pinned audited run and the list of mistakes the audit now catches.

The hub opens on **Overview**: 30-day spend and where it went, the optimization opportunities ranked by worst-case saving (each labelled measured, priced or guess), and the runs measured on this machine with their audits. **Optimize → Models** lists every model the gateway can use, with the local ones read live from Ollama.

### A synthetic company for demos: `opt hub demo`

`opt hub demo` starts the hub on Tallyfox, a fictional AI-native startup. It is built by `tools/demo-startup.mjs` from one seed into `~/.opthub/demo/tallyfox`, and covers five months of Claude Code use as the team grows:

- June to August: spend climbs.
- 1 September: opt arrives, and Triage classifies the July and August sessions (Jev's classes, each method priced).
- September: six experiments are judged blind.
- From 15 September: optimize mode rolls out, and spend per session falls.
- Six `opt claude -p --compare` runs are audited. Five pass every claim; one fails its hidden check and moves its project down a rung.

Everything is generated. The shapes are calibrated on the stripped opthub ledger (`docs/data/e1b-sessions.csv`), but no file comes from a real session. The hub runs with its own `OPT_HOME`, its own transcripts and LangSmith off. The pages carry no "synthetic" label by default; `--banner` adds one to every page, for a recording or a screenshot that may travel. The data folder always holds `SYNTHETIC.md`. `--rebuild` regenerates it; the build refuses to replace any folder it did not make.

## Is everything up? — `opt init`

The command to run when something is wrong and you do not yet know what, or when
you come back to the project after a week away:

```bash
opt init                 # everything, with the 12 most recent sessions
opt init --sessions 40   # more of them
```

It checks each dependency in turn and says which ones answer:

* **credentials** — which resolve, from where (`.env`, environment, 1Password
  reference), and whether they are *live*. The Anthropic key gets one 4-token
  request, because an exhausted key otherwise fails silently inside a sandbox
  fifteen minutes later. A subscription token cannot be validated from the host,
  and the report says so rather than implying it is good.
* **E2B** — every template with its size, build status and spawn count, plus
  anything running right now (which is money burning, so it is flagged).
* **LangSmith** — the project, its trace count, when it last received a run, and
  the link.
* **model runners** — each one marked usable or not, with the specific reason:
  a missing credential, an unbuilt template, absent AWS keys.
* **tasks and scenarios** — what exists, and which tasks have a hidden suite.
* **sessions** — *every* session on disk, read and summarised: the models that
  ran, median and largest context peak, the tools most reached for, and the
  API-list-equivalent spend. Then a table of the most recent ones with each
  session's model, context peak against its window, and top tools.

It ends with a verdict — `up — 3 runner(s) usable: anthropic, openmodel,
openmodel-bedrock`, or the specific thing to fix first.

It boots nothing. `opt doctor` and `opt setup` are aliases.

## Watching a run — `opt experiments`

Everything about runs lives under one verb:

```bash
opt experiments              # every run, live or finished
opt experiments ui           # baseline → optimized, what moved, how to apply it
opt experiments results      # the written comparison, plus the levers to copy
opt experiments ps · status [ui] · logs <runId> · open <runId> · kill <runId|all>
```

The old top-level forms (`opt ls`, `opt status`, `opt kill` …) still run, but are deprecated: each prints
the `opt experiments …` form it moved to.

### `opt experiments ui`

One row per run, sortable on every column: the strategy in words rather than a
filename, the inputs each arm was given, the score, the cost delta, and a verdict.
Improved numbers are green, degraded ones red. Click a row and the sheet opens
over the table with four things:

**baseline → optimized.** The two arms named by their role, with the run's own
arm ids as subtitles. Parameters here are strictly *inputs* — the model, the
prompt size, the prompt complexity, and the shared spec. What each arm *did*
with them belongs in the metrics, not here.

The model shown is the one that actually answered. When a scenario points Claude
Code at a proxy, `--model opus` is only the name on the request, so the view
reads the proxy's own config and reports `qwen.qwen3-coder-480b-a35b-v1:0 (via
proxy)` instead.

**what moved.** Every metric with baseline, optimized, delta and a verdict —
correctness, cost, tokens, turns, wall time, cache reuse. Correctness is the only
one where more is better; the rest are costs.

An arm that errored spends less because it did less, so a run where either arm
failed reports its numbers with **no verdict at all** rather than a flattering
one. A harness-level fatal *after* an arm was graded does not void the
comparison — only an agent error, or a missing grade, does.

**how to apply this.** The levers as things you can paste: CLI flags, env,
workspace files, subagents, the appended prompt, setup and background services —
each with a copy button and a line on what it does.

**produced artifacts.** What each arm actually left behind, with line counts,
pulled back from its sandbox.

## Watching a run — the single-purpose views

```bash
opt experiments ls     # every run, live or finished (--session <id> for one session)
opt experiments ps     # only what is live in E2B right now
opt experiments status [runId]   # evidence + a judgement: progressing or stuck?
opt session            # last 48h, e2b arms + this machine's own sessions
opt session --since 7d # widen the window (--all for everything)
opt session --e2b      # one kind only (--local for this machine)
opt session --sort cost # order by a column (-cost to reverse)
opt session <#>        # one session's context window, the way /context draws it
opt session ui         # the same table in a browser, click a row
opt experiments logs <runId>       # what each arm's agent has written
opt experiments kill <runId|all>   # stop sandboxes
```

`opt experiments status` collects hard evidence — heartbeat age, sandbox liveness, CPU and
memory, workspace contents, whether `sheet.py` exists yet, files touched in the
last three minutes, stderr tails — then asks Claude (sonnet, a fraction of a
cent) to judge whether the run is progressing or wedged, and what to do.

### `opt session` — the sessions, not the runs

`opt experiments ls` is organised by run; `opt session` is organised by **session** — one
Claude Code process, wherever it ran. Two kinds land in the same table:

| `SRC` | what it is | where it comes from |
|---|---|---|
| `e2b` | one arm of one run, in a sandbox | `results/<runId>/<arm>/` |
| `local` | a session on this machine | `~/.claude/projects/*/*.jsonl` |

That matters because an experiment costs more than its arms. The sandbox runs
are the measurement; the local session that wrote the harness, debugged the
proxy and read the results is the *other* half of the bill, and it is usually
the larger one. A rig that prices only its own arms is measuring the cheap part.

The session is the unit an experiment compares, so it is the unit worth pricing:

```
#   SRC    SESSION            WHERE      INTENT                      STATE          DUR TURNS  TOKENS     COST  ARTIFACTS
1   e2b    13:25:27·control   e2b/regex  control baseline — stock…   done 69/69   5m46s     7  308.2k    $1.07  agent-tests.txt rex.py
2   e2b    13:25:27·headroom  e2b/regex  Route the agent through…    done 69/69   5m47s     6  184.2k  $0.9696  agent-tests.txt rex.py
9   local  368fe0a1           e2b        please see if you can run…  done         4m45s    16  716.0k    $1.17  —
```

`opt session <#>` then reconstructs that session's **context window** — the same
picture `/context` draws inside Claude Code, rebuilt from the arm's
`stream.jsonl`. Every assistant message reports the tokens its request carried,
so summing them says exactly how full the window was at that moment:

* **prefix** — the first request's input: system prompt, tool schemas,
  `CLAUDE.md`, the task spec. Sent once, cached thereafter.
* **messages** — everything the prefix grew by: conversation and tool results.
* **free space** — the rest of the model's window.

Those three are exact; they come from the API's own token counts. What is *not*
recoverable from the outside is the split inside the prefix — system prompt vs
tools vs memory. Only Claude Code itself can name that, and the view says so
rather than inventing a number.

Walking the series also surfaces **compactions**: the points where the total
fell off a cliff because the thread was summarised and restarted. For a rig
whose whole subject is context discipline, that is the signal — a control arm
that peaked at 9.9% of a 1M window never compacted at all, and the strategy
meant to save it had nothing to save.

`opt session ui` serves the same table in the browser. Clicking a row opens its
context window as a **sheet over the table** — not below it, because a detail
panel you have to scroll to is a detail panel you do not read. `↑↓` moves
between sessions with the sheet open, `Enter` opens the selected one, `Esc` or a
click outside closes it, and the corner shows `4 / 15` so you know where you
are. Chips switch both the window and the source.

**Sorting.** Click any column header to order by it; click again to reverse.
Numeric columns open high-to-low, text columns A-to-Z, and missing values sink
to the bottom either way — an errored arm with no token count does not lead an
ascending sort. `#` keeps its recency identity through every sort, so a row's
number is a stable handle for `opt session <#>` rather than a position. The
selected row follows the session across a re-sort, not the slot it was in.
`--sort <column>` does the same on the terminal side, `-cost` to reverse.

### Which tools and skills a session actually reached for

Every session summary carries a **tools** block — one tag per tool with its call
count, biggest first, the top one picked out:

```
TOOLS & SKILLS  28 calls · 9 kinds · 1 skill
   Bash·13  chrome/computer·4  chrome/navigate·4  chrome/read_network_requests·2
   chrome/get_page_text·1  chrome/tabs_close_mcp·1  /claude-in-chrome·1  ToolSearch·1
```

Names collapse to the readable half and the prefix says what a thing is:
`/claude-api` is a skill, `@Explore` a subagent, `chrome/computer` an MCP tool
(from `mcp__claude-in-chrome__computer`, full name on hover), everything else a
built-in. `Skill` and `Task` are recorded *by name* rather than as themselves —
knowing a session called `Skill` twelve times says nothing; knowing it ran
`/artifact-design` says what it was doing. Subagent calls are counted and
labelled separately rather than folded in silently.

This is the shape of a session at a glance, and the arms make the point better
than prose: the `11:54:42` control ran **42 Bash calls** to reach 69/69 for
$3.61, while `13:25:27` reached the same 69/69 in **6 calls** — Write, Write,
Bash, Edit, Bash, Read — for $1.07. Same task, same model, same prompt. The tool
histogram is where that difference is visible; the token totals only tell you it
happened.

### What the local half cannot tell you

Local transcripts are the same record stream, so tokens, cost and the context
window all reconstruct the same way. Four things do not survive the trip, and
the views say so rather than papering over them:

* **Cost is API-list equivalent, not a bill.** Subscription traffic is not
  billed per token. It is the right unit for sizing an optimization, the wrong
  unit for reading as money owed.
* **`DUR` is span, first record to last** — not time spent working. A session
  resumed across days spans days. Spans overlap in wall-clock, so the totals row
  deliberately omits a duration sum.
* **The context window size is not recorded.** It is inferred from the smallest
  standard size the peak fits in, which is only decisive above 200K. Below that
  the panel prints both readings and how to pin it: `--window 1m`.

A reported window is not believed over the tokens, either. An arm running behind
the Headroom proxy reported a 200,000 window while carrying 322,058 tokens —
Claude Code cannot see which variant a proxy is really talking to, so it fell
back to the default. The view rejects the impossible figure, uses the next
standard size up, and says it did rather than drawing a bar at 161%.
* **Artifacts count Write/Edit writes only.** A file written through Bash — a
  heredoc, a script — leaves no tool record, so `—` means "nothing written
  through a file tool", not "produced nothing".

Sessions with **no usage record at all** are listed rather than dropped. A
prompt-only shell writes a `user` record and no assistant record: it ran, and it
cannot be costed from disk. That is a property of the store, not a gap here.

**The window.** Both surfaces show the **last 48 hours** by default, because
that is the span in which you are still comparing arms against each other.
`--since` takes `6h`, `90m`, `7d`, `2w`; `--all` drops the filter. In the
browser the same windows are chips above the table, and switching is instant —
the page holds every session and filters client-side. Anything hidden is
counted, never silently dropped.

Session numbers are assigned over *all* sessions, not the visible ones, so
`opt session 7` means the same session whether or not the window shows it —
and the totals row always sums exactly what you can see.

The synthetic smoketest is undated by design: its run id is not a timestamp, so
it falls outside every window and only appears under `--all`. It is not a
result.

The reasoning matters because the naive signal lies: an agent legitimately
spends many minutes on one step, writing nothing, while it thinks. Elapsed time
alone cannot distinguish that from a hang. The prompt says so explicitly and
lists what actually indicates trouble — near-zero CPU with no recent writes, a
dead sandbox on an unfinished arm, an auth error in stderr, an orchestrator
process that has vanished.

If no model is reachable it falls back to a rule-based assessment rather than
printing nothing. `opt` uses **this machine's** Claude Code login, never the
sandbox token.

## The benchmark

`task/spec/SPEC.md` — implement `sheet.py`, a mini spreadsheet formula engine:
recursive-descent parser, bijective base-26 columns, ranges with free corner
order, `SUM/AVG/MIN/MAX/COUNT`, cycle detection, four precisely-specified
exception types.

Graded by `task/grader/test_hidden.py` — **47 tests**, written into the sandbox
only *after* the agent process exits, so no run can be tuned against its own
scorer. The spec and grader were validated against a reference implementation
(47/47) before either arm ever ran.

## Output

`results/<runId>/`:

* **`report.html`** — six-axis **spider chart** (correctness, cost efficiency,
  token economy, turn economy, cache reuse, speed), the raw numbers
  unnormalised, and a per-test failure breakdown. Regenerate any time with
  `node report.mjs [runId]`.
* `report.txt` — the same comparison as terminal text
* `run.json` — everything, machine-readable
* per arm: the delivered `sheet.py`, `PLAN.md`, the agent's own tests, raw
  Claude Code result JSON

Each axis normalises independently so the better session touches the outer ring
— **outward is always better**, including where a lower raw number wins. A radar
plot flatters whichever shape encloses more area, so the unnormalised table
directly beneath it is not optional.

`results/0000-SYNTHETIC-SMOKETEST/` holds **invented** numbers used to develop
the chart. It is not a result. Real runs sort after it, so `node report.mjs`
with no argument always picks the newest real one.

## Setup

From the repo root (one `package.json` and one `.env` for the whole repo):

```bash
npm install
```

Two keys in `.env` — that's the whole setup, no interactive login:

```bash
read -rs 'k?E2B_API_KEY: '        && printf 'E2B_API_KEY=%s\n' "$k" >> .env && unset k
read -rs 'k?ANTHROPIC_API_KEY: '  && printf 'ANTHROPIC_API_KEY=%s\n' "$k" >> .env && unset k
```

* **`E2B_API_KEY`** — https://console.e2b.dev/?tab=keys · free tier, no card, $100 credit
* **`ANTHROPIC_API_KEY`** — https://console.anthropic.com/settings/keys

The Anthropic key is injected straight into both sandboxes. Runs bill API
credits, capped at `--budget` per arm (default **$10**).

## Knobs

| env | default | |
|---|---|---|
| `BENCH_MODEL` | `opus` | applied to **both** arms — changing it per-arm would measure model routing, not your strategy |
| `MAX_BUDGET_USD` | `10` | per arm, enforced by `--max-budget-usd` |
| `AGENT_MS` | 30 min | agent timeout |
| `SANDBOX_MS` | 40 min | VM lifetime (E2B hobby tier caps at 1 h) |
| `ONLY_ARM` | — | `control` or the scenario name, to run just one |

## Reading results honestly

**n = 1 per arm.** Agent runs vary substantially. One pass shows the shape of a
difference, not a defensible number — three repeats is the minimum before
quoting a figure. The optimized arm is *expected* to win on cost; that is the
hypothesis, not a finding. The open questions are whether correctness survives,
and by how much the gap moves. One task, a parser, rewards planning; a debugging
or refactoring task could rank these strategies differently. And an experiment's
scaffolding cost a human time to write, which this prices at zero.
