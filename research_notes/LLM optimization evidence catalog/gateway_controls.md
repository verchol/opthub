# Gateway-level LLM cost controls: semantic/exact caching, Batch APIs, rate and budget limits

Scope: public evidence (retrieved 2026-09-29) on gateway-level cost controls, each translated into ready-to-paste config where the keys were verified in vendor docs during this pass. Evidence-strength labels: **measured-production**, **benchmark**, **vendor-claim**, **anecdote**, **vendor-doc (spec)** (a documented product behavior or price, not a savings claim). "Client" means it runs from Claude Code alone. "Gateway" means it needs a proxy in the request path.

Overall read: nearly every hit-rate or savings number in this space is a vendor claim or a secondary blog that aggregates vendor claims. The only primary, spec-level facts that bear on opthub's batch mechanism come from Anthropic's own docs, and they support it (details in Q3).

---

## Q1. What semantic-cache hit rates are measured in production, on which workloads, and is there evidence for coding/agent workloads?

### Takeaway
The production hit rates that get cited cluster at **~10–45%** (Portkey ~20% on RAG, which is the most-cited "production" figure). Benchmarks on curated datasets report 60–90%. No source gives a *measured* semantic-cache hit rate for coding-agent traffic. The only coding figure (5–15%) is an unsourced blog estimate. Several gateways' docs design semantic cache so that it **skips multi-turn/agentic requests**, so for Claude Code traffic the expected hit rate is roughly zero by design.

### Cited Findings
- **Hit-rate table by workload** (blog by Gaurav Dagde, originally on preto.ai, April 2026; the author cites sources without links, so treat it as **anecdote/aggregate**): FAQ/support 40–60%; classification 50–70%; internal KB Q&A 30–45%; RAG 15–25%; open-ended chat 10–20%; **code generation 5–15%**. Cited "production" points: Portkey ~20% (RAG, 99% match accuracy), an EdTech platform ~45%, a mixed-traffic estimate of 30–40%. The academic "GPT Semantic Cache" result is 61–69% on a curated benchmark. The post's core claim: "The 95% number refers to *accuracy* of cache matches, not frequency of hits." — [DEV/preto.ai](https://dev.to/gauravdagde/llm-semantic-caching-the-95-hit-rate-myth-and-what-production-data-actually-shows-8ga); [Preto.ai original](https://preto.ai/blog/semantic-caching-llm/)
- **Portkey production claim**: "over 250 million cache requests", ~99% user-rated accuracy from backtesting ~5,000 queries. A food-delivery customer is said to have cut LLM spend by "over $500K" with caching. **Vendor-claim** — [Portkey blog: Semantic caching thresholds](https://portkey.ai/blog/semantic-caching-thresholds/)
- **AWS benchmark as reported by Portkey** (Claude 3 Haiku + Titan embeddings), by threshold, as hit rate / accuracy / cost saving: 0.99 → 23.5% / 92.1% / 15.8%; 0.95 → 56.0% / 92.6% / 51.9%; 0.90 → 74.5% / 92.3% / 72.5%; 0.80 → 87.6% / 91.8% / 84.6%; 0.75 → 90.3% / 91.2% / 86.3%. Headline: "reduced cost by up to 86% and improved latency by 88%". **Benchmark (secondary report of an AWS test; the original AWS post was not fetched)** — [Portkey blog](https://portkey.ai/blog/semantic-caching-thresholds/)
- Production hit rates of 20–45% are "realistic" for FAQ/support/search, and long-tail conversational agents see 10–25%. **Anecdote/aggregate** — [TianPan.co, 2026-04-09](https://tianpan.co/blog/2026-04-09-semantic-caching-llm-production); [Braintrust: LLM gateway caching](https://www.braintrust.dev/articles/llm-gateway-caching) (these appeared in search results; the full pages were not fetched)
- **Bifrost by design skips multi-turn conversations**: `conversation_history_threshold` (default 3) means "skip caching when a conversation has more than this many messages." A semantic miss also adds "the embedding call *on top of* the full LLM call". **Vendor-doc (spec)** — [Bifrost semantic caching docs](https://docs.getbifrost.ai/features/semantic-caching)
- **Portkey semantic cache limits**: it only works on "requests under 8,191 tokens and ≤4 messages", "the system prompt is ignored — changing it does not affect cache hits", and it is available only "on select Enterprise plans" (simple cache is on all plans). Portkey's claim: "up to 20x faster". **Vendor-doc (spec) + vendor-claim** — [Portkey cache docs](https://portkey.ai/docs/product/ai-gateway/cache-simple-and-semantic)
- **Cloudflare AI Gateway is exact-match only**: the key hashes provider, endpoint, model, auth header and the "full request body". "Any difference in the body — including messages, tools, or model parameters — will result in a separate cache entry." Semantic caching is planned but not supported, and the cache is "volatile". No hit-rate numbers are given. **Vendor-doc (spec)** — [Cloudflare AI Gateway caching](https://developers.cloudflare.com/ai-gateway/features/caching/)
- **Helicone is exact-match only** (any change in content or params creates a new entry). No hit-rate numbers are given. **Vendor-doc (spec)** — [Helicone caching docs](https://docs.helicone.ai/features/advanced-usage/caching)
- **Kong ai-semantic-cache** documents no hit-rate or savings numbers, only qualitative benefits. **Vendor-doc** — [Kong ai-semantic-cache](https://developer.konghq.com/plugins/ai-semantic-cache/)

### Configs (keys verified in the cited docs unless flagged)

**LiteLLM proxy: semantic cache (Gateway)** — [docs](https://docs.litellm.ai/docs/proxy/caching)
```yaml
litellm_settings:
  cache: True
  cache_params:
    type: redis-semantic            # or qdrant-semantic
    redis_semantic_cache_embedding_model: text-embedding-ada-002
    similarity_threshold: 0.75      # raise toward 0.95+ to cut false hits (see Q2)
    ttl: 3600
    supported_call_types: ['completion', 'acompletion']
    mode: default_off               # opt-in per request; recommended for mixed traffic
# qdrant variant: type: qdrant-semantic, qdrant_semantic_cache_embedding_model: ...,
#   qdrant_collection_name: litellm-cache, qdrant_quantization_config: null
```
Per-request headers: `Cache-Control: no-cache` (bypass), `Cache-Control: no-store`, `Cache-Control: max-age=7200`/`s-maxage`, `x-litellm-cache-ttl: 1800`. Responses carry `x-litellm-cache-key`, which can be passed to `/cache/delete`. UNVERIFIED: my fetch summary said the LiteLLM page warns that semantic caching "goes badly wrong on agentic traffic". I could not confirm that exact wording, so do not quote it.

**Portkey (Gateway)** — [docs](https://portkey.ai/docs/product/ai-gateway/cache-simple-and-semantic)
```json
{ "cache": { "mode": "semantic", "max_age": 60 } }
```
Use `"mode": "simple"` for exact match. The force-refresh header is `x-portkey-cache-force-refresh: true`. Log statuses are `Cache Hit`, `Cache Semantic Hit`, `Cache Miss`, `Cache Refreshed` and `Cache Disabled`.

**Bifrost (Gateway)** — [docs](https://docs.getbifrost.ai/features/semantic-caching)
```json
{
  "name": "semantic_cache",
  "enabled": true,
  "config": {
    "provider": "openai",
    "embedding_model": "text-embedding-3-small",
    "dimension": 1536,
    "ttl": "5m",
    "threshold": 0.8,
    "conversation_history_threshold": 3,
    "exclude_system_prompt": false,
    "cache_by_model": true,
    "cache_by_provider": true
  }
}
```
Per-request headers: `x-bf-cache-key` (required for caching to engage), `x-bf-cache-ttl`, `x-bf-cache-threshold`, `x-bf-cache-type: direct|semantic`, `x-bf-cache-no-store: true`. For exact-only ("direct-only") mode, set `dimension: 1` and omit provider/embedding_model.

**Cloudflare AI Gateway: exact cache (Gateway)** — [docs](https://developers.cloudflare.com/ai-gateway/features/caching/)
Request headers: `cf-aig-cache-ttl: <seconds>` (minimum 60s, maximum one month), `cf-aig-skip-cache: true`, `cf-aig-cache-key: <custom>` (defaults to a 5 min TTL if no TTL is given). The response header is `cf-aig-cache-status`. The old `cf-cache-ttl`/`cf-skip-cache` headers are deprecated. Cloudflare rate-limiting config was NOT verified in this pass.

**Helicone: exact cache (Gateway)** — [docs](https://docs.helicone.ai/features/advanced-usage/caching)
```
Helicone-Cache-Enabled: true
Cache-Control: max-age=604800        # default 7d; max 31536000 (365d)
Helicone-Cache-Bucket-Max-Size: 1    # up to 20
Helicone-Cache-Seed: user-123        # optional namespace
Helicone-Cache-Ignore-Keys: <comma-separated JSON keys>
```
Responses carry `Helicone-Cache: HIT|MISS` and `Helicone-Cache-Bucket-Idx`.

**Kong ai-semantic-cache (Gateway), PARTIALLY VERIFIED**: the docs confirm these field names: `config.vectordb.strategy` (`redis` | `pgvector`), `config.vectordb.redis.*`, `config.vectordb.dimensions`, `config.vectordb.distance_metric`, `config.vectordb.threshold`, `config.embeddings.model.provider`, `config.embeddings.model.name`, `config.message_countback`, `config.exact_caching`, `config.ignore_system_prompts`, `config.ignore_assistant_prompts`, `config.ignore_tool_prompts`, and `cache_ttl`. I did NOT get a verbatim complete example, so assemble one from the [plugin page](https://developer.konghq.com/plugins/ai-semantic-cache/) rather than trusting a guessed nesting. Response headers: `X-Cache-Status: Hit|Miss|Bypass|Refresh`, `X-Cache-Key`, `X-Cache-Ttl`, `Age`.

**Claude Code-side equivalent**: none. Claude Code has no client-side response cache. Its cost lever is *provider* prompt caching (prefix reuse), which a gateway must pass through untouched. Pointing Claude Code at any of the gateways above uses `ANTHROPIC_BASE_URL` plus `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`/`apiKeyHelper` (see Q4).

### Inferences
- The number that matters for replay is hit *frequency* on the user's own traffic. For Claude Code, every turn carries a unique, growing conversation plus tool results, so exact-match hits should be about 0%. Semantic caches either skip such requests by design (Bifrost's >3 messages, Portkey's ≤4 messages and <8,191 tokens) or match only the last N messages (Kong `message_countback`), which invites wrong answers. Expected savings on coding-agent traffic are ~0%, with a nonzero correctness risk if forced on. opthub can verify this directly by counting exact-duplicate request bodies in the transcripts.
- The Portkey/AWS table shows accuracy staying at ~91–92% across thresholds while hit rate moves from 23% to 90%. That suggests the "accuracy" metric is not sensitive to false hits (or that the dataset is saturated with paraphrases), so the 86% saving is a best case on a paraphrase-heavy dataset.

### Gaps
- No public, measured semantic-cache hit rate for coding assistants or tool-using agents was found. The 5–15% "code generation" figure is unsourced.
- The original AWS blog post behind the Portkey table was not fetched, and its date and workload are unverified.
- Not found or verified in this pass: GPTCache paper/README numbers, TrueFoundry and OpenRouter caching docs.

---

## Q2. What false-positive / wrong-answer rates are documented for semantic caching?

### Takeaway
Documented false-hit rates are threshold-dependent and mostly come from blogs: **~8–15% false positives at 0.90 on broad chat**, and **<0.5% at 0.97, where hit rate falls to ~5–10%**. The strongest source is peer-reviewed: vCache (ICLR 2026) shows static thresholds give no correctness guarantee and reports up to **26× lower error rates** and **12.5× higher hit rates** than static-threshold baselines. Semantic caches are also attackable via embedding key collisions.

### Cited Findings
- At threshold 0.90, false positives "jump to 8–15% on broad chat workloads" (misfires are related-but-distinct questions). At 0.97, the FP rate is "under 0.5%" but the hit rate is "low (5-10%)". A Dataquest study reportedly found a 40.9% hit rate at 0.90 with "near-zero false positives" on its workload. The two claims conflict, which shows how workload-dependent FP rates are. **Anecdote/aggregate** — [Preto.ai](https://preto.ai/blog/semantic-caching-llm/) and [PremAI blog](https://blog.premai.io/semantic-caching-for-llms-how-to-cut-api-bills-by-60-without-hurting-quality/), both surfaced through search snippets. I did not attribute each number to one page in full-text reading, so verify before quoting.
- Threshold guidance: 0.85 is aggressive (more FPs, acceptable for FAQ), 0.92 is "sweet spot", 0.98 is near-exact. **Anecdote** — [DEV/preto.ai](https://dev.to/gauravdagde/llm-semantic-caching-the-95-hit-rate-myth-and-what-production-data-actually-shows-8ga)
- vCache: "static thresholds do not give formal correctness guarantees, result in unexpected error rates, and lead to suboptimal cache hit rates". It uses per-prompt online-learned thresholds with a user-defined error bound: "up to 12.5× higher cache hit and 26× lower error rates" versus static-threshold and fine-tuned-embedding baselines. It releases four benchmarks. arXiv v1 is dated 2025-02-06, v5 2026-02-21, and the paper was accepted at ICLR 2026. **Benchmark (peer-reviewed)** — [arXiv 2502.03771](https://arxiv.org/abs/2502.03771); [OpenReview](https://openreview.net/forum?id=zF0A0xw3HZ)
- Security: "Semantic caching is naturally vulnerable to cache collision". An attacker can craft adversarial inputs that trigger false-positive hits, which can serve one user's cached answer for another's query. **Benchmark (research)** — [arXiv 2601.23088, Key Collision Attack on LLM Semantic Caching, Jan 2026](https://arxiv.org/html/2601.23088v1)
- Portkey reports ~99% user-rated accuracy (backtest of ~5,000 queries), which implies a ~1% wrong-answer rate on its traffic mix. The AWS test as reported by Portkey shows 91–92% accuracy at every threshold. **Vendor-claim** — [Portkey blog](https://portkey.ai/blog/semantic-caching-thresholds/)

### Inferences
- For code, a "semantically similar" prompt ("fix the bug in auth.py" vs the same text after the file changed) usually needs a *different* answer, because correctness depends on repo state that is not in the embedded text. The FP risk is therefore structurally higher than for FAQ traffic. This is my reasoning, not measured.
- A safe default for any opthub recommendation: exact-match cache only, and only for deterministic single-shot calls (for example, title or summary generation with identical inputs). Semantic cache should stay `mode: default_off` / opt-in.

### Gaps
- No documented FP rate on code or agent workloads.
- vCache's per-baseline absolute error percentages (e.g., GPTCache at a given threshold) were not extracted, because the abstract only gives ratios. The full paper tables are needed.

---

## Q3. Does batch lose prompt-cache benefits? Any published numbers? (opthub's floor −$854 / ceiling +$254 mechanism)

### Takeaway
**Anthropic's docs confirm the mechanism.** Batch and caching discounts stack (a batch cache read costs 0.5 × 0.1 = **0.05× base**), but cache hits in batches are **"best-effort"**, with users typically seeing **30%–98%** hit rates. Cache pre-warming is **not supported inside a batch** because "an ephemeral cache entry written during batch processing would likely expire before the follow-up request runs." Anthropic also says, for Managed Agents, that the batch discount does not apply because "sessions are stateful and interactive." For a cache-heavy workload already at ~97% sync hit rate, batch needs about ≥89–91% in-batch hit rate just to break even on input cost. Because each agent turn depends on the previous response, Claude Code turns cannot be batched in any practical way. opthub's asymmetric floor/ceiling is consistent with primary-source pricing.

### Cited Findings
- "The pricing discounts from prompt caching and Message Batches can stack… However, because batch requests are processed asynchronously and concurrently, cache hits are provided on a best-effort basis. **Users typically experience cache hit rates ranging from 30% to 98%, depending on their traffic patterns.**" **Vendor-doc (spec, with a vendor-reported range)** — [Anthropic batch processing docs](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
- Anthropic's tips for maximizing batch cache hits: identical `cache_control` blocks in every request, "a steady stream of requests to prevent cache entries from expiring after their 5-minute lifetime", and "consider using the 1-hour cache duration… because batches can take longer than 5 minutes to process." — [same](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
- "`max_tokens: 0` (cache pre-warming) is not supported inside a batch, because an ephemeral cache entry written during batch processing would likely expire before the follow-up request runs." — [same](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
- Batch limits: 50% off all usage; most batches finish in under 1 hour, with expiry at 24h; 100,000 requests or 256 MB per batch; results kept 29 days. — [same](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
- Pricing multipliers: 5-minute cache write 1.25×, 1-hour write 2×, read 0.1× (0.05× on Opus 5.5, 0.025× on Fable 5.1). "These multipliers stack with other pricing modifiers, including the Batch API discount." Batch on Opus 5 is $2.50/$12.50 per MTok, vs $5/$25 standard. Fast mode is not available with Batch. **Vendor-doc (price)** — [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- For Claude Managed Agents, the Batch API discount does not apply: "Sessions are stateful and interactive. There is no batch mode." — [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- OpenAI Batch: "50% cost discount compared to synchronous APIs", `completion_window: "24h"`, 50,000 requests or 200 MB per batch, per-model enqueued-token limits. The batch guide says **nothing** about prompt caching in batch. **Vendor-doc** — [OpenAI Batch guide](https://developers.openai.com/api/docs/guides/batch)
- OpenAI caching and batch, conflicting evidence: a community thread (c. April 2025, no staff answer) says "caching isn't available for batch API requests" — [OpenAI community](https://community.openai.com/t/prompt-caching-in-batching-api/1223191). A June 2026 secondary blog says "Caching inside the Batch API works only on GPT-5-and-later models" and that Flex processing gives "the same 50% discount plus full prompt caching". It claims ~73–77% combined batch+cache savings across providers, but gives no OpenAI primary link — [LeanLM, June 2026](https://leanlm.ai/blog/llm-batch-api). OpenAI's prompt-caching guide (fetched) does not mention Batch. Current OpenAI terms per that guide for GPT-5.6+: "Cache-write pricing is 1.25× the standard uncached rate; cached reads cost only 0.1× that rate", with a 1,024-token minimum and 24h default retention for non-ZDR orgs — [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching). **Status: UNVERIFIED from primary source for OpenAI batch+cache stacking.**
- Gemini batch is 50% off and explicit context caching is supported in batch (e.g., $0.075/M quoted for gemini-3.5-flash). **Secondary only** — [LeanLM](https://leanlm.ai/blog/llm-batch-api). A Google primary doc was not fetched.

### Worked mechanism (my arithmetic from the Anthropic multipliers above; per unit of base input price)
| Scenario for a previously-cached prefix token | Multiplier |
|---|---|
| Sync, cache hit (today's 96.8%-hit coding workload) | 0.10× |
| Batch, cache hit (stacked) | 0.05× (**ceiling: saves 0.05×**) |
| Batch, miss with no cache write | 0.50× (**5× the sync cost**) |
| Batch, miss that writes 5-min cache | 0.625× |
| Batch, miss that writes 1-hour cache | 1.00× |

Break-even in-batch hit rate h for input tokens (misses plain at 0.5×): 0.05h + 0.5(1−h) = 0.10 → **h ≈ 0.89**. If misses write a 5-minute cache (0.625×), **h ≈ 0.91**. Anthropic's own reported range (30–98%) sits mostly below that break-even, and only output tokens (a flat 50% off) offset it. This matches the shape of opthub's result: a small upside (+$254) when batch keeps near-full caching, and a large downside (−$854) when the cache is lost.

### Client/gateway notes and configs
- **Claude Code has no batch mode.** `claude -p` (headless) is *unattended*, not *batched*: it calls the synchronous Messages API with normal prompt caching and gets no 50% discount. **Client.** Useful flags, verbatim from the [CLI reference](https://code.claude.com/docs/en/cli-reference):
  ```bash
  claude -p --max-budget-usd 5.00 --max-turns 20 --output-format json \
    --exclude-dynamic-system-prompt-sections "query"
  ```
  `--max-budget-usd`: "Maximum dollar amount to spend on API calls before stopping (print mode only). Spend from subagents counts toward the cap." Totals restored via `--continue`/`--resume` don't count toward it, and cap enforcement on subagents requires v2.1.217+. `--exclude-dynamic-system-prompt-sections` "Improves prompt-cache reuse across different users and machines running the same task."
- To actually batch, you must leave Claude Code and call the Message Batches API directly (Agent SDK/custom code) for **independent, single-shot** requests with a shared cached prefix, using `cache_control: {"type": "ephemeral", "ttl": "1h"}`. UNVERIFIED: the exact `ttl` field syntax was not re-fetched in this pass, so check the [prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
- Gateway batch passthrough (LiteLLM `/v1/batches`, etc.) was not verified in this pass.

### Inferences
- Multi-turn agent sessions are sequential: turn N+1 needs turn N's output. Batching each turn adds minutes to hours of latency per turn (most batches finish in under 1 hour, the maximum is 24h). That well exceeds the 5-minute cache TTL, and often the 1-hour TTL, so batched agent turns should be modeled as cache misses or cache writes. That is opthub's floor case. Anthropic's statement that the ephemeral cache "would likely expire before the follow-up request runs" is the closest primary-source confirmation.
- Batch is only positive for embarrassingly parallel, prefix-sharing work (evals, bulk summarization, lint-style reviews over many files) submitted in one batch with 1-hour cache and a steady stream.

### Gaps
- No independent, measured in-batch cache hit rate was found. The only number is Anthropic's vendor-reported 30–98% range.
- OpenAI's primary position on cache discounts inside Batch (GPT-5+) is unverified. Google Gemini batch and caching was not checked against primary docs.

---

## Q4. What do budget/limit features actually save (evidence vs claims), and how are they configured?

### Takeaway
I found **no measured savings data** for budget caps or token rate limits. They are **guardrails**: they bound worst-case spend and attribute it by key, team or user. They do not reduce the per-token cost of useful work. Vendor pages describe them only qualitatively ("cost controls: enforce budgets and rate limits in one place"). Their measurable value is the size of the runaway tail they cut off, which opthub could replay on transcripts, for example with loop detection plus `--max-budget-usd`.

### Cited Findings
- Claude Code's gateway docs say a gateway provides credentials, "Usage tracking: attribute usage by developer or team", "Cost controls: enforce budgets and rate limits in one place", and audit logging. They recommend issuing "each developer a gateway credential, so usage is attributed to the developer." With a gateway credential or `apiKeyHelper` active, "the subscription's usage limits don't apply" and traffic is billed per token. **Vendor-doc** — [Claude Code: Other LLM gateways](https://code.claude.com/docs/en/llm-gateway)
- Claude Code: with a gateway credential active, Claude Code "doesn't report usage metrics to the Console analytics dashboard", so attribution must come from the gateway. **Vendor-doc** — [Claude Code: Connect to a gateway](https://code.claude.com/docs/en/llm-gateway-connect)
- LiteLLM supports per-key, team, user and customer `max_budget`, `budget_duration`, `tpm_limit`, `rpm_limit`, `max_parallel_requests`, `soft_budget`, `model_max_budget` (enterprise), `budget_limits` (multiple windows), `model_rpm_limit`/`model_tpm_limit`, plus global `litellm_settings.max_budget`/`budget_duration` and `fail_closed_budget_enforcement`. No savings numbers are given. **Vendor-doc** — [LiteLLM budgets & rate limits](https://docs.litellm.ai/docs/proxy/users)
- Kong ai-rate-limiting-advanced: `tokens_count_strategy` of `total_tokens` | `prompt_tokens` | `completion_tokens` | `cost` (cost = (prompt×input_cost + completion×output_cost)/1e6). Counter strategy is `local` | `cluster` | `redis`. It returns HTTP 429 and `X-AI-RateLimit-*` headers. No savings numbers are given. **Vendor-doc** — [Kong ai-rate-limiting-advanced](https://developer.konghq.com/plugins/ai-rate-limiting-advanced/)

### Configs

**LiteLLM: per-developer virtual key with budget and limits (Gateway)** — [docs](https://docs.litellm.ai/docs/proxy/users)
```bash
curl 'http://0.0.0.0:4000/key/generate' \
  --header 'Authorization: Bearer <master-key>' \
  --header 'Content-Type: application/json' \
  --data '{
    "max_budget": 100,
    "budget_duration": "30d",
    "soft_budget": 80,
    "tpm_limit": 200000,
    "rpm_limit": 60,
    "max_parallel_requests": 10,
    "budget_limits": [
      {"budget_duration": "24h", "max_budget": 10},
      {"budget_duration": "30d", "max_budget": 100}
    ]
  }'
```
Team: `POST /team/new` with `team_alias`, `max_budget`, `budget_duration`, `tpm_limit`, `rpm_limit`, `model_tpm_limit`. Proxy-wide:
```yaml
litellm_settings:
  max_budget: 500
  budget_duration: 30d
  fail_closed_budget_enforcement: true
```
(The values above are examples. The keys match the docs, and `budget_duration` accepts values like "30s", "30m", "30h", "30d".)

**Kong ai-rate-limiting-advanced: per-consumer, per-model policy (Gateway)** — [docs](https://developer.konghq.com/plugins/ai-rate-limiting-advanced/)
```yaml
config:
  policies:
  - match:
    - type: consumer
      key: id
      values: ["$CONSUMER_ID"]
    - type: model
      partition_by: true
      values: ["gpt-4o"]
    limits:
    - limit: 100
      window_size: 60
```
To cap dollars instead of tokens, set `tokens_count_strategy: cost` at the documented location. UNVERIFIED: the exact nesting of `tokens_count_strategy` relative to `policies` was not confirmed, so check the plugin reference.

**Portkey budget limits, Cloudflare AI Gateway rate limiting, OpenRouter key limits, Anthropic Console workspace spend limits**: NOT verified in this pass, so no config is given.

**Claude Code side (Client)**
- Per-run cap: `claude -p --max-budget-usd 5.00 --max-turns 20 "…"`, print mode only — [CLI reference](https://code.claude.com/docs/en/cli-reference).
- Route through a gateway for per-developer attribution and budgets (Client config, gateway enforcement). `~/.claude/settings.json`:
  ```json
  { "env": { "ANTHROPIC_BASE_URL": "https://llm-gateway.example.com",
             "ANTHROPIC_AUTH_TOKEN": "sk-gateway-key",
             "ANTHROPIC_CUSTOM_HEADERS": "X-Org-Route: prod\nX-Tenant: example" } }
  ```
  Or use a rotating credential with `{ "apiKeyHelper": "~/bin/get-gateway-key.sh" }`. It is cached for 5 minutes by default, and the TTL can be changed with `CLAUDE_CODE_API_KEY_HELPER_TTL_MS=900000`. The helper value is sent in both `Authorization` and `x-api-key`. `ANTHROPIC_AUTH_TOKEN` is sent as `Authorization: Bearer` and `ANTHROPIC_API_KEY` as `x-api-key`. If a gateway rewrites context-limit errors, set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (minimum 100,000). — [Connect Claude Code to an LLM gateway](https://code.claude.com/docs/en/llm-gateway-connect)

### Inferences
- The saving from budgets equals the avoided runaway spend (loops, stuck agents) minus the value of work cut off. opthub can estimate it by replay: apply a per-session `--max-budget-usd` cap and a per-day key budget to historical sessions, then count dollars above the cap and whether those sessions produced useful output.
- A gateway in front of Claude Code must pass `cache_control`, `anthropic-beta` and the other request fields through unchanged, or it will destroy the 96.8% prompt-cache hit rate. That would cost far more than any gateway cache could save. The docs warn that a gateway "that doesn't forward them breaks the corresponding features" — [llm-gateway](https://code.claude.com/docs/en/llm-gateway).

### Gaps
- No public measured study of budget or rate-limit savings, whether vendor or independent.
- Not verified: Portkey budget-limit schema, Cloudflare rate-limit settings, OpenRouter per-key credit limits, TrueFoundry, Kong `ai-proxy` config, Anthropic Console workspace spend-limit mechanics.
