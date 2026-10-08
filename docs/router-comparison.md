# Model routers — comparison against opthub

*Started 2026-09-22. Working document; rows are meant to be revised as each router is actually tried.*

Every router here makes the routing decision **before the answer exists**, from the prompt.
opthub makes it **after the answer exists**, from a graded replay. That is the gap this table
tracks. "Sandbox difficulty" means: how hard is it to stand this up inside opthub's E2B / Docker
sandbox or on a developer laptop so a real session can be replayed through it.

## Summary table

| # | Router | Category | Decision made by | Quality check on the answer | Sandbox / dev-machine difficulty | Overlap with opthub |
|---|---|---|---|---|---|---|
| 1 | [pi-model-router](https://github.com/alexei-led/pi-model-router) (Alexei) | dev routing | external advisor (Jev) per turn, else fixed baseline | none — advisor's self-reported confidence only | **easy** locally · **medium** in sandbox | `model-routing`, `effort-tuning` levers, applied live |
| 1a | [claude-router](https://github.com/alexei-led/claude-router) (Alexei) — *added 2026-10-08* | dev routing, **inside Claude Code** | classifier (Jev, or Cloudflare's Clef / Clef Flash) once per turn + local cache-cost policy | none — README: savings not measured | **easy** — `claude --plugin-dir`; classifier egress needed in sandbox | the transport epic MOD copies; arm E-R1 in the replay loop |
| 2 | [RouteLLM](https://github.com/lm-sys/RouteLLM) (LMSYS) | dev routing | trained classifier per request | offline benchmarks (MT-Bench, GSM8K), not your workload | **medium** | prior art for the accuracy gate's cost-vs-quality curve |
| 3 | [LiteLLM](https://github.com/BerriAI/litellm) Router / Proxy | runtime for agents | config: fallbacks, load-balance, budget | none — availability & cost, not quality | **easy** — already in `template/` | the A/B seam opthub already runs through |
| 4 | [Kong AI Gateway](https://docs.konghq.com/hub/?category=ai) | runtime for agents | plugins: semantic routing, semantic cache, limits | none — embedding similarity on the prompt | **medium–hard** — already in `template/kong/`; semantic plugins need Enterprise + vector store | source of opthub's 13-lever catalog |
| 5 | Hosted routers — [Not Diamond](https://www.notdiamond.ai/), [OpenRouter auto](https://openrouter.ai/), [Martian](https://withmartian.com/) | other (paid service) | vendor black box | vendor's own benchmark | **trivial to call, impossible to sandbox** — decision lives off-machine | a candidate lever to test, not an alternative |

Difficulty scale: **easy** = one install + one key, runs offline or with one allow-listed egress ·
**medium** = extra runtime (Python env, model weights, container) or a second vendor in the request path ·
**hard** = licence, GPU, or infrastructure (vector DB, DB-backed gateway) ·
**impossible** = the routing decision cannot be brought inside the sandbox at all.

---

## 1. `alexei-led/pi-model-router` (Alexei's repo)

**Main purpose:** dev routing — a per-turn model picker inside one coding agent (Pi), for a
single developer's own sessions.

**Five main use cases**
1. **Cheap answers for cheap questions.** "what is 7+5" or "read package.json" goes to a
   micro/low model instead of the frontier one.
2. **Frontier model for design and debugging.** Ambiguous bugs, tradeoffs, multi-constraint design
   go to the high tier with thinking on.
3. **Soft spend cap per session.** Above a dollar threshold, unpinned requests are pushed to
   medium-or-lower tiers.
4. **Manual override when the router is wrong.** `/router pin high`, `/router fix <tier>`,
   per-tier thinking overrides; the pin survives restarts.
5. **Fallback chains across providers.** If the chosen model fails before emitting anything,
   retry a configured alternative, possibly at another vendor.

**How hard to run in a sandbox / on a dev machine — easy locally, medium in sandbox**
- Needs Pi ≥ 0.86 and Node ≥ 22.19; install is `pi install npm:@alexeiled/pi-model-router`
  plus a `model-router.json` with provider keys. On a laptop this is minutes.
- The advisor (Jev) is a **second vendor in the hot path**: needs a TypeSafe API key and egress
  to `api.typesafe.ai` allow-listed in the sandbox proxy. Without the key it silently falls back
  to a fixed baseline, so a replay "with routing" must assert the key was actually used.
- **It routes Pi, not Claude Code.** To replay an opthub session through it, the session's
  prompt must be re-driven through Pi, or the routing logic lifted out (~300 lines in
  `extensions/jev.ts` + `routing.ts`) into an adapter in front of Claude Code.
- Adds ~0.7 s median per user turn (Alexei's own measurement, 24 tasks, range 284–841 ms).

**Overlap with opthub:** use cases 1–3 are opthub's `model-routing` and `effort-tuning` levers,
applied live rather than proposed after measurement. The difference is who decides: Alexei's
router trusts the advisor's self-reported confidence every turn; opthub replays the session in a
sandbox and blind-grades whether the cheaper arm did the same job. Alexei's repo has no
measurement of quality lost, and does not charge the advisor's own cost or latency against the
saving. His own validation shows the advisor's confidence moved from ~30% to ~90% on identical
inputs when he reworded the tier descriptions — the same instability opthub's stability gate
(§6.5) exists to catch.

---

## 1a. `alexei-led/claude-router` (Alexei's Claude Code version) — *added 2026-10-08*

**Main purpose:** dev routing for **Claude Code** — the Pi router's idea moved into a Claude Code Mod.
Read at commit `7599fb5` (1.3.0, 2026-10-06, MIT).

**What changed against row 1.** The objection under row 1 — "it routes Pi, not Claude Code" — no
longer holds. Since 1.0.0 the router is a `turn.step` hook: it changes only model and effort on the main
conversation, and Claude Code builds the request, holds the credentials, runs the tools and streams.
Subagent steps pass through unchanged. There is no proxy, no port and no model adapter.

**How it decides.** The classifier sees the prompt and up to six recent messages, 1,200 characters each,
once per turn; tool continuations keep the choice (`docs/architecture.md`). A local policy then:
- prices a switch as the candidate's worst-case cache write minus the incumbent's best-case cache read,
  from the last response's usage;
- raises the bar to switch as that cost rises;
- needs repeated votes for an upgrade, and a payback horizon for a downgrade;
- drops a model at 80% of its context window (`lib/policy.mjs`, `lib/native-cost.mjs`).

Classifier deadlines are 1,500 ms for Jev and 3,000 ms for Clef; three failures pause it for 60 s.

**What its own evaluation says** (`docs/evaluation.md`, one developer, list prices, no quality review):
- 15.5% below always-Opus-xhigh, and 4.1% below the strongest model per whole session.
- A native shadow replay: 0 of 37 advised decisions routed differently.

**How hard to run here — easy.** `claude --plugin-dir <checkout>` with a Jev key or a Cloudflare token.
In the sandbox the egress allow-list needs `api.typesafe.ai` or Cloudflare. Without a key the router
silently keeps the baseline model, so a replay must assert the classifier was reached.

**Overlap with opthub:** the transport epic MOD copies for capture and shadow routing (`docs/epic-mod.md`).
It is also the first router to run as an arm (E-R1, MOD-4), since it is the closest to what developers
will actually install. One difference to keep: it sends prompt text to the classifier, which opthub's
classifier contract (counts and flags only) does not allow.

---

## 2. RouteLLM (LMSYS)

**Main purpose:** dev routing — a trained classifier that decides per request whether a strong or
weak model is needed, exposed as an OpenAI-compatible endpoint.

**Five main use cases**
1. Cut API bill on chat/QA traffic by sending easy prompts to the cheap model.
2. Tune one cost/quality dial (a threshold) instead of picking a single model.
3. Benchmark routers on public evals before deploying.
4. Train a custom router on your own preference data.
5. Serve the router as a local proxy in front of existing apps with no code change.

**How hard to run in a sandbox / on a dev machine — medium**
- `pip install "routellm[serve]"`, then a small server; the default `mf` router is a small
  matrix-factorisation model downloaded from Hugging Face (egress to `huggingface.co` needed
  once, then cacheable in the image). The BERT and causal-LLM routers are heavier and want a GPU.
- Needs keys for both the strong and the weak model.
- Speaks the **OpenAI** API. Claude Code speaks the Anthropic API, so LiteLLM must sit between
  them (`Claude Code → LiteLLM → RouteLLM → provider`) — three hops, all already available in
  `template/`.
- Router is trained on single-turn chat preferences; an agent turn with 200k of tool output is
  out of distribution. Expect it to be confidently wrong on long sessions.

**Overlap with opthub:** the most relevant prior art for the accuracy gate — RouteLLM publishes
*quality retained vs. cost saved* curves, which is the shape of the number opthub wants from a
replay. It routes single prompts, not 700-turn sessions, and says nothing about the prompt-cache
invalidation a model switch causes, which opthub found is the real cost of switching
(`docs/optimizers-cookbook.md`, F6).

---

## 3. LiteLLM Router / Proxy

**Main purpose:** runtime for agents — a gateway in front of many providers that load-balances,
retries, and budgets.

**Five main use cases**
1. One API key and one endpoint for every provider.
2. Fallbacks and retries when a provider is down or rate-limited.
3. Per-team / per-key spend limits and budgets.
4. Load-balancing across several deployments of the same model.
5. Logging and cost attribution per request.

**How hard to run in a sandbox / on a dev machine — easy**
- `pip install "litellm[proxy]"` or the official Docker image; one `config.yaml`.
- Already running inside opthub's E2B template as the A/B seam; Claude Code is pointed at it
  via `ANTHROPIC_BASE_URL`. No new egress, no new vendor.
- Routing strategies are latency-, cost-, or usage-based — **not** "is this prompt hard". A
  quality-based router has to be plugged in front of it (see RouteLLM) or written as a custom
  routing strategy.

**Overlap with opthub:** infrastructure opthub runs experiments *through*, not a competitor. Its
per-request cost log is the same data opthub's wire-level capture wants to own with its own
retention.

---

## 4. Kong AI Gateway (and Portkey, same class)

**Main purpose:** runtime for agents — an enterprise gateway with one plugin per lever: caching,
prompt guards, rate limits, semantic routing.

**Five main use cases**
1. Semantic routing: pick a model by embedding similarity of the prompt to configured intents.
2. Semantic caching: return a stored answer for a near-duplicate question.
3. Prompt compression / decoration applied centrally.
4. Token- and cost-based rate limiting per consumer.
5. Governance: PII guards, audit logs, allow-listed models.

**How hard to run in a sandbox / on a dev machine — medium to hard**
- Basic `ai-proxy` runs DB-less from one container with a declarative YAML; opthub already has
  this in `template/kong/` in front of Bedrock, with Claude Code unmodified.
- The interesting plugins — semantic routing (`ai-proxy-advanced`), semantic cache — are
  **Enterprise-tier at time of writing** (verify against current Kong licensing) and need an
  embedding model plus a vector store (Redis) alongside the gateway. That is three containers and
  a licence inside the sandbox.
- Portkey's open-source gateway is a single Node container and easy, but its routing is
  config-driven (weights, fallbacks), not semantic.

**Overlap with opthub:** opthub's lever catalog is taken from Kong's plugin surface (13 levers,
4 marked gateway-only). Kong supplies the *knobs*; opthub asks whether turning one on a real
session was worth it. Kong's semantic router has the same weakness as Alexei's Jev call — the
decision is made from the prompt before the answer exists, with no check on the answer.

---

## 5. Hosted routers — Not Diamond, OpenRouter "auto", Martian

**Main purpose:** other — a paid service that picks the model for you, sold on "best quality per
dollar".

**Five main use cases**
1. Zero-config routing for an app that does not want to choose models.
2. Automatic migration to newer models as they appear.
3. Per-request cost/latency preference ("cheapest that meets quality X").
4. Joint benchmarking across vendors from one place.
5. Fallback across vendors during outages.

**How hard to run in a sandbox / on a dev machine — trivial to call, impossible to sandbox**
- One API key and one egress allow-list entry; OpenRouter is OpenAI-compatible so it also needs
  LiteLLM in front of Claude Code. Not Diamond has its own SDK.
- The routing decision, the model list, and the pricing all live on the vendor's side. Nothing
  can be pinned, nothing can be replayed identically next week, and the sandbox's egress
  allow-list has to open to whichever upstream the vendor chose. This breaks opthub's
  content-hash provenance for a baseline (SPEC §5.2).

**Overlap with opthub:** the commercial form of Alexei's advisor — the signal is a black box,
the confidence is the vendor's, and the quality claim is on the vendor's benchmark, not on your
workload. A hosted router is a candidate lever for opthub to test, not an alternative to it.

---

## Open items

- [ ] Actually run #1 on one exported session (needs Pi installed in the sandbox + TypeSafe key).
- [ ] Run #1a as arm E-R1 — three sessions, three repeats, blind grade (`docs/epic-mod.md` MOD-4). Easier than #1: no Pi needed.
- [ ] Run #2 behind LiteLLM on the same session; compare blind scores.
- [ ] Confirm Kong semantic-routing licence status before budgeting #4.
- [ ] Add a "cost of the router itself" column once #1 and #2 have real numbers.
- [ ] Reference this file from `docs/optimizers.md` §3.4 as prior art for `model-routing`.
