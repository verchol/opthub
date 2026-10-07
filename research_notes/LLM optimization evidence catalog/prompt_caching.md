# Prompt caching and cache TTL optimizations for LLM APIs and coding agents

Research date: 2026-09-29. Evidence strength labels: **MP** = measured production, **BM** = benchmark or controlled study, **VC** = vendor claim or vendor doc, **AN** = anecdote or illustrative math. "Client" = runnable from the developer's machine with no proxy. "Gateway" = needs a proxy in the request path.

Context for opthub: opthub measured a 96.8% cache hit rate on a real month of Claude Code use. Every independent Claude Code measurement found below lands in the same band (94 to 99.9% of input-side tokens are cache reads). Claude Code caches by default, and on a subscription it already requests the 1-hour TTL for the main conversation. So "turn on prompt caching" is not a savings lever for Claude Code users. The remaining levers are TTL choice (5m vs 1h per bucket), avoiding the invalidators listed below, and subagent TTL.

---

## Q1. What measured cache hit rates and savings do real agent and coding workloads report (not vendor marketing)?

### Takeaway
Measured coding-agent workloads that are append-only (Claude Code, Codex CLI) show 94 to 99.9% of input tokens served from cache with no tuning. Custom agents start much lower (7%, 20%, 60%) until dynamic content is moved out of the prefix, then reach 84 to 92%. Realized cost savings run 41 to 80% (benchmark) and 59 to 77% (production), not the "up to 90%" in vendor copy.

### Cited Findings

**Claude Code: independent measurements (caching already on by default)**
- 1. **devx AI labs, "I Analyzed 165.9 Million Tokens to Understand How Claude Code Actually Works"** (Vishal Makwana, 2026-03-10). Across 4 days and 4 projects, 97.2% of all tokens were cache reads and 2.6% cache writes. By turn 10 of a session, 99.9% of input came from cache. One session had 1,070 turns and 271 subagents. 100% of cache-creation tokens were on the 1-hour tier and every `ephemeral_5m_input_tokens` value was 0 (subscription account, before the March 2026 change described in Q2). Strength: **MP** (single user). — [devxlabs](https://www.devxlabs.ai/blogs/how-claude-code-actually-works)
  - Config (client, Claude Code): check your own split with `claude -p "hello" --output-format json` and read `usage.cache_creation.ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens` (verified in [Claude Code docs](https://code.claude.com/docs/en/prompt-caching)).
- 2. **GitHub anthropics/claude-code #24147** (@RedhatEnt, opened 2026-02-08). Over 30 days: 5,092,500,074 cache-read tokens, 176,498,498 cache-creation tokens, and 3,887,759 I/O tokens. Cache reads were 99.93% of the total, or 1,310 cache-read tokens per I/O token. The author blames a ~15k-token CLAUDE.md that is re-read every turn and counts against quota. Strength: **MP** (single user). No maintainer response visible. — [GitHub issue](https://github.com/anthropics/claude-code/issues/24147)
  - Implication and config: cache reads are cheap but not free. At 0.1x (0.05x on Opus 5.5), a large static prefix re-read ~1,000 times still dominates spend. The lever is shrinking CLAUDE.md, not caching more. There is no caching config key for this.
- 3. **dev.to "I Thought I Used 1 Billion Tokens in Claude Code Last Week. Turns Out 97% Was Cache"** (flipslidersand). One week, 1.36B tokens, 13,972 turns. Split: cache read 97.4%, cache create 2.2%, output 0.4%, uncached input ~0.0%. Input:output about 230:1. Max plan. Strength: **MP/AN** (single user). **The date the fetch returned (2024-08-07) must be wrong.** Claude Code and the Max plan did not exist then, so treat the date as unknown (2025 or 2026). — [dev.to](https://dev.to/flipslidersand/i-thought-i-used-1-billion-tokens-in-claude-code-last-week-turns-out-97-was-cache-1m2i)
- 4. A search snippet reports "1,674 AI coding agent sessions … 94.2% of tokens were cache reads", but I could not trace it to a primary page. **Unverified.** See Gaps.
- 5. **Anthropic, "Lessons from building Claude Code: Prompt caching is everything"** (Thariq Shihipar, Claude Code team, 2026-04-30). The team runs alerts on prompt-cache hit rate and declares SEVs when it drops, because "a few percentage points of cache miss rate can dramatically affect cost and latency." It gives no absolute numbers. Strength: **VC** (first-party practice, no figures). — [claude.dev blog](https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/) (redirected from claude.com/blog)

**Codex CLI and OpenAI-shaped agents**
- 6. **anomalyco/opencode #51580** (ykk-deadsd, 2026-09-27). Same endpoint and model (zen/go/v1, deepseek-v4.1-flash). Codex CLI had 2 misses in 657 requests (0.30% miss rate). ZCode (opencode-based) had 23 misses in 685 (3.36%), about 10x more. The difference traced to Codex sending `prompt_cache_key` in the body while ZCode sent only an `x-opencode-session` header. On misses, cache_read fell to 0/1024/1152 while input was 90k to 520k. Strength: **MP** (small n). — [GitHub issue](https://github.com/anomalyco/opencode/issues/51580)
  - Config (API request shape, client): `{"model": "...", "prompt_cache_key": "<stable-per-session-id>", "input": [...]}`. `prompt_cache_key` is verified in [OpenAI docs](https://developers.openai.com/api/docs/guides/prompt-caching).
- 7. **OpenAI Cookbook, "Prompt Caching 201"** (date not shown). "One of our coding customers … improved hit rate from 60% to 87% when they started using prompt_cache_key." It also claims the Responses API gives "40-80% better cache utilization" than Chat Completions, and that Flex vs Batch gave +8.5% hit rate and -23% input cost. Strength: **VC** (vendor-reported customer result, not independently verifiable). — [OpenAI Cookbook](https://developers.openai.com/cookbook/examples/prompt_caching_201)
- 8. Search snippets (not fetched) describe CLIProxyAPI #5300, where an auto-derived `prompt_cache_key` gave a 0.4% hit rate on batch workloads, and oh-my-pi #10786, where remote compaction got 0% cache hits vs ~99.9% on normal Codex turns. Strength: **AN**, **unverified** beyond titles. — [CLIProxyAPI #5300](https://github.com/router-for-me/CLIProxyAPI/issues/5300), [oh-my-pi #10786](https://github.com/can1357/oh-my-pi/issues/10786)

**Custom production agents (before and after cache-aware restructuring)**
- 9. **ProjectDiscovery, "How We Cut LLM Costs by 59% With Prompt Caching"** (2026-04-10; Neo security agent on Opus 4.5, Anthropic direct first, Bedrock/Vertex as fallback).
  - Hit rate rose from 7% to 74% to 84%. Overall cost fell 59%, then 66% after Feb 16, and 70% over the last 10 days. 9.8B tokens were served from cache.
  - One task used 67.5M input tokens over 1,225 steps at a 91.8% cache rate. The same task before the change ran at 3.2%, "roughly 60x the cost."
  - Main fix: move working memory, skills and runtime context out of the system prompt into a trailing `<system-reminder>` user message.
  - Secondary fixes: date-only timestamp frozen per task, placeholder template variables, static tools sorted alphabetically ahead of dynamic ones, routing to Anthropic direct first for cache locality.
  - Strength: **MP**. — [ProjectDiscovery](https://projectdiscovery.io/blog/how-we-cut-llm-cost-with-prompt-caching)
  - Config (API request shape, client). Three breakpoints: BP1 on the last static system block with `ttl:"1h"`, BP3 on the last static tool with `ttl:"1h"`, BP2 on the last content part of the last tool result with the 5m default. Note that longer-TTL entries must come before shorter ones.
    ```json
    {"tools":[ /* static tools, sorted */ {"name":"zz_last_static","input_schema":{},"cache_control":{"type":"ephemeral","ttl":"1h"}} ],
     "system":[{"type":"text","text":"<static system prompt>","cache_control":{"type":"ephemeral","ttl":"1h"}}],
     "messages":[ ..., {"role":"user","content":[{"type":"tool_result","tool_use_id":"...","content":"...","cache_control":{"type":"ephemeral"}}]},
                  {"role":"user","content":"<system-reminder>working memory / runtime context</system-reminder>"} ]}
    ```
- 10. **Deriv, "How prompt caching cut our production AI agent input costs by 77%"** (Osama Ghazal, 2026-07-23; GPT-5, OpenAI). The measured hit rate was 85.8% and input-token cost fell 77%. Dollar figures use an illustrative 30B tokens/month: $37,500 with no caching, $30,750 at a 20% hit rate, $8,540 at 85.8%. Techniques: separate static and dynamic content, order by variability, serialize deterministically (sort lists, canonicalize tool definitions), and monitor cached/total. Strength: **MP** for the % figures, **AN** for the dollar figures. — [Deriv on Substack](https://derivai.substack.com/p/prompt-caching-production-ai-agent-costs)
- 11. **Manus, "Context Engineering for AI Agents: Lessons from Building Manus"** (Yichao "Peak" Ji, 2025-07-18). KV-cache hit rate is "the single most important metric". The average input:output ratio is about 100:1. On Claude Sonnet, cached input costs $0.30/MTok vs $3/MTok uncached (10x). Rules: no second-precision timestamps in the system prompt, deterministic JSON key ordering, append-only context, mask tools instead of removing them, and for self-hosted vLLM, enable prefix caching and route by session ID. Strength: **MP/VC** (practitioner, no hit-rate figure). — [Manus blog](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- 12. **Citare / Prism ("Anthropic Prompt Caching: Real Numbers From 330 Production Calls")** (Ravi Patel, dev.to, 2026). Anthropic prompt caching cut Citare's AI bill 25 to 35% on parsing-heavy workloads. Seen only through a search snippet; the body was not fetched. Strength: **MP**, small n, partially verified. — [dev.to](https://dev.to/rikuq/anthropic-prompt-caching-real-numbers-from-330-production-calls-2eg4)
- 13. **MegaBrain, "Your AI Agent's Cache Hit Rate Is Probably 7%"** (2026-07-25). This is a secondary write-up of ProjectDiscovery plus other claims:
  - random multi-provider routing costs 2.25x vs 1.75x with affinity
  - keepalive pings kept the cache warm 40/40 times vs 0/48 without
  - the TradingAgents framework rebuilds prompts every call, for ~0% hits

  Strength: **AN** (aggregator; primary data not verified except ProjectDiscovery). — [MegaBrain](https://getmegabrain.com/blog/prompt-cache-hit-rate-myth-2026)

**Benchmarks**
- 14. **Lumer et al., "Don't Break the Cache: An Evaluation of Prompt Caching for Long-Horizon Agentic Tasks"** (arXiv 2601.06007, v1 2026-01-09, v2 2026-01-31). Over 500 agent sessions on OpenAI, Anthropic and Google, using DeepResearch Bench with a 10k-token system prompt, plus ablations from 500 to 50k tokens and 3 to 50 tool calls. Results: 41 to 80% cost reduction and 13 to 31% better time to first token (TTFT). "Naive full-context caching … can paradoxically increase latency." The recommended strategy caches the system prompt and excludes dynamic tool results. Strength: **BM**. — [arXiv](https://arxiv.org/abs/2601.06007)

**Vendor headline numbers (for contrast)**
- 15. **OpenAI docs and cookbook.** Cache reads are 0.1x uncached input on GPT-5.6+, and GPT-5.6+ adds a 1.25x cache-write charge where earlier models had none. The cookbook gives TTFT reductions of up to 80%: 7% faster at 1,024 tokens and 67% faster at 150k+. Discounts by model: gpt-4o 50%, gpt-4.1 75%, gpt-5.x 90%. Strength: **VC**. — [OpenAI guide](https://developers.openai.com/api/docs/guides/prompt-caching), [Cookbook 201](https://developers.openai.com/cookbook/examples/prompt_caching_201)
- 16. **Anthropic docs.** 5-minute and 1-hour caches "provide identical latency benefits." Cache reads are 0.1x base input for most models, 0.05x for Opus 5.5, and 0.025x for Fable 5.1 and Mythos 5.1. Strength: **VC**. — [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

### Inferences
- There are two regimes. Append-only coding agents (Claude Code, Codex CLI, Aider) are at 94 to 99.9% by construction, so opthub's 96.8% is typical. There is little left to gain from hit rate itself; what remains is the misses (TTL expiry, model or effort switches, MCP changes, compaction) and the cost of what gets cached (CLAUDE.md size, subagent TTL). Custom agents with mutable system prompts start at 7 to 60% and gain the most, 59 to 77% cost cut.
- For opthub replay-testing: "enable caching" should be expected to show ~0 delta on Claude Code logs. The meaningful replays are TTL policy (5m vs 1h per bucket), invalidation avoidance, and prefix size.
- Hit rate and cost savings are not the same thing. Anthropic writes cost 1.25 to 2x and reads 0.05 to 0.1x, so a 97% hit rate can still leave cache writes as a large share of spend. See Q2, where the ~2.6% of tokens that are writes are billed at 2x.

### Gaps
- The "1,674 sessions, 94.2% cache reads" figure could not be traced to a primary source.
- I found no public measured hit rates from Cursor, Sourcegraph/Amp, Replit, Factory or Cognition. Their engineering posts (not fetched in full) do not publish cache numbers that I could verify.
- I did not fetch the full DigitalOcean "7% to 74%" article; the page returned only navigation chrome.

---

## Q2. When does the 1-hour TTL pay off vs 5-minute (write 2x vs 1.25x), and who has published numbers?

### Takeaway
The 1h TTL pays off as soon as a cached prefix sees at least one idle gap between 5 and 60 minutes that would otherwise force a full re-write. The extra 0.75x write premium is repaid by a single such avoided re-write. For bursty work that never idles more than 5 minutes, 5m is cheaper. The best public "numbers" come from one heavy Claude Code user (issue #46829): when the client silently moved from 1h to 5m writes, cache-creation overpayment rose from 1.1% (Feb) to 25.9% (March).

### Cited Findings
- 17. **Anthropic pricing and docs** (current). The 5m write is 1.25x base input, the 1h write is 2x, and hits or refreshes are 0.1x (0.05x Opus 5.5, 0.025x Fable/Mythos 5.1). Example on Opus 5.5: base $4, 5m write $5, 1h write $8, hit $0.20 per MTok. Anthropic says to use 1h for prompts used less often than every 5 minutes but more often than hourly, agent runs longer than 5 minutes, long chats with slow user replies, and latency-critical follow-ups. The docs also note cache hits don't count against rate limits. Strength: **VC**. — [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
  - Config (API request shape, client): `"cache_control": {"type": "ephemeral", "ttl": "1h"}` on a block, or top-level automatic caching with `"cache_control": {"type": "ephemeral"}` (verified).
- 18. **Vercel AI Gateway docs** (last updated 2026-09-11). "A one-hour entry costs an additional 0.75× base input to write. One read after the five-minute entry would have expired saves 0.9× base input and repays that premium. Use one hour for long-running agents and conversations that commonly pause for more than five minutes." Strength: **VC**, with correct arithmetic.
  - The 0.9x counts against uncached base input. Counted against the 5m alternative, which re-writes at 1.25x, the saving per avoided re-write is 1.15x. Either way, one avoided expiry repays the premium.
  - Source: [Vercel](https://vercel.com/docs/ai-gateway/models-and-providers/automatic-caching)
  - Config (gateway, Vercel AI Gateway Responses API): `{"model":"anthropic/claude-sonnet-5","caching":"auto","cache_ttl":"1h","input":"..."}`. `cache_ttl` accepts `5m`/`1h` and only works with `caching:"auto"` (verified).
- 19. **anthropics/claude-code #46829, "Cache TTL silently regressed from 1h to 5m around early March 2026"** (@seanGSISG, opened 2026-04-12, closed as not planned). 119,866 API calls on two machines, 2026-01-11 to 2026-04-11.
  - Feb 1 to Mar 5: 33 consecutive days of 1h-only writes.
  - From Mar 6 the writes were mixed; by Mar 21 they were 93% 5m (21.37M 5m-create vs 1.70M 1h-create).
  - Estimated overpayment from extra re-writes: 1.1% in Feb, 25.9% in March, 17.1% overall ($949.08 Sonnet 4.6, $1,581.80 Opus 4.6).
  - Strength: **MP** (single user, author's own cost model).
  - Source: [GitHub issue](https://github.com/anthropics/claude-code/issues/46829)
  - The current Claude Code docs explain the behavior. By default, 1h is requested only for the main conversation on a subscription within plan usage. API key, cloud provider, usage-credit overage, subagents, compaction and titles get 5m.
- 20. **Claude Code docs, "How Claude Code uses prompt caching"** (current, v2.1.242+ for the TTL keys). "The longer TTL helps when you leave a session idle and come back to it… It costs more on short bursts of work that never idle past five minutes." Strength: **VC**. — [Claude Code docs](https://code.claude.com/docs/en/prompt-caching)
  - Config (client, Claude Code), all verified in that page:
    ```jsonc
    // ~/.claude/settings.json  (values: "5m" | "1h"; anything else ignored)
    { "promptCacheTtl": "1h",            // main conversation bucket
      "subagentPromptCacheTtl": "1h" }   // subagents, workflows, teammates, forks, compaction, titles
    ```
    ```bash
    export CLAUDE_CODE_PROMPT_CACHE_TTL=1h            # main bucket
    export CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=5m   # everything else
    export ENABLE_PROMPT_CACHING_1H=1                 # both buckets 1h (lower precedence)
    export FORCE_PROMPT_CACHING_5M=1                  # both buckets 5m (highest precedence; debugging/A-B)
    ```
    Precedence: `FORCE_PROMPT_CACHING_5M`, then the bucket env var, then the bucket setting, then subagent frontmatter `experimental.cacheTtl` (v2.1.248+), then `ENABLE_PROMPT_CACHING_1H`, then the default. These can be enforced org-wide in the managed-settings `env` block. Through an `ANTHROPIC_BASE_URL` gateway, the 1h request partly travels in the `anthropic-beta` header, which the gateway must forward. 1h is not available via the Claude apps gateway.
- 21. **Ravi Patel / ssimplifi (dev.to, "…the two-tier write premium, and when it actually pays off")**, 2026. Uses a model where each cached prefix is written once and then read N times (no expiry considered). Break-even is 2 hits for 5m (0.675x average at N=2) and about 3 hits for 1h (0.733x). The article notes 1h survives 12x longer and "requires 50% more hits." Strength: **AN** (illustrative math). — [dev.to](https://dev.to/rikuq/anthropic-prompt-caching-explained-cachecontrol-markers-the-two-tier-write-premium-and-when-it-25cp)
- 22. **Synrouter blog** (search snippet only, not fetched). In a cost comparison, 5m TTL spent $1.73 on cache writes and 1h spent $0.09 on one session with idle gaps. Strength: **AN**, unverified. — [Synrouter](https://synrouter.ai/blog/anthropic-cache-ttl-5min-vs-1hr)
- 23. **Aider `--cache-keepalive-pings N`**: a client-side alternative to the 1h TTL. It pings every 5 minutes, up to N times, to keep the 5m cache warm. Each ping is a cache read (0.1x) plus a tiny request, so N pings cost about N × 0.1x of the prefix. That beats the 1h 0.75x premium only while N ≤ 7 (about 35 minutes of idle). This is my arithmetic, not a published figure. Strength: **VC** (flag verified). — [Aider docs](https://aider.chat/docs/usage/caching.html)
  - Config (client): `aider --cache-prompts --cache-keepalive-pings 12`, which keeps the cache warm for about 60 minutes of idle.
- 24. **Cline discussion #414** (opened 2024-09-27, dated). Users asked for Aider-style pings to stretch the 5m cache to 35 to 60 minutes (12 pings for 60 minutes). They estimated that pinging costs about 1.45x vs 2.5x uncached for two messages. Strength: **AN**. — [GitHub discussion](https://github.com/cline/cline/discussions/414)
- 25. **OpenAI retention.** GPT-5.6+ uses `"30m"` retention ("eligible for reuse for 30 minutes after its most recent write or reuse"). On earlier models, `"in_memory"` lasts about 5 to 10 minutes idle and up to 1 hour, and `"24h"` typically keeps entries about 30 minutes and up to 24 hours. The Cookbook says `"24h"` is available on gpt-5.5+. Strength: **VC**. — [OpenAI guide](https://developers.openai.com/api/docs/guides/prompt-caching), [Cookbook 201](https://developers.openai.com/cookbook/examples/prompt_caching_201)
  - Config (API request shape, client): `{"model":"gpt-5.5","prompt_cache_key":"sess-123","prompt_cache_retention":"24h","input":[...]}`.
  - Conflict: the guide and the cookbook describe the GPT-5.6+ retention values slightly differently. Verify per model.
- 26. **Gemini.** Implicit caching is on by default for Gemini 2.5 and newer. Minimum prefix is 2,048 tokens on 2.5 Flash/Pro and 4,096 on the 3.x Flash and 3.1 Pro preview models. Explicit caching needs `generateContent`, not the Interactions API. The fetched page did not give discount % or explicit-cache TTL/storage pricing. OpenRouter lists Gemini 2.5 cache reads at 0.25x. Strength: **VC**. — [Gemini caching](https://ai.google.dev/gemini-api/docs/caching), [OpenRouter](https://openrouter.ai/docs/guides/best-practices/prompt-caching)

### Inferences
- Rule of thumb for Claude Code (verified by the pricing math above): choose 1h for the main conversation if the developer has at least one idle gap of 5 to 60 minutes per roughly 1.5 cache writes' worth of prefix. Typical interactive sessions (meetings, reviews, lunch) qualify. Headless `-p` batch runs and tight loops should stay on 5m.
- Subagents default to 5m even on subscriptions. A subagent that sleeps or waits on long tool calls (builds, tests over 5 minutes) pays a full re-write on its next turn. `subagentPromptCacheTtl: "1h"` is the specific lever there, and opthub can replay it by looking for subagent turns that follow a gap of more than 5 minutes.
- #46829 is the only public longitudinal dataset. Its 17 to 26% cache-creation overpayment is an upper bound on what 1h saves for a heavy interactive user, since it counts only re-writes that 1h would have avoided.
- API-key Claude Code users are on 5m by default, which is the most actionable finding for them. `promptCacheTtl: "1h"` is a one-line client change.

### Gaps
- I found no public study measuring the idle-gap distribution of real Claude Code sessions, which is the input that decides 1h vs 5m. opthub's own transcripts could supply it.
- Anthropic has made no public statement on #46829 beyond the current documented defaults.
- Gemini explicit cache pricing and default TTL were not captured in this pass.

---

## Q3. What silent invalidators and minimum-prefix rules have people documented?

### Takeaway
Caching is an exact prefix match, and nearly every documented failure is silent: no error, only a lower `cache_read` count. The top causes are dynamic content in the system prompt (timestamps, working memory), tool-set or tool-order changes, model, effort or fast-mode switches, compaction, non-deterministic serialization, gateways that strip `cache_control`, routing across providers or replicas without affinity, and prefixes below the per-model minimum.

### Cited Findings
- 27. **Anthropic invalidation matrix.**
  - The cache hierarchy is tools, then system, then messages.
  - Changing tool definitions invalidates everything.
  - Web-search, citations or speed toggles invalidate system and messages.
  - `tool_choice` and adding or removing images invalidate messages.
  - Thinking and effort parameters are model-specific.
  - Other rules: at most 4 explicit breakpoints and a 20-block lookback. A cache entry is available only after the first response begins, so concurrent fan-out requests all miss. Isolation is per workspace on the Claude API, AWS and Foundry, and per organization on Bedrock and Vertex.
  - Minimum cacheable tokens: 512 (Opus 5.5, Opus 5, Sonnet 5.5, Fable/Mythos 5.x); 1,024 (Opus 4.8, Sonnet 5, Sonnet 4.5/4.6, Opus 4/4.1); 2,048 (Opus 4.7, Mythos Preview, Haiku 3.5); 4,096 (Opus 4.5/4.6, Haiku 4.5).
  - Strength: **VC**.
  - Source: [Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- 28. **Claude Code invalidators** (docs; each causes a one-time uncached turn):
  - switching models with `/model`
  - `opusplan` plan-mode toggles, which switch between Opus and Sonnet
  - skills whose frontmatter sets a different `model`
  - automatic safety-classifier model fallback
  - changing effort level (the cache is kept on Opus 5.5, Sonnet 5.5 and Fable 5.1 via API or subscription since v2.1.260, but not on Bedrock or Vertex)
  - turning fast mode on (a cache-key header, once per conversation)
  - connecting or removing MCP servers when tool search isn't deferring tools, which includes any custom `ANTHROPIC_BASE_URL` gateway
  - enabling a plugin that provides MCP servers
  - bare-name tool deny rules without tool search
  - `/compact`
  - dropping the oldest images and PDFs once request limits are reached
  - upgrading Claude Code

  **Cache-safe actions:** editing repo files, editing CLAUDE.md mid-session (the change doesn't apply until `/clear`, `/compact` or a restart), permission-mode changes, output-style changes (v2.1.251+), skills and commands, `/recap`, `/rewind`, subagents (the parent cache is untouched), and forks (which read the parent cache).

  Cache scope is effectively one machine and one directory, because the system prompt embeds auto-memory paths and the conversation opens with cwd, OS and git-status details. Sequential sessions share a prefix only if the git status snapshot matches.

  `/usage` shows a `Prompt cache (main)` hit ratio (v2.1.251+) and a "likely cause" of the last miss (v2.1.260+).

  Strength: **VC**. — [Claude Code docs](https://code.claude.com/docs/en/prompt-caching)
  - Gateway pitfall (verified, same page). If a gateway strips `cache_control` but returns success, "your entire conversation history bills as uncached input on every turn." Converting block-form system content to a plain string has the same effect. If the gateway instead returns a 400 naming `cache_control`, Claude Code falls back to caching only the conversation.
  - Config (client): `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` makes the mid-conversation system-context block uncached. Avoid it unless the gateway requires it.
  - Config (client): `DISABLE_AUTOUPDATER=1` lets you control when upgrades, which change the prefix, land.
- 29. **Claude Code team blog** (2026-04-30). Documented breakers:
  - a timestamp in the system prompt
  - non-deterministic tool ordering
  - updating tool parameters mid-session
  - switching models
  - adding or removing tools ("one of the most common ways people break prompt caching")
  - compaction calls built with a different system prompt

  Fixes: put state changes in messages (plan mode is an EnterPlanMode/ExitPlanMode tool pair), use `defer_loading` tool stubs, and have forks share the exact parent prefix. Strength: **VC**. — [claude.dev](https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/)
- 30. **Manus** (2025-07-18): "even a single-token difference can invalidate the cache from that token onward." It names second-precision timestamps and unstable JSON key order ("can silently break the cache"). Strength: **MP/VC**. — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- 31. **ProjectDiscovery** (2026-04-10). Pitfalls it hit:
  - Dynamic content between breakpoints invalidates everything after it.
  - Automatic caching can't tell static content from dynamic content.
  - The default 5m TTL is too short for sharing a cache across users.
  - The 4-breakpoint limit is tight when there are parallel tool calls.
  - Extended thinking and caching conflict across providers.
  - Bedrock/Vertex fallback loses cache locality.

  Strength: **MP**. — [ProjectDiscovery](https://projectdiscovery.io/blog/how-we-cut-llm-cost-with-prompt-caching)
- 32. **OpenAI.**
  - Minimum prefix is 1,024 visible input tokens on GPT-5.6+. Earlier models report cached tokens in 128-token increments, rounded down.
  - "Traffic above 15 requests per minute can lead to overflow routing," which breaks locality per prefix plus `prompt_cache_key` combination.
  - Keys "do not pin requests to a machine or guarantee a cache hit."
  - Hits show in `usage.input_tokens_details.cached_tokens` and writes in `cache_write_tokens`.

  Strength: **VC**. — [OpenAI guide](https://developers.openai.com/api/docs/guides/prompt-caching)
  - Implication: `prompt_cache_key` should be per-session or per-prefix, not global. A single key shared by a high-QPS fleet overflows at about 15 rpm.
- 33. **Portkey/gateway #1579**: `cache_control` blocks were stripped when routing to Anthropic models on Vertex AI through Portkey (from a search snippet). **flue #662**: the Cloudflare Workers AI binding forces `cacheRetention: 'none'` for Anthropic. **openclaw #46709**: OpenClaw doesn't pass cache settings through Cloudflare AI Gateway, so TTL falls back to 5m. Strength: **AN** (issue reports, search snippets only). — [Portkey #1579](https://github.com/Portkey-AI/gateway/issues/1579), [flue #662](https://github.com/withastro/flue/issues/662), [openclaw #46709](https://github.com/openclaw/openclaw/issues/46709)
- 34. **Lumer et al.**: naive full-context caching can increase latency. Excluding dynamic tool results from the cached region gave more consistent gains. Strength: **BM**. — [arXiv](https://arxiv.org/abs/2601.06007)
- 35. **Aider**: cache statistics and costs aren't shown when streaming, so use `--no-stream` to see them. A silent observability gap rather than an invalidator. Strength: **VC**. — [Aider](https://aider.chat/docs/usage/caching.html)
- 36. **opencode #51580**: a session header without `prompt_cache_key` produced 10x more misses than Codex on the same endpoint. Strength: **MP**. — [GitHub](https://github.com/anomalyco/opencode/issues/51580)

### Inferences
- For opthub, the invalidators you can detect from Claude Code transcripts are: model change between turns, effort change, fast-mode on, MCP server connect or disconnect, `/compact`, image eviction, Claude Code version change on resume, and idle gaps longer than the TTL. Each has a known signature: `cache_creation_input_tokens` spikes to about the full context. Each can be priced as (context tokens × (write multiplier − read multiplier)).
- Measure "silent" gateway stripping by comparing `cache_read_input_tokens` through the gateway against direct calls. A result of zero on turn 2 or later means stripping.

### Gaps
- I did not verify the "Claude Code counts a miss when a request re-processed more than 5% and at least 2,000 tokens" rule seen in a search snippet. Check `/docs/en/costs#prompt-cache-statistics`.
- There is no public quantification of how often each Claude Code invalidator fires in real usage.

---

## Q4. Which tools expose caching controls, and with exactly what config syntax?

### Takeaway
The verified controls are: Claude Code (TTL per bucket and disable flags), the Anthropic API (`cache_control` with `ttl`, or top-level automatic caching), the OpenAI API (`prompt_cache_key`, `prompt_cache_retention`, and on GPT-5.6+ explicit `prompt_cache_breakpoint`/`prompt_cache_options`), LiteLLM (global flag, TTL, injection points), Vercel AI Gateway (`caching:'auto'`, `cache_ttl`, `cache_anchor_items`, `x-session-affinity`), OpenRouter (automatic or explicit `cache_control`, `session_id` sticky routing), Portkey (pass-through `cache_control`) and Aider (`--cache-prompts`, `--cache-keepalive-pings`). I could not verify prompt-caching controls for Kong, Cloudflare AI Gateway, Helicone, Bifrost, Cursor, Cline or Codex CLI. Kong and Bifrost market semantic or response caching, which is a different feature.

### Cited Findings

**Claude Code (client)**: all verified in [Claude Code prompt-caching docs](https://code.claude.com/docs/en/prompt-caching)
- 37. Caching is on by default. The disable flags are `DISABLE_PROMPT_CACHING=1` (all models), `DISABLE_PROMPT_CACHING_HAIKU`, `_SONNET`, `_OPUS` and `_FABLE`. TTL keys are listed under Q2 #20. Verify with `claude -p "hello" --output-format json` and inspect `usage.cache_creation`. For orgs, set any of these in the managed-settings `env` block. Strength: **VC**.
  ```jsonc
  // managed-settings.json or ~/.claude/settings.json
  { "promptCacheTtl": "1h", "subagentPromptCacheTtl": "1h",
    "env": { "DISABLE_AUTOUPDATER": "1" } }
  ```
  Subagent-level override (v2.1.248+): `experimental: { cacheTtl: 1h }` in the subagent's frontmatter. The docs name the field `cacheTtl` inside `experimental`. **The exact YAML nesting was not quoted in the fetched text; verify against the sub-agents frontmatter reference.**

**Anthropic Messages API (client)**: [docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), **VC**
- 38. Automatic caching places the breakpoint on the last cacheable block and moves it forward each turn:
  ```json
  {"model":"claude-opus-5-5","max_tokens":1024,"cache_control":{"type":"ephemeral"},"system":"...","messages":[...]}
  ```
  Explicit breakpoints allow up to 4: `"cache_control":{"type":"ephemeral","ttl":"1h"}` on a tools, system or messages block. When mixing TTLs, 1h breakpoints must come before 5m ones (per the [Portkey docs](https://portkey.ai/docs/integrations/llms/anthropic/prompt-caching)). The usage fields are `cache_read_input_tokens`, `cache_creation_input_tokens` and `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`.

**OpenAI API (client)**: [guide](https://developers.openai.com/api/docs/guides/prompt-caching), **VC**
- 39. `prompt_cache_key: "<stable id>"` and `prompt_cache_retention: "in_memory" | "24h"` (earlier models) or `"30m"` (GPT-5.6+). On GPT-5.6+ there are also explicit breakpoints, as shown in LiteLLM's pass-through example (verified in the [LiteLLM docs](https://docs.litellm.ai/docs/completion/prompt_caching)):
  ```python
  messages=[{"role":"system","content":[{"type":"text","text":"<long static>","prompt_cache_breakpoint":{"mode":"explicit"}}]}, ...],
  prompt_cache_options={"mode":"explicit","ttl":"30m"}
  ```

**LiteLLM proxy (gateway)**: verified in [LiteLLM auto-inject tutorial](https://docs.litellm.ai/docs/tutorials/prompt_caching), **VC**
- 40. The global flag adds one checkpoint on the system prompt and one on the trailing turn. It applies to Claude only (`anthropic/` and `bedrock/`), not to Claude on `vertex_ai/` or `azure_ai/`. It never double-injects: if the client sends its own `cache_control`, the client's markers win.
  ```yaml
  litellm_settings:
    enable_anthropic_prompt_caching: true      # env: LITELLM_ENABLE_ANTHROPIC_PROMPT_CACHING=true
    anthropic_prompt_caching_ttl: "1h"          # env: LITELLM_ANTHROPIC_PROMPT_CACHING_TTL; default 5m
  ```
  Per-model injection covers other providers and positions:
  ```yaml
  model_list:
    - model_name: anthropic-cache
      litellm_params:
        model: anthropic/claude-sonnet-5
        cache_control_injection_points:
          - location: message
            role: system
          - location: message
            index: -1          # negative index = last message
  ```
  The docs also mention `location: tool_config` for caching tool definitions and a `prompt_caching` router pre-call check among the router's toggleable checks ([LiteLLM routing](https://docs.litellm.ai/docs/routing)). **The exact semantics of the `prompt_caching` pre-call check were not captured.** The docs say it is one of the names in the router's pre-call-check list; verify before use.
  - For Claude Code behind LiteLLM, Claude Code already sends `cache_control`, so LiteLLM "stands down." The TTL then comes from Claude Code settings, and the proxy must forward the `anthropic-beta` header for 1h ([Claude Code docs](https://code.claude.com/docs/en/prompt-caching)).

**Vercel AI Gateway (gateway)**: verified in [Vercel docs](https://vercel.com/docs/ai-gateway/models-and-providers/automatic-caching), **VC**
- 41. When `caching` is unset, requests pass through unchanged and Anthropic is not cached unless the client adds markers. Settings:
  - `providerOptions: { gateway: { caching: 'auto' } }` adds a breakpoint on the last message and one on the message before the last user message.
  - `cache_ttl: '5m' | '1h'` (Responses API, only with `caching:'auto'`)
  - `cache_anchor_items: N`, a third breakpoint that survives mid-prompt compaction or pruning
  - an `x-session-affinity: <opaque id>` header for provider-side locality
  - `has: ['implicit-caching']` to restrict routing to implicitly caching models

  Vercel's own guidance: for strictly one-shot traffic, `caching:'auto'` costs a small net write premium.

**OpenRouter (gateway)**: verified in [OpenRouter docs](https://openrouter.ai/docs/guides/best-practices/prompt-caching), **VC**
- 42. Supports top-level automatic `cache_control` or block-level breakpoints (up to 4), both with `"ttl":"1h"`. Provider sticky routing turns on after a cached request and expires after 10 minutes idle. You can force it with a body `session_id` (up to 256 chars) or an `x-session-id` header. Read multipliers: DeepSeek and Anthropic 0.1x, Gemini 2.5 0.25x, Groq 0.5x. Savings appear in `usage.prompt_tokens_details.cached_tokens`, `cache_write_tokens` and `cache_discount`.
  ```json
  {"model":"anthropic/claude-sonnet-5","session_id":"sess-123","cache_control":{"type":"ephemeral","ttl":"1h"},"messages":[...]}
  ```

**Portkey (gateway)**: [Portkey docs](https://portkey.ai/docs/integrations/llms/anthropic/prompt-caching), **VC**
- 43. Pass-through only. You place `cache_control` (optionally with `"ttl":"1h"`) in content blocks yourself, with headers `x-portkey-api-key` and `x-portkey-provider: anthropic`. Portkey prices `cache_creation_input_tokens`/`cache_read_input_tokens` correctly. It has no auto-injection config (only a prompt-template UI toggle). The reported #1579 bug stripped `cache_control` on the Vertex route.

**Aider (client)**: [Aider docs](https://aider.chat/docs/usage/caching.html), **VC**
- 44. `--cache-prompts` caches the system prompt, read-only files, the repo map and editable files. `--cache-keepalive-pings N` pings every 5 minutes, up to N times. The docs list Anthropic (Sonnet, Haiku) and DeepSeek Chat as providers. Use `--no-stream` to see cache stats. YAML equivalents are presumably `cache-prompts: true` in `.aider.conf.yml`, but that follows Aider's general flag-to-YAML convention and was **not verified on this page.**

**Continue (client)**: **unverified**
- 45. A community sample config and search snippets show a per-model block like the one below, possibly with `useExtendedCacheTtlBeta` and `cacheTtl`. The current official config.yaml reference page did **not** contain these keys when fetched. Treat them as **unverified**. — [community sample](https://github.com/jdraths/continue-dev-config/blob/main/sample.yaml), [Continue reference](https://docs.continue.dev/reference)
  ```yaml
  models:
    - name: sonnet
      provider: anthropic
      model: claude-sonnet-5
      cacheBehavior:
        cacheSystemMessage: true
        cacheConversation: true
  ```

**Codex CLI, Cursor, Cline**
- 46. Codex CLI sends `prompt_cache_key` automatically (observed in [opencode #51580](https://github.com/anomalyco/opencode/issues/51580)). I found no documented user-facing Codex config key for caching. Cursor publishes no user caching controls that I could verify. Cline discussion #414 (2024) asked for keepalive, and I found no verified Cline setting. **No verified config.**

**Kong AI Gateway, Cloudflare AI Gateway, Helicone, Bifrost**
- 47. Kong (AI Semantic Cache plugin, 3.8+) and Bifrost (semantic cache plugin) market semantic or response caching, which is a different mechanism from provider prompt caching. It returns stored completions and does not discount prefix tokens. Source: search snippets from [Spheron](https://www.spheron.network/blog/ai-gateway-litellm-portkey-kong-gpu-cloud/) and [Maxim](https://www.getmaxim.ai/articles/top-5-ai-gateways-with-semantic-caching-to-cut-llm-api-calls/), both vendor-adjacent. For Cloudflare AI Gateway, the only evidence is issue reports that some clients or bindings drop `cache_control` (#33). A third-party Worker ([qiyuanlabs-ai/claude-prompt-cache-edge](https://github.com/qiyuanlabs-ai/claude-prompt-cache-edge)) claims "40-70% cost reduction" by auto-injecting caching; that is **VC/unverified**. **No verified prompt-caching config keys for Kong, Cloudflare, Helicone or Bifrost.**

**Self-hosted**
- 48. For vLLM, Manus recommends enabling prefix caching and routing by session ID. The exact vLLM flag was not quoted in the fetched text, so it is **not verified here.** — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)

### Inferences
- Client-runnable, no gateway needed: all Claude Code TTL and disable keys, Anthropic `cache_control`, OpenAI `prompt_cache_key`/`prompt_cache_retention`, and Aider flags. Gateway-dependent: LiteLLM auto-injection and TTL, Vercel `caching:'auto'`/`cache_anchor_items`/affinity, OpenRouter sticky routing, Portkey pass-through.
- For Claude Code users, a gateway can only hurt or break even on caching, because Claude Code already places optimal markers. The key gateway checks are that it forwards `cache_control` untouched, forwards the `anthropic-beta` header (for 1h), and doesn't flatten system blocks to strings.
- Gateway auto-injection (LiteLLM, Vercel) is valuable for custom agents and SDK apps that send no markers to Anthropic, where the baseline hit rate is 0%.

### Gaps
- Kong, Cloudflare, Helicone and Bifrost prompt-caching (not semantic-cache) config was not found or verified.
- The Continue `cacheBehavior` keys are absent from the current official reference, so their status is unknown.
- I found no documented Codex CLI config key for `prompt_cache_key` or retention, and no Cursor or Cline user settings.
- Anthropic's original 2024 prompt-caching launch table (latency and cost per use case) could not be fetched; the redirect target returned 404.
