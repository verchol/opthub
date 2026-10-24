# Backlog

Requested 2026-09-05, worked overnight. Status is honest: `done` means it runs
and was exercised end to end, `built, unexercised` means the code is complete and
unit-tested but a live run was never possible, `todo` means it is specified but
not built.

---

## ⚠ Read this first — both auth paths are dead

Nothing that calls a model can run right now, and this is not something the code
can fix:

| credential | state | evidence |
|---|---|---|
| `ANTHROPIC_API_KEY` (1Password `op://Automation/Token-Anthropic-demo/token`) | valid key, **no credit** | `400 Your credit balance is too low to access the Anthropic API` |
| `CLAUDE_CODE_OAUTH_TOKEN` (`.env`, minted 2026-09-04) | **expired** | agent in-sandbox: `401 OAuth access token is invalid` |

To unblock, either:

1. Top up at `console.anthropic.com/settings/billing`, or
2. `node auth.mjs` to mint a fresh subscription token — needs your browser, so I
   could not do it.

`opt tune` and `opt session export --run` now **preflight this before booting
anything**, so a dead credential costs one 4-token request instead of N sandbox
boots. Two sandboxes were spent discovering it before that guard existed; nothing
has been spent since.

---

## 1. Export a session into a sandbox — `done`

`opt session export <#|ref>` turns any session in the table into a self-contained
bundle under `exports/<ref>/`, and `--run` boots an E2B sandbox from it.

* **e2b arms** export exactly: task spec, prompt, flags, scenario setup. Re-running
  one is a true replay — same inputs, fresh sandbox.
* **local sessions** export what a transcript can prove: the prompts the user
  typed, the files the session wrote through Write/Edit, and the project's
  `CLAUDE.md`. A file written through Bash leaves no record, so a local export is
  a faithful *restart*, not a byte-identical clone. The manifest says which it is.

See `README.md` § *Exporting a session into a sandbox*.

## 2. Sandbox-side reasoning that tunes its own parameters — `built, unexercised`

`opt tune <bundle>` runs the same task under several configurations, reads the
graded results, and asks Claude to reason about *why* one beat another and what
to change next. Each round is a generation: N sandboxes in parallel, a judgement,
then a new set of candidates.

Tunable axes: model, effort, context/compaction settings, prompt strategy,
subagent model, tool-preload policy, and any other Claude Code flag the reasoner
decides to move. The reasoner is constrained to a declared search space so it
cannot invent flags that do not exist.

Every generation, every candidate and the reasoning itself are traced.

**What was verified:** `npm test` covers the flag builder over every knob in the
search space, the scoring and ranking rules (correctness first, cost as
tie-break, fatal last, ungraded reported as `null` rather than silently zero),
and the reasoner prompt (names every legal knob, states the sample size, warns
about noise at n=1, refuses to invent flags, says plainly when nothing can be
graded). 22 assertions, all passing.

**What was not:** a live generation. The reasoner call and the candidate runs
both need a working credential, and neither existed by the time it was built. The
sandbox-running half of the same code path *was* exercised — see item 1 — so what
is untested is specifically the reasoner call and the generation loop around it.

## 3. LangSmith monitoring, project `sandboxes` — `done`

Project created and receiving runs — three traces in it, with the full nested
span tree and token/cost rollup. It proved its worth immediately: the first
bundle run came back `1 turn, $0.0000, 17.8s` in the terminal, and the trace said
why — `Credit balance is too low`, recorded on the `agent` span. The second said
`401 OAuth access token is invalid`. That is how both blockers above were
diagnosed.

Note the MCP LangSmith server's key is 403 Forbidden; the key in the shell
environment works. The harness uses the latter over REST.

Trace shape:

```
run <scenario> · <task>          chain
  arm control                    chain
    sandbox created              tool
    install claude-code          tool
    scenario setup               tool
    agent                        llm    ← tokens, cost, model
    grade                        tool
  arm <scenario>                 chain
    …
```

`opt tune` nests one level deeper: `tune → generation N → candidate → arm → …`,
with the reasoner's own call as an `llm` span carrying its verdict.

Enabled whenever `LANGSMITH_API_KEY` is set; `SANDBOX_TRACING=0` turns it off.
Tracing is best-effort by construction — a tracing backend that can take a run
down is worse than no tracing, so every call swallows its own errors.

---

## 4. Unasked-for fix: `op` could wedge the whole CLI — `done`

Secrets resolve at module load through `op read`, which blocks on a Touch ID
prompt. With the vault locked and nobody at the keyboard, that call never
returned — so `opt <anything>` hung with no output at all, which is what several
commands did tonight before I traced it. `op` calls now take a bounded wait
(`OP_TIMEOUT_MS`, default 20s) and fail with the actionable message that was
already written for the case.

## 5. The experiment: local session → sandbox → open weights — `done`

`opt replay --new --task mini --runner openmodel` runs one task twice — once by
Claude here, once by an open-weights model in a sandbox — and grades both with
the same hidden suite. `opt replay <#>` replays an existing session instead of
starting one.

Runners live in `runners.mjs`: `anthropic`, `openmodel` (qwen2.5-coder:3b via
Ollama + LiteLLM, entirely inside the `openmodel-bench` template), and
`openmodel-bedrock` (Qwen3-Coder-480B). `ANTHROPIC_BASE_URL` is the whole trick —
LiteLLM serves the Anthropic wire format in front of something else.

**Two plumbing problems, both found by running it:**

* Ollama defaults a model's context to **2048 tokens**, which cannot hold Claude
  Code's system prompt. The runner rebuilds the model from a `Modelfile` with a
  32K window first.
* Claude Code asks for thinking and qwen has none —
  `"openmodel-ctx" does not support thinking`, a 500 through LiteLLM. Fixed with
  `additional_drop_params` plus `MAX_THINKING_TOKENS=0`.

**Measured, and worth knowing before relying on it:** the local 3B model runs at
**8.5 tok/s generating, ~29 tok/s reading prompt** on 4 CPU cores. One probe
logged a single `/v1/messages` request in 25 minutes on a trivial prompt. The
runner narrows the tool surface to `Bash Read Write Edit` to cut the prompt it
re-reads each turn, but `openmodel` remains a *plumbing* path — correct, free,
and slow. For open weights that finish real work, `openmodel-bedrock`.

Worth noting from your own overnight run (`results/2026-09-05T23-08-41-997Z`):
Qwen3-Coder-480B reached **65/69** on `regex` against the 30B's **11/69**, but
the 480B arm ended on `400 BedrockException … This model's maximum context` at 28
turns — cut off, not finished, so 65 is a floor. The 30B arm ran to `DONE` in 27
turns and still scored 11. If you re-run that comparison, the 480B arm wants a
compaction setting or a smaller context budget.

## 6. `opt experiments` group + UI — `done`

Run commands grouped under one verb (`ls · ps · status · results · logs · open ·
kill · ui`), old top-level forms kept as aliases. `opt experiments ui` shows, per
run: the strategy in words, each arm's *inputs* (model, prompt size, prompt
complexity, spec), what moved with green/red numbers, how to apply the levers,
and the artifacts each arm produced. Sortable on every column.

## 7. `opt` no longer asks for credentials on every command — `done`

**Cause:** `.env` holds three `op://` references (`ANTHROPIC_API_KEY`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`), and `resolveSecrets` ran at module
load. Every `opt` invocation therefore ran up to three `op read` calls, each
raising a Touch ID prompt — including `opt ls`, which needs none of them.

**Fix:** plain `.env` values still load eagerly (free); `op://` references
resolve lazily, only in the commands that will actually use them, memoised per
process. `opt ls` went from ~7s and three prompts to ~2s and none. A command that
never calls a model never asks for a model credential.

## 8. `opt init` — `done`

One command that says whether the rig is up: credentials (with a live 4-token
check on the Anthropic key), E2B templates and running sandboxes, the LangSmith
project and its trace count, each model runner marked usable or not *with the
reason*, tasks and scenarios, and every session on disk analysed for model,
context peak against its window, and tools. Ends with a verdict naming the
usable runners, or the thing to fix first. Read-only. `opt doctor` / `opt setup`
alias it.

## 9. The agent cap was silently eating runs — `done`

`opt session export 13:25:27·control --run` scored **69/69 in 77 turns** and
reported `$—`. The blank cost was the tell: wall time was 1207.6s against a
1200s agent cap, so `claude` was killed mid-turn and never wrote its result
event. The grade was real — the code was already on disk — but cost, tokens and
the agent's own summary were gone, and nothing said so.

Two fixes: the default agent cap is now 30 minutes (matching `run-demo.mjs`,
`AGENT_MS` overrides), and a capped-out run says it plainly —
`the agent was killed at its 30-minute cap … the grade is real, the spend is not
missing but unknown` — instead of printing an empty cost column.

Also worth carrying forward: the same bundle that the original arm finished in
**7 turns / 5m46s / $1.07** took **77 turns / 20m+** on replay. Same prompt, same
spec, same `--model opus` alias — but the original ran on `claude-opus-4-8` and
the alias now resolves elsewhere. An alias is not a pinned model, and a replay
that wants to be a replay should pin the exact model id from the manifest.

## 10. Analytics: percentiles, continuous classes, similar sessions — `done`

Requested 2026-10-19. Analytics is now a rail section of its own, not only a
per-session view. `GET /api/insights` (`lib/insights.mjs`) classifies every session
on twelve attributes — purpose (from wording, a guess), kind, artifact type,
project, tool style, model tier, driver, scale, context, and the three Jev triage
classes — and is recomputed whenever a transcript moves, so a new or growing
session is classified on the next poll. Page code: `lib/hub-insights.mjs`.

* **Percentiles** — p50 / p95 / p99 per category, for cost, cost per turn, cost
  per typed prompt, duration or context. Filter by window, model, driver, min n
  and text; sort any column; the cheapest p50 and the tamest p95 are badged; a
  row opens to its cheapest sessions and its tail. Nearest-rank: below 20
  sessions p95/p99 are top values, and the page says so.
* **Classes** — attributes ranked by ω² on log cost (how much of the cost spread
  each explains, corrected for group count). Grouping defaults to the top *work*
  attribute; scale and context rank highest but explain cost by construction, so
  they are shown and never picked for you. Optional second level, "auto: top two".
* **Similar** — sessions as a force-directed graph: an edge joins two sessions
  among each other's five nearest (½ shared attributes, ⅓ intent TF-IDF, rest
  shared file types), sized by cost, coloured by any attribute, clustered by
  colour. Pan, zoom, drag, highlight; a click lists the neighbours and *why*.
  Layout and focus survive the hub's redraws.

On this machine: 123 sessions, classified in 27 ms; 339 links at ≥ 35%.

## Known limits, carried forward

* **`--run` on a local export replays the prompt, not the machine.** Anything the
  session read outside the files it wrote is not in the bundle.
* **The tuner grades on the task's own hidden suite.** A task with no suite
  (`kind: document`) falls back to the document metrics and the blind judge,
  which is a weaker signal — the tuner says so in its verdict.
* **n = 1 per candidate.** The tuner compares single runs; agent variance is
  wide enough that a one-run difference under ~15% is noise. `--repeats` exists
  and defaults to 1 because repeats cost linearly.
* **The tuner's search space is a declared list, not everything Claude Code has.**
  It covers model, effort, autocompact, dynamic-system-prompt exclusion, setting
  sources, tool surface, subagents, appended system prompt, and the task prompt.
  Adding a knob is one entry in `SEARCH_SPACE` plus one property on the tool
  schema; both live in `tune.mjs`.

## Next

* `todo` — run the reasoner *inside* a sandbox rather than on the host. Needs the
  E2B key forwarded into the sandbox so it can spawn siblings; deliberately not
  done without asking, since it puts a key that can spend money inside an agent
  workspace.
* `todo` — carry a tuning result back into `scenarios/` as a generated scenario
  file, so a win becomes a first-class experiment.
* `todo` — LangSmith datasets: pin a task's graded outcomes as a dataset so
  regressions across model versions are visible without re-reading run.json.

---

## 4. Optimization Hub  *(building now)*

A local server — `opt hub start` — that presents everything `opt` produces as one
browsable UI, with **sessions** as the centre of gravity.

**Sessions tab.** Every ended Claude Code session on this machine, processed into
one super-simple table row: `model · intent · duration · cost · top artifact ·
tool-call graph`, plus classification attributes (task kind, has-artifacts, cost
bucket) so sessions can be sorted and filtered. A session that produced no file
is marked `none`. Each ended session registers via a Stop hook; the hub also
scans the transcript directory on demand, so it works with or without the hook.

**Analytics tab.** The main metric over a session's lifecycle — cumulative cost
(or tokens) against turn index — so you can see where spend accrues.

**Judging.** The default comparison between an actual session and its optimized
replay is by their **artifacts**: same task, whose output is better. Sessions
with no artifact can't be compared and read `none`.

Model is a first-class column on every row — the single most important attribute
for classifying and comparing.
