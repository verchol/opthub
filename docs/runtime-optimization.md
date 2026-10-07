# Epic RO — runtime optimization (`opt claude optimize`)

**Status:** draft v0.1 · **Date:** 2026-09-30 · **Owner:** oleg@canarian.io
**Spec:** `SPEC.md` §16 points here. **Implementation:** `sandbox/e2b` — `optimize-live.mjs`,
`ult.mjs`, `lib/ult/`, `config/ult.default.json`, `template/claude/commands/optimize.md`.
**Thesis:** `docs/demo-thesis.md` Phase 2 · **Evidence:** `docs/evidence-catalog.md`

---

## 1. What this epic delivers

Phase 1 measures sessions after they happen. Runtime optimization acts **while the developer works**:

> A developer types `opt claude optimize` in a normal terminal. Claude Code starts inside the opthub
> sandbox, and the developer keeps typing prompts exactly as before. Every request Claude Code sends
> goes through **LLM Ultra Light (ULT)**, a small router inside the sandbox boundary that classifies the
> request, decides whether to keep it on the frontier model, route it to a cheaper remote model, or
> answer it with a local Ollama model, and records the decision in an append-only audit log.

The decision element sits at the edge, next to the session (claim C1). Policy stays central and
versioned (C2). Parts of a session are routed, never the whole session (C3).

## 2. User stories

| id | as a… | I want… | so that… |
|---|---|---|---|
| RO-1 | developer | to start an optimized session with one command from my usual terminal | I don't change how I work |
| RO-2 | developer | my prompts to go to Claude Code running in the sandbox, interactively | the agent can't touch my real checkout or my credentials |
| RO-3 | developer | each request classified and routed by class | cheap work goes to cheap models and hard work stays on the frontier model |
| RO-4 | developer | local Ollama models used where they are good enough | some requests cost nothing and never leave the machine |
| RO-5 | developer | the classifier to remember my session and project | routing gets better with history and a turn keeps one class across its tool loop |
| RO-6 | team lead | every decision recorded, tamper-evident | we can audit what was routed where, and why, after the fact |
| RO-7 | developer | a shadow mode that decides and records but changes nothing | I can see what it would do before trusting it |
| RO-8 | developer | to override the router in one flag or setting | a wrong decision never blocks me |

## 3. How it works

```
 host terminal                                    sandbox boundary (Docker)
 ─────────────                                    ──────────────────────────────────────────────
 $ opt claude optimize ──► preflight, config, workspace ─► opthub-agent-<id>   (internal network only)
      │                                               claude (interactive TTY)
      │  stdin/stdout ◄────────── docker run -it ──►   ANTHROPIC_BASE_URL=http://ult:8787
      │                                               workspace copy at /work/out/project (rw)
      │                                                     │  /v1/messages
      │                                                     ▼
      │                                           opthub-ult-<id>   (internal + egress networks)
      │                                               features → classifier → policy → upstream
      │                                               │ rules  ─┐
      │                                               │ Jev    ─┼─► class, confidence
      │                                               │ context─┘   (persisted per project)
      │                                               ├─► remote: api.anthropic.com   (holds the credential)
      │                                               ├─► local:  ollama @ host:11434 (Anthropic API)
      │                                               └─► audit.jsonl (hash-chained, append-only)
      ▼
 on exit: summary, audit path, how to merge the workspace back
```

**Trust boundary** (unchanged from `SPEC.md` §5.1, extended):

| | agent container | ULT container | host |
|---|---|---|---|
| network | internal only: reaches `ult` and the egress proxy | internal + egress: provider API, Ollama on the host | normal |
| credential | a dummy key only | the real API key or OAuth token | keychain / env |
| writes | the workspace copy | audit log, classifier context | everything |
| code | Claude Code | ULT, mounted read-only | opthub |

**Which credential.** The Claude **subscription** is the default and the only thing used unless
`AUTH_MODE=api-key` is set; there is no fallback from one to the other. A container cannot use the
Mac's own Claude Code login, so the subscription travels as the long-lived token `claude setup-token`
issues (billed to the plan). `opt claude optimize login` runs that once and stores the token in the
macOS Keychain (`opthub-claude-subscription`; a 0600 file on Linux); it takes precedence over a
`CLAUDE_CODE_OAUTH_TOKEN` in the shell or `.env`. An API key bills API credits and is used only with
`AUTH_MODE=api-key` (found 2026-09-30: preferring a 1Password-held API key produced "credit balance
too low" for a user on a Claude plan). `--sandbox host` needs no token: it is the developer's own login.

The agent never holds the provider credential. ULT swaps the dummy key for the real one on the way
out, so a compromised agent can spend only through the router that audits it.

## 4. Components

### 4.1 Launcher — `opt claude optimize` (`optimize-live.mjs`)
1. Resolves config (§6) and flags (§5); writes the resolved config to the run directory.
2. Preflight: Docker running, images `opthub/agent:0.1` present (else `template/docker/sandbox.sh build`),
   networks and egress proxy up (else `sandbox.sh up`), a credential available, Ollama reachable if
   any local target is enabled.
3. Workspace: `copy` (default) clones the project into `$OPT_HOME/sandbox-out/optimize-<id>/project`,
   including uncommitted and untracked files; `rw` mounts the real directory writable (explicit
   opt-in, warns); `ro` mounts it read-only.
4. Starts ULT, waits for `/healthz`, then runs Claude Code interactively in the agent container with
   the developer's terminal attached. Onboarding and trust prompts are pre-answered.
   - **Progress display** (`lib/progress.mjs`): each step shows a spinner, a bar and its elapsed time,
     and finished steps stay on screen with their duration.
   - **Credential checked first:** one free `count_tokens` call. A `401`/`403` stops the launch in
     under a second with the fix, before any container starts (`--skip-auth-check` to override).
   - **Parallel:** Docker and the credential are checked together; then the workspace copy, the router
     start and `docker create` of the agent container run together; the agent starts with
     `docker start -ai`. Measured 2026-09-30: **4.2 s** from command to Claude Code
     (Docker 0.2 s · sandbox check 1.5 s · router healthy 2.5 s), on a Docker Desktop running 51 other
     containers.
   - **Removal in the background:** removing a container took ~5 s on that Docker Desktop, so neither
     container uses `--rm`; both are removed detached after the session, and the prompt returns at once.
   - **One router per session, by its own name.** The router joins the internal network as
     `ult-<session>` and the agent gets that name pinned in `/etc/hosts` (`--add-host`), so there is no
     shared name and no DNS lookup (~200 ms each on that Docker Desktop). Found 2026-09-30: with a
     shared `ult` alias, a session's requests went to an orphaned router from an earlier session,
     which held an expired token — every request failed and was retried, which read as a slow terminal.
   - **Cleanup on every exit path:** normal exit, error, Ctrl-C before the session starts, `SIGTERM`
     and `SIGHUP` (terminal closed) remove both containers. Every container carries
     `opthub.session`, `opthub.role` and `opthub.launcher=<pid>@<host>` labels; at each launch, in
     `status` and in `opt claude optimize clean`, containers whose launcher is gone (or, unlabelled,
     a router with no running agent) are removed — this covers `kill -9`. Workspace copies are never
     removed automatically: they hold the session's changes.
5. On exit: stops ULT, prints the audit summary and the command to bring changes back
   (`git -C <repo> fetch <copy> HEAD:opthub/optimize-<id>` for a git project).
6. **Visible mode.** Claude Code's status line shows the session is optimized, refreshed every 2s from
   `GET /ult/status` (`lib/ult/statusline.mjs`):
   `opthub ROUTE · non-coding/explain → haiku-4-5 · 14 req · 3 rerouted · saved $0.19` (green tag),
   `opthub SHADOW · … keep · would route haiku-4-5 · would act on 2` (violet tag), or a red
   `opthub router unreachable`. Docker mode sets it in the sandbox's own settings; host mode passes it
   with `claude --settings` for that session only. The terminal title reads
   `opthub optimize · <mode> · <project>`, and `/status` inside Claude Code shows the router's URL.
7. `--host` runs ULT in-process and the developer's own `claude` against it, with no sandbox. It is for
   development and for machines without Docker, and says so on start.

### 4.2 LLM Ultra Light — the router (`ult.mjs`, `lib/ult/`)
An Anthropic-compatible HTTP server with no dependencies beyond Node 22.

| route | behaviour |
|---|---|
| `POST /v1/messages` | classify → decide → forward (streaming passthrough) → audit |
| `POST /v1/messages/count_tokens` | forward to the remote provider unchanged |
| `GET /healthz` | liveness |
| `GET /ult/status` | counts by class and decision for this run |
| anything else | forward to the remote provider unchanged, audited as `passthrough` |

Per request:

1. **Features** (`features.mjs`), the session view a gateway lacks: requested model, message count,
   whether the last message is a human prompt or a tool result, tools offered, tool uses in the last
   six assistant turns (edits, bash, reads, git diff), thinking on or off, `max_tokens`, approximate
   input tokens, and the thread key (Claude Code session id from `metadata.user_id`, plus a hash of the
   system prompt and first message so subagent threads are told apart).
2. **Classifier** (`classifier.mjs`) assigns one runtime class:
   `coding/edit` · `coding/debug` · `review/security` · `review/general` · `non-coding/explain` ·
   `non-coding/summarize` · `non-coding/pr-description` · `background/utility` · `unclear`.
   - **Rules first**: prompt keywords matched in memory, plus session signals such as recent edits and
     `git diff` output. Prompt text is never stored or sent anywhere.
   - **Turn stickiness**: a class is decided on the human prompt and held for every tool-loop request
     that follows it until the next human prompt (RO-5).
   - **Jev** (TypeSafe `jev-1.13.0`, Choice primitive) is asked only when rules return `unclear` or
     fall below `classifier.jev.minRuleConfidence`, and only with **features and boolean prompt
     flags**, never prompt text, paths or cost. A timeout or invalid answer means abstain (the same
     contract as `experiments/session-triage`).
3. **Context store** (`context-store.mjs`): per project, `$OPT_HOME/ult/context/<project-key>.json`,
   holding per-session turn state, thread-to-model stickiness, class history, and project priors
   (class frequencies and developer overrides). Loaded at start, written atomically. This is the
   "persisted classifier context".
4. **Policy** (`policy.mjs`) decides `keep` · `route` · `local`:
   - `never_downgrade` classes always keep.
   - `routes` map class → target (`remote:<model>` or `local:<model>`).
   - **Economics check (cache-aware)**: a main-thread request that is routed to another model pays
     uncached input at the target's write price, while keeping it pays cache reads (evidence catalog:
     94–99.9% of Claude Code input is cache reads). A route happens only when the estimated cost of
     routing is below keeping, unless the target is local.
   - **Thread stickiness**: once a thread is routed, it stays on its target so its cache stays warm.
     Route per thread, never flip per turn.
   - `mode: shadow` (the default) records the decision and forwards unchanged.
5. **Upstream** (`upstream.mjs`): remote is `api.anthropic.com` with ULT's credential; local is
   Ollama's Anthropic-compatible `/v1/messages` (verified on Ollama 0.18), with fields local models
   reject removed (`thinking`, `context_management`, `cache_control`, beta headers). Streaming is
   passed through byte for byte while usage is read from the SSE events.
6. **Model adapter** (`adaptForModel`, `adaptHeaders`, config `models`): a request Claude Code built
   for its main model must be reshaped for the model it is routed to. Found on live traffic
   (2026-09-30), each one a `400` from Haiku 4.5 until handled:
   - adaptive thinking is not supported, so thinking is turned off (routes are for non-coding classes);
     `clear_thinking` context edits go with it;
   - `output_config.effort`, at the top level and per message (the per-turn-control beta), is removed;
   - mid-conversation `system`-role messages are folded into the top-level system prompt;
   - the `effort-`, `per-turn-control-`, `advisor-tool-`, `thinking-token-count-` and `mid-conversation-`
     betas are dropped, and `max_tokens` is clamped to the target's maximum output (64k).
   `ULT_DEBUG_SHAPE=1` logs the top-level shape and beta header of each routed request (no content).
7. **Fallback**: if a local or routed request fails before any byte is streamed, it is retried once
   on the originally requested model and audited as `fallback` with the provider's error message.
   `401`/`403` are not retried, because the same credential would fail again.

### 4.3 Audit log (`audit.mjs`) — RO-6
`$OPT_HOME/results/ult-<id>/audit.jsonl`, one line per request, hash-chained as in `SPEC.md` §9.2:
`hash = sha256(prev_hash + canonical JSON of the entry)`.

| field | meaning |
|---|---|
| `seq`, `ts`, `run`, `session`, `thread` | identity |
| `path`, `requested_model`, `stream` | what Claude Code asked for |
| `features` | counts and booleans only |
| `class`, `confidence`, `source` | `rules` · `sticky` · `jev` · `prior` · `override` |
| `decision`, `target`, `reason`, `mode` | `keep` · `route` · `local` · `fallback` · `passthrough` |
| `est_keep_usd`, `est_route_usd` | the economics check |
| `status`, `latency_ms`, `ttft_ms` | outcome |
| `usage` | input, output, cache read, cache write tokens from the response |
| `cost_usd`, `counterfactual_usd` | priced actual vs the requested model on the same usage |
| `prompt_sha256`, `prompt_chars` | fingerprint only; text is stored only with `--audit-prompts` |
| `prev_hash`, `hash` | the chain |

`run.json` beside it records the resolved config, its hash, the ULT version and the policy version.
`opt claude optimize audit <run> [--verify]` prints the summary or checks the chain.

## 5. Flags

```
opt claude optimize [project-dir] [flags] [-- <claude args>]

  --mode shadow|route          shadow records only (default); route acts
  --sandbox docker|host        docker (default) or host: no sandbox, for development
  --workspace copy|rw|ro       copy (default) · rw mounts the real checkout · ro read-only
  --model <id>                 main model for Claude Code (default: config.remote.defaultModel)
  --local-model <ollama tag>   local target, e.g. qwen2.5-coder:1.5b; enables local routes
  --no-local                   disable every local route
  --ollama-url <url>           default http://host.docker.internal:11434 (docker), 127.0.0.1 (host)
  --jev / --no-jev             ask Jev when rules are unsure (needs JEV_API_KEY)
  --route <class>=<target>     override one route, repeatable (e.g. non-coding/*=remote:claude-haiku-4-5)
  --pin frontier               keep everything on the requested model, still classify and audit
  --config <file>              extra config layered last
  --audit-prompts              store prompt text in the audit (off by default)
  --port <n>                   ULT port (default 8787)
  --dry-run                    print the resolved config and the commands, start nothing
  --auth [token]               credential for this session, ahead of Keychain/.env/1Password; kind from the
                               value (sk-ant-oat… subscription, sk-ant-api… API key). Alone: hidden prompt;
                               env:NAME: a variable; -: stdin. --save keeps it in the Keychain.
  --skip-auth-check            start even if the pre-launch credential check fails

opt claude optimize audit [run] [--verify] [--json]   summary of a run's decisions, or check its hash chain
opt claude optimize status                             running optimize sessions
opt claude optimize install-command                    install the /optimize slash command for Claude Code
opt claude optimize login | logout                     store / remove the Claude subscription token the sandbox uses
opt claude optimize clean                              remove containers left by a crashed or killed session
```

**The agent is a level of the command** (`opt <agent> optimize`) so other coding agents (Codex CLI,
Aider, …) can be added beside Claude Code; `AGENTS` in `optimize-live.mjs` is the registry, with
`claude` as its only entry today. The older `opt optimize` still works and prints the new name.
`SPEC.md` §10 lists it as `opthub claude optimize`, apart from the offline `opthub optimize` of Phase 1.

`/optimize`, typed inside an ordinary Claude Code session, cannot move that session into a sandbox.
It explains the mode and gives the command to relaunch with `opt claude optimize` in the same directory.

## 6. Configuration

Layered, later wins: `config/ult.default.json` (ships) → `$OPT_HOME/ult.json` (user) →
`<project>/.opthub/ult.json` (project, committable) → `--config` → flags.

```json
{
  "version": 1,
  "mode": "shadow",
  "remote": { "provider": "anthropic", "baseUrl": "https://api.anthropic.com", "defaultModel": null },
  "local":  { "enabled": true, "baseUrl": "http://host.docker.internal:11434", "model": "qwen2.5-coder:1.5b", "numCtx": 32768 },
  "classifier": {
    "rules": true,
    "jev": { "enabled": false, "endpoint": "https://api.typesafe.ai/v1/systemone", "model": "jev-1.13.0",
             "timeoutMs": 1500, "minRuleConfidence": 0.6 },
    "context": { "persist": true, "historyPerSession": 50 }
  },
  "policy": {
    "version": "v14",
    "neverDowngrade": ["review/security", "coding/debug"],
    "routes": {
      "background/utility": "local",
      "non-coding/*": "remote:claude-haiku-4-5",
      "coding/*": "keep", "review/*": "keep", "unclear": "keep"
    },
    "economics": { "requireSaving": true, "assumeCachedPrefix": true },
    "stickyThreads": true
  },
  "audit": { "prompts": false },
  "prices": { "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10], "claude-haiku-4-5": [1, 5] }
}
```

The block above is abridged. The shipped defaults, including `policy.minConfidence`,
`policy.localWithTools`, prices, cache multipliers and the per-model `models` adapter table, are
`sandbox/e2b/config/ult.default.json`.

## 7. What this does not do yet — and why

| not yet | why | when |
|---|---|---|
| **Scoped context (C3)**: fork a turn into a small fresh context before routing | Rewriting `messages` in the proxy changes what the agent sees; it needs the replay gate first | RO phase 2 |
| Resume a host session inside the sandbox | Transcripts are keyed by working directory, which differs inside the container | RO phase 2 |
| E2B as the sandbox | The Docker path proves the loop locally first; E2B needs a tunnel for the terminal | RO phase 2 |
| Central policy push, team audit view | `SPEC.md` §5.4 centralising is a separate epic | RO phase 3 |
| Gates on live decisions | Live traffic has no baseline arm; shadow-mode audits feed the replay loop instead | by design |

**Consequence of the economics check.** Without scoped context, routing a long main-thread turn to a
cheaper model usually costs more than keeping it, because the prefix is re-bought uncached. In
`route` mode today, most real savings come from local answers to background calls and from threads
that start small (subagents). The audit log shows the estimate either way, which is the evidence
phase 2 needs.

## 8. Acceptance — status 2026-09-30

- [x] `opt claude optimize --dry-run` prints the resolved config and the exact container commands.
- [x] ULT classifies, decides, forwards (stream and non-stream), adapts, falls back and audits:
      `npm test` in `sandbox/e2b` runs 66 checks against fake upstreams, all passing.
- [x] The audit chain verifies; editing or deleting any line breaks verification.
- [x] Local route answered by a real Ollama (`qwen2.5-coder:1.5b`, Ollama 0.18) through ULT.
- [x] Context persists across ULT restarts; a turn keeps its class through its tool loop and a
      "go ahead" continues it.
- [x] **Live route, host mode:** a real `claude -p` session classified `non-coding/summarize`, routed
      to Haiku 4.5 (thread pinned), answered correctly: **$0.0645 vs $0.2581** priced at the requested
      Opus 5.5 on the same usage. Haiku added one detail not in the source ("exponential" backoff),
      which is the quality risk the replay grade exists to catch.
- [~] **Docker sandbox:** the full path works (agent container → ULT container → api.anthropic.com,
      error relayed to Claude Code), but the OAuth token in `sandbox/e2b/.env` is rejected (`401`), so
      no answered request yet. Needs a fresh `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) or
      `ANTHROPIC_API_KEY`.
- [ ] Interactive session in the Docker sandbox, driven by a developer, end to end.
- [ ] Shadow-mode week on real work, then compare decisions to blind replay grades.

## 9. Findings from the first live runs (2026-09-30)

1. **The first request of a session is the expensive one.** With the developer's global MCP servers
   loaded, Claude Code's first request carried **123 tools and 152k tokens**, written to the 1-hour
   cache at 2x input: $0.76 on Opus 5.5 before any work. With `--strict-mcp-config` the same session
   cost $0.11. This is evidence-catalog replay candidate #3 (tool definitions), seen on this machine.
2. **Cache writes must be priced by TTL.** The API splits `cache_creation` into 5-minute and 1-hour
   tokens; pricing all writes at 1.25x undercounted this session by about 40%. ULT now prices each.
3. **Routing needs a per-model adapter.** Four distinct `400`s from one routed request (§4.2 item 6).
   Without the fallback, each would have been a failed turn for the developer.
4. **The byte estimate undercounts real input** (100k estimated vs 152k billed). The economics check
   errs toward routing; calibrating it from returned usage per thread is the next change.

## 10. Overlap to resolve: two routers named LLM Light

On 2026-09-30 a parallel session added `llmlight.mjs`, `lib/llmlight.mjs`,
`config/llmlight-profiles.json` and `assets/llmlight_router.py` to `sandbox/e2b`: **LiteLLM with a
Python routing hook**, five named profiles (laptop-guarded, laptop-balanced, sandbox-lean, ci-strict,
frontier-governed), tier routing (frontier / mid / small) keyed by the model name Claude Code asks for,
classes baked in from Triage (where Jev answered offline), targets local / sandbox (Bedrock) / mock, and
applied per project through `.claude/settings.local.json`.

| | ULT (this epic) | LLM Light profiles |
|---|---|---|
| runtime | Node, no dependencies | LiteLLM + Python callback |
| decision | per request: rules → Jev → persisted context | per request: request kind + baked Triage classes |
| local models | Ollama, Anthropic API | not yet |
| audit | hash-chained | JSONL |
| model adapter | yes, from live 400s | via LiteLLM |
| named profiles | no | yes |

**Proposed convergence:** keep ULT as the engine behind `opt claude optimize` and compile LLM Light
profiles into ULT config (`opt claude optimize --profile sandbox-lean`), so a profile is the named preset
and ULT is what runs. Not done yet — it needs the owner of the parallel work to agree.
