# Local inference capacity: knowing there is room before routing to Ollama

**Status:** proposal, 2026-10-23. Nothing here is built yet. **Applies to:** the `local` route of
ULT (`opt claude optimize`, [`runtime-optimization.md`](runtime-optimization.md) §4.2, story RO-4).
**Code today:** `app/lib/ult/server.mjs`, `app/lib/ult/upstream.mjs`, `app/config/ult.default.json`,
`app/lib/models.mjs`.

Routing work to a local open-weights model only saves money if the machine can actually serve it:
the model has to fit in memory, the full prompt has to fit in its context, and the answer has to
come back about as fast as the remote one would. Today the router checks none of this, and a local
machine does not scale. This document describes the gap and a three-layer fix.

---

## 1. What happens today

| | today |
|---|---|
| what goes local | only `background/utility` requests (`policy.routes`), to `qwen2.5-coder:1.5b` (`local.model`) |
| when it falls back to remote | only after the local call **fails** (`server.mjs`: any non-ok response except 401/403) |
| local timeout | `local.timeoutMs` = **120 000 ms** |
| check that the model fits in memory | none |
| limit on concurrent local requests | none |
| time-to-first-token budget | none |
| context length sent to Ollama (`num_ctx`) | not set: `sanitizeForLocal` strips unsupported fields but sets no options |

Two consequences follow.

1. **Overload is slow, not loud.** Ollama does not reject a request when it is busy; it queues it,
   and returns an error only when the queue itself is full. A saturated or cold Ollama therefore costs
   up to two minutes per request before the router falls back, and every waiting second is the
   developer's.
2. **Long prompts may be truncated silently.** Ollama's default context window is a few thousand
   tokens unless `num_ctx` (or `OLLAMA_CONTEXT_LENGTH`) says otherwise. Claude Code requests can be far
   longer. A local answer computed from a truncated prompt is a correctness problem, and it is likely
   the bigger risk.

## 2. The reference machine

Read from the development Mac on 2026-10-23 (`sysctl hw.memsize`, `ollama --version`, `GET /api/tags`,
`GET /api/ps`). This is an inventory, not a measurement of throughput.

| | |
|---|---|
| memory | 48 GiB unified (51 539 607 552 bytes) |
| Ollama | 0.35.1; no `OLLAMA_NUM_PARALLEL` or `OLLAMA_CONTEXT_LENGTH` override set |
| loaded at the time | none (`/api/ps` empty): the first local request pays a model load |
| pulled models (size on disk) | `qwen2.5-coder:1.5b` 1.0 GB · `tev1:0.8b` 0.8 GB · `qwen3.5:2b` 2.7 GB · `qwen3.5:4b` 3.4 GB · `tev1:latest` 4.5 GB · `llama3.1:latest` 4.9 GB · `llama3.1:70b` 42.5 GB · `nomic-embed-text` 0.3 GB |

The small models fit with plenty of room. `llama3.1:70b` takes nearly all of the memory for its
weights alone, before any context. **How fast any of them serve two or three requests at once has not
been measured.** That is layer 3 below.

## 3. What "enough" means

A local route is safe for one request when all three hold:

1. **It fits:** the model's weights plus the KV cache for the context it will be given fit in free
   memory, alongside whatever else is loaded.
2. **The prompt fits:** the request's token count is within the `num_ctx` the model runs with.
   Otherwise route remote; never truncate.
3. **It is fast enough now:** a slot is free, and the first token arrives within a budget the
   developer would not notice compared with the remote model.

## 4. The fix, in three layers

### Layer 1: fit check before routing

- Read the model's parameters and native context length from `POST /api/show`, and what is loaded and
  its memory use from `GET /api/ps` (`app/lib/models.mjs` already reads both for the models catalog).
- Estimate the memory needed as weights plus KV cache at the chosen `num_ctx`, and compare it with
  free memory. If it does not fit, the local route is unavailable: route remote and record
  `capacity: no-fit` in the audit log.
- Set `num_ctx` explicitly on every local request. Count the request's tokens first; above `num_ctx`,
  route remote with `capacity: context`.
- Show the result in `opt models` and the hub's models catalog: *fits, at what context*, or *does not
  fit*, and why.

### Layer 2: admission control at request time

This is the answer to "there is no scale": don't scale the laptop, refuse work it cannot take.

- **Cap requests in flight** at what Ollama runs in parallel for that model. Above the cap, go remote
  at once (`capacity: busy`) instead of joining Ollama's queue.
- **Time-to-first-token budget** of a few seconds, replacing the 120 s wait. Past the budget, abort
  the local call and go remote (`capacity: slow`).
- **Circuit breaker:** after repeated `busy`, `slow` or failed local calls, stop routing locally for a
  few minutes, then probe again.
- **Warm-up:** when the launcher starts, load the local model (a one-token request) so the first real
  request doesn't pay the load. Keep it loaded for the session (`keep_alive`).

Every capacity fallback goes into the audit log with its reason, beside the existing `fallback_from`.

### Layer 3: measure the machine

- New command `opt models bench [model]`. It runs only local inference, so it is free.
- It sends prompts at the sizes Claude Code actually sends (taken from transcript token counts,
  bucketed) at concurrency 1 to N, and records time to first token, prefill and decode tokens/second,
  and peak memory.
- It writes a per-machine capacity profile under `OPT_HOME`. Layer 2 reads its cap and budget from
  that profile instead of guessing.
- Same rules as every other number in this repo: three repeats minimum, and the profile records the
  machine, Ollama version, model and date it was measured on.

## 5. Scale beyond one machine

Local inference is one machine per developer, by design. That fits the current policy, which sends
only small, short background calls local. For a team:

- point `local.baseUrl` at a **shared inference server** (Ollama or vLLM on a GPU box). Layers 1 to 3
  apply unchanged; the server gets its own capacity profile, and the in-flight cap becomes a shared
  budget across developers; or
- route the same classes to a **cheap remote model** (for example Haiku), which scales without
  capacity planning and is already a route in the policy.

## 6. How it shows up in the savings

A local route is only a saving if it is actually taken. The hub should report, per local route:

- requests routed local versus capacity fallbacks, by reason (`no-fit`, `context`, `busy`, `slow`);
- the latency the developer saw on local answers next to remote ones.

A route that keeps getting refused then reads as "not paying off on this machine", not as a saving.
Savings claimed from local routes stay labelled `guess` until layer 3 has measured the machine they
ran on.

## 7. Build order

1. Layers 1 and 2: guards in the router, tested against a fake Ollama (slow, busy, small context,
   no-fit) in `app/test/ult.test.mjs`. No network, no spend.
2. Layer 3: `opt models bench` and the capacity profile; layer 2 switches from defaults to the profile.
3. Hub: capacity fallbacks and local latency next to the savings.
