# Context management optimizations for LLM / coding agents: evidence and config

Scope: compaction/summarization, tool-result clearing (context editing / observation masking), memory, subagent isolation, tool-schema slimming (MCP bloat, tool search / defer_loading), output-length limits. Research date: 2026-09-29. Config keys marked VERIFIED were read from the current vendor docs on that date; anything else is flagged.

Evidence-strength labels: **measured-production** (real user traffic), **benchmark** (public or reproducible eval), **vendor-claim** (vendor's internal eval, methodology not public), **anecdote** (single user/blog).

---

## Q1. What published measurements exist on long-context cost/quality in agents ("context rot"), and on compaction's accuracy cost?

### Takeaway
Several independent benchmarks show accuracy falls as input grows, even far below the advertised window and even when retrieval is perfect (drops of 13.9–85% in one EMNLP 2025 paper). Compaction's accuracy cost has been measured: summaries keep about 98.6–99.3% compression but lose file/artifact tracking (scores 2.2–2.5/5). In a SWE-bench study, simply masking old observations halved cost with no loss in solve rate, while LLM summarization made trajectories about 15% longer.

### Cited Findings
**Context rot / length degradation**
- Chroma "Context Rot" (Jul 14 2025, **benchmark**): tested 18 models (Claude Opus 4/Sonnet 4/3.7/3.5/Haiku 3.5, o3, GPT-4.1 family, GPT-4o, Gemini 2.5 Pro/Flash, Qwen3). On LongMemEval, focused prompts (~300 tokens) scored "significantly higher" than full prompts (~113k tokens) for every model. Claude Opus 4 had the widest focused-vs-full gap. A single distractor lowered accuracy and four lowered it further. Even a trivial repeated-words copy task degraded with length. Models also did worse on logically ordered haystacks than on shuffled ones. — [Chroma Research](https://www.trychroma.com/research/context-rot)
- Du et al., "Context Length Alone Hurts LLM Performance Despite Perfect Retrieval" (EMNLP 2025 Findings, arXiv Oct 2025, **benchmark**): 5 LLMs on math, QA and coding. Performance fell **13.9%–85%** as input length grew, while still well within claimed windows. This held even when the filler was whitespace, and even when irrelevant tokens were masked. The mitigation, having the model "recite the evidence first", turns a long-context task into a short-context one. — [arXiv 2510.05381](https://arxiv.org/abs/2510.05381); [ACL Anthology](https://aclanthology.org/2025.findings-emnlp.1264/)
- Anthropic "Effective context engineering for AI agents" (Sep 29 2025, **vendor position**): "as the number of tokens in the context window increases, the model's ability to accurately recall information from that context decreases". It frames context as a finite "attention budget" (n² pairwise attention). — [Anthropic Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Anthropic compaction docs (current) say compaction "keeps the active context small, because response quality degrades as a conversation grows." — [Compaction overview](https://platform.claude.com/docs/en/build-with-claude/compaction)
- Anthropic tool-search docs: tool-selection accuracy "degrades once you exceed 30–50 available tools". — [Tool search tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)

**Cost scales with context**
- Claude Code docs: "Token costs scale with context size". Unexpectedly high API spend "usually traces back to long sessions that were never cleared or to Opus left as the default model". — [Claude Code: Manage costs](https://code.claude.com/docs/en/costs)
- Claude Code docs: enterprise average is ~$13/developer/active day and $150–250/developer/month, with 90% of users below $30/active day (**measured-production, vendor-reported**). — [Claude Code: Manage costs](https://code.claude.com/docs/en/costs)
- Pricing: Claude 4.6+ models include the 1M window at standard per-token pricing ("A 900k-token request is billed at the same per-token rate as a 9k-token request"). There is no long-context premium on current models, so cost per turn grows linearly with context. — [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- Manus (Jul 18 2025, **measured-production**): the average input:output token ratio is ~100:1, and a typical task is ~50 tool calls. With Claude Sonnet, cached input costs $0.30/MTok against $3/MTok uncached (10x), so input/context dominates cost. — [Manus blog](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- Anthropic multi-agent research (Jun 13 2025, **vendor-claim**): token usage alone "explains 80% of the variance" on BrowseComp. Agents use ~4x the tokens of chat, and multi-agent systems ~15x. — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)

**Compaction / clearing accuracy cost**
- Factory "Evaluating context compression" (Dec 16 2025, **benchmark on production traces**): probe-based eval over 36,611 messages from real SWE sessions, judged by GPT-5.2 on a 0–5 scale. Overall scores: Factory anchored summarization 3.70, Anthropic compaction 3.44, OpenAI /compact 3.35. Compression ratios were 98.6% (Factory), 98.7% (Anthropic) and 99.3% (OpenAI). Every method did poorly on "artifact trail" (file tracking), at 2.19–2.45/5. — [Factory](https://factory.com/news/evaluating-compression)
- JetBrains Research, "The Complexity Trap" (NeurIPS 2025 DL4Code workshop; blog Dec 2025, **benchmark**, SWE-bench Verified, up to 250 turns):
  - Observation masking (keeping only the last M=10 turns of tool outputs) cut cost by more than 50% versus the raw agent. With Qwen3-Coder 480B it was 52% cheaper and solved 2.6% more.
  - Masking was cheaper than LLM summarization in 4 of 5 settings.
  - Summarization made trajectories ~13–15% longer, and summary calls cost more than 7% of per-instance cost.
  - A hybrid (masking plus occasional summaries) was 7% cheaper than masking alone and 11% cheaper than summarization alone.
  — [JetBrains blog](https://blog.jetbrains.com/research/2025/12/efficient-context-management/); [arXiv 2508.21433](https://arxiv.org/abs/2508.21433); [code](https://github.com/JetBrains-Research/the-complexity-trap)
- Cognition "Don't Build Multi-Agents" (Jun 12 2025, **opinion, no numbers**): for long tasks, use a model that compresses history "into key details, events, and decisions". Cognition says this "is hard to get right" and that it fine-tunes smaller models for the job. — [Cognition](https://cognition.com/blog/dont-build-multi-agents)
- OpenAI GPT-5.1-Codex-Max (Nov 2025, **vendor-claim**): natively trained to compact across multiple windows and to work "over millions of tokens"; it ran more than 24h on one task in internal evals. On SWE-bench Verified at medium effort it used 30% fewer thinking tokens than GPT-5.1-Codex. — [OpenAI](https://openai.com/index/gpt-5-1-codex-max/)
- Claude Code docs: `/compact` "reads the conversation it summarizes, so compacting a large context is itself a large request", whereas `/clear` "costs nothing". — [Claude Code: Manage costs](https://code.claude.com/docs/en/costs)

**Config: compaction / clearing** (all VERIFIED unless noted)
- *(a) Anthropic API, server-side compaction at a threshold. Client-side; beta header `compact-2026-01-12`.* `trigger.type` must be `input_tokens`, with a minimum of 50,000 and a default of 150,000. — [Compaction at a token threshold](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold)
  ```python
  client.beta.messages.create(betas=["compact-2026-01-12"], model=..., max_tokens=...,
      messages=msgs,
      context_management={"edits": [{"type": "compact_20260112",
                                     "trigger": {"type": "input_tokens", "value": 100000}}]})
  ```
  On-demand compaction uses beta `compact-2026-09-04` and a top-level `compaction` parameter, and Anthropic recommends it "wherever it is available". I did not read its body schema, so it is **unverified beyond the name**. — [Compaction overview](https://platform.claude.com/docs/en/build-with-claude/compaction)
- *(a) OpenAI Responses API. Client-side.* Server-side compaction uses `context_management=[{"type":"compaction","compact_threshold":200000}]` (the docs show 200000 as the example value). There is also a stateless `POST /responses/compact` endpoint that returns an encrypted compaction item. I could not confirm from this page whether `truncation="auto"` interacts with compaction. — [OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction)
- *(b) Claude Code. Client-side.*
  - `autoCompactEnabled` (bool) and `autoCompactWindow` (tokens, 100000–1000000) in settings.json. — [settings reference](https://code.claude.com/docs/en/settings-reference)
  - `CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000` takes a plain integer only ("500k" reads as 500), and it overrides both `/autocompact` and `--autocompact`.
  - `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50` sets a percentage of the window from 1–100. It can only lower the threshold, and it applies to subagents too.
  - `DISABLE_AUTO_COMPACT=1` turns off auto-compaction but keeps `/compact`; `DISABLE_COMPACT=1` turns off all compaction.
  - `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` holds 1M-native models to 200K.
  - The last four are all in the [env-vars reference](https://code.claude.com/docs/en/env-vars).
  - Default auto-compaction on 1M-native models (Opus 4.7+, Sonnet 5.x, Fable) runs at **~967K tokens**; 200K models compact at the 200K boundary. — [model-config](https://code.claude.com/docs/en/model-config)
  - `/compact Focus on test output and code changes`, or a `# Compact instructions` section in CLAUDE.md. — [costs](https://code.claude.com/docs/en/costs)
  - The `PreCompact` and `PostCompact` hooks have matchers `manual` and `auto`. PreCompact can block compaction with `decision:"block"`. — [hooks](https://code.claude.com/docs/en/hooks)
  ```json
  { "autoCompactWindow": 250000,
    "env": { "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "60" } }
  ```
- *(c) Codex CLI (`~/.codex/config.toml`). Client-side.* `model_auto_compact_token_limit` (unset means model default), `model_auto_compact_token_limit_scope` (`total` by default), `model_context_window`, `tool_output_token_limit`, `compact_prompt`, `experimental_compact_prompt_file` and `mcp_servers.<id>.tools.<tool>.output_token_limit`. — [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
  ```toml
  model_auto_compact_token_limit = 180000
  tool_output_token_limit = 8000
  ```
- *(c) Roo Code. Client-side, UI setting.* "Automatically trigger intelligent context condensing" is on by default, and its threshold slider defaults to 100%. The custom prompt is stored at `customSupportPrompts.CONDENSE`. 30% of the window is reserved (20% output, 10% buffer). — [Roo docs](https://roocodeinc.github.io/Roo-Code/features/intelligent-context-condensing)
- *(c) Cline "Auto Compact".* It summarizes near the limit, and Cline says cost is mostly the summary's output tokens thanks to caching. **No setting names or threshold are given in the docs; unverified.** — [Cline docs](https://docs.cline.bot/features/auto-compact)
- *(c) Cursor and Continue.* I found no documented compaction settings or numbers; **unverified**.

### Inferences
- The JetBrains and Anthropic results together say that the cheapest and safest first move is clearing or masking old tool outputs. That is a deterministic operation and easy to replay-test. Summarization should come second, because it costs a model call, lengthens trajectories and loses file tracking (the Factory artifact scores).
- Current Anthropic pricing is flat across 1M, and Claude Code's default auto-compaction on 1M models waits until about 967K. So sessions with a median context of 250k or more (opthub's 52.9% of spend) are likely never compacted by default. For opthub, lowering `autoCompactWindow` or `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is a direct, client-side, replayable lever. The cost is mostly cache-read tokens (0.1x), so the saving is proportional to the context removed per turn.
- The Chroma and Du et al. results mean a shorter context can raise quality as well as cut cost. That argues for replay-testing quality, not just cost.

### Gaps
- No public measurement of Claude Code's own auto-compact accuracy cost; Factory's "Anthropic" arm is the closest.
- No public numbers from Cursor or Continue on context management.
- The on-demand compaction (`compact-2026-09-04`) parameter body is unverified.

---

## Q2. How much do tool definitions cost, and what does tool search / deferred loading save?

### Takeaway
MCP tool definitions routinely take 20–80k tokens before any work starts (vendor measurement: ~55k for 5 servers, 134k worst case; user measurement: 66–82k). Tool search or deferred loading cuts this by about 85% (vendor) and raised MCP-eval accuracy (Opus 4.5: 79.5 to 88.1%). Claude Code now defers MCP tools by default, but not behind a non-first-party `ANTHROPIC_BASE_URL`, which matters for gateway users.

### Cited Findings
- Anthropic "Advanced tool use" (Nov 24 2025, **vendor-claim / internal measurement**):
  - Measured definition sizes: GitHub ~26K tokens (35 tools), Slack ~21K (11), Jira ~17K, Sentry ~3K, Grafana ~3K, Splunk ~2K. The 5-server setup came to ~55K, and the worst case observed was 134K.
  - Tool search cut tokens by 85%, leaving 191,300 tokens of context free versus 122,800.
  - MCP-eval accuracy went from 49% to 74% on Opus 4 and from 79.5% to 88.1% on Opus 4.5.
  - Programmatic tool calling cut tokens by 37% (43,588 to 27,297).
  - Tool use examples raised accuracy from 72% to 90%.
  — [Anthropic Engineering](https://www.anthropic.com/engineering/advanced-tool-use)
- Anthropic "Code execution with MCP" (Nov 4 2025, **vendor-claim, illustrative example**): letting the agent write code against a filesystem of tool files cut tokens from 150,000 to 2,000 (98.7%). — [Anthropic Engineering](https://www.anthropic.com/engineering/code-execution-with-mcp)
- Scott Spence (Sep 30 2025, **anecdote with measurements**): MCP tools took 66,000–81,986 tokens, about a third of a 200k window (omnisearch 14.1k, playwright 13.6k, sqlite-tools 13.4k ×2, n8n 7.0k). He merged 20 tools into 8, taking omnisearch from 14,214 to 5,663 tokens (-60%), and measured with `/context`. — [scottspence.com](https://scottspence.com/posts/optimising-mcp-server-context-usage-in-claude-code)
- Secondary reports (**anecdote/aggregator**):
  - Claude Code MCP Tool Search is reported as launched Jan 14 2026 (v2.1.7), with auto-deferral when tools exceed 10% of context. — [atcyrus](https://www.atcyrus.com/stories/mcp-tool-search-claude-code-context-pollution-guide)
  - One user reports 3 vendor MCPs going from ~12K to ~600 tokens (-95%). — [claudefa.st](https://claudefa.st/blog/tools/mcp-extensions/mcp-tool-search)
  - I did not verify the launch date or version against Anthropic's changelog.
- Claude Code docs (current, VERIFIED): "MCP tool definitions are deferred by default, so only tool names and server instructions enter context". `ENABLE_TOOL_SEARCH` is unset by default, which defers everything. It takes `true`, `auto` (load upfront if the tools fit within 10% of context), `auto:N` or `false`. Tool search is **disabled when `ANTHROPIC_BASE_URL` points to a non-first-party host** ("most proxies don't forward `tool_reference` blocks") unless you set it explicitly. `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` forces it off. — [env-vars](https://code.claude.com/docs/en/env-vars); [MCP docs](https://code.claude.com/docs/en/mcp); [costs](https://code.claude.com/docs/en/costs)
- Claude Code docs: `MAX_MCP_OUTPUT_TOKENS` defaults to 25000, with a warning above 10,000. `disableClaudeAiConnectors` (setting) and `ENABLE_CLAUDEAI_MCP_SERVERS=false` stop claude.ai connectors from loading. — [env-vars](https://code.claude.com/docs/en/env-vars); [settings reference](https://code.claude.com/docs/en/settings-reference)
- Codex: `skills.max_context_tokens` caps the skills catalog, defaulting to 2% of the window. — [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- Manus (Jul 2025, **practice, no number**): Manus masks tool logits instead of removing tools, because changing tool definitions invalidates the KV cache (10x price difference). It uses fewer than 20 atomic tools. — [Manus blog](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus); [Lance Martin notes](https://rlancemartin.github.io/2025/10/15/manus/)

**Config** (VERIFIED)
- *(a) API. Client-side.* Include a tool search tool, then mark the rest deferred. Search returns up to 5 `tool_reference` results by default. The Nov 2025 blog used beta header `advanced-tool-use-2025-11-20`; the current docs list the tool types as supported on 4.5+ models, but I did not confirm whether a beta header is still required. — [tool search docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
  ```json
  "tools": [
    {"type": "tool_search_tool_bm25_20251119", "name": "tool_search_tool_bm25"},
    {"name": "github_create_issue", "description": "...", "input_schema": {...}, "defer_loading": true}
  ]
  ```
- *(b) Claude Code. Client-side.*
  ```json
  { "env": { "ENABLE_TOOL_SEARCH": "true", "MAX_MCP_OUTPUT_TOKENS": "10000" },
    "disableClaudeAiConnectors": true }
  ```
  Behind a gateway, set `ENABLE_TOOL_SEARCH=true` only if the proxy forwards `tool_reference`; otherwise tools load upfront. Use `/context` to audit usage, and remove MCP servers you don't use.
- *(c) Codex:* `mcp_servers.<id>.tools.<tool>.output_token_limit`, `skills.max_context_tokens`.

### Inferences
- For opthub users on a gateway (a custom `ANTHROPIC_BASE_URL`), the default deferral is off, so the whole ~55k-token MCP tax may be present on every turn. That is a replayable, measurable finding to check in transcripts: look for tool-definition tokens in the system prefix.
- Tool definitions sit in the cached prefix, so their marginal cost is mostly cache-read (0.1x). But they occupy context on every turn and lower tool-selection accuracy, which Anthropic says degrades beyond 30–50 tools.

### Gaps
- No independent (non-Anthropic) benchmark of tool-search accuracy.
- The Claude Code tool-search launch date and version are only from secondary sources.

---

## Q3. What do Anthropic context editing / memory, Manus, Cognition, Factory and LangChain report?

### Takeaway
Anthropic reports an 84% token reduction and +29% (context editing alone) or +39% (with memory) task performance on an internal agentic-search eval. Manus, LangChain and Cognition give principles (reduce, offload, isolate; prefer reversible compaction over summarization; KV-cache stability) but few numbers. Factory gives the only public compaction quality comparison.

### Cited Findings
- Anthropic "Managing context on the Claude Developer Platform" (Sep 29 2025, **vendor-claim, internal eval**): memory plus context editing gave +39% over baseline on agentic search, and context editing alone gave +29%. In a 100-turn web-search eval, context editing cut token use by 84% and let agents finish workflows that would otherwise fail from context exhaustion. — [Claude blog](https://claude.com/blog/context-management)
- Anthropic "Effective context engineering" (Sep 29 2025): tool-result clearing is "the safest, lightest-touch form of compaction". For compaction prompts, "maximize recall first, then precision". Use structured note-taking (NOTES.md or a to-do list), and retrieve just in time using file paths or queries as handles. — [Anthropic Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Manus (Jul 18 2025): keep the prefix stable and the context append-only to preserve the KV cache (10x price gap). Use the file system as restorable external memory, recite a todo.md, and keep errors in context. — [Manus blog](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- Lance Martin / LangChain x Manus webinar (Oct 2025): stale tool results are compacted to references while newer ones stay in full, and summarization is used only "when compaction reaches diminishing returns". Manus was refactored 5 times since its March 2025 launch. The playbook is reduce, offload, isolate. — [rlancemartin.github.io](https://rlancemartin.github.io/2025/10/15/manus/); [webinar summary (Medium, secondary)](https://medium.com/@caldasdcardoso/inside-the-langchain-x-manus-webinar-on-context-engineering-69166ee404db)
- Cognition (Jun 12 2025): share full traces; "actions carry implicit decisions". Compressing history with an LLM is "hard to get right". — [Cognition](https://cognition.com/blog/dont-build-multi-agents)
- Factory (Dec 2025): see Q1 (scores of 3.70 / 3.44 / 3.35). — [Factory](https://factory.com/news/evaluating-compression)
- Prompt compression. **These are paper benchmarks on RAG/QA, not agents.**
  - LLMLingua (EMNLP 2023; older): "up to 20x compression with minimal performance loss".
  - LongLLMLingua (ACL 2024): RAG accuracy up to +21.4% using 1/4 of the tokens.
  - LLMLingua-2 (ACL 2024 Findings): 3–6x faster than the original.
  - The API is `PromptCompressor().compress_prompt(ctx, rate=0.33 | target_token=200, force_tokens=[...])`.
  — [LLMLingua GitHub](https://github.com/microsoft/LLMLingua)
- Kong AI Prompt Compressor (**vendor doc, no savings number**): needs Kong Gateway 3.11+ and an external LLMLingua-2 service (a Docker image with a `POST /llm/v1/compressPrompt` endpoint). It compresses by ratio or target token count, applies conditional rules by prompt length, and compresses selectively inside `<LLMLINGUA>` tags. **The exact plugin field names were not verified.** Gateway-side only. — [Kong docs](https://developer.konghq.com/plugins/ai-prompt-compressor/)

**Config** (VERIFIED, API, client-side; beta `context-management-2025-06-27`)
- Defaults (from [context editing docs](https://platform.claude.com/docs/en/build-with-claude/context-editing)):
  - `trigger` is 100,000 input tokens.
  - `keep` is 3 tool uses.
  - `clear_at_least` has no default. Use it so a cache break is worth it.
  - `exclude_tools` has no default.
  - `clear_tool_inputs` defaults to false.
  - A thinking-clearing strategy, `clear_thinking_20251015` with `keep: {type: "thinking_turns", value: N}` or `"all"`, also exists.
  ```python
  client.beta.messages.create(betas=["context-management-2025-06-27"], model=..., max_tokens=4096,
    tools=[..., {"type": "memory_20250818", "name": "memory"}],
    context_management={"edits": [{"type": "clear_tool_uses_20250919",
        "trigger": {"type": "input_tokens", "value": 30000},
        "keep": {"type": "tool_uses", "value": 3},
        "clear_at_least": {"type": "input_tokens", "value": 5000},
        "exclude_tools": ["web_search"]}]})
  ```
  Memory tool: `{"type":"memory_20250818","name":"memory"}` is the entire definition; the client implements the file operations. — [memory tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- Claude Code equivalent:
  - Claude Code clears old tool results itself, and the `/cost` cache line counts "expected rebuild (compaction or tool-result clearing)". — [costs](https://code.claude.com/docs/en/costs)
  - I found **no user-facing key to tune its tool-result-clearing threshold**.
  - The closest levers are `BASH_MAX_OUTPUT_LENGTH` (default 30000 chars, max 150000) or the newer `bashOutputMaxChars` setting (4000–128000, v2.1.261+; overflow goes to a file plus a preview). Also `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`, `MAX_MCP_OUTPUT_TOKENS`, and a PreToolUse/PostToolUse hook that greps logs. The docs say this goes "from tens of thousands of tokens to hundreds".
  — [env-vars](https://code.claude.com/docs/en/env-vars); [settings reference](https://code.claude.com/docs/en/settings-reference); [costs](https://code.claude.com/docs/en/costs)
- *(c) Aider:* `--map-tokens` (default 1k, and it can expand when no files are in chat), `--map-refresh`, `--map-multiplier-no-files` and `--max-chat-history-tokens` exist in the options reference. I did not verify their defaults beyond map-tokens=1k. — [Aider repo map](https://aider.chat/docs/repomap.html); [Aider options](https://aider.chat/docs/config/options.html)
- *(d) Gateway:* Kong ai-prompt-compressor (above). LiteLLM: **not researched or verified**.

### Inferences
- Anthropic's 84% figure and JetBrains's ~50% cost reduction both come from dropping old tool outputs. That is the best-evidenced single lever, and it is deterministic, so opthub can simulate it exactly on transcripts: drop tool_result bodies older than the last N, then reprice.
- LLMLingua-style compression is poorly suited to agent transcripts with code. The evidence base is RAG/QA, and lossy token deletion inside code or diffs is risky. I would rank it as low priority for Claude Code.

### Gaps
- Anthropic's context-editing eval methodology is not public.
- No public numbers from LangChain or Cognition.

---

## Q4. Evidence for scoping a subagent to a fresh, small context (cost and quality)?

### Takeaway
Anthropic reports a large quality gain from multi-agent isolation (+90.2%), but at about 15x chat token cost. Subagents return condensed summaries of 1–2k tokens to the lead agent. Cognition warns against parallel write-subagents and endorses Claude Code's read-only question-answering subagents. There is no public controlled measurement of the cost of a subagent versus inline work in a coding agent.

### Cited Findings
- Anthropic multi-agent research (Jun 13 2025, **vendor-claim**): an Opus 4 lead with Sonnet 4 subagents beat single-agent Opus 4 by 90.2% on an internal research eval. Multi-agent uses about 15x the tokens of chat, and agents about 4x. Subagents with "separate context windows" act as compression. The lead saves its plan to memory near the 200k limit. — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- Anthropic context engineering (Sep 2025): subagents may use "tens of thousands of tokens" but return condensed summaries, typically 1,000–2,000 tokens. — [Anthropic Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Cognition (Jun 2025): parallel subagents make conflicting implicit decisions. Claude Code's subtask agent "is usually only tasked with answering a question, not writing any code", which keeps investigation out of the main history. — [Cognition](https://cognition.com/blog/dont-build-multi-agents)
- Claude Code docs: "Delegate verbose operations to subagents… verbose output stays in the subagent's context while only a summary returns". The subagent's own requests still cost money, so use a smaller model. — [costs](https://code.claude.com/docs/en/costs)

**Config** (VERIFIED, Claude Code, client-side)
- `.claude/agents/<name>.md` frontmatter fields are `description`, `tools`, `disallowedTools`, `model`, `permissionMode`, `mcpServers`, `hooks`, `maxTurns`, `skills`, `initialPrompt`, `memory`, `effort`, `background`, `omitClaudeMd` and `isolation`. If `tools` is omitted, the subagent inherits every tool. — [sub-agents](https://code.claude.com/docs/en/sub-agents)
  ```markdown
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
- `CLAUDE_CODE_SUBAGENT_MODEL=haiku` sets the default subagent model. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` forces it (v2.1.257+). `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` also applies to subagents. — [env-vars](https://code.claude.com/docs/en/env-vars)

### Inferences
- opthub's 51k to 6.1k scoped-turn demo (-88%) is in line with Anthropic's 1–2k-token return summaries and the 84% context-editing result. But subagent cost is additive: the subagent re-reads its own context. The net saving has to be computed as the parent's avoided context carried forward over the remaining turns, minus the subagent's own spend. Replay is the right way to measure this, since there is no public benchmark of it.

### Gaps
- No public controlled study of subagent versus inline work in coding agents, for either cost or quality.

---

## Output-length limits (cross-cutting)

### Cited Findings
- Claude Code's `CLAUDE_CODE_MAX_OUTPUT_TOKENS` default varies by model; it is 32000 for unrecognized IDs. **Raising it reduces the effective context window before auto-compaction.** — [env-vars](https://code.claude.com/docs/en/env-vars)
- `MAX_THINKING_TOKENS` is a fixed thinking budget, capped at max_output-1 and never below 1,024. `0` disables thinking except on Opus 5.5, Sonnet 5.5 and Fable. Lower effort with `/effort`. — [env-vars](https://code.claude.com/docs/en/env-vars); [costs](https://code.claude.com/docs/en/costs)
- Codex-Max used 30% fewer thinking tokens at equal effort (vendor-claim). — [OpenAI](https://openai.com/index/gpt-5-1-codex-max/)
- Manus reports a 100:1 input:output ratio, so output caps are a minor cost lever for agents compared with context. — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- Chroma's repeated-words task: models under-generated and hit output limits early at long lengths. — [Chroma](https://www.trychroma.com/research/context-rot)

### Config
- API: `max_tokens`. Claude Code: `{"env":{"CLAUDE_CODE_MAX_OUTPUT_TOKENS":"16000","MAX_THINKING_TOKENS":"8000"}}`. Codex: I found no max-output key in the fetched reference (**unverified**).

### Gaps
- I found no public measurement of cost or quality from capping output length in coding agents.
