/**
 * LLM Light — render a profile (config/llmlight-profiles.json) into what runs:
 *
 *   litellm.yaml            the proxy: one model per tier, fallbacks, cache, budget, the hook
 *   llmlight_router.py      the per-request decision and the audit (assets/, copied verbatim)
 *   llmlight_profile.json   the resolved rules the hook reads, with the project's classes baked in
 *   claude env / flags      how Claude Code is pointed at the proxy and what it caps
 *
 * Targets:
 *   local    Anthropic API (ANTHROPIC_API_KEY on the machine). Applying it moves Claude Code on
 *            that project from subscription auth to API billing — the proxy needs a key.
 *   sandbox  Bedrock through optimize.mjs MODELS, inside an E2B arm.
 *   mock     every tier answers "ok" without calling anyone — for tests and demos.
 */
import fs from 'node:fs'
import path from 'node:path'

const TIERS = ['frontier', 'mid', 'small']
/** optimize.mjs MODELS, as much as rendering a sandbox target needs (the arm itself passes the real table) */
export const SANDBOX_MODELS = {
  opus45: { label: 'Claude Opus 4.5', bedrock: 'eu.anthropic.claude-opus-4-5-20251101-v1:0' },
  sonnet46: { label: 'Claude Sonnet 4.6', bedrock: 'eu.anthropic.claude-sonnet-4-6' },
}

export function loadProfiles(ROOT) {
  const f = path.join(ROOT, 'config', 'llmlight-profiles.json')
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) { return { version: '0', profiles: [], error: e.message } }
}
export const profileById = (ROOT, id) => loadProfiles(ROOT).profiles.find((p) => p.id === id) ?? null

/** tier -> litellm_params lines, per target */
function tierModels(target, MODELS = {}) {
  if (target === 'local') {
    const a = (m) => [`model: anthropic/${m}`, 'api_key: os.environ/ANTHROPIC_API_KEY']
    return { frontier: a('claude-opus-5'), mid: a('claude-sonnet-5'), small: a('claude-haiku-4-5'),
             label: { frontier: 'Claude Opus 5', mid: 'Claude Sonnet 5', small: 'Claude Haiku 4.5' } }
  }
  if (target === 'mock') {
    const m = (t) => [`model: anthropic/mock-${t}`, 'api_key: sk-mock', `mock_response: "ok from ${t}"`]
    return { frontier: m('frontier'), mid: m('mid'), small: m('small'), label: { frontier: 'mock', mid: 'mock', small: 'mock' } }
  }
  const b = (id) => [`model: bedrock/${MODELS[id].bedrock}`, 'aws_region_name: os.environ/AWS_REGION',
    'aws_access_key_id: os.environ/AWS_ACCESS_KEY_ID', 'aws_secret_access_key: os.environ/AWS_SECRET_ACCESS_KEY']
  // no Haiku id is enabled on this Bedrock account yet: small runs on the mid model
  const small = MODELS.haiku45 ? 'haiku45' : 'sonnet46'
  return { frontier: b('opus45'), mid: b('sonnet46'), small: b(small),
           label: { frontier: MODELS.opus45.label, mid: MODELS.sonnet46.label, small: MODELS[small].label } }
}

/**
 * The classes Jev gave this project's sessions (Hub → Triage), reduced to one per axis: the class
 * that covers the most spend, ignoring `unclear`. `unclear` everywhere leaves the axis unset, so
 * no session-class rule can fire on it — which is what "keep-frontier" means.
 */
export function classesFor(projectDir, triage) {
  if (!projectDir || !triage?.sessions) return {}
  const norm = String(projectDir).replace(/^\/Users\/[^/]+/, '~').replace(/\/$/, '')
  const mine = triage.sessions.filter((s) => String(s.key || '').split('|').slice(1).join('|') === norm)
  const out = {}
  for (const ax of ['urgency', 'latency', 'deferral', 'capability', 'context']) {
    const w = {}
    for (const s of mine) { const v = s.labels?.[ax]; if (v && v !== 'unclear') w[v] = (w[v] ?? 0) + s.cost }
    const best = Object.entries(w).sort((a, b) => b[1] - a[1])[0]
    if (best) out[ax] = best[0]
  }
  return { ...out, _sessions: mine.length }
}

function yamlList(lines, pad) { return lines.map((l) => pad + l).join('\n') }

export function render(profile, { target = 'local', MODELS = {}, classes = {}, auditPath = null } = {}) {
  if (!profile) throw new Error('no such profile')
  const tm = tierModels(target, MODELS)
  const inject = !!profile.cache?.inject
  const entry = (name, tier) => `  - model_name: "${name}"\n    litellm_params:\n${yamlList(tm[tier], '      ')}`
    + (inject ? '\n      cache_control_injection_points:\n        - location: message\n          role: system' : '')
  const models = [...TIERS.map((t) => entry(`tier-${t}`, t)), entry('*', profile.routing?.default ?? 'frontier')]

  const fb = Object.entries(profile.routing?.fallbacks ?? {}).filter(([, to]) => to?.length)
  const router = fb.length ? 'router_settings:\n  fallbacks:\n' + fb.map(([from, to]) =>
    `    - "tier-${from}": [${to.map((t) => `"tier-${t}"`).join(', ')}]`).join('\n') + '\n' : ''

  const s = ['  drop_params: true', '  callbacks: llmlight_router.handler']
  if (profile.cache?.responseTtl > 0) s.push('  cache: true', '  cache_params:', '    type: local', `    ttl: ${Number(profile.cache.responseTtl)}`)
  const b = profile.budget ?? {}
  if (b.perRunUsd) s.push(`  max_budget: ${Number(b.perRunUsd)}`)
  else if (b.perDayUsd) s.push(`  max_budget: ${Number(b.perDayUsd)}`, '  budget_duration: "1d"')

  const litellmYaml = `# LLM Light profile "${profile.id}" · target ${target} · rendered ${new Date().toISOString()}\n`
    + `model_list:\n${models.join('\n')}\n${router}litellm_settings:\n${s.join('\n')}\n`
    + 'general_settings:\n  master_key: sk-local\n  forward_client_headers_to_llm_api: false\n'

  const sessionClasses = Object.fromEntries(Object.entries(classes).filter(([k]) => !k.startsWith('_')))
  const hookProfile = {
    id: profile.id, target,
    routing: { default: profile.routing?.default ?? 'frontier', rules: profile.routing?.rules ?? [],
               neverDowngrade: profile.routing?.neverDowngrade ?? [] },
    // only when the profile reads Triage: a rules-only profile must not be steered by classes
    sessionClasses: profile.classifier?.source === 'session-classes' ? sessionClasses : {},
    audit: { log: profile.audit?.log ?? 'decisions', ...(auditPath ? { path: auditPath } : {}),
             judgeSampleRate: profile.audit?.judgeSampleRate ?? 0 },
  }

  const env = {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000',
    ANTHROPIC_AUTH_TOKEN: 'sk-local',                    // the proxy's master key, not a real credential
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'llmlight-background', // lets the hook tell a background call apart
    CLAUDE_CODE_SUBAGENT_MODEL: 'llmlight-subagent',
    ...(b.thinkingTokens ? { MAX_THINKING_TOKENS: String(b.thinkingTokens) } : {}),
    ...(profile.claude?.env ?? {}),
  }
  const flags = b.maxTurns ? `--max-turns ${Number(b.maxTurns)}` : ''

  const summary = [
    `main loop → ${profile.routing?.default ?? 'frontier'} (${tm.label[profile.routing?.default ?? 'frontier']})`,
    ...(profile.routing?.rules ?? []).map((r) => `${JSON.stringify(r.when)} → ${r.to} (${tm.label[r.to]})${r.why ? ' — ' + r.why : ''}`),
    ...(profile.routing?.neverDowngrade?.length ? [`never downgrade on: ${profile.routing.neverDowngrade.join(', ')}`] : []),
    ...(fb.length ? [`fallbacks: ${fb.map(([f, t]) => f + '→' + t.join('→')).join(', ')}`] : []),
    `cache: ${inject ? 'system prompt marked cacheable' : 'client default'}${profile.cache?.responseTtl > 0 ? `, response cache ${profile.cache.responseTtl}s` : ''}`,
    `budget: ${b.perRunUsd ? `$${b.perRunUsd} per run` : b.perDayUsd ? `$${b.perDayUsd} per day` : 'none'} at the proxy`
      + `${b.maxTurns ? `, ${b.maxTurns} turns` : ''}${b.thinkingTokens ? `, thinking ≤ ${b.thinkingTokens}` : ''}`,
    `audit: ${hookProfile.audit.log}${hookProfile.audit.judgeSampleRate ? `, ${Math.round(hookProfile.audit.judgeSampleRate * 100)}% of routed turns re-graded` : ''}`,
    ...(Object.keys(hookProfile.sessionClasses).length ? [`project classes (Triage): ${Object.entries(hookProfile.sessionClasses).map(([k, v]) => k + '=' + v).join(', ')}`] : []),
  ]
  return { profile: profile.id, target, litellmYaml, hookProfile, env, flags, summary, tiers: tm.label }
}

/** The files to lay down next to each other, keyed by name. */
export function renderFiles(ROOT, profile, opts) {
  const r = render(profile, opts)
  return { ...r, files: {
    'litellm.yaml': r.litellmYaml,
    'llmlight_profile.json': JSON.stringify(r.hookProfile, null, 2),
    'llmlight_router.py': fs.readFileSync(path.join(ROOT, 'assets', 'llmlight_router.py'), 'utf8'),
  } }
}

/** Sum what the hook audited for a run: routed calls per tier, and LiteLLM's own cost. */
export function readAudit(text) {
  const out = { calls: 0, byTier: {}, byCall: {}, cost: 0, errors: 0 }
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue
    let r; try { r = JSON.parse(line) } catch { continue }
    if (r.event === 'route') { out.calls++; out.byTier[r.tier] = (out.byTier[r.tier] ?? 0) + 1; out.byCall[r.call] = (out.byCall[r.call] ?? 0) + 1 }
    if (r.event === 'result' && typeof r.cost_usd === 'number') out.cost += r.cost_usd
    if (r.event === 'error') out.errors++
  }
  return out
}
