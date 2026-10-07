# Model Routing, Cascades, and Local / Open-Weights Offload for LLM Workloads and Coding Agents

Research date: 2026-09-29. Evidence-strength labels: **measured-production** (live traffic or real user sessions), **benchmark** (public or academic benchmark, reproducible), **vendor-claim** (the seller's own numbers, method not independently checked), **anecdote** (blog or n-small personal test).
Config labels: **[client]** runs from the developer's machine with no extra infra. **[gateway]** needs a proxy or router process (local or hosted). **[verified]** means the key was seen in official docs fetched this session. **[secondary]** means the key was seen only in third-party tutorials. **[unverified]** means from memory or not re-checked this session.

---

## Q1. What quality loss do routers report on benchmarks vs on real agent workloads?

### Takeaway
On single-turn benchmarks, learned routers report "95% of strong-model quality" at 35–85% lower cost, but the size of the saving depends heavily on the benchmark (MT-Bench 85%, GSM8K 35%). Independent evaluations (RouterArena, "Most of the Routing Gap Is Task Type") find that most routers over-select the expensive model. They also find that a static per-task-type table captures about 72% of the achievable gain. Agent-workload evidence is thin and mostly vendor-claimed (Not Diamond: 39% cheaper at Opus parity on Poly-SWE-Bench). The best agent-specific academic result is on tool calling (Switchcraft: 84% cheaper at best-single-model accuracy), not long coding trajectories. For an opthub replay, the honest prior is this: benchmark "no quality loss" claims do not carry over to multi-turn agent sessions without per-workload validation.

### Cited Findings

**RouteLLM (LMSYS / Berkeley), 2024-07-01. Benchmark (GPT-4 Turbo strong vs Mixtral 8x7B weak).**
- Cost reduction at 95% of GPT-4 quality: over 85% on MT-Bench, 45% on MMLU, 35% on GSM8K — [LMSYS blog](https://www.lmsys.org/blog/2024-07-01-routellm/)
- The matrix-factorization router needed 26% GPT-4 calls for 95% of MT-Bench performance with Arena data only (48% cheaper than a random baseline), and 14% GPT-4 calls with LLM-judge-augmented data (75% cheaper than random). On MMLU the causal-LLM router needed 54% GPT-4 calls (only 14% cheaper than random) — [LMSYS blog](https://www.lmsys.org/blog/2024-07-01-routellm/)
- Claims to match Martian and Unify AI commercial routers "while being over 40% cheaper". Generalized to the Claude 3 Opus / Llama 3 8B pair without retraining — [LMSYS blog](https://www.lmsys.org/blog/2024-07-01-routellm/)
- Config [gateway, unverified this session; from the RouteLLM README as I recall it]: an OpenAI-compatible server started with `python -m routellm.openai_server --routers mf --strong-model gpt-4-1106-preview --weak-model anyscale/mistralai/Mixtral-8x7B-Instruct-v0.1`. Clients call the model name `router-mf-0.11593`, where the suffix is the cost threshold, calibrated with `python -m routellm.calibrate_threshold --routers mf --strong-model-pct 0.5`. Verify against https://github.com/lm-sys/RouteLLM before use.

**FrugalGPT (Stanford), 2023. Benchmark (cascade: try cheap, escalate by a learned scorer). [not re-fetched this session]**
- Abstract claims it can match GPT-4 performance with up to 98% cost reduction, or improve accuracy over GPT-4 by 4% at the same cost. The tasks are classification/QA datasets, not agents — [arXiv 2305.05176](https://arxiv.org/abs/2305.05176)

**Hybrid LLM (Microsoft), ICLR 2024. Benchmark. [not re-fetched this session]**
- Abstract claims up to 40% fewer calls to the large model with no drop in response quality, using a quality-gap router with a tunable threshold — [arXiv 2404.14618](https://arxiv.org/abs/2404.14618)

**RouterArena (Rice University), 2025-09-30, ICLR 2026. Independent benchmark: about 8,400 queries, 44 categories, 12 routers.**
- "No single router is universally optimal." Commercial routers (NotDiamond, Azure Model Router, GPT-5 router) got higher accuracy at "substantially elevated costs". Open-source routers (CARROT, GraphRouter, RouterDC) were more cost-efficient — [arXiv 2510.00202](https://arxiv.org/html/2510.00202v1)
- "All existing routers fall short... primarily because they are inefficient at recognizing when smaller, cheaper models are sufficient" — [arXiv 2510.00202](https://arxiv.org/html/2510.00202v1)
- Router overhead is "non-negligible" and "may even compromise service-level objectives"; some routers exceed 100 ms — [arXiv 2510.00202](https://arxiv.org/html/2510.00202v1)
- Secondary (search snippet, not fetched): the claim that Not Diamond ranks #12 or last (score 60.8, June 2026 round) because it often picks expensive models, and that vLLM-SR and CARROT reach about 35% cost savings at under 2% accuracy loss — [dreaming.press](https://dreaming.press/posts/2026-06-21-routellm-vs-notdiamond-vs-martian.html); [RouterArena leaderboard](https://routeworks.github.io/?p=%2Fleaderboard). Treat as unverified.

**"Most of the LLM Routing Gap Is Task Type" (Lee, Redrob), 2026-08-24. Benchmark: 14 models, 294 questions, 7 task types, 3 languages.**
- Only 29 of 294 questions could benefit from routing at all. A static task-type → model table fixed 21 of the 29 (about 72% of the possible gain) — [arXiv 2608.23023](https://arxiv.org/abs/2608.23023)
- Static table: 262 correct at $3.33 per run. Best single model: 245 correct at $7.69 per run. So the table was both cheaper (−57%) and better — [arXiv 2608.23023](https://arxiv.org/abs/2608.23023)
- 5.37% of the 4,116 model-question pairs scored differently across repeat runs. Run-to-run noise is the same order as many routers' claimed gains — [arXiv 2608.23023](https://arxiv.org/abs/2608.23023)

**Switchcraft (Microsoft Research authors), 2026-05-08. Benchmark: agentic tool/function calling.**
- 82.9% accuracy, "matching or exceeding the best individual model", with 84% lower inference cost (over $3,600 saved per million queries). Uses a DistilBERT classifier under a latency budget — [arXiv 2605.07112](https://arxiv.org/abs/2605.07112)
- "Nominally cheaper models can incur higher total cost due to token-intensive reasoning." Per-token price is a poor proxy for per-task cost — [arXiv 2605.07112](https://arxiv.org/abs/2605.07112)

**Agent-as-a-Router / CodeRouterBench (NUS, Alibaba DAMO), 2026-06-26. Benchmark: about 10k coding task instances, 8 frontier LLMs.**
- Adding task-dimension performance statistics to a vanilla LLM router gives a 15.3% relative gain. The authors report that static classifiers "experience significant performance degradation" on out-of-distribution agentic programming tasks, while their feedback-loop router stays robust. No absolute cost numbers in the abstract — [alphaXiv 2606.22902](https://www.alphaxiv.org/abs/2606.22902)

**TwinRouterBench, 2026-05-14. Benchmark design (agentic routing).**
- States the core problem: existing router benchmarks score isolated prompts, but coding agents make many model calls per user request. Its dynamic track runs routers live on 500 SWE-bench cases (100-case held-out set), scored by resolution rate and actual API cost. The abstract gives no headline numbers — [arXiv 2605.18859](https://arxiv.org/abs/2605.18859)

**Not Diamond Code, 2026-08-04. Vendor-claim on coding-agent benchmarks.**
- Poly-SWE-Bench Verified: 39% cost reduction while matching Opus 4.8 xhigh. LongCodeQA: 61% cost reduction at Opus parity. Adding open-weights models (GLM 5.2, DeepSeek V4 Flash) to the Anthropic pool: 66% savings with +3.6% performance. Enterprise early access: "over 20%" savings — [Not Diamond blog](https://www.notdiamond.ai/blog/not-diamond-code-intelligent-model-routing-for-coding-agents)
- Says it runs as a local proxy, is "harness- and gateway-agnostic", accounts for KV/prompt-cache state when deciding to switch, and sends only derived metadata off-machine. The blog gives no concrete Claude Code env vars — [Not Diamond blog](https://www.notdiamond.ai/blog/not-diamond-code-intelligent-model-routing-for-coding-agents)
- Rootly case study (vendor-claim, search snippet only): +39% average accuracy on Rootly's SRE benchmarks — [notdiamond.ai](https://www.notdiamond.ai/)
- Config: [gateway]. Point `ANTHROPIC_BASE_URL` at the local proxy. The exact port and keys are **unverified** because the blog gives none.

**OpenRouter Auto Router. Vendor docs (current as of 2026-09).**
- `model: "openrouter/auto"` selects from about 30 task types based on community usage patterns. The response reports the chosen model. There is no extra fee (you pay the selected model's rate). Session stickiness via `session_id` prefers the model a conversation already landed on. Cost bands are `low` / `medium` / `high` / `xhigh` / `max`. Allowed-model filter: `plugins: [{ id: 'auto-router', allowed_models: ['anthropic/*'] }]`. No quality-retention numbers are published — [OpenRouter docs](https://openrouter.ai/docs/features/model-routing)
- Config [gateway (hosted), verified]:
  ```json
  { "model": "openrouter/auto",
    "session_id": "<stable-per-conversation-id>",
    "plugins": [{ "id": "auto-router", "allowed_models": ["anthropic/*"] }],
    "messages": [ ... ] }
  ```
  The `models: [primary, fallback, ...]` fallback array is **unverified this session** (not returned by the fetch).

**LiteLLM auto (complexity) router and prompt caching. Measured-production plus benchmark, vendor (LiteLLM) blog, 2026-07-31.**
- Tiers: SIMPLE → claude-haiku-4-5, MEDIUM → claude-sonnet-5, COMPLEX/REASONING → claude-opus-5. Datasets: WildChat-1M (30,769 conversations), DevGPT (1,011), and **95 real agent sessions / 8,174 API calls**. Auto-routing with caching was 37–69% cheaper than single-model caching. This is a **cost** result; the post does not report task-success retention on the agent sessions — [LiteLLM blog](https://docs.litellm.ai/blog/auto-router-prompt-caching-benchmark)
- Config [gateway, verified]:
  ```yaml
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
          classifier_type: heuristic      # or llm | jev | custom
          session_affinity: true          # pin session to first-turn model (cache-friendly)
          enable_context_window_escalation: true
        complexity_router_default_model: claude-sonnet-5
  ```
  Optional LLM classifier: `classifier_type: llm`, `classifier_llm_config: {model: ..., timeout_ms: 2000}`, `classifier_fallback: heuristic` — [LiteLLM auto routing docs](https://docs.litellm.ai/docs/proxy/auto_routing). Point Claude Code at it with `ANTHROPIC_BASE_URL=http://<litellm-host>:4000` and `ANTHROPIC_MODEL=smart-router` (the model name mapping is **unverified**; check that LiteLLM's Anthropic `/v1/messages` passthrough exposes `smart-router`).
- LiteLLM load-balancing strategies [verified]: `routing_strategy: simple-shuffle | least-busy | latency-based-routing | usage-based-routing-v2 | cost-based-routing`, with `num_retries`, `allowed_fails`, `cooldown_time`, `enable_pre_call_checks: true` — [LiteLLM routing docs](https://docs.litellm.ai/docs/routing). Fallback syntax `router_settings: fallbacks: [{"claude-opus-5": ["claude-sonnet-5"]}]` (plus `context_window_fallbacks`, `content_policy_fallbacks`) is **unverified this session**, though it is a long-standing LiteLLM feature.

### Inferences
- The published "95% quality" numbers are averages over single-turn prompts judged by an LLM or by exact match. RouterArena and Switchcraft agree that routers struggle to recognize when the cheap model is enough. Agent-as-a-Router reports that static classifiers degrade on OOD agentic programming tasks. Both point the same way as opthub's prompt-only-router counterexample that missed a security finding: a prompt-level router cannot see the difficulty that shows up only later in the trajectory.
- The "Most of the Routing Gap Is Task Type" result suggests a strong, cheap baseline for opthub: a static rule per task class (subagent type, background vs main loop, plan vs execute). Evaluate this before learned routers.
- The only agent-workload quality numbers in this catalog are vendor claims (Not Diamond) or tool-calling benchmarks (Switchcraft). No independent source reports resolve-rate retention for a router inside a long Claude Code-style session.

### Gaps
- Martian, Kong ai-proxy-advanced (semantic routing), and Portkey conditional routing were not researched this session. There are no verified configs or numbers for them.
- TwinRouterBench's dynamic-track headline numbers (resolve rate vs cost for routers on SWE-bench) were not in the abstract. The full PDF is worth fetching.
- RouteLLM server flags and the OpenRouter `models` fallback array need re-verification against current docs.

---

## Q2. What do coding-agent-specific splits (architect/editor, plan/act, background model) save, with numbers?

### Takeaway
The strongest public number for a split is still Aider's 2024 architect/editor benchmark. Pairing a strong reasoner with a cheaper editor raised pass rate rather than lowering it (o1-preview + DeepSeek 85.0% vs o1-preview solo 79.7%). Claude Code offers the same splits natively (`opusplan`, subagent `model:` frontmatter, `CLAUDE_CODE_SUBAGENT_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` for background work), but Anthropic publishes no measured savings for them. Savings figures for subagent-to-Haiku routing come from blogs (30–60%) and are not controlled for quality.

### Cited Findings

**Aider architect/editor, 2024-09-26. Benchmark (Aider code-editing benchmark).**
- o1-preview architect + o1-mini editor: 85.0%. o1-preview + DeepSeek: 85.0%. o1-preview + claude-3.5-sonnet: 82.7%. o1-preview solo baseline (diff): 79.7%. claude-3.5-sonnet + claude-3.5-sonnet: 80.5%. gpt-4o + gpt-4o: 75.2%. o1-mini + DeepSeek: 71.4%. gpt-4o-mini pair: 60.2% — [Aider blog](https://aider.chat/2024/09/26/architect.html)
- Interpretation: on this benchmark the cheap editor (DeepSeek) gave no quality loss and cost far less than o1-preview for the edit step. The blog does not report per-run dollar cost in the fetched table.
- Config [client, verified]: `aider --architect --model <strong> --editor-model <cheap>`, plus `--editor-edit-format`, `--auto-accept-architect` (default True), and `--weak-model <cheap>`. The weak model is used only "for commit messages and chat history summarization". YAML keys: `architect`, `model`, `editor-model`, `weak-model` (these follow the documented flag-to-key convention) — [Aider options](https://aider.chat/docs/config/options.html)
  ```yaml
  # .aider.conf.yml
  architect: true
  model: anthropic/claude-opus-5-5          # planner
  editor-model: anthropic/claude-sonnet-5   # applies edits
  weak-model: anthropic/claude-haiku-4-5    # commits + summaries
  ```
  The model ID strings are illustrative. Check Aider's model name aliases.

**Claude Code native splits. Vendor docs (code.claude.com, current 2026-09). No savings numbers published.**
- `opusplan` alias: "Uses `opus` in plan mode, switches to `sonnet` for execution". `claude --model opusplan` or `/model opusplan[1m]` — [Model config docs](https://code.claude.com/docs/en/model-config)
- Env vars [client, verified]: `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_MODEL` (v2.1.236+), `ANTHROPIC_DEFAULT_OPUS_MODEL` (the `opus` alias and plan-mode Opus), `ANTHROPIC_DEFAULT_SONNET_MODEL` (the `sonnet` alias and execution-mode Sonnet), `ANTHROPIC_DEFAULT_HAIKU_MODEL` ("`haiku` alias and background functionality"), `CLAUDE_CODE_SUBAGENT_MODEL`, and `ANTHROPIC_BASE_URL` ("changes where requests are sent, not which model answers"). **`ANTHROPIC_SMALL_FAST_MODEL` is deprecated; use `ANTHROPIC_DEFAULT_HAIKU_MODEL`** — [Model config docs](https://code.claude.com/docs/en/model-config)
- settings.json [client, verified]: `"model"`, `"fallbackModel"` (array, capped at 3, used "when primary unavailable" — an availability fallback, not a cost cascade), `"effortLevel"`, `"modelSettings"`, `"availableModels"`, `"deniedModels"`, `"maxEffortLevel"`. CLI: `claude --fallback-model sonnet,haiku` — [Model config docs](https://code.claude.com/docs/en/model-config)
  ```json
  {
    "model": "opusplan",
    "fallbackModel": ["sonnet", "haiku"],
    "env": {
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5",
      "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet"
    }
  }
  ```
  (`env` block in settings.json is a standard Claude Code settings key; not re-fetched this session.)
- Subagent frontmatter [client, verified]: `model:` accepts `sonnet | opus | haiku | fable`, a full model ID, or `inherit`. Precedence: per-invocation `model` param > frontmatter `model` > `CLAUDE_CODE_SUBAGENT_MODEL` > main model. **As of v2.1.251 `CLAUDE_CODE_SUBAGENT_MODEL` no longer overrides frontmatter.** The built-in Explore subagent inherits the main model, capped at Opus on the Claude API. Users can override it by defining their own `Explore` agent — [Subagents docs](https://code.claude.com/docs/en/sub-agents)
  ```yaml
  ---
  name: file-scout
  description: Locate files and symbols; no edits
  model: haiku
  tools: Read, Glob, Grep
  ---
  ```
- Effort levels are a within-model routing knob: `low | medium | high | xhigh | max`. Opus 5.5 and Sonnet 5.5 default to `medium`. `CLAUDE_CODE_EFFORT_LEVEL` / `effortLevel` — [Model config docs](https://code.claude.com/docs/en/model-config)

**claude-code-router (musistudio). Community tool, [gateway: local proxy].**
- Router rule keys [secondary, since the official docs page returned 404 and the current README defers to ccrdesk.top]: `default`, `background` ("can be a smaller, local model to save costs"), `think` ("reasoning-heavy tasks, like Plan Mode"), `longContext`, `longContextThreshold` (default 60000), `webSearch`. Values are `"provider,model"` strings — [DataCamp tutorial](https://www.datacamp.com/tutorial/claude-code-router); [Morph guide](https://www.morphllm.com/claude-code-router); [GitHub README](https://github.com/musistudio/claude-code-router)
  ```json
  {
    "Router": {
      "default": "deepseek,deepseek-chat",
      "background": "ollama,qwen2.5-coder:latest",
      "think": "deepseek,deepseek-reasoner",
      "longContext": "openrouter,google/gemini-2.5-pro-preview",
      "longContextThreshold": 60000,
      "webSearch": "gemini,gemini-2.5-flash"
    }
  }
  ```
  The `Providers` array, `CUSTOM_ROUTER_PATH`, `image` key, and `<CCR-SUBAGENT-MODEL>` tag are **unverified this session**. The project has been reorganized into a desktop app with "conditions on headers and bodies; prefixes; rewrites; retries; ordered fallbacks", so the schema may have changed.
- Savings: a third-party review headline asks "Can You Really Cut Your AI Coding Bill By 80%?" (not fetched; anecdote) — [aitoolanalysis.com](https://aitoolanalysis.com/claude-code-router-review/). There is no measured quality data.

**Subagent-to-Haiku savings. Anecdote / blog (search snippets, not fetched).**
- "One team cut token spend by 60% just by setting two fields in their agent frontmatter". "Model routing alone cuts the subagent line item roughly 30%" — [Medium, Monteiro](https://medium.com/@roanmonteiro/claude-code-subagent-model-routing-stop-paying-for-opus-on-haiku-work-ee76dc32cb88); [byteiota](https://byteiota.com/claude-code-subagent-model-routing/)
- Fleet arithmetic: 1 Opus 5 + 3 Sonnet 5 + 1 Haiku costs $39.00/day vs $81.25 for 5 Opus 5 (−52%, under promotional pricing). This is price-sheet math, not a measurement — [Developers Digest](https://www.developersdigest.tech/blog/what-parallel-claude-agents-actually-cost)
- Not Diamond (vendor-claim): routing easy requests to Haiku 4.5 saves "40 to 70 percent depending on prompt distribution, with under 2 percent quality loss on hard tasks" (snippet; the source page was not identified precisely) — [notdiamond.ai](https://www.notdiamond.ai/)

**Codex CLI [client, partly verified].**
- Keys: `model`, `model_provider`, `model_reasoning_effort`, `review_model` (model override for `/review`), `model_providers.<id>.base_url` / `env_key`, `oss_provider = "ollama" | "lmstudio"`, `codex --oss`, `--profile <name>` — [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- The fetched summary says profiles live in `profile-name.config.toml` files. Older docs used `[profiles.<name>]` tables inside `config.toml`. Treat the exact profile-file layout as **unverified**. There is no documented separate "background/subagent model" key.

**Cline/Roo plan/act models, Continue model roles, Cursor auto mode:** not researched this session. There are no verified keys or numbers.

### Inferences
- Aider's result suggests the split that is safe in quality is "strong model decides, cheaper model transcribes edits". The risky split is "cheap model decides what to look at", as in exploration or review subagents on Haiku. In that split, missed findings (such as opthub's missed security finding) never become visible to the strong model.
- `fallbackModel` in Claude Code is an availability failover, not a cost-quality cascade. Claude Code has no native "try Haiku, escalate on low confidence" mechanism. A cascade needs a gateway.
- The v2.1.251 precedence change means opthub replays that set `CLAUDE_CODE_SUBAGENT_MODEL` will **not** override subagents whose frontmatter pins `model:`. Replays must patch frontmatter too.

### Gaps
- No controlled public measurement of `opusplan` vs all-Opus or all-Sonnet (cost and resolve rate) was found.
- No measured quality impact of moving the Claude Code background (Haiku-slot) model to a local model was found.

---

## Q3. What evidence exists on local models for coding agents (quality gap, latency), especially on long agentic sessions?

### Takeaway
Open-weights coding models now post high SWE-bench Verified numbers (Qwen3-Coder-Next 70.6%, vendor-reported). But the only hands-on comparison found (50 tasks, one consumer GPU) shows the local gap concentrated in multi-file and agentic work, at about half the throughput. No source measures local models across long Claude Code sessions. opthub's n=1 result (7.1x cheaper, 18 points worse) matches the direction of the multi-file gap and is larger than the averaged 6% gap in the blog test.

### Cited Findings
- Qwen3-Coder-Next (3B active params): 70.6% SWE-bench Verified, 62.8% SWE-bench Multilingual, 44.3% SWE-bench Pro. **Vendor-claim** (Qwen), and scaffold-dependent — [Qwen blog](https://qwen.ai/blog?id=qwen3-coder-next); aggregated at [Morph](https://www.morphllm.com/best-ollama-models)
- Devstral 24B: 46.8% SWE-bench Verified (vs GPT-4.1-mini 23.6%, Claude 3.5 Haiku 40.6%). **Aggregator** — [Morph](https://www.morphllm.com/best-ollama-models)
- Qwen3-Coder 30B-A3B: 19 GB at Q4_K_M, 256K context. Best quality per GB on 24–32 GB GPUs or a 32 GB Mac — [Morph](https://www.morphllm.com/best-ollama-models)
- **Anecdote/benchmark (Ganglani, 2026-03-27, updated 2026-07-12)**, RTX 4070 Ti Super 16 GB, 50 real tasks in 5 categories, scored /15:
  - Claude Sonnet 5: 13.2 at about 80 tok/s. Qwen3-Coder Q4_K_M: 12.4 at about 38 tok/s (within 6%). Qwen2.5-Coder-32B: 11.1. DeepSeek-Coder-V2: 10.9. Gemma 4 12B: 10.6 at about 55 tok/s.
  - Multi-file refactoring: Claude 13.6 vs Qwen3-Coder 11.4 (−16%). Local matched or beat Claude on single-file generation and test generation.
  - Break-even on the GPU is about 6–7 weeks at 50 agentic sessions/day ($225–337/month API) — [kunalganglani.com](https://www.kunalganglani.com/blog/local-llm-vs-claude-coding-benchmark)
- The same source says the gap was 15–20% in March 2026 and narrowed to 6% by the update (per the search snippet) — [kunalganglani.com](https://www.kunalganglani.com/blog/local-llm-vs-claude-coding-benchmark)
- Config [client + local server, verified] for Claude Code on Ollama: `ollama launch claude`, or
  ```bash
  export ANTHROPIC_AUTH_TOKEN=ollama
  export ANTHROPIC_API_KEY=""
  export ANTHROPIC_BASE_URL=http://localhost:11434
  claude --model qwen3.5
  ```
  Ollama advises setting context length "to 64k or higher" for larger codebases. Tool calling is "available with compatible models" — [Ollama docs](https://docs.ollama.com/integrations/claude-code)
- Claude Code settings needed with custom or local model IDs [verified]: `CLAUDE_CODE_MAX_CONTEXT_TOKENS` ("correct context window for gateway/custom model ID") and `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1`. Without these, auto-compact thresholds assume the wrong window — [Model config docs](https://code.claude.com/docs/en/model-config)
- Hybrid local offload via the Haiku slot [client, verified keys; untested combination]: point `ANTHROPIC_DEFAULT_HAIKU_MODEL` at a local model only if `ANTHROPIC_BASE_URL` targets a gateway that serves both Anthropic and local models (LiteLLM or claude-code-router), since one base URL serves all slots.
- Codex CLI local [client, verified keys]: `oss_provider = "ollama"` or `"lmstudio"`; `codex --oss` — [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- Not Diamond (vendor-claim): adding open-weights GLM 5.2 and DeepSeek V4 Flash to a routing pool raised savings from 39% to 66% with +3.6% performance. This is hosted open-weights, not local — [Not Diamond blog](https://www.notdiamond.ai/blog/not-diamond-code-intelligent-model-routing-for-coding-agents)

### Inferences
- SWE-bench Verified scores for open models come from vendor scaffolds with large context windows at full precision. Local Q4 quantization with a 64K context under Claude Code's harness (a large system prompt plus tool schemas) is a different operating point. Expect a larger gap than the leaderboard delta, as opthub observed.
- Throughput of about 38 tok/s vs about 80 tok/s means local sessions take roughly twice the wall-clock time for the same tokens. Long agentic sessions compound this through more turns when quality is lower.

### Gaps
- No public study measures local-model task success across long (multi-hour, 100+ tool-call) Claude Code sessions, tool-call malformation rates, or compaction behavior with local models.
- No independent SWE-bench run of quantized local models under Claude Code's own harness was found.

---

## Q4. Documented failure modes (cache invalidation on model switch, OOD long contexts, router overhead latency)

### Takeaway
Switching models clears the prompt cache (Anthropic documents this for `/model`). The best measurement found shows that switch-backs are mostly still warm, and that session-affinity routing avoids most of the loss (LiteLLM: 97.4% warm at 5-min TTL). But a router that switches every turn with caching broken costs about 4x a single cached model. Router latency overhead can exceed 100 ms. Static routers degrade out of distribution on agentic coding. Cheap models can cost more per task through extra tokens.

### Cited Findings
- **Cache cleared on model switch:** "Cache is cleared when you switch models". Changing effort level mid-session "may clear cache" — [Claude Code model config](https://code.claude.com/docs/en/model-config)
- **Switch-backs mostly warm:** across 4,684 real switch-backs on live gateway traffic, the cache was warm 97.4% of the time at 5-min TTL and 99.3% at 1-hour TTL. Only 4% of misses were preventable by background warming. Measured-production (vendor blog) — [LiteLLM blog](https://docs.litellm.ai/blog/auto-router-prompt-caching-benchmark)
- **The expensive mistake:** "a router with caching switched off costs about 4x caching one fixed model". Every switch with cost-optimization and fallback enabled is "a full cold rebuild costing 1.25× write with zero reads" (search snippet from LiteLLM's caching docs/blog) — [LiteLLM prompt caching doc](https://docs.litellm.ai/docs/auto_router/prompt_caching)
- **Router drops cache_control:** an open-source router issue reports that the router stripped client `cache_control`, making vendor prompt caching unreachable — [tas-llm-router issue #100](https://github.com/Tributary-ai-services/tas-llm-router/issues/100)
- **Mitigations in config [verified]:** LiteLLM `session_affinity: true`, OpenRouter `session_id` stickiness, and Not Diamond's cache-aware switching (vendor-claim) — [LiteLLM docs](https://docs.litellm.ai/docs/proxy/auto_routing); [OpenRouter docs](https://openrouter.ai/docs/features/model-routing); [Not Diamond blog](https://www.notdiamond.ai/blog/not-diamond-code-intelligent-model-routing-for-coding-agents)
- **Router latency overhead:** some routers exceed 100 ms and "may even compromise service-level objectives" — [RouterArena](https://arxiv.org/html/2510.00202v1). The LiteLLM LLM classifier has a documented `timeout_ms: 2000` budget, meaning up to 2 s added per routed call when that classifier is used — [LiteLLM docs](https://docs.litellm.ai/docs/proxy/auto_routing)
- **OOD degradation:** static classifier routers "experience significant performance degradation" on out-of-distribution agentic programming tasks — [Agent-as-a-Router](https://www.alphaxiv.org/abs/2606.22902)
- **Routers under-use cheap models:** "inefficient at recognizing when smaller, cheaper models are sufficient" — [RouterArena](https://arxiv.org/html/2510.00202v1)
- **Cheap per token ≠ cheap per task:** "nominally cheaper models can incur higher total cost due to token-intensive reasoning" — [Switchcraft](https://arxiv.org/abs/2605.07112)
- **Measurement noise:** 5.37% of model-question pairs flip between identical runs — [arXiv 2608.23023](https://arxiv.org/abs/2608.23023)
- **Coupled variables:** prompt wording, effort level, and harness design interact, so token or cache counts alone are "not sufficient optimization targets" — [arXiv 2608.01347](https://arxiv.org/abs/2608.01347)
- **Long-context routing cost trap (anecdote):** setting `longContextThreshold` too low in claude-code-router sends mid-sized requests to the expensive long-context model — [search snippet, Morph/EggStriker guides](https://www.morphllm.com/claude-code-router)
- **Context-window mismatch with custom models:** Claude Code needs `CLAUDE_CODE_MAX_CONTEXT_TOKENS` for gateway or custom model IDs, or compaction fires at the wrong point — [Claude Code model config](https://code.claude.com/docs/en/model-config)

### Inferences
- For opthub replays: route per session or per subagent, not per turn. Per-turn switching inside the main loop risks cold caches (1.25x write cost with no reads) and wipes out the cheaper model's price advantage on long contexts.
- The 5.37% run-to-run flip rate and the 72% static-table result together argue for replaying each routing policy several times before claiming a "no quality loss" result. opthub's n=1 18-point drop is directionally credible but statistically weak.

### Gaps
- No public measurement quantifies Anthropic-side cache loss specifically for `opusplan` transitions (plan → execute).
- No numbers were found on how often routers pick the weak model for security-sensitive review tasks, or what they miss when they do.
- Kong, Portkey, and Martian overhead and latency numbers were not researched.
