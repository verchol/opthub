/**
 * The hub's landing page: what the last 30 days cost, where it went, and what could be saved —
 * each saving labelled by how much it is worth trusting.
 *
 *   measured   opt claude -p --compare on this machine, with the claims audit's verdict
 *   priced     the Optimization Atlas, priced on each session's own tokens (a ceiling, not a promise)
 *   guess      a stated basis, nothing measured yet
 *
 * Levers overlap, so their savings are never added together; each is shown on its own.
 */
import fs from 'node:fs'
import path from 'node:path'
import { STATE } from './state.mjs'
import { listClaudeRuns } from './claims.mjs'
import { outRoot } from './local-run.mjs'
import { modelsCatalog } from './models.mjs'
import { sessionErrors, errorsSummary, pctl } from './cc-errors.mjs'

const DAY = 864e5
const sum = (a) => a.reduce((x, y) => x + y, 0)
const median = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null }
const at = (s) => Date.parse(s.startedAt) || 0

/** What a lever asks the person to do: the command, or where in the hub. */
const HOW = {
  'effort-medium': 'opt claude -p "…" --compare  (the balanced rung)',
  'effort-low': 'opt claude -p "…" --compare --level aggressive',
  'route-cheaper-frontier': 'Optimize → Sessions: run it against a baseline on one session',
  'terse-context': 'opt claude -p "…" --compare  (lean rules are on in every rung)',
}

/**
 * @param {object} o
 * @param {object[]} o.sessions        the hub's session records (lib/watch.mjs)
 * @param {(s) => object} o.potentialOf the Atlas potential for one session
 * @param {object|null} o.behaviour    the Behaviour payload, when it is already cached (cold-cache cost)
 */
export async function overviewPayload({ sessions, potentialOf, behaviour = null, triage = null, days = 30, now = Date.now() }) {
  const cur = sessions.filter((s) => at(s) >= now - days * DAY)
  const prev = sessions.filter((s) => at(s) < now - days * DAY && at(s) >= now - 2 * days * DAY)
  const spend = sum(cur.map((s) => s.cost || 0)), prevSpend = sum(prev.map((s) => s.cost || 0))

  const group = (key) => {
    const g = {}
    for (const s of cur) { const k = key(s) || '—'; (g[k] ??= { key: k, cost: 0, sessions: 0 }); g[k].cost += s.cost || 0; g[k].sessions++ }
    return Object.values(g).sort((a, b) => b.cost - a.cost)
  }
  const byDay = Array.from({ length: days }, (_, i) => {
    const d0 = now - (days - i) * DAY
    return { day: new Date(d0 + DAY / 2).toISOString().slice(0, 10), cost: sum(cur.filter((s) => at(s) >= d0 && at(s) < d0 + DAY).map((s) => s.cost || 0)) }
  })
  const tok = (k) => sum(cur.map((s) => s[k] || 0))
  const cacheHit = tok('cacheReadTokens') / Math.max(1, tok('cacheReadTokens') + tok('cacheWriteTokens') + tok('freshInTokens'))

  // ---- opportunities: every session's Atlas levers, summed per lever
  const levers = {}
  for (const s of cur) {
    const p = potentialOf(s)
    for (const m of p?.methods ?? []) {
      const l = (levers[m.id] ??= { id: m.id, title: m.title, kind: m.kind, evidence: m.evidence, usdLo: 0, usdHi: 0, sessions: 0, risk: m.risk, why: m.why, caveat: m.caveat })
      l.usdLo += m.usdLo || 0; l.usdHi += m.usdHi || 0; l.sessions++
    }
  }
  const opportunities = Object.values(levers).filter((l) => l.usdHi > 0.5)
    .map((l) => ({ ...l, source: 'atlas', how: HOW[l.id] ?? 'Optimize → Sessions: pick a session and run it against its baseline' }))
    .sort((a, b) => b.usdLo - a.usdLo || b.usdHi - a.usdHi).slice(0, 6)

  if (behaviour?.kpi?.coldCost > 0.05) opportunities.push({
    id: 'cold-cache', title: 'Prompt cache re-written after idle', kind: 'priced', evidence: 'priced', source: 'behaviour',
    usdLo: behaviour.kpi.coldCost, usdHi: behaviour.kpi.coldCost, sessions: behaviour.kpi.cold,
    why: `${behaviour.kpi.cold} turns re-wrote the whole context after more than 5 minutes idle (Analytics → Behaviour, last ${behaviour.days} days).`,
    how: 'Analytics → Behaviour: which sessions, and when', risk: 'none: a habit, not a setting',
  })

  // ---- measured: opt claude -p comparisons on this machine, with their audits
  const allRuns = listClaudeRuns(outRoot(), 200), runs = allRuns.slice(0, 12)
  const compared = runs.filter((r) => r.compare && r.verdict)
  const proven = compared.find((r) => r.verdict.verdict === 'keep' && r.claims && r.claims.failed === 0)
  if (proven) opportunities.unshift({
    id: 'optimize-mode', title: `Optimize mode (${proven.level} profile) on ${proven.project.split('/').slice(-2).join('/')}`, kind: 'measured', evidence: 'measured', source: 'claude-p',
    pct: proven.verdict.pct, usdLo: null, usdHi: null, sessions: proven.repeats,
    why: `${Math.abs(proven.verdict.pct).toFixed(0)}% cheaper than plain claude -p on the same input, ${proven.claims.verified} claims verified, none failed (${proven.run}).`,
    how: 'opt claude -p "…" --compare', risk: proven.repeats < 3 ? 'n < 3: a direction, not a finding' : 'measured on one task: run it on yours',
  })

  let local = { up: false }
  try {
    const cat = await modelsCatalog()
    const o = cat.providers.find((p) => p.id === 'ollama')
    local = { up: o.status === 'ready', models: o.models.length, routerModel: cat.router.localModel, note: o.note }
  } catch {}

  return {
    days, at: now,
    months: withSaved(monthly(sessions, now), savedByMonth({ sessions, runs: allRuns, ledger: readLedger() })), triage: triageSaving(triage), errors: errors(sessions, now - days * DAY), leaders: leaders(cur, now - days * DAY),
    kpi: {
      sessions: cur.length, spend, prevSpend, deltaPct: prevSpend ? ((spend - prevSpend) / prevSpend) * 100 : null,
      perSession: median(cur.map((s) => s.cost || 0)), projects: new Set(cur.map((s) => s.cwd)).size,
      activeDays: new Set(cur.map((s) => (s.startedAt || '').slice(0, 10))).size, cacheHit,
      humanShare: cur.length ? cur.filter((s) => s.entry === 'cli').length / cur.length : 0,
    },
    byProject: group((s) => path.basename(s.cwd || '')).slice(0, 6),
    byModel: group((s) => s.model).slice(0, 5),
    byDay, opportunities, runs: compared.slice(0, 5), local,
  }
}

const family = (m = '') => (/opus/.test(m) ? 'opus' : /sonnet/.test(m) ? 'sonnet' : /haiku/.test(m) ? 'haiku' : /fable/.test(m) ? 'fable' : 'other')

/** Spend per calendar month, by model family; the current month projected from its days so far (a guess, labelled). */
export function monthly(sessions, now = Date.now(), n = 12) {
  const by = {}
  for (const s of sessions) {
    const m = (s.startedAt || '').slice(0, 7); if (!m) continue
    const r = (by[m] ??= { month: m, cost: 0, sessions: 0, byFamily: {} })
    r.cost += s.cost || 0; r.sessions++; r.byFamily[family(s.model)] = (r.byFamily[family(s.model)] ?? 0) + (s.cost || 0)
  }
  const d = new Date(now), cur = d.toISOString().slice(0, 7)
  const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(), elapsed = d.getUTCDate() - 1 + d.getUTCHours() / 24
  const months = Object.values(by).sort((a, b) => a.month.localeCompare(b.month)).slice(-n)
  const c = by[cur]
  if (c && elapsed >= 1) c.projected = (c.cost / elapsed) * dim
  const prev = months.filter((x) => x.month < cur).at(-1) ?? null
  return { months, current: c ?? { month: cur, cost: 0, sessions: 0, byFamily: {} }, previous: prev, total: sum(months.map((x) => x.cost)), daysElapsed: elapsed, daysInMonth: dim }
}

/** Sessions run in optimize mode, one JSON line each: { sid, project, at }. */
export const LEDGER = () => path.join(STATE, 'results', 'optimize-mode.jsonl')
export function readLedger(file = LEDGER()) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { return [] }
}

/**
 * What optimize mode saved, per month, in two kinds:
 *
 *   measured   opt claude -p --compare runs kept with every claim verified: plain minus optimized, per repeat
 *   estimated  work run in optimize mode with nothing beside it (opt claude -p without --compare, and the
 *              sessions in results/optimize-mode.jsonl): what it cost × r/(1−r), where r is the saving its
 *              project's audited comparisons measured, or the median of all of them when the project has
 *              none. A project whose latest comparison was dropped counts nothing.
 */
export function savedByMonth({ sessions, runs, ledger }) {
  const proj = (p) => path.basename(String(p ?? ''))
  const ok = runs.filter((r) => r.compare && r.verdict?.verdict === 'keep' && r.claims?.failed === 0 && r.plainCost > 0 && r.optCost != null)
  const cut = (r) => 1 - r.optCost / r.plainCost
  const last = {}
  for (const r of runs.filter((r) => r.compare && r.verdict).sort((a, b) => String(a.at).localeCompare(String(b.at)))) last[proj(r.project)] = r.verdict.verdict
  const byProject = {}
  for (const r of ok) (byProject[proj(r.project)] ??= []).push(cut(r))
  const fleet = median(ok.map(cut))
  const rate = (p) => (last[p] === 'drop' ? 0 : median(byProject[p] ?? []) ?? fleet ?? 0)
  const by = {}
  const row = (at) => { const m = String(at ?? '').slice(0, 7); return m ? (by[m] ??= { measured: 0, estimated: 0, sessions: 0, runs: 0 }) : null }
  const est = (cost, r) => (r > 0 && r < 0.95 ? cost * r / (1 - r) : 0)
  for (const r of ok) { const x = row(r.at); if (x) { x.measured += (r.plainCost - r.optCost) * (r.repeats || 1); x.runs++ } }
  for (const r of runs.filter((r) => !r.compare && r.optCost)) { const x = row(r.at); if (x) { x.estimated += est(r.optCost * (r.repeats || 1), rate(proj(r.project))); x.runs++ } }
  const bySid = new Map(sessions.map((s) => [s.id, s]))
  for (const l of ledger) {
    const s = bySid.get(l.sid), cost = s?.cost ?? l.cost
    const x = cost ? row(s?.startedAt ?? l.at) : null
    if (x) { x.estimated += est(cost, rate(proj(l.project ?? s?.cwd))); x.sessions++ }
  }
  return {
    by, fleet, comparisons: ok.length,
    rates: Object.fromEntries([...new Set([...Object.keys(byProject), ...Object.keys(last)])].map((p) => [p, { rate: rate(p), own: !!byProject[p], last: last[p] ?? null }])),
  }
}

/** The monthly spend with each month's saving beside it. */
export function withSaved(m, s) {
  // m.current is the same object as this month's row, so it carries the saving too
  for (const r of m.months) { const x = s.by[r.month]; if (x && x.measured + x.estimated > 0) r.saved = { ...x, total: x.measured + x.estimated } }
  return { ...m, saving: { fleet: s.fleet, comparisons: s.comparisons, rates: s.rates } }
}

/**
 * The Triage pass (results/triage.json: Jev's classes, each method priced per session), added up the
 * way the Triage tab adds it: potential = every unlocked method works; expected = score × saving.
 */
export function triageSaving(t) {
  if (!t?.sessions?.length) return null
  const S = t.sessions, cost = sum(S.map((s) => s.cost || 0))
  const best = sum(S.map((s) => s.best || 0)), expected = sum(S.map((s) => s.expected || 0))
  const risk = sum(S.map((s) => Math.max(0, -(s.worst || 0))))
  const methods = {}
  for (const s of S) for (const m of s.methods ?? []) {
    if (!m.unlocked) continue
    const r = (methods[m.id] ??= { id: m.id, title: m.title, label: m.label, knob: m.knob, saving: 0, expected: 0, sessions: 0 })
    r.saving += Math.max(0, m.saving || 0); r.expected += m.expected || 0; r.sessions++
  }
  const projects = {}
  for (const s of S) { const p = (projects[s.project] ??= { project: s.project, cost: 0, best: 0, expected: 0, sessions: 0 }); p.cost += s.cost || 0; p.best += s.best || 0; p.expected += s.expected || 0; p.sessions++ }
  return {
    generatedAt: t.generatedAt, classifier: t.classifier?.model ?? t.classifier?.arm ?? null, sessions: S.length, cost, best, expected, risk,
    methods: Object.values(methods).filter((m) => m.saving > 0.01).sort((a, b) => b.expected - a.expected || b.saving - a.saving).slice(0, 7),
    projects: Object.values(projects).sort((a, b) => b.best - a.best).slice(0, 5),
  }
}

/** Claude Code's errors in the window, from the transcripts, with the sessions they hit. */
function errors(all, sinceMs) {
  const by = sessionErrors(sinceMs)
  const t = errorsSummary(by)
  const name = Object.fromEntries(all.map((s) => [s.id, { intent: s.intent, project: path.basename(s.cwd || '') }]))
  t.worst = t.worst.map((w) => ({ ...w, ...(name[w.sid] ?? { intent: '', project: '' }) }))
  return t
}

/**
 * The sessions at or above the 95th percentile: by cost, and by turn latency (how long Claude took to
 * answer a prompt, from Claude Code's turn_duration records). Small n makes p95 the top values.
 */
function leaders(cur, sinceMs) {
  const turns = sessionErrors(sinceMs)   // cached per transcript: no second read
  const spend = sum(cur.map((s) => s.cost || 0))
  const row = (s) => ({ id: s.id, intent: s.intent, project: path.basename(s.cwd || ''), cost: s.cost || 0, durationMin: s.durationMin, turns: s.turns, model: s.model,
    turnP95: pctl(turns[s.id]?.turnMs ?? [], 0.95), turnN: turns[s.id]?.turnMs?.length ?? 0, startedAt: s.startedAt })
  const costP95 = pctl(cur.map((s) => s.cost || 0), 0.95) ?? 0
  const top = cur.filter((s) => s.cost > 0 && s.cost >= costP95).sort((a, b) => b.cost - a.cost)
  const timed = cur.map(row).filter((r) => r.turnN > 0).sort((a, b) => b.turnP95 - a.turnP95)
  const allTurns = timed.flatMap((r) => turns[r.id].turnMs)
  const latP95 = pctl(timed.map((r) => r.turnP95), 0.95)
  return {
    costP95, topCount: top.length, costShare: spend ? sum(top.map((s) => s.cost)) / spend : 0, byCost: top.slice(0, 8).map(row),
    latencyP95: latP95, turnMedian: pctl(allTurns, 0.5), turnP95All: pctl(allTurns, 0.95), sessionsWithTiming: timed.length, turnsTimed: allTurns.length,
    byLatency: timed.slice(0, 8).map((r) => ({ ...r, aboveP95: latP95 != null && r.turnP95 >= latP95 })),
  }
}
