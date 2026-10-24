/**
 * Optimization potential for one session, from the Optimization Atlas
 * (docs/atlas/ at the repo root: engine.js + scenarios.json).
 *
 * The atlas prices every optimization scenario against a workload. Here the workload is the
 * session itself, and every input says where it came from:
 *
 *   measured    this session's transcript: requests, context, output, thinking, cache hit, model
 *   classified  Jev's classes for the session (Hub → Triage): could a mid model do it, was anyone
 *               waiting, did it mix unrelated tasks, was it urgent
 *   default     the atlas default, where nothing measures it for one session
 *
 * The engine's cost for that workload is anchored to the session's real cost, so a lever's dollars
 * are dollars of this session. Levers overlap: the session's headline is one lever — the safest by
 * worst case — never a sum.
 *
 * Returns the shape lib/potential.mjs returned (band, lo, hi, usdLo, usdHi, methods, basis,
 * gateNote), so the Sessions tab keeps working, plus `atlas` with the workload and every lever.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { REPO_ROOT } from './state.mjs'

const ATLAS = path.join(REPO_ROOT, 'docs', 'atlas')
const require = createRequire(import.meta.url)
const E = require(path.join(ATLAS, 'engine.js'))
const SCENARIOS = JSON.parse(fs.readFileSync(path.join(ATLAS, 'scenarios.json'), 'utf8')).scenarios
/** List price for one model id, $/1M tokens — the one price table the hub uses. */
export function priceFor(model) {
  const m = String(model || '')
  if (!m.startsWith('claude-')) return { in: 3, out: 15 }   // non-Claude and <synthetic>: no published Claude rate
  return E.PRICES[MODEL(m)]
}
export const ATLAS_URL = 'https://claude.ai/artifact/4MtoY99tPqUrxfxNEYJ2u7'
// Two sandbox arms of a typical session: below this, an experiment costs more than it could save.
const EXPERIMENT_COST = Number(process.env.OPT_EXPERIMENT_COST_USD ?? 1.0)

const MODEL = (m) => {
  m = String(m || '')
  if (m.startsWith('claude-haiku')) return 'claude-haiku-4-5'
  if (m.startsWith('claude-sonnet')) return 'claude-sonnet-5'
  if (m === 'claude-opus-5-5') return 'claude-opus-5-5'
  if (m.startsWith('claude-fable')) return 'claude-fable-5-1'
  return 'claude-opus-5'   // Opus 5 and Opus 4.8 share a price
}

/** The atlas workload for one session, and where each input came from. */
export function workloadFor(s, tri) {
  const d = E.defaults(), src = {}
  const set = (k, v, how) => { d[k] = v; src[k] = how }
  const req = Math.max(1, s.ctxRequests || s.turns || 1)
  set('devs', 1, 'measured'); set('sessions', 1, 'measured'); set('days', 1, 'measured')
  set('requests', req, 'measured')
  set('model', MODEL(s.model), 'measured')
  set('ctx', Math.max(1000, Math.round((s.inTokens || 0) / req)), 'measured')
  set('out', Math.max(50, Math.round((s.outTokens || 0) / req)), 'measured')
  set('think', s.outTokens ? Math.round(100 * (s.thinkingTokens || 0) / s.outTokens) : 0, 'measured')
  set('hit', Math.round(1000 * (s.cacheHit || 0)) / 10, 'measured')
  d.schema = Math.min(d.schema, Math.round(d.ctx * 0.5)); src.schema = 'default'
  set('sandbox', 0, 'measured'); set('idle', 0, 'measured'); set('selfhost', 0, 'measured')
  const L = tri?.labels
  if (L) {
    const cap = L.capability
    if (cap === 'mid' || cap === 'small') set('simple', 100, `classified: Jev said ${cap}`)
    else if (cap === 'frontier') set('simple', 0, 'classified: Jev said frontier')
    if (L.latency === 'unattended') set('unattended', 100, 'classified: unattended')
    else if (L.latency === 'interactive' || L.deferral === 'run-now') set('unattended', 0, `classified: ${L.latency === 'interactive' ? 'interactive' : 'run-now'}`)
    else if (L.latency === 'checks-in' && ['within-hours', 'overnight'].includes(L.deferral)) set('unattended', 100, `classified: checks-in, ${L.deferral}`)
    if (L.context === 'separable') set('separable', 100, 'classified: separable')
    else if (L.context === 'continuous' || L.context === 'short') set('separable', 0, `classified: ${L.context}`)
    if (L.urgency) set('urgent', L.urgency === 'blocking-now' ? 100 : 0, `classified: ${L.urgency}`)
  }
  for (const k of Object.keys(d)) src[k] = src[k] ?? 'default'
  return { workload: d, source: src }
}

export function atlasPotential(s, tri) {
  const cost = s.cost || 0
  const { workload, source } = workloadFor(s, tri)
  const b = E.baseline(workload)
  const k = b.llm > 0 ? cost / b.llm : 0           // anchor the engine to what the session really cost
  const rows = E.evaluate(workload, SCENARIOS).map((r) => ({ ...r, worst: r.worst * k, best: r.best * k }))
  const levers = rows.filter((r) => r.kind === 'saving' && r.best > 0.005).sort((a, b) => b.worst - a.worst || b.best - a.best)
  const trusted = levers.filter((r) => (r.evidence === 'priced' || r.evidence === 'measured') && r.worst > 0)
  const head = trusted[0] || levers[0] || null
  const pct = (v) => (cost > 0 ? (100 * v) / cost : 0)
  const lo = head ? Math.max(0, pct(head.worst)) : 0, hi = head ? pct(head.best) : 0
  const band = !head || cost < 0.05 ? 'none' : head.best < EXPERIMENT_COST ? 'below-gate' : hi >= 30 ? 'high' : hi >= 10 ? 'medium' : 'low'
  const measured = Object.entries(source).filter(([, v]) => v === 'measured').map(([k]) => k)
  const classified = Object.entries(source).filter(([, v]) => v.startsWith('classified')).map(([k, v]) => `${k} (${v.slice(12)})`)
  return {
    band, lo, hi, usdLo: head ? Math.max(0, head.worst) : 0, usdHi: head ? head.best : 0,
    head: head ? { id: head.id, name: head.name, evidence: head.evidence } : null,
    gateNote: band === 'below-gate' ? `The best lever saves at most $${head.best.toFixed(2)}; two sandbox arms cost about $${EXPERIMENT_COST.toFixed(2)}.` : null,
    methods: levers.slice(0, 6).map((r) => ({
      id: r.id, title: r.name, kind: r.evidence === 'priced' || r.evidence === 'measured' ? 'priced' : 'guess', evidence: r.evidence,
      lo: pct(r.worst), hi: pct(r.best), usdLo: r.worst, usdHi: r.best, risk: r.risk, why: r.basis, params: r.params, caveat: r.caveat,
    })),
    basis: `Optimization Atlas, priced on this session: measured ${measured.filter((x) => !['devs', 'sessions', 'days', 'sandbox', 'idle', 'selfhost'].includes(x)).join(', ')}`
      + (classified.length ? `; from Jev's classes: ${classified.join(', ')}` : '; no Jev classes for this session, so the work mix uses atlas defaults')
      + '. Headline is the safest single lever by worst case; levers overlap and are never added.',
    atlas: { url: ATLAS_URL, workload, source, anchor: k },
  }
}
