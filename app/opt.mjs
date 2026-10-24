#!/usr/bin/env node
/**
 * opt — inspect harness experiments, running or finished.
 *
 *   opt experiments ls                list every run this machine knows about
 *   opt experiments ps                only what is live in E2B right now
 *   opt experiments status [runId]    gather evidence and have Claude judge: healthy or stuck?
 *   opt experiments logs <runId>      tail what each arm's agent has written
 *   opt experiments kill <runId|all>  stop sandboxes
 *
 * `status` is the interesting one: it collects hard evidence — heartbeat age,
 * sandbox liveness, CPU, workspace contents, stderr tails — and asks Claude
 * (sonnet, cheap) to reason about whether a run is progressing or wedged.
 */
import { Sandbox } from '../sandbox/e2b/index.mjs'
import { STATE as STATE_DIR, ENV_FILE, REPO_ROOT } from './lib/state.mjs'
import { resolveSecrets, parseEnvFile, verifyKey, opFindAnthropic, opAvailable, isOpRef } from './secrets.mjs'
import { startUi, snapshot, resolveRunId } from './statusui.mjs'
import { collectSessions, countAll, findSession, renderTable, renderContext, startSessionsUi,
         parseSince, describeWindow, sortSessions, SORTS, DEFAULT_SINCE_MS } from './sessions.mjs'
import { oldestOnDisk } from './transcripts.mjs'
import { exportSession, renderExport, resolveSession } from './export.mjs'
import { runBundle, preflightAuth } from './sandbox.mjs'
import { getRunner, listRunners } from './runners.mjs'
import { replay, renderReplay, startLocalSession } from './replay.mjs'
import { startExperimentsUi, collectExperiments, headline } from './experiments.mjs'
import { watchList } from './lib/watch.mjs'
import { parseDateSpec, describeRange } from './lib/daterange.mjs'
import { initReport } from './init.mjs'
import { tune, renderTuning } from './tune.mjs'
import { startTrace, ensureProject, enabled as tracingOn, projectUrl, PROJECT as LS_PROJECT } from './langsmith.mjs'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const RESULTS = path.join(STATE_DIR, 'results')
// Plain .env values are free to read. `op://` references are NOT: each one runs
// `op read`, which raises a Touch ID prompt. Resolving them at module load meant
// every command paid for every secret — `opt ls` asked three times before it
// printed a row. They are resolved lazily now, by the commands that need them.
const ENV_VALUES = parseEnvFile(ENV_FILE)
for (const [k, v] of Object.entries(ENV_VALUES))
  if (!process.env[k] && !isOpRef(v)) process.env[k] = v

const SECRET_KEYS = ['ANTHROPIC_API_KEY', 'E2B_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
                     'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']
let SECRETS = null

/**
 * Resolve the named secrets, once per process. Pass only what the command
 * actually needs: a key that is a 1Password reference costs an unlock prompt,
 * and a command that never calls the API should never ask for one.
 */
function needSecrets(keys = SECRET_KEYS) {
  const missing = keys.filter((k) => !process.env[k] && isOpRef(ENV_VALUES[k]))
  if (missing.length || !SECRETS) SECRETS = { ...(SECRETS ?? {}), ...resolveSecrets(keys) }
  return SECRETS
}

/** Exactly the credentials this runner will use, and nothing else. */
function secretsForRunner(runner) {
  const keys = []
  if (runner?.needsAnthropicAuth !== false) keys.push('ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN')
  if (runner?.needsAws) keys.push('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY')
  if (keys.length) needSecrets(keys)
}

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', m: '\x1b[35m',
            d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
const WORK = '/home/user/work'
const age = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 1000 : null)
const dur = (s) => (s == null ? '—' : s < 90 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`)

const STATE = {
  done: `${C.g}done${C.x}`, failed: `${C.r}failed${C.x}`, running: `${C.y}running${C.x}`,
  stale: `${C.r}stale${C.x}`, unknown: `${C.d}unknown${C.x}`,
}

// ---------------------------------------------------------------- gather
function localRuns() {
  if (!fs.existsSync(RESULTS)) return []
  return fs.readdirSync(RESULTS).filter((d) => !d.startsWith('.'))
    .map((id) => ({ id, t: (() => { try { return fs.statSync(path.join(RESULTS, id)).mtimeMs } catch { return 0 } })() }))
    .sort((a, b) => b.t - a.t).map((x) => x.id).map((id) => {
    const dir = path.join(RESULTS, id)
    const rd = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { return null } }
    const status = rd('status.json')
    const final = rd('run.json')
    const arms = final
      ? final.arms.map((a) => ({ arm: a.arm, step: (a.fatal && !a.grade) ? 'failed' : 'done', sandboxId: a.sandboxId,
          passed: a.grade?.passed ?? null, total: a.grade?.total ?? null, cost: a.result?.total_cost_usd ?? null,
          at: null, finished: true }))
      : Object.values(status?.arms ?? {})
    return { id, dir, session: final?.session ?? status?.session ?? null,
             experiment: final?.experiment ?? status?.experiment ?? '—',
             model: final?.model ?? status?.model ?? '—', complete: !!final,
             updatedAt: status?.updatedAt ?? null, pid: status?.pid ?? null, arms }
  })
}

async function liveSandboxes() {
  try {
    const all = await Sandbox.list()
    const items = all?.sandboxes ?? all ?? []
    return items.filter((s) => s?.metadata?.harnessDemo === '1')
  } catch (e) { return { error: String(e?.message ?? e) } }
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

function classify(run, liveIds) {
  if (run.complete) return run.arms.some((a) => a.step === 'failed') ? 'failed' : 'done'
  const a = age(run.updatedAt)
  const anyLive = run.arms.some((x) => liveIds.has(x.sandboxId))
  const procLive = run.pid ? pidAlive(run.pid) : false
  if (!anyLive && !procLive) return a != null && a > 120 ? 'stale' : 'unknown'
  return a != null && a > 15 * 60 ? 'stale' : 'running'
}

// ---------------------------------------------------------------- commands
async function cmdLs({ live, session } = {}) {
  const sandboxes = await liveSandboxes()
  if (sandboxes.error) console.log(`${C.y}!${C.x} could not reach E2B: ${sandboxes.error}\n`)
  const liveIds = new Set((sandboxes.error ? [] : sandboxes).map((s) => s.sandboxId))
  const runs = localRuns()
    .filter((r) => !live || r.arms.some((a) => liveIds.has(a.sandboxId)))
    .filter((r) => !session || r.session === session)
  if (!runs.length) { console.log(`\n${C.d}no runs${C.x}\n`); return { runs: [], liveIds } }

  console.log('')
  console.log(`  ${C.d}${'RUN'.padEnd(34)}${'SESSION'.padEnd(14)}${'STATE'.padEnd(12)}${'UPDATED'.padEnd(9)}ARMS${C.x}`)
  for (const r of runs) {
    const st = classify(r, liveIds)
    // baseline first, then what was changed about it — the same relationship
    // `opt experiments ui` shows, so the two views agree.
    const ordered = [...r.arms].sort((a, b) =>
      (/^(control|baseline)$/.test(a.arm) ? 0 : 1) - (/^(control|baseline)$/.test(b.arm) ? 0 : 1))
    const arms = ordered.map((a, i) => {
      const dot = liveIds.has(a.sandboxId) ? C.g + '●' + C.x : C.d + '○' + C.x
      const noResult = a.step === 'done' && !a.total && !a.cost
      const sc = a.total ? ` ${a.passed}/${a.total}` : noResult ? ` ${C.y}no result${C.x}${C.d}` : ''
      const role = i === 0 ? 'baseline' : 'optimized'
      return `${dot} ${role}${C.d}(${a.arm}):${a.step}${sc}${C.x}`
    }).join(`  ${C.d}\u2192${C.x} `)
    console.log(`  ${r.id.slice(0, 32).padEnd(34)}${String(r.session ?? '—').slice(0, 12).padEnd(14)}` +
                `${STATE[st].padEnd(12 + 9)}${(r.updatedAt ? dur(age(r.updatedAt)) : '—').padEnd(9)}${arms}`)
  }
  console.log(`\n  ${C.d}● live in E2B   ○ gone${C.x}\n`)
  return { runs, liveIds }
}

/** Pull hard evidence out of a live sandbox — cheap, read-only. */
async function probeSandbox(id) {
  const out = { sandboxId: id }
  try {
    const sbx = await Sandbox.connect(id)
    const r = await sbx.commands.run(
      `echo "--- ps"; ps -eo pid,etime,pcpu,comm --sort=-pcpu | head -6; ` +
      `echo "--- work"; ls -la ${WORK} 2>/dev/null | head -20; ` +
      `echo "--- newest"; find ${WORK} -type f -newermt '-3 minutes' 2>/dev/null | head -10; ` +
      `echo "--- sheet"; wc -c ${WORK}/sheet.py 2>/dev/null || echo "sheet.py absent"; ` +
      `echo "--- err"; tail -c 700 /home/user/claude.err 2>/dev/null`,
      { timeoutMs: 30000 })
    out.probe = r.stdout.slice(0, 4000)
    try {
      const m = await sbx.getMetrics()
      const last = m?.[m.length - 1]
      if (last) out.metrics = { cpuPct: last.cpuUsedPct, memMiB: Math.round((last.memUsed ?? 0) / 1048576) }
    } catch {}
  } catch (e) { out.error = String(e?.message ?? e) }
  return out
}

const claude = (prompt) => new Promise((res) => {
  const env = { ...process.env }
  delete env.CLAUDE_CODE_OAUTH_TOKEN      // use this machine's own login, not the sandbox's
  execFile('claude', ['-p', '--model', 'sonnet', '--output-format', 'json',
                      '--strict-mcp-config', '--no-session-persistence', '--max-budget-usd', '0.30'],
    { timeout: 90000, maxBuffer: 16 * 1024 * 1024, env },
    (err, stdout, stderr) => {
      if (err && !stdout) return res({ error: `${String(err.message).slice(0, 160)} ${String(stderr ?? '').trim().slice(0, 240)}` })
      try {
        const j = JSON.parse(stdout)
        const text = String(j.result ?? '')
        const m = /\{[\s\S]*\}/.exec(text)
        res({ verdict: m ? JSON.parse(m[0]) : null, raw: text, cost: j.total_cost_usd })
      } catch (e) { res({ error: 'could not parse claude output', raw: stdout.slice(0, 400) }) }
    }).stdin.end(prompt)
})

/** Deterministic assessment, so `opt status` is still useful with no model available. */
function heuristic(ev) {
  const arms = ev.arms ?? []
  const failed = arms.filter((a) => a.step === 'failed')
  if (failed.length)
    return { state: 'failed', confidence: 'high',
             reason: `${failed.map((a) => a.arm).join(' and ')} reported step "failed".`,
             action: 'opt experiments logs to see why; the other arm may still finish' }
  const unfinished = arms.filter((a) => a.step !== 'done' && a.step !== 'failed')
  const hb = ev.run.heartbeatSecondsAgo
  if (ev.run.orchestratorAlive === false && unfinished.length)
    return { state: 'failed', confidence: 'high',
             reason: `The orchestrator process is gone while ${unfinished.length} arm(s) never reached "done".`,
             action: 'opt experiments kill ' + ev.run.id + ' , then re-run' }
  if (unfinished.some((a) => !a.sandboxLive))
    return { state: 'failed', confidence: 'medium',
             reason: 'An unfinished arm has no live sandbox — it died or timed out.',
             action: 'opt experiments logs ' + ev.run.id + ' to see the last output' }
  if (hb != null && hb > 15 * 60)
    return { state: 'stuck', confidence: 'medium',
             reason: `No heartbeat for ${Math.round(hb / 60)} minutes.`, action: 'opt experiments logs, then opt experiments kill if dead' }
  if (arms.length && arms.every((a) => a.step === 'grading' || a.step === 'done'))
    return { state: 'finishing', confidence: 'high', reason: 'All arms are grading or done.', action: 'wait' }
  return { state: 'progressing', confidence: 'low',
           reason: 'Sandboxes are live and the heartbeat is recent; long silent stretches are normal while an agent works.',
           action: 'wait' }
}

async function cmdStatus(runId) {
  const sandboxes = await liveSandboxes()
  const liveIds = new Set((sandboxes.error ? [] : sandboxes).map((s) => s.sandboxId))
  const runs = localRuns()
  const run = runId ? runs.find((r) => r.id.startsWith(runId)) : runs.find((r) => !r.complete) ?? runs[0]
  if (!run) { console.log(`\n${C.d}no such run${C.x}\n`); return }

  const st = classify(run, liveIds)
  console.log(`\n  ${C.b}${run.id}${C.x}  ${C.d}·${C.x} ${run.experiment}  ${C.d}·${C.x} ${STATE[st]}`)
  console.log(`  ${C.d}heartbeat ${run.updatedAt ? dur(age(run.updatedAt)) + ' ago' : 'never'}` +
              ` · orchestrator pid ${run.pid ?? '—'} ${run.pid ? (pidAlive(run.pid) ? 'alive' : 'gone') : ''}${C.x}\n`)

  const probes = []
  for (const a of run.arms) {
    const live = liveIds.has(a.sandboxId)
    console.log(`  ${live ? C.g + '●' + C.x : C.d + '○' + C.x} ${C.b}${a.arm}${C.x} ${C.d}${a.sandboxId ?? '—'}${C.x}`)
    console.log(`     step ${a.step}${a.at ? `, ${dur(age(a.at))} ago` : ''}` +
                `${a.total ? `, scored ${a.passed}/${a.total}` : ''}${a.cost != null ? `, $${Number(a.cost).toFixed(4)}` : ''}`)
    if (live) {
      const p = await probeSandbox(a.sandboxId)
      probes.push({ arm: a.arm, ...p })
      if (p.metrics) console.log(`     ${C.d}cpu ${p.metrics.cpuPct?.toFixed?.(1) ?? '?'}%  mem ${p.metrics.memMiB}MiB${C.x}`)
    }
  }

  if (run.complete) { console.log(`\n  ${C.d}finished — see results/${run.id}/report.html${C.x}\n`); return }

  // ---- reasoning pass
  console.log(`\n  ${C.c}◆${C.x} asking Claude to judge progress…`)
  const evidence = {
    now: new Date().toISOString(),
    run: { id: run.id, experiment: run.experiment, model: run.model,
           heartbeatSecondsAgo: age(run.updatedAt), orchestratorAlive: run.pid ? pidAlive(run.pid) : null },
    arms: run.arms.map((a) => ({ arm: a.arm, step: a.step, secondsSinceStep: age(a.at),
                                 sandboxLive: liveIds.has(a.sandboxId) })),
    sandboxProbes: probes,
  }
  const prompt = `You are monitoring an automated benchmark. Two cloud sandboxes each run a coding agent
on the same task; one is a control, one applies an optimization strategy. A run normally takes 5-20
minutes: sandbox boots (~1s), Claude Code installs (~6s), the agent works (minutes), then a hidden
test suite grades the workspace.

Decide whether this run is PROGRESSING or STUCK. Evidence follows as JSON.

Read it carefully:
- An agent legitimately spends many minutes on one step with no file changes while it thinks. Long
  elapsed time alone is NOT stuck.
- Real stuck signals: near-zero CPU with no new files for a long time; an agent step lasting far
  beyond the 30-minute cap; a sandbox that has died while its arm never reached "done"; an auth or
  quota error in stderr; the orchestrator process gone while arms are unfinished.
- "sheet.py absent" early in a run is normal. Late in a run with no recent file writes, it matters.
- If the two arms are at very different steps, that is normal — they run independently.

EVIDENCE:
${JSON.stringify(evidence, null, 2)}

Reply with ONLY a JSON object:
{"state":"progressing"|"stuck"|"failed"|"finishing","confidence":"high"|"medium"|"low",
 "reason":"<one or two sentences citing the specific evidence>",
 "action":"<what the operator should do, or 'wait' >"}`

  const res = await claude(prompt)
  let v = res.verdict
  if (!v) {
    console.log(`  ${C.y}!${C.x} reasoning unavailable ${C.d}(${res.error ?? 'unparsable reply'})${C.x}`)
    console.log(`  ${C.d}opt uses this machine's own Claude Code login; check \`claude auth status\`${C.x}`)
    v = heuristic(evidence)
    console.log(`  ${C.d}falling back to rules${C.x}`)
  }
  const colour = v.state === 'stuck' || v.state === 'failed' ? C.r : v.state === 'finishing' ? C.g : C.y
  console.log(`\n  ${colour}${C.b}${String(v.state).toUpperCase()}${C.x} ${C.d}(${v.confidence} confidence)${C.x}`)
  console.log(`  ${v.reason}`)
  console.log(`  ${C.b}→${C.x} ${v.action}`)
  console.log(res.cost != null ? `\n  ${C.d}verdict cost $${res.cost.toFixed(4)}${C.x}\n` : '')
}

async function cmdLogs(runId) {
  const runs = localRuns()
  const run = runId ? runs.find((r) => r.id.startsWith(runId)) : runs[0]
  if (!run) { console.log('no such run'); return }
  const sandboxes = await liveSandboxes()
  const liveIds = new Set((sandboxes.error ? [] : sandboxes).map((s) => s.sandboxId))
  for (const a of run.arms) {
    console.log(`\n${C.b}── ${a.arm} ${C.d}${a.sandboxId ?? ''}${C.x}`)
    const f = path.join(run.dir, a.arm, 'claude.err')
    if (fs.existsSync(f)) { console.log(fs.readFileSync(f, 'utf8').trim().slice(-1500) || '(empty)'); continue }
    if (!liveIds.has(a.sandboxId)) { console.log(`${C.d}(sandbox gone, no local log yet)${C.x}`); continue }
    const p = await probeSandbox(a.sandboxId)
    console.log(p.probe ?? p.error ?? '(nothing)')
  }
  console.log('')
}

async function cmdKill(which) {
  const sandboxes = await liveSandboxes()
  if (sandboxes.error) { console.log(`could not reach E2B: ${sandboxes.error}`); return }
  const targets = which === 'all' ? sandboxes
    : sandboxes.filter((s) => s.sandboxId === which || s.metadata?.runId?.startsWith(which))
  if (!targets.length) { console.log('nothing matching to kill'); return }
  for (const s of targets) {
    const done = await Sandbox.kill(s.sandboxId).catch(() => false)
    console.log(`  ${done ? C.g + '✓' : C.r + '✗'}${C.x} ${s.sandboxId} ${C.d}${s.metadata?.arm ?? ''}${C.x}`)
  }
}

// ---------------------------------------------------------------- status ui
async function cmdStatusUi(runId) {
  const runs = localRuns()
  // no runId given = follow whatever is newest, including runs started later
  const pinned = runId ? runs.find((r) => r.id.startsWith(runId)) : null
  if (runId && !pinned) { console.log(`\n  ${C.d}no such run${C.x}\n`); return }
  const run = pinned ?? { id: resolveRunId(ROOT) ?? '(waiting for a run)' }

  let port = Number(process.env.OPT_UI_PORT ?? 8791)
  let started = await startUi(ROOT, pinned ? pinned.id : null, { port })
  for (let i = 0; started.error && i < 8; i++) started = await startUi(ROOT, run.id, { port: ++port })
  if (started.error) { console.log(`  ${C.r}✗${C.x} ${started.error}`); return }

  const snap = resolveRunId(ROOT) || pinned ? snapshot(ROOT, pinned ? pinned.id : resolveRunId(ROOT))
              : { scenario: '—', task: { title: 'nothing running yet' }, arms: [] }
  console.log(`\n  ${C.b}${run.id}${C.x} ${C.d}· ${snap.scenario}${C.x}${pinned ? '' : C.d + ' (follows the newest run)' + C.x}`)
  console.log(`  ${C.c}${started.url}${C.x}  ${C.d}(opened in your browser, refreshes every 2s)${C.x}`)
  console.log(`  ${C.d}both sandboxes are building: ${snap.task.title}${C.x}`)
  for (const a of snap.arms) {
    const eta = a.etaSamples ? `~${Math.round(a.eta)}s expected (${a.etaSamples} past run${a.etaSamples > 1 ? 's' : ''})` : 'no history yet'
    console.log(`  ${C.d}  ${a.arm.padEnd(16)} ${a.step.padEnd(16)} ${eta}${C.x}`)
  }
  console.log(`\n  ${C.d}ctrl-c to stop serving${C.x}\n`)
  await new Promise(() => {})     // serve until interrupted
}

// ---------------------------------------------------------------- sessions
/**
 * Every agent session the rig has run — one per arm of one run — and, for any
 * one of them, the context window it actually used.
 */
async function cmdSession(sub, rest) {
  // --since 48h | --since 7d | --all — the window the table covers, default 48h
  const argv = [sub, ...rest].filter((v) => v != null)
  let sinceMs = DEFAULT_SINCE_MS
  let sources = ['e2b', 'local']
  let windowOverride = null
  let sortKey = 'start', sortDir = -1
  let doRun = false
  let runnerId = 'anthropic'
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--all') { sinceMs = null; continue }
    if (a === '--window' || a.startsWith('--window=')) {
      const v = a.startsWith('--window=') ? a.slice(9) : argv[++i]
      const m = /^(\d+(?:\.\d+)?)(k|m)?$/i.exec(String(v ?? '').trim())
      if (!m) {
        console.log(`\n  ${C.r}\u2717${C.x} cannot read ${C.b}${v}${C.x} as a context window ${C.d}\u2014 try 200k or 1m${C.x}\n`)
        return
      }
      windowOverride = Number(m[1]) * ({ k: 1e3, m: 1e6 }[m[2]?.toLowerCase()] ?? 1)
      continue
    }
    if (a === '--sort' || a.startsWith('--sort=')) {
      let v = String((a.startsWith('--sort=') ? a.slice(7) : argv[++i]) ?? '').toLowerCase()
      if (v.startsWith('-')) { sortDir = 1; v = v.slice(1) }        // -cost = ascending
      if (!SORTS[v]) {
        console.log(`\n  ${C.r}\u2717${C.x} no column ${C.b}${v}${C.x} ${C.d}\u2014 try ${Object.keys(SORTS).join(', ')}${C.x}\n`)
        return
      }
      sortKey = v
      continue
    }
    if (a === '--run') { doRun = true; continue }
    if (a === '--runner' || a.startsWith('--runner=')) {
      const v = a.startsWith('--runner=') ? a.slice(9) : argv[++i]
      if (!getRunner(v)) {
        console.log(`\n  ${C.r}\u2717${C.x} no runner ${C.b}${v}${C.x} ${C.d}\u2014 try ${listRunners().map((r) => r.id).join(', ')}${C.x}\n`)
        return
      }
      runnerId = v
      continue
    }
    if (a === '--e2b') { sources = ['e2b']; continue }
    if (a === '--local') { sources = ['local']; continue }
    let spec = null
    if (a === '--since' || a === '--last') spec = argv[++i]
    else if (a.startsWith('--since=')) spec = a.slice(8)
    else if (a.startsWith('--last=')) spec = a.slice(7)
    else { positional.push(a); continue }
    const parsed = parseSince(spec)
    if (parsed === undefined) {
      console.log(`\n  ${C.r}\u2717${C.x} cannot read ${C.b}${spec}${C.x} as a window ${C.d}\u2014 try 6h, 48h, 7d, or --all${C.x}\n`)
      return
    }
    sinceMs = parsed
  }
  sub = positional[0]

  if (sub === 'export') {
    const ref = positional[1]
    if (!ref) {
      console.log(`\n  ${C.d}which session? ${C.x}opt session export <#|ref>${C.d}   (${C.x}opt session${C.d} lists them)${C.x}\n`)
      return
    }
    const s = resolveSession(ROOT, ref)
    if (!s) { console.log(`\n  ${C.d}no session matches ${C.x}${ref}${C.x}\n`); return }
    const bundle = exportSession(ROOT, s)
    console.log(renderExport(bundle, ROOT))
    if (!doRun) return
    deprecated(`opt replay ${ref} --runner ${runnerId}`)

    const runner = getRunner(runnerId)
    console.log(`  ${C.d}runner${C.x}       ${C.m}${runner.id}${C.x} ${C.d}\u2014 ${runner.label}${C.x}`)
    secretsForRunner(runner)
    if (runner.needsAnthropicAuth) {
      const pre = await preflightAuth()
      if (!pre.ok) {
        console.log(`  ${C.r}\u2717 nothing can run${C.x} ${C.d}(${pre.mode ?? 'no auth'})${C.x}`)
        console.log(`  ${pre.reason}`)
        console.log(`  ${C.d}${pre.fix}${C.x}`)
        console.log(`  ${C.d}an open-weights runner needs no Anthropic credential: ${C.x}--runner openmodel${C.x}\n`)
        return
      }
      if (pre.unverified) console.log(`  ${C.d}auth: ${pre.mode} (cannot be checked from here)${C.x}`)
    }

    // --run: boot a sandbox from the bundle and let it play out.
    await ensureProject()
    const trace = tracingOn() ? startTrace(`export-run ${s.ref}`, {
      inputs: { ref: s.ref, intent: s.intent, fidelity: bundle.manifest.fidelity },
      metadata: { kind: 'export-run', bundle: path.basename(bundle.dir) },
      tags: ['export-run', s.kind],
    }) : null
    if (trace) console.log(`  ${C.d}tracing → ${projectUrl()}${C.x}\n`)
    console.log(`  ${C.d}booting a sandbox…${C.x}`)
    let turns = 0
    const rec = await runBundle({
      ROOT, dir: bundle.dir, manifest: bundle.manifest, trace, runner: runnerId,
      config: { id: s.ref, model: runner.modelAlias ?? (s.model?.includes('sonnet') ? 'sonnet' : 'opus') },
      onEvent: (ev) => {
        if (ev.type === 'runner_step') {
          process.stdout.write(`\r  ${C.d}${ev.exitCode === 0 ? '\u2713' : '\u2717'} ${ev.name}${' '.repeat(30)}${C.x}\n`)
        } else if (ev.type === 'assistant') {
          turns++
          const tool = (ev.message?.content ?? []).find((b) => b.type === 'tool_use')
          process.stdout.write(`\r  ${C.d}turn ${turns}${tool ? ` \u00b7 ${tool.name}` : ''}${' '.repeat(20)}${C.x}`)
        }
      },
    })
    process.stdout.write('\r' + ' '.repeat(60) + '\r')
    await trace?.end({ outputs: { passed: rec.grade?.passed ?? null, total: rec.grade?.total ?? null,
                                  cost_usd: rec.cost, turns: rec.turns }, error: rec.fatal ?? null })
    console.log(`  ${C.b}${rec.id}${C.x}  ${rec.fatal ? `${C.r}FATAL${C.x} ${rec.fatal}` :
      `${rec.grade?.total ? `${rec.grade.passed}/${rec.grade.total}  ` : ''}` +
      `${rec.cost != null ? '$' + rec.cost.toFixed(4) : C.y + 'cost unknown' + C.x}  ${rec.turns ?? '—'} turns  ${dur(rec.wallSec)}`}`)
    if (rec.cappedOut) {
      console.log(`  ${C.y}${rec.cappedNote}${C.x}`)
      console.log(`  ${C.d}no result event was written, so cost and tokens are unrecoverable —${C.x}`)
      console.log(`  ${C.d}the grade is real, the spend is not missing but unknown. ${C.x}AGENT_MS${C.d} raises the cap.${C.x}`)
    }
    if (rec.authFallback) console.log(`  ${C.y}${rec.authFallback}${C.x}`)
    if (rec.result?.is_error) console.log(`  ${C.r}the agent reported:${C.x} ${String(rec.result.result).slice(0, 200)}`)
    else if (!rec.result && rec.stderrTail) console.log(`  ${C.r}stderr:${C.x} ${rec.stderrTail.split('\n').pop()?.slice(0, 200)}`)
    console.log(`  ${C.d}sandbox ${rec.sandboxId}${C.x}`)
    if (trace) console.log(`  ${C.d}trace   ${projectUrl()}${C.x}`)
    console.log('')
    return
  }

  if (sub === 'ui') {
    let port = Number(process.env.OPT_SESSIONS_PORT ?? 8793)
    let started = await startSessionsUi(ROOT, { port, sinceMs, sources })
    for (let i = 0; started.error && i < 8; i++)
      started = await startSessionsUi(ROOT, { port: ++port, sinceMs, sources })
    if (started.error) { console.log(`  ${C.r}\u2717${C.x} ${started.error}`); return }
    const count = collectSessions(ROOT, { sinceMs, sources }).length
    const hidden = countAll(ROOT, { sources }) - count
    console.log(`\n  ${C.b}${count} session${count === 1 ? '' : 's'}${C.x} ${C.d}in the last ${describeWindow(sinceMs)}` +
                `${hidden ? `, ${hidden} older hidden` : ''}${C.x}`)
    console.log(`  ${C.c}${started.url}${C.x}  ${C.d}(opened in your browser, refreshes every 5s)${C.x}`)
    console.log(`  ${C.d}click a row \u2014 or \u2191\u2193 \u2014 for its context window; the chips change the window${C.x}`)
    console.log(`\n  ${C.d}ctrl-c to stop serving${C.x}\n`)
    await new Promise(() => {})     // serve until interrupted
    return
  }

  const sessions = collectSessions(ROOT, { sinceMs, sources })
  if (!sub) {
    // Only worth the full scan when the window could actually reach the boundary.
    const deep = sources.includes('local') && (sinceMs == null || sinceMs > 25 * 864e5)
    console.log(renderTable(sortSessions(sessions, sortKey, sortDir), sinceMs, {
      hidden: countAll(ROOT, { sources }) - sessions.length,
      retention: deep ? oldestOnDisk() : null,
      sortKey, sortDir,
    }))
    return
  }

  const s = findSession(sessions, sub)
       ?? (sinceMs != null ? findSession(collectSessions(ROOT, { sinceMs: null, sources }), sub) : null)
  if (!s) {
    console.log(`\n  ${C.d}no session matches ${C.x}${sub}${C.d} \u2014 try ${C.x}opt session${C.d} for the list${C.x}\n`)
    return
  }
  console.log(renderContext(s, windowOverride))
}

// ---------------------------------------------------------------- init
/**
 * Is everything up? Reads every dependency and every session, and says what
 * works. Boots nothing; the only spend is one 4-token credential check.
 */
async function cmdInit(rest = []) {
  const dIdx = rest.findIndex((a) => a === '--sessions' || a === '-s')
  const detail = dIdx >= 0 ? Number(rest[dIdx + 1]) || 12 : 12
  // init is the one command that legitimately wants every credential, because
  // reporting on them is the whole job.
  const secrets = needSecrets(SECRET_KEYS)
  const preflight = await preflightAuth()
  console.log(await initReport(ROOT, { secrets, preflight, detail }))
}

// ---------------------------------------------------------------- experiments
/**
 * Everything about runs lives under one verb. The old top-level forms (`opt ls`,
 * `opt status`, …) still run but are deprecated: each says where it moved.
 */
async function cmdExperiments(sub, rest) {
  switch (sub) {
    case undefined:
    case 'ls': case 'list': {
      const i = rest.indexOf('--session')
      await cmdLs({ session: i >= 0 ? rest[i + 1] : null }); return
    }
    case 'ps': case 'live': await cmdLs({ live: true }); return
    case 'status': case 'st':
      if (rest[0] === 'ui') await cmdStatusUi(rest[1]); else await cmdStatus(rest[0])
      return
    case 'logs': await cmdLogs(rest[0]); return
    case 'open': await cmdOpen(rest[0]); return
    case 'kill': await cmdKill(rest[0] ?? 'all'); return
    case 'results': case 'report': await cmdResults(rest[0]); return
    case 'ui': {
      let port = Number(process.env.OPT_EXPERIMENTS_PORT ?? 8794)
      let started = await startExperimentsUi(ROOT, { port })
      for (let i = 0; started.error && i < 8; i++) started = await startExperimentsUi(ROOT, { port: ++port })
      if (started.error) { console.log(`  ${C.r}\u2717${C.x} ${started.error}`); return }
      const all = collectExperiments(ROOT)
      console.log(`\n  ${C.b}${all.length} experiment${all.length === 1 ? '' : 's'}${C.x}`)
      console.log(`  ${C.c}${started.url}${C.x}  ${C.d}(opened in your browser, refreshes every 10s)${C.x}`)
      console.log(`  ${C.d}click a run for both configurations, what moved, and how to apply it${C.x}`)
      console.log(`\n  ${C.d}ctrl-c to stop serving${C.x}\n`)
      await new Promise(() => {})
      return
    }
    default:
      console.log(`\n  ${C.d}no such subcommand ${C.x}${sub}${C.x}`)
      console.log(`  ${C.d}try: ls · ps · status · results · logs · open · kill · ui${C.x}\n`)
  }
}

/** The written comparison a finished run already produced. */
async function cmdResults(runId) {
  const all = collectExperiments(ROOT)
  if (!all.length) { console.log(`\n  ${C.d}no runs${C.x}\n`); return }
  const e = runId ? all.find((x) => x.runId.startsWith(runId) || x.runId.includes(runId)) : all[0]
  if (!e) { console.log(`\n  ${C.d}no run matches ${C.x}${runId}${C.x}\n`); return }

  const txt = fs.existsSync(path.join(e.dir, 'report.txt'))
    ? fs.readFileSync(path.join(e.dir, 'report.txt'), 'utf8') : null
  console.log('')
  console.log(`  ${C.b}${e.runId}${C.x} ${C.d}\u00b7 ${e.scenario}${e.task ? ` \u00b7 ${e.task}` : ''}${C.x}`)
  const h = headline(e)
  const tone = h.tone === 'improved' ? C.g : h.tone === 'degraded' ? C.r : C.d
  console.log(`  ${tone}${h.text}${C.x}`)
  if (txt) { console.log(''); console.log(txt.trimEnd()) }
  else console.log(`  ${C.d}no report.txt \u2014 the run may not have finished${C.x}`)
  if (e.apply.length) {
    console.log(`\n  ${C.d}HOW TO APPLY${C.x}`)
    for (const a of e.apply)
      console.log(`    ${C.c}${a.kind.padEnd(20)}${C.x}${C.d}${a.how.split('\n')[0].slice(0, 80)}${a.how.length > 80 ? '\u2026' : ''}${C.x}`)
    console.log(`  ${C.d}full detail, side by side: ${C.x}opt experiments ui${C.x}`)
  }
  console.log('')
}

// ---------------------------------------------------------------- replay
/**
 * The experiment: a session that ran here, exported, and run again in a sandbox
 * on an open-weights model — then the two put side by side.
 */
async function cmdReplay(arg, rest) {
  const argv = [arg, ...rest].filter((v) => v != null)
  let runnerId = 'openmodel'
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--runner' || a.startsWith('--runner=')) {
      runnerId = a.startsWith('--runner=') ? a.slice(9) : argv[++i]
      continue
    }
    positional.push(a)
  }
  const ref = positional[0]
  const runner = getRunner(runnerId)
  const isNew = argv.includes('--new')
  const taskIdx = argv.findIndex((a) => a === '--task')
  const task = taskIdx >= 0 ? argv[taskIdx + 1] : (isNew ? 'regex' : null)
  if (!runner) {
    console.log(`\n  ${C.r}\u2717${C.x} no runner ${C.b}${runnerId}${C.x}`)
    for (const r of listRunners()) console.log(`     ${C.m}${r.id.padEnd(20)}${C.x}${C.d}${r.label}${C.x}`)
    console.log('')
    return
  }
  // --new is the whole experiment: start a session here, then run it there.
  if (isNew) {
    console.log(`\n  ${C.b}local \u2192 sandbox \u2192 open weights${C.x}`)
    console.log(`  ${C.d}one task, run twice: once by Claude on this machine, once by an${C.x}`)
    console.log(`  ${C.d}open-weights model inside a sandbox, graded by the same hidden suite${C.x}\n`)
    secretsForRunner(runner)
    console.log(`  ${C.b}1. local session${C.x}`)
    const local = await startLocalSession({ ROOT, task })

    const all = collectSessions(ROOT, { sinceMs: null, sources: ['local'] })
    const s = all.find((x) => x.sessionId === local.sessionId)
           ?? { ref: local.sessionId.slice(0, 8), kind: 'local', runId: local.sessionId,
                arm: 'local', where: path.basename(local.work), task, taskTitle: local.cfg.title,
                intent: `${local.cfg.title} — run locally`, model: local.result.modelUsage
                  ? Object.keys(local.result.modelUsage)[0] : 'claude', artifacts: [], levers: [],
                startedMs: Date.now(), toolCounts: null }

    const origin = {
      ref: s.ref, kind: 'local', intent: local.cfg.title, model: s.model ?? 'claude',
      turns: local.result.num_turns, wallSec: local.wallSec,
      cost: local.result.total_cost_usd ?? null,
      tokens: { total: local.result.usage
        ? (local.result.usage.input_tokens ?? 0) + (local.result.usage.cache_read_input_tokens ?? 0)
          + (local.result.usage.cache_creation_input_tokens ?? 0) + (local.result.usage.output_tokens ?? 0)
        : null },
      grade: local.grade,
      artifacts: fs.existsSync(local.work) ? fs.readdirSync(local.work).filter((f) => !f.startsWith('.')) : [],
      costBasis: 'API-list equivalent (subscription session)',
      workspace: path.relative(ROOT, local.work),
    }

    console.log(`\n  ${C.b}2. export \u2192 3. sandbox${C.x}`)
    const out = await replay({ ROOT, session: s, runnerId, task, originOverride: origin })
    console.log(renderReplay(out, ROOT))
    return
  }

  if (!ref) {
    console.log(`\n  ${C.d}which session? ${C.x}opt replay <#|ref> [--runner <id>]${C.x}`)
    console.log(`  ${C.d}or run the whole experiment: ${C.x}opt replay --new --task regex${C.x}`)
    console.log(`  ${C.d}${C.x}opt session --local${C.d} lists the ones that ran here${C.x}\n`)
    for (const r of listRunners()) console.log(`     ${C.m}${r.id.padEnd(20)}${C.x}${C.d}${r.label}${C.x}`)
    console.log('')
    return
  }

  const s = resolveSession(ROOT, ref)
  if (!s) { console.log(`\n  ${C.d}no session matches ${C.x}${ref}${C.x}\n`); return }

  console.log(`\n  ${C.b}replaying ${s.ref}${C.x}`)
  secretsForRunner(runner)
  if (runner.needsAnthropicAuth) {
    const pre = await preflightAuth()
    if (!pre.ok) {
      console.log(`  ${C.r}\u2717 nothing can run${C.x} \u2014 ${pre.reason}`)
      console.log(`  ${C.d}an open-weights runner needs no Anthropic credential: ${C.x}--runner openmodel${C.x}\n`)
      return
    }
  }
  const out = await replay({ ROOT, session: s, runnerId })
  console.log(renderReplay(out, ROOT))
}

// ---------------------------------------------------------------- tune
/**
 * Search for a better configuration of the same task, with Claude reading the
 * results between generations and proposing what to try next.
 */
async function cmdTune(arg, rest) {
  const argv = [arg, ...rest].filter((v) => v != null)
  let generations = 2, candidates = 3, repeats = 1, budget = process.env.MAX_BUDGET_USD ?? '4'
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const take = () => argv[++i]
    if (a === '--generations' || a === '-g') { generations = Number(take()); continue }
    if (a === '--candidates' || a === '-n') { candidates = Number(take()); continue }
    if (a === '--repeats') { repeats = Number(take()); continue }
    if (a === '--budget') { budget = String(take()); continue }
    positional.push(a)
  }
  const target = positional[0]
  if (!target) {
    console.log(`\n  ${C.d}what should be tuned? ${C.x}opt tune <bundle-dir|session-ref>${C.x}`)
    console.log(`  ${C.d}export one first with ${C.x}opt session export <#>${C.x}\n`)
    return
  }

  // A bundle directory, or a session reference that gets exported on the spot.
  let dir = path.resolve(ROOT, target)
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
    const s = resolveSession(ROOT, target)
    if (!s) { console.log(`\n  ${C.d}no bundle or session matches ${C.x}${target}${C.x}\n`); return }
    console.log(`  ${C.d}exporting ${s.ref} first…${C.x}`)
    dir = exportSession(ROOT, s).dir
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))

  const total = generations * candidates
  console.log(`\n  ${C.b}tuning ${path.basename(dir)}${C.x}`)
  console.log(`  ${C.d}${manifest.session.intent?.slice(0, 90) ?? ''}${C.x}`)
  console.log(`  ${C.d}${generations} generation(s) x up to ${candidates} candidate(s) = up to ${total} sandbox runs, $${budget} cap each${C.x}`)
  if (!manifest.gradeable)
    console.log(`  ${C.y}this bundle has no test suite — correctness cannot be measured, only cost and completion${C.x}`)

  needSecrets(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'])
  const pre = await preflightAuth()
  if (!pre.ok) {
    console.log(`\n  ${C.r}\u2717 nothing can run${C.x} ${C.d}(${pre.mode ?? 'no auth'})${C.x}`)
    console.log(`  ${pre.reason}`)
    console.log(`  ${C.d}${pre.fix}${C.x}`)
    console.log(`  ${C.d}no sandbox was booted, nothing was billed${C.x}\n`)
    return
  }
  if (pre.unverified) console.log(`  ${C.d}auth: ${pre.mode} (cannot be checked from here)${C.x}`)

  const out = await tune({ ROOT, dir, generations, candidatesPerGen: candidates, repeats, budget })
  console.log(renderTuning(out, ROOT))
}

// ---------------------------------------------------------------- open
async function cmdOpen(runId) {
  const runs = localRuns()
  const run = runId ? (runs.find((r) => r.id === runId) ?? runs.find((r) => r.id.includes(runId)))
                    : runs.find((r) => r.complete && !r.id.startsWith('0000'))
  if (!run) {
    console.log(`\n  ${C.d}no run matching "${runId ?? ''}"${C.x}`)
    console.log(`  ${C.d}known runs:${C.x}`)
    for (const r of runs.slice(0, 12)) console.log(`     ${r.id}`)
    console.log('')
    return
  }
  const report = path.join(run.dir, 'report.html')
  if (!fs.existsSync(report)) { console.log(`\n  ${C.y}${run.id} has no report yet${C.x} — still running?\n`); return }
  console.log(`\n  ${C.b}${run.id}${C.x}  ${C.d}${path.relative(ROOT, report)}${C.x}`)
  const o = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try { spawn(o, [report], { detached: true, stdio: 'ignore' }).unref(); console.log(`  ${C.g}opened${C.x}\n`) }
  catch { console.log(`  ${C.y}could not open automatically${C.x}\n`) }
}

// ---------------------------------------------------------------- secrets
async function cmdSecrets(verify) {
  console.log('')
  for (const k of ['ANTHROPIC_API_KEY', 'E2B_API_KEY']) {
    const r = needSecrets(SECRET_KEYS)[k] ?? {}
    const val = process.env[k]
    const mark = r.error ? `${C.r}✗${C.x}` : val ? `${C.g}✓${C.x}` : `${C.y}—${C.x}`
    console.log(`  ${mark} ${C.b}${k}${C.x}`)
    console.log(`     ${C.d}${r.source ? `from ${r.source}` : 'not set'}${r.ref ? `  ${r.ref}` : ''}${val ? `  (${val.length} chars)` : ''}${C.x}`)
    for (const n of r.notes ?? []) console.log(`     ${C.y}!${C.x} ${n}`)
  }
  if (!process.env.ANTHROPIC_API_KEY && opAvailable()) {
    const found = opFindAnthropic()
    if (found.length) {
      console.log(`\n  ${C.d}1Password items that look relevant:${C.x}`)
      for (const f of found) console.log(`     ${f.ref}`)
      console.log(`\n  ${C.d}put one in .env, verbatim:${C.x}`)
      console.log(`     ANTHROPIC_API_KEY=${found[0].ref}`)
    }
  }
  if (verify && process.env.ANTHROPIC_API_KEY) {
    process.stdout.write(`\n  checking the Anthropic key against the API… `)
    const v = await verifyKey(process.env.ANTHROPIC_API_KEY)
    console.log(v.ok ? `${C.g}valid${C.x}` : `${C.r}rejected (${v.status})${C.x} ${C.d}${v.message ?? ''}${C.x}`)
  }
  console.log('')
}

// ---------------------------------------------------------------- hub
async function cmdHub(sub) {
  if (sub === 'demo') return cmdHubDemo(process.argv.slice(4))
  if (sub && sub !== 'start') { console.log('\n  opt hub start   — the Optimization Hub server\n  opt hub demo    — the same hub on a synthetic company (Tallyfox) [--rebuild] [--port N] [--dir D] [--banner]\n'); return }
  const child = spawn(process.execPath, [path.join(ROOT, 'hub.mjs'), 'start', ...(process.argv.includes('--no-open') ? ['--no-open'] : [])], { stdio: 'inherit', cwd: ROOT, env: process.env })
  await new Promise((r) => child.on('exit', r))
}

/**
 * The hub on synthetic data (tools/demo-startup.mjs): its own transcripts, its own opt state, no
 * LangSmith, a banner on every page. Nothing of yours is read or written.
 */
async function cmdHubDemo(args) {
  const { DEFAULT_OUT, COMPANY } = await import('./tools/demo-startup.mjs')
  const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }
  const out = path.resolve(flag('--dir', DEFAULT_OUT))
  if (args.includes('--rebuild') || !fs.existsSync(path.join(out, 'SYNTHETIC.md'))) {
    console.log(`\n  building the ${COMPANY} demo (synthetic) in ${out}`)
    // in its own process: this one has already fixed OPT_HOME to your real state
    const b = spawn(process.execPath, [path.join(ROOT, 'tools', 'demo-startup.mjs'), out], { stdio: 'inherit', cwd: ROOT,
      env: { ...process.env, OPT_HOME: path.join(out, 'home'), OPT_PROJECTS_DIR: path.join(out, 'projects') } })
    if (await new Promise((r) => b.on('exit', r)) !== 0) { console.error('  the demo build failed'); return }
  }
  const env = { ...process.env, OPT_PROJECTS_DIR: path.join(out, 'projects'), OPT_HOME: path.join(out, 'home'), OPT_CLAUDE_SETTINGS: path.join(out, 'claude-settings.json'),
    LANGSMITH_API_KEY: '', CC_LANGSMITH_API_KEY: '', LANGCHAIN_API_KEY: '', LANGSMITH_ENDPOINT: '', HUB_PORT: flag('--port', '8950'), OPT_OTLP_PORT: '14350', HUB_SYNTHETIC: COMPANY, HUB_BANNER: args.includes('--banner') ? '1' : '' }
  const child = spawn(process.execPath, [path.join(ROOT, 'hub.mjs'), 'start', ...(args.includes('--no-open') ? ['--no-open'] : [])], { stdio: 'inherit', cwd: ROOT, env })
  await new Promise((r) => child.on('exit', r))
}

// ---------------------------------------------------------------- artifacts
async function cmdArtifacts(sub) {
  const list = sub === 'ls' || sub === '--list'
  await new Promise((r) => spawn(process.execPath, [path.join(ROOT, 'artifacts.mjs'), ...(list ? ['--list'] : [])],
    { stdio: 'inherit', cwd: ROOT }).on('exit', r))
  if (list) return
  const idx = path.join(RESULTS, 'index.html')
  if (!fs.existsSync(idx)) return
  console.log(`  ${C.c}${idx}${C.x}`)
  const o = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try { spawn(o, [idx], { detached: true, stdio: 'ignore' }).unref(); console.log(`  ${C.g}opened${C.x}\n`) } catch {}
}

// ---------------------------------------------------------------- flow
async function cmdFlow(sub, rest) {
  const flows = fs.existsSync(path.join(ROOT, 'flows'))
    ? fs.readdirSync(path.join(ROOT, 'flows')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')) : []
  if (sub === 'ls' || sub === 'list') {
    console.log('\nflows:\n')
    for (const f of flows) {
      const src = fs.readFileSync(path.join(ROOT, 'flows', `${f}.md`), 'utf8')
      const d = /^description:\s*(.*)$/m.exec(src)?.[1] ?? ''
      const st = /^stages:\s*(.*)$/m.exec(src)?.[1] ?? ''
      console.log(`  ${f.padEnd(18)} ${C.d}${st.padEnd(22)}${C.x}${d.slice(0, 70)}`)
    }
    console.log('')
    return
  }
  if (sub !== 'run') {
    console.log(`\n  ${C.b}opt flow run${C.x} <name> [--model M] [--github owner/repo] [--dry]`)
    console.log(`  ${C.b}opt flow ls${C.x}\n  ${C.d}available: ${flows.join(', ') || '(none)'}${C.x}\n`)
    return
  }
  const code = await new Promise((r) => spawn(process.execPath, [path.join(ROOT, 'flow.mjs'), ...rest],
    { stdio: 'inherit', cwd: ROOT, env: process.env }).on('exit', r))
  process.exit(code ?? 0)
}

// ---------------------------------------------------------------- run
/**
 * `opt run` — one or more scenarios, grouped under a session id.
 * Each scenario gets its own paired baseline, so run-to-run variance is
 * controlled within a comparison rather than across them.
 */
async function cmdRun(rest) {
  const flag = (n, d) => { const i = rest.indexOf(n); return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : d }
  const list = (v) => String(v ?? '').split(/[\s,]+/).filter(Boolean)

  const scenarios = list(flag('--experiments', flag('--experiment', flag('--scenarios', ''))))
  if (!scenarios.length) {
    console.log(`\n  ${C.b}opt flow run${C.x} <name> [--github owner/repo]
                         autonomous flow: controller + workers + a judge sandbox
  ${C.b}opt flow ls${C.x}            what flows exist

  ${C.b}opt run${C.x} --experiments <a,b,c> [--session <id>] [--task <t>] [--budget N] [--model M] [--parallel N] [--dry]\n`)
    console.log(`  ${C.d}available:${C.x} ${listScenarios().join(', ')}\n`)
    return
  }
  const unknown = scenarios.filter((n) => !fs.existsSync(path.join(ROOT, 'scenarios', `${n}.md`)))
  if (unknown.length) { console.log(`\n  ${C.r}no such scenario:${C.x} ${unknown.join(', ')}\n  available: ${listScenarios().join(', ')}\n`); return }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')
  const session = flag('--session', null) ?? `s-${stamp.slice(2, 8)}-${stamp.slice(8, 12)}`
  const task = flag('--task', process.env.TASK ?? 'sheet')
  const budget = flag('--budget', process.env.MAX_BUDGET_USD ?? '10')
  const model = flag('--model', process.env.BENCH_MODEL ?? 'opus')
  const control = flag('--control', null)
  const dry = rest.includes('--dry')
  const parallel = Math.max(1, Math.min(Number(flag('--parallel', scenarios.length)) || 1, 4))

  const existing = localRuns().filter((r) => r.session === session)
  console.log(`\n  ${C.b}session ${session}${C.x}${existing.length ? ` ${C.d}(joining ${existing.length} existing run${existing.length > 1 ? 's' : ''})${C.x}` : ''}`)
  console.log(`  task ${C.b}${task}${C.x} · model ${model} · budget $${budget}/arm · ${parallel} at a time`)
  console.log(`  experiments: ${scenarios.map((x) => C.b + x + C.x).join(', ')}`)
  console.log(`  ${C.d}${scenarios.length * 2} sandboxes total — each scenario runs against its own baseline${C.x}\n`)

  const env = { ...process.env, MAX_BUDGET_USD: budget, BENCH_MODEL: model, SESSION_ID: session, TASK: task }
  const results = []
  for (let i = 0; i < scenarios.length; i += parallel) {
    const batch = scenarios.slice(i, i + parallel)
    await Promise.all(batch.map((sc) => new Promise((res) => {
      const args = [path.join(ROOT, 'run-demo.mjs'), '--scenarios', sc, '--task', task, '--session', session,
                    ...(control ? ['--control', control] : []), ...(dry ? ['--dry'] : [])]
      const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: parallel === 1 ? 'inherit' : ['ignore', 'pipe', 'pipe'] })
      let buf = ''
      child.stdout?.on('data', (d) => { buf += d; process.stdout.write(String(d).split('\n').filter(Boolean).map((l) => `${C.d}[${sc}]${C.x} ${l}`).join('\n') + '\n') })
      child.stderr?.on('data', (d) => { buf += d })
      child.on('exit', (code) => { results.push({ scenario: sc, code, tail: buf.slice(-400) }); res() })
    })))
  }

  console.log(`\n  ${C.b}session ${session}${C.x} finished`)
  for (const r of results) console.log(`    ${r.code === 0 ? C.g + '✓' : C.r + '✗'}${C.x} ${r.scenario}${r.code === 0 ? '' : ` (exit ${r.code})`}`)
  const runs = localRuns().filter((r) => r.session === session)
  for (const r of runs) {
    const scores = r.arms.map((a) => a.total ? `${a.arm} ${a.passed}/${a.total}` : `${a.arm} —`).join('  ')
    console.log(`    ${C.d}${r.id}${C.x}  ${scores}`)
  }
  console.log(`\n  ${C.d}opt experiments ls --session ${session}   ·   opt experiments open <runId>${C.x}\n`)
}

// ---------------------------------------------------------------- watch
const STATUS_COLOR = { live: C.g, open: C.c, idle: C.y, closed: C.d }
const clip = (t, n) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const lastWrote = (ms) => !Number.isFinite(ms) ? '  --'
  : ms < 60000 ? Math.round(ms / 1000) + 's'
  : ms < 3600000 ? Math.round(ms / 60000) + 'm'
  : ms < 86400000 ? (ms / 3600000).toFixed(1) + 'h'
  : Math.round(ms / 86400000) + 'd'

/**
 * `opt session --watch` (formerly `opt watch`) — what is running right now, redrawn in place.
 *
 * live   wrote in the last 90s
 * open   a claude process is running in that directory, newest transcript there
 * idle   wrote in the last 30 min, nothing running
 */
async function cmdWatch(rest = []) {
  const has = (...f) => f.some((x) => rest.includes(x))
  const onlyOpen = has('--live', '--open')
  const once = has('--once', '--no-follow')
  // --since 7d | --on 2026-09-01 | --since 2026-09-01..2026-09-05 — by creation
  const dateArg = (() => {
    for (const flag of ['--since', '--on', '--created']) {
      const i = rest.indexOf(flag)
      if (i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--')) return rest[i + 1]
      const eq = rest.find((a) => a.startsWith(flag + '='))
      if (eq) return eq.slice(flag.length + 1)
    }
    return null
  })()
  const created = parseDateSpec(dateArg)
  if (created === undefined) {
    console.log(`\n  ${C.r}\u2717${C.x} cannot read ${C.b}${dateArg}${C.x} as a date`
      + ` ${C.d}\u2014 try 7d, today, 2026-09-01, or 2026-09-01..2026-09-05${C.x}\n`)
    return
  }
  const every = Math.max(1, Number((rest.find((a) => a.startsWith('--every=')) || '').split('=')[1]) || 2)
  const rows = Number((rest.find((a) => a.startsWith('--rows=')) || '').split('=')[1]) || (onlyOpen ? 12 : 20)

  const draw = () => {
    const w = watchList({ onlyOpen, created })
    const c = w.counts
    const out = []
    out.push('')
    out.push(`  ${C.b}opt session --watch${C.x}  ${C.d}${new Date().toLocaleTimeString()}${C.x}`
      + `   ${C.g}live ${c.live ?? 0}${C.x}  ${C.c}open ${c.open ?? 0}${C.x}`
      + `  ${C.y}idle ${c.idle ?? 0}${C.x}  ${C.d}closed ${c.closed ?? 0}${C.x}`
      + (dateArg ? `   ${C.m}created ${describeRange(created)}${C.x}` : '')
      + `   ${C.d}${w.sessions.length} of ${Object.values(w.countsAll).reduce((a, b) => a + b, 0)}${C.x}`)
    out.push(`  ${C.d}${w.processes.length} claude process(es): `
      + (w.processes.map((p) => p.cwd.replace(process.env.HOME, '~')).join(', ') || 'none') + C.x)
    out.push('')
    out.push(`  ${C.d}STATUS   SESSION   LAST    COST   TURNS  CONTEXT  INTENT${C.x}`)
    for (const s of w.sessions.slice(0, rows)) {
      const col = STATUS_COLOR[s.status] ?? C.x
      const ctx = s.ctxMedian >= 1000 ? Math.round(s.ctxMedian / 1000) + 'k' : String(s.ctxMedian)
      out.push(`  ${col}${s.status.toUpperCase().padEnd(7)}${C.x}  ${s.id.slice(0, 8)}`
        + `  ${lastWrote(s.ageMs).padStart(5)}  ${('$' + s.cost.toFixed(2)).padStart(8)}`
        + `  ${String(s.turns).padStart(5)}  ${ctx.padStart(7)}  ${clip(s.intent, 46)}`)
    }
    if (!w.sessions.length) out.push(`  ${C.d}nothing ${onlyOpen ? 'live or open' : 'on disk'}${C.x}`)
    out.push('')
    if (!once) out.push(`  ${C.d}refreshing every ${every}s \u00b7 ctrl-c to stop${C.x}\n`)
    return out.join('\n')
  }

  if (once) { console.log(draw()); return }
  process.stdout.write('\x1b[?25l')                       // hide cursor
  const paint = () => process.stdout.write('\x1b[2J\x1b[H' + draw())
  paint()
  const timer = setInterval(paint, every * 1000)
  const stop = () => { clearInterval(timer); process.stdout.write('\x1b[?25h\n'); process.exit(0) }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
}

// ---------------------------------------------------------------- demo
async function cmdDemo(sub, rest) {
  if (sub === 'scenarios' || sub === 'ls') {
    await new Promise((r) => spawn(process.execPath, [path.join(ROOT, 'run-demo.mjs'), '--list'],
      { stdio: 'inherit', cwd: ROOT }).on('exit', r))
    return
  }
  if (sub !== 'run') {
    console.log(`\n  ${C.b}opt demo run${C.x} [--scenarios <name>] [--dry] [--budget N] [--model M]\n` +
                `  ${C.b}opt demo scenarios${C.x}   list what can be run\n`)
    return
  }

  const flag = (n, d) => { const i = rest.indexOf(n); return i >= 0 && rest[i + 1] ? rest[i + 1] : d }
  // a bare word is the scenario only if it is not the value of some other flag
  const valueOf = new Set(rest.filter((a, i) => a.startsWith('--') && rest[i + 1] && !rest[i + 1].startsWith('-')).map((a, i) => a))
  const bare = rest.filter((a, i) => !a.startsWith('-') && !(rest[i - 1] ?? '').startsWith('--'))
  const scenario = flag('--scenarios', flag('--scenario', bare[0] ?? 'uber-factory'))
  const task = flag('--task', process.env.TASK ?? 'sheet')
  const control = flag('--control', process.env.CONTROL_SCENARIO ?? null)
  const budget = flag('--budget', process.env.MAX_BUDGET_USD ?? '10')
  const model = flag('--model', process.env.BENCH_MODEL ?? 'opus')
  const dry = rest.includes('--dry')

  const env = { ...process.env, MAX_BUDGET_USD: budget, BENCH_MODEL: model }
  if (env.E2B_TEMPLATE) console.log(`\n  ${C.d}template ${env.E2B_TEMPLATE}${C.x}`)
  if (!env.E2B_API_KEY) {
    console.log(`\n  ${C.r}✗${C.x} E2B_API_KEY missing from .env`)
    console.log(`    free key, no card: ${C.c}https://console.e2b.dev/?tab=keys${C.x}\n`)
    process.exit(1)
  }
  // An arm that sets ANTHROPIC_BASE_URL is served by another provider, so it needs
  // no Anthropic key. Only require one if some arm actually talks to Anthropic.
  const scenarioEnv = (name) => {
    try {
      const src = fs.readFileSync(path.join(ROOT, 'scenarios', `${name}.md`), 'utf8')
      const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src)
      return /^env:.*ANTHROPIC_BASE_URL/m.test(m?.[1] ?? '')
    } catch { return false }
  }
  const controlNeedsAnthropic = control ? !scenarioEnv(control) : true
  const armNeedsAnthropic = !scenarioEnv(scenario)
  const needsAnthropic = controlNeedsAnthropic || armNeedsAnthropic
  if (!needsAnthropic) console.log(`\n  ${C.d}no Anthropic key needed — both arms are served by another provider${C.x}`)

  if (needsAnthropic && !env.ANTHROPIC_API_KEY && !dry) {
    console.log(`\n  ${C.r}✗${C.x} ANTHROPIC_API_KEY missing from .env`)
    console.log(`    ${C.d}read -rs 'k?ANTHROPIC_API_KEY: ' && printf 'ANTHROPIC_API_KEY=%s\\n' "$k" >> .env && unset k${C.x}`)
    console.log(`    ${C.c}https://console.anthropic.com/settings/keys${C.x}\n`)
    process.exit(1)
  }

  if (!dry && needsAnthropic) {
    process.stdout.write(`\n  checking the Anthropic key… `)
    const v = await verifyKey(env.ANTHROPIC_API_KEY)
    if (!v.ok) {
      console.log(`${C.r}rejected (${v.status})${C.x} ${C.d}${v.message ?? ''}${C.x}`)
      console.log(`\n  Nothing was booted. Run ${C.c}opt secrets${C.x} to see where that key came from.`)
      console.log(`  A fresh one: ${C.c}https://console.anthropic.com/settings/keys${C.x}\n`)
      process.exit(1)
    }
    console.log(`${C.g}valid${C.x}`)
  }

  console.log(`\n  ${C.b}demo${C.x}  task ${C.b}${task}${C.x} · scenario ${C.b}${scenario}${C.x} · model ${model} · budget $${budget}/arm`)
  console.log(`  ${C.d}control vs ${scenario}, two sandboxes, live below. ${C.x}`)
  console.log(`  ${C.d}another terminal: opt experiments status · opt experiments logs · opt experiments kill all${C.x}`)

  const args = [path.join(ROOT, 'run-demo.mjs'), '--scenarios', scenario, '--task', task,
                ...(control ? ['--control', control] : []), ...(dry ? ['--dry'] : [])]
  const code = await new Promise((r) => spawn(process.execPath, args, { stdio: 'inherit', cwd: ROOT, env }).on('exit', r))
  if (code !== 0 || dry) process.exit(code ?? 0)

  const runs = fs.readdirSync(RESULTS).filter((d) => !d.startsWith('0000') &&
    fs.existsSync(path.join(RESULTS, d, 'report.html'))).sort()
  const latest = runs[runs.length - 1]
  if (latest) {
    const report = path.join(RESULTS, latest, 'report.html')
    console.log(`  ${C.g}✓${C.x} ${path.relative(ROOT, report)}`)
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    try { spawn(opener, [report], { detached: true, stdio: 'ignore' }).unref() } catch {}
  }
  console.log('')
}

// ---------------------------------------------------------------- main
const [cmd, arg] = process.argv.slice(2)
const usage = `
${C.b}opt${C.x} — harness experiment monitor

  ${C.b}opt scan${C.x}               what this machine's Claude Code spend could save: settings, routing and
                         the rest, priced from the transcripts; free, no text leaves  ${C.d}· --dry · --help${C.x}
       ${C.d}--days 30   --since 2026-10-01   --admin-report usage.json   --no-open
       opt scan rollup DIR [DIR …]   one org view from several developers' scans${C.x}

  ${C.b}opt analyse${C.x}            load every session and classify it: interactive or not,
                         kind of work, the strategy to try first  ${C.d}(Jev on local Ollama)${C.x}
  ${C.b}opt optimize${C.x} [strategy]  run one non-interactive task in the local sandbox with that
                         strategy; the sandbox exits when the task does  ${C.d}· --help${C.x}
  ${C.b}opt audit${C.x}              every task analyse and optimize ran  ${C.d}· --verify · <task>${C.x}

  ${C.b}opt claude optimize${C.x} [dir] [--mode shadow|route] …   ${C.d}interactive: Claude Code behind LLM Ultra Light · --help${C.x}
  ${C.b}opt run${C.x} --experiments <a,b,c> [--session <id>] [--task <t>] [--budget N]
                         run one or more scenarios, grouped under a session

  ${C.b}opt demo run${C.x} [--scenarios <name>] [--task <name>] [--control <name>]
                         run the demo: control vs a scenario
                         --control replaces the stock arm with another scenario
  ${C.b}opt demo scenarios${C.x}                   what can be run
       ${C.d}--budget 10   --model opus   --dry${C.x}

  ${C.b}opt init${C.x}               is everything up: credentials, templates, tracing,
                         runners, and every session on disk
       ${C.d}--sessions 30          how many sessions to list in detail${C.x}

  ${C.b}opt secrets${C.x}            where each key comes from, and whether it works

  ${C.b}opt session${C.x}            last 48h, both kinds: e2b arms and this machine's own
  ${C.b}opt session${C.x} <#|ref>    that session's context window, the way /context draws it
  ${C.b}opt session ui${C.x}         the same table in a browser, click a row
       ${C.d}--since 7d   --all      window covered, default the last 48h
       --e2b   --local        one kind only
       --window 1m            pin a local session's context window
       --sort cost            order by a column (-cost to reverse)
       --watch                what is running right now, redrawn in place:
                              --live · --on 2026-09-01 · --once · --every=2 · --rows=20${C.x}

  ${C.b}opt session export${C.x} <#>  bundle a session so a sandbox can run it (${C.b}opt replay${C.x} runs it)
  ${C.b}opt replay${C.x} <#>          run a session again in a sandbox on an open-weights
                         model, and put the two side by side
  ${C.b}opt replay --new${C.x}       the whole experiment: start a local session, export it,
                         replay it on an open model, compare both graded
       ${C.d}--task regex   --runner openmodel | openmodel-bedrock | anthropic${C.x}

  ${C.b}opt tune${C.x} <bundle|#>     search for a better configuration; Claude reads each
                         generation and proposes the next
       ${C.d}-g 3   -n 4   --budget 4${C.x}

  ${C.b}opt hub start${C.x}          the Optimization Hub — sessions + analytics in a browser
  ${C.b}opt hub demo${C.x}           the hub on a synthetic AI-native startup (Tallyfox): triage,
                         experiments, optimize mode and audits, all generated

  ${C.b}opt claude -p${C.x} "<task>"   Claude Code headless in optimize mode: sandbox, LLM Ultra Light
                         gateway, the project's tuned profile and skills
       ${C.d}--compare              also run plain claude -p, then audit every claim
       opt claude example     the repo's example, both ways, audited
       opt claude runs · audit [run] · profile${C.x}
  ${C.b}opt models${C.x}             every model the gateway can use: Anthropic, local Ollama, Hugging Face

  ${C.b}opt monitor on${C.x}         send Claude Code's OpenTelemetry (metrics, events, spans) to
                         the local collector the hub runs; ${C.b}off${C.x} undoes it
  ${C.b}opt monitor status${C.x}     OTEL settings, the collector, LangSmith tracing, what arrived
       ${C.d}--endpoint URL         any OTLP/HTTP collector instead of the local one
       --langsmith-endpoint   a self-hosted LangSmith for the tracing plugin${C.x}

  ${C.b}opt flow run${C.x} <name>    autonomous flow: controller + worker + judge sandboxes
  ${C.b}opt flow ls${C.x}            what flows exist
       ${C.d}--github owner/repo    file the user story as a GitHub issue (opt-in)${C.x}

  ${C.b}opt artifacts${C.x}          render every deliverable to HTML and open one index
  ${C.b}opt artifacts ls${C.x}       list them in the terminal

  ${C.b}opt experiments${C.x}        every run, live or finished
  ${C.b}opt experiments ui${C.x}     baseline vs optimized, what moved, and how to apply it
  ${C.b}opt experiments results${C.x} [runId]
                         the written comparison, plus the levers to copy
       ${C.d}ps · status [ui] · logs <runId> · open <runId> · kill <runId|all>${C.x}
       ${C.d}deprecated, still run: opt ls · ps · status · ui · logs · open · kill · results · watch · opt opt${C.x}
`
// Overlapping forms with one home now: they still run, after one line on stderr naming it.
function deprecated(now) {
  process.stderr.write(`  ${C.y}deprecated:${C.x} opt ${process.argv.slice(2).join(' ')}  ${C.d}\u2192${C.x} ${C.b}${now}${C.x}\n`)
}
const tail = process.argv.slice(3).join(' ')
const moved = (sub) => deprecated(`opt experiments ${sub}${tail ? ' ' + tail : ''}`)

switch (cmd) {
  case 'scan': {
    // The engine is stdlib Python (tools/scan.py); this passes the flags through and opens the report.
    const args = process.argv.slice(3).filter((a) => a !== '--no-open')
    const out = process.env.OPT_HOME && !args.includes('--out') && args[0] !== 'rollup' ? ['--out', path.join(STATE_DIR, 'scan')] : []
    const code = await new Promise((r) => spawn('python3', [path.join(REPO_ROOT, 'tools', 'scan.py'), ...args, ...out], { stdio: 'inherit' })
      .on('error', (e) => { console.log(`\n  ${C.r}\u2717${C.x} python3 not found: ${e.message}\n`); r(127) }).on('exit', r))
    process.exitCode = code ?? 1
    const quiet = ['--dry', '--json', '--help', '-h', '--no-open', '--out'].some((f) => process.argv.includes(f)) || args[0] === 'rollup'
    if (code === 0 && !quiet && process.stdout.isTTY) {
      const report = path.join(out.length ? out[1] : path.join(REPO_ROOT, 'data', 'private', 'scan'), new Date().toISOString().slice(0, 10), 'report.html')
      if (fs.existsSync(report)) try { spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [report], { detached: true, stdio: 'ignore' }).unref() } catch {}
    }
    break
  }
  case 'init': case 'doctor': case 'setup':
    await cmdInit(process.argv.slice(3)); break
  case 'demo': await cmdDemo(arg, process.argv.slice(4)); break
  case 'experiments': case 'experiment': case 'exp': case 'x':
    await cmdExperiments(arg, process.argv.slice(4)); break
  case 'results': case 'report': moved('results'); await cmdResults(arg); break
  case 'secrets': await cmdSecrets(arg !== '--no-verify'); break
  case 'open': moved('open'); await cmdOpen(arg); break
  case 'session': case 'sessions': case 'se':
    if (process.argv.includes('--watch')) { await cmdWatch(process.argv.slice(3).filter((a) => a !== '--watch')); break }
    await cmdSession(arg, process.argv.slice(4)); break
  case 'replay': await cmdReplay(arg, process.argv.slice(4)); break
  case 'tune': await cmdTune(arg, process.argv.slice(4)); break
  case 'flow': await cmdFlow(arg, process.argv.slice(4)); break
  case 'hub': await cmdHub(arg); break
  case 'watch': case 'w':
    deprecated(`opt session --watch${tail ? ' ' + tail : ''}`)
    await cmdWatch(process.argv.slice(3)); break
  case 'artifacts': case 'art': await cmdArtifacts(arg); break
  case 'run': await cmdRun(process.argv.slice(3)); break
  case 'claude': {
    // opt <agent> <verb> — the agent is its own level so others (codex, aider…) slot in beside it.
    if (arg === 'optimize') {
      const { main } = await import('./optimize-live.mjs')
      // Credentials through the same path as every other command: .env, then 1Password for op://
      // references (one Touch ID prompt), only when a session actually starts.
      process.exitCode = await main(process.argv.slice(4), { agent: 'claude', resolveSecrets: (keys) => needSecrets(keys) })
    } else {
      // opt claude -p "…": headless, in optimize mode (gateway + profile + skills); example / runs / audit / profile
      const { main: claudeP } = await import('./claude-run.mjs')
      process.exitCode = await claudeP(process.argv.slice(3), { needSecrets })
    }
    break
  }
  case 'analyse': case 'analyze': {
    const { cmdAnalyse } = await import('./core.mjs')
    process.exitCode = await cmdAnalyse(process.argv.slice(3)); break
  }
  case 'optimize': case 'opt': {
    if (cmd === 'opt') deprecated(`opt optimize${tail ? ' ' + tail : ''}`)
    // Non-interactive runs in the local sandbox. The interactive, router-in-the-path mode is `opt claude optimize`.
    const { cmdOptimize } = await import('./core.mjs')
    process.exitCode = await cmdOptimize(process.argv.slice(3), { needSecrets }); break
  }
  case 'models': {
    const { cmdModels } = await import('./lib/models.mjs')
    process.exitCode = await cmdModels(process.argv.slice(3)); break
  }
  case 'monitor': case 'mon': {
    const { cmdMonitor } = await import('./lib/monitor.mjs')
    process.exitCode = await cmdMonitor(arg, process.argv.slice(4)); break
  }
  case 'audit': {
    const { cmdAudit } = await import('./core.mjs')
    process.exitCode = await cmdAudit(process.argv.slice(3)); break
  }
  case 'ls': moved('ls'); await cmdLs({ session: (process.argv.indexOf('--session') >= 0 ? process.argv[process.argv.indexOf('--session') + 1] : null) }); break
  case 'ps': moved('ps'); await cmdLs({ live: true }); break
  case 'status': case 'st':
    moved('status')
    if (arg === 'ui') await cmdStatusUi(process.argv[4]); else await cmdStatus(arg)
    break
  case 'ui': deprecated(`opt experiments status ui${tail ? ' ' + tail : ''}`); await cmdStatusUi(arg); break
  case 'logs': moved('logs'); await cmdLogs(arg); break
  case 'kill': moved('kill'); await cmdKill(arg ?? 'all'); break
  default: console.log(usage)
}
