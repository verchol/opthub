#!/usr/bin/env node
/** Optimization Hub — `opt hub start`. One server, sessions front and centre. */
import http from 'node:http'
import { STATE, ENV_FILE, REPO_ROOT } from './lib/state.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Sandbox } from '../sandbox/e2b/index.mjs'
import { buildIndex, sessionDetail } from './lib/sessions-index.mjs'
import { collectRuns, runsBySession } from './lib/hub-runs.mjs'
import { catalogPayload, loadCatalog } from './lib/optimizations.mjs'
import { atlasPotential } from './lib/atlas.mjs'
import { tagsFor } from './lib/tags.mjs'
import { shanaTova } from './lib/shana-tova.mjs'
import { watchList } from './lib/watch.mjs'
import { propose } from './lib/goals.mjs'
import { PAGE } from './lib/hub-page.mjs'
import { serveWeb } from './lib/web-dist.mjs'
import { insights } from './lib/insights.mjs'
import { behaviourPayload } from './lib/behaviour.mjs'
import { overviewPayload } from './lib/overview.mjs'
import { modelsCatalog } from './lib/models.mjs'
import { listClaudeRuns } from './lib/claims.mjs'
import { outRoot } from './lib/local-run.mjs'
import { handleOtlp, startCollector, OTLP_PORT } from './lib/otel.mjs'
import { parseEnvFile, isOpRef, opRead } from './secrets.mjs'
import { loadProfiles, render as renderProfile, classesFor, SANDBOX_MODELS } from './lib/llmlight.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const RUNNING = {}   // session id -> in-flight run status
const CHILD = {}     // session id -> child process
const TRIAGE = { child: null, startedAt: null, limit: 0 }   // the one re-run batch allowed at a time
const SCORE = { child: null, startedAt: null, days: 0, jev: false }   // the one scoring pass allowed at a time
// The scoring pipeline and the session graph: the Python side of this repo (OPTHUB_DIR: a fixture, in tests)
const OPTHUB = process.env.OPTHUB_DIR || REPO_ROOT
const GRAPH_TPL = path.join(OPTHUB, 'docs/preview/session-graph/triage-graph.template.html')
const GRAPH_PY = path.join(OPTHUB, 'tools/sessiongraph.py')
const GRAPH_SID = /^[0-9a-f-]{8,36}$/
const NO_TRANSCRIPT = 'no transcript for this session (expired or never recorded)'
const GRAPH_BUILD = {}   // session id -> the in-flight sessiongraph.py run
/** Jev's key: the environment first, then the repo's .env (a literal or an op:// reference). Read at click time only. */
function jevKey() {
  if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY
  const v = parseEnvFile(ENV_FILE).JEV_API_KEY
  if (!v) return ''
  try { return isOpRef(v) ? opRead(v) : v } catch { return '' }
}
const goalOf = (U) => (['cost', 'latency', 'accuracy'].includes(U.searchParams.get('goal')) ? U.searchParams.get('goal') : 'cost')
const hasJevKey = () => !!(process.env.JEV_API_KEY || parseEnvFile(ENV_FILE).JEV_API_KEY)

/** What answers on a local port: null (nothing), { synthetic } (a hub), or { other: true }. */
async function hubAt(port) {
  let r
  try { r = await fetch(`http://127.0.0.1:${port}/api/hub`, { signal: AbortSignal.timeout(1500) }) } catch { return null }
  try { return r.ok ? { synthetic: (await r.json()).synthetic ?? null } : { other: true } } catch { return { other: true } }
}
const DEMO_PORT = Number(process.env.HUB_DEMO_PORT ?? 8950)
// the newest sessions the hub reads: enough that a busy team's monthly totals are not cut off
const SESSION_LIMIT = Number(process.env.HUB_SESSION_LIMIT ?? 3000)
let demoStarted = 0
const switchPage = (res, title, body, refresh) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(`<!doctype html><meta charset=utf-8>${refresh ? '<meta http-equiv=refresh content=2>' : ''}<title>${title}</title>
<body style="margin:0;padding:48px;background:#0A0A0A;color:#D8D2C6;font:13px/1.6 'JetBrains Mono',ui-monospace,monospace">${body}`)
}
const redirect = (res, url) => { res.writeHead(302, { location: url, 'cache-control': 'no-store' }); res.end() }

/**
 * Your hub → the synthetic demo. Starts `opt hub demo` (building it the first time) when nothing
 * answers on its port; the page reloads itself until the demo is up, then goes there.
 */
async function switchToDemo(res, port) {
  if (process.env.HUB_SYNTHETIC) return redirect(res, '/')
  const at = await hubAt(DEMO_PORT)
  if (at?.synthetic) { demoStarted = 0; return redirect(res, `http://127.0.0.1:${DEMO_PORT}/?home=${port}`) }
  if (at) return switchPage(res, 'port busy', `Port ${DEMO_PORT} is taken by something other than the demo.<br>Stop it, or point the switch elsewhere: <b>HUB_DEMO_PORT=N opt hub start</b>`)
  const log = path.join(STATE, 'results', 'hub-demo.log')
  if (!demoStarted) {
    demoStarted = Date.now()
    fs.mkdirSync(path.dirname(log), { recursive: true })
    const fd = fs.openSync(log, 'w')
    spawn(process.execPath, [path.join(ROOT, 'opt.mjs'), 'hub', 'demo', '--no-open', '--port', String(DEMO_PORT)],
      { cwd: ROOT, env: { ...process.env, HUB_HOME_PORT: String(port) }, detached: true, stdio: ['ignore', fd, fd] }).on('error', () => {}).unref()
    fs.closeSync(fd)
  } else if (Date.now() - demoStarted > 180_000) {
    demoStarted = 0
    return switchPage(res, 'demo did not start', `The demo did not start within 3 minutes. Its log: <b>${log}</b><br><a style="color:#3DD6C4" href="/">back to your hub</a>`)
  }
  switchPage(res, 'starting the demo…', `Starting the synthetic demo on port ${DEMO_PORT}… (the first time, it builds the company first)`, true)
}

/** The demo → your hub, on the port the switch came from. Only a hub with your own data counts. */
async function switchHome(res, asked) {
  const port = /^\d{2,5}$/.test(asked ?? '') ? Number(asked) : Number(process.env.HUB_HOME_PORT ?? 8899)
  const at = await hubAt(port)
  if (at && !at.other && !at.synthetic) return redirect(res, `http://127.0.0.1:${port}/`)
  switchPage(res, 'your hub is not running', `Your own hub is not running on port ${port}. Start it with <b>opt hub start</b>.<br><a style="color:#3DD6C4" href="/">back to the demo</a>`)
}

function serve(port) {
  const RESULTS = path.join(STATE, 'results')
  const logPath = (id) => path.join(RESULTS, `.optlog-${id.slice(0, 12)}.log`)

  /**
   * Launch optimize.mjs for one session, in either mode. Both write the same
   * status.json and report.html, so everything downstream is shared.
   */
  const launch = (res, id, extraArgs, label) => {
    if (!/^[0-9a-f-]{6,}$/.test(id)) { res.writeHead(400); return res.end('bad session id') }
    if (RUNNING[id] && !['done', 'error', 'stopped', 'stale'].includes(RUNNING[id].phase)) return jsonTo(res, RUNNING[id])
    RUNNING[id] = { phase: 'starting', session: id, kind: label, startedAt: new Date().toISOString() }
    fs.mkdirSync(RESULTS, { recursive: true })
    const logStream = fs.createWriteStream(logPath(id))
    logStream.write(`${label} ${id} — started ${new Date().toISOString()}\n`)
    const child = spawn(process.execPath, [path.join(ROOT, 'optimize.mjs'), id, ...extraArgs],
      { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    CHILD[id] = child
    const onData = (d) => {
      logStream.write(d)
      const s = String(d)
      const m = /\b(analyzing|running|judging|booting)\b/.exec(s)
      if (m || /phase|plan:|grid:|ok ·|error ·|done ·/.test(s))
        RUNNING[id] = { ...(RUNNING[id] || {}), phase: m ? m[1] : 'running', session: id, pid: child.pid }
    }
    child.stdout.on('data', onData); child.stderr.on('data', onData)
    child.on('exit', (code, sig) => {
      logStream.end(`\n[exit ${code}${sig ? ' ' + sig : ''}]\n`)
      delete CHILD[id]
      const disk = runsBySession(ROOT)[id]
      RUNNING[id] = disk ?? { phase: sig ? 'stopped' : code === 0 ? 'done' : 'error', session: id }
    })
    return jsonTo(res, { phase: 'starting', session: id, kind: label })
  }
  /** session id -> its Triage record (Jev's classes), for the atlas */
  const triageBySession = () => {
    try { return Object.fromEntries(JSON.parse(fs.readFileSync(path.join(RESULTS, 'triage.json'), 'utf8')).sessions.filter((x) => x.session).map((x) => [x.session, x])) }
    catch { return {} }
  }
  /**
   * A Triage session's graph, stripped (opthub tools/sessiongraph.py, never --keep-text): results/<record.graph>
   * from export_hub.py, else results/graphs/<sid>.json, else built once from the transcript and cached there.
   */
  const graphFor = async (sid) => {
    const recs = Object.values(triageBySession())
    const rec = recs.find((x) => x.session === sid) ?? recs.find((x) => x.session.startsWith(sid)) ?? null
    const id = rec?.session ?? sid
    const read = (abs) => { try { const t = fs.readFileSync(abs, 'utf8'); JSON.parse(t); return t } catch { return null } }
    const inResults = (rel) => { const abs = path.normalize(path.join(RESULTS, rel)); return abs.startsWith(RESULTS + path.sep) ? abs : null }
    const fromExport = rec?.graph && inResults(rec.graph) ? read(inResults(rec.graph)) : null
    if (fromExport) return fromExport
    const cached = path.join(RESULTS, 'graphs', `${id}.json`)
    if (fs.existsSync(cached)) { const t = read(cached); if (t) return t }
    if (!fs.existsSync(GRAPH_PY)) return null
    fs.mkdirSync(path.dirname(cached), { recursive: true })
    GRAPH_BUILD[id] ??= new Promise((resolve) => execFile('python3', [GRAPH_PY, id, '-o', cached], { timeout: 20000 },
      (err) => { delete GRAPH_BUILD[id]; resolve(err ? null : read(cached)) }))
    return GRAPH_BUILD[id]
  }
  const graphMissingPage = (msg) => '<!doctype html><meta charset="utf-8"><title>No graph</title>'
    + '<style>body{font:14px/1.5 system-ui,sans-serif;margin:40px;color:#333;background:#fff}@media(prefers-color-scheme:dark){body{color:#ddd;background:#111}a{color:#3DD6C4}}</style>'
    + `<p>${msg.replace(/</g, '&lt;')}</p><p><a href="/" target="_top">◂ back to Triage</a></p>`
  const jsonTo = (res, o) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)) }

  const server = http.createServer((req, res) => {
    const U = new URL(req.url, 'http://x')
    const json = (o) => jsonTo(res, o)

    if (U.pathname.startsWith('/api/sessions')) {
      // potential is derived, not stored: computed here so the page renders it
      // without shipping the pricing model to the browser.
      // watchList wraps buildIndex and adds live/open/idle/closed per session
      const idx = watchList({ limit: SESSION_LIMIT })
      // potential comes from the Optimization Atlas, priced on each session's own measurements and its Jev classes
      const tri = triageBySession()
      for (const s of idx.sessions) { const p = atlasPotential(s, tri[s.id]); s.potential = p; s.potPct = p.lo; s.shanaTova = shanaTova(s); s.tags = tagsFor(s) }
      return json(idx)
    }
    // one session with its per-turn series — fetched on demand, never in the list
    if (U.pathname === '/api/session') {
      const d = sessionDetail(U.searchParams.get('id') || '')
      if (!d) { res.writeHead(404); return res.end('no such session') }
      d.potential = atlasPotential(d, triageBySession()[d.id]); d.shanaTova = shanaTova(d); d.tags = tagsFor(d)
      return json(d)
    }
    // Analytics → Percentiles / Classes / Similar: every session classified, attributes ranked, neighbours
    if (U.pathname === '/api/insights') return json(insights(watchList({ limit: SESSION_LIMIT }).sessions, triageBySession()))
    // which hub this is: your data, or a synthetic company (opt hub demo)
    if (U.pathname === '/api/hub') return json({ synthetic: process.env.HUB_SYNTHETIC ?? null, port })
    // the sidebar's switch between the two: each is its own hub on its own port
    if (U.pathname === '/api/switch/demo') return switchToDemo(res, port)
    if (U.pathname === '/api/switch/home') return switchHome(res, U.searchParams.get('port'))
    // Overview: the landing page — spend, where it went, and what could be saved, each saving labelled by evidence
    if (U.pathname === '/api/overview') {
      const tri = triageBySession()
      const sessions = watchList({ limit: SESSION_LIMIT }).sessions
      // Behaviour is read only if it is ready within a moment: LangSmith must never hold up the landing page
      const beh = Promise.race([behaviourPayload({ days: 30 }).catch(() => null), new Promise((r) => setTimeout(() => r(null), 3000))])
      let triage = null
      try { triage = JSON.parse(fs.readFileSync(path.join(RESULTS, 'triage.json'), 'utf8')) } catch {}
      beh.then((behaviour) => overviewPayload({ sessions, potentialOf: (s) => atlasPotential(s, tri[s.id]), behaviour, triage }))
        .then(json).catch((e) => { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String(e?.message ?? e)) })
      return
    }
    // Optimize → Models: Anthropic, the local Ollama (live), the Hugging Face cache
    if (U.pathname === '/api/models') { modelsCatalog({ fresh: U.searchParams.has('fresh') }).then(json); return }
    // opt claude -p runs, with their claims audits
    if (U.pathname === '/api/claude-runs') return json({ runs: listClaudeRuns(outRoot(), 30) })
    if (U.pathname === '/api/claude-run') {
      const id = U.searchParams.get('id') || ''
      if (!/^cp-[0-9a-z-]+$/i.test(id)) { res.writeHead(400); return res.end('bad run id') }
      const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(outRoot(), id, f), 'utf8')) } catch { return null } }
      const run = read('run.json')
      if (!run) { res.writeHead(404); return res.end('no such run') }
      return json({ run, claims: read('claims.json') })
    }
    // Analytics → Behaviour: Claude Code turns from LangSmith traces and the local OTEL store
    if (U.pathname === '/api/behaviour') {
      const days = Math.min(90, Math.max(1, Number(U.searchParams.get('days')) || 7))
      // OTEL spans carry no project: take it from the session's transcript folder
      const cwd = Object.fromEntries(watchList({ limit: SESSION_LIMIT }).sessions.map((s) => [s.id, s.cwd]))
      const projectOf = (sid) => (cwd[sid] ? path.basename(cwd[sid]) : null)
      behaviourPayload({ days, project: U.searchParams.get('project') || '', source: U.searchParams.get('source') || 'auto', projectOf })
        .then(json)
        .catch((e) => { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String(e?.message ?? e)) })
      return
    }
    // OTLP/HTTP for Claude Code, on the hub's own port too (opt monitor points at the fixed collector port)
    if (handleOtlp(req, res, U.pathname, '/otel')) return
    if (U.pathname === '/api/catalog') return json(catalogPayload(ROOT))
    if (U.pathname === '/api/runs') return json({ runs: collectRuns(ROOT), bySession: runsBySession(ROOT) })
    // Triage: the session classification (opthub repo, experiments/session-triage/src/export_hub.py)
    // and its re-run queue — sessions the classifier could not place on a model tier.
    if (U.pathname === '/api/triage') {
      let t = { sessions: [], missing: true }
      try { t = JSON.parse(fs.readFileSync(path.join(RESULTS, 'triage.json'), 'utf8')) } catch {}
      // a batch started by another hub or a shell holds the lock
      let other = false
      try { const pid = Number(fs.readFileSync(path.join(RESULTS, '.triage-rerun.lock'), 'utf8')); process.kill(pid, 0); other = !TRIAGE.child } catch {}
      let step = ''
      try { step = (fs.readFileSync(path.join(RESULTS, '.triage-score.log'), 'utf8').match(/\[\d\/5\] [^\n]*|scoring done|archived[^\n]*/g) || []).pop() || '' } catch {}
      return json({ ...t, rerun: { running: !!TRIAGE.child || other, elsewhere: other, startedAt: TRIAGE.startedAt, limit: TRIAGE.limit },
        graph: { available: fs.existsSync(GRAPH_TPL) },
        score: { running: !!SCORE.child, startedAt: SCORE.startedAt, days: SCORE.days, jev: SCORE.child ? SCORE.jev : hasJevKey(), step,
          available: fs.existsSync(path.join(OPTHUB, 'experiments/session-triage/src/score.py')) } })
    }
    // Score with Jev: ledger -> features + Claude Code settings -> rules + Jev -> per-method scores -> triage.json.
    // One Jev call per session (paid) when a key is set; rules only otherwise. Everything else is local.
    if (U.pathname === '/api/triage/score' && req.method === 'POST') {
      if (SCORE.child) return json({ running: true, startedAt: SCORE.startedAt })
      const days = Math.max(1, Math.min(30, Number(U.searchParams.get('days') || 30)))
      const script = path.join(OPTHUB, 'experiments/session-triage/src/score.py')
      if (!fs.existsSync(script)) { res.writeHead(404); return res.end(`no scoring pipeline at ${script}`) }
      const key = jevKey()
      fs.mkdirSync(RESULTS, { recursive: true })
      const log = fs.createWriteStream(path.join(RESULTS, '.triage-score.log'))
      log.write(`score — started ${new Date().toISOString()} · ${days} days · ${key ? 'Jev' : 'rules only (no JEV_API_KEY)'}\n`)
      // OPT_TRIAGE_DIR: score.py's working files (default: the opthub repo's gitignored data/private/)
      const work = process.env.OPT_TRIAGE_DIR ? ['--dir', process.env.OPT_TRIAGE_DIR] : []
      const child = spawn('python3', [script, '--days', String(days), '--out', path.join(RESULTS, 'triage.json'), ...work],
        { cwd: path.dirname(script), env: { ...process.env, ...(key ? { JEV_API_KEY: key } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
      Object.assign(SCORE, { child, startedAt: new Date().toISOString(), days, jev: !!key })
      child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
      child.on('exit', (code) => { log.end(`\n[exit ${code}]\n`); SCORE.child = null })
      return json({ running: true, days, jev: !!key })
    }
    if (U.pathname === '/api/triage/score/log') {
      let body = ''; try { body = fs.readFileSync(path.join(RESULTS, '.triage-score.log'), 'utf8') } catch { body = '(not scored from the hub yet)' }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); return
    }
    if (U.pathname === '/api/triage/rerun' && req.method === 'POST') {
      if (TRIAGE.child) return json({ running: true, startedAt: TRIAGE.startedAt })
      const limit = Math.max(1, Math.min(10, Number(U.searchParams.get('limit') || 3)))
      fs.mkdirSync(RESULTS, { recursive: true })
      const log = fs.createWriteStream(path.join(RESULTS, '.triage-rerun.log'))
      const child = spawn(process.execPath, [path.join(ROOT, 'triage-rerun.mjs'), '--go', `--limit=${limit}`],
        { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
      Object.assign(TRIAGE, { child, startedAt: new Date().toISOString(), limit })
      child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
      child.on('exit', (code) => { log.end(`\n[exit ${code}]\n`); TRIAGE.child = null })
      return json({ running: true, limit })
    }
    if (U.pathname === '/api/triage/rerun/stop' && req.method === 'POST') {
      if (TRIAGE.child) TRIAGE.child.kill('SIGTERM')
      return json({ stopping: !!TRIAGE.child })
    }
    // LLM Light profiles, each rendered for the requested target (local | sandbox), optionally with a
    // project's Triage classes baked in
    if (U.pathname === '/api/profiles') {
      const P = loadProfiles(ROOT), target = U.searchParams.get('target') === 'sandbox' ? 'sandbox' : 'local'
      const project = U.searchParams.get('project') || ''
      let tri = null; try { tri = JSON.parse(fs.readFileSync(path.join(RESULTS, 'triage.json'), 'utf8')) } catch {}
      const classes = project ? classesFor(project, tri) : {}
      const rendered = P.profiles.map((p) => {
        try { const r = renderProfile(p, { target, MODELS: SANDBOX_MODELS, classes }); return { id: p.id, summary: r.summary, env: r.env, flags: r.flags, yaml: r.litellmYaml, tiers: r.tiers, hook: r.hookProfile } }
        catch (e) { return { id: p.id, error: e.message } }
      })
      return json({ ...P, target, project, classes, rendered })
    }
    // a Triage session's graph: the JSON (/api/triage/:sid/graph) or the opthub page around it (/triage/:sid/graph)
    const gm = /^\/(api\/)?triage\/([^/]+)\/graph$/.exec(U.pathname)
    if (gm) {
      const api = !!gm[1], sid = decodeURIComponent(gm[2])
      const fail = (code, msg) => api
        ? (res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }), res.end(JSON.stringify({ error: msg })))
        : (res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }), res.end(graphMissingPage(msg)))
      if (!GRAPH_SID.test(sid)) return fail(400, 'bad session id')
      graphFor(sid).then((graph) => {
        if (!graph) return fail(404, NO_TRANSCRIPT)
        if (api) { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(graph) }
        // read on every request, so template edits show without a restart
        let html; try { html = fs.readFileSync(GRAPH_TPL, 'utf8') } catch { return fail(404, `no graph template at ${GRAPH_TPL}`) }
        // inside a <script>: a "</script>" in a file name must not close it
        html = html.split('/*GRAPH*/null').join(graph.replace(/</g, '\\u003c'))
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html)
      }, (e) => fail(500, String(e?.message ?? e)))
      return
    }
    if (U.pathname === '/api/triage/log') {
      let body = ''; try { body = fs.readFileSync(path.join(RESULTS, '.triage-rerun.log'), 'utf8') } catch { body = '(no re-run yet)' }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); return
    }

    // in-flight status wins over what is on disk, for every session
    if (U.pathname === '/api/optimize/all') {
      const out = {}
      for (const [sid, r] of Object.entries(runsBySession(ROOT))) out[sid] = r
      return json({ ...out, ...RUNNING })
    }
    if (U.pathname === '/api/optimize/status') {
      const id = U.searchParams.get('session') || ''
      return json(RUNNING[id] ?? runsBySession(ROOT)[id] ?? { phase: null })
    }
    if (U.pathname === '/api/optimize' && req.method === 'POST')
      return launch(res, U.searchParams.get('session') || '', ['--budget=3', '--max=3', `--goal=${goalOf(U)}`], 'optimize')

    // Strategies for one session and one goal: goals.mjs ranks the levers on the session's own
    // tokens; Jev's per-method score (Triage) is attached as evidence, never as the ranking.
    if (U.pathname === '/api/strategies') {
      const id = U.searchParams.get('session') || '', goal = goalOf(U)
      const s = sessionDetail(id)
      if (!s) { res.writeHead(404); return res.end('no such session') }
      const cat = loadCatalog(ROOT, { fresh: true }).experiments
      const runnable = (x) => cat.some((e) => e.id === x && e.runnable !== false && !e.control)
      const tri = triageBySession()[id]
      const JEV = { 'route-cheaper-frontier': 'route', 'context-compaction': 'context', 'effort-medium': 'effort', 'effort-low': 'effort',
        'claude-thinking-cap': 'effort', 'litellm-route-side-calls': 'side-calls' }
      const jev = (lever) => { const m = tri?.methods?.find((x) => x.id === JEV[lever]); return m ? { score: m.score, unlocked: m.unlocked, saving: m.saving, pct: m.pct } : null }
      // Jev answered and said no: the lever sinks to the bottom of the list, whatever the goal
      const against = (c) => { const j = c.levers.length === 1 ? jev(c.levers[0]) : null; return !!j && j.score != null && j.score < 0.2 && !j.unlocked }
      const p = propose(s, { goal, temperature: goal === 'accuracy' ? 'conservative' : 'balanced', runnable, adjust: (c) => (against(c) ? -1000 : 0) })
      const title = (x) => cat.find((e) => e.id === x)?.title ?? x
      return json({ goal, session: id, pick: p.pick?.id ?? null, considered: p.considered.map((c) => ({
        id: c.id, title: c.levers.map(title).join(' + '), levers: c.levers, runnable: c.ok && c.levers.length === 1,
        ok: c.ok, why: c.why ?? null, risk: c.risk, rank: c.rank ?? null, jevAgainst: against(c), best: c.best, worst: c.worst, caughtBy: c.caughtBy, jev: c.levers.length === 1 ? jev(c.levers[0]) : null })) })
    }

    if (U.pathname === '/api/experiment' && req.method === 'POST') {
      const id = U.searchParams.get('session') || ''
      const exp = U.searchParams.get('experiment') || ''
      const entry = loadCatalog(ROOT, { fresh: true }).experiments.find((e) => e.id === exp)
      if (!entry) { res.writeHead(400); return res.end(`no experiment "${exp}"`) }
      if (entry.runnable === false || entry.control) { res.writeHead(400); return res.end(`experiment "${exp}" is not runnable here`) }
      return launch(res, id, [`--experiment=${exp}`, '--budget=3', `--goal=${goalOf(U)}`], `experiment ${exp}`)
    }
    if (U.pathname === '/api/optimize/stop' && req.method === 'POST') {
      const id = U.searchParams.get('session') || ''
      const c = CHILD[id]
      if (c) { c.kill('SIGTERM'); RUNNING[id] = { ...(RUNNING[id] || {}), phase: 'stopping', session: id } }
      // belt and braces: sweep any optimize sandboxes still up
      ;(async () => { try { const all = await Sandbox.list(); const items = all?.sandboxes ?? all ?? []
        for (const sb of items.filter((x) => x?.metadata?.role === 'optimize')) await Sandbox.kill(sb.sandboxId).catch(() => {}) } catch {} })()
      return json({ phase: c ? 'stopping' : 'not-running', session: id })
    }
    if (U.pathname === '/api/optimize/log') {
      const id = U.searchParams.get('session') || ''
      let body = ''; try { body = fs.readFileSync(logPath(id), 'utf8') } catch { body = '(no log yet)' }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); return
    }
    if (U.pathname === '/optlog') {
      const id = U.searchParams.get('session') || ''
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><meta charset=utf-8><title>optimize log ${id.slice(0,8)}</title>
<style>body{margin:0;background:#0A0A0A;color:#D8D2C6;font:12.5px/1.55 'JetBrains Mono',ui-monospace,monospace}
header{position:sticky;top:0;background:#000;border-bottom:1px solid #1c1c1c;padding:8px 14px;display:flex;gap:14px;align-items:center}
b{color:#3DD6C4}button{font:11px 'JetBrains Mono',monospace;background:none;border:1px solid #A8611F;color:#F0A868;padding:4px 12px;cursor:pointer}
pre{margin:0;padding:14px;white-space:pre-wrap;word-break:break-word}#s{color:#7C7C7C}</style>
<header><b>optimize ${id.slice(0,8)}</b><span id=s>connecting…</span><button onclick="stop()">stop run</button></header><pre id=l></pre>
<script>
async function tick(){try{const t=await(await fetch('/api/optimize/log?session=${encodeURIComponent(id)}',{cache:'no-store'})).text()
 document.getElementById('l').textContent=t
 const near=window.scrollY+innerHeight>document.body.scrollHeight-80;if(near)window.scrollTo(0,document.body.scrollHeight)
 let st={};try{st=await(await fetch('/api/optimize/status?session=${encodeURIComponent(id)}')).json()}catch(e){}
 document.getElementById('s').textContent='phase: '+(st.phase||'?')+(st.totalCost!=null?'  ·  $'+Number(st.totalCost).toFixed(4):'')
}catch(e){}}
async function stop(){await fetch('/api/optimize/stop?session=${encodeURIComponent(id)}',{method:'POST'});document.getElementById('s').textContent='stopping…'}
tick();setInterval(tick,2000)
</script>`); return
    }
    // the Optimization Atlas, served locally so a session can open in it with its own workload
    if (U.pathname === '/atlas' || U.pathname === '/atlas/') {
      let body = '<p>docs/atlas/index.html is missing — build it with docs/atlas/build.mjs.</p>'
      try { body = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'atlas', 'index.html'), 'utf8') } catch {}
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body.startsWith('<!doctype') ? body : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + body)
      return
    }
    // static files: reports and artifacts live under results/, docs/ and config/
    if (/^\/(results|docs|config)\//.test(U.pathname)) {
      const rel = decodeURIComponent(U.pathname).replace(/^\//, '')
      if (rel.split('/').some((seg) => seg === '..')) { res.writeHead(404); return res.end('not found') }
      const abs = path.normalize(path.join(ROOT, rel))
      const okDir = ['results', 'docs', 'config'].some((d) => abs.startsWith(path.join(ROOT, d) + path.sep))
      if (!okDir) { res.writeHead(403); return res.end('forbidden') }
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); return res.end('not found') }
      const ext = path.extname(abs).toLowerCase()
      const ct = { '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json',
                   '.yaml': 'text/plain; charset=utf-8', '.yml': 'text/plain; charset=utf-8',
                   '.diff': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.jsonl': 'text/plain; charset=utf-8',
                   '.py': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' }[ext] ?? 'application/octet-stream'
      res.writeHead(200, { 'content-type': ct, 'cache-control': 'no-store' }); res.end(fs.readFileSync(abs)); return
    }
    // an API path this server does not know is a 404 in JSON, never the page: a page newer than the
    // running server then says "restart the hub" instead of failing to parse HTML as data
    if (U.pathname.startsWith('/api/')) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'unknown API', path: U.pathname })) }
    // the pre-React page, kept on this branch for side-by-side checks until the port is signed off
    if (U.pathname === '/classic') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGE) }
    // HUB_SYNTHETIC (opt hub demo): the page knows it is the demo; HUB_BANNER (--banner) also labels every page as generated
    serveWeb(req, res, U.pathname, process.env.HUB_SYNTHETIC ? { head: `<script>window.HUB_SYNTHETIC=${JSON.stringify(process.env.HUB_SYNTHETIC)};window.HUB_BANNER=${process.env.HUB_BANNER ? 'true' : 'false'}</script>` } : {})
  })
  return new Promise((resolve) => {
    server.on('error', () => resolve({ error: `port ${port} busy` }))
    server.listen(port, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${port}/`, server }))
  })
}

const cmd = process.argv[2] ?? 'start'
if (cmd === 'start') {
  let port = Number(process.env.HUB_PORT ?? 8899)
  let s = await serve(port)
  for (let i = 0; s.error && i < 10; i++) s = await serve(++port)
  if (s.error) { console.error(s.error); process.exit(1) }
  console.log(`\n  Optimization Hub → ${s.url}\n  (sessions · experiments · analytics · ctrl-c to stop)\n`)
  // the OTLP receiver `opt monitor on` points Claude Code at; a busy port means one is already running
  const col = await startCollector({ port: OTLP_PORT })
  console.log(col.error ? `  otel: ${col.error}` : `  otel collector → ${col.url}  (opt monitor on)`)
  console.log(`  opthub: ${OPTHUB}`)
  if (!fs.existsSync(GRAPH_TPL)) console.warn(`  warning: no session-graph template at ${GRAPH_TPL} — Triage → Graph is off\n`)
  const o = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  // no browser opener (a server, a container): the spawn fails asynchronously, so it needs an 'error'
  // handler — try/catch alone let it take the hub down
  if (!process.argv.includes('--no-open')) try { spawn(o, [s.url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref() } catch {}
} else {
  console.log('usage: node hub.mjs start')
}
