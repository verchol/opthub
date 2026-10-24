/**
 * Goal → strategy. The user says what they want (cost, latency, balanced) and how much risk
 * they accept (temperature: conservative, balanced, aggressive); opt proposes the strategy.
 *
 * Every candidate carries a risk class and a best case / worst case:
 *   best case   cost: priced from the session's own tokens where possible (a ceiling, labelled
 *               `priced`), otherwise a stated `guess`. Latency is ordinal: faster / same / slower.
 *   worst case  what goes wrong, and what catches it (the hidden check, the baseline compare).
 * Risk is the worst case's severity: low = the worst case is "no saving"; medium = it can cost
 * more turns or miss a rule, which the check catches; high = it can fail the task outright.
 *
 * Aggressive may stack two levers into one run. A stacked run cannot attribute a failure to
 * either lever, and the proposal says so.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const GOALS = ['cost', 'latency', 'accuracy', 'balanced']
export const TEMPERATURES = ['conservative', 'balanced', 'aggressive']
const RISK_ALLOWED = { conservative: ['low'], balanced: ['low', 'medium'], aggressive: ['low', 'medium', 'high'] }
const RISK_RANK = { low: 0, medium: 1, high: 2 }

let PRICES = null
function prices() {
  if (PRICES) return PRICES
  try { PRICES = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'ult.default.json'), 'utf8')).prices } catch { PRICES = {} }
  return PRICES
}
const CHEAPER = 'claude-sonnet-5-5'     // what `--model sonnet` resolves to today
const priceOf = (m) => prices()[m] ?? prices()[String(m).replace(/-\d{8}$/, '')] ?? null

/** 0, 0.33, 'hot' … → a temperature name. */
export function parseTemperature(v) {
  if (v == null || v === true) return 'balanced'
  const s = String(v).toLowerCase()
  if (TEMPERATURES.includes(s)) return s
  if (['low', 'cold', 'safe', 'cautious'].includes(s)) return 'conservative'
  if (['high', 'hot', 'bold', 'max'].includes(s)) return 'aggressive'
  const n = Number(s)
  if (Number.isFinite(n)) return n < 0.34 ? 'conservative' : n < 0.67 ? 'balanced' : 'aggressive'
  return null
}

/** Shares of this session's cost that each lever can touch. All priced from its own tokens. */
export function sessionShares(s) {
  const p = priceOf(s?.model)
  if (!s || !p || !s.cost) return { known: false }
  const [inP, outP] = p
  const thinking = (s.thinkingTokens ?? 0) * outP / 1e6
  const cacheRead = (s.cacheReadTokens ?? 0) * inP * 0.1 / 1e6
  const ctx = s.ctxMedian ?? 0
  const overflow = ctx > 100000 ? cacheRead * (1 - 100000 / ctx) : 0
  const q = priceOf(CHEAPER)
  const ratio = q ? (q[0] / inP + q[1] / outP) / 2 : null
  return {
    known: true, model: s.model,
    thinking: Math.min(1, thinking / s.cost), compaction: Math.min(1, overflow / s.cost),
    cheaper: ratio != null && ratio < 1 ? 1 - ratio : 0,
  }
}

const pct = (x) => `−${Math.round(x * 100)}%`

/**
 * Candidates. `applies` returns null when the lever fits the session, or the reason it does not.
 * `best(sh)` returns {pct, label, basis} for cost; latency is an ordinal score.
 */
const CANDIDATES = [
  { id: 'terse-context', fast: { best: 'shorter replies to generate', worst: 'no faster' }, levers: ['terse-context'], risk: 'low', latency: 1,
    best: () => ({ text: 'less output', label: 'guess' }),
    worst: 'no saving', caughtBy: 'the baseline compare' },
  { id: 'effort-medium', fast: { best: 'less thinking before each reply', worst: 'more turns: no faster' }, levers: ['effort-medium'], risk: 'low', latency: 1,
    best: (sh) => sh.known && sh.thinking > 0.01 ? { x: sh.thinking / 2, label: 'guess', basis: 'half of this session\'s thinking' } : { text: 'small', label: 'guess' },
    worst: 'more turns instead of thinking: no saving', caughtBy: 'the cost and turns compare' },
  { id: 'route-cheaper-frontier', fast: { best: 'a smaller model answers faster', worst: 'extra turns make it slower overall' }, levers: ['route-cheaper-frontier'], risk: 'medium', latency: 2,
    applies: (s, w) => w === 'review' || w === 'debugging' ? 'review and debugging stay on the session\'s own model below aggressive' : !/opus|fable/.test(s?.model ?? 'opus') ? 'already on a cheaper model' : null,
    riskFor: (w) => (w === 'review' || w === 'debugging' ? 'high' : 'medium'),
    best: (sh) => sh.known && sh.cheaper ? { x: sh.cheaper, label: 'priced', basis: `${CHEAPER} price vs ${sh.model}, same tokens` } : { text: 'about half, at list prices', label: 'guess' },
    worst: 'misses a spec rule; extra turns eat the saving', caughtBy: 'the hidden check' },
  { id: 'effort-low', fast: { best: 'almost no thinking before replies', worst: 'guesses, fails, and retries: slower' }, levers: ['effort-low'], risk: 'medium', latency: 2,
    best: (sh) => sh.known && sh.thinking > 0.01 ? { x: sh.thinking, label: 'priced', basis: 'all of this session\'s thinking removed' } : { text: 'small', label: 'guess' },
    worst: 'guesses where a plan was needed, and fails', caughtBy: 'the hidden check' },
  { id: 'claude-thinking-cap', fast: { best: 'thinking time is capped', worst: 'no faster on easy turns' }, levers: ['claude-thinking-cap'], risk: 'medium', latency: 1,
    applies: (s) => s?.thinkingTokens == null ? 'a new task: no thinking measured yet' : s.thinkingTokens < 8000 ? 'thinking already under the 8k cap' : null,
    best: (sh) => sh.known ? { x: sh.thinking, label: 'priced', basis: 'ceiling: thinking above the cap' } : { text: 'unknown', label: 'guess' },
    worst: 'shallow exactly where depth was needed', caughtBy: 'the hidden check' },
  { id: 'context-compaction', fast: { best: 'less context to read per request', worst: 'the summary call adds time' }, levers: ['context-compaction'], risk: 'medium', latency: 1,
    applies: (s) => s?.ctxMedian == null ? 'a new task: context size unknown' : s.ctxMedian <= 100000 ? `median context ${Math.round((s.ctxMedian ?? 0) / 1000)}k: nothing to compact` : null,
    best: (sh) => ({ x: sh.compaction, label: 'priced', basis: 'cache reads above 100k context' }),
    worst: 'loses an early detail, often the spec', caughtBy: 'the hidden check' },
  { id: 'litellm-route-side-calls', fast: { best: 'subagents answer faster', worst: 'a subagent that reasons takes longer' }, levers: ['litellm-route-side-calls'], risk: 'medium', latency: 1,
    applies: (s) => !s || ((s.toolCounts?.Task ?? 0) + (s.toolCounts?.Agent ?? 0)) === 0 ? 'no subagents in this session' : null,
    best: () => ({ text: 'the subagent share of spend', label: 'guess' }),
    worst: 'a subagent that reasons does it worse', caughtBy: 'the hidden check' },
  { id: 'claude-max-turns', fast: { best: 'run time is bounded', worst: 'stops before the task is done' }, levers: ['claude-max-turns'], risk: 'high', latency: 1,
    applies: (s) => s?.turns != null && s.turns < 40 ? `finished in ${s.turns} turns: a 40-turn cap changes nothing` : null,
    best: () => ({ text: 'bounds the worst case, not the mean', label: 'guess' }),
    worst: 'stops before the task is done', caughtBy: 'the artifact and hidden checks' },
  // stacked: aggressive only
  { id: 'route-cheaper-frontier+effort-low', fast: { best: 'smaller model, almost no thinking', worst: 'both slowdowns at once' }, levers: ['route-cheaper-frontier', 'effort-low'], risk: 'high', latency: 3,
    applies: (s, w) => !/opus|fable/.test(s?.model ?? 'opus') ? 'already on a cheaper model' : null,
    best: (sh) => sh.known && sh.cheaper ? { x: 1 - (1 - sh.cheaper) * (1 - sh.thinking), label: 'priced', basis: `${CHEAPER} price, thinking removed` } : { text: 'the two savings combined', label: 'guess' },
    worst: 'both worst cases at once; a failure has no single cause', caughtBy: 'the hidden check' },
  { id: 'route-cheaper-frontier+context-compaction', fast: { best: 'smaller model, less context', worst: 'both slowdowns at once' }, levers: ['route-cheaper-frontier', 'context-compaction'], risk: 'high', latency: 3,
    applies: (s) => s?.ctxMedian == null || s.ctxMedian <= 100000 ? 'nothing to compact' : !/opus|fable/.test(s.model ?? '') ? 'already on a cheaper model' : null,
    best: (sh) => ({ x: 1 - (1 - sh.cheaper) * (1 - sh.compaction), label: 'priced', basis: `${CHEAPER} price, history above 100k dropped` }),
    worst: 'both worst cases at once; a failure has no single cause', caughtBy: 'the hidden check' },
]

function describeBest(b) {
  if (b.x != null) return { text: b.x > 0.005 ? `${pct(b.x)} cost` : 'no measurable saving', x: b.x, label: b.label, basis: b.basis }
  return { text: b.text, x: null, label: b.label }
}

/**
 * Propose a strategy for one session (or an ad-hoc task when `s` is null).
 * Returns { pick, considered[] } where each entry has id, risk, best, worst, ok, why.
 */
export function propose(s, { goal = 'cost', temperature = 'balanced', work = null, runnable = () => true, adjust = null } = {}) {
  const sh = sessionShares(s)
  const allowed = RISK_ALLOWED[temperature]
  const considered = CANDIDATES.map((c) => {
    const risk = c.riskFor?.(work) ?? c.risk
    const best = describeBest(c.best(sh))
    // for a latency goal the case is stated in time; the cost estimate still breaks ties
    const shown = goal === 'latency' ? { ...best, text: c.fast.best, basis: null, label: 'guess' } : best
    const base = { id: c.id, levers: c.levers, risk, best: shown, worst: goal === 'latency' ? c.fast.worst : c.worst, costBest: best, caughtBy: goal === 'latency' ? 'the run-time compare against the baseline' : c.caughtBy, latency: c.latency }
    const na = c.applies?.(s, work)
    if (na && !(temperature === 'aggressive' && /review and debugging/.test(na))) return { ...base, ok: false, why: na }
    if (!allowed.includes(risk)) return { ...base, ok: false, why: `${risk} risk is above ${temperature}` }
    if (!c.levers.every(runnable)) return { ...base, ok: false, why: 'cannot run in the local sandbox' }
    if (goal !== 'latency' && best.x != null && best.x < 0.01) return { ...base, ok: false, why: 'no measurable saving for this session' }
    return { ...base, ok: true }
  })
  const costScore = (c) => c.costBest.x ?? (c.costBest.label === 'guess' ? 0.02 : 0)
  // accuracy: keep the answer as good as it was — least risk first, then the saving
  const score = (c) => goal === 'cost' ? costScore(c) * 10 + c.latency * 0.01
    : goal === 'latency' ? c.latency + costScore(c) * 0.1
      : goal === 'accuracy' ? -RISK_RANK[c.risk] * 10 + costScore(c)
        : costScore(c) * 5 + c.latency * 0.5
  // highest score wins; on a tie, the lower risk. `adjust` lets a caller add evidence (e.g. a
  // classifier that says a lever does not apply) without changing what the goal ranks by.
  const total = (c) => score(c) + (adjust?.(c) ?? 0)
  const ok = considered.filter((c) => c.ok).sort((a, b) => total(b) - total(a) || RISK_RANK[a.risk] - RISK_RANK[b.risk])
  ok.forEach((c, i) => { c.rank = i + 1 })
  return { goal, temperature, pick: ok[0] ?? null, considered, shares: sh }
}

export const RISK_COLOR = { low: 'g', medium: 'y', high: 'r' }
