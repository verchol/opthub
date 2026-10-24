/**
 * What an arm can change inside the sandbox, beyond the model: the LiteLLM proxy
 * Claude Code talks to (routing, caching, budget) and Claude Code itself (env,
 * settings.json, CLI flags).
 *
 * An arm carries these as two optional objects:
 *
 *   litellm: {
 *     routes:  { "<alias>": "<MODELS id>" }   extra model_list entries next to the "*" upstream.
 *                                              Claude Code sends the alias as the model name
 *                                              (see claude.subagentModel / backgroundModel), and
 *                                              LiteLLM matches an exact name before the wildcard.
 *     cacheInject: true                         cache_control_injection_points on every upstream:
 *                                              LiteLLM marks the system prompt cacheable even when
 *                                              the client did not.
 *     responseCache: { ttl: 600 }               LiteLLM's own exact-match response cache (local).
 *     budgetUsd: 2, budgetDuration: "1d"        proxy-wide max_budget: the proxy refuses requests
 *                                              once LiteLLM's own spend count reaches it.
 *   }
 *   claude: {
 *     subagentModel:   "<alias or model>"       CLAUDE_CODE_SUBAGENT_MODEL (Task subagents)
 *     backgroundModel: "<alias or model>"       ANTHROPIC_DEFAULT_HAIKU_MODEL + ANTHROPIC_SMALL_FAST_MODEL
 *                                              (titles, summaries, other small-fast calls)
 *     thinkingTokens:  8000                     MAX_THINKING_TOKENS
 *     maxOutputTokens: 16000                    CLAUDE_CODE_MAX_OUTPUT_TOKENS
 *     env:      { K: V }                        any other env var, verbatim
 *     settings: { ... }                         written to <workdir>/.claude/settings.json
 *     maxTurns: 40, fallbackModel: "sonnet", appendSystemPrompt: "…"   CLI flags
 *   }
 *
 * Without routes, every request — the main loop, subagents and Claude Code's own
 * small-fast calls — lands on the single "*" upstream. So a baseline on Opus pays
 * Opus prices for session titles. The routing arm exists to measure that.
 */

const yamlStr = (s) => JSON.stringify(String(s))

function upstream(bedrockId, inject) {
  return [
    `      model: bedrock/${bedrockId}`,
    '      aws_region_name: os.environ/AWS_REGION',
    '      aws_access_key_id: os.environ/AWS_ACCESS_KEY_ID',
    '      aws_secret_access_key: os.environ/AWS_SECRET_ACCESS_KEY',
    ...(inject ? ['      cache_control_injection_points:', '        - location: message', '          role: system'] : []),
  ].join('\n')
}

/** The LiteLLM proxy config for one arm. With no `lc` it is byte-for-byte the old single-upstream config. */
export function litellmConfig(main, lc, MODELS) {
  lc = lc ?? {}
  const inject = !!lc.cacheInject
  const entries = [`  - model_name: "*"\n    litellm_params:\n${upstream(main.bedrock, inject)}`]
  for (const [alias, id] of Object.entries(lc.routes ?? {})) {
    const m = MODELS[id]
    if (!m) throw new Error(`litellm.routes.${alias}: unknown model id "${id}"`)
    entries.unshift(`  - model_name: ${yamlStr(alias)}\n    litellm_params:\n${upstream(m.bedrock, inject)}`)
  }
  const settings = ['  drop_params: true']
  if (lc.responseCache) {
    settings.push('  cache: true', '  cache_params:', '    type: local', `    ttl: ${Number(lc.responseCache.ttl ?? 600)}`)
  }
  if (lc.budgetUsd) {
    settings.push(`  max_budget: ${Number(lc.budgetUsd)}`, `  budget_duration: ${yamlStr(lc.budgetDuration ?? '1d')}`)
  }
  return `model_list:\n${entries.join('\n')}\nlitellm_settings:\n${settings.join('\n')}\n`
    + 'general_settings:\n  master_key: sk-local\n  forward_client_headers_to_llm_api: false\n'
}

/** Env vars Claude Code reads, for one arm. */
export function claudeEnv(cc) {
  cc = cc ?? {}
  const env = { ...(cc.env ?? {}) }
  if (cc.subagentModel) env.CLAUDE_CODE_SUBAGENT_MODEL = cc.subagentModel
  if (cc.backgroundModel) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = cc.backgroundModel
    env.ANTHROPIC_SMALL_FAST_MODEL = cc.backgroundModel   // older CLIs read this name
  }
  if (cc.thinkingTokens != null) env.MAX_THINKING_TOKENS = String(cc.thinkingTokens)
  if (cc.maxOutputTokens != null) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(cc.maxOutputTokens)
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)]))
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/** Extra CLI flags for one arm. */
export function claudeFlags(cc) {
  cc = cc ?? {}
  const f = []
  if (cc.maxTurns) f.push(`--max-turns ${Number(cc.maxTurns)}`)
  if (cc.fallbackModel) f.push(`--fallback-model ${shq(cc.fallbackModel)}`)
  if (cc.appendSystemPrompt) f.push(`--append-system-prompt ${shq(cc.appendSystemPrompt)}`)
  return f.join(' ')
}

/** settings.json content for one arm, or null when the arm writes none. */
export function claudeSettings(cc) {
  return cc?.settings && Object.keys(cc.settings).length ? JSON.stringify(cc.settings, null, 2) : null
}

/** Stable one-line descriptions, used by armDiff so a no-op arm is still caught. */
export function describeLitellm(lc) {
  if (!lc) return null
  const p = []
  for (const [a, id] of Object.entries(lc.routes ?? {}).sort()) p.push(`route ${a}→${id}`)
  if (lc.cacheInject) p.push('cache-control injected')
  if (lc.responseCache) p.push(`response cache ${lc.responseCache.ttl ?? 600}s`)
  if (lc.budgetUsd) p.push(`proxy budget $${lc.budgetUsd}/${lc.budgetDuration ?? '1d'}`)
  return p.length ? p.join(', ') : null
}
export function describeClaude(cc) {
  if (!cc) return null
  const p = []
  if (cc.subagentModel) p.push(`subagents on ${cc.subagentModel}`)
  if (cc.backgroundModel) p.push(`background calls on ${cc.backgroundModel}`)
  if (cc.thinkingTokens != null) p.push(`thinking ≤${cc.thinkingTokens}`)
  if (cc.maxOutputTokens != null) p.push(`output ≤${cc.maxOutputTokens}`)
  if (cc.maxTurns) p.push(`max ${cc.maxTurns} turns`)
  if (cc.fallbackModel) p.push(`fallback ${cc.fallbackModel}`)
  if (cc.appendSystemPrompt) p.push('system prompt appended')
  for (const k of Object.keys(cc.env ?? {}).sort()) p.push(`${k}=${cc.env[k]}`)
  if (cc.settings && Object.keys(cc.settings).length) p.push(`settings.json: ${Object.keys(cc.settings).sort().join(', ')}`)
  return p.length ? p.join(', ') : null
}

/**
 * Price a Claude Code result by model. Claude Code's JSON result carries
 * `modelUsage` per model name; a routed arm is priced per route instead of
 * charging every token at the main model's rate, which would hide the saving.
 * Falls back to the single-model sum when modelUsage is absent.
 */
export function priceResult(r, main, MODELS, routes = {}) {
  const mu = r?.modelUsage
  const priceOf = (name) => {
    if (routes[name] && MODELS[routes[name]]) return MODELS[routes[name]]
    const n = String(name).toLowerCase()
    if (n.includes('sonnet') && MODELS.sonnet46) return MODELS.sonnet46
    if (n.includes('opus') && MODELS.opus45) return MODELS.opus45
    return main
  }
  if (mu && typeof mu === 'object' && Object.keys(mu).length) {
    let cost = 0
    for (const [name, u] of Object.entries(mu)) {
      const m = priceOf(name)
      const inTok = (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0)
      cost += (inTok * m.inM + (u.outputTokens ?? 0) * m.outM) / 1e6
    }
    return cost
  }
  const u = r?.usage ?? {}
  const inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
  return (inTok * main.inM + (u.output_tokens ?? 0) * main.outM) / 1e6
}
