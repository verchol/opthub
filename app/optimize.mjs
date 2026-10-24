#!/usr/bin/env node
/**
 * Optimization loop for one real session:
 *   1. analyze the session (Claude on Bedrock proposes a parameter grid)
 *   2. run each grid cell in parallel in a sandbox, on Bedrock
 *   3. judge the produced artifacts against the original session's
 *   4. write results/optrun-<id>-<stamp>/report.html and status.json
 *
 *   node optimize.mjs <sessionId> [--budget=3] [--max=3]
 *
 * Experiment mode — one named lever from config/optimizations.json, run against
 * its own baseline arm so the delta is attributable to that one variable:
 *
 *   node optimize.mjs <sessionId> --experiment=route-open-weights
 *
 * Both modes write the same status.json and report.html, so the hub renders
 * them through one path and the verdict reads the same either way.
 */
import { Sandbox } from '../sandbox/e2b/index.mjs'
import { STATE, ENV_FILE } from './lib/state.mjs'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSecrets, parseEnvFile } from './secrets.mjs'
import { processTranscript, findTranscript } from './lib/sessions-index.mjs'
import { loadCatalog, resolveArm, armDiff, armTag } from './lib/optimizations.mjs'
import { writeReport } from './lib/opt-report.mjs'
import { litellmConfig, claudeEnv, claudeFlags, claudeSettings, priceResult } from './lib/arm-config.mjs'
import { profileById, renderFiles, classesFor, readAudit } from './lib/llmlight.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const WORK = '/home/user/work'
console.log('optimize: starting up')
// If creds are already in the environment (hub started from a warmed shell), use
// them and never touch 1Password — op read blocks ~20s per key otherwise.
const needOp = !(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.E2B_API_KEY)
if (needOp) { console.log('optimize: resolving secrets from 1Password (may prompt)…'); resolveSecrets(['E2B_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) }
for (const [k, v] of Object.entries(parseEnvFile(ENV_FILE))) if (!process.env[k] && !String(v).startsWith('op://')) process.env[k] = v
const REGION = process.env.AWS_REGION || 'eu-north-1'
const ACTIVE = new Set()   // live sandboxes, so a SIGTERM stop can tear them down
let STOPPING = false

const MODELS = {
  'opus45':  { label: 'Claude Opus 4.5',   bedrock: 'eu.anthropic.claude-opus-4-5-20251101-v1:0', inM: 5, outM: 25 },
  'sonnet46':{ label: 'Claude Sonnet 4.6',  bedrock: 'eu.anthropic.claude-sonnet-4-6',             inM: 3, outM: 15 },
  'qwen480': { label: 'Qwen3-Coder-480B',   bedrock: 'qwen.qwen3-coder-480b-a35b-v1:0',            inM: 0.22, outM: 1.80 },
  'qwen30':  { label: 'Qwen3-Coder-30B',    bedrock: 'qwen.qwen3-coder-30b-a3b-v1:0',              inM: 0.07, outM: 0.28 },
}
// Claude Code accepts 'auto' or 100k–1M here and rejects anything smaller before
// the first turn. The old value (60000) killed every compaction arm silently.
const CATALOG = loadCatalog(ROOT)
const AUTOCOMPACT = CATALOG.about?.autocompactTokens ?? '100k'
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/**
 * baseline, exp1, exp2 … plus the one-phrase tag naming what each varies, and
 * the parameter diff behind it. A chart axis has room for "exp1 · model", not
 * for a sentence, and the diff is what proves the arm varied anything at all.
 */
const modelPrice = (id) => { const m = MODELS[id]; return m ? m.inM + m.outM : null }
function nameArms(grid, entries = []) {
  const base = grid[0]
  return grid.map((c, i) => {
    const diff = armDiff(c, base)
    return { ...c,
      armId: i === 0 ? 'baseline' : `exp${i}`,
      armTag: i === 0 ? null : armTag(c, base, entries[i], modelPrice),
      armDiff: diff,
      armSame: i > 0 && diff.length === 0,
      role: i === 0 ? 'baseline' : 'optimized' }
  })
}
const short = (s, n = 80) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
/** The session's own tier, mapped onto what this sandbox can actually serve. */
const baselineModel = (session) => session.modelTier === 'opus' ? 'opus45' : 'sonnet46'

function bedrock(modelId, prompt, maxTokens = 900) {
  const body = JSON.stringify({ messages: [{ role: 'user', content: [{ text: prompt }] }], inferenceConfig: { maxTokens } })
  const out = execFileSync('aws', ['bedrock-runtime', 'converse', '--region', REGION, '--model-id', modelId, '--cli-input-json', body, '--output', 'json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180000, env: { ...process.env, AWS_DEFAULT_REGION: REGION } })
  return JSON.parse(out).output.message.content[0].text
}
/**
 * Models fence their JSON, prefix it with prose, or both. The old code did
 * `/\{[\s\S]*\}/.exec(txt)[0]` and threw on null, which is how every judge
 * verdict in results/ became "Judge unavailable".
 */
function askJson(modelId, prompt, maxTokens = 900) {
  const txt = bedrock(modelId, prompt, maxTokens)
  const body = txt.replace(/^[\s\S]*?```(?:json)?\s*/i, '').replace(/```[\s\S]*$/, '')
  for (const c of [body, txt]) {
    const s = c.indexOf('{'), e = c.lastIndexOf('}')
    if (s < 0 || e <= s) continue
    try { return JSON.parse(c.slice(s, e + 1)) } catch {}
  }
  throw new Error(`model did not return JSON: ${short(txt, 120)}`)
}

/** Claude proposes which parameters to vary, given the session's shape. */
function analyze(session, max) {
  const prompt = `You are tuning how a coding agent runs. A past session had these characteristics:
- request: ${short(session.intent, 200)}
- model used: ${session.model}
- cost: $${session.cost}  ·  turns: ${session.turns}  ·  produced: ${session.hasArtifact ? session.artifacts.map((a) => a.name).join(', ') : 'nothing'}
- task kind: ${session.kind}

Propose up to ${max} configurations to re-run this task with, to find a cheaper or better one. Vary MODEL and CONTEXT COMPACTION. Available models: ${Object.keys(MODELS).join(', ')} (opus45/sonnet46 are frontier; qwen* are open-weights, far cheaper, weaker on hard reasoning). Compaction reduces context cost but can drop needed detail.

Reply ONLY JSON: {"rationale":"<one sentence>","grid":[{"label":"...","model":"<one of the ids>","compaction":true|false}]}`
  try {
    const j = askJson('eu.anthropic.claude-sonnet-4-6', prompt, 500)
    j.grid = (j.grid || []).filter((c) => MODELS[c.model]).slice(0, max)
    if (!j.grid.length) throw new Error('empty grid')
    return j
  } catch (e) {
    // fallback grid: the original-tier frontier vs two cheaper open models
    console.log(`  plan: analysis unavailable (${short(e.message, 80)}) — using the default grid`)
    return { rationale: 'default grid (analysis unavailable): frontier vs open-weights', grid: [
      { label: 'Opus 4.5', model: 'opus45', compaction: false },
      { label: 'Qwen-480B', model: 'qwen480', compaction: false },
      { label: 'Qwen-480B + compaction', model: 'qwen480', compaction: true },
    ].slice(0, max) }
  }
}

/** The flags for one arm. Everything the arm can vary lives here. */
function armFlags(cell, budget) {
  const f = ['-p', '--output-format json', '--dangerously-skip-permissions', '--no-session-persistence',
             '--disallowed-tools WebSearch WebFetch', `--max-budget-usd ${cell.budgetUsd ?? budget}`, '--model opus']
  if (cell.compaction) f.push(`--autocompact ${AUTOCOMPACT}`)
  if (cell.effort && EFFORTS.has(cell.effort)) f.push(`--effort ${cell.effort}`)
  if (cell.flags) f.push(cell.flags)
  const cf = claudeFlags(cell.claude)
  if (cf) f.push(cf)
  return f.join(' ')
}

async function runCell(cell, session, inputs, budget, template) {
  const m = MODELS[cell.model]
  if (!m) throw new Error(`unknown model id "${cell.model}"`)
  process.stdout.write(`  ${cell.label.padEnd(26)} booting… `)
  const sbx = await Sandbox.create(template, { timeoutMs: 30 * 60 * 1000, metadata: { harnessDemo: '1', role: 'optimize', model: cell.model } })
  console.log(sbx.sandboxId)
  ACTIVE.add(sbx)
  const cr = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, AWS_REGION: REGION, AWS_DEFAULT_REGION: REGION }
  try {
    await sbx.commands.run(`mkdir -p ${WORK}`)
    await sbx.files.write(inputs.map((f) => ({ path: `${WORK}/${f.rel}`, data: f.data })))
    await sbx.commands.run(`cd ${WORK} && git init -q && git add -A && git -c user.email=r@r -c user.name=r commit -qm base`)
    // an LLM Light arm brings its own proxy config, hook and rules; the project's Triage classes are baked in
    let ll = null
    if (cell.llmlight) {
      let tri = null; try { tri = JSON.parse(fs.readFileSync(path.join(STATE, 'results', 'triage.json'), 'utf8')) } catch {}
      ll = renderFiles(ROOT, profileById(ROOT, cell.llmlight), { target: 'sandbox', MODELS, classes: classesFor(session.cwd, tri) })
      await sbx.files.write([{ path: '/home/user/llmlight_router.py', data: ll.files['llmlight_router.py'] },
                             { path: '/home/user/llmlight_profile.json', data: ll.files['llmlight_profile.json'] }])
    }
    const cfg = ll ? ll.litellmYaml : litellmConfig(m, cell.litellm, MODELS)
    await sbx.files.write('/home/user/lc.yaml', cfg)
    await sbx.commands.run('litellm --config /home/user/lc.yaml --port 4000 --host 127.0.0.1 > /home/user/ll.log 2>&1', { background: true, timeoutMs: 0, envs: cr })
    const up = await sbx.commands.run(`for i in $(seq 1 90); do curl -sf -o /dev/null http://127.0.0.1:4000/health/liveliness && break; sleep 2; done; curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4000/health/liveliness`, { timeoutMs: 300000, envs: cr })
    if (up.stdout.trim() !== '200') throw new Error('litellm not ready')
    const flags = armFlags(cell, budget) + (ll?.flags ? ' ' + ll.flags : '')
    const req = cell.appendPrompt ? `${session.intent}\n\n## Additional instruction\n\n${cell.appendPrompt}\n` : session.intent
    await sbx.files.write(`${WORK}/.req`, req)
    const settings = claudeSettings(cell.claude)
    if (settings) await sbx.files.write(`${WORK}/.claude/settings.json`, settings)
    const t0 = Date.now()
    // The exit code and stderr are the only evidence when claude refuses a flag
    // and dies before the first turn. Losing them turned a hard failure into a
    // run that reported 0 turns, $0 and no error.
    await sbx.commands.run(`cd ${WORK} && cat .req | claude ${flags} > /home/user/out.json 2>/home/user/err.txt; echo $? > /home/user/rc.txt`,
      { timeoutMs: 22 * 60 * 1000, envs: { ...cr, ...claudeEnv(cell.claude), ...(ll?.env ?? {}), ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000', ANTHROPIC_API_KEY: 'sk-local', CI: '1' } })
    const secs = Math.round((Date.now() - t0) / 1000)
    const readIf = async (p) => { try { return await sbx.files.read(p) } catch { return '' } }
    let r = null; try { r = JSON.parse(await sbx.files.read('/home/user/out.json')) } catch {}
    const rc = Number(String(await readIf('/home/user/rc.txt')).trim() || 0)
    const stderr = String(await readIf('/home/user/err.txt')).trim()
    const diff = (await sbx.commands.run(`cd ${WORK} && rm -f .req && git add -A && git diff --cached --stat && echo '---8<---' && git diff --cached`).catch(() => ({ stdout: '' }))).stdout
    // numstat is the only reliable source for added/removed; --stat truncates
    const numstat = (await sbx.commands.run(`cd ${WORK} && git diff --cached --numstat`).catch(() => ({ stdout: '' }))).stdout
    const u = r?.usage ?? {}
    const inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    // a routed arm is priced from the proxy's own audit (what each tier actually cost), not from the
    // model names Claude Code asked for — those are the names before routing
    const llAudit = ll ? readAudit(await readIf('/home/user/llmlight-audit.jsonl')) : null
    const cost = llAudit && llAudit.cost > 0 ? llAudit.cost : priceResult(r, m, MODELS, cell.litellm?.routes)
    const artifacts = [...diff.matchAll(/^\s*(\S+)\s+\|\s+\d+/gm)].map((x) => x[1]).filter((f) => f && f !== '---8<---')
    let added = 0, removed = 0
    for (const l of numstat.split('\n')) { const m2 = /^(\d+)\s+(\d+)\s+(.+)$/.exec(l.trim()); if (m2) { added += +m2[1]; removed += +m2[2] } }
    const metrics = { files: artifacts.length, added, removed,
                      bytes: (diff.split('---8<---')[1] ?? '').length,
                      testFiles: artifacts.filter((f) => /(^|\/)tests?[\/_]|_test\.|\.test\./i.test(f)).length }
    // No parsable result is a failure, not a free success. The old code left
    // isError false here, which is what made a dead arm look like a $0 winner.
    const isError = !!r?.is_error || rc !== 0 || !r
    const err = isError ? short(r?.is_error ? r?.result : (stderr || `claude exited ${rc} with no output`), 300) : ''
    console.log(`  ${cell.label.padEnd(26)} ${isError ? 'error' : 'ok'} · ${r?.num_turns ?? 0} turns · ${secs}s · $${cost.toFixed(4)} · ${artifacts.length} file(s)${isError ? ` · ${short(err, 90)}` : ''}`)
    return { ...cell, modelLabel: m.label, secs, turns: r?.num_turns ?? 0, cost, isError, exitCode: rc,
             artifacts, metrics, diff: diff.split('---8<---')[1] ?? '', err,
             ...(llAudit ? { llmlightAudit: llAudit } : {}),
             sandboxId: sbx.sandboxId, usage: r?.usage ?? {},
             reportedCost: r?.total_cost_usd ?? 0, durationMs: r?.duration_ms ?? secs * 1000,
             pricing: { inPerM: m.inM, outPerM: m.outM }, bedrock: m.bedrock }
  } finally { ACTIVE.delete(sbx); await sbx.kill().catch(() => {}) }
}

const RUBRIC = ['meets_the_request', 'correctness', 'completeness', 'code_quality', 'tests', 'contains_no_new_risk']

/**
 * A blind rubric over the arms that actually produced something, in the shape
 * report.mjs already renders: six criteria scored 1-10, so a total is out of 60
 * exactly as the CLI's document judge produces.
 *
 * Arms are presented in randomised order with their identities withheld, which
 * is the only reason the score is worth reading at all.
 */
function judgeArtifacts(session, cells) {
  const good = cells.filter((c) => !c.isError && c.artifacts.length)
  if (good.length < 1) return null
  const order = good.map((_, i) => i).sort(() => Math.random() - 0.5)
  const shown = order.map((i) => good[i])
  const list = shown.map((c, i) => `=== SUBMISSION ${i} ===\n${(c.diff || '(no diff)').slice(0, 3500)}`).join('\n\n')
  const prompt = `${shown.length} submission(s) answer the same request: "${short(session.intent, 200)}".

${list}

Score each submission 1-10 on every criterion: ${RUBRIC.join(', ')}. Judge only what is in the diff. Reply ONLY JSON, no prose and no code fence:
{"scores":[${shown.map((_, i) => `{"submission":${i},${RUBRIC.map((k) => `"${k}":<1-10>`).join(',')}}`).join(',')}],"why":"<one sentence naming the deciding difference>"}`
  try {
    // two submissions × six criteria with reasons ran past 900 tokens and the verdict JSON was cut off
    const j = askJson('eu.anthropic.claude-sonnet-4-6', prompt, 4000)
    const scores = {}, totals = {}
    for (const row of j.scores ?? []) {
      const c = shown[row.submission]; if (!c) continue
      const per = {}; let tot = 0
      for (const k of RUBRIC) { const v = Math.max(1, Math.min(10, Number(row[k]) || 1)); per[k] = v; tot += v }
      scores[c.armId] = per; totals[c.armId] = tot
    }
    if (!Object.keys(totals).length) throw new Error('judge returned no usable scores')
    const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1])
    const bestArmId = ranked[0][0]
    const margin = ranked.length > 1 ? `${ranked[0][1] - ranked[1][1]} points` : 'unopposed'
    return {
      rubric: RUBRIC, scores, totals, why: short(j.why, 240),
      winner: good.find((c) => c.armId === bestArmId)?.label ?? bestArmId,
      winnerArm: bestArmId, margin, presentedFirst: shown[0]?.armId ?? null,
      // the hub reads `best` as an index into the arms that produced artifacts
      best: good.findIndex((c) => c.armId === bestArmId),
      configs: good.map((c) => c.label),
    }
  } catch (e) { return { error: short(e.message, 160), configs: good.map((c) => c.label) } }
}

async function main() {
  const argv = process.argv.slice(2)
  const id = argv.find((a) => !a.startsWith('--'))
  const budget = argv.find((a) => a.startsWith('--budget='))?.split('=')[1] ?? '3'
  const max = Number(argv.find((a) => a.startsWith('--max='))?.split('=')[1] ?? 3)
  const expId = argv.find((a) => a.startsWith('--experiment='))?.split('=')[1] ?? null
  // what the person asked for (cost | latency | accuracy): recorded with the run, shown beside its result
  const goal = argv.find((a) => a.startsWith('--goal='))?.split('=')[1] ?? 'cost'
  if (!id) { console.log('usage: node optimize.mjs <sessionId> [--budget=3] [--max=3] [--experiment=<id>]'); process.exit(1) }
  for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) if (!process.env[k] || process.env[k].startsWith('op://')) {
    console.error(`${k} not resolved — start the hub from a shell with AWS creds exported.`); process.exit(1) }

  const file = findTranscript(id); if (!file) { console.error('no transcript ' + id); process.exit(1) }
  const session = processTranscript(file)
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/(\d{8})(\d{6})/, '$1-$2')

  // Experiment mode is one lever against its own control; optimize mode is a
  // model/compaction grid Claude picks. They differ only in how the arms are
  // chosen — everything downstream is shared.
  let plan, RUN
  if (expId) {
    const exp = CATALOG.experiments.find((e) => e.id === expId)
    if (!exp) { console.error(`no experiment "${expId}" in config/optimizations.json`); process.exit(1) }
    if (exp.runnable === false) { console.error(`experiment "${expId}" is not runnable here: it needs ${exp.requires ?? 'a gateway in the request path'}`); process.exit(1) }
    const base = CATALOG.experiments.find((e) => e.control)
    plan = { rationale: `${exp.title} — ${exp.summary}`, experiment: expId, hypothesis: exp.hypothesis, gate: exp.gate, risk: exp.risk,
             grid: nameArms([resolveArm(base, session, baselineModel), resolveArm(exp, session, baselineModel)], [null, exp]) }
    RUN = `exprun-${id.slice(0, 8)}-${expId}-${stamp}`
  } else {
    // A grid with no control has nothing to be a delta against — the report's
    // whole left column. --max counts the control, so this costs no more than
    // the old three-cell grid did.
    plan = analyze(session, Math.max(1, max - 1))
    const base = CATALOG.experiments.find((e) => e.control)
    plan.grid = nameArms([resolveArm(base, session, baselineModel),
                          ...plan.grid.map((c) => ({ ...c, role: 'optimized' }))])
    RUN = `optrun-${id.slice(0, 8)}-${stamp}`
  }
  const OUT = path.join(STATE, 'results', RUN)
  fs.mkdirSync(OUT, { recursive: true })
  const status = { run: RUN, kind: expId ? 'experiment' : 'optimize', experiment: expId, session: id, goal,
                   intent: session.intent, originalCost: session.cost, originalModel: session.model,
                   phase: 'analyzing', startedAt: new Date().toISOString(), pid: process.pid }
  const save = () => fs.writeFileSync(path.join(OUT, 'status.json'), JSON.stringify(status, null, 2))
  save()
  const onStop = async () => {
    if (STOPPING) return; STOPPING = true
    console.log('\n  stop requested — tearing down sandboxes')
    status.phase = 'stopped'; status.stoppedAt = new Date().toISOString(); save()
    for (const sbx of ACTIVE) await sbx.kill().catch(() => {})
    process.exit(0)
  }
  process.on('SIGTERM', onStop); process.on('SIGINT', onStop)

  console.log(`\n${expId ? 'experiment ' + expId : 'optimize'} ${id.slice(0, 8)} · "${short(session.intent, 70)}"`)
  console.log(`  plan: ${plan.rationale}`)
  console.log(`  grid: ${plan.grid.map((c) => c.label).join(', ')}`)
  status.phase = 'running'; status.plan = plan; save()

  // inputs: the session's cwd files, minus its own outputs and junk
  const inputs = []
  const cwd = session.cwd.replace(/^~/, os.homedir())
  const exclude = new Set(session.artifacts.map((a) => a.name))
  if (fs.existsSync(cwd)) {
    const collect = (d, rel = '') => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (f.name.startsWith('.') || ['__pycache__', 'node_modules', 'tests', '.git'].includes(f.name)) continue
      const abs = path.join(d, f.name), r = rel ? rel + '/' + f.name : f.name
      if (exclude.has(f.name)) continue
      if (f.isDirectory()) collect(abs, r)
      else { const st = fs.statSync(abs); if (st.size < 1024 * 1024) try { inputs.push({ rel: r, data: fs.readFileSync(abs, 'utf8') }) } catch {} } } }
    collect(cwd)
  }
  if (!inputs.length) inputs.push({ rel: 'CONTEXT.md', data: `The original request was:\n\n${session.intent}\n` })
  console.log(`  shipping ${inputs.length} input file(s)\n`)
  const template = process.env.E2B_TEMPLATE || undefined

  const results = []
  for (const cell of plan.grid) {
    try { results.push(await runCell(cell, session, inputs, budget, template)) }
    catch (e) { console.log(`  ${cell.label.padEnd(26)} error · ${short(e.message, 120)}`)
                results.push({ ...cell, isError: true, err: short(e.message, 200), cost: 0, turns: 0, artifacts: [], diff: '' }) }
    status.results = results; save()
  }
  status.phase = 'judging'; status.results = results; save()
  const verdict = judgeArtifacts(session, results)
  status.verdict = verdict

  writeReport(OUT, { id, session, plan, results, verdict, mode: status.kind, run: RUN })
  status.phase = 'done'; status.finishedAt = new Date().toISOString(); status.report = `results/${RUN}/report.html`
  status.totalCost = results.reduce((a, r) => a + (r.cost || 0), 0)
  status.failed = results.filter((r) => r.isError).length
  save()
  console.log(`\n  done · $${status.totalCost.toFixed(4)} · ${status.failed}/${results.length} arm(s) failed · results/${RUN}/report.html\n`)
}
main().catch((e) => { console.error(e?.stack ?? e?.message ?? e); process.exit(1) })
