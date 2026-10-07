# Effort / Thinking Budget, Fast & Speculative Modes, and Coding-Agent Cost Evidence

Research date: 2026-09-29. Evidence-strength labels: **measured-production** (real usage logs), **benchmark** (fixed task suite), **vendor-claim** (vendor statement, not independently reproduced), **anecdote** (single user/blog). All config keys below were seen in the fetched doc page cited next to them unless marked **UNVERIFIED**. "Client" = settable on the developer's machine; "gateway" = needs a proxy such as LiteLLM.

Context for opthub: on the pinned month (214 sessions, $508.80), effort-tuning headroom is estimated at 2.4%, and fast mode counts as extra spend (Opus fast = 2x price). The evidence below supports both choices (see Inferences).

## Q1. What does lowering effort/thinking cost in accuracy, and what does it save?

### Takeaway
Public benchmark data shows effort is a steep cost lever with a shallow accuracy curve at the top. On Aider polyglot, GPT-5 high→medium loses 1.3 pp for 39% less cost, and high→low loses 6.7 pp for 64% less. Anthropic says Opus 4.5 at medium effort matches Sonnet 4.5's best SWE-bench Verified score with 76% fewer output tokens. But effort only moves output tokens (thinking, text, and tool-call count), and in Claude Code sessions output is a minority of dollars. On current Claude Code defaults (Opus 5.5 and Sonnet 5.5 already default to `medium`), there is little room left to lower it.

### Cited Findings
**Benchmarks (Aider polyglot leaderboard, 2025 models; label: benchmark, older)** — [Aider leaderboard](https://aider.chat/docs/leaderboards/)
- GPT-5: high 88.0% / $29.08; medium 86.7% / $17.69; low 81.3% / $10.37 (whole 225-exercise run). Derived: high→medium −1.3 pp, −39% cost; high→low −6.7 pp, −64% cost. — [Aider](https://aider.chat/docs/leaderboards/)
- o3: `--reasoning-effort high` 81.3% / $21.23 vs default 76.9% / $13.75 (+4.4 pp for +54% cost). — [Aider](https://aider.chat/docs/leaderboards/)
- o3-mini: high 60.4% / $18.16 vs medium 53.8% / $8.86 (+6.6 pp for +105% cost). — [Aider](https://aider.chat/docs/leaderboards/)
- Gemini 2.5 Pro preview 06-05: `--thinking-tokens 32k` 83.1% / $49.88 vs default 79.1% / $45.60 (+4.0 pp, +9% cost). — [Aider](https://aider.chat/docs/leaderboards/)
- Claude Sonnet 4: 32k thinking 61.3% / $26.58 vs no thinking 56.4% / $15.82 (+4.9 pp, +68% cost). — [Aider](https://aider.chat/docs/leaderboards/)
- Claude Opus 4: 32k thinking 72.0% / $65.75 vs no thinking 70.7% / $68.63. Thinking was +1.3 pp and 4% cheaper, so thinking does not always add cost. — [Aider](https://aider.chat/docs/leaderboards/)

**Vendor claims (Anthropic)**
- Opus 4.5 (2025-11-24): "Set to a medium effort level, Opus 4.5 matches Sonnet 4.5's best score on SWE-bench Verified, but uses 76% fewer output tokens." At highest effort it beats Sonnet 4.5 by 4.3 pp with 48% fewer tokens. (vendor-claim) — [Anthropic, Introducing Claude Opus 4.5](https://www.anthropic.com/news/claude-opus-4-5)
- The effort parameter affects **all output tokens**: text, tool calls and arguments, and thinking. "Lower effort also means fewer and terser tool calls." It is "a behavioral signal, not a strict token budget." (vendor doc) — [Anthropic effort docs](https://platform.claude.com/docs/en/build-with-claude/effort)
- Defaults: `high` on most models. `medium` is the default on Opus 5.5 ("a request that omits `effort` runs one level lower than it did on Claude Opus 5"). For Opus 4.7/4.8, Anthropic recommends starting at `xhigh` for coding. `max` "adds significant cost for relatively small quality gains". Sonnet 5 at medium is "comparable to Claude Sonnet 4.6 at high effort". (vendor doc) — [Anthropic effort docs](https://platform.claude.com/docs/en/build-with-claude/effort)
- **Cache interaction:** "Changing the top-level effort value between requests invalidates prompt caching." Per-message effort (beta header `mid-conversation-output-config-2026-07-01`, Opus 5/5.5, Sonnet 5.5, Fable 5.1) keeps the cache. (vendor doc) — [Anthropic effort docs](https://platform.claude.com/docs/en/build-with-claude/effort)
- Claude Code defaults: Opus 5.5 and Sonnet 5.5 default to `medium`, Opus 4.7 to `xhigh`, and others to `high`. Thinking cannot be turned off on Opus 5.5, Sonnet 5.5, or Fable. `MAX_THINKING_TOKENS` applies only to fixed-budget models (Opus 4.6 and Sonnet 4.6); adaptive models ignore nonzero budgets. — [Claude Code model config](https://code.claude.com/docs/en/model-config); [Claude Code costs](https://code.claude.com/docs/en/costs)
- "Thinking tokens are billed as output tokens, and the default budget can be tens of thousands of tokens per request depending on the model." — [Claude Code costs](https://code.claude.com/docs/en/costs)
- Newer tokenizer (Claude 4.7+) "produces approximately 30% more tokens for the same text". Token savings figures from effort changes are not comparable across tokenizer generations. — [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)

### Ready-to-paste configs (verified keys)
**(a) Claude Code — client-side**
```jsonc
// ~/.claude/settings.json — per-model effort (takes precedence over global effortLevel)
{
  "modelSettings": {
    "claude-opus-5-5":   { "effortLevel": "medium" },
    "claude-sonnet-5-5": { "effortLevel": "low" }
  },
  "effortLevel": "high"          // global fallback for models without a modelSettings entry
}
```
- Env: `export CLAUDE_CODE_EFFORT_LEVEL=medium`. CLI: `claude --effort low`. In session: `/effort low`. — [model-config](https://code.claude.com/docs/en/model-config)
- `maxEffortLevel` is a **managed setting** that caps the effort users can pick (deploy through managed-settings.json or MDM). The key name is verified. **UNVERIFIED:** the exact value syntax, assumed to be a level string such as `"high"`. — [model-config](https://code.claude.com/docs/en/model-config)
- Fixed-budget models only (Opus 4.6 and Sonnet 4.6): `export MAX_THINKING_TOKENS=8000`. `MAX_THINKING_TOKENS=0` turns thinking off except on Opus 5.5, Sonnet 5.5, and Fable. `"alwaysThinkingEnabled": false` in settings.json. — [costs](https://code.claude.com/docs/en/costs), [model-config](https://code.claude.com/docs/en/model-config)
- Cheaper subagents: `export CLAUDE_CODE_SUBAGENT_MODEL=haiku`, or `model: haiku` in the subagent frontmatter. — [model-config](https://code.claude.com/docs/en/model-config), [costs](https://code.claude.com/docs/en/costs)
- Headless run with a budget cap: `claude -p "…" --effort low --max-budget-usd 2`. `--max-budget-usd` is referenced in the costs doc; the `--effort` flag is in model-config. Combining them in one command is my composition and **not tested**. — [costs](https://code.claude.com/docs/en/costs)
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS`: **UNVERIFIED.** It did not appear on the pages I fetched (costs, model-config, fast-mode).

**(b) Anthropic API — client-side**
```json
{ "model": "claude-opus-5-5", "max_tokens": 64000, "output_config": { "effort": "low" } }
```
Values: `low | medium | high | xhigh | max`. No beta header is needed. Per-message change is done with an effort-only system message, `{"role":"system","content":[],"output_config":{"effort":"low"}}`, plus the beta header `mid-conversation-output-config-2026-07-01`. On Opus 4.5 only, effort works alongside `thinking: {type:"enabled", budget_tokens:N}`. On Sonnet 5.5 the lowest setting is `thinking: {"type":"between_tools"}`, valid at low, medium, and high. — [effort docs](https://platform.claude.com/docs/en/build-with-claude/effort)

**(c) Other agents — client-side**
- Codex CLI `~/.codex/config.toml`:
  ```toml
  model_reasoning_effort = "medium"        # levels the model advertises: low|medium|high|xhigh|max|ultra
  plan_mode_reasoning_effort = "high"      # Plan-mode-only override
  model_reasoning_summary = "none"         # auto|concise|detailed|none
  model_verbosity = "low"                  # low|medium|high (GPT-5 Responses API)
  ```
  Profiles are files at `$CODEX_HOME/<name>.config.toml`, selected with `--profile <name>`. — [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- Aider: `aider --model o3 --reasoning-effort medium`; `aider --model sonnet --thinking-tokens 8k`; in-chat `/reasoning-effort high` and `/thinking-tokens 4k`. Per-model support is declared through `accepts_settings` in `.aider.model.settings.yml`; `--no-check-model-accepts-settings` overrides the check. — [Aider reasoning docs](https://aider.chat/docs/config/reasoning.html)
- Cursor, Cline/Roo, Continue: **UNVERIFIED.** I did not fetch their docs, so no keys are given.

**(d) Gateway — needs a proxy**
- LiteLLM `reasoning_effort` mapping for Anthropic. Pre-4.6 models get `thinking.budget_tokens`: minimal 1024, low 1024, medium 2048, high 4096, xhigh 8192, max 16384. Budgets can be overridden with `DEFAULT_REASONING_EFFORT_*_THINKING_BUDGET` env vars. For Claude 4.6+, LiteLLM sends `{"thinking":{"type":"adaptive"},"output_config":{"effort":<level>}}`, with minimal mapped to low. — [LiteLLM reasoning docs](https://docs.litellm.ai/docs/reasoning_content)
  ```yaml
  model_list:
    - model_name: claude-thinking
      litellm_params:
        model: anthropic/claude-sonnet-5
        thinking: { type: enabled, budget_tokens: 1024 }
  ```
  Caveat: LiteLLM's "high" is only 4096 budget tokens on legacy models, far below Claude Code's default. Routing Claude Code through LiteLLM with `reasoning_effort` can silently lower thinking.
- Kong AI Gateway: **UNVERIFIED.** No doc fetched.

### Inferences
- The effort lever acts on output tokens. Output was only about 14–22% of dollars in the Claude Code token breakdowns below (Q4). So even a 30–76% output-token cut maps to roughly 4–15% of the bill, before any accuracy-driven rework. opthub's 2.4% is plausible, at the low end of that range, especially because Claude Code's defaults for Opus 5.5 and Sonnet 5.5 are already `medium`.
- The accuracy cost is not linear. The top step (high→medium) is cheap in accuracy (GPT-5: −1.3 pp) and the bottom step (medium→low) is expensive (−5.4 pp). Lower effort can also cost more overall when it causes retries. The Opus 4 row, where no-thinking cost more than thinking, is a hint of this.
- Switching effort mid-session through top-level effort busts the prompt cache, and cache writes are about 19–34% of dollars in the breakdowns below. Per-task effort changes inside one Claude Code session could therefore cost more than they save. Whether Claude Code's `/effort` uses the cache-preserving per-message beta is **not documented in the pages fetched**.

### Gaps
- No public SWE-bench Verified sweep for Opus 5.5 or Sonnet 5.5 across low…max with cost per task. The Anthropic docs tell users to run their own sweep.
- The Aider polyglot numbers are 2025 models. I found no 2026 effort-sweep rows.
- No independent reproduction of the "76% fewer output tokens" claim.

## Q2. What do published cost-per-developer analyses report?

### Takeaway
The anchor figure is Anthropic's own: about **$13 per developer per active day, $150–250 per developer per month, and under $30 per active day for 90% of users**, measured across enterprise deployments at API list rates. Other published figures are second-hand survey citations or token-math estimates.

### Cited Findings
- "Across enterprise deployments, the average cost is around $13 per developer per active day and $150-250 per developer per month, with costs remaining below $30 per active day for 90% of users." (measured-production, vendor-reported, no methodology given) — [Claude Code costs](https://code.claude.com/docs/en/costs)
- Agent teams use "approximately 7x more tokens than standard sessions when teammates run in plan mode." (vendor-claim) — [Claude Code costs](https://code.claude.com/docs/en/costs)
- Background token use (summarization and similar) is "typically under $0.04 per session". (vendor-claim) — [Claude Code costs](https://code.claude.com/docs/en/costs)
- Per-user rate-limit recommendations drop from 200k–300k TPM (1–5 users) to 10k–15k TPM (500+ users), which reflects low concurrency in large organizations. (vendor guidance) — [Claude Code costs](https://code.claude.com/docs/en/costs)
- Illustrative `/usage` example: Sonnet 4.6, 1.2k input, 5.3k output, 940k cache read, 50k cache write = $0.55. (vendor example, not a measurement) — [Claude Code costs](https://code.claude.com/docs/en/costs)
- Survey figures, second-hand only and read in search-result text: Gartner reports nearly a quarter of tech leaders spend $200–500 per developer per month on AI coding tokens, with about 6% above $2,000. The Pragmatic Engineer survey puts the typical company-funded plan at $100–200 per engineer per month. **I could not open the primary sources.** The aggregator page returned HTTP 429. — search snippet via [MorphLLM AI coding costs](https://www.morphllm.com/ai-coding-costs), [CloudZero](https://www.cloudzero.com/blog/claude-code-pricing/)
- Faros AI reports a "50% reduction in cost per task (by replaying 211 real tasks across seven model and harness routes)". Subagents add "200–500% overhead compared to single-agent approaches". A single grep with 50 matches can consume 10k–15k tokens. (vendor-claim, 2026-06-25) — [Faros AI blog](https://www.faros.ai/blog/claude-code-token-usage)
- A GitHub issue claims each compaction re-writes about 97k unchanged tokens to cache, quoted as "700M tokens and $6.7k wasted per month on a 10-agent fleet". (anecdote, issue title only, not read in full) — [anthropics/claude-code #94197](https://github.com/anthropics/claude-code/issues/94197)

### Inferences
- opthub's pinned month ($508.80 over 214 sessions, about $2.38 per session) is about 2–3x the Anthropic enterprise per-developer average of $150–250 per month. That suggests heavy but not extreme usage. Treat the comparison with care: the vendor figure is per developer, and the pinned month may span multiple parallel sessions.

### Gaps
- No primary-source Codex or Cursor per-developer spend figures found (OpenAI and Cursor pages were not fetched successfully).
- Anthropic does not publish the sample size or date range behind $13 per day.

## Q3. What is the price/latency trade of fast modes, priority tiers, and speculative or predicted outputs?

### Takeaway
Fast modes are consistently **about 2x price for up to about 2.5x speed** at the same quality, at both Anthropic and OpenAI. They never save money on tokens. Claude Code adds a one-off penalty: turning fast mode on mid-conversation re-bills the whole context at the uncached fast input rate. OpenAI predicted outputs cut latency only on older non-reasoning models and bill rejected tokens.

### Cited Findings
- Claude Code fast mode: "up to 2.5x faster at a higher cost per token". It is the same model and same quality, supported on Opus 5.5, Opus 5, and Opus 4.8. Fast pricing is $8/$40 per MTok on Opus 5.5 and $10/$50 on Opus 5 and Opus 4.8. (vendor-claim, research preview) — [Claude Code fast mode](https://code.claude.com/docs/en/fast-mode)
- Standard pricing is $4/$20 for Opus 5.5 and $5/$25 for Opus 5 and 4.8, so **fast is exactly 2.0x** on both input and output. Cache multipliers stack on top of fast pricing. Fast mode is not available with Batch or on Bedrock, Vertex, or Foundry. — [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- "The first time you enable fast mode in a conversation, you pay the full fast mode uncached input token price for the entire conversation context." On Opus 5.5 that moves context from $0.20/MTok (cache read) to $8/MTok, a 40x step on that one turn. The 40x is my arithmetic from the cited prices. — [fast mode](https://code.claude.com/docs/en/fast-mode), [pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- On subscription plans, fast mode is billed from usage credits only, even when plan usage remains. Its rate-limit pool is separate, and it falls back to standard speed when that pool is exhausted. — [fast mode](https://code.claude.com/docs/en/fast-mode)
- OpenAI: Priority processing was renamed "Fast mode" on 2026-07-30. `service_tier: "priority"` and `service_tier: "fast"` both charge **2x** on all token types and give "up to 2.5× faster" speeds with more consistent latency. It is pay-as-you-go with no provisioning. (vendor-claim; **read in search-result text only**, because the OpenAI pages returned 403 or 404 on fetch) — [OpenAI Fast mode page](https://openai.com/api-priority-processing/), [OpenAI help FAQ](https://help.openai.com/en/articles/11647665-priority-processing-faq)
- tokscale issue: Codex sessions that ignore `service_tier` undercount priority/fast spend by 50%. Usage trackers must read the tier, or fast spend is undercounted by half. (anecdote/bug report) — [tokscale #1347](https://github.com/junhoyeo/tokscale/issues/1347)
- OpenAI Predicted Outputs: `prediction: {type:"content", content: <code>}` on gpt-4o, gpt-4o-mini, and gpt-4.1, 4.1-mini, and 4.1-nano only. It does not work with function-calling tools, `n>1`, or `max_completion_tokens`. "Any rejected tokens are still billed like other completion tokens." (vendor doc; the feature dates from 2024) — [OpenAI predicted outputs](https://developers.openai.com/api/docs/guides/predicted-outputs)

### Ready-to-paste configs
**(a) Claude Code — client-side** — [fast mode](https://code.claude.com/docs/en/fast-mode)
```jsonc
{ "fastMode": false, "fastModePerSessionOptIn": true }   // each session starts non-fast; user must /fast
```
- Kill switch: `export CLAUDE_CODE_DISABLE_FAST_MODE=1`. Org-wide: managed settings `"fastMode": false`.
- Headless: `claude -p --settings '{"fastMode": true}' "…"` (v2.1.205+).
- Behind a gateway: `CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS=1` or `CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK=1`. These affect only the client-side availability check.
- Report spend at contracted rates: managed setting `modelPricing` (v2.1.242+, managed-only). — [costs](https://code.claude.com/docs/en/costs)

**(b) API** — Anthropic `speed: "fast"` on the request. The field name is mentioned in the pricing page ("requests with `speed: "fast"`"); Managed Agents use `model.speed: "fast"`. OpenAI uses `"service_tier": "priority"` or `"fast"`.

**(c) Codex CLI** — `service_tier = "fast"` in config.toml, which maps to request value `priority`. — [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference)

### Inferences
- opthub's treatment of fast mode as spend, never savings, matches every vendor source: the premium is 2.0x on all token types. The only defensible "saving" is avoiding the mid-session enable penalty. That makes `fastModePerSessionOptIn: true` plus "enable at session start" the relevant hygiene rule, and it is replay-testable.
- Fast mode and lower effort combine: the vendor suggests "fast mode with a lower effort level for maximum speed". Lower effort offsets part of the 2x output cost.

### Gaps
- No independent tokens-per-second measurement of Anthropic fast mode found. "Up to 2.5x" is a vendor ceiling.
- No public data on speculative decoding exposed to users of Claude or Codex beyond the above. Predicted Outputs does not apply to reasoning models or tool calls, so it is mostly irrelevant to coding agents.

## Q4. Where do coding-agent tokens actually go?

### Takeaway
By **token count**, cache reads are about 94–97% of Claude Code and other coding-agent traffic, and output is under 1%. By **dollars** the picture is very different. At Anthropic prices, cache reads are about 50–66%, cache writes about 19–34%, and output about 14–22%. Fresh uncached input is near zero.

### Cited Findings
- One week on a Max plan: cache read 1,326.5M (97.4%), cache create 30.2M (2.2%), output 5.9M (0.4%), input 0.1M (0.0%), total 1,362.7M. (anecdote, measured on one user, posted Aug 7) — [DEV: "Turns Out 97% Was Cache"](https://dev.to/flipslidersand/i-thought-i-used-1-billion-tokens-in-claude-code-last-week-turns-out-97-was-cache-1m2i)
- 1,674 sessions across Cursor, Claude Code, and Codex: 94.2% of tokens were cache reads and 0.6% were agent output. In 48% of 13,323 xcodebuild or swift test runs the output was unfiltered, and filtering one test output cut about 406,500 tokens to about 168. (measured, single developer, 2026-09-28) — [SwiftLee (avanderlee.com)](https://www.avanderlee.com/ai-development/reduce-token-usage-claude-code-codex-cursor/)
- A GitHub issue reports cache reads consuming 99.93% of the usage quota, attributed to CLAUDE.md and context re-reads. (anecdote) — [anthropics/claude-code #24147](https://github.com/anthropics/claude-code/issues/24147)
- Anthropic's example: Sonnet 4.6 session with 940k cache read, 50k cache write, 5.3k output, 1.2k input = $0.55. Derived dollar split: cache read about 51%, cache write about 34%, output about 14%, input under 1%. (vendor illustration) — [Claude Code costs](https://code.claude.com/docs/en/costs)
- Pricing multipliers that drive the split: cache read is 0.1x base input on most models, **0.05x on Opus 5.5** ($0.20/MTok), and 0.025x on Fable 5.1. 5-minute cache writes are 1.25x and 1-hour writes are 2x. — [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- The cache TTL is 1 hour on a subscription but "drops to five minutes once you're drawing on usage credits". API keys default to 5 minutes. Claude Code counts a "miss" as more than 5% and at least 2k tokens re-processed. — [Claude Code costs](https://code.claude.com/docs/en/costs)

### Inferences
- The DEV week priced at Opus 4.x list rates comes to about $1,000: cache read about 66%, cache write about 19%, output about 15%. At Opus 5.5 rates it comes to about $534: cache read about 50%, cache write about 28%, output about 22%. This is my arithmetic on the cited token counts and assumes 5-minute writes.
- Implication for opthub's ranking: context size and cache hygiene (cache writes after misses, compaction, TTL expiry) touch about 70–85% of dollars. Effort and thinking touch only the output slice. This is consistent with effort headroom landing in the low single digits.

### Gaps
- No large multi-developer public dataset gives a dollar-weighted split by token type. All split data is single-user or vendor-illustrative.
- Thinking tokens are not broken out separately from output in any of these public breakdowns.
