#!/usr/bin/env node
/**
 * A synthetic company for demos: Tallyfox, a fictional AI-native startup (invoice automation),
 * five months of Claude Code use while the team grows, then opt adopted: Triage classifies the
 * sessions, experiments test the levers, optimize mode rolls out, and spend per session falls.
 *
 *   node tools/demo-startup.mjs [out-dir]        (opt hub demo builds it on first start)
 *
 * Everything here is generated, from one seed; nothing is copied from a real session. The shapes
 * are calibrated on the pinned, stripped opthub ledger (docs/data/e1b-sessions.csv): how cost
 * splits across cache reads, writes, output and thinking, how sessions are sized, how often a
 * script rather than a person drives one. Every file is marked synthetic, and the hub shows a
 * banner when it serves this data.
 *
 *   <out>/projects/        Claude Code transcripts            (OPT_PROJECTS_DIR)
 *   <out>/home/            opt state: Triage, experiments, opt claude -p runs and their claims
 *                          audits, profile ladders, OTEL telemetry, the task trail   (OPT_HOME)
 *   <out>/claude-settings.json   a settings file with no LangSmith, so nothing real is read
 *
 * Derived artifacts are computed from the generated transcripts with the hub's own readers
 * (processTranscript, the claims audit), so every number on every page agrees with every other.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const COMPANY = 'Tallyfox'
export const DEFAULT_OUT = path.join(os.homedir(), '.opthub', 'demo', 'tallyfox')
const NOW = Date.parse(process.env.OPT_DEMO_NOW ?? new Date().toISOString())
const DAY = 864e5
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

// ---------------------------------------------------------------- deterministic randomness
let seed = 0x7a11f0
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pick = (a) => a[Math.floor(rnd() * a.length)]
const between = (a, b) => a + rnd() * (b - a)
const gauss = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()) }
const lognormal = (median, sigma) => median * Math.exp(sigma * gauss())
const weighted = (pairs) => { const t = pairs.reduce((s, [, w]) => s + w, 0); let r = rnd() * t; for (const [v, w] of pairs) { if ((r -= w) < 0) return v } return pairs.at(-1)[0] }
const uuid = () => { const h = [...Array(32)].map(() => Math.floor(rnd() * 16).toString(16)).join(''); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[Math.floor(rnd() * 4)]}${h.slice(17, 20)}-${h.slice(20, 32)}` }
const msgId = () => 'msg_01' + [...Array(22)].map(() => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'[Math.floor(rnd() * 56)]).join('')
const toolId = () => 'toolu_01' + [...Array(22)].map(() => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'[Math.floor(rnd() * 56)]).join('')

// ---------------------------------------------------------------- the company
const HOME = '/Users/demo'
const PROJECTS = {
  api: { lang: 'python', kind: 'code', weight: 26, files: ['app/invoices/router.py', 'app/invoices/service.py', 'app/models.py', 'tests/test_invoices.py', 'app/auth/tokens.py', 'migrations/0042_add_currency.py'],
    intents: ['add an endpoint that returns overdue invoices grouped by customer', 'the reconciliation job double-counts partial payments, find out why and fix it', 'add idempotency keys to the payment webhook handler', 'migrate the invoice totals to Decimal everywhere and update the tests', 'write tests for the currency conversion service, it has none', 'refactor the auth token refresh so it stops racing under load', 'add rate limiting per tenant to the public API', 'why does test_invoice_pdf fail only in CI'] },
  web: { lang: 'typescript', kind: 'code', weight: 20, files: ['src/app/invoices/page.tsx', 'src/components/InvoiceTable.tsx', 'src/lib/api.ts', 'src/app/settings/billing/page.tsx', 'src/hooks/useInvoices.ts'],
    intents: ['build the invoice detail drawer with line items and payment history', 'the dashboard table re-renders on every keystroke in the filter, fix the performance', 'add a dark mode toggle that follows the system setting', 'wire the new overdue endpoint into the collections view', 'make the billing settings page work on mobile', 'add optimistic updates when marking an invoice paid'] },
  extractor: { lang: 'python', kind: 'debug', weight: 16, files: ['extractor/pipeline.py', 'extractor/layout.py', 'extractor/eval/run_eval.py', 'extractor/prompts/line_items.md', 'tests/test_layout.py'],
    intents: ['the line-item extraction misses totals on multi-page PDFs, debug it against the eval set', 'run the eval suite and explain why recall dropped on German invoices', 'add a fallback when the OCR layer returns empty pages', 'tighten the line_items prompt so it stops inventing tax rows', 'profile the pipeline, a 40-page invoice takes four minutes'] },
  agents: { lang: 'python', kind: 'code', weight: 14, files: ['agents/collections_agent.py', 'agents/tools/email.py', 'agents/memory.py', 'agents/evals/test_collections.py'],
    intents: ['the collections agent sends a reminder twice when the webhook retries, make it idempotent', 'add a tool that lets the agent look up a customer payment plan', 'write an eval for the dunning email tone', 'summarise what the agent did in the last 50 runs from the logs'] },
  infra: { lang: 'hcl', kind: 'code', weight: 9, files: ['terraform/modules/db/main.tf', 'k8s/api-deployment.yaml', '.github/workflows/ci.yml', 'terraform/envs/prod/main.tf'],
    intents: ['add a read replica for the reporting queries in terraform', 'CI takes 19 minutes, find what to cache', 'set up a staging environment that mirrors prod at a quarter of the size', 'the api pods restart under load, look at the probes'] },
  data: { lang: 'sql', kind: 'explore', weight: 8, files: ['models/marts/fct_invoices.sql', 'models/staging/stg_payments.sql', 'analyses/churn_by_cohort.sql'],
    intents: ['which customers pay late most often, by plan and region', 'build a dbt model for monthly recurring revenue', 'explain the drop in paid invoices last week', 'add tests to the payments staging model'] },
  docs: { lang: 'markdown', kind: 'doc', weight: 7, files: ['docs/rfc/0012-multi-currency.md', 'docs/api/invoices.md', 'CHANGELOG.md', 'docs/onboarding.md'],
    intents: ['write the RFC for multi-currency invoices from the notes in docs/notes', 'update the API reference for the new overdue endpoint', 'draft release notes for 2.4 from the merged PRs', 'turn the onboarding checklist into a proper guide'] },
}
const FOLLOWUPS = ['now run the full test suite', 'good, also handle the empty case', 'that broke the other test, look again', 'add a test for that', 'can you make it simpler', 'commit it with a clear message', 'also update the docs', 'check the logs for the same error', 'what else calls this function', 'ok ship it', 'try it with the March export', 'why is that slower than before']
const SCRIPTED = [['ci', 'triage the failing CI run and propose a fix'], ['ci', 'bump dependencies and run the tests'], ['docs', 'update CHANGELOG.md from the merged PRs'], ['api', 'nightly: run the migration dry-run and report'], ['extractor', 'nightly eval: run the extraction eval and summarise regressions']]
const TOOLS = { code: [['Read', 20], ['Edit', 24], ['Bash', 30], ['Grep', 12], ['Write', 5], ['Task', 5], ['TodoWrite', 4]], debug: [['Read', 22], ['Bash', 40], ['Grep', 16], ['Edit', 14], ['Task', 6], ['WebSearch', 2]],
  explore: [['Read', 25], ['Bash', 45], ['Grep', 15], ['Write', 10], ['Task', 5]], doc: [['Read', 35], ['Write', 25], ['Edit', 20], ['Grep', 10], ['WebFetch', 5], ['Task', 5]] }

// ---------------------------------------------------------------- the story
const START = Date.UTC(2026, 5, 2)                                  // 2 June
const TRIAGE_AT = Date.UTC(2026, 8, 1, 9)                           // 1 Sep: opt analyse + Triage
const ROLLOUT = Date.UTC(2026, 8, 15)                               // 15 Sep: optimize mode starts
const optimizedShare = (t) => (t < ROLLOUT ? 0 : Math.min(0.9, 0.45 + ((t - ROLLOUT) / DAY) * 0.025))
// the company's size: TEAM scales the sessions a day, TOKENS the context each step reads and adds
// (a large monorepo), OUT the replies. Weekday sessions grow from ~6 to ~28 as the team grows.
const TEAM = 4, TOKENS = 4, OUT = 3, COMPACT_AT = 480e3
const perDay = (t) => TEAM * 1.6 * Math.exp(((t - START) / DAY) / 100)

// ---------------------------------------------------------------- one session as a transcript
function simulate({ sid, project, start, scripted, optimized, intent }) {
  const P = PROJECTS[project] ?? PROJECTS.api
  const cwd = `${HOME}/tallyfox/${project === 'ci' ? 'api' : project}`
  const kind = scripted ? 'code' : P.kind
  // optimize mode routes non-coding sessions to Sonnet; coding stays on Opus
  const model = optimized && (P.kind === 'doc' || P.kind === 'explore') ? 'claude-sonnet-5-5' : 'claude-opus-5-5'
  const lines = []
  let t = start, parent = null, ctx = Math.round(between(19000, 26000) * TOKENS), prevCtx = 0
  const base = { cwd, sessionId: sid, version: '2.1.2' + Math.floor(between(60, 99)), entrypoint: scripted ? 'sdk-cli' : 'cli', isSidechain: false, userType: 'external', gitBranch: 'main' }
  const push = (o) => { const uuidv = uuid(); lines.push({ parentUuid: parent, ...base, ...o, uuid: uuidv, timestamp: new Date(t).toISOString() }); parent = uuidv }
  const prompts = scripted ? 1 : Math.max(1, Math.min(40, Math.round(lognormal(7, 0.75))))
  let lastEnd = t, files = new Set()
  // the 529 incidents and the September rate limits are days, not dice rolls per request
  const day = new Date(start).toISOString().slice(0, 10)
  const incident = ['2026-08-21', '2026-09-17', '2026-10-08'].includes(day)
  const rateLimited = start > Date.UTC(2026, 8, 5) && start < ROLLOUT && rnd() < 0.18
  for (let p = 0; p < prompts; p++) {
    if (p) {
      const gap = Math.min(6 * 3600e3, lognormal(150e3, 1.25))
      t += gap
      // a gap past the cache's life: the next request writes the whole context again
      if (gap > 3600e3) prevCtx = -1
    }
    const turnStart = t
    push({ type: 'user', message: { role: 'user', content: p ? pick(FOLLOWUPS) : intent } })
    const steps = Math.max(1, Math.round(lognormal(scripted ? 7 : 11, 0.7) * (optimized ? 0.9 : 1)))
    for (let s = 0; s < steps; s++) {
      if ((incident || rateLimited) && rnd() < (incident ? 0.12 : 0.05)) {
        const n = 1 + Math.floor(rnd() * 3)
        for (let k = 0; k < n; k++) {
          t += between(2e3, 9e3)
          push({ type: 'system', subtype: 'api_error', level: 'error', retryAttempt: k + 1, maxRetries: 10,
            error: { message: incident ? '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' : '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}' } })
        }
        if (incident && rnd() < 0.15) push({ type: 'assistant', isApiErrorMessage: true, message: { id: msgId(), model: '<synthetic>', role: 'assistant', type: 'message', content: [{ type: 'text', text: 'API Error: 529 Overloaded. This is a server-side issue, usually temporary.' }], usage: { input_tokens: 0, output_tokens: 0 } } })
      }
      // optimize mode compacts early (COMPACT_AT); without it, Claude Code compacts only near the window
      if (ctx > (optimized ? COMPACT_AT : 900e3)) { push({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' }); ctx = Math.round(between(32e3, 48e3) * TOKENS); prevCtx = -1 }
      const last = s === steps - 1
      const out = Math.round(Math.min(9000 * OUT, lognormal(last ? 260 : 170, 0.9) * OUT * (optimized ? 0.78 : 1)))
      const think = Math.round(out * (optimized ? 0.14 : 0.32))
      const add = Math.round(Math.min(40e3 * TOKENS, lognormal(kind === 'debug' ? 2600 : 1700, 0.9) * TOKENS))
      const cold = prevCtx === -1
      const usage = { input_tokens: Math.round(between(2, 12)), cache_creation_input_tokens: cold ? ctx : add, cache_read_input_tokens: cold ? 0 : ctx, output_tokens: out,
        output_tokens_details: { thinking_tokens: think }, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cold ? ctx : add }, service_tier: 'standard' }
      prevCtx = ctx
      ctx += add + out
      t += lognormal(scripted ? 6e3 : 9e3, 0.5) * (out / 300 + 0.6)
      const content = []
      let tool = null
      if (!last) {
        tool = weighted(TOOLS[kind])
        const f = pick(P.files)
        const input = tool === 'Bash' ? { command: pick(['pytest -q', 'npm test', 'git status', 'make test', 'python -m extractor.eval.run_eval --set de', 'terraform plan', 'rg -n reconcile app/']) }
          : tool === 'Edit' ? { file_path: `${cwd}/${f}`, old_string: '…', new_string: '…' } : tool === 'Write' ? { file_path: `${cwd}/${f}`, content: '(generated)' }
          : tool === 'Task' ? { description: 'search the codebase', subagent_type: 'Explore', prompt: '(synthetic)' } : { file_path: `${cwd}/${f}`, pattern: 'invoice' }
        if (tool === 'Edit' || tool === 'Write') files.add(f)
        content.push({ type: 'tool_use', id: toolId(), name: tool, input })
      } else content.push({ type: 'text', text: '(synthetic) Done: the change is in place and the tests pass.' })
      push({ type: 'assistant', message: { id: msgId(), model, role: 'assistant', type: 'message', content, stop_reason: last ? 'end_turn' : 'tool_use', usage } })
      if (tool) {
        t += tool === 'Bash' ? lognormal(6e3, 1.1) : lognormal(400, 0.6)
        const errP = { Bash: optimized ? 0.05 : 0.09, Edit: 0.03, Write: 0.01 }[tool] ?? 0.005
        const isErr = rnd() < errP
        push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: content[0].id, content: isErr ? (tool === 'Edit' ? 'String to replace not found in file.' : 'Exit code 1\nFAILED tests (synthetic)') : '(synthetic tool output)', ...(isErr ? { is_error: true } : {}) }] } })
      }
    }
    if (!scripted && rnd() < 0.035) push({ type: 'user', message: { role: 'user', content: '[Request interrupted by user]' } })
    push({ type: 'system', subtype: 'turn_duration', durationMs: Math.round(t - turnStart), messageCount: steps * 2 })
    lastEnd = t
  }
  return { lines, end: lastEnd, cwd, model, files: [...files] }
}

// ---------------------------------------------------------------- triage (Jev's classes, priced)
const METHODS = [
  { id: 'route', title: 'Model routing', axis: 'capability', knob: '--model sonnet | haiku', catalog: 'route-cheaper-frontier', label: 'priced' },
  { id: 'side-calls', title: 'Subagents on a small model', axis: 'delegation', knob: 'CLAUDE_CODE_SUBAGENT_MODEL=haiku', catalog: 'litellm-route-side-calls', label: 'priced' },
  { id: 'context', title: 'Context compaction / split', axis: 'context', knob: '--autocompact <tokens> · /clear between tasks', catalog: 'context-compaction', label: 'guess' },
  { id: 'effort', title: 'Lower reasoning effort', axis: 'reasoning', knob: '--effort medium', catalog: 'effort-medium', label: 'guess' },
  { id: 'batch', title: 'Defer to batch', axis: 'deferral', knob: 'claude -p headless + Batch API', catalog: null, label: 'priced ceiling · guess floor' },
  { id: 'fast-mode', title: 'Fast mode (spend)', axis: 'urgency', knob: '/fast', catalog: null, label: 'priced — spend' },
]
function triageRecord(s, meta) {
  const P = PROJECTS[meta.project] ?? PROJECTS.api
  const capability = meta.project === 'extractor' || meta.project === 'agents' ? (rnd() < 0.7 ? 'frontier' : 'mid') : P.kind === 'doc' || P.kind === 'explore' ? 'small' : meta.project === 'infra' ? 'mid' : rnd() < 0.55 ? 'mid' : 'frontier'
  const labels = {
    urgency: meta.scripted ? 'whenever' : pick(['blocking-now', 'blocking-now', 'same-day']),
    latency: meta.scripted ? 'walks-away' : pick(['watches', 'checks-in', 'checks-in']),
    deferral: meta.scripted ? 'can-wait' : pick(['run-now', 'run-now', 'later-today']),
    capability, context: s.ctxPeak > 150e3 || s.humanPrompts > 8 ? 'separable' : 'continuous',
  }
  const confidence = Object.fromEntries(Object.keys(labels).map((k) => [k, +between(0.62, 0.97).toFixed(2)]))
  const cacheShare = s.cacheReadTokens * 0.1 / Math.max(1, s.cacheReadTokens * 0.1 + s.cacheWriteTokens * 1.25 + s.freshInTokens + s.outTokens * 5)
  const task = (s.toolCounts?.Task ?? 0) > 0
  const m = (id, unlocked, pct, score, extra = {}) => {
    const saving = +(s.cost * pct / 100).toFixed(4)
    return { ...METHODS.find((x) => x.id === id), score: unlocked ? score : 0, unlocked, saving, savingFloor: null, pct: +pct.toFixed(1), expected: unlocked ? +(saving * score).toFixed(4) : 0, note: '', ...extra }
  }
  const methods = [
    m('route', capability !== 'frontier', capability === 'small' ? between(55, 62) : between(38, 46), confidence.capability, { note: capability === 'small' ? 'to Haiku' : 'to Sonnet' }),
    m('side-calls', task, task ? between(5, 12) : 0, 0.8, { note: task ? 'subagent requests found' : 'no subagent requests' }),
    m('context', labels.context === 'separable', between(18, 34), confidence.context, { note: labels.context === 'separable' ? 'split: /clear between tasks' : 'one thread' }),
    m('effort', capability !== 'frontier', between(6, 14), 0.55, { note: 'thinking share ' + Math.round(100 * s.thinkingTokens / Math.max(1, s.outTokens)) + '%' }),
    m('batch', labels.deferral === 'can-wait', 50, 0.5, { savingFloor: +(s.cost * (cacheShare > 0.4 ? -1.2 : 0.3)).toFixed(4), note: `cache reads are ${Math.round(cacheShare * 100)}% of cost` }),
    { ...m('fast-mode', false, -100, 0), saving: -s.cost, note: 'doubles the price for faster replies' },
  ]
  const un = methods.filter((x) => x.unlocked && x.saving > 0)
  // levers overlap: their savings compound on what is left, never add
  const best = s.cost * (1 - un.reduce((r, x) => r * (1 - x.pct / 100), 1))
  const expected = s.cost * (1 - un.reduce((r, x) => r * (1 - (x.pct / 100) * x.score), 1))
  const worst = Math.min(best, ...un.map((x) => x.savingFloor ?? x.saving))
  const started = new Date(s.startedAt)
  return {
    session: s.id, key: `${s.startedAt.slice(0, 19)}|~/tallyfox/${meta.project}`, project: `tallyfox/${meta.project}`, kind: meta.kindLabel,
    entry: meta.scripted ? 'headless script' : 'interactive terminal', started: started.toUTCString().slice(0, 3) + ' ' + s.startedAt.slice(11, 16),
    requests: s.turns, ctxMedian: s.ctxMedian, ctxMax: s.ctxPeak, cost: s.cost, cacheRead: +(s.cacheReadTokens * 0.4 / 1e6).toFixed(4), model: s.model.replace(/^claude-/, ''),
    labels, confidence, probabilities: {}, outcome: 'ok', best: +best.toFixed(4), worst: +worst.toFixed(4), expected: +expected.toFixed(4),
    levers: un.map((x) => x.id), fastModeSpend: 0, claudeCode: null,
    signals: { files_touched: meta.files.length + 2, lines_changed: Math.round(lognormal(180, 0.9)), files_edited_3plus_times: Math.floor(rnd() * 2), test_runs: Math.round(lognormal(3, 0.6)), test_runs_failed: Math.floor(rnd() * 2), tool_errors: meta.toolErrors, git_commits: Math.floor(rnd() * 3) },
    methods, synthetic: true,
  }
}

// ---------------------------------------------------------------- build
export async function build(out = DEFAULT_OUT, { log = console.log } = {}) {
  // only ever replaces a folder this script made
  if (fs.existsSync(out) && fs.readdirSync(out).length && !fs.existsSync(path.join(out, 'SYNTHETIC.md'))) throw new Error(`${out} exists and is not a demo folder; refusing to replace it`)
  fs.rmSync(out, { recursive: true, force: true })
  const projDir = path.join(out, 'projects'), home = path.join(out, 'home')
  fs.mkdirSync(projDir, { recursive: true }); fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(out, 'SYNTHETIC.md'), `# ${COMPANY} — synthetic demo data (building)\n`)
  process.env.OPT_HOME = home
  process.env.OPT_PROJECTS_DIR = projDir
  const { processTranscript } = await import('../lib/sessions-index.mjs')

  // ---- sessions, day by day
  const sessions = []
  for (let d = START; d < NOW - 3600e3; d += DAY) {
    const dow = new Date(d).getUTCDay()
    const n = Math.round((dow === 0 || dow === 6 ? 0.25 : 1) * perDay(d) * between(0.6, 1.4))
    for (let i = 0; i < n; i++) {
      const start = d + (7 + between(0, 11)) * 3600e3 + between(0, 3600e3)
      if (start > NOW - 1800e3) continue
      const scripted = rnd() < 0.24
      let project, intent
      if (scripted) [project, intent] = pick(SCRIPTED)
      else { project = weighted(Object.entries(PROJECTS).map(([k, v]) => [k, v.weight])); intent = pick(PROJECTS[project].intents) }
      sessions.push({ sid: uuid(), project, intent, start, scripted, optimized: rnd() < optimizedShare(start) })
    }
  }
  const records = []
  for (const s of sessions) {
    const sim = simulate(s)
    const dir = path.join(projDir, sim.cwd.replace(/[/.]/g, '-'))
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${s.sid}.jsonl`)
    fs.writeFileSync(file, sim.lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    fs.utimesSync(file, new Date(sim.end), new Date(sim.end))
    const rec = processTranscript(file)
    if (rec) records.push({ rec, meta: { ...s, cwd: sim.cwd, files: sim.files, toolErrors: sim.lines.filter((l) => l.message?.content?.[0]?.is_error).length,
      kindLabel: s.scripted ? 'ci-automation' : { api: 'backend-service', web: 'web-frontend', extractor: 'ml-pipeline', agents: 'agent-tooling', infra: 'infrastructure', data: 'analytics', docs: 'documentation' }[s.project] } })
  }
  log(`  ${records.length} sessions, ${new Date(START).toISOString().slice(0, 10)} → ${new Date(NOW).toISOString().slice(0, 10)}, $${records.reduce((a, r) => a + r.rec.cost, 0).toFixed(0)} at list prices`)

  // ---- Triage, as of 1 September: July and August sessions worth classifying
  const results = path.join(home, 'results'); fs.mkdirSync(results, { recursive: true })
  const triaged = records.filter(({ rec }) => Date.parse(rec.startedAt) >= Date.UTC(2026, 6, 1) && Date.parse(rec.startedAt) < TRIAGE_AT && rec.cost >= 0.5)
  const tri = { generatedAt: new Date(TRIAGE_AT).toISOString(), synthetic: true,
    classifier: { arm: 'jev-C1', model: 'jev-1.13.0', jevRequested: 'jev-C1', outcomes: { ok: triaged.length } },
    methods: METHODS, total: +triaged.reduce((a, r) => a + r.rec.cost, 0).toFixed(1), rerunExperiment: 'route-cheaper-frontier',
    sessions: triaged.map(({ rec, meta }) => triageRecord(rec, meta)) }
  fs.writeFileSync(path.join(results, 'triage.json'), JSON.stringify(tri, null, 1))
  log(`  Triage: ${tri.sessions.length} sessions classified, $${tri.total} triaged, $${tri.sessions.reduce((a, s) => a + s.expected, 0).toFixed(0)} expected saving`)

  // ---- the sessions run in optimize mode after the rollout; the hub prices what they saved from the audited comparisons
  const inOpt = records.filter(({ meta }) => meta.optimized)
  fs.writeFileSync(path.join(results, 'optimize-mode.jsonl'), inOpt.map(({ rec, meta }) => JSON.stringify({ sid: rec.id, project: meta.cwd, at: rec.startedAt, synthetic: true })).join('\n') + '\n')
  log(`  optimize mode: ${inOpt.length} sessions since ${new Date(ROLLOUT).toISOString().slice(0, 10)}`)

  // ---- experiments on the costliest triaged sessions (sandbox replays, judged blind)
  const EXP = [
    ['context-compaction', 'Context compaction', { compaction: true }, 0.58, 0],
    ['effort-medium', 'Medium reasoning effort', { effort: 'medium' }, 0.74, -1],
    ['litellm-route-side-calls', 'Side calls on a small model', {}, 0.81, 0],
    ['route-cheaper-frontier', 'Route to a cheaper frontier model', { model: 'sonnet46' }, 0.47, -9],
    ['terse-context', 'Terse working rules', {}, 0.83, 1],
    ['route-cheaper-frontier', 'Route to a cheaper frontier model', { model: 'sonnet46' }, 0.52, -1],
  ]
  const top = [...triaged].sort((a, b) => b.rec.cost - a.rec.cost).slice(0, EXP.length)
  const CRIT = ['meets_the_request', 'correctness', 'completeness', 'code_quality', 'tests', 'contains_no_new_risk']
  top.forEach(({ rec }, i) => {
    const [exp, title, arm, ratio, dq] = EXP[i]
    const at = Date.UTC(2026, 8, 3 + i * 2, 10 + i)
    const dir = path.join(results, `exprun-${rec.id.slice(0, 8)}-${exp}-${new Date(at).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}`)
    fs.mkdirSync(dir, { recursive: true })
    const baseCost = +between(0.9, 3.2).toFixed(4), baseTurns = Math.round(between(9, 22))
    const scoreB = Object.fromEntries(CRIT.map((c) => [c, Math.round(between(7, 9))]))
    const scoreE = Object.fromEntries(CRIT.map((c, k) => [c, Math.max(1, Math.min(10, scoreB[c] + (k < Math.abs(dq) ? Math.sign(dq) * (dq < -3 ? 2 : 1) : 0)))]))
    const tot = (o) => Object.values(o).reduce((a, b) => a + b, 0)
    const grid = [{ label: 'Baseline', armId: 'baseline', experimentId: 'baseline', role: 'baseline', model: 'opus45', compaction: false },
      { label: title, armId: 'exp1', experimentId: exp, role: 'optimized', model: arm.model ?? 'opus45', compaction: !!arm.compaction, effort: arm.effort ?? null }]
    const res = (g, cost, turns) => ({ ...g, modelLabel: g.model === 'sonnet46' ? 'Claude Sonnet 4.6' : 'Claude Opus 4.5', secs: Math.round(turns * between(5, 9)), turns, cost, isError: false, exitCode: 0, artifacts: ['src/changes.patch', 'tests/test_added.py'], err: '' })
    const win = tot(scoreE) >= tot(scoreB) - 1
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
      run: path.basename(dir), kind: 'experiment', experiment: exp, session: rec.id, goal: 'cost', intent: rec.intent, originalCost: rec.cost, originalModel: rec.model,
      phase: 'done', startedAt: new Date(at).toISOString(), finishedAt: new Date(at + 6 * 60e3).toISOString(), synthetic: true,
      plan: { rationale: `${title} on a ${triaged.find((x) => x.rec.id === rec.id)?.meta.kindLabel} session`, experiment: exp, hypothesis: 'Same result for less: the judge decides quality, cost decides the rest.',
        gate: 'judge score must not drop more than 1 point out of 10 against baseline', risk: exp.startsWith('route') ? 'Accuracy. This is the lever the gate exists for.' : 'Low.', grid },
      results: [res(grid[0], baseCost, baseTurns), res(grid[1], +(baseCost * ratio).toFixed(4), Math.max(3, Math.round(baseTurns * between(0.8, 1.05))))],
      verdict: { rubric: CRIT, scores: { baseline: scoreB, exp1: scoreE }, totals: { baseline: tot(scoreB), exp1: tot(scoreE) },
        why: win ? `Both submissions make the requested change and pass the tests; the ${title.toLowerCase()} arm is as complete.` : 'The cheaper arm misses the multi-page case and adds no test for it.',
        winner: win ? title : 'Baseline', winnerArm: win ? 'exp1' : 'baseline', margin: `${Math.abs(tot(scoreE) - tot(scoreB))} points`, presentedFirst: 'baseline', best: win ? 1 : 0, configs: ['Baseline', title] },
      totalCost: +(baseCost * (1 + ratio)).toFixed(4),
    }, null, 1))
  })
  log(`  ${top.length} experiments, judged blind`)

  await claudeRuns(out, home, records)
  telemetry(home, records)
  fs.writeFileSync(path.join(out, 'claude-settings.json'), JSON.stringify({ env: {} }, null, 2))
  fs.writeFileSync(path.join(out, 'SYNTHETIC.md'), `# ${COMPANY} — synthetic demo data\n\nGenerated by tools/demo-startup.mjs on ${new Date().toISOString()} from a fixed seed. ${COMPANY} is a fictional company; no file here comes from a real session.\n`)
  return { out, sessions: records.length }
}

// ---------------------------------------------------------------- opt claude -p runs, audited
const PLACEHOLDER = 'sk-ant-oat01-opthub-gateway-placeholder-not-a-real-token-0000000000'
const INIT_TOOLS = ['Bash', 'Edit', 'Read', 'Write', 'Grep', 'Glob', 'Task', 'TodoWrite', 'ToolSearch', 'WebFetch', 'WebSearch', 'Skill']
async function claudeRuns(out, home, records) {
  seed = 0x5eed03   // its own seed: the comparisons do not shift when the company's size does
  const { AuditLog } = await import('../lib/ult/audit.mjs')
  const { appendEntry } = await import('../lib/task-audit.mjs')
  // the demo's own trail, by path: never the module's, which a parent process may have pointed at real state
  const AUDIT_FILE = path.join(home, 'audit', 'tasks.jsonl')
  const { auditClaims, armEvidence } = await import('../lib/claims.mjs')
  const { LEAN_RULES } = await import('../lib/claude-profile.mjs')
  const { projectKey } = await import('../lib/ult/context-store.mjs')
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'ult.default.json'), 'utf8'))
  const price = (m) => cfg.prices[m]
  const runsRoot = path.join(home, 'sandbox-out'); fs.mkdirSync(runsRoot, { recursive: true })
  // [project, level, task, saving on the main thread, side calls moved, check passes (opt), day]
  const PLAN = [
    ['api', 'balanced', 'Fix the reconciliation job so partial payments are counted once; the tests in tests/test_reconcile.py fail.', 0.19, 2, 3, Date.UTC(2026, 8, 16, 14)],
    ['web', 'balanced', 'Make the invoice table filter debounce input and stop re-rendering every row; keep the existing tests green.', 0.23, 1, 3, Date.UTC(2026, 8, 22, 11)],
    ['api', 'aggressive', 'Add idempotency keys to the payment webhook handler, with tests for a replayed webhook.', 0.31, 3, 3, Date.UTC(2026, 9, 1, 15)],
    ['extractor', 'aggressive', 'Fix line-item extraction on multi-page PDFs; the eval set in tests/fixtures must pass.', 0.36, 2, 2, Date.UTC(2026, 9, 6, 10)],
    ['agents', 'balanced', 'Make the collections agent idempotent when the webhook retries; add an eval for it.', 0.27, 4, 3, Date.UTC(2026, 9, 12, 16)],
    ['docs', 'guarded', 'Update docs/api/invoices.md for the overdue endpoint from the router code.', 0.41, 3, 3, Date.UTC(2026, 9, 17, 9)],
  ]
  const profiles = {}
  for (const [project, level, taskText, cut, moved, optPass, at] of PLAN) {
    const id = `cp-${new Date(at).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${sha(project + at).slice(0, 4)}`
    const runDir = path.join(runsRoot, id); fs.mkdirSync(runDir, { recursive: true })
    const projectDir = `${HOME}/tallyfox/${project}`
    const taskId = `claude-p-${new Date(at).toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${sha(id).slice(0, 6)}`
    const ts = (dt) => new Date(at + dt).toISOString()
    const flags = level === 'guarded' ? [] : ['--effort', level === 'balanced' ? 'medium' : 'low']
    appendEntry({ task: taskId, kind: 'claude-p', event: 'start', ts: ts(0), run: id, project: `~/tallyfox/${project}`, task_sha256: sha(taskText), task_chars: taskText.length, level, flags, rules_sha256: sha(LEAN_RULES), skills: [], compare: true, repeats: 3, check: 'check.py', auth: 'oauth', synthetic: true }, AUDIT_FILE)
    const arms = []
    for (const side of ['optimized', 'baseline']) for (let r = 1; r <= 3; r++) {
      const label = `${side === 'optimized' ? 'optimized' : 'plain'}-${r}`
      const dir = path.join(runDir, label); fs.mkdirSync(path.join(dir, 'check'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'task.md'), taskText)
      const opt = side === 'optimized'
      const n = Math.round(between(9, 16) * (opt ? 0.9 : 1))
      const ev = [{ type: 'system', subtype: 'init', model: 'claude-opus-5-5', tools: INIT_TOOLS, skills: ['verify', 'code-review'], claude_code_version: '2.1.304', synthetic: true }]
      const totals = { in: 0, out: 0, cr: 0, cw: 0 }, router = []
      let ctx = 12400 + (opt ? 140 : 0)
      for (let k = 0; k < n; k++) {
        const out = Math.round(lognormal(opt ? 210 : 300, 0.5) * (opt ? 1 - cut * 0.6 : 1))
        const cw = k === 0 ? 3600 : Math.round(lognormal(opt ? 900 : 1300, 0.5))
        const usage = { input_tokens: 3, output_tokens: out, cache_read_input_tokens: ctx, cache_creation_input_tokens: cw, cache_creation: { ephemeral_1h_input_tokens: cw, ephemeral_5m_input_tokens: 0 } }
        ev.push({ type: 'assistant', message: { id: msgId(), model: 'claude-opus-5-5', usage, content: [{ type: 'tool_use', id: toolId(), name: pick(['Bash', 'Edit', 'Read']), input: {} }] } })
        totals.in += 3; totals.out += out; totals.cr += ctx; totals.cw += cw
        if (opt) {
          // the gateway's price for this request: the same table the claims audit re-prices with
          const [pi, po] = price('claude-opus-5-5')
          const c = (3 * pi + ctx * pi * 0.1 + cw * pi * 2 + out * po) / 1e6
          router.push({ kind: 'request', class: 'coding/debug', source: 'rules', confidence: 0.8, decision: 'keep', acted: false, target: 'claude-opus-5-5', usage, cost_usd: c, counterfactual_usd: c, status: 200 })
        }
        ctx += cw + out
      }
      // Claude Code's own small-model side calls (titles, summaries); the gateway moves some off Haiku
      const side_ = Math.round(between(3, 6))
      const hu = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
      for (let k = 0; k < side_; k++) {
        const inp = Math.round(between(900, 2400)), o = Math.round(between(40, 160))
        hu.inputTokens += inp; hu.outputTokens += o
        if (opt) {
          const [hi, ho] = price('claude-haiku-4-5'), cf = (inp * hi + o * ho) / 1e6
          const mv = k < moved
          router.push({ kind: 'request', class: 'background/utility', source: 'rules', confidence: 0.9, decision: mv ? 'local' : 'keep', acted: mv, target: mv ? 'local:qwen2.5-coder:1.5b' : 'claude-haiku-4-5',
            usage: { input_tokens: inp, output_tokens: o }, cost_usd: mv ? 0 : cf, counterfactual_usd: cf, status: 200 })
        }
      }
      const pass = !opt || r <= optPass
      ev.push({ type: 'result', subtype: 'success', is_error: false, num_turns: n, duration_ms: Math.round(n * between(3200, 4600) * (opt ? 0.9 : 1)), result: '(synthetic) Fixed, tests pass.',
        usage: { input_tokens: totals.in, output_tokens: totals.out, cache_read_input_tokens: totals.cr, cache_creation_input_tokens: totals.cw, cache_creation: { ephemeral_1h_input_tokens: totals.cw, ephemeral_5m_input_tokens: 0 } },
        modelUsage: { 'claude-opus-5-5': { inputTokens: totals.in, outputTokens: totals.out, cacheReadInputTokens: totals.cr, cacheCreationInputTokens: totals.cw }, 'claude-haiku-4-5': hu }, total_cost_usd: 0 })
      fs.writeFileSync(path.join(dir, 'events.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n')
      fs.writeFileSync(path.join(dir, 'check', 'check_code'), pass ? '0\n' : '1\n')
      if (opt) {
        fs.writeFileSync(path.join(dir, 'agent-key.sha256'), sha(PLACEHOLDER) + '  -\n')
        const log = new AuditLog(path.join(dir, 'router', 'audit.jsonl'))
        for (const e of router) log.append({ ...e, path: '/v1/messages', synthetic: true })
      }
      appendEntry({ task: taskId, kind: 'claude-p', event: 'run-start', ts: ts(30e3), run: label, side }, AUDIT_FILE)
      arms.push({ label, side, check: pass ? 'pass' : 'fail' })
    }
    const run = { run: id, kind: 'claude-p', task_id: taskId, started: ts(0), seconds: Math.round(between(70, 130)), project: `~/tallyfox/${project}`, synthetic: true,
      task_sha256: sha(taskText), tree_sha256: sha(project + 'tree'), auth: 'oauth', placeholder_sha256: sha(PLACEHOLDER),
      profile: { level, flags, env: level === 'aggressive' ? { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-4-5' } : {}, rules_sha256: sha(LEAN_RULES), skills: [] },
      gateway: { config: '5c5de930581da832', local: 'qwen2.5-coder:1.5b' }, compare: true, repeats: 3,
      warmup: { prompt_sha256: sha('Reply with the single word: ready.'), cost_usd: { optimized: 0.031, baseline: 0.029 }, note: 'one turn per side before the measured runs; not in the comparison' },
      check: { name: 'check.py', sha256: sha(project + 'check') }, arms: [], verdict: null, profile_move: null }
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(run))
    // the numbers, read back the way the runner reads them
    const evd = arms.map((a) => ({ ...a, e: armEvidence(runDir, a) }))
    const med = (xs) => { const v = xs.sort((a, b) => a - b); return v[Math.floor((v.length - 1) / 2)] }
    const oc = med(evd.filter((a) => a.side === 'optimized').map((a) => a.e.cost)), bc = med(evd.filter((a) => a.side === 'baseline').map((a) => a.e.cost))
    const pct = (oc - bc) / bc * 100, passAll = optPass === 3
    run.arms = evd.map((a) => ({ label: a.label, side: a.side, exit: 0, timed_out: false, is_error: false, model: 'claude-opus-5-5', turns: a.e.events.result.num_turns, cost_usd: a.e.cost, duration_ms: a.e.durationMs, check: a.check, files: ['~src (synthetic)'] }))
    run.verdict = !passAll ? { verdict: 'drop', reason: `fails the check the baseline passes (${optPass}/3 vs 3/3)` } : pct < 0 ? { verdict: 'keep', reason: `${Math.abs(pct).toFixed(0)}% cheaper, and passes the same check`, pct } : { verdict: 'drop', reason: 'not cheaper', pct }
    const p = (profiles[project] ??= { key: projectKey(projectDir), level, streak: 0, history: [] })
    const i = ['guarded', 'balanced', 'aggressive'].indexOf(level)
    const to = run.verdict.verdict === 'drop' ? ['guarded', 'balanced', 'aggressive'][Math.max(0, i - 1)] : p.streak + 1 >= 2 && i < 2 ? ['guarded', 'balanced', 'aggressive'][i + 1] : level
    run.profile_move = { from: level, to, why: run.verdict.verdict === 'drop' ? `${level} did worse than plain claude -p: back to ${to}` : to !== level ? `2 kept comparisons on ${level}: up to ${to}` : `kept (${p.streak + 1}/2 toward the next rung)` }
    p.history.push({ at: ts(0), run: id, level, verdict: run.verdict.verdict, cost: oc, base_cost: bc, check: passAll ? 'pass' : 'fail' })
    p.streak = run.verdict.verdict === 'keep' && to === level ? p.streak + 1 : 0
    p.level = to
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(run, null, 2))
    appendEntry({ task: taskId, kind: 'claude-p', event: 'end', ts: ts(run.seconds * 1000), verdict: run.verdict.verdict, cost_usd: +(oc * 3 + bc * 3).toFixed(4), runs: 6, failed: 0, level_to: to }, AUDIT_FILE)
    auditClaims(runDir, { trailFile: AUDIT_FILE })
  }
  const pdir = path.join(home, 'claude-profile'); fs.mkdirSync(pdir, { recursive: true })
  for (const p of Object.values(profiles)) fs.writeFileSync(path.join(pdir, `${p.key}.json`), JSON.stringify(p, null, 2))
}

// ---------------------------------------------------------------- Claude Code's OTEL, last 21 days
function telemetry(home, records) {
  const dir = path.join(home, 'otel'); fs.mkdirSync(dir, { recursive: true })
  const files = {}
  // kept as objects until the end: an interaction span is written when it opens and closed later
  const put = (r) => { const f = new Date(r.t).toISOString().slice(0, 10); (files[f] ??= []).push(r) }
  const hex = (n) => [...Array(n)].map(() => Math.floor(rnd() * 16).toString(16)).join('')
  for (const { rec, meta } of records) {
    const t0 = Date.parse(rec.startedAt)
    if (t0 < NOW - 21 * DAY) continue
    const file = path.join(process.env.OPT_PROJECTS_DIR, meta.cwd.replace(/[/.]/g, '-'), `${rec.id}.jsonl`)
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const sid = rec.id, res = { 'session.id': sid, 'service.name': 'claude-code', synthetic: true }
    let inter = null, trace = null, last = null
    for (const l of lines) {
      const t = Date.parse(l.timestamp)
      if (l.type === 'user' && typeof l.message?.content === 'string' && !l.message.content.startsWith('[')) {
        trace = hex(32); inter = { k: 'span', t, end: t, name: 'claude_code.interaction', trace, id: hex(16), parent: null, a: { ...res }, err: false }
        put(inter); put({ k: 'log', t, name: 'claude_code.user_prompt', a: { ...res, prompt_length: l.message.content.length } })
      } else if (l.type === 'assistant' && inter && !l.isApiErrorMessage) {
        const u = l.message.usage, start = last ?? t - 4000
        put({ k: 'span', t: start, end: t, name: 'claude_code.llm_request', trace, id: hex(16), parent: inter.id, a: { ...res, model: l.message.model, input_tokens: u.input_tokens, output_tokens: u.output_tokens,
          cache_read_tokens: u.cache_read_input_tokens, cache_creation_tokens: u.cache_creation_input_tokens, ttft_ms: Math.round(between(600, 2600)), attempt: 1, success: true, request_id: 'req_' + hex(20) } })
        const tu = l.message.content.find((b) => b.type === 'tool_use')
        if (tu) {
          const wait = tu.name === 'Bash' && rnd() < 0.25 ? Math.round(lognormal(9000, 0.9)) : 0
          const ts = hex(16), dur = Math.round(lognormal(tu.name === 'Bash' ? 5000 : 300, 0.9)) + wait
          put({ k: 'span', t, end: t + dur, name: 'claude_code.tool', trace, id: ts, parent: inter.id, a: { ...res, tool_name: tu.name } })
          if (wait) {
            put({ k: 'span', t, end: t + wait, name: 'claude_code.tool.blocked_on_user', trace, id: hex(16), parent: ts, a: { ...res, duration_ms: wait, decision: 'accept', source: 'user_temporary' } })
            put({ k: 'log', t: t + wait, name: 'claude_code.tool_decision', a: { ...res, tool_name: tu.name, decision: 'accept', source: 'user_temporary' } })
          }
        }
        inter.end = t; last = t
      } else if (l.type === 'system' && l.subtype === 'api_error') {
        put({ k: 'log', t, name: 'claude_code.api_error', a: { ...res, status_code: l.error.message.slice(0, 3), attempt: l.retryAttempt } })
      } else if (l.type === 'system' && l.subtype === 'turn_duration' && inter) {
        inter.end = t; inter.a['interaction.duration_ms'] = t - inter.t; last = null
      } else if (l.type === 'system' && l.subtype === 'compact_boundary') put({ k: 'log', t, name: 'claude_code.compaction', a: { ...res } })
    }
    put({ k: 'metric', t: Date.parse(rec.endedAt), name: 'claude_code.active_time.total', v: Math.round(rec.durationMin * 60 * 0.35), a: { ...res, type: 'cli' } })
    put({ k: 'metric', t: Date.parse(rec.endedAt), name: 'claude_code.active_time.total', v: Math.round(rec.durationMin * 60 * 0.08), a: { ...res, type: 'user' } })
    put({ k: 'metric', t: Date.parse(rec.endedAt), name: 'claude_code.lines_of_code.count', v: Math.round(lognormal(120, 0.8)), a: { ...res, type: 'added' } })
    put({ k: 'metric', t: Date.parse(rec.endedAt), name: 'claude_code.lines_of_code.count', v: Math.round(lognormal(40, 0.8)), a: { ...res, type: 'removed' } })
  }
  for (const [f, rows] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${f}.ndjson`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await build(process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUT)
  console.log(`  ${COMPANY} demo written to ${r.out}`)
}
