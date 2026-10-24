/**
 * The two verbs opt is built around, plus the trail they leave:
 *
 *   opt analyse                 load every session and classify it (Jev on local Ollama by default)
 *   opt optimize [strategy]     run one non-interactive task in the local sandbox with that strategy
 *   opt audit                   every task either of them ran, from the hash-chained log
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyse, analysisFor, allAnalysed, CLASSIFIERS, SOURCES, CACHE_FILE } from './lib/analyse.mjs'
import { parseDateSpec, describeRange } from './lib/daterange.mjs'
import { startTask, readTasks, summarizeTasks, verifyAudit, AUDIT_FILE, sha256 } from './lib/task-audit.mjs'
import { loadCatalog } from './lib/optimizations.mjs'
import { localPlan, mergePlans, containerScript, readResult, diffTrees, runSandbox, outRoot, tilde, setParallel, parallelLimit } from './lib/local-run.mjs'
import { propose, parseTemperature, GOALS, TEMPERATURES } from './lib/goals.mjs'
import { findTranscript, processTranscript } from './lib/sessions-index.mjs'
import { STATE as STATE_DIR } from './lib/state.mjs'
import { SANDBOX_SH } from '../sandbox/docker/index.mjs'
import { launcherCredential } from './lib/ult/credentials.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
const pad = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n) }
const money = (v) => v == null ? '—' : `$${v < 10 ? v.toFixed(2) : v.toFixed(0)}`

function flagsOf(argv, spec) {
  const f = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { f._.push(a); continue }
    const [k, inline] = a.slice(2).split(/=(.*)/s)
    if (spec.bool?.includes(k)) f[k] = true
    else f[k] = inline ?? argv[++i]
  }
  return f
}

// ------------------------------------------------------------------ analyse
export const ANALYSE_HELP = `
  ${C.b}opt analyse${C.x}                load and classify every session
       --source claude-code        where sessions come from (default; the only one today)
       --classifier jev-local      Jev contract on local Ollama, model tev1 (default)
                    jev            hosted TypeSafe Jev, needs JEV_API_KEY
                    rules          no model
       --model tev1                local decision model   --url http://127.0.0.1:11434/v1/systemone
       --since 30d                 window by creation date (default: all)
       --project <dir>             only sessions that ran in this directory or below
       --fresh                     re-classify everything, ignore the cache
       --rows 25  --all            how many rows to print
       --eligible                  only sessions opt optimize may take (non-interactive)
       --json                      machine-readable
`

export async function cmdAnalyse(argv) {
  const f = flagsOf(argv, { bool: ['fresh', 'json', 'all', 'eligible', 'help'] })
  if (f.help) { console.log(ANALYSE_HELP); return 0 }
  const source = f.source ?? 'claude-code'
  const classifier = f.classifier ?? 'jev-local'
  if (!(classifier in CLASSIFIERS)) { console.error(`unknown classifier '${classifier}' — ${Object.keys(CLASSIFIERS).join(', ')}`); return 2 }
  if (!SOURCES.includes(source)) { console.error(`unknown source '${source}' — supported: ${SOURCES.join(', ')}`); return 2 }
  const cfg = CLASSIFIERS[classifier] && { ...CLASSIFIERS[classifier], ...(f.model ? { model: f.model } : {}), ...(f.url ? { endpoint: f.url } : {}) }
  const apiKey = cfg?.key ? process.env[cfg.key] : null
  if (cfg?.key && !apiKey) { console.error(`${classifier} needs ${cfg.key} in the environment`); return 2 }
  const range = parseDateSpec(f.since ?? 'all')
  const project = f.project ? path.resolve(f.project.replace(/^~/, os.homedir())) : null
  if (!range) { console.error(`--since: cannot read '${f.since}'`); return 2 }

  const task = startTask('analyse', { source, classifier, model: cfg?.model ?? null, window: describeRange(range), project: project ? tilde(project) : null })
  let done = 0, fromCache = 0
  try {
    const { records, jevDown } = await analyse({
      source, classifier, cfg, apiKey, range, project, fresh: !!f.fresh,
      onEach: (r, cached) => {
        done++; if (cached) { fromCache++; return }
        // one line per decision: what was decided, by whom, and whether the rules agreed — no text
        task.event('classified', { session: r.id, mode: r.mode.label, mode_by: r.mode.by, mode_conf: r.mode.confidence,
          work: r.work.label, work_by: r.work.by, agree: r.mode.agree, strategy: r.strategy.id, jev_error: r.jevError })
        if (!f.json && process.stderr.isTTY) process.stderr.write(`\r  ${C.d}classifying ${done}…${C.x}   `)
      },
    })
    if (process.stderr.isTTY && !f.json) process.stderr.write('\r' + ' '.repeat(30) + '\r')
    const recs = records.filter(Boolean)
    const byMode = {}
    for (const r of recs) { const m = (byMode[r.mode.label] ??= { n: 0, cost: 0 }); m.n++; m.cost += r.cost ?? 0 }
    const viaJev = recs.filter((r) => r.mode.by !== 'rules').length
    const disagree = recs.filter((r) => r.mode.agree === false).length
    const eligible = recs.filter((r) => r.eligible)
    task.end({ sessions: recs.length, classified: recs.length - fromCache, cached: fromCache, via_jev: viaJev, rules_fallback: recs.length - viaJev,
      disagree, eligible: eligible.length, jev_down: jevDown, by_mode: Object.fromEntries(Object.entries(byMode).map(([k, v]) => [k, v.n])) })

    if (f.json) { console.log(JSON.stringify({ task: task.id, records: recs }, null, 1)); return 0 }
    const show = (f.eligible ? eligible : recs).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    const rows = f.all ? show : show.slice(0, Number(f.rows ?? 25))
    console.log(`\n  ${C.b}opt analyse${C.x}  ${C.d}${source}${project ? ' · ' + tilde(project) : ''} · ${describeRange(range)} · ${classifier}${cfg ? ` (${cfg.model})` : ''} · task ${task.id}${C.x}`)
    if (jevDown) console.log(`  ${C.y}${classifier} unreachable at ${cfg.endpoint} — fell back to rules. Is Ollama running, and is ${cfg.model} pulled?${C.x}`)
    console.log(`\n  ${C.d}${pad('SESSION', 10)}${pad('MODE', 17)}${pad('WORK', 12)}${pad('BY', 11)}${pad('PROPOSAL · cost', 26)}${pad('TURNS', 7)}${pad('COST', 8)}INTENT${C.x}`)
    for (const r of rows) {
      const mc = r.mode.label === 'non-interactive' ? C.g : r.mode.label === 'interactive' ? '' : C.y
      const by = r.mode.by === 'rules' ? 'rules' : r.mode.agree === false ? 'jev ≠ rules' : 'jev'
      console.log(`  ${pad(r.id.slice(0, 8), 10)}${mc}${pad(r.mode.label, 17)}${C.x}${pad(r.work.label, 12)}${C.d}${pad(by, 11)}${C.x}${(RISK_C[r.strategy.risk] ?? '')}${pad(r.strategy.id, 26)}${C.x}${pad(r.turns, 7)}${pad(money(r.cost), 8)}${C.d}${pad(r.intent, 40)}${C.x}`)
    }
    if (rows.length < show.length) console.log(`  ${C.d}… ${show.length - rows.length} more (--all)${C.x}`)
    console.log('')
    for (const [m, v] of Object.entries(byMode)) console.log(`  ${pad(m, 17)}${pad(v.n + ' sessions', 14)}${money(v.cost)}`)
    console.log(`\n  ${C.d}${viaJev} decided by ${classifier}, ${recs.length - viaJev} by rules · ${disagree} where Jev and rules disagree · ${fromCache} from cache${C.x}`)
    console.log(`  ${C.g}${eligible.length}${C.x} non-interactive sessions are eligible:  ${C.b}opt optimize <strategy> --session <id>${C.x}`)
    console.log(`  ${C.d}cache ${tilde(CACHE_FILE)} · audit ${tilde(AUDIT_FILE)}${C.x}\n`)
    return 0
  } catch (e) {
    task.fail(e); console.error(`analyse failed: ${e.message}`); return 1
  }
}

// ------------------------------------------------------------------ optimize
export const OPTIMIZE_HELP = `
  ${C.b}opt optimize${C.x} [goal] [temperature]     run a task non-interactively in the local sandbox;
                                         opt proposes the strategy for the goal
       goal          cost (default) · latency · balanced
       temperature   conservative · balanced (default) · aggressive, or 0–1
                     how much risk you accept: conservative only takes levers whose worst case is
                     "no saving"; aggressive may stack two levers and risk failing the task
       --task "…"  --task-file <f|->  --session <id>   what to run (a session must be non-interactive)
       --dir <path>                source tree, mounted read-only (default: the session's cwd, else .)
       --model <m>                 the baseline model (default: the session's own)

     compare against the baseline
       --baseline / --no-baseline  also run the task unchanged and compare (default: on for --session)
       --repeats 3                 runs per side; under 3 the verdict says it is not a finding
       --check <file>              hidden check (.py .sh .js), run against each result in its own sandbox
       --eligible                  every non-interactive session (opt analyse), each against its baseline
         --project <dir>  --checks <dir>       narrow to one project; checks named <project>.py

       --parallel 6                sandboxes at once (each is a full Claude Code)
       --timeout 30m  --budget 2  --auth api-key|oauth  --force  --dry-run

  ${C.b}opt optimize plan${C.x} [goal]          each temperature's proposal per session: risk, best case, worst case
  ${C.b}opt optimize strategies${C.x}             every lever, what it changes, and whether it runs locally
  ${C.b}opt optimize${C.x} <strategy-id>        experts: skip the proposal and run one lever by name
  ${C.b}opt optimize ls${C.x}  ·  ${C.b}install-command${C.x}   recent tasks · install /optimize into Claude Code
`

function firstPrompt(id) {
  const file = findTranscript(id)
  if (!file) return null
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let e; try { e = JSON.parse(line) } catch { continue }
    if (e.type !== 'user' || e.isMeta) continue
    const c = e.message?.content
    const t = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b.type === 'text')?.text ?? '') : ''
    if (t && !t.startsWith('<')) return { text: t, file }
  }
  return null
}
const seconds = (s) => { const m = /^(\d+)\s*([smh]?)$/.exec(String(s)); return m ? Number(m[1]) * ({ s: 1, m: 60, h: 3600 }[m[2] || 'm']) : null }
const median = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null }
const RUNNER = { '.py': 'python3', '.sh': 'bash', '.js': 'node', '.mjs': 'node' }
/** A check kept outside the tree, so neither the agent nor the session calling opt can read it. */
function hiddenCheck(dir) {
  const root = process.env.OPT_CHECKS_DIR
  if (!root || !dir) return null
  for (const ext of Object.keys(RUNNER)) { const c = path.resolve(root, path.basename(dir) + ext); if (fs.existsSync(c)) return c }
  return null
}
const withModel = (plan, m) => (m && !plan.flags.some((x) => x.startsWith('--model')) ? { ...plan, flags: [`--model ${m}`, ...plan.flags] } : plan)

/**
 * The verdict, from measured numbers only. Keep needs: every strategy run finished,
 * it passes the check at least as often as the baseline, and it is cheaper.
 */
export function verdictOf(base, strat, { hasCheck, goal = 'cost' }) {
  const n = strat.length
  if (strat.some((r) => r.is_error)) return { verdict: 'drop', reason: 'the strategy run failed' }
  if (base.some((r) => r.is_error)) return { verdict: 'inconclusive', reason: 'the baseline run failed, so there is nothing to compare against' }
  const pass = (rs) => rs.filter((r) => r.check === 'pass').length
  if (hasCheck && pass(base) === 0 && pass(strat) === 0) return { verdict: 'inconclusive', reason: 'neither side passes the check' }
  if (hasCheck && pass(strat) / n < pass(base) / base.length) return { verdict: 'drop', reason: `fails the check the baseline passes (${pass(strat)}/${n} vs ${pass(base)}/${base.length})` }
  const same = hasCheck ? ', and passes the same check' : ', same task finished'
  const delta = (key) => { const b = median(base.map((r) => r[key])), x = median(strat.map((r) => r[key])); return b == null || x == null || !b ? null : (x - b) / b * 100 }
  const cost = delta('cost_usd'), time = delta('duration_ms')
  const word = (p, better, worse) => `${Math.abs(p).toFixed(0)}% ${p < 0 ? better : worse}`
  if (goal === 'latency') {
    if (time == null) return { verdict: 'inconclusive', reason: 'no run time reported' }
    return time < 0 ? { verdict: 'keep', reason: `${word(time, 'faster', 'slower')}${same}`, pct: time }
      : { verdict: 'drop', reason: `not faster (${word(time, 'faster', 'slower')})`, pct: time }
  }
  if (goal === 'balanced') {
    if (time == null || cost == null) return { verdict: 'inconclusive', reason: 'cost or run time missing' }
    if (time <= 0 && cost <= 0 && (time < 0 || cost < 0)) return { verdict: 'keep', reason: `${word(cost, 'cheaper', 'dearer')} and ${word(time, 'faster', 'slower')}${same}`, pct: cost }
    return { verdict: 'drop', reason: `not better on both: ${word(cost, 'cheaper', 'dearer')}, ${word(time, 'faster', 'slower')}`, pct: cost }
  }
  if (cost == null) return { verdict: 'inconclusive', reason: 'no cost reported' }
  return cost < 0 ? { verdict: 'keep', reason: `${word(cost, 'cheaper', 'dearer')}${same}`, pct: cost }
    : { verdict: 'drop', reason: `not cheaper (${word(cost, 'cheaper', 'dearer')})`, pct: cost }
}

/** Every lever in config/optimizations.json, and what it changes in a run (`opt claude strategies`). */
export function cmdStrategies(entries = strategyEntries()) {
  console.log(`\n  ${C.b}strategies${C.x}  ${C.d}config/optimizations.json · use one: opt claude -p "…" --strategy <id> --compare${C.x}\n`)
  for (const e of entries) {
    const p = localPlan(e)
    const why = p.error ? p.error.replace(`${e.id} `, '') : null
    console.log(`  ${p.error ? C.d + '·' : C.g + '✓'}${C.x} ${pad(e.id, 28)}${p.error ? C.d + pad(why, Math.max(40, (process.stdout.columns || 132) - 34)) + C.x : [...p.flags, ...Object.entries(p.env).map(([k, v]) => `${k}=${v}`), p.appendPrompt ? '+prompt' : ''].filter(Boolean).join(' ') || '(no change: the control)'}`)
  }
  console.log('')
  return 0
}

export const strategyEntries = () => { const c = loadCatalog(ROOT, { fresh: true }); return c.experiments ?? c }

/**
 * A recorded session as a task: its first prompt, the directory it ran in, its model. Only
 * non-interactive sessions qualify (opt analyse decides), unless force.
 * @returns {{text, session, dir, analysed, sessionModel} | {error}}
 */
export function taskFromSession(id, { force = false } = {}) {
  const analysed = analysisFor(id)
  const fp = firstPrompt(analysed?.id ?? id)
  if (!fp) return { error: `no transcript for session ${id}` }
  const session = path.basename(fp.file, '.jsonl')
  if (!analysed) return { error: `session ${session.slice(0, 8)} has not been analysed — run opt analyse first, so its mode is known` }
  if (!analysed.eligible && !force) return { error: `session ${session.slice(0, 8)} is ${analysed.mode.label} (by ${analysed.mode.by}): only non-interactive sessions are replayed as tasks; --force overrides` }
  const rec = processTranscript(fp.file)
  return { text: fp.text, session, analysed, sessionModel: rec?.model?.startsWith('claude-') ? rec.model : null,
           dir: rec?.cwd ? rec.cwd.replace(/^~/, os.homedir()) : null }
}

export async function cmdOptimize(argv, { needSecrets } = {}) {
  const f = flagsOf(argv, { bool: ['force', 'dry-run', 'help', 'json', 'baseline', 'no-baseline', 'fresh-baseline', 'eligible'] })
  if (f.help) { console.log(OPTIMIZE_HELP); return 0 }
  const catalog = loadCatalog(ROOT, { fresh: true })
  const entries = catalog.experiments ?? catalog

  if (f._[0] === 'strategies') return cmdStrategies(entries)
  if (f._[0] === 'install-command') {
    const src = path.join(ROOT, 'template', 'claude', 'commands', 'optimize.md')
    const dest = path.join(os.homedir(), '.claude', 'commands', 'optimize.md')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') !== fs.readFileSync(src, 'utf8') && !f.force) {
      console.error(`${tilde(dest)} exists and differs (an older /optimize?) — not overwriting. --force replaces it.`); return 1
    }
    fs.copyFileSync(src, dest)
    console.log(`installed /optimize → ${tilde(dest)}  ${C.d}(the interactive mode is /optimize-live: opt claude optimize install-command)${C.x}`)
    return 0
  }
  if (f._[0] === 'ls') {
    const rows = summarizeTasks(readTasks()).filter((t) => t.kind === 'optimize').slice(0, 20)
    console.log(`\n  ${C.d}${pad('TASK', 32)}${pad('STATE', 9)}${pad('STRATEGY', 24)}${pad('COST', 8)}VERDICT${C.x}`)
    for (const t of rows) {
      const e = t.end ?? {}
      const st = t.state === 'done' ? C.g + 'done' : t.state === 'failed' ? C.r + 'failed' : C.y + 'running'
      console.log(`  ${pad(t.task, 32)}${pad(st + C.x, 9 + 9)}${pad(t.start?.strategy, 24)}${pad(money(e.cost_usd), 8)}${e.verdict ?? ''}`)
    }
    console.log('')
    return 0
  }

  if (f.parallel) setParallel(Number(f.parallel))
  if (f._[0] === 'plan') { f._.shift(); return cmdPlan(f, entries) }
  if (f.eligible) return cmdEligible(f, entries, needSecrets)

  // ---- what to run
  let text = null, session = null, dir = f.dir ? path.resolve(f.dir) : null, analysed = null, sessionModel = null
  if (f.session) {
    const t = taskFromSession(f.session, { force: f.force })
    if (t.error) { console.error(t.error); return 2 }
    ;({ text, session, analysed, sessionModel } = t)
    if (!dir) dir = t.dir
  }
  if (f.task) text = f.task
  if (f['task-file']) text = f['task-file'] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(f['task-file'], 'utf8')
  if (!text?.trim()) { console.error('nothing to run: give --task, --task-file or --session  (opt optimize --help)'); return 2 }
  dir ??= process.cwd()
  if (!fs.existsSync(dir)) { console.error(`source tree ${tilde(dir)} does not exist`); return 2 }

  const choice = chooseStrategy(f, entries, { session, analysed })
  if (choice.error) { console.error(choice.error); return 2 }
  const r = await runOptimize({ f, entries, needSecrets, text, session, dir, analysed, sessionModel, choice })
  return r.code
}

/**
 * Positional words: a goal (cost, latency, balanced), a temperature (conservative, balanced,
 * aggressive, or 0–1), or — for experts — a strategy id, which skips the proposal.
 */
function goalArgs(f) {
  let goal = f.goal ?? null, temperature = f.temperature ?? f.temp ?? null, named = null
  for (const a of f._) {
    if (!goal && GOALS.includes(a)) goal = a
    else if (!temperature && parseTemperature(a) && (TEMPERATURES.includes(a) || /^[\d.]+$/.test(a) || ['hot', 'cold', 'safe', 'bold'].includes(a))) temperature = a
    else named = a
  }
  return { goal: goal ?? 'cost', temperature: parseTemperature(temperature) ?? 'balanced', named, rawTemp: temperature }
}

const runnableIn = (entries) => (id) => { const e = entries.find((x) => x.id === id); return !!e && !localPlan(e).error }

export function chooseStrategy(f, entries, { session, analysed }) {
  const g = goalArgs(f)
  if (g.rawTemp && !parseTemperature(g.rawTemp)) return { error: `temperature '${g.rawTemp}': use conservative, balanced, aggressive or 0–1` }
  if (g.named) return { strategyId: g.named, strategyWhy: 'named', proposal: null }
  const s = session ? processTranscript(findTranscript(session)) : f.model ? { model: f.model } : null
  const proposal = propose(s, { goal: g.goal, temperature: g.temperature, work: analysed?.work?.label ?? null, runnable: runnableIn(entries) })
  if (!proposal.pick) {
    const why = proposal.considered.map((c) => `    ${c.id}: ${c.why}`).join('\n')
    return { error: `nothing fits goal ${g.goal} at ${g.temperature}:\n${why}\n  try a higher temperature` }
  }
  return { strategyId: proposal.pick.id, strategyWhy: `goal ${g.goal} · ${g.temperature}`, proposal }
}

const RISK_C = { low: C.g, medium: C.y, high: C.r }
const latencyWord = (n) => (n >= 2 ? 'faster' : n >= 1 ? 'a little faster' : 'same speed')
export function printProposal(log, p) {
  if (!p?.pick) return
  const k = p.pick
  log(`  goal       ${C.b}${p.goal}${C.x} · ${p.temperature}`)
  log(`  proposal   ${C.b}${k.levers.join(' + ')}${C.x}   ${RISK_C[k.risk]}${k.risk} risk${C.x}`)
  log(`  best case  ${C.g}${k.best.text}${C.x}${k.best.basis ? ` ${C.d}(${k.best.label}: ${k.best.basis})${C.x}` : ` ${C.d}(${k.best.label})${C.x}`}${p.goal === 'latency' ? '' : ' · ' + latencyWord(k.latency)}`)
  log(`  worst case ${C.r}${k.worst}${C.x} ${C.d}→ caught by ${k.caughtBy}${C.x}`)
  const passed = p.considered.filter((c) => !c.ok && !/above/.test(c.why)).slice(0, 2)
  const riskier = p.considered.filter((c) => /above/.test(c.why))
  for (const [i, c] of passed.entries()) log(`  ${i ? '          ' : 'passed    '} ${C.d}${c.id}: ${c.why}${C.x}`)
  if (riskier.length) log(`  ${C.d}           not at ${p.temperature}: ${riskier.map((c) => c.id).join(', ')}${C.x}`)
}


/** Sessions to optimize: eligible ones from the analysis cache, optionally under one project. */
export function eligibleSessions(f) {
  const project = f.project ? path.resolve(f.project.replace(/^~/, os.homedir())) : null
  const out = []
  for (const a of allAnalysed()) {
    if (!a.eligible) continue
    const fp = firstPrompt(a.id)
    if (!fp) continue
    const rec = processTranscript(fp.file)
    const dir = rec?.cwd ? rec.cwd.replace(/^~/, os.homedir()) : null
    if (!dir || !fs.existsSync(dir)) continue
    if (project && !dir.startsWith(project)) continue
    out.push({ analysed: a, session: a.id, text: fp.text, rec, dir, sessionModel: rec?.model?.startsWith('claude-') ? rec.model : null })
  }
  return out
}

/** `opt optimize plan`: what each temperature would do for one session, best case against worst. */
export function cmdPlan(f, entries = strategyEntries()) {
  const g = goalArgs(f)
  let list = []
  if (f.session) { const a = analysisFor(f.session); if (!a) { console.error(`session ${f.session} has not been analysed — opt analyse`); return 2 }; list = eligibleSessions({ ...f, project: null }).filter((x) => x.session === a.id); if (!list.length) list = [{ analysed: a, session: a.id, rec: processTranscript(findTranscript(a.id)), dir: '' }] }
  else list = eligibleSessions(f)
  if (!list.length) { console.error('no eligible sessions — run opt analyse first (and --project to narrow it)'); return 2 }
  for (const x of list) {
    const s = x.rec
    console.log(`\n  ${C.b}${x.session.slice(0, 8)}${C.x}  ${path.basename(x.dir || s?.cwd || '')} · ${s?.model ?? '?'} · ${money(s?.cost)} · ${x.analysed.mode.label} ${x.analysed.work.label}`)
    console.log(`  ${C.d}${pad('GOAL ' + g.goal, 15)}${pad('PROPOSAL', 40)}${pad('RISK', 8)}${pad('BEST CASE', 13)}WORST CASE${C.x}`)
    for (const t of TEMPERATURES) {
      const p = propose(s, { goal: g.goal, temperature: t, work: x.analysed.work.label, runnable: runnableIn(entries) })
      const k = p.pick
      if (!k) { console.log(`  ${pad(t, 15)}${C.d}nothing fits${C.x}`); continue }
      console.log(`  ${pad(t, 15)}${pad(k.levers.join(' + '), 40)}${RISK_C[k.risk]}${pad(k.risk, 8)}${C.x}${C.g}${pad(k.best.text, 13)}${C.x}${C.d}${pad(k.worst, Math.max(30, (process.stdout.columns || 132) - 82))}${C.x}`)
    }
  }
  console.log(`\n  ${C.d}best case is priced from each session's own tokens (a ceiling); every worst case is caught by the hidden check or the baseline compare${C.x}`)
  console.log(`  ${C.d}run it: opt claude -p --session <id> --goal ${g.goal} --temperature <t> --compare   ·   all of them: … --eligible${C.x}\n`)
  return 0
}

/**
 * `opt optimize <goal> <temperature> --eligible`: every non-interactive session, optimized on
 * this machine, each against its own baseline, each graded by its own hidden check
 * (--checks <dir>/<project>.py), all in parallel. Ends with one ledger.
 */
async function cmdEligible(f, entries, needSecrets) {
  const list = eligibleSessions(f)
  if (!list.length) { console.error('no eligible sessions — run opt analyse first (and --project to narrow it)'); return 2 }
  const g = goalArgs(f)
  const repeats = Math.max(1, Number(f.repeats ?? 1))
  const checkFor = (dir) => {
    if (!f.checks) return null
    for (const ext of Object.keys(RUNNER)) { const c = path.resolve(f.checks, path.basename(dir) + ext); if (fs.existsSync(c)) return c }
    return null
  }
  const jobs = list.map((x) => ({ ...x, check: checkFor(x.dir), choice: chooseStrategy({ ...f, _: f._.filter((a) => a !== 'plan') }, entries, { session: x.session, analysed: x.analysed }) }))
  const batch = startTask('optimize-batch', { goal: g.goal, temperature: g.temperature, sessions: jobs.map((j) => j.session), repeats })

  console.log(`\n  ${C.b}opt optimize${C.x} ${C.b}${g.goal}${C.x} · ${g.temperature}  ${C.d}every non-interactive session, optimized on this machine${C.x}\n`)
  console.log(`  ${C.d}${pad('SESSION', 10)}${pad('PROJECT', 18)}${pad('PROPOSAL', 42)}${pad('RISK', 8)}${pad('BEST CASE', 14)}CHECK${C.x}`)
  for (const j of jobs) {
    const k = j.choice.proposal?.pick
    console.log(`  ${pad(j.session.slice(0, 8), 10)}${pad(path.basename(j.dir), 18)}${pad(k ? k.levers.join(' + ') : j.choice.strategyId ?? '—', 42)}${k ? RISK_C[k.risk] + pad(k.risk, 8) + C.x : pad('', 8)}${C.g}${pad(k?.best?.text ?? '', 14)}${C.x}${C.d}${j.check ? path.basename(j.check) : 'none'}${C.x}`)
  }
  console.log(`\n  ${C.d}${jobs.length} sessions × (baseline + proposal) × ${repeats} = ${jobs.length * 2 * repeats} sandbox runs, ${parallelLimit()} at a time${C.x}`)

  const t0 = Date.now(), prog = new Map()
  const draw = () => {
    if (!process.stderr.isTTY) return
    const parts = jobs.map((j) => { const p = prog.get(j.session); return `${path.basename(j.dir)} ${p ? `${p.done}/${p.total}` : '…'}` })
    process.stderr.write(`\r  ${C.d}${Math.round((Date.now() - t0) / 1000)}s · ${parts.join(' · ')}${C.x}`.padEnd(110))
  }
  const timer = setInterval(draw, 1000)
  const results = await Promise.all(jobs.map((j) => j.choice.error ? { code: 2, error: j.choice.error } : runOptimize({
    f: { ...f, check: j.check, baseline: true }, entries, needSecrets, text: j.text, session: j.session, dir: j.dir,
    analysed: j.analysed, sessionModel: j.sessionModel, choice: j.choice, quiet: true,
    onProgress: (arms, live) => { prog.set(j.session, { total: arms.length, done: arms.filter((a) => /^done|failed/.test(live.get(a.label) ?? '')).length }) },
  })))
  clearInterval(timer)
  if (process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(110) + '\r')

  console.log(`  ${C.d}${pad('SESSION', 10)}${pad('PROJECT', 18)}${pad('BASELINE', 10)}${pad('OPTIMIZED', 11)}${pad('SAVING', 9)}${pad('CHECK', 12)}VERDICT${C.x}`)
  let B = 0, S = 0, kept = 0
  const rows = []
  for (const [i, r] of results.entries()) {
    const j = jobs[i]
    if (!r.base) { console.log(`  ${pad(j.session.slice(0, 8), 10)}${pad(path.basename(j.dir), 18)}${C.r}${r.error ?? 'did not run'}${C.x}`); continue }
    const b = median(r.base.map((x) => x.cost_usd)) ?? 0, s = median(r.strat.map((x) => x.cost_usd)) ?? 0
    const pass = (rs) => `${rs.filter((x) => x.check === 'pass').length}/${rs.length}`
    const v = r.verdict?.verdict
    if (v === 'keep') { kept++; B += b; S += s } else { B += b; S += b }   // a dropped proposal keeps the baseline cost
    const sav = b ? (s - b) / b * 100 : 0
    const vc = v === 'keep' ? C.g + '✓ keep' : v === 'drop' ? C.r + '✗ drop' : C.y + '? ' + (v ?? '—')
    rows.push({ session: j.session, project: path.basename(j.dir), strategy: r.strategyId, baseline_usd: b, optimized_usd: s, verdict: v, task: r.task })
    console.log(`  ${pad(j.session.slice(0, 8), 10)}${pad(path.basename(j.dir), 18)}${pad(money(b), 10)}${pad(money(s), 11)}${sav <= 0 ? C.g : C.r}${pad((sav <= 0 ? '−' : '+') + Math.abs(sav).toFixed(0) + '%', 9)}${C.x}${pad(pass(r.base) + ' · ' + pass(r.strat), 12)}${vc}${C.x}`)
  }
  const tot = B ? (S - B) / B * 100 : 0
  console.log(`  ${C.d}${'─'.repeat(78)}${C.x}`)
  console.log(`  ${pad('per run of all ' + jobs.length + ' jobs', 28)}${pad(money(B), 10)}${C.b}${pad(money(S), 11)}${C.x}${C.g}${C.b}${pad('−' + Math.abs(tot).toFixed(0) + '%', 9)}${C.x}${pad('', 12)}${kept} of ${jobs.length} kept`)
  console.log(`\n  ${C.d}kept proposals at their measured cost, dropped ones at baseline cost · CHECK = baseline · proposal passes${repeats < 3 ? ` · n = ${repeats}: a direction, not a finding` : ` · n = ${repeats} per side`}${C.x}`)
  const spent = results.reduce((a, r) => a + (r.totalCost ?? 0), 0)
  // the experiment is paid once; the saving repeats every time these jobs run
  const perRun = B - S
  if (perRun > 0) {
    const payback = Math.ceil(spent / perRun)
    console.log(`  ${C.b}payback${C.x}   this check cost ${money(spent)} once and saves ${money(perRun)} on every run of these ${jobs.length} jobs → ${C.g}${C.b}pays for itself after ${payback} run${payback === 1 ? '' : 's'}${C.x}`)
    console.log(`  ${C.d}          nightly, that is ${money(perRun * 30)} saved a month (priced from the measured runs above)${C.x}`)
  }
  batch.end({ sessions: jobs.length, kept, baseline_usd: +B.toFixed(4), optimized_usd: +S.toFixed(4), saving_pct: +tot.toFixed(1), spent_usd: +spent.toFixed(4), payback_runs: perRun > 0 ? Math.ceil(spent / perRun) : null, rows })
  console.log(`  ${C.d}audit: opt audit ${batch.id}${C.x}\n`)
  return 0
}

/** One session or task: strategy (and baseline) in the sandbox, checked, compared, audited. */
async function runOptimize({ f, entries, needSecrets, text, session, dir, analysed, sessionModel, choice, quiet = false, onProgress }) {
  const log = quiet ? () => {} : console.log
  // ---- which strategy, and the baseline it is measured against
  const { strategyId, strategyWhy, proposal } = choice
  const parts = strategyId.split('+').map((id) => entries.find((e) => e.id === id))
  if (parts.some((e) => !e)) { console.error(`unknown strategy '${strategyId}' — opt optimize strategies`); return { code: 2 } }
  const baseModel = f.model ?? sessionModel
  const plan = withModel(mergePlans(parts.map(localPlan)), baseModel)
  if (plan.error) { console.error(`cannot run ${strategyId} locally: ${plan.error}`); return { code: 2 } }
  const basePlan = withModel(localPlan(entries.find((e) => e.id === 'baseline')), baseModel)
  const withBaseline = strategyId !== 'baseline' && !f['no-baseline'] && (f.baseline || !!session)
  const repeats = Math.max(1, Number(f.repeats ?? 1))
  const checkFile = f.check ? path.resolve(f.check) : hiddenCheck(dir)
  if (checkFile && !fs.existsSync(checkFile)) { console.error(`--check: ${f.check} does not exist`); return { code: 2 } }
  if (checkFile && !RUNNER[path.extname(checkFile)]) { console.error(`--check: use a .py, .sh or .js file`); return { code: 2 } }

  const timeoutSec = seconds(f.timeout ?? '30m') ?? 1800
  const extraFlags = f.budget ? [`--max-budget-usd ${Number(f.budget)}`] : []
  const basePrompt = text.trim()
  const stratPrompt = basePrompt + (plan.appendPrompt ? `\n\n## Working rules\n\n${plan.appendPrompt}\n` : '')

  if (f['dry-run']) {
    log(`\n  ${C.b}opt optimize${C.x} ${strategyId}  ${C.d}(${strategyWhy})${C.x}`)
    printProposal(log, proposal)
    log(`  source     ${tilde(dir)} (read-only)\n  task       ${basePrompt.length} chars${session ? ` · from session ${session.slice(0, 8)}` : ''}`)
    log(`  runs    ${withBaseline ? `baseline ×${repeats} + ` : ''}${strategyId} ×${repeats}${checkFile ? ` · check ${path.basename(checkFile)}` : ''}`)
    for (const n of plan.notes) log(`  ${C.y}note${C.x}    ${n}`)
    log(`\n${C.d}${containerScript(plan, { timeoutSec, extraFlags })}${C.x}\n`)
    return { code: 0 }
  }

  // ---- credentials: exactly one goes into the sandbox
  // OPT_ANTHROPIC_API_KEY is for the sandbox only: setting ANTHROPIC_API_KEY would also switch the
  // Claude Code session that calls /optimize off its own login
  // The same path as opt claude: the subscription by default (the Keychain token from `opt claude optimize
  // login`, then CLAUDE_CODE_OAUTH_TOKEN), an API key only when asked for (--auth api-key, AUTH_MODE=api-key).
  if (!process.env.ANTHROPIC_API_KEY && process.env.OPT_ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = process.env.OPT_ANTHROPIC_API_KEY
  const wantKey = (f.auth ?? process.env.OPT_AUTH ?? process.env.AUTH_MODE) === 'api-key'
  try { needSecrets?.([wantKey ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN']) } catch {}
  const cred = launcherCredential({ ...process.env, AUTH_MODE: wantKey ? 'api-key' : 'subscription', ULT_AUTH_MODE: wantKey ? 'api-key' : 'subscription' })
  if (!cred) {
    console.error(wantKey ? '--auth api-key: ANTHROPIC_API_KEY is not set (opt secrets)'
      : 'no Claude subscription token: opt claude optimize login, or CLAUDE_CODE_OAUTH_TOKEN in .env (opt secrets); --auth api-key for an API key')
    return { code: 2 }
  }
  process.env[cred.env] = cred.value                  // a Keychain token is not in the environment yet
  const auth = cred.kind === 'api-key' ? 'api-key' : 'oauth'
  log(`  ${C.d}auth       ${auth === 'oauth' ? 'Claude subscription' : 'API key (bills credits)'} from ${cred.source}${C.x}`)
  const armEnv = auth === 'api-key' ? { CLAUDE_CODE_OAUTH_TOKEN: '' } : { ANTHROPIC_API_KEY: '' }

  // ---- a cached baseline for this exact task, tree, model and check is reused
  const baseKey = sha256([basePrompt, dir, basePlan.flags.join(' '), checkFile ? sha256(fs.readFileSync(checkFile)) : ''].join('\0')).slice(0, 16)
  const baseCacheFile = path.join(STATE_DIR, 'baselines', `${baseKey}.json`)
  let cachedBase = null
  if (withBaseline && !f['fresh-baseline']) { try { const c = JSON.parse(fs.readFileSync(baseCacheFile, 'utf8')); if (c.runs?.length >= repeats) cachedBase = c } catch {} }

  const task = startTask('optimize', {
    strategy: strategyId, strategy_why: strategyWhy, goal: proposal?.goal ?? null, temperature: proposal?.temperature ?? null,
    risk: proposal?.pick?.risk ?? null, best_case: proposal?.pick?.best?.text ?? null, source: session ? 'session' : 'task', session,
    session_mode: analysed?.mode?.label ?? null, forced: !!(analysed && !analysed.eligible && f.force),
    task_sha256: sha256(basePrompt), task_chars: basePrompt.length, dir: tilde(dir),
    flags: plan.flags.concat(extraFlags), env: Object.keys(plan.env), timeout_s: timeoutSec, auth,
    baseline: withBaseline ? (cachedBase ? 'cached' : 'run') : 'none', repeats, check: checkFile ? path.basename(checkFile) : null,
  })
  const taskDir = path.join(outRoot(), task.id)
  fs.mkdirSync(taskDir, { recursive: true })
  log(`\n  ${C.b}opt optimize${C.x} ${strategyId}  ${C.d}${strategyWhy}${C.x}`)
  printProposal(log, proposal)
  log(`  task       ${task.id}`)
  log(`  source     ${tilde(dir)} ${C.d}(read-only)${C.x}`)
  log(`  runs       ${withBaseline ? `baseline ×${repeats}${cachedBase ? ' (cached)' : ''} + ` : ''}${strategyId} ×${repeats}, in parallel${checkFile ? ` · hidden check ${path.basename(checkFile)}` : ''}`)
  for (const n of plan.notes) log(`  ${C.y}note${C.x}     ${n}`)

  const arms = []
  if (withBaseline && !cachedBase) for (let i = 1; i <= repeats; i++) arms.push({ side: 'baseline', label: `baseline-${i}`, plan: basePlan, prompt: basePrompt })
  for (let i = 1; i <= repeats; i++) arms.push({ side: 'strategy', label: `${strategyId}-${i}`, plan, prompt: stratPrompt })

  const sandboxSh = SANDBOX_SH
  const t0 = Date.now()
  const live = new Map()
  const tick = () => {
    if (quiet) { onProgress?.(arms, live); return }
    if (!process.stderr.isTTY) return
    // one short line per side, so six parallel runs never wrap the terminal
    const side = (name) => {
      const mine = arms.filter((a) => a.side === name)
      if (!mine.length) return null
      const st = mine.map((a) => live.get(a.label) ?? 'starting')
      const turns = st.reduce((n, x) => n + (Number(/^(\d+) turns/.exec(x)?.[1]) || 0), 0)
      const done = st.filter((x) => x.startsWith('done')).length, failed = st.filter((x) => x === 'failed').length
      return `${name === 'baseline' ? 'baseline' : strategyId}: ${done}/${mine.length} done${failed ? `, ${failed} failed` : ''}${turns ? ` · ${turns} turns` : ''}`
    }
    const line = `${Math.round((Date.now() - t0) / 1000)}s · ${[side('baseline'), side('strategy')].filter(Boolean).join('   ')}`
    process.stderr.write(`\r  ${C.d}${line.slice(0, (process.stderr.columns || 120) - 6).padEnd(Math.min(100, (process.stderr.columns || 120) - 6))}${C.x}`)
  }
  async function runArm(a) {
    const outDir = path.join(taskDir, a.label)
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'task.md'), a.prompt)
    task.event('run-start', { run: a.label, side: a.side, flags: a.plan.flags.concat(extraFlags), container: `${task.id}-${a.label}` })
    const ev = path.join(outDir, 'events.jsonl')
    const poll = setInterval(() => { live.set(a.label, `${readResult(ev).turns} turns`); tick() }, 2000)
    const { code, stderr } = await runSandbox({ sandboxSh, src: dir, outDir, name: `${task.id}-${a.label}`,
      script: containerScript(a.plan, { timeoutSec, extraFlags }), env: armEnv })
    clearInterval(poll)
    const { result, model, turns } = readResult(ev)
    const work = path.join(outDir, 'workspace')
    const diff = fs.existsSync(work) ? diffTrees(dir, work) : { added: [], changed: [] }
    const r = {
      run: a.label, side: a.side, exit: code, is_error: result?.is_error ?? (code !== 0), model,
      error: result?.is_error ? String(result.result ?? '').split('\n')[0].slice(0, 120) : (!result ? stderr.trim().split('\n').slice(-1)[0]?.slice(0, 120) ?? `exit ${code}` : null),
      cost_usd: result?.total_cost_usd ?? null, turns: result?.num_turns ?? turns, duration_ms: result?.duration_ms ?? null,
      files_added: diff.added.length, files_changed: diff.changed.length, files: [...diff.added.map((x) => '+' + x), ...diff.changed.map((x) => '~' + x)],
      timed_out: code === 124, check: null,
    }
    live.set(a.label, r.is_error ? 'failed' : 'checking'); tick()
    if (checkFile && fs.existsSync(work) && !r.is_error) {
      // the check runs in a second sandbox, against the finished workspace mounted read-only
      const cDir = path.join(outDir, 'check')
      fs.mkdirSync(cDir, { recursive: true })
      const name = 'check' + path.extname(checkFile)
      fs.copyFileSync(checkFile, path.join(cDir, name))
      const c = await runSandbox({ sandboxSh, src: work, outDir: cDir, name: `${task.id}-${a.label}-check`,
        script: `cd /work/src && ${RUNNER[path.extname(checkFile)]} /work/out/${name} > /work/out/check.log 2>&1; echo $? > /work/out/check_code; exit 0`, env: armEnv })
      let cc = NaN; try { cc = Number(fs.readFileSync(path.join(cDir, 'check_code'), 'utf8').trim()) } catch {}
      r.check = cc === 0 ? 'pass' : 'fail'
      if (c.code !== 0 && Number.isNaN(cc)) r.check = 'error'
    }
    live.set(a.label, r.is_error ? 'failed' : `done${r.check ? ' · ' + r.check : ''}`); tick()
    task.event('run-end', r)
    return r
  }

  let results
  try { results = await Promise.all(arms.map(runArm)) }
  catch (e) { task.fail(e); console.error(`\n  optimize failed: ${e.message}`); return { code: 1 } }
  if (!quiet && process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(120) + '\r')

  const strat = results.filter((r) => r.side === 'strategy')
  let base = results.filter((r) => r.side === 'baseline')
  if (withBaseline && cachedBase) base = cachedBase.runs.slice(0, repeats)
  if (withBaseline && !cachedBase && base.every((r) => !r.is_error)) {
    fs.mkdirSync(path.dirname(baseCacheFile), { recursive: true })
    fs.writeFileSync(baseCacheFile, JSON.stringify({ key: baseKey, task: task.id, runs: base }, null, 1))
  }

  // ---- report
  const sideSummary = (rs) => ({
    model: rs[0]?.model ?? '—', cost: median(rs.map((r) => r.cost_usd)), turns: median(rs.map((r) => r.turns)),
    secs: median(rs.map((r) => r.duration_ms && r.duration_ms / 1000)), files: median(rs.map((r) => r.files_added + r.files_changed)),
    check: checkFile ? `${rs.filter((r) => r.check === 'pass').length}/${rs.length} pass` : '—', failed: rs.filter((r) => r.is_error).length,
  })
  const S = sideSummary(strat)
  let verdict = null
  if (withBaseline) {
    const B = sideSummary(base)
    verdict = verdictOf(base, strat, { hasCheck: !!checkFile, goal: proposal?.goal ?? 'cost' })
    const anyFailed = B.failed || S.failed
    const ch = (b, s, unit = '') => (anyFailed || b == null || s == null ? '' : b === 0 ? '' : `${s <= b ? C.g : C.r}${s - b >= 0 ? '+' : '−'}${Math.abs((s - b) / b * 100).toFixed(0)}%${C.x}`)
    const W = Math.max(22, strategyId.length + 3)
    const row = (k, b, s, d = '') => log(`  ${pad(k, 12 + (k.includes('\x1b') ? 8 : 0))}${pad(b, W)}${pad(s, W)}${d}`)
    log(`\n  ${C.d}${pad('', 12)}${pad('baseline' + (cachedBase ? ' (cached)' : ''), W)}${pad(strategyId, W)}change${C.x}`)
    row('  model', B.model, S.model)
    const goalOf = proposal?.goal ?? 'cost', mark = (k, on) => (on ? `${C.b}▸ ${k}${C.x}` : `  ${k}`)
    row(mark('cost', goalOf !== 'latency'), money(B.cost), money(S.cost), ch(B.cost, S.cost))
    row('  turns', B.turns ?? '—', S.turns ?? '—', ch(B.turns, S.turns))
    row(mark('time', goalOf !== 'cost'), B.secs != null ? `${Math.round(B.secs)}s` : '—', S.secs != null ? `${Math.round(S.secs)}s` : '—', ch(B.secs, S.secs))
    row('  files', B.files ?? '—', S.files ?? '—')
    if (checkFile) row('  check', B.check, S.check)
    const vc = verdict.verdict === 'keep' ? C.g : verdict.verdict === 'drop' ? C.r : C.y
    const word = { keep: '✓ keep it', drop: '✗ drop it', inconclusive: '? inconclusive' }[verdict.verdict]
    log(`\n  ${vc}${C.b}${word}${C.x}  ${verdict.reason}`)
    if (repeats < 3) log(`  ${C.d}n = ${repeats} per side: a direction, not a finding. --repeats 3 before acting on it.${C.x}`)
    task.event('compare', { verdict: verdict.verdict, reason: verdict.reason, goal: proposal?.goal ?? 'cost', temperature: proposal?.temperature ?? null,
      strategy: strategyId, base_cost: B.cost, strat_cost: S.cost, base_secs: B.secs, strat_secs: S.secs, base_check: B.check, strat_check: S.check, n: repeats, baseline_cached: !!cachedBase })
  } else {
    const r = strat[0]
    log(`\n  ${r.is_error ? C.r + '✗ ' + (r.timed_out ? 'timed out' : r.error) : C.g + '✓ done'}${C.x}  ${money(r.cost_usd)} · ${r.turns} turns · ${r.duration_ms ? Math.round(r.duration_ms / 1000) + 's' : ''} · ${r.model ?? ''}${r.check ? ` · check ${r.check}` : ''}`)
  }
  for (const r of strat.slice(0, 1)) {
    log(`  files    ${r.files_added} added, ${r.files_changed} changed ${C.d}(measured from the tree)${C.x}`)
    for (const p of r.files.slice(0, 8)) log(`           ${C.d}${p.replace(/^\+/, '+ ').replace(/^~/, '~ ')}${C.x}`)
  }
  for (const r of results.filter((x) => x.is_error)) log(`  ${C.r}${r.run}: ${r.timed_out ? 'timed out' : r.error}${C.x}`)

  const totalCost = results.reduce((a, r) => a + (r.cost_usd ?? 0), 0)
  fs.writeFileSync(path.join(taskDir, 'run.json'), JSON.stringify({ task: task.id, strategy: strategyId, session, verdict, baseline_cached: !!cachedBase, runs: results }, null, 1))
  const endData = { cost_usd: +totalCost.toFixed(4), runs: results.length, failed: results.filter((r) => r.is_error).length,
    verdict: verdict?.verdict ?? null, is_error: strat.every((r) => r.is_error), files_changed: S.files }
  task.end(endData)
  log(`\n  ${C.d}spent ${money(totalCost)} · results ${tilde(taskDir)} · opt audit ${task.id}${C.x}\n`)
  return { code: strat.every((r) => !r.is_error) ? 0 : 1, task: task.id, strategyId, verdict, base, strat, totalCost, check: checkFile ? path.basename(checkFile) : null, baselineCached: !!cachedBase }
}

// ------------------------------------------------------------------ projection
/**
 * `opt audit --projection`: the latest kept comparison, applied to every non-interactive session
 * this machine ran in the last N days. Measured % × measured volume — a projection, labelled so.
 */
async function cmdProjection(f) {
  const days = Number(f.days ?? 30)
  const compares = readTasks().filter((e) => e.event === 'compare' && e.verdict === 'keep')
  const m = f._[0] ? compares.filter((e) => e.task.startsWith(f._[0])).at(-1) : compares.at(-1)
  if (!m) { console.error('no kept comparison in the audit log yet — run opt optimize with a baseline first'); return 2 }
  const dt = m.base_secs && m.strat_secs != null ? (m.strat_secs - m.base_secs) / m.base_secs : null
  const dc = m.base_cost && m.strat_cost != null ? (m.strat_cost - m.base_cost) / m.base_cost : null
  const { buildIndex } = await import('./lib/sessions-index.mjs')
  const since = Date.now() - days * 86400e3
  const byId = new Map(buildIndex({ limit: 5000 }).sessions.map((s) => [s.id, s]))
  const pop = allAnalysed().filter((a) => a.eligible && Date.parse(a.startedAt ?? '') >= since).map((a) => byId.get(a.id)).filter(Boolean)
  const hours = pop.reduce((n, s) => n + (s.durationMin ?? 0), 0) / 60
  const cost = pop.reduce((n, s) => n + (s.cost ?? 0), 0)
  const pctS = (x) => (x == null ? '—' : `${x < 0 ? '−' : '+'}${Math.abs(x * 100).toFixed(0)}%`)
  const hrs = (h) => (Math.abs(h) < 1 ? `${Math.round(Math.abs(h) * 60)} min` : `${Math.abs(h).toFixed(1)} h`)
  const signed = (v, fmt) => `${v < 0 ? '−' : '+'}${fmt(Math.abs(v))}`
  console.log(`\n  ${C.b}opt audit --projection${C.x}  ${C.d}a measured change × the sessions it applies to on this machine${C.x}\n`)
  console.log(`  ${C.b}${pad('measured', 12)}${C.x}${m.task}  ${C.d}goal ${m.goal ?? 'cost'}${m.temperature ? ' · ' + m.temperature : ''}${m.strategy ? ' · ' + m.strategy.split('+').join(' + ') : ''} · n = ${m.n} per side${C.x}`)
  console.log(`  ${pad('', 12)}time ${C.g}${pctS(dt)}${C.x}${dt != null ? ` (${Math.round(m.base_secs)}s → ${Math.round(m.strat_secs)}s)` : ''}   cost ${C.g}${pctS(dc)}${C.x} (${money(m.base_cost)} → ${money(m.strat_cost)})   check ${m.base_check} · ${m.strat_check}`)
  console.log(`\n  ${C.b}${pad('volume', 12)}${C.x}${pop.length} non-interactive sessions in the last ${days} days   run time ${hrs(hours)}   cost ${money(cost)}`)
  if (!pop.length) { console.log(`  ${C.d}run opt analyse first, so there is a population to project onto${C.x}\n`); return 0 }
  const pt = dt != null ? hours * dt : null, pc = dc != null ? cost * dc : null
  const yr = 365 / days
  console.log(`  ${C.b}${pad('projected', 12)}${C.x}if they all ran with this change:   run time ${C.g}${C.b}${pt != null ? signed(pt, hrs) : '—'}${C.x}   cost ${C.g}${C.b}${pc != null ? signed(pc, money) : '—'}${C.x}   per ${days} days`)
  console.log(`  ${pad('', 12)}${C.d}at this rate for a year:            run time ${pt != null ? signed(pt * yr, hrs) : '—'}   cost ${pc != null ? signed(pc * yr, money) : '—'}${C.x}`)
  console.log(`\n  ${C.d}projection, not a measurement: it assumes those sessions respond like the measured task.${m.n < 3 ? ' n < 3: a direction only.' : ''} Interactive sessions are not counted: opt optimize does not touch them.${C.x}\n`)
  return 0
}

// ------------------------------------------------------------------ audit
export async function cmdAudit(argv) {
  const f = flagsOf(argv, { bool: ['verify', 'json', 'projection'] })
  if (f.projection) return cmdProjection(f)
  if (f.verify) {
    const v = verifyAudit(AUDIT_FILE)
    console.log(v.ok ? `${C.g}✓${C.x} ${v.entries} entries, chain intact  ${C.d}${tilde(AUDIT_FILE)}${C.x}` : `${C.r}✗ chain broken at entry ${v.brokenAt}: ${v.reason}${C.x}`)
    return v.ok ? 0 : 1
  }
  const entries = readTasks()
  if (f._[0]) {
    const mine = entries.filter((e) => e.task === f._[0] || e.task.startsWith(f._[0]))
    if (f.json) { console.log(JSON.stringify(mine, null, 1)); return 0 }
    for (const e of mine) {
      const { seq, ts, task, kind, event, prev_hash, hash, ...rest } = e
      console.log(`  ${C.d}${pad(seq, 6)}${ts}${C.x}  ${pad(event, 14)}${C.d}${JSON.stringify(rest)}${C.x}`)
    }
    return 0
  }
  const rows = summarizeTasks(entries).slice(0, Number(f.rows ?? 25))
  if (f.json) { console.log(JSON.stringify(rows, null, 1)); return 0 }
  console.log(`\n  ${C.b}opt audit${C.x}  ${C.d}${tilde(AUDIT_FILE)} · ${entries.length} entries${C.x}\n`)
  console.log(`  ${C.d}${pad('TASK', 38)}${pad('KIND', 16)}${pad('STATE', 9)}${pad('STARTED', 21)}SUMMARY${C.x}`)
  for (const t of rows) {
    const e = t.end ?? {}
    const sum = t.kind === 'analyse' ? `${e.sessions ?? '…'} sessions · ${e.eligible ?? '…'} eligible · ${e.via_jev ?? 0} by jev`
      : t.kind === 'optimize-batch' ? `${e.sessions ?? '…'} sessions · ${e.kept ?? '…'} kept · ${e.saving_pct != null ? (e.saving_pct < 0 ? '−' : '+') + Math.abs(Math.round(e.saving_pct)) + '%' : '…'} · pays back in ${e.payback_runs ?? '—'} runs`
      : t.kind === 'optimize' ? `${t.start?.strategy} · ${money(e.cost_usd)} · ${e.files_changed ?? '…'} files${e.verdict ? ' · ' + e.verdict : ''}${e.error ? ' · ' + e.error : ''}` : ''
    const st = t.state === 'done' ? C.g : t.state === 'failed' ? C.r : C.y
    console.log(`  ${pad(t.task, 38)}${pad(t.kind, 16)}${st}${pad(t.state, 9)}${C.x}${pad(t.started?.slice(0, 19).replace('T', ' '), 21)}${C.d}${pad(sum, Math.max(30, (process.stdout.columns || 132) - 87))}${C.x}`)
  }
  console.log(`\n  ${C.d}opt audit <task> for every event · opt audit --verify checks the hash chain${C.x}\n`)
  return 0
}
