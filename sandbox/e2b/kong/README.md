# Kong AI Gateway sandbox template

Claude Code, unmodified, talking to Bedrock through Kong.

    ANTHROPIC_BASE_URL=http://127.0.0.1:8000
    ANTHROPIC_API_KEY=sk-kong

`llm_format: anthropic` on `ai-proxy-advanced` is what makes that work: the
client keeps speaking its normal protocol and the gateway translates. It never
learns which model answered, whether the answer came from a cache, or that its
prompt was rewritten on the way out.

## Why this template exists

Everything in `../../config/optimizations.json` marked `runnable: false` is a
lever that has to sit *in the request path*. From a client you cannot semantically
cache, you cannot compress someone else's prompt, and you cannot rate-limit
yourself honestly. This template is where those become runnable.

## The three files

| file | what it is |
|---|---|
| `kong.yaml` | one point in the parameter space — the config Kong actually loads |
| `optimization-params.yaml` | the space itself: every knob, its range, its default, what it trades against |
| `start.sh` | boots redis + kong, validates the config, and prints which AI plugins actually loaded |

`optimization-params.yaml` is the spec. Entries that carry an `experiment:` key
already have a runnable arm in `config/optimizations.json`; entries without one
are levers this harness has not tried yet. It also has a
`not_available_at_the_gateway` section, because the split between what a gateway
can do and what only the client can do is the useful part, and leaving it out
would read as an omission.

## Build

    e2b auth login
    ./build.sh harness-kong          # MEMORY_MB=4096 CPU_COUNT=2 by default

Then in `.env`:

    E2B_KONG_TEMPLATE=harness-kong

Four processes share the box — Kong (~300MB), Redis (~40MB), the prompt
compressor (~250MB when enabled), Claude Code (~220MB). 2GB OOMs; 4GB is the
floor.

## Turning a lever on

Every AI plugin except `ai-proxy-advanced` and `file-log` ships `enabled: false`.
That is deliberate: each one is an independent variable, and turning two on at
once produces a number nobody can attribute. Flip exactly one, rebuild, run
against the same session, and compare.

    deck file validate -s kong.yaml   # catches the typo before the gateway boots without your plugin

## Two defaults that will bite

* **`max_request_body_size` defaults to 1MB.** An agent request carrying whole
  files is routinely larger, and above the limit Kong stops introspecting the
  body — so the cache and the compressor silently stop applying to exactly the
  requests worth optimising. It is raised to 32MB in `kong.yaml`.
* **`read_timeout` defaults to 60s.** Agent turns are longer than that. Raised
  to 600s on both the service and the balancer.
