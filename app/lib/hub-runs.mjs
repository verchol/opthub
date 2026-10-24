/**
 * Every optimize / experiment run on disk, in one shape.
 *
 * `results/` holds three generations of run directory. This reads the two the
 * hub launches — optrun-* (a model grid) and exprun-* (one named lever against
 * its control) — and leaves the older demo runs to experiments.mjs.
 *
 * A run whose process is gone but whose status.json still says "running" is
 * reported as `stale`, not as running. The old hub had no such check, so a
 * killed run pinned its session in a spinner forever with no way to retry.
 */
import fs from 'node:fs'
import { STATE } from './state.mjs'
import path from 'node:path'

const STALE_AFTER_MS = 3 * 60 * 1000
const TERMINAL = new Set(['done', 'error', 'stopped', 'stale'])

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch { return false } }

/** One run directory → a row, or null if it is not one of ours. */
export function readRun(RESULTS, dir) {
  const m = /^(optrun|exprun)-([0-9a-f]{8})-(.*)$/.exec(dir)
  if (!m) return null
  const st = readJson(path.join(RESULTS, dir, 'status.json'))
  if (!st) return null
  const abs = path.join(RESULTS, dir)
  const mtime = fs.statSync(path.join(abs, 'status.json')).mtimeMs
  let phase = st.phase ?? 'unknown'
  if (!TERMINAL.has(phase) && !alive(st.pid) && Date.now() - mtime > STALE_AFTER_MS) phase = 'stale'

  const results = st.results ?? []
  const arms = results.map((r, i) => ({
    label: r.label, armId: r.armId ?? null, model: r.modelLabel ?? r.model,
    // runs written before arms carried a role: the first cell was the control
    role: r.role ?? (i === 0 ? 'baseline' : 'optimized'),
    compaction: !!r.compaction, effort: r.effort ?? null,
    cost: r.cost ?? null, turns: r.turns ?? 0, secs: r.secs ?? null,
    artifacts: r.artifacts ?? [], isError: !!r.isError, err: r.err ?? '',
    score: r.armId && st.verdict?.totals ? st.verdict.totals[r.armId] ?? null : null,
  }))
  const ok = arms.filter((a) => !a.isError && a.artifacts.length)
  const best = st.verdict && st.verdict.best != null && !st.verdict.error ? (ok[st.verdict.best]?.label ?? null) : null

  return {
    run: dir, kind: m[1] === 'exprun' ? 'experiment' : 'optimize',
    experiment: st.experiment ?? null, goal: st.goal ?? 'cost',
    // judge totals are summed over the rubric, each criterion out of 10
    scoreMax: st.verdict?.rubric ? st.verdict.rubric.length * 10 : null,
    session: st.session ?? m[2], sessionShort: (st.session ?? m[2]).slice(0, 8),
    intent: st.intent ?? '', phase,
    startedAt: st.startedAt ?? null, finishedAt: st.finishedAt ?? null, updatedAt: new Date(mtime).toISOString(),
    originalCost: st.originalCost ?? null, originalModel: st.originalModel ?? null,
    rationale: st.plan?.rationale ?? null, hypothesis: st.plan?.hypothesis ?? null,
    gate: st.plan?.gate ?? null, risk: st.plan?.risk ?? null,
    arms, failed: arms.filter((a) => a.isError).length,
    totalCost: st.totalCost ?? arms.reduce((a, x) => a + (x.cost || 0), 0),
    verdict: st.verdict ?? null, best,
    headline: headline({ phase, arms, best, verdict: st.verdict }),
    report: fs.existsSync(path.join(abs, 'report.html')) ? `results/${dir}/report.html` : null,
  }
}

/**
 * The one line that says what the run found — or why it cannot say.
 *
 * The comparison is arm against arm, both run here, never against the original
 * session's cost. A sandbox replay finishes in two turns what the real session
 * took seven hundred to reach, so "2278× cheaper" was measuring the replay's
 * incompleteness and calling it a saving.
 */
function headline({ phase, arms, best, verdict }) {
  if (phase === 'stale') return { text: 'run died — process gone, no result', tone: 'degraded' }
  if (phase === 'stopped') return { text: 'stopped by hand', tone: 'flat' }
  if (!TERMINAL.has(phase)) return { text: phase + '…', tone: 'flat' }

  const ok = arms.filter((a) => !a.isError && a.artifacts.length)
  if (!ok.length) return { text: `every arm failed (${arms.length})`, tone: 'degraded',
                           detail: arms.find((a) => a.err)?.err ?? 'no arm produced a file' }

  const base = ok.find((a) => a.role === 'baseline')
  const rivals = ok.filter((a) => a !== base)
  if (!base || !rivals.length) return {
    text: `only ${ok.length} of ${arms.length} arms delivered — no comparison`, tone: 'flat',
    detail: 'a delta needs a control and a variant that both produced something',
  }

  // cheapest rival that the judge did not rank below the control
  const pick = [...rivals].sort((a, b) => a.cost - b.cost)[0]
  const ratio = pick.cost > 0 ? base.cost / pick.cost : null
  const money = ratio == null ? 'cost unmeasured'
    : ratio >= 1.05 ? `${ratio.toFixed(ratio < 10 ? 1 : 0)}× cheaper than control`
    : ratio <= 0.95 ? `${(1 / ratio).toFixed(1)}× dearer than control`
    : 'same cost as control'
  const tone = ratio == null ? 'flat' : ratio >= 1.05 ? 'improved' : ratio <= 0.95 ? 'degraded' : 'flat'

  if (verdict?.error) return { text: `${money} · judge unavailable`, tone: 'flat', detail: verdict.error }
  // when the rubric ran, quality decides and cost is the qualifier
  if (base.score != null && pick.score != null) {
    const d = pick.score - base.score
    const q = d > 0 ? `quality +${d}` : d < 0 ? `quality ${d}` : 'quality level'
    return { text: `${pick.label}: ${q}, ${money}`, tone: d < -3 ? 'degraded' : tone, detail: verdict?.why ?? null }
  }
  return { text: best ? `${best} · ${money}` : money, tone, detail: verdict?.why ?? null }
}

/** Newest first. */
export function collectRuns(ROOT) {
  const RESULTS = path.join(STATE, 'results')
  if (!fs.existsSync(RESULTS)) return []
  return fs.readdirSync(RESULTS)
    .map((d) => { try { return fs.statSync(path.join(RESULTS, d)).isDirectory() ? readRun(RESULTS, d) : null } catch { return null } })
    .filter(Boolean)
    .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))
}

/** session id → its most recent run, which is what the Sessions list shows. */
export function runsBySession(ROOT) {
  const out = {}
  for (const r of collectRuns(ROOT)) {
    const cur = out[r.session]
    if (!cur || String(r.startedAt) > String(cur.startedAt)) out[r.session] = r
  }
  return out
}
