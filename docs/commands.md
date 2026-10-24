# Commands

Every command in the repo, run from the checkout root. **Free** means no model call outside this
machine and no sandbox in the cloud. Commands marked **spends** start arms, call a paid API or boot a
sandbox: never run them while testing, and the Python ones refuse without `--yes`.

## Once per checkout

```sh
npm install                                  # the app's deps at the root (e2b is optional)
npm run build:web                            # the hub page: app/web -> app/web/dist; again after any change under app/web/
ln -s "$PWD/opt" ~/.local/bin/opt            # the opt CLI on your PATH
cp .env.example .env                         # one .env for Node and Python; fill in only what you need
python3 tools/envfile.py check               # which secrets are set (masked) and what each enables
```

Optional: `npm i -g @mermaid-js/mermaid-cli` (for `mmdc`), Docker Desktop (for `tools/rerun.py run` and
`opt optimize`), `"cleanupPeriodDays": 3650` in `~/.claude/settings.json` to keep transcripts.

## Checks

```sh
npm test                                     # app suites + sandbox/test.mjs; no network beyond 127.0.0.1, no Docker, no model calls
node sandbox/test.mjs                        # the boundary alone: SDK in one place, nothing points outside the checkout
python3 examples/golden/demo.py --check      # golden test of the whole pipeline on synthetic sessions
python3 examples/golden/demo.py --update     # after a deliberate change; regenerates examples/golden/how-it-works.html
python3 tools/ratecard.py check              # the rate card vs Claude Code's own per-model costs
python3 -m unittest tools/test_onboard.py    # the onboarding probes: known answers, silent cases, no text in any output
```

## Analysis tools (free, read-only)

All read `~/.claude/projects` and price with `tools/ratecard.py`, counting usage once per request.

| command | what it answers |
|---|---|
| `python3 tools/sessions.py [--hours 8 \| --days 7 \| --since YYYY-MM-DD] [--sort cost] [--csv out.csv]` | what ran, when, where and what it cost; the retention boundary |
| `python3 tools/lenops.py view [--all \| --session <uuid>]` | one session's ops report: context, cache, cost mix, levers (also `/lenops`) |
| `python3 tools/ctxwatch.py [--once] [--session <uuid>] [--project DIR]` | live context meter for a running session |
| `python3 tools/loopscan.py [--days 31] [--json out.json]` | month aggregate, recurrent loops, TTL counterfactual (E1) |
| `python3 tools/savings.py --days 30 [--top 15] [--csv out.csv]` | per-session lever headroom, A–D |
| `python3 tools/dynconfig.py [--since YYYY-MM-DD] [--top 15] [--root DIR]` | the Claude Code config catalog priced per session, in applied order |
| `python3 tools/sessiongraph.py <sid> [-o g.json] [--html g.html --page triage\|session]` | one session as a graph of tasks |
| `python3 tools/tune.py <sid> [--json]` | the "dynamic" flags for one session |
| `python3 tools/costmodel.py` | the supportbot cost model; run before editing any number in `docs/optimizers.md` |
| `python3 tools/ratecard.py` | the rate card in force, with its version |

Anything derived from live sessions goes under the gitignored `data/private/`.

## opt scan, the v1 product

```sh
opt scan                     # free: layers 1-3 over the last 30 days -> data/private/scan/<date>/report.html, opened
opt scan --dry               # print every field that would leave the machine; write nothing
opt scan --since 2026-10-01 [--admin-report usage.json] [--no-open]
opt scan rollup DIR [DIR …]  # one org view from several developers' scan directories
```

Same as `python3 tools/scan.py …`. Layer 1 is settings (the onboarding probes plus dynconfig's fast mode, model
switches, unused tools and output hook), layer 2 routing (each subagent type, skill and main loop re-priced on
Haiku 5.5 or Sonnet 5.5), layer 3 the Optimization Atlas. Per-repo day-1 profiles land in `profiles/` and never
leave the machine.

## Onboarding scan (`docs/onboarding-spec.md`)

```sh
python3 tools/onboard.py [--days 30] [--admin-report usage.json]   # free: P0-P5 -> data/private/onboard/<date>/ (findings.jsonl, report.html)
python3 tools/onboard.py --dry               # print every field that would leave the machine; write nothing
python3 tools/cachestatus.py [--admin-report usage.json]          # P1 alone: caching on? uncached share, TTL mix
python3 tools/gapscan.py [--since YYYY-MM-DD]                     # P3 alone: TTL and keep-alive policy per population
python3 tools/savings.py --classes           # P4 alone: lever B per session class, effort switches
python3 tools/sessiongraph.py <sid>          # P5 for one session: spend by thread and subagent model
python3 tools/probe_cache.py                 # P2 plan and estimated cost (free)
python3 tools/probe_cache.py conformance --yes   # spends (~$0.09): smart-TTL billing check, ~8 minutes
python3 tools/probe_cache.py path --yes      # spends (~$0.05): does the gateway keep cache markers
python3 tools/probe_cache.py show            # stored P2 results and whether they are current
```

## Replays: `tools/rerun.py`

```sh
python3 tools/rerun.py plan <sid> --goal cost [--dynamic]   # free: writes the plan, prints the commands
python3 tools/rerun.py run    <run-id> --yes                # spends: replays every arm in the Docker sandbox
python3 tools/rerun.py judge  <run-id> --yes                # spends: blind pairwise score of the diffs
python3 tools/rerun.py report <run-id>                      # free: radar + tables -> report.html
python3 tools/rerun.py go <sid> --goal cost --repeats 3 --yes   # spends: all four
```

Goals: `cost`, `speed`, `quality`, or `--flags "..."`. `--sandbox host` runs outside Docker. Output goes to
`data/private/reruns/<run-id>/`. A verdict needs three repeats per arm.

## Experiments

```sh
cd experiments/session-triage
python3 src/run.py                           # J3 rules arm on the pinned E1b ledger, no egress
python3 src/run.py --dry-run                 # print the Jev payload for the top session, send nothing
python3 src/run.py --mode interactive --limit 20   # label the 20 most expensive sessions yourself (gold)
python3 src/score.py --days 30               # one-shot scoring pass; rules only while JEV_API_KEY is unset
python3 src/export_hub.py                    # triage.json for the hub (app/results/, or $OPT_HOME/results/)
python3 src/recommend.py [--arm human] [--copy settings|script]   # the settings the labels recommend
```

**Spends:** `--arms rules,jev` and `score.py` with `JEV_API_KEY` set (one Jev call per session). Run
them through `python3 tools/envfile.py run -- …`. The email triage experiment (J2) is in
`experiments/email-triage/` (see its README).

## The `opt` CLI (`app/`)

`opt --help` lists every command. Free ones:

```sh
opt init                     # is everything up: credentials, templates, tracing, runners, sessions on disk
opt secrets                  # where each key comes from, and whether it works
opt session [<#>] [ui]       # last 48h of sessions; one session's context window; the same in a browser
opt session --watch [--live] [--once]   # what is running now, redrawn in place
opt analyse                  # classify every session (Jev on local Ollama)
opt audit [--verify]         # every task analyse and optimize ran
opt models                   # every model the gateway can use
opt models bench [model] [--sizes 1000,4000,16000]   # first token, prefill, decode on this machine; writes the profile the router reads
opt install [--yes]          # the local tier: Ollama version, server settings, tev1 + worker, a bench profile
                             # --yes: launchctl setenv + ollama pull (downloads); never installs Ollama itself
opt experiments [ls|ps|status|logs|open|kill|results|ui]   # runs: list, live, health, logs, stop, compare
opt artifacts [ls]           # render every deliverable to HTML
opt monitor on|off|status    # send Claude Code's OpenTelemetry to the hub's collector
opt hub start                # the Optimization Hub on :8899
opt hub demo                 # the Tallyfox demo hub on :8950 (synthetic data)
```

**Spends** (starts arms or boots sandboxes):

```sh
opt optimize [strategy]      # one task in the local sandbox
opt claude optimize [dir]    # interactive Claude Code behind LLM Ultra Light
opt claude optimize [dir] --local-cloud   # + the local tier: Ollama for what capacity admits, tev1 when rules are unsure (shadow)
opt claude -p "<task>"       # headless, optimize mode   (also: opt claude example)
opt run --experiments a,b    # scenarios, grouped under a session
opt demo run                 # control vs a scenario   (opt demo scenarios lists them, free)
opt replay <#> [--runner anthropic|openmodel] | --new   # a session again in E2B (default: open weights), side by side
opt tune <bundle|#>          # configuration search, one arm per candidate
opt flow run <name>          # controller + worker + judge sandboxes
```

The hub's run endpoints spend the same way: `/api/optimize`, `/api/experiment`, `/api/triage/*`.

**Deprecated** (still run, and print the form below on stderr):

| old | use |
|---|---|
| `opt ls`, `ps`, `status [ui]`, `logs`, `open`, `kill`, `results` / `report` | `opt experiments <same>` |
| `opt ui` | `opt experiments status ui` |
| `opt watch` / `opt w` | `opt session --watch` |
| `opt opt` | `opt optimize` |
| `opt session export <#> --run [--runner r]` | `opt replay <#> --runner r` (export, run, trace, and compare) |

## Sandboxes, docs, packaging

```sh
sandbox/docker/sandbox.sh build|verify|run|shell|down    # the local Docker sandbox (rerun.py builds it on first use)
sandbox/e2b/harness/build.sh                             # build the E2B arm template, after `e2b auth login`
mmdc -i docs/demo-diagrams.md -o docs/screens/diagrams/demo.png -b white -s 2   # re-render the demo diagrams
app/packaging/make-dist.sh                               # the release tarball; refuses if a credential-shaped string is in it
node app/tools/hub-snapshot.mjs                          # frozen hub snapshot for the read-only deploy (app/deploy/)
```
