# Turning 110 public savings claims into replayable configs

Plenty of public evidence reports LLM cost and latency savings with numbers. Very little of it tells a Claude Code developer what a given config change will do to their own bill. This catalog collects **110 claims** from engineering blogs, vendor docs, papers, benchmarks and GitHub issues, most of them from 2025–2026. By evidence strength they break down as **13 measured-production, 21 benchmark, 54 vendor-claim and 22 anecdote**. Half of the catalog is vendor-sourced. Of the 13 production measurements, 7 come from a single user or a small sample, and 2 are vendors reporting on their own products. Most of the benchmark rows are single-turn (router, context-rot and semantic-cache studies); only a few, including JetBrains, Factory and Lumer et al., measure long multi-turn agent trajectories. So public evidence exists in bulk, but it is mostly generic, single-turn or vendor-sourced. That gap is opthub's opening: it turns each claim into a concrete config (a `settings.json` key, env var, subagent frontmatter or gateway YAML), replays that config on the developer's own Claude Code sessions in a sandbox, and grades the result blind. The notes largely back opthub's own numbers. Independent Claude Code measurements put cache reads at 94–99.9% of tokens, so opthub's 96.8% hit rate is typical and "turn on caching" is worth about nothing. Anthropic's docs describe exactly the batch mechanism that produces opthub's asymmetric floor and ceiling. Fast mode costs exactly 2.0x. The one notable difference is that opthub's local-model penalty is larger than the public averages. The levers the public evidence ranks highest for Claude Code are context lifecycle, tool-output and tool-schema slimming, and TTL choice per bucket, all of which can be set on the client.

## Public evidence mostly confirms opthub's own measurements

The table below checks each of opthub's headline numbers against the catalog. Five of the six are confirmed by primary sources or consistent independent measurements. The sixth, the local-model penalty, points the same way as public data but is larger than the only public hands-on average.

| opthub finding | What the catalog says | Verdict |
|---|---|---|
| **96.8% cache hit rate** on a real month | Independent Claude Code measurements: 97.2% cache reads ([devx AI labs](https://www.devxlabs.ai/blogs/how-claude-code-actually-works)), 97.4% ([dev.to](https://dev.to/flipslidersand/i-thought-i-used-1-billion-tokens-in-claude-code-last-week-turns-out-97-was-cache-1m2i)), 99.93% ([#24147](https://github.com/anthropics/claude-code/issues/24147)), and 94.2% across 1,674 sessions in Cursor, Claude Code and Codex ([SwiftLee](https://www.avanderlee.com/ai-development/reduce-token-usage-claude-code-codex-cursor/)) | **Confirmed.** Typical for append-only agents, so enabling caching gives about 0 delta |
| **Batch floor −$854 vs ceiling +$254** on a $508.80 month | In batch, cache hits are "best-effort" at "30% to 98%", and pre-warming is unsupported because entries "would likely expire" ([Anthropic batch docs](https://platform.claude.com/docs/en/build-with-claude/batch-processing)). Break-even in-batch hit rate is about 89–91% (arithmetic on [pricing](https://platform.claude.com/docs/en/about-claude/pricing)) | **Mechanism confirmed** by primary docs. No independent measurement exists |
| **Effort headroom 2.4%** | Output is about 14–22% of Claude Code dollars. Opus 5.5 and Sonnet 5.5 already default to `medium` ([model-config](https://code.claude.com/docs/en/model-config)) | **Consistent.** Slightly below the naive 4–15% bound, which is explained by the already-medium defaults |
| **Fast mode counted as 2x spend** | Opus 5.5 costs $8/$40 fast vs $4/$20 standard, exactly 2.0x ([fast mode](https://code.claude.com/docs/en/fast-mode), [pricing](https://platform.claude.com/docs/en/about-claude/pricing)). Turning it on mid-session also re-bills the whole context uncached | **Confirmed**, and the true cost is slightly worse than 2x |
| **Context lifecycle is the top lever**: 52.9% of spend is in sessions with median context ≥250k | Auto-compaction on 1M models defaults to about 967K ([model-config](https://code.claude.com/docs/en/model-config)). 1M context has flat pricing ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)). Masking old tool outputs halves cost on SWE-bench ([JetBrains](https://blog.jetbrains.com/research/2025/12/efficient-context-management/)) | **Supported.** Long-context sessions are likely never compacted by default |
| **Local model: 7.1x cheaper, 18 points worse** (n=1) | Qwen3-Coder is 6% behind Sonnet 5 on average but 16% behind on multi-file refactors, at about half the throughput ([Ganglani](https://www.kunalganglani.com/blog/local-llm-vs-claude-coding-benchmark)). Run-to-run flips affect 5.37% of model-question pairs ([arXiv 2608.23023](https://arxiv.org/abs/2608.23023)) | **Same direction, larger size.** Consistent with the multi-file gap, but statistically weak at n=1 |

The reading is simple. For an append-only coding agent, most of the "up to 90%" savings claims in vendor copy (see the caching and semantic-cache sections) are already captured or do not apply. What remains are the costs of *what* sits in context and *how long* it stays there, and these are exactly the levers opthub can replay from transcripts on the client.

**Table legend.** Evidence strength: **MP** measured-production, **BM** benchmark, **VC** vendor claim or vendor doc/spec, **AN** anecdote or illustrative math. *Replay-testable* means whether opthub can test the config on Claude Code sessions: **yes** (client config or deterministic transcript simulation), **needs gateway** (a proxy must sit in the sandboxed request path), **no** (applies to another agent, is already on by default in Claude Code, or has no config).

## Prompt caching already runs at 94–99.9%; TTL and invalidators are what is left

Two regimes run through the caching evidence. Append-only coding agents such as Claude Code and Codex CLI sit at 94–99.9% cache reads with no tuning. By turn 10, 99.9% of input came from cache in one 165.9M-token analysis ([devx AI labs](https://www.devxlabs.ai/blogs/how-claude-code-actually-works)). Custom agents with mutable system prompts start far lower: ProjectDiscovery went from **7% to 84%** and cut costs **59–70%** after moving working memory out of the system prompt ([ProjectDiscovery](https://projectdiscovery.io/blog/how-we-cut-llm-cost-with-prompt-caching)), and Deriv reached 85.8% hits and a **77%** input-cost cut ([Deriv](https://derivai.substack.com/p/prompt-caching-production-ai-agent-costs)). The only controlled benchmark finds **41–80%** cost reduction and 13–31% better time to first token, and warns that "naive full-context caching … can paradoxically increase latency" ([Lumer et al.](https://arxiv.org/abs/2601.06007)). None of that is headroom for a Claude Code user, whose client already places optimal breakpoints.

What does remain has three parts. The first is **TTL per bucket**. Claude Code requests the 1h TTL only for the main conversation on a subscription within plan usage. API keys, cloud providers, usage-credit overage, subagents, compaction and titles all get 5m ([Claude Code prompt caching](https://code.claude.com/docs/en/prompt-caching)). The only public longitudinal dataset covers 119,866 calls from one heavy user. When writes silently shifted from 1h to 5m, cache-creation overpayment rose from **1.1% in February to 25.9% in March, 17.1% overall** ([#46829](https://github.com/anthropics/claude-code/issues/46829)). That figure is an upper bound on what 1h saves. The arithmetic is simple: a 1h write costs 0.75x base input more than a 5m write, and a single avoided re-write after a 5–60 minute idle gap repays it ([Vercel AI Gateway](https://vercel.com/docs/ai-gateway/models-and-providers/automatic-caching)).

The second is **invalidators**. The notes list each of these as causing a one-time uncached turn:

- `/model` switches and `opusplan` toggles
- skills that pin a different model
- turning fast mode on
- MCP connects when tool search isn't deferring, which includes any custom `ANTHROPIC_BASE_URL`
- `/compact`
- image eviction
- Claude Code upgrades

([Claude Code prompt caching](https://code.claude.com/docs/en/prompt-caching)). The Claude Code team treats cache hit rate as an operational metric and declares SEVs when it drops ([claude.dev](https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/)).

The third is **what gets cached**. At 1,310 cache-read tokens per I/O token, a 15k-token CLAUDE.md dominates spend even at 0.1x ([#24147](https://github.com/anthropics/claude-code/issues/24147)). No caching key fixes that; it is prefix-trim work.

| Source (publisher, date) | Claim + number | Strength | opthub lever | Runs | Replay-testable |
|---|---|---|---|---|---|
| [How Claude Code actually works](https://www.devxlabs.ai/blogs/how-claude-code-actually-works) (devx AI labs, 2026-03-10) | 97.2% cache reads; 99.9% by turn 10; 100% 1h writes on subscription | MP | cache-config/TTL | client | yes |
| [claude-code #24147](https://github.com/anthropics/claude-code/issues/24147) (GitHub, 2026-02-08) | 99.93% cache reads over 30 days; about 15k-token CLAUDE.md re-read every turn | MP | prefix-trim | client | yes |
| ["97% was cache"](https://dev.to/flipslidersand/i-thought-i-used-1-billion-tokens-in-claude-code-last-week-turns-out-97-was-cache-1m2i) (dev.to, date unknown; fetched date 2024-08-07 is impossible) | 1.36B tokens in one week: 97.4% read, 2.2% write, 0.4% output | MP | cache-config/TTL | client | yes |
| [Prompt caching is everything](https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/) (Anthropic, 2026-04-30) | SEVs on hit-rate drops; list of breakers; no figures | VC | cache-priming detector | client | yes |
| [opencode #51580](https://github.com/anomalyco/opencode/issues/51580) (GitHub, 2026-09-27) | Codex 0.30% misses vs 3.36% without `prompt_cache_key` on the same endpoint | MP | cache-config/TTL | client | no (non-Claude Code) |
| [Prompt Caching 201](https://developers.openai.com/cookbook/examples/prompt_caching_201) (OpenAI, undated) | Customer hit rate went 60%→87% with `prompt_cache_key`; Responses API "40–80% better" | VC | cache-config/TTL | client | no |
| [Cut LLM costs 59%](https://projectdiscovery.io/blog/how-we-cut-llm-cost-with-prompt-caching) (ProjectDiscovery, 2026-04-10) | Hits 7%→74%→84%; cost −59/−66/−70%; one task 3.2%→91.8% | MP | prefix-trim | client | no (custom agent) |
| [Prompt caching cut input costs 77%](https://derivai.substack.com/p/prompt-caching-production-ai-agent-costs) (Deriv, 2026-07-23) | 85.8% hit rate; −77% input cost (dollar figures illustrative) | MP | prefix-trim | client | no |
| [Context engineering lessons](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) (Manus, 2025-07-18) | Input:output about 100:1; cached input 10x cheaper; no timestamps in prefix | MP | prefix-trim | client | no |
| [330 production calls](https://dev.to/rikuq/anthropic-prompt-caching-real-numbers-from-330-production-calls-2eg4) (dev.to, 2026) | Caching cut bill 25–35% (snippet only) | MP | cache-config/TTL | client | no |
| [Cache hit rate is probably 7%](https://getmegabrain.com/blog/prompt-cache-hit-rate-myth-2026) (MegaBrain, 2026-07-25) | Random routing costs 2.25x vs 1.75x with affinity; keepalive warm 40/40 vs 0/48 | AN | cache-priming detector | gateway | needs gateway |
| [Don't Break the Cache](https://arxiv.org/abs/2601.06007) (arXiv, 2026-01) | 500+ sessions: −41–80% cost, +13–31% TTFT; naive full caching can add latency | BM | cache-config/TTL | client | no (already default) |
| [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) (OpenAI, current) | Reads 0.1x and writes 1.25x on GPT-5.6+; overflow routing above about 15 rpm | VC | cache-config/TTL | client | no |
| [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) (Anthropic, current) | 5m write 1.25x, 1h write 2x, read 0.1x (0.05x Opus 5.5); both TTLs have identical latency | VC | cache-config/TTL | client | yes (pricing basis) |
| [Automatic caching](https://vercel.com/docs/ai-gateway/models-and-providers/automatic-caching) (Vercel, 2026-09-11) | One read after 5m expiry repays the 0.75x 1h premium | VC | cache-config/TTL | gateway | needs gateway |
| [claude-code #46829](https://github.com/anthropics/claude-code/issues/46829) (GitHub, 2026-04-12) | 1h→5m regression; overpayment 1.1%→25.9%, 17.1% overall | MP | cache-config/TTL | client | yes |
| [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching) (Anthropic, current) | TTL buckets and defaults; invalidator list; `/usage` hit ratio | VC | cache-config/TTL, cache-priming detector | client | yes |
| [Two-tier write premium](https://dev.to/rikuq/anthropic-prompt-caching-explained-cachecontrol-markers-the-two-tier-write-premium-and-when-it-25cp) (dev.to, 2026) | Break-even at 2 hits for 5m, about 3 for 1h (no expiry modeled) | AN | cache-config/TTL | client | yes |
| [5min vs 1hr](https://synrouter.ai/blog/anthropic-cache-ttl-5min-vs-1hr) (Synrouter, undated, snippet) | Cache writes $1.73 at 5m vs $0.09 at 1h in one idle-gap session | AN | cache-config/TTL | client | yes |
| [Aider caching](https://aider.chat/docs/usage/caching.html) (Aider, current) | `--cache-keepalive-pings N` keeps 5m cache warm | VC | cache-priming detector | client | no (Aider-only) |
| [Cline discussion #414](https://github.com/cline/cline/discussions/414) (GitHub, 2024-09-27) | Pinging estimated at 1.45x vs 2.5x uncached | AN | cache-priming detector | client | no |
| [Portkey #1579](https://github.com/Portkey-AI/gateway/issues/1579), [flue #662](https://github.com/withastro/flue/issues/662), [openclaw #46709](https://github.com/openclaw/openclaw/issues/46709) (GitHub, snippets) | Gateways and bindings strip `cache_control` or force a 5m TTL | AN | cache-config/TTL | gateway | needs gateway |
| [LiteLLM auto-inject](https://docs.litellm.ai/docs/tutorials/prompt_caching) (LiteLLM, current) | Global injection flag and TTL; defers to the client's own markers | VC | cache-config/TTL | gateway | needs gateway |
| [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching) (OpenRouter, current) | Sticky routing with 10-min idle expiry; read multipliers 0.1–0.5x | VC | cache-config/TTL | gateway | needs gateway |
| [claude-prompt-cache-edge](https://github.com/qiyuanlabs-ai/claude-prompt-cache-edge) (GitHub, undated) | Cloudflare Worker claims "40–70% cost reduction" | VC | cache-config/TTL | gateway | needs gateway |

Two conflicts are resolved here. The "1,674 sessions, 94.2% cache reads" figure, which the caching note could not trace, turns out to come from SwiftLee (2026-09-28) and is cited in the baselines section. The "a miss is more than 5% and at least 2k tokens re-processed" rule is stated in the [Claude Code costs doc](https://code.claude.com/docs/en/costs). The notes also disagree on effort switches. The Claude Code caching doc says the cache is kept across effort changes on Opus 5.5, Sonnet 5.5 and Fable 5.1 via the API or a subscription since v2.1.260, but not on Bedrock or Vertex. The model-config doc says effort changes "may clear cache". The API docs say a top-level effort change invalidates the cache and only the per-message beta keeps it. opthub should detect this empirically from `cache_creation` spikes rather than assume either answer.

### Config: prompt caching and TTL

**Claude Code: client.** All keys below are verified in the [Claude Code prompt-caching docs](https://code.claude.com/docs/en/prompt-caching), v2.1.242+ for the TTL keys.

```jsonc
// ~/.claude/settings.json  or managed-settings.json   (values: "5m" | "1h"; anything else ignored)
{
  "promptCacheTtl": "1h",           // main-conversation bucket (already 1h on subscription within plan usage)
  "subagentPromptCacheTtl": "1h",   // subagents, workflows, teammates, forks, compaction, titles (default 5m)
  "env": { "DISABLE_AUTOUPDATER": "1" }   // control when prefix-changing upgrades land
}
```

```bash
export CLAUDE_CODE_PROMPT_CACHE_TTL=1h            # main bucket
export CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=5m   # everything else
export ENABLE_PROMPT_CACHING_1H=1                 # both buckets 1h (lower precedence)
export FORCE_PROMPT_CACHING_5M=1                  # both buckets 5m (highest precedence; A/B testing)
# Disable flags (for A/B only): DISABLE_PROMPT_CACHING=1, DISABLE_PROMPT_CACHING_{HAIKU,SONNET,OPUS,FABLE}
# Verify the TTL split:
claude -p "hello" --output-format json   # read usage.cache_creation.ephemeral_1h_input_tokens / ephemeral_5m_input_tokens
```

Precedence runs `FORCE_PROMPT_CACHING_5M`, then the bucket env var, then the bucket setting, then subagent frontmatter `experimental.cacheTtl` (v2.1.248+), then `ENABLE_PROMPT_CACHING_1H`, then the default. The per-subagent override is documented as a field `cacheTtl` inside `experimental`, but **the exact YAML nesting below is UNVERIFIED**:

```markdown
---
name: long-build-runner
experimental:
  cacheTtl: 1h     # UNVERIFIED nesting — check the sub-agents frontmatter reference
---
```

Avoid `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` unless a gateway requires it. It makes the mid-conversation system-context block uncached and also forces tool search off.

**Gateway (only if Claude Code runs behind one).** Claude Code already sends `cache_control`, so the gateway's job is to *not break it*. It must forward `cache_control` unchanged, forward the `anthropic-beta` header (which the 1h TTL partly travels in), and never flatten block-form system content into a string. If it strips markers but returns success, "your entire conversation history bills as uncached input on every turn" ([Claude Code prompt caching](https://code.claude.com/docs/en/prompt-caching)). Auto-injection matters for SDK apps that send no markers:

```yaml
# LiteLLM proxy — verified (docs.litellm.ai/docs/tutorials/prompt_caching); Claude on anthropic/ and bedrock/ only
litellm_settings:
  enable_anthropic_prompt_caching: true   # env LITELLM_ENABLE_ANTHROPIC_PROMPT_CACHING=true
  anthropic_prompt_caching_ttl: "1h"      # env LITELLM_ANTHROPIC_PROMPT_CACHING_TTL; default 5m
model_list:
  - model_name: anthropic-cache
    litellm_params:
      model: anthropic/claude-sonnet-5
      cache_control_injection_points:
        - location: message
          role: system
        - location: message
          index: -1
# The router pre-call check named "prompt_caching" exists; its semantics are UNVERIFIED.
```

```jsonc
// Vercel AI Gateway (Responses API) — verified; cache_ttl works only with caching:"auto"
{ "model": "anthropic/claude-sonnet-5", "caching": "auto", "cache_ttl": "1h", "input": "..." }
// also: providerOptions.gateway.caching:'auto', cache_anchor_items:N, header x-session-affinity:<id>

// OpenRouter — verified; session_id (or x-session-id header) forces sticky provider routing
{ "model": "anthropic/claude-sonnet-5", "session_id": "sess-123",
  "cache_control": { "type": "ephemeral", "ttl": "1h" }, "messages": [ ] }
```

Portkey is pass-through only. You place `cache_control` yourself and send the `x-portkey-api-key` and `x-portkey-provider: anthropic` headers ([Portkey](https://portkey.ai/docs/integrations/llms/anthropic/prompt-caching)). The notes found **no verified provider-prompt-caching keys for Kong, Cloudflare AI Gateway, Helicone or Bifrost**. Their caching features are response caches, covered in the semantic-cache section.

**Other agents.**

```bash
# Aider — verified flags
aider --cache-prompts --cache-keepalive-pings 12   # ~60 min idle warm; use --no-stream to see cache stats
# .aider.conf.yml "cache-prompts: true" follows Aider's flag-to-YAML convention but is UNVERIFIED on the caching page
```

```jsonc
// OpenAI Responses request shape (what Codex CLI already sends automatically; no user config key documented)
{ "model": "gpt-5.5", "prompt_cache_key": "sess-123", "prompt_cache_retention": "24h", "input": [ ] }
// GPT-5.6+ uses "30m" retention; the guide and cookbook describe the values slightly differently — verify per model
```

```yaml
# Continue — UNVERIFIED: present in a community sample, absent from the current official config reference
models:
  - name: sonnet
    provider: anthropic
    model: claude-sonnet-5
    cacheBehavior:
      cacheSystemMessage: true
      cacheConversation: true
```

The notes found no verified caching settings for Cursor, Cline or Codex CLI.

## Routers claim 35–85% savings on single-turn prompts; agent evidence is thin and vendor-heavy

Router evidence is the clearest case of "generic and single-turn". RouteLLM reports **85% cost cuts on MT-Bench but only 35% on GSM8K** at 95% of GPT-4 quality ([LMSYS](https://www.lmsys.org/blog/2024-07-01-routellm/)). FrugalGPT claims up to 98% on classification and QA ([arXiv 2305.05176](https://arxiv.org/abs/2305.05176)). The independent evaluations are less flattering. RouterArena finds routers "inefficient at recognizing when smaller, cheaper models are sufficient", with overhead that can exceed 100 ms ([RouterArena](https://arxiv.org/html/2510.00202v1)). A 2026 study found that a **static task-type → model table** captured about 72% of the achievable gain, getting 262 correct at $3.33 per run against the best single model's 245 at $7.69. It also found that 5.37% of model-question pairs flip between identical runs ([arXiv 2608.23023](https://arxiv.org/abs/2608.23023)). That noise floor is the same order as many routers' claimed gains, so any opthub routing verdict needs repeated replays.

The agent-specific numbers are either vendor claims or not about long trajectories:

- **Not Diamond Code** reports 39% savings at Opus 4.8 xhigh parity on Poly-SWE-Bench, rising to 66% with open-weights models in the pool ([Not Diamond](https://www.notdiamond.ai/blog/not-diamond-code-intelligent-model-routing-for-coding-agents)).
- **Switchcraft** reports 84% lower cost at the best single model's accuracy, but on tool calling. It also warns that "nominally cheaper models can incur higher total cost due to token-intensive reasoning" ([Switchcraft](https://arxiv.org/abs/2605.07112)).
- **LiteLLM's auto-router** was 37–69% cheaper than single-model caching across 95 real agent sessions, but the post reports cost only, not task success ([LiteLLM blog](https://docs.litellm.ai/blog/auto-router-prompt-caching-benchmark)).

The same LiteLLM post measured that switch-backs stay 97.4% warm at 5m TTL with session affinity. It also warns that a router with caching broken costs about 4x a single cached model ([LiteLLM](https://docs.litellm.ai/docs/auto_router/prompt_caching)). The practical rule is to route per session or per subagent, never per turn.

The best-supported split is Aider's architect/editor: a strong planner with a cheap editor *raised* pass rate, from 79.7% to 85.0% ([Aider](https://aider.chat/2024/09/26/architect.html)). The riskier split is the reverse, where a cheap model decides what to look at. opthub's own prompt-only router missed a security finding. That matches Agent-as-a-Router's report that static classifiers "experience significant performance degradation" out of distribution on agentic programming ([alphaXiv 2606.22902](https://www.alphaxiv.org/abs/2606.22902)).

For local models, open-weights leaderboard scores (Qwen3-Coder-Next 70.6% SWE-bench Verified, vendor-reported) sit far from the only hands-on test. That test found a 6% average gap but a 16% multi-file gap, at 38 vs 80 tok/s ([Ganglani](https://www.kunalganglani.com/blog/local-llm-vs-claude-coding-benchmark)). opthub's 18-point drop fits the multi-file pattern.

| Source (publisher, date) | Claim + number | Strength | opthub lever | Runs | Replay-testable |
|---|---|---|---|---|---|
| [RouteLLM](https://www.lmsys.org/blog/2024-07-01-routellm/) (LMSYS, 2024-07-01) | At 95% GPT-4 quality: −85% cost on MT-Bench, −45% on MMLU, −35% on GSM8K | BM | model-routing | gateway | needs gateway |
| [FrugalGPT](https://arxiv.org/abs/2305.05176) (Stanford, 2023) | Up to −98% cost at GPT-4 parity (classification/QA) | BM | model-routing | gateway | needs gateway |
| [Hybrid LLM](https://arxiv.org/abs/2404.14618) (Microsoft, ICLR 2024) | Up to 40% fewer large-model calls with no quality drop | BM | model-routing | gateway | needs gateway |
| [RouterArena](https://arxiv.org/html/2510.00202v1) (Rice, 2025-09-30) | 12 routers: over-select expensive models; overhead >100 ms | BM | model-routing | gateway | needs gateway |
| [Routing gap is task type](https://arxiv.org/abs/2608.23023) (Redrob, 2026-08-24) | Static table 262 correct at $3.33 vs 245 at $7.69; 72% of gain; 5.37% flip rate | BM | model-routing | client | yes (per-subagent static rule) |
| [Switchcraft](https://arxiv.org/abs/2605.07112) (MSR authors, 2026-05-08) | 82.9% accuracy at −84% cost on tool calling | BM | model-routing | gateway | needs gateway |
| [Agent-as-a-Router](https://www.alphaxiv.org/abs/2606.22902) (NUS/DAMO, 2026-06-26) | +15.3% relative; static classifiers degrade out of distribution | BM | model-routing | gateway | needs gateway |
| [arXiv 2608.01347](https://arxiv.org/abs/2608.01347) (2026) | Prompt, effort and harness interact; token counts alone are "not sufficient" targets | BM | effort-tuning, model-routing | client | yes (design rule) |
| [Not Diamond Code](https://www.notdiamond.ai/blog/not-diamond-code-intelligent-model-routing-for-coding-agents) (Not Diamond, 2026-08-04) | −39% at Opus 4.8 xhigh parity; −61% LongCodeQA; −66% and +3.6% with open weights | VC | model-routing | gateway | needs gateway |
| [Not Diamond](https://www.notdiamond.ai/) (snippet) | Easy requests to Haiku 4.5: −40–70%, <2% quality loss | VC | model-routing | gateway | needs gateway |
| [OpenRouter Auto Router](https://openrouter.ai/docs/features/model-routing) (OpenRouter, current) | About 30 task types; no fee; no quality numbers | VC | model-routing | gateway | needs gateway |
| [Auto-router + caching benchmark](https://docs.litellm.ai/blog/auto-router-prompt-caching-benchmark) (LiteLLM, 2026-07-31) | −37–69% vs single-model caching; switch-backs 97.4% warm (5m), 99.3% (1h) | MP | model-routing | gateway | needs gateway |
| [Aider architect/editor](https://aider.chat/2024/09/26/architect.html) (Aider, 2024-09-26) | o1-preview + DeepSeek editor 85.0% vs solo 79.7% | BM | model-routing | client | no (Aider); `opusplan` analog yes |
| [Claude Code model config](https://code.claude.com/docs/en/model-config) and [sub-agents](https://code.claude.com/docs/en/sub-agents) (Anthropic, current) | `opusplan`, subagent `model:`; "cache is cleared when you switch models"; no savings figures | VC | model-routing, cache-priming detector | client | yes |
| [Subagent routing](https://medium.com/@roanmonteiro/claude-code-subagent-model-routing-stop-paying-for-opus-on-haiku-work-ee76dc32cb88) (Medium), [byteiota](https://byteiota.com/claude-code-subagent-model-routing/) (snippets) | "60% by setting two fields"; about −30% on the subagent line item | AN | model-routing | client | yes |
| [Parallel agents cost](https://www.developersdigest.tech/blog/what-parallel-claude-agents-actually-cost) (Developers Digest) | Mixed fleet $39/day vs $81.25 all-Opus (−52%, price-sheet math) | AN | model-routing | client | yes |
| [Qwen3-Coder-Next](https://qwen.ai/blog?id=qwen3-coder-next) (Qwen) | 70.6% SWE-bench Verified, 44.3% SWE-bench Pro | VC | model-routing (local) | client + local server | yes |
| [Best Ollama models](https://www.morphllm.com/best-ollama-models) (Morph, aggregator) | Devstral 24B 46.8% SWE-bench Verified; Qwen3-Coder 30B-A3B 19 GB at Q4 | VC | model-routing (local) | client + local server | yes |
| [Local LLM vs Claude](https://www.kunalganglani.com/blog/local-llm-vs-claude-coding-benchmark) (Ganglani, 2026-03-27, upd. 2026-07-12) | 50 tasks: Sonnet 5 13.2 vs Qwen3-Coder 12.4 (−6%); multi-file −16%; 38 vs 80 tok/s | AN | model-routing (local) | client + local server | yes |
| [Ollama + Claude Code](https://docs.ollama.com/integrations/claude-code) (Ollama, current) | Set context "to 64k or higher"; tool calling on compatible models | VC | model-routing (local) | client + local server | yes |
| [claude-code-router review](https://aitoolanalysis.com/claude-code-router-review/) (snippet) | "Cut your AI coding bill by 80%?" (no measurement) | AN | model-routing | gateway (local proxy) | needs gateway |
| [claude-code-router guide](https://www.morphllm.com/claude-code-router) (Morph, snippet) | `longContextThreshold` set too low sends mid-size requests to the expensive model | AN | model-routing | gateway (local proxy) | needs gateway |
| [tas-llm-router #100](https://github.com/Tributary-ai-services/tas-llm-router/issues/100) (GitHub) | Router stripped `cache_control` | AN | cache-config/TTL | gateway | needs gateway |

### Config: model routing and local offload

**Claude Code: client.** Keys verified in [model-config](https://code.claude.com/docs/en/model-config) and [sub-agents](https://code.claude.com/docs/en/sub-agents). The `env` block is a standard settings key, though the routing note did not re-fetch it.

```jsonc
// ~/.claude/settings.json
{
  "model": "opusplan",                    // opus in plan mode, sonnet for execution (switch clears cache once)
  "fallbackModel": ["sonnet", "haiku"],   // AVAILABILITY failover (max 3), NOT a cost cascade
  "env": {
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5",   // haiku alias + background work
    "CLAUDE_CODE_SUBAGENT_MODEL": "haiku",
    "CLAUDE_CODE_SUBAGENT_MODEL_FORCE": "1"                // v2.1.257+; without it, frontmatter model: wins (since v2.1.251)
  }
}
// ANTHROPIC_SMALL_FAST_MODEL is deprecated — use ANTHROPIC_DEFAULT_HAIKU_MODEL.
```

```markdown
<!-- .claude/agents/Explore.md — overrides the built-in Explore subagent (which otherwise inherits the main model) -->
---
name: Explore
description: Locate files and symbols; no edits
model: haiku
tools: Read, Glob, Grep
---
```

```bash
# Local model via Ollama — verified
export ANTHROPIC_AUTH_TOKEN=ollama
export ANTHROPIC_API_KEY=""
export ANTHROPIC_BASE_URL=http://localhost:11434
export CLAUDE_CODE_MAX_CONTEXT_TOKENS=65536                  # correct window for custom model IDs (value illustrative)
export CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1
claude --model qwen3.5          # or: ollama launch claude
```

One base URL serves every model slot. Pointing only the Haiku slot at a local model therefore requires a gateway that serves both Anthropic and local models. The notes list this combination as untested.

**Gateway.**

```yaml
# LiteLLM complexity auto-router — verified (docs.litellm.ai/docs/proxy/auto_routing)
model_list:
  - model_name: smart-router
    litellm_params:
      model: auto_router/complexity_router
      complexity_router_config:
        tiers:
          SIMPLE: claude-haiku-4-5
          MEDIUM: claude-sonnet-5
          COMPLEX: claude-sonnet-5
          REASONING: claude-opus-5
        classifier_type: heuristic          # llm adds up to timeout_ms (e.g. 2000) per routed call
        session_affinity: true              # pin session to first-turn model — keeps cache warm
        enable_context_window_escalation: true
      complexity_router_default_model: claude-sonnet-5
router_settings:
  routing_strategy: cost-based-routing      # verified options: simple-shuffle | least-busy | latency-based-routing | usage-based-routing-v2 | cost-based-routing
  enable_pre_call_checks: true
# fallbacks: [{"claude-opus-5": ["claude-sonnet-5"]}] — long-standing feature, syntax UNVERIFIED this pass
```

```bash
# Point Claude Code at it — the model-name mapping via /v1/messages is UNVERIFIED
export ANTHROPIC_BASE_URL=http://<litellm-host>:4000
export ANTHROPIC_MODEL=smart-router
```

```jsonc
// OpenRouter Auto Router — verified
{ "model": "openrouter/auto", "session_id": "<stable-per-conversation-id>",
  "plugins": [{ "id": "auto-router", "allowed_models": ["anthropic/*"] }], "messages": [ ] }
// "models": [primary, fallback, ...] array — UNVERIFIED this pass
```

RouteLLM's server flags (`python -m routellm.openai_server --routers mf ...`, model name `router-mf-0.11593`) are **UNVERIFIED**; they come from memory of the [README](https://github.com/lm-sys/RouteLLM). Not Diamond runs as a local proxy reached through `ANTHROPIC_BASE_URL`, but **its port and keys are unpublished**.

**Other agents.**

```yaml
# .aider.conf.yml — flags verified; YAML keys follow the documented convention; model IDs illustrative
architect: true
model: anthropic/claude-opus-5-5          # planner
editor-model: anthropic/claude-sonnet-5   # applies edits
weak-model: anthropic/claude-haiku-4-5    # commit messages + history summarization only
```

```jsonc
// claude-code-router ~/.claude-code-router config — Router keys from SECONDARY sources only; schema may have changed
{ "Router": {
    "default": "deepseek,deepseek-chat",
    "background": "ollama,qwen2.5-coder:latest",
    "think": "deepseek,deepseek-reasoner",
    "longContext": "openrouter,google/gemini-2.5-pro-preview",
    "longContextThreshold": 60000,
    "webSearch": "gemini,gemini-2.5-flash" } }
// Providers array, CUSTOM_ROUTER_PATH, image key, <CCR-SUBAGENT-MODEL> tag — UNVERIFIED
```

```toml
# Codex CLI ~/.codex/config.toml — verified keys
review_model = "<cheaper-model>"   # model override for /review
oss_provider = "ollama"            # or "lmstudio"; run with `codex --oss`
# Profile file layout ($CODEX_HOME/<name>.config.toml vs [profiles.<name>]) is UNVERIFIED; no background/subagent model key documented
```

The notes cover no Cline/Roo plan/act models, Continue model roles or Cursor auto mode.

## Semantic caching, batch and budgets save roughly nothing on Claude Code traffic

This category holds the widest gap between marketing and mechanism. The most-cited "production" semantic-cache hit rate is Portkey's ~20% on RAG. The only coding figure, 5–15%, is an unsourced blog estimate ([Dagde/Preto](https://dev.to/gauravdagde/llm-semantic-caching-the-95-hit-rate-myth-and-what-production-data-actually-shows-8ga)). The headline "86% cost cut" comes from a paraphrase-heavy AWS benchmark at a loose 0.75 threshold ([Portkey](https://portkey.ai/blog/semantic-caching-thresholds/)). More decisive for opthub is that the gateways themselves are designed to skip agent traffic:

- **Bifrost** skips conversations with more than 3 messages by default ([Bifrost](https://docs.getbifrost.ai/features/semantic-caching)).
- **Portkey semantic** only works under 8,191 tokens and at most 4 messages, and ignores the system prompt ([Portkey docs](https://portkey.ai/docs/product/ai-gateway/cache-simple-and-semantic)).
- **Cloudflare and Helicone** are exact-match on the full body ([Cloudflare](https://developers.cloudflare.com/ai-gateway/features/caching/), [Helicone](https://docs.helicone.ai/features/advanced-usage/caching)).

Every Claude Code turn carries a unique, growing history, so expected hits are about zero. Correctness risk also rises: the same prompt text against changed repo state needs a different answer. vCache (ICLR 2026) shows static thresholds carry no correctness guarantee ([arXiv 2502.03771](https://arxiv.org/abs/2502.03771)), and embedding key collisions are attackable ([arXiv 2601.23088](https://arxiv.org/html/2601.23088v1)).

Batch is the one place where primary docs directly back opthub's arithmetic. Discounts stack: a batch cache read costs 0.5 × 0.1 = 0.05x. But in-batch cache hits are "best-effort", with users seeing **30% to 98%**, and `max_tokens: 0` pre-warming is unsupported because the entry "would likely expire before the follow-up request runs" ([Anthropic batch](https://platform.claude.com/docs/en/build-with-claude/batch-processing)). Anthropic also rules out batch for stateful sessions: "Sessions are stateful and interactive. There is no batch mode" ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)). For a workload already paying 0.10x on cached tokens, a batch miss at 0.5x is five times worse than a synchronous hit. The notes' arithmetic puts break-even at an in-batch hit rate of about 89–91%, above most of Anthropic's reported range. This is exactly the shape of opthub's −$854 floor and +$254 ceiling. Claude Code has no batch mode; `claude -p` is unattended, not discounted.

Budgets and rate limits are guardrails. No source in the catalog measures their savings. Their value is the runaway tail they cut off, which opthub can price by capping historical sessions at a budget.

| Source (publisher, date) | Claim + number | Strength | opthub lever | Runs | Replay-testable |
|---|---|---|---|---|---|
| [Semantic caching 95% myth](https://dev.to/gauravdagde/llm-semantic-caching-the-95-hit-rate-myth-and-what-production-data-actually-shows-8ga) (Dagde/Preto, 2026-04) | Hit rate by workload: code generation 5–15%, RAG 15–25%, FAQ 40–60% (unsourced) | AN | none (response cache) | gateway | yes (count duplicate bodies) |
| [Semantic caching thresholds](https://portkey.ai/blog/semantic-caching-thresholds/) (Portkey) | 250M cache requests; ~99% accuracy; ">$500K" saved by one customer | VC | none | gateway | needs gateway |
| AWS test as reported by [Portkey](https://portkey.ai/blog/semantic-caching-thresholds/) (original unfetched) | 0.95 threshold: 56% hit, −51.9% cost; 0.75: 90.3% hit, −86.3% cost | BM | none | gateway | needs gateway |
| [TianPan](https://tianpan.co/blog/2026-04-09-semantic-caching-llm-production) (2026-04-09), [Braintrust](https://www.braintrust.dev/articles/llm-gateway-caching) (snippets) | 20–45% realistic for FAQ; 10–25% for conversational agents | AN | none | gateway | needs gateway |
| [Bifrost semantic caching](https://docs.getbifrost.ai/features/semantic-caching) (Bifrost, current) | `conversation_history_threshold` default 3 skips multi-turn traffic; a miss adds an embedding call | VC | none | gateway | needs gateway |
| [Portkey cache](https://portkey.ai/docs/product/ai-gateway/cache-simple-and-semantic) (Portkey, current) | Semantic cache only for <8,191 tokens and ≤4 messages; Enterprise only; "up to 20x faster" | VC | none | gateway | needs gateway |
| [Cloudflare AI Gateway caching](https://developers.cloudflare.com/ai-gateway/features/caching/) (Cloudflare, current) | Exact-match on full body; semantic caching not supported | VC | none | gateway | yes (duplicate count) |
| [Helicone caching](https://docs.helicone.ai/features/advanced-usage/caching) (Helicone, current) | Exact-match only; no hit-rate numbers | VC | none | gateway | yes (duplicate count) |
| [Kong ai-semantic-cache](https://developer.konghq.com/plugins/ai-semantic-cache/) (Kong, current) | Qualitative benefits only | VC | none | gateway | needs gateway |
| [Preto](https://preto.ai/blog/semantic-caching-llm/), [PremAI](https://blog.premai.io/semantic-caching-for-llms-how-to-cut-api-bills-by-60-without-hurting-quality/) (snippets) | False positives 8–15% at a 0.90 threshold; <0.5% at 0.97, where hits fall to 5–10% | AN | none | gateway | needs gateway |
| [vCache](https://arxiv.org/abs/2502.03771) (ICLR 2026) | Up to 12.5x higher hit rate and 26x lower error vs static thresholds | BM | none | gateway | needs gateway |
| [Key collision attack](https://arxiv.org/html/2601.23088v1) (arXiv, 2026-01) | Adversarial inputs trigger false hits across users | BM | none | gateway | no |
| [Batch processing](https://platform.claude.com/docs/en/build-with-claude/batch-processing) (Anthropic, current) | Batch cache hits 30–98% best-effort; no pre-warming inside a batch | VC | batch | client (direct API) | yes (pricing simulation) |
| [Pricing](https://platform.claude.com/docs/en/about-claude/pricing) (Anthropic, current) | Batch and cache multipliers stack; fast mode not with batch; Managed Agents have no batch mode | VC | batch | client | yes |
| [Batch guide](https://developers.openai.com/api/docs/guides/batch) (OpenAI, current) | −50%, 24h window; silent on caching | VC | batch | client | no |
| [OpenAI community](https://community.openai.com/t/prompt-caching-in-batching-api/1223191) (c. 2025-04), [LeanLM](https://leanlm.ai/blog/llm-batch-api) (2026-06) | Conflicting: no caching in batch vs caching on GPT-5+; claims −73–77% combined | AN | batch | client | no |
| [LLM gateway](https://code.claude.com/docs/en/llm-gateway) (Anthropic, current) | Gateways "enforce budgets and rate limits"; no savings figures | VC | none (guardrail) | gateway | needs gateway |
| [LiteLLM budgets](https://docs.litellm.ai/docs/proxy/users) (LiteLLM, current) | Per-key, team and user budgets and TPM/RPM limits; no savings figures | VC | none (guardrail) | gateway | needs gateway |
| [Kong ai-rate-limiting-advanced](https://developer.konghq.com/plugins/ai-rate-limiting-advanced/) (Kong, current) | Token or cost rate limits; HTTP 429 when exceeded | VC | none (guardrail) | gateway | needs gateway |
| [CLI reference](https://code.claude.com/docs/en/cli-reference) (Anthropic, current) | `--max-budget-usd` caps print-mode spend, including subagents (v2.1.217+) | VC | none (guardrail) | client | yes |

### Config: response caching, batch, budgets

**Claude Code: client.** There is no client response cache and no batch mode. The client-side levers are a headless budget cap and cross-machine prefix reuse:

```bash
# verified verbatim flags (code.claude.com/docs/en/cli-reference)
claude -p --max-budget-usd 5.00 --max-turns 20 --output-format json \
  --exclude-dynamic-system-prompt-sections "query"
```

```jsonc
// Route through a gateway for per-developer attribution and budgets — verified (llm-gateway-connect)
{ "env": { "ANTHROPIC_BASE_URL": "https://llm-gateway.example.com",
           "ANTHROPIC_AUTH_TOKEN": "sk-gateway-key",
           "ANTHROPIC_CUSTOM_HEADERS": "X-Org-Route: prod\nX-Tenant: example",
           "CLAUDE_CODE_API_KEY_HELPER_TTL_MS": "900000" },
  "apiKeyHelper": "~/bin/get-gateway-key.sh" }
// With a gateway credential active: subscription limits don't apply, billing is per-token,
// and usage is NOT reported to Console analytics — attribution must come from the gateway.
```

**Gateway: exact and semantic cache** (keep semantic cache off by default for agent traffic).

```yaml
# LiteLLM — verified (docs.litellm.ai/docs/proxy/caching)
litellm_settings:
  cache: True
  cache_params:
    type: redis-semantic
    redis_semantic_cache_embedding_model: text-embedding-ada-002
    similarity_threshold: 0.95
    ttl: 3600
    supported_call_types: ['completion', 'acompletion']
    mode: default_off          # opt in per request
# headers: Cache-Control: no-cache | no-store | max-age=7200 ; x-litellm-cache-ttl: 1800
```

```jsonc
// Portkey — verified; "simple" = exact match (all plans), "semantic" = Enterprise
{ "cache": { "mode": "simple", "max_age": 60 } }

// Bifrost — verified; dimension:1 with no provider/embedding_model = exact-only
{ "name": "semantic_cache", "enabled": true,
  "config": { "provider": "openai", "embedding_model": "text-embedding-3-small", "dimension": 1536,
              "ttl": "5m", "threshold": 0.8, "conversation_history_threshold": 3,
              "exclude_system_prompt": false, "cache_by_model": true, "cache_by_provider": true } }
// per-request: x-bf-cache-key (required), x-bf-cache-ttl, x-bf-cache-threshold, x-bf-cache-type, x-bf-cache-no-store
```

```text
# Cloudflare AI Gateway (verified): cf-aig-cache-ttl: <60s..1 month>, cf-aig-skip-cache: true, cf-aig-cache-key: <key>; read cf-aig-cache-status
# Helicone (verified): Helicone-Cache-Enabled: true ; Cache-Control: max-age=604800 ; Helicone-Cache-Bucket-Max-Size: 1 ; Helicone-Cache-Seed: user-123
# Kong ai-semantic-cache: field names verified (config.vectordb.strategy/threshold/dimensions, config.embeddings.model.*,
#   config.message_countback, config.exact_caching, config.ignore_system_prompts, cache_ttl); full nesting UNVERIFIED
```

**Gateway: budgets and rate limits.**

```bash
# LiteLLM per-developer virtual key — verified keys; values are examples
curl 'http://0.0.0.0:4000/key/generate' -H 'Authorization: Bearer <master-key>' -H 'Content-Type: application/json' \
  --data '{"max_budget":100,"budget_duration":"30d","soft_budget":80,"tpm_limit":200000,"rpm_limit":60,
           "max_parallel_requests":10,
           "budget_limits":[{"budget_duration":"24h","max_budget":10},{"budget_duration":"30d","max_budget":100}]}'
```

```yaml
litellm_settings:            # proxy-wide — verified
  max_budget: 500
  budget_duration: 30d
  fail_closed_budget_enforcement: true
---
# Kong ai-rate-limiting-advanced — policy shape verified; placement of tokens_count_strategy: cost is UNVERIFIED
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

Batching requires leaving Claude Code and calling the Message Batches API directly, with independent single-shot requests that share a prefix marked `"cache_control": {"type":"ephemeral","ttl":"1h"}`. The gateway note did not re-fetch this syntax, but the caching note verified it. Portkey budgets, Cloudflare rate limits, OpenRouter key limits, Anthropic Console spend limits and LiteLLM `/v1/batches` passthrough were **not verified**.

## Context lifecycle has the strongest evidence and the most client-side levers

Every other category's evidence leads back here. Cost grows linearly with context, since a 900k-token request bills at the same per-token rate as a 9k one ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)). Claude Code's docs attribute unexpectedly high spend to "long sessions that were never cleared" ([costs](https://code.claude.com/docs/en/costs)). Default auto-compaction on 1M-native models fires at **about 967K tokens** ([model-config](https://code.claude.com/docs/en/model-config)), so opthub's 52.9%-of-spend cohort with median context ≥250k almost certainly never compacts.

Quality also falls with length. Performance drops **13.9–85%** as input grows, even with perfect retrieval ([Du et al.](https://arxiv.org/abs/2510.05381)), and focused ~300-token prompts beat ~113k-token prompts on every one of 18 models tested ([Chroma](https://www.trychroma.com/research/context-rot)). Shorter context can therefore improve the blind grade, not just the bill.

The ways to shrink context differ sharply in cost and risk:

- **Observation masking** keeps only the last 10 tool outputs. It cut SWE-bench cost by **more than 50%**, and with Qwen3-Coder 480B it was 52% cheaper and solved 2.6% more ([JetBrains](https://blog.jetbrains.com/research/2025/12/efficient-context-management/)). Anthropic's context editing cut tokens **84%** on a 100-turn eval ([Anthropic](https://claude.com/blog/context-management)).
- **LLM summarization** made trajectories 13–15% longer ([JetBrains](https://blog.jetbrains.com/research/2025/12/efficient-context-management/)). On real SWE traces, every compaction method scored only **2.19–2.45/5 on artifact tracking** ([Factory](https://factory.com/news/evaluating-compression)).
- **`/compact` itself** is "a large request", while `/clear` "costs nothing" ([costs](https://code.claude.com/docs/en/costs)). One issue reports each compaction re-writing about 97k unchanged tokens to cache ([#94197](https://github.com/anthropics/claude-code/issues/94197)).

So the order to test is: clear or cap tool output first, since it is deterministic and exactly simulable; lower the compaction threshold second; and grade quality rather than assume it.

Tool schemas are the other big prefix item. MCP definitions measured ~55k tokens for 5 servers and 134k in the worst case, and tool search cut that 85% while raising Opus 4.5 MCP-eval accuracy from 79.5% to 88.1% ([Anthropic](https://www.anthropic.com/engineering/advanced-tool-use)). A user measured 66–82k tokens of MCP definitions ([Scott Spence](https://scottspence.com/posts/optimising-mcp-server-context-usage-in-claude-code)). Claude Code now defers MCP tools by default, **except when `ANTHROPIC_BASE_URL` points to a non-first-party host**, because "most proxies don't forward `tool_reference` blocks" ([env-vars](https://code.claude.com/docs/en/env-vars)). Every gateway user may therefore be paying the full schema tax on every turn.

| Source (publisher, date) | Claim + number | Strength | opthub lever | Runs | Replay-testable |
|---|---|---|---|---|---|
| [Context Rot](https://www.trychroma.com/research/context-rot) (Chroma, 2025-07-14) | 18 models: ~300-token focused prompts beat ~113k-token full prompts on every model | BM | context-lifecycle | client | yes (quality) |
| [Context length alone hurts](https://arxiv.org/abs/2510.05381) (EMNLP 2025 Findings, 2025-10) | −13.9% to −85% as length grows, even with perfect retrieval | BM | context-lifecycle | client | yes (quality) |
| [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (Anthropic, 2025-09-29) | Tool-result clearing is the "safest, lightest-touch" compaction; subagents return 1–2k-token summaries | VC | context-lifecycle | client | yes |
| [Tool search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) (Anthropic, current) | Tool selection degrades beyond 30–50 tools | VC | prefix-trim | client | yes |
| [Manage costs](https://code.claude.com/docs/en/costs) (Anthropic, current) | Cost scales with context; `/compact` is a large request; `/clear` is free | VC | context-lifecycle | client | yes |
| [Model config](https://code.claude.com/docs/en/model-config) (Anthropic, current) | Default auto-compact at ~967K on 1M-native models | VC | context-lifecycle | client | yes |
| [Pricing](https://platform.claude.com/docs/en/about-claude/pricing) (Anthropic, current) | 1M window at standard per-token price (no long-context premium) | VC | context-lifecycle | client | yes |
| [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (Anthropic, 2025-06-13) | Tokens explain 80% of variance; agents use ~4x chat tokens, multi-agent ~15x; +90.2% quality | VC | context-lifecycle | client | yes |
| [Evaluating compression](https://factory.com/news/evaluating-compression) (Factory, 2025-12-16) | Anchored 3.70 vs Anthropic 3.44 vs OpenAI 3.35; 98.6–99.3% compression; artifact trail 2.19–2.45/5 | BM | context-lifecycle | client | yes |
| [The Complexity Trap](https://blog.jetbrains.com/research/2025/12/efficient-context-management/) (JetBrains, 2025-12) | Masking over 50% cheaper; summarization +13–15% trajectory length; hybrid −7% vs masking alone | BM | context-lifecycle | client | yes (exact simulation) |
| [Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use) (Anthropic, 2025-11-24) | 5 MCP servers ~55K tokens (134K worst); tool search −85%; accuracy 79.5→88.1% | VC | prefix-trim | client / gateway | needs gateway (for gateway users) |
| [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) (Anthropic, 2025-11-04) | 150,000→2,000 tokens (−98.7%, illustrative) | VC | prefix-trim | client | no |
| [Optimising MCP context](https://scottspence.com/posts/optimising-mcp-server-context-usage-in-claude-code) (Scott Spence, 2025-09-30) | MCP took 66–82k tokens; merging tools gave −60% on one server | AN | prefix-trim | client | yes |
| [atcyrus](https://www.atcyrus.com/stories/mcp-tool-search-claude-code-context-pollution-guide), [claudefa.st](https://claudefa.st/blog/tools/mcp-extensions/mcp-tool-search) (secondary) | Tool search ~12K→~600 tokens (−95%); launch date and version unverified | AN | prefix-trim | client | yes |
| [Env vars](https://code.claude.com/docs/en/env-vars), [MCP](https://code.claude.com/docs/en/mcp) (Anthropic, current) | MCP deferred by default; **off behind a non-first-party `ANTHROPIC_BASE_URL`** | VC | prefix-trim | gateway | needs gateway |
| [Managing context](https://claude.com/blog/context-management) (Anthropic, 2025-09-29) | Context editing −84% tokens; +29% alone, +39% with memory | VC | context-lifecycle | client | yes |
| [LLMLingua](https://github.com/microsoft/LLMLingua) (Microsoft, 2023–2024) | Up to 20x compression; LongLLMLingua +21.4% RAG accuracy at 1/4 tokens (RAG/QA, not agents) | BM | prefix-trim | gateway | needs gateway |
| [AI Prompt Compressor](https://developer.konghq.com/plugins/ai-prompt-compressor/) (Kong, current) | LLMLingua-2 compression plugin (3.11+); no savings number | VC | prefix-trim | gateway | needs gateway |
| [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) (Manus, 2025-07-18) | <20 atomic tools; mask tools rather than remove them (cache); ~50 tool calls per task | MP | prefix-trim | client | no |
| [Don't build multi-agents](https://cognition.com/blog/dont-build-multi-agents) (Cognition, 2025-06-12) | LLM history compression "hard to get right"; prefers read-only subagents | AN | context-lifecycle | client | no |
| [Manus notes](https://rlancemartin.github.io/2025/10/15/manus/) (Lance Martin, 2025-10) | Compact stale tool results to references; summarize only at diminishing returns | AN | context-lifecycle | client | yes |

### Config: compaction, clearing, tool slimming, output limits

**Claude Code: client.** Verified in [settings-reference](https://code.claude.com/docs/en/settings-reference), [env-vars](https://code.claude.com/docs/en/env-vars), [model-config](https://code.claude.com/docs/en/model-config) and [hooks](https://code.claude.com/docs/en/hooks).

```jsonc
// ~/.claude/settings.json
{
  "autoCompactEnabled": true,
  "autoCompactWindow": 250000,               // tokens, 100000–1000000 (default ~967K on 1M-native models)
  "bashOutputMaxChars": 16000,               // 4000–128000, v2.1.261+; overflow goes to a file + preview
  "disableClaudeAiConnectors": true,
  "env": {
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "60", // 1–100 % of window; can only LOWER the threshold; applies to subagents
    "ENABLE_TOOL_SEARCH": "true",            // unset = defer all; "auto" | "auto:N" | "false"; set explicitly behind a gateway ONLY if it forwards tool_reference
    "MAX_MCP_OUTPUT_TOKENS": "10000"         // default 25000
  }
}
```

```bash
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=250000   # plain integer only ("500k" reads as 500); overrides /autocompact and --autocompact
export DISABLE_AUTO_COMPACT=1                   # keeps manual /compact
export DISABLE_COMPACT=1                        # disables all compaction
export CLAUDE_CODE_DISABLE_1M_CONTEXT=1         # hold 1M-native models to 200K
export BASH_MAX_OUTPUT_LENGTH=30000             # chars; default 30000, max 150000 (older lever than bashOutputMaxChars)
export CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS=<n>
export CLAUDE_CODE_MAX_OUTPUT_TOKENS=16000      # CONFLICT: listed in env-vars reference per one note (default 32000 for unrecognized IDs;
                                                # raising it shrinks effective context before compaction); another note did not find it — verify
```

Compaction steering uses `/compact Focus on test output and code changes` or a `# Compact instructions` section in CLAUDE.md. The `PreCompact` and `PostCompact` hooks take matchers `manual` and `auto`, and PreCompact can block compaction by returning `decision:"block"`. The docs also describe a PreToolUse/PostToolUse hook that greps logs, taking output "from tens of thousands of tokens to hundreds". The notes do not include a full hook JSON example, so none is given here. The notes found **no user-facing key for Claude Code's own tool-result-clearing threshold**. A scoped subagent keeps verbose output out of the parent:

```markdown
<!-- .claude/agents/log-digger.md — frontmatter fields verified -->
---
name: log-digger
description: Read test/build logs and return only failing assertions and file:line refs.
tools: Read, Grep, Glob
model: haiku
maxTurns: 8
omitClaudeMd: true
---
Return at most 20 lines. Never paste raw logs.
```

**Anthropic API: client** (for agents built on the SDK):

```python
# Tool-result clearing — beta context-management-2025-06-27 (defaults: trigger 100k, keep 3)
context_management={"edits": [{"type": "clear_tool_uses_20250919",
    "trigger": {"type": "input_tokens", "value": 30000},
    "keep": {"type": "tool_uses", "value": 3},
    "clear_at_least": {"type": "input_tokens", "value": 5000},
    "exclude_tools": ["web_search"]}]}
# Server-side compaction — beta compact-2026-01-12; trigger min 50,000, default 150,000
context_management={"edits": [{"type": "compact_20260112", "trigger": {"type": "input_tokens", "value": 100000}}]}
# On-demand compaction (beta compact-2026-09-04, top-level `compaction` param): body schema UNVERIFIED
```

```jsonc
// Tool search + deferred tools (API). Whether the advanced-tool-use-2025-11-20 beta header is still required is UNVERIFIED
"tools": [ {"type": "tool_search_tool_bm25_20251119", "name": "tool_search_tool_bm25"},
           {"name": "github_create_issue", "description": "...", "input_schema": {}, "defer_loading": true} ]
```

**Other agents.**

```toml
# Codex CLI ~/.codex/config.toml — verified keys
model_auto_compact_token_limit = 180000
tool_output_token_limit = 8000
# also: model_auto_compact_token_limit_scope, model_context_window, compact_prompt, experimental_compact_prompt_file,
#       mcp_servers.<id>.tools.<tool>.output_token_limit, skills.max_context_tokens (default 2% of window)
# OpenAI Responses API: context_management=[{"type":"compaction","compact_threshold":200000}]
```

Roo Code has a UI setting, "intelligent context condensing". It is on by default, its threshold defaults to 100%, and its custom prompt lives at `customSupportPrompts.CONDENSE`. Aider exposes `--map-tokens` (default 1k), `--map-refresh`, `--map-multiplier-no-files` and `--max-chat-history-tokens`; only the map-tokens default is verified. **Cline Auto Compact has no documented setting names**, and the notes found nothing for Cursor or Continue. On the gateway side, Kong's AI Prompt Compressor needs an external LLMLingua-2 service, and **its field names are UNVERIFIED**.

## Effort and fast mode move only the output slice, which is 14–22% of Claude Code dollars

The benchmark evidence on effort is real but was measured where output is a larger share of the bill. On Aider polyglot, GPT-5 high→medium lost **1.3 points for 39% less cost**, and high→low lost **6.7 points for 64% less** ([Aider leaderboard](https://aider.chat/docs/leaderboards/)). The accuracy curve is shallow at the top and steep at the bottom. The same table shows that thinking does not always add cost: Opus 4 with 32k thinking was 1.3 points better *and* 4% cheaper. Anthropic says Opus 4.5 at medium effort matched Sonnet 4.5's best SWE-bench Verified score with **76% fewer output tokens** ([Anthropic](https://www.anthropic.com/news/claude-opus-4-5)), and that effort affects all output tokens, "fewer and terser tool calls" included ([effort docs](https://platform.claude.com/docs/en/build-with-claude/effort)).

In Claude Code sessions, though, output is only about 14–22% of dollars (see the baselines section), and Opus 5.5 and Sonnet 5.5 already default to `medium` ([model-config](https://code.claude.com/docs/en/model-config)). opthub's 2.4% headroom sits slightly below the naive 4–15% range the notes derive. The already-medium default accounts for that, and so does the risk that low effort causes retries.

Fast mode is never a saving. It costs **exactly 2.0x** on Opus 5.5, $8/$40 against $4/$20, for "up to 2.5x" speed. Enabling it mid-conversation also bills the entire context at the uncached fast input rate. On Opus 5.5 that is $8/MTok instead of a $0.20/MTok cache read, a 40x step on one turn (the notes' arithmetic from [fast mode](https://code.claude.com/docs/en/fast-mode) and [pricing](https://platform.claude.com/docs/en/about-claude/pricing)). OpenAI's renamed Priority/Fast tier is likewise 2x ([OpenAI](https://openai.com/api-priority-processing/)), and trackers that ignore `service_tier` undercount it by half ([tokscale #1347](https://github.com/junhoyeo/tokscale/issues/1347)).

| Source (publisher, date) | Claim + number | Strength | opthub lever | Runs | Replay-testable |
|---|---|---|---|---|---|
| [Aider leaderboard](https://aider.chat/docs/leaderboards/) (Aider, 2025 models) | GPT-5 high 88.0%/$29.08, medium 86.7%/$17.69, low 81.3%/$10.37 | BM | effort-tuning | client | yes (analog) |
| [Aider leaderboard](https://aider.chat/docs/leaderboards/) (Aider, 2025) | o3 high +4.4 pp for +54% cost; o3-mini high +6.6 pp for +105% | BM | effort-tuning | client | yes (analog) |
| [Aider leaderboard](https://aider.chat/docs/leaderboards/) (Aider, 2025) | Sonnet 4 thinking +4.9 pp/+68% cost; Opus 4 thinking +1.3 pp and 4% cheaper | BM | effort-tuning | client | yes (analog) |
| [Introducing Opus 4.5](https://www.anthropic.com/news/claude-opus-4-5) (Anthropic, 2025-11-24) | Medium effort matches Sonnet 4.5's best with 76% fewer output tokens | VC | effort-tuning | client | yes |
| [Effort docs](https://platform.claude.com/docs/en/build-with-claude/effort) (Anthropic, current) | Top-level effort change invalidates cache; `max` adds cost for small gains; Sonnet 5 medium ≈ Sonnet 4.6 high | VC | effort-tuning, cache-priming detector | client | yes |
| [Model config](https://code.claude.com/docs/en/model-config) (Anthropic, current) | Opus 5.5/Sonnet 5.5 default `medium`; Opus 4.7 `xhigh`; thinking can't be turned off on 5.5 models | VC | effort-tuning | client | yes |
| [GPT-5.1-Codex-Max](https://openai.com/index/gpt-5-1-codex-max/) (OpenAI, 2025-11) | 30% fewer thinking tokens at medium effort vs GPT-5.1-Codex | VC | effort-tuning | client | no |
| [Pricing](https://platform.claude.com/docs/en/about-claude/pricing) (Anthropic, current) | 4.7+ tokenizer produces ~30% more tokens for the same text | VC | effort-tuning | client | yes (normalization) |
| [Fast mode](https://code.claude.com/docs/en/fast-mode) (Anthropic, current) | Up to 2.5x faster at 2.0x price; first enable re-bills context uncached | VC | cache-priming detector | client | yes |
| [Fast mode / Priority](https://openai.com/api-priority-processing/) (OpenAI, renamed 2026-07-30; snippet) | 2x on all tokens, up to 2.5x faster | VC | none (spend) | client | no |
| [tokscale #1347](https://github.com/junhoyeo/tokscale/issues/1347) (GitHub) | Ignoring `service_tier` undercounts fast spend 50% | AN | none (accounting) | client | no |
| [Predicted outputs](https://developers.openai.com/api/docs/guides/predicted-outputs) (OpenAI, 2024 feature) | Rejected tokens billed; no tools, older non-reasoning models only | VC | none | client | no |
| [Reasoning content](https://docs.litellm.ai/docs/reasoning_content) (LiteLLM, current) | `reasoning_effort` "high" = only 4096 budget tokens on legacy Claude | VC | effort-tuning | gateway | needs gateway |

### Config: effort, thinking, fast mode

**Claude Code: client.** Verified in [model-config](https://code.claude.com/docs/en/model-config), [costs](https://code.claude.com/docs/en/costs) and [fast mode](https://code.claude.com/docs/en/fast-mode).

```jsonc
// ~/.claude/settings.json
{
  "modelSettings": {                                   // per-model; overrides global effortLevel
    "claude-opus-5-5":   { "effortLevel": "medium" },
    "claude-sonnet-5-5": { "effortLevel": "low" }
  },
  "effortLevel": "high",                               // low | medium | high | xhigh | max
  "alwaysThinkingEnabled": false,                      // no effect on Opus 5.5 / Sonnet 5.5 / Fable (thinking always on)
  "fastMode": false,
  "fastModePerSessionOptIn": true                      // sessions start non-fast; enable at session start, not mid-session
}
// managed-only: "maxEffortLevel" (key verified; value syntax UNVERIFIED, assumed a level string like "high")
// managed-only: "modelPricing" (v2.1.242+) to report spend at contracted rates
```

```bash
export CLAUDE_CODE_EFFORT_LEVEL=medium    # or: claude --effort low ; in-session: /effort low
export MAX_THINKING_TOKENS=8000           # fixed-budget models only (Opus 4.6, Sonnet 4.6); adaptive models ignore nonzero values
export CLAUDE_CODE_DISABLE_FAST_MODE=1    # kill switch
claude -p --settings '{"fastMode": true}' "..."   # headless fast (v2.1.205+)
claude -p "..." --effort low --max-budget-usd 2   # composition of two documented flags — UNTESTED together
```

`CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS=1` and `CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK=1` affect only the client-side availability check behind a gateway.

**API: client.**

```jsonc
{ "model": "claude-opus-5-5", "max_tokens": 64000, "output_config": { "effort": "low" } }
// cache-preserving per-message change: {"role":"system","content":[],"output_config":{"effort":"low"}}
//   + beta header mid-conversation-output-config-2026-07-01 (Opus 5/5.5, Sonnet 5.5, Fable 5.1)
// fast: "speed": "fast" (OpenAI: "service_tier": "priority" | "fast")
```

**Gateway.** LiteLLM maps `reasoning_effort` to `thinking.budget_tokens` on pre-4.6 Claude: low 1024, medium 2048, high 4096, xhigh 8192, max 16384 (overridable via `DEFAULT_REASONING_EFFORT_*_THINKING_BUDGET`). On 4.6+ it sends adaptive thinking with `output_config.effort`. **Routing Claude Code through LiteLLM with `reasoning_effort` set can silently lower thinking.**

**Other agents.**

```toml
# Codex CLI — verified
model_reasoning_effort = "medium"      # low|medium|high|xhigh|max|ultra, as the model advertises
plan_mode_reasoning_effort = "high"
model_reasoning_summary = "none"
model_verbosity = "low"
service_tier = "fast"                  # maps to request value "priority" — 2x spend
```

```bash
# Aider — verified
aider --model o3 --reasoning-effort medium
aider --model sonnet --thinking-tokens 8k      # in chat: /reasoning-effort high, /thinking-tokens 4k
```

The notes found no effort keys for Cursor, Cline/Roo, Continue or Kong.

## Coding-agent spend is 94–97% cache reads by token and 50–66% by dollar

The baseline data explains why the levers rank as they do. By token count, cache reads are 94–97% of coding-agent traffic and output is under 1%. Across 1,674 sessions in Cursor, Claude Code and Codex, **94.2% of tokens were cache reads and 0.6% agent output** ([SwiftLee](https://www.avanderlee.com/ai-development/reduce-token-usage-claude-code-codex-cursor/)). By dollars at Anthropic rates the split changes: cache reads are about 50–66%, cache writes 19–34% and output 14–22%. The notes derive this from the one-week 1.36B-token dataset and Anthropic's own `/usage` example ([costs](https://code.claude.com/docs/en/costs)). Context size and cache hygiene therefore touch roughly 70–85% of dollars, while effort touches only the output slice.

The same SwiftLee dataset gives the sharpest single prefix-trim example. **48% of 13,323 test runs had unfiltered output**, and filtering one test output cut about 406,500 tokens to about 168.

Anthropic's enterprise anchor is **$13 per developer per active day and $150–250 per month**, with 90% of users under $30 per active day ([costs](https://code.claude.com/docs/en/costs)). opthub's pinned month ($508.80 over 214 sessions) is 2–3x that. This reads as heavy but not extreme use, with the caveat that the vendor figure is per developer.

| Source (publisher, date) | Claim + number | Strength | opthub lever | Runs | Replay-testable |
|---|---|---|---|---|---|
| [Manage costs](https://code.claude.com/docs/en/costs) (Anthropic, current) | $13/dev/active day; $150–250/dev/month; 90% under $30/day (no methodology) | MP | baseline | client | yes (comparison) |
| [Manage costs](https://code.claude.com/docs/en/costs) (Anthropic, current) | Agent teams use ~7x tokens when teammates run in plan mode | VC | context-lifecycle, model-routing | client | yes |
| [Manage costs](https://code.claude.com/docs/en/costs) (Anthropic, current) | Background token use typically under $0.04 per session | VC | model-routing | client | yes |
| [Manage costs](https://code.claude.com/docs/en/costs) (Anthropic, current) | `/usage` example $0.55; dollar split read 51% / write 34% / output 14% | VC | baseline | client | yes |
| [Reduce token usage](https://www.avanderlee.com/ai-development/reduce-token-usage-claude-code-codex-cursor/) (SwiftLee, 2026-09-28) | 1,674 sessions: 94.2% cache reads, 0.6% output; 48% of 13,323 test runs unfiltered; 406,500→168 tokens | MP | prefix-trim, context-lifecycle | client | yes |
| [Claude Code token usage](https://www.faros.ai/blog/claude-code-token-usage) (Faros AI, 2026-06-25) | −50% cost per task over 211 replayed tasks; subagents add 200–500% overhead; one grep = 10–15k tokens | VC | model-routing, context-lifecycle | client | yes |
| [claude-code #94197](https://github.com/anthropics/claude-code/issues/94197) (GitHub, title only) | Each compaction re-writes ~97k unchanged tokens; "$6.7k/month on a 10-agent fleet" | AN | context-lifecycle, cache-priming detector | client | yes |
| [MorphLLM](https://www.morphllm.com/ai-coding-costs), [CloudZero](https://www.cloudzero.com/blog/claude-code-pricing/) (secondary) | Gartner: ~¼ of tech leaders spend $200–500/dev/month; Pragmatic Engineer: $100–200 | AN | baseline | — | no |

### Config: measuring the baseline before replaying

```bash
claude -p "hello" --output-format json      # usage.cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens
# in session: /usage (Prompt cache (main) hit ratio, v2.1.251+; "likely cause" of last miss, v2.1.260+), /context (MCP + prefix audit), /cost
aider --no-stream                           # Aider hides cache stats while streaming
```

Faros's "replay 211 real tasks across seven model and harness routes" is the closest public analog to opthub's method. It remains a vendor claim with no published quality grading.

## Top replay candidates for Claude Code sessions

The candidates below are ranked by plausible dollar effect on sessions like opthub's pinned month, restricted to configs that are client-runnable or that need only a sandboxed gateway. Each hypothesis is stated so that a replay can falsify it. Because identical runs flip 5.37% of outcomes ([arXiv 2608.23023](https://arxiv.org/abs/2608.23023)), each should be replayed several times before the blind grade is trusted.

| Rank | Config to replay | Hypothesis | What would falsify it | Evidence base |
|---|---|---|---|---|
| 1 | `"autoCompactWindow": 250000` or `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=25` (1M-native models), vs default ~967K | In the 52.9%-of-spend cohort (median context ≥250k), a lower threshold cuts per-turn cache-read dollars roughly in proportion to context removed. The saving exceeds the compaction call plus the post-compaction cache re-write, and the grade holds or improves | Net dollars rise once compaction requests and ~97k-token re-writes ([#94197](https://github.com/anthropics/claude-code/issues/94197)) are counted; or the grade drops through lost file tracking (Factory artifact trail 2.19–2.45/5), seen as the agent re-reading files it already had | JetBrains, Chroma, Du et al., Factory, model-config default |
| 2 | Tool-output caps: `bashOutputMaxChars: 16000`, `MAX_MCP_OUTPUT_TOKENS=10000`, `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`, plus a log-digger subagent on `haiku` | Clipping or delegating verbose tool results removes tokens that are then carried in every later turn. This is the deterministic lever with the best evidence (−50% JetBrains, −84% Anthropic) | The agent re-runs commands or re-reads files to recover truncated output, so turn count and tokens rise; or failing-test details are lost and the grade drops | JetBrains, Anthropic context editing, SwiftLee 406,500→168 |
| 3 | `ENABLE_TOOL_SEARCH=true` behind a gateway that forwards `tool_reference` (sessions with a custom `ANTHROPIC_BASE_URL`) | Gateway sessions carry full MCP schemas (tens of thousands of tokens) in every turn because deferral is off. Enabling tool search removes most of that and may raise tool-selection accuracy | Transcripts show a small tool prefix (few MCP servers); or the gateway rejects or strips `tool_reference`; or deferred loading triggers extra cache invalidations that cost more than the schema savings | Anthropic advanced tool use (−85%), env-vars doc, Scott Spence |
| 4 | Subagent model: `CLAUDE_CODE_SUBAGENT_MODEL=haiku` + `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`, or a user-defined `Explore` agent with `model: haiku` (patch frontmatter too, since v2.1.251 precedence) | Read-only exploration subagents cost 30–60% less with no grade loss, because they return 1–2k-token summaries to a strong parent | Blind grader finds missed findings, as in opthub's router that missed a security issue; or Haiku subagents take more turns or tokens so per-task cost rises ([Switchcraft](https://arxiv.org/abs/2605.07112)); or parent rework offsets the savings | Blogs (AN), Aider architect split, Anthropic 1–2k summaries |
| 5 | `"subagentPromptCacheTtl": "1h"`; for API-key or overage users also `"promptCacheTtl": "1h"` | Subagents and API-key sessions default to 5m. Every idle gap of 5–60 minutes (long builds, reviews) forces a full re-write that 1h would avoid, and one avoided re-write repays the 0.75x premium | The idle-gap distribution shows few gaps of 5–60 minutes (bursty work), so the extra 0.75x per write exceeds the avoided re-writes. The ceiling is #46829's 17–26% of cache-creation spend | #46829, Vercel arithmetic, Claude Code caching docs |
| 6 | Prefix-trim: shrink CLAUDE.md; `--exclude-dynamic-system-prompt-sections` for headless runs | A static prefix re-read ~1,000 times per I/O token dominates cache-read dollars, so halving CLAUDE.md cuts that line nearly proportionally | Instructions removed from CLAUDE.md are needed: the grade drops or the agent spends turns rediscovering conventions | #24147, Manus, ProjectDiscovery |
| 7 | `modelSettings` / `effortLevel: "low"` (from the default `medium`) | Output-token savings are real but land on a 14–22% dollar slice, so net saving is at most about the 2.4% headroom opthub already estimated | The grade drops more than the noise floor (Aider medium→low −5.4 pp); or retries and extra turns push total cost *up*; or effort switches cause cache writes (on Bedrock/Vertex, or top-level effort via API) | Aider leaderboard, Opus 4.5 claim, model-config defaults |
| 8 | `"fastModePerSessionOptIn": true` (detector, not saver) | Mid-session fast enables account for measurable one-turn 40x re-bills; forcing opt-in at session start removes them with no quality effect | Transcripts contain no mid-session fast-mode enables | Fast mode docs, pricing |

Rank 1 comes first because it acts on the largest dollar pool (cache reads at 50–66% of spend) in exactly the sessions opthub already flagged, and Claude Code's defaults visibly leave it untouched. Ranks 2 and 3 are prefix and context reductions with the strongest measured evidence. Rank 3 is also the only one that exposes a hidden cost of adopting a gateway. Rank 4 carries the highest quality risk and needs the blind grader most. Rank 5 has the cleanest arithmetic but depends entirely on each developer's idle-gap distribution, which no public study measures and opthub's transcripts can supply. Rank 7 is expected to confirm a small effect. Its value is showing developers that lowering effort is not where the money is.

## Gaps, conflicts and unverifiable claims

The largest gap is structural. **No public source measures any of these levers on long, multi-hour Claude Code sessions with a quality grade attached.** No study measures Claude Code's own auto-compaction accuracy cost, the idle-gap distribution that decides 1h vs 5m, the savings of `opusplan` vs all-Opus, subagent vs inline work on cost and quality, local models across 100+ tool-call sessions, or how often each cache invalidator fires in practice. There is also no measured semantic-cache hit rate or false-positive rate on coding traffic, no independent in-batch cache hit rate beyond Anthropic's 30–98% range, and no savings study of budgets or rate limits. The notes found no public Cursor, Sourcegraph/Amp, Replit, Factory or Cognition cache or context numbers, no independent reproduction of Anthropic's 76%-fewer-tokens, 84% context-editing or 85% tool-search figures, and no 2026 effort sweep for Opus 5.5 or Sonnet 5.5. TwinRouterBench, which scores routers live on 500 SWE-bench cases by resolution rate and actual cost, publishes no headline numbers in its abstract ([arXiv 2605.18859](https://arxiv.org/abs/2605.18859)). It is the public benchmark closest to opthub's method and is worth reading in full.

Several claims rest on weak provenance and should not be quoted as fact:

- **Snippets or aggregators only:** Citare's 25–35%, Synrouter's $1.73 vs $0.09, MegaBrain's keepalive 40/40, the claude-code-router "80%" headline, the subagent-to-Haiku 30–60% blogs, Not Diamond's Haiku 40–70%, the RouterArena rank of Not Diamond, the semantic-cache false-positive rates, Gartner and Pragmatic Engineer spend figures, and the MCP tool search launch date and version.
- **Suspect date:** the dev.to "97% was cache" post's fetched date (2024-08-07) predates Claude Code.
- **Unverified quotes:** the LiteLLM "goes badly wrong on agentic traffic" wording was not confirmed. OpenAI's primary position on caching inside Batch is unverified, and a community thread contradicts a secondary blog on it.

Some config keys are flagged unverified or conflicting in the notes, and are marked that way in the snippets above:

- **Claude Code:**
  - subagent frontmatter `experimental.cacheTtl` (nesting)
  - `maxEffortLevel` (value syntax)
  - `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (one note verified it in env-vars; another did not find it)
  - whether `/effort` preserves the cache (the prompt-caching doc says yes on 5.5-class models since v2.1.260; the model-config doc says it "may clear cache")
  - the Ollama-plus-Haiku-slot hybrid (untested)
  - `ANTHROPIC_MODEL=smart-router` mapping through LiteLLM
  - the `--effort` plus `--max-budget-usd` composition
- **Anthropic API:** the on-demand compaction body and whether tool search still needs a beta header.
- **Gateways:**
  - LiteLLM's `prompt_caching` pre-call check semantics and fallback syntax
  - OpenRouter's `models` fallback array
  - Kong's semantic-cache nesting, `tokens_count_strategy` placement and Prompt Compressor fields
  - RouteLLM server flags
  - Not Diamond's proxy port
  - any prompt-caching keys for Kong, Cloudflare, Helicone or Bifrost (none found)
- **Other agents:**
  - Continue `cacheBehavior`
  - Aider YAML `cache-prompts`
  - Codex profile layout and max-output key
  - claude-code-router's `Providers` schema
  - Cline Auto Compact settings
  - anything for Cursor

None of these should ship in an opthub recommendation until the replay harness has confirmed that the key is honored.

## Conclusion

The catalog reverses the usual order of confidence. The most-quoted numbers (semantic cache "86%", router "95% quality at 85% less", caching "up to 90%") come from single-turn or vendor-run settings that Claude Code sessions either already beat or structurally cannot use. The quietest evidence points to the biggest remaining money. That evidence is a JetBrains workshop paper on masking tool outputs, one GitHub user's 119,866-call TTL regression, and a line in Claude Code's docs that auto-compaction waits until about 967K tokens. For a developer at a 96.8% cache hit rate, the savings no longer come from "make more of it cached". They come from "carry less of it, for less long". That is a context-lifecycle and prefix problem, and it can be tested on the client.

This is also why opthub's method matters more than any single number in the catalog. Every high-value lever here has an explicit failure mode that only shows up in the developer's own trajectories: lost file tracking after compaction, re-runs after truncated output, missed findings from a cheap subagent, and idle gaps that decide the TTL. The public record can nominate candidates and bound their effects, but it cannot measure these failure modes. Replaying on the developer's own sessions and grading blind can, and nothing in the public record substitutes for it.

## Sources

**Prompt caching and TTL**
- devx AI labs, "I Analyzed 165.9 Million Tokens…" (2026-03-10): https://www.devxlabs.ai/blogs/how-claude-code-actually-works
- Claude Code docs, "How Claude Code uses prompt caching": https://code.claude.com/docs/en/prompt-caching
- anthropics/claude-code #24147 (2026-02-08): https://github.com/anthropics/claude-code/issues/24147
- dev.to, "…Turns Out 97% Was Cache": https://dev.to/flipslidersand/i-thought-i-used-1-billion-tokens-in-claude-code-last-week-turns-out-97-was-cache-1m2i
- Anthropic, "Lessons from building Claude Code: Prompt caching is everything" (2026-04-30): https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/
- anomalyco/opencode #51580 (2026-09-27): https://github.com/anomalyco/opencode/issues/51580
- OpenAI prompt caching guide: https://developers.openai.com/api/docs/guides/prompt-caching
- OpenAI Cookbook, "Prompt Caching 201": https://developers.openai.com/cookbook/examples/prompt_caching_201
- CLIProxyAPI #5300: https://github.com/router-for-me/CLIProxyAPI/issues/5300
- oh-my-pi #10786: https://github.com/can1357/oh-my-pi/issues/10786
- ProjectDiscovery, "How We Cut LLM Costs by 59%…" (2026-04-10): https://projectdiscovery.io/blog/how-we-cut-llm-cost-with-prompt-caching
- Deriv, "How prompt caching cut our production AI agent input costs by 77%" (2026-07-23): https://derivai.substack.com/p/prompt-caching-production-ai-agent-costs
- Manus, "Context Engineering for AI Agents" (2025-07-18): https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- dev.to, "Anthropic Prompt Caching: Real Numbers From 330 Production Calls": https://dev.to/rikuq/anthropic-prompt-caching-real-numbers-from-330-production-calls-2eg4
- MegaBrain, "Your AI Agent's Cache Hit Rate Is Probably 7%" (2026-07-25): https://getmegabrain.com/blog/prompt-cache-hit-rate-myth-2026
- Lumer et al., "Don't Break the Cache" (arXiv 2601.06007): https://arxiv.org/abs/2601.06007
- Anthropic prompt caching docs: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Vercel AI Gateway, automatic caching (2026-09-11): https://vercel.com/docs/ai-gateway/models-and-providers/automatic-caching
- anthropics/claude-code #46829 (2026-04-12): https://github.com/anthropics/claude-code/issues/46829
- dev.to, "…the two-tier write premium…": https://dev.to/rikuq/anthropic-prompt-caching-explained-cachecontrol-markers-the-two-tier-write-premium-and-when-it-25cp
- Synrouter, 5min vs 1hr: https://synrouter.ai/blog/anthropic-cache-ttl-5min-vs-1hr
- Aider prompt caching: https://aider.chat/docs/usage/caching.html
- Cline discussion #414 (2024-09-27): https://github.com/cline/cline/discussions/414
- Gemini context caching: https://ai.google.dev/gemini-api/docs/caching
- OpenRouter prompt caching: https://openrouter.ai/docs/guides/best-practices/prompt-caching
- Portkey gateway #1579: https://github.com/Portkey-AI/gateway/issues/1579
- withastro/flue #662: https://github.com/withastro/flue/issues/662
- openclaw #46709: https://github.com/openclaw/openclaw/issues/46709
- Portkey Anthropic prompt caching: https://portkey.ai/docs/integrations/llms/anthropic/prompt-caching
- LiteLLM prompt caching (completion): https://docs.litellm.ai/docs/completion/prompt_caching
- LiteLLM auto-inject tutorial: https://docs.litellm.ai/docs/tutorials/prompt_caching
- LiteLLM routing: https://docs.litellm.ai/docs/routing
- Continue community sample config: https://github.com/jdraths/continue-dev-config/blob/main/sample.yaml
- Continue reference: https://docs.continue.dev/reference
- Spheron gateway comparison: https://www.spheron.network/blog/ai-gateway-litellm-portkey-kong-gpu-cloud/
- Maxim, semantic-caching gateways: https://www.getmaxim.ai/articles/top-5-ai-gateways-with-semantic-caching-to-cut-llm-api-calls/
- qiyuanlabs-ai/claude-prompt-cache-edge: https://github.com/qiyuanlabs-ai/claude-prompt-cache-edge

**Model routing and local offload**
- LMSYS, RouteLLM (2024-07-01): https://www.lmsys.org/blog/2024-07-01-routellm/
- RouteLLM repo: https://github.com/lm-sys/RouteLLM
- FrugalGPT (arXiv 2305.05176): https://arxiv.org/abs/2305.05176
- Hybrid LLM (arXiv 2404.14618): https://arxiv.org/abs/2404.14618
- RouterArena (arXiv 2510.00202): https://arxiv.org/html/2510.00202v1
- dreaming.press router comparison: https://dreaming.press/posts/2026-06-21-routellm-vs-notdiamond-vs-martian.html
- RouterArena leaderboard: https://routeworks.github.io/?p=%2Fleaderboard
- "Most of the LLM Routing Gap Is Task Type" (arXiv 2608.23023): https://arxiv.org/abs/2608.23023
- Switchcraft (arXiv 2605.07112): https://arxiv.org/abs/2605.07112
- Agent-as-a-Router / CodeRouterBench (alphaXiv 2606.22902): https://www.alphaxiv.org/abs/2606.22902
- TwinRouterBench (arXiv 2605.18859): https://arxiv.org/abs/2605.18859
- arXiv 2608.01347 (coupled variables): https://arxiv.org/abs/2608.01347
- Not Diamond Code (2026-08-04): https://www.notdiamond.ai/blog/not-diamond-code-intelligent-model-routing-for-coding-agents
- Not Diamond homepage: https://www.notdiamond.ai/
- OpenRouter model routing: https://openrouter.ai/docs/features/model-routing
- LiteLLM auto-router + prompt caching benchmark (2026-07-31): https://docs.litellm.ai/blog/auto-router-prompt-caching-benchmark
- LiteLLM auto routing docs: https://docs.litellm.ai/docs/proxy/auto_routing
- LiteLLM auto-router prompt caching: https://docs.litellm.ai/docs/auto_router/prompt_caching
- Aider architect/editor (2024-09-26): https://aider.chat/2024/09/26/architect.html
- Aider options: https://aider.chat/docs/config/options.html
- Claude Code model config: https://code.claude.com/docs/en/model-config
- Claude Code sub-agents: https://code.claude.com/docs/en/sub-agents
- claude-code-router README: https://github.com/musistudio/claude-code-router
- DataCamp claude-code-router tutorial: https://www.datacamp.com/tutorial/claude-code-router
- Morph claude-code-router guide: https://www.morphllm.com/claude-code-router
- aitoolanalysis claude-code-router review: https://aitoolanalysis.com/claude-code-router-review/
- Medium (Monteiro), subagent model routing: https://medium.com/@roanmonteiro/claude-code-subagent-model-routing-stop-paying-for-opus-on-haiku-work-ee76dc32cb88
- byteiota, subagent model routing: https://byteiota.com/claude-code-subagent-model-routing/
- Developers Digest, parallel agents cost: https://www.developersdigest.tech/blog/what-parallel-claude-agents-actually-cost
- Qwen3-Coder-Next: https://qwen.ai/blog?id=qwen3-coder-next
- Morph, best Ollama models: https://www.morphllm.com/best-ollama-models
- Ganglani, local LLM vs Claude (2026-03-27, upd. 2026-07-12): https://www.kunalganglani.com/blog/local-llm-vs-claude-coding-benchmark
- Ollama Claude Code integration: https://docs.ollama.com/integrations/claude-code
- tas-llm-router #100: https://github.com/Tributary-ai-services/tas-llm-router/issues/100
- Codex config reference: https://learn.chatgpt.com/docs/config-file/config-reference

**Semantic caching, batch, budgets**
- Dagde, "The 95% hit rate myth" (dev.to): https://dev.to/gauravdagde/llm-semantic-caching-the-95-hit-rate-myth-and-what-production-data-actually-shows-8ga
- Preto.ai, semantic caching: https://preto.ai/blog/semantic-caching-llm/
- Portkey, semantic caching thresholds: https://portkey.ai/blog/semantic-caching-thresholds/
- TianPan, semantic caching in production (2026-04-09): https://tianpan.co/blog/2026-04-09-semantic-caching-llm-production
- Braintrust, LLM gateway caching: https://www.braintrust.dev/articles/llm-gateway-caching
- Bifrost semantic caching: https://docs.getbifrost.ai/features/semantic-caching
- Portkey cache (simple and semantic): https://portkey.ai/docs/product/ai-gateway/cache-simple-and-semantic
- Cloudflare AI Gateway caching: https://developers.cloudflare.com/ai-gateway/features/caching/
- Helicone caching: https://docs.helicone.ai/features/advanced-usage/caching
- Kong ai-semantic-cache: https://developer.konghq.com/plugins/ai-semantic-cache/
- LiteLLM proxy caching: https://docs.litellm.ai/docs/proxy/caching
- PremAI, semantic caching: https://blog.premai.io/semantic-caching-for-llms-how-to-cut-api-bills-by-60-without-hurting-quality/
- vCache (arXiv 2502.03771): https://arxiv.org/abs/2502.03771 ; OpenReview: https://openreview.net/forum?id=zF0A0xw3HZ
- Key Collision Attack on LLM Semantic Caching (arXiv 2601.23088): https://arxiv.org/html/2601.23088v1
- Anthropic batch processing: https://platform.claude.com/docs/en/build-with-claude/batch-processing
- Anthropic pricing: https://platform.claude.com/docs/en/about-claude/pricing
- OpenAI Batch guide: https://developers.openai.com/api/docs/guides/batch
- OpenAI community, prompt caching in batch: https://community.openai.com/t/prompt-caching-in-batching-api/1223191
- LeanLM, LLM batch API (2026-06): https://leanlm.ai/blog/llm-batch-api
- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
- Claude Code, other LLM gateways: https://code.claude.com/docs/en/llm-gateway
- Claude Code, connect to a gateway: https://code.claude.com/docs/en/llm-gateway-connect
- LiteLLM budgets and rate limits: https://docs.litellm.ai/docs/proxy/users
- Kong ai-rate-limiting-advanced: https://developer.konghq.com/plugins/ai-rate-limiting-advanced/

**Context management**
- Chroma, "Context Rot" (2025-07-14): https://www.trychroma.com/research/context-rot
- Du et al., "Context Length Alone Hurts…" (arXiv 2510.05381): https://arxiv.org/abs/2510.05381 ; ACL Anthology: https://aclanthology.org/2025.findings-emnlp.1264/
- Anthropic, "Effective context engineering for AI agents" (2025-09-29): https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic compaction overview: https://platform.claude.com/docs/en/build-with-claude/compaction
- Anthropic compaction at a token threshold: https://platform.claude.com/docs/en/build-with-claude/compaction-threshold
- Anthropic tool search tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- Claude Code, manage costs: https://code.claude.com/docs/en/costs
- Anthropic, multi-agent research system (2025-06-13): https://www.anthropic.com/engineering/multi-agent-research-system
- Factory, "Evaluating context compression" (2025-12-16): https://factory.com/news/evaluating-compression
- JetBrains Research, "The Complexity Trap" (2025-12): https://blog.jetbrains.com/research/2025/12/efficient-context-management/ ; arXiv 2508.21433: https://arxiv.org/abs/2508.21433 ; code: https://github.com/JetBrains-Research/the-complexity-trap
- Cognition, "Don't Build Multi-Agents" (2025-06-12): https://cognition.com/blog/dont-build-multi-agents
- OpenAI, GPT-5.1-Codex-Max (2025-11): https://openai.com/index/gpt-5-1-codex-max/
- OpenAI compaction guide: https://developers.openai.com/api/docs/guides/compaction
- Claude Code settings reference: https://code.claude.com/docs/en/settings-reference
- Claude Code env vars: https://code.claude.com/docs/en/env-vars
- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Roo Code, intelligent context condensing: https://roocodeinc.github.io/Roo-Code/features/intelligent-context-condensing
- Cline, auto compact: https://docs.cline.bot/features/auto-compact
- Anthropic, "Advanced tool use" (2025-11-24): https://www.anthropic.com/engineering/advanced-tool-use
- Anthropic, "Code execution with MCP" (2025-11-04): https://www.anthropic.com/engineering/code-execution-with-mcp
- Scott Spence, optimising MCP context (2025-09-30): https://scottspence.com/posts/optimising-mcp-server-context-usage-in-claude-code
- atcyrus, MCP tool search guide: https://www.atcyrus.com/stories/mcp-tool-search-claude-code-context-pollution-guide
- claudefa.st, MCP tool search: https://claudefa.st/blog/tools/mcp-extensions/mcp-tool-search
- Lance Martin, Manus notes (2025-10-15): https://rlancemartin.github.io/2025/10/15/manus/
- LangChain x Manus webinar summary (Medium): https://medium.com/@caldasdcardoso/inside-the-langchain-x-manus-webinar-on-context-engineering-69166ee404db
- Anthropic, "Managing context on the Claude Developer Platform" (2025-09-29): https://claude.com/blog/context-management
- Microsoft LLMLingua: https://github.com/microsoft/LLMLingua
- Kong AI Prompt Compressor: https://developer.konghq.com/plugins/ai-prompt-compressor/
- Anthropic context editing: https://platform.claude.com/docs/en/build-with-claude/context-editing
- Anthropic memory tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- Aider repo map: https://aider.chat/docs/repomap.html

**Effort, thinking, fast mode, spend baselines**
- Aider leaderboards: https://aider.chat/docs/leaderboards/
- Anthropic, "Introducing Claude Opus 4.5" (2025-11-24): https://www.anthropic.com/news/claude-opus-4-5
- Anthropic effort docs: https://platform.claude.com/docs/en/build-with-claude/effort
- Claude Code fast mode: https://code.claude.com/docs/en/fast-mode
- OpenAI Fast mode / Priority processing: https://openai.com/api-priority-processing/ ; FAQ: https://help.openai.com/en/articles/11647665-priority-processing-faq
- tokscale #1347: https://github.com/junhoyeo/tokscale/issues/1347
- OpenAI predicted outputs: https://developers.openai.com/api/docs/guides/predicted-outputs
- Aider reasoning settings: https://aider.chat/docs/config/reasoning.html
- LiteLLM reasoning content: https://docs.litellm.ai/docs/reasoning_content
- SwiftLee, reduce token usage (2026-09-28): https://www.avanderlee.com/ai-development/reduce-token-usage-claude-code-codex-cursor/
- Faros AI, Claude Code token usage (2026-06-25): https://www.faros.ai/blog/claude-code-token-usage
- anthropics/claude-code #94197: https://github.com/anthropics/claude-code/issues/94197
- MorphLLM, AI coding costs: https://www.morphllm.com/ai-coding-costs
- CloudZero, Claude Code pricing: https://www.cloudzero.com/blog/claude-code-pricing/
