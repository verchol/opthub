#!/usr/bin/env node
/**
 * Work the Triage re-run queue: every session the classifier could not place on a
 * model tier is re-run in the sandbox — baseline vs Sonnet, blind-judged — through
 * the same optimize.mjs experiment path the hub's Run button uses.
 *
 *   node triage-rerun.mjs                      plan only: what would run, what it may cost. Spends nothing.
 *   node triage-rerun.mjs --go --limit=3       run the 3 most expensive queued sessions, one at a time
 *   node triage-rerun.mjs --go --max-usd=15    stop starting new runs once sandbox spend reaches $15
 *
 * The queue is results/triage.json (written by the opthub repo's
 * experiments/session-triage/src/export_hub.py). A session is skipped when it
 * already has a finished run of the same experiment, so re-running this resumes.
 *
 * Why a cap here: --budget bounds one arm; nothing bounded a batch of runs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { STATE } from './lib/state.mjs'
import { collectRuns } from './lib/hub-runs.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d }
const GO = process.argv.includes('--go')
const LIMIT = Number(arg('limit', 3))
const MAX_USD = Number(arg('max-usd', 20))
const BUDGET = Number(arg('budget', 3))          // per arm, passed to optimize.mjs
const ARMS = 2                                    // experiment mode: baseline + one arm

const file = path.join(STATE, 'results', 'triage.json')
if (!fs.existsSync(file)) { console.error(`no ${file} — run export_hub.py in the opthub repo first`); process.exit(1) }
const T = JSON.parse(fs.readFileSync(file, 'utf8'))
const EXP = T.rerunExperiment

// session -> a finished run of this experiment that produced a comparison. A run
// where an arm failed, or the judge could not score, answered nothing and is re-queued.
// "Sonnet scored worse" is an answer; "only one arm delivered" is not.
const answered = (r) => r.phase === 'done' && r.verdict && !r.verdict.error
  && r.arms.filter((a) => a.score != null).length >= 2
const done = new Map()
for (const r of collectRuns(ROOT)) {
  if (r.experiment === EXP && answered(r)) done.set(r.session, r)
}
const queue = T.sessions
  .filter((s) => s.rerun?.needed && s.session && !done.has(s.session))
  .sort((a, b) => b.cost - a.cost)
const pick = queue.slice(0, LIMIT)

console.log(`triage re-run · ${EXP} · ${queue.length} queued, ${done.size} already run · taking ${pick.length}`)
console.log(`  per run ≤ $${BUDGET * ARMS} (${ARMS} arms × $${BUDGET}) · batch cap $${MAX_USD}`)
for (const s of pick) console.log(`  ${s.session.slice(0, 8)}  $${s.cost.toFixed(2).padStart(7)}  ${s.project}  — ${s.rerun.reason}`)
if (!GO) { console.log('\nplan only. Add --go to run.'); process.exit(0) }

// one batch at a time across every hub and shell on this machine
const LOCK = path.join(STATE, 'results', '.triage-rerun.lock')
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
try { const other = Number(fs.readFileSync(LOCK, 'utf8')); if (other && alive(other)) { console.log(`another re-run batch is running (pid ${other})`); process.exit(3) } } catch {}
fs.writeFileSync(LOCK, String(process.pid))
process.on('exit', () => { try { if (fs.readFileSync(LOCK, 'utf8') === String(process.pid)) fs.unlinkSync(LOCK) } catch {} })

const spentOf = (id) => {
  const r = collectRuns(ROOT).filter((x) => x.session === id && x.experiment === EXP)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0]
  return r?.totalCost ?? 0
}
let spent = 0
let current = null
process.on('SIGTERM', () => { console.log('\nstop requested'); current?.kill('SIGTERM'); process.exit(143) })
for (const s of pick) {
  if (spent + BUDGET * ARMS > MAX_USD) { console.log(`\nstopping: the next run could pass the $${MAX_USD} cap (spent $${spent.toFixed(2)})`); break }
  console.log(`\n▶ ${s.session.slice(0, 8)} ${s.project}`)
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'optimize.mjs'), s.session, `--experiment=${EXP}`, `--budget=${BUDGET}`],
      { cwd: ROOT, env: process.env, stdio: 'inherit' })
    current = child
    child.on('exit', resolve)
  })
  const cost = spentOf(s.session)
  spent += cost
  console.log(`◀ ${s.session.slice(0, 8)} exit ${code} · $${cost.toFixed(2)} · batch $${spent.toFixed(2)}`)
}
console.log(`\ndone · sandbox spend $${spent.toFixed(2)}`)
