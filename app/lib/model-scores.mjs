/**
 * The routing record of every model, from every router audit on this machine (last 7 days): how
 * often a model was given work, how often it delivered, how fast, what it saved, and why it was
 * refused or abandoned. The hub shows it (Optimize → Models). The launchers read the verdicts
 * (capacity.withMachine), so a local model with a bad record stops getting traffic until its window
 * clears: the record steers the next routing decision.
 *
 *   good          enough attempts, at least 80% answered, first token within budget
 *   learning      fewer than 10 attempts: no verdict yet
 *   too slow      over 30% abandoned for no first token in time, or median first token over budget
 *   unreliable    under 80% answered, mostly failed or malformed answers
 *   does not fit  refused for memory and never answered (shown, not demoted: every router start re-checks fit)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadProfile } from './ult/capacity.mjs'

const WINDOW_MS = 7 * 86400000
const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }

/** Router audit files: `opt claude optimize` runs and `opt claude -p` arms. */
export function auditFiles(stateDir) {
  const out = []
  const ls = (d) => { try { return fs.readdirSync(d) } catch { return [] } }
  for (const run of ls(path.join(stateDir, 'results'))) out.push(path.join(stateDir, 'results', run, 'audit.jsonl'))
  for (const run of ls(path.join(stateDir, 'sandbox-out')))
    for (const arm of ls(path.join(stateDir, 'sandbox-out', run))) out.push(path.join(stateDir, 'sandbox-out', run, arm, 'router', 'audit.jsonl'))
  return out.filter((f) => fs.existsSync(f))
}

function entries(files, since) {
  const out = []
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue
      let e; try { e = JSON.parse(line) } catch { continue }
      if (e.kind === 'request' && (!since || Date.parse(e.ts ?? 0) >= since)) out.push(e)
    }
  }
  return out
}

/** @returns {{window_days:number, models: object[]}} one row per model, local first */
export function scoreModels(files, { now = Date.now(), budgetMs = 5000, minAttempts = 10 } = {}) {
  const M = new Map()
  const row = (id, where) => {
    if (!M.has(id)) M.set(id, { id, where, requests: 0, attempted: 0, answered: 0, refused: {}, failed: {}, shadow: 0, ttft: [], latency: [], outTokens: 0, costUsd: 0, savedUsd: 0 })
    return M.get(id)
  }
  for (const e of entries(files, now - WINDOW_MS)) {
    const proposedLocal = e.proposed?.decision === 'local' ? e.proposed.target?.replace(/^local:/, '') : null
    const fellBack = e.fallback_from?.target?.startsWith('local:') ? e.fallback_from.target.slice(6) : null
    const local = e.decision === 'local' ? e.target.replace(/^local:/, '') : fellBack ?? (e.capacity ? proposedLocal : null)
    if (local) {
      const r = row(local, 'local')
      if (e.decision === 'local') {
        r.attempted++; r.answered++; r.requests++
        r.ttft.push(e.ttft_ms); r.latency.push(e.latency_ms); r.outTokens += e.usage?.output_tokens ?? 0
        r.savedUsd += e.counterfactual_usd ?? 0
      } else if (fellBack) {
        r.attempted++; r.requests++
        const why = e.capacity?.reason ?? 'failed'; r.failed[why] = (r.failed[why] ?? 0) + 1
      } else {
        r.requests++
        const why = e.capacity.reason; r.refused[why] = (r.refused[why] ?? 0) + 1
      }
    } else if (e.mode === 'shadow' && proposedLocal) {
      row(proposedLocal, 'local').shadow++
    }
    // whoever answered on the remote side
    if (e.decision !== 'local' && e.status === 200) {
      const r = row(e.actual_model ?? e.target ?? e.requested_model ?? 'unknown', 'remote')
      r.requests++; r.answered++; r.latency.push(e.latency_ms); r.ttft.push(e.ttft_ms)
      r.outTokens += e.usage?.output_tokens ?? 0; r.costUsd += e.cost_usd ?? 0
      if (e.decision === 'route') r.savedUsd += (e.counterfactual_usd ?? 0) - (e.cost_usd ?? 0)
      if (fellBack) r.caughtFallbacks = (r.caughtFallbacks ?? 0) + 1
    }
  }
  const models = [...M.values()].map((r) => {
    const failed = Object.values(r.failed).reduce((a, b) => a + b, 0)
    const out = { ...r, ttftP50: median(r.ttft), latencyP50: median(r.latency), costUsd: +r.costUsd.toFixed(4), savedUsd: +r.savedUsd.toFixed(4),
                  answerRate: r.attempted ? +(r.answered / r.attempted).toFixed(3) : null }
    delete out.ttft; delete out.latency
    if (r.where === 'remote') return { ...out, verdict: 'frontier' }
    const slow = r.failed.slow ?? 0
    out.verdict = r.answered === 0 && r.refused['no-fit'] ? 'does not fit'
      : r.attempted < minAttempts ? 'learning'
      : slow / r.attempted > 0.3 || (out.ttftP50 ?? 0) > budgetMs ? 'too slow'
      : r.answered / r.attempted < 0.8 && failed > slow ? 'unreliable'
      : 'good'
    out.demote = ['too slow', 'unreliable'].includes(out.verdict)     // fit is re-checked at every router start
    return out
  })
  models.sort((a, b) => (a.where === b.where ? b.requests - a.requests : a.where === 'local' ? -1 : 1))
  return { window_days: WINDOW_MS / 86400000, budget_ms: budgetMs, models }
}

/**
 * What the router cannot see from inside its container, written into the resolved config by the
 * launcher: the bench profile in OPT_HOME, the host's memory (a container reports the VM's), and the
 * local models whose record says stop sending them work.
 */
export function withMachine(config, stateDir) {
  if (!config.local?.enabled) return config
  config.local.bench = loadProfile(stateDir, config.local.model)?.recommended ?? null
  config.local.hostMemoryBytes = os.totalmem()
  config.local.demoted = demoted(stateDir, { budgetMs: config.local.firstTokenMs ?? 5000 })
  return config
}

/** Local models whose record says stop sending them work. */
export function demoted(stateDir, opts) {
  return scoreModels(auditFiles(stateDir), opts).models.filter((m) => m.demote).map((m) => ({ id: m.id, verdict: m.verdict }))
}
