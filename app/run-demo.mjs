#!/usr/bin/env node
/**
 * Two E2B sandboxes, same task, one variable.
 *   control  - a regular session: stock defaults, nothing added.
 *   <experiment> - the same task plus one optimization strategy from experiments/.
 * Both are graded by a hidden test suite injected only after the agent exits.
 *
 *   node run-demo.mjs --list          what experiments exist
 *   node run-demo.mjs <name> --dry    show both arms, boot nothing
 *   node run-demo.mjs <name>          run it
 */
import { Sandbox } from '../sandbox/e2b/index.mjs'
import { STATE, ENV_FILE } from './lib/state.mjs'
import { buildHtml } from './report.mjs'
import { Live, summarize } from './live.mjs'
import { resolveSecrets, parseEnvFile } from './secrets.mjs'
import { execSync } from 'node:child_process'
import { startTrace, ensureProject, usagePayload, enabled as tracingOn, projectUrl, PROJECT as LS_PROJECT } from './langsmith.mjs'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))

// .env values may be literals or op:// 1Password references, resolved at run time
const SECRETS = resolveSecrets(['ANTHROPIC_API_KEY', 'E2B_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'])
// everything else in .env is plain configuration (E2B_TEMPLATE, BENCH_MODEL, …)
for (const [k, v] of Object.entries(parseEnvFile(ENV_FILE)))
  if (!(k in SECRETS) && !process.env[k] && !v.startsWith('op://')) process.env[k] = v
const WORK = '/home/user/work'
const STAMP = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/(\d{8})(\d{6})/, '$1-$2')


const SANDBOX_MS = Number(process.env.SANDBOX_MS ?? 40 * 60 * 1000)
const AGENT_MS = Number(process.env.AGENT_MS ?? 30 * 60 * 1000)
const BUDGET = process.env.MAX_BUDGET_USD ?? '10'
const MODEL = process.env.BENCH_MODEL ?? 'opus'
const ONLY = process.env.ONLY_ARM || null
const argv = process.argv.slice(2)
const flagVal = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[i + 1] : null
}
const TASK = flagVal('--task') || process.env.TASK || 'sheet'
const CONTROL = flagVal('--baseline') || flagVal('--control') || process.env.CONTROL_SCENARIO || null
const SESSION = flagVal('--session') || process.env.SESSION_ID || null
const EXPERIMENT = flagVal('--scenarios') || flagVal('--scenario')
  || argv.find((a) => !a.startsWith('-') && argv[argv.indexOf(a) - 1] !== '--scenarios' && argv[argv.indexOf(a) - 1] !== '--scenario')
  || process.env.SCENARIO || 'uber-factory'

const APIKEY = process.env.ANTHROPIC_API_KEY
const OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN
const E2B_KEY = process.env.E2B_API_KEY

// An API key is injected straight into both sandboxes — no interactive login.
const AUTH = APIKEY
  ? { mode: 'API key (ANTHROPIC_API_KEY)', envs: { ANTHROPIC_API_KEY: APIKEY, CLAUDE_CODE_OAUTH_TOKEN: '' } }
  : OAUTH
  ? { mode: 'subscription (CLAUDE_CODE_OAUTH_TOKEN)', envs: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH, ANTHROPIC_API_KEY: '' } }
  : null

const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const TASKDIR = path.join(ROOT, 'tasks', TASK)
if (!fs.existsSync(TASKDIR)) {
  console.error(`no task "${TASK}". available: ${fs.readdirSync(path.join(ROOT, 'tasks')).join(', ')}`)
  process.exit(1)
}
const TASKCFG = JSON.parse(fs.readFileSync(path.join(TASKDIR, 'task.json'), 'utf8'))
// human-readable, so parallel runs are distinguishable at a glance
const RUN_ID = `${TASK}-${EXPERIMENT}-${STAMP}`
const OUT = path.join(STATE, 'results', RUN_ID)

// ---------------------------------------------------------------- experiments
const ASSETS = path.join(ROOT, 'assets')
const EXPDIR = path.join(ROOT, 'scenarios')

/** `---\nkey: value\n---\nbody` — every key optional, body is the strategy prompt. */
function parseFrontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src)
  if (!m) return { meta: {}, body: src.trim() }
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (kv) meta[kv[1]] = kv[2].trim()
  }
  return { meta, body: src.slice(m[0].length).trim() }
}

function listExperiments() {
  if (!fs.existsSync(EXPDIR)) return []
  return fs.readdirSync(EXPDIR)
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .map((f) => f.replace(/\.md$/, '')).sort()
}

function loadExperiment(name) {
  const file = path.join(EXPDIR, `${name}.md`)
  if (!fs.existsSync(file)) {
    throw new Error(`no scenario "${name}"\n  available: ${listExperiments().join(', ') || '(none)'}`)
  }
  const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'))
  const files = (meta.files || '').split(/\s+/).filter(Boolean)
  if (meta.agents && !files.includes(meta.agents)) files.push(meta.agents)
  for (const f of files) {
    if (!fs.existsSync(path.join(ASSETS, f))) throw new Error(`scenario "${name}" wants assets/${f}, which does not exist`)
  }
  return {
    id: name,
    description: meta.description || '',
    rawFlags: (meta.flags || '').trim(),
    flags: (meta.flags || '').split(/\s+/).filter(Boolean),
    files, agents: meta.agents || null,
    setup: meta.setup || null,
    service: meta.service || null,
    passEnv: (meta.passenv || meta.passEnv || '').split(/\s+/).filter(Boolean),
    needsAws: /^(1|true|yes)$/i.test(meta.aws || ''),
    // when the arm is served by another provider, Claude Code's own --max-budget-usd
    // prices it as Anthropic and is meaningless. These let us cap it ourselves.
    model: meta.model || null,
    priceIn: Number(meta.pricein ?? meta.priceIn ?? 0),    // USD per 1M input tokens
    priceOut: Number(meta.priceout ?? meta.priceOut ?? 0), // USD per 1M output tokens
    budget: Number(meta.budget ?? 0),                      // USD, hard stop
    ready: meta.ready || null,
    teardown: meta.teardown || null,
    env: Object.fromEntries((meta.env || '').split(/\s+/).filter(Boolean)
      .map((kv) => { const i = kv.indexOf('='); return i > 0 ? [kv.slice(0, i), kv.slice(i + 1)] : null })
      .filter(Boolean)),
    strategy: body,
  }
}

/** Flags a task applies to BOTH arms, so a task-level constraint cannot skew one. */
function taskFlags() {
  return String(TASKCFG.flags ?? '').split(/\s+/).filter(Boolean)
}

/** A task may supply its own prompt; otherwise the shared one. */
function basePrompt() {
  const own = path.join(TASKDIR, 'PROMPT.md')
  const src = fs.existsSync(own) ? fs.readFileSync(own, 'utf8') : rd('lib/BASE_PROMPT.md')
  return src.replace(/\{\{FILE\}\}/g, TASKCFG.file)
}

/** Files a task attaches to the workspace — identical for both arms. */
function taskInputs() {
  const dir = path.join(TASKDIR, 'inputs')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => !f.startsWith('.'))
    .map((f) => ({ path: `${WORK}/${f}`, data: fs.readFileSync(path.join(dir, f), 'utf8') }))
}

/** The control never varies. Whatever the experiment does not set stays at these values. */
function controlArm() {
  const base = basePrompt()
  return {
    id: 'baseline',
    label: `baseline · default Claude Code (${MODEL})`,
    files: () => [
      { path: `${WORK}/SPEC.md`, data: fs.readFileSync(path.join(TASKDIR, 'SPEC.md'), 'utf8') },
      { path: `${WORK}/PROMPT.md`, data: base },
      ...taskInputs(),
    ],
    flags: [`--model ${MODEL}`, ...taskFlags()],
    model: MODEL,
    levers: [
      `model: ${MODEL} — Anthropic, default settings`,
      'stock defaults — no flags beyond --model',
      'default effort, default compaction',
      'task prompt only, no strategy appended',
      'empty workspace: SPEC.md + PROMPT.md',
      'nothing gates completion — the agent decides it is done',
    ],
  }
}

function experimentArm(exp, idOverride = null) {
  const base = basePrompt()
  const prompt = exp.strategy
    ? `${base}\n\n---\n\n# Optimization strategy — ${exp.id}\n\n${exp.strategy}\n`
    : base
  const flags = [`--model ${MODEL}`, ...taskFlags(), ...exp.flags]
  if (exp.agents) flags.push(`--agents "$(cat ${exp.agents})"`)
  const words = exp.strategy ? exp.strategy.split(/\s+/).filter(Boolean).length : 0
  const id = idOverride ?? exp.id
  const shownModel = exp.model || MODEL
  return {
    id,
    model: shownModel,
    label: id === 'baseline' ? `baseline · ${exp.id} (${shownModel})` : `optimized · ${exp.id} (${shownModel})`,
    description: exp.description,
    files: () => [
      { path: `${WORK}/SPEC.md`, data: fs.readFileSync(path.join(TASKDIR, 'SPEC.md'), 'utf8') },
      { path: `${WORK}/PROMPT.md`, data: prompt },
      ...taskInputs(),
      ...exp.files.map((f) => ({ path: `${WORK}/${f}`, data: fs.readFileSync(path.join(ASSETS, f), 'utf8') })),
    ],
    // a copied file with no dot in its basename is a script
    post: exp.files.filter((f) => !path.basename(f).includes('.')).map((f) => `chmod +x ${WORK}/${f}`),
    setup: exp.setup, service: exp.service, ready: exp.ready, teardown: exp.teardown,
    priceIn: exp.priceIn, priceOut: exp.priceOut, budget: exp.budget,
    model: shownModel,
    env: { ...exp.env, ...hostEnv(exp) },
    flags,
    levers: [
      exp.description || `experiment: ${exp.id}`,
      exp.rawFlags ? `flags: ${exp.rawFlags}` : 'flags: none beyond --model',
      exp.files.length ? `workspace: ${exp.files.join(', ')}` : 'workspace: SPEC.md + PROMPT.md only',
      words ? `strategy prompt: ${words} words appended to the task` : 'no strategy prompt',
      exp.agents ? `subagents from ${exp.agents}` : 'no subagents',
      ...(exp.setup ? [`sandbox setup: ${exp.setup.slice(0, 70)}`] : []),
      ...(exp.service ? [`background service: ${exp.service.slice(0, 60)}`] : []),
      ...(exp.budget ? [`harness spend cap: $${exp.budget} at $${exp.priceIn}/$${exp.priceOut} per M tok`] : []),
      ...(Object.keys(exp.env).length ? [`env: ${Object.entries(exp.env).map(([k, v]) => `${k}=${v}`).join(' ')}`] : []),
    ],
  }
}


// ---------------------------------------------------------------- utils
let LIVE = null
const C = { a: '\x1b[36m', b: '\x1b[35m', dim: '\x1b[2m', r: '\x1b[0m', g: '\x1b[32m', y: '\x1b[33m', rd: '\x1b[31m' }
const tag = (id) => `${id === 'baseline' ? C.a : C.b}[${id.slice(0, 14).padEnd(14)}]${C.r}`
const log = (id, msg) => LIVE ? LIVE.status(id, String(msg).replace(/\x1b\[[0-9;]*m/g, '')) : console.log(`${tag(id)} ${msg}`)
const nowSec = () => Date.now() / 1000

async function sh(sbx, id, cmd, { timeoutMs = 300000, quiet = true, envs, stream } = {}) {
  const t0 = nowSec()
  const res = await sbx.commands.run(cmd, {
    timeoutMs, envs,
    onStdout: stream ? (d) => stream(d) : quiet ? undefined : (d) => process.stdout.write(`${tag(id)} ${C.dim}${d}${C.r}`),
    onStderr: stream ? undefined : quiet ? undefined : (d) => process.stdout.write(`${tag(id)} ${C.dim}${d}${C.r}`),
  }).catch((e) => ({ exitCode: -1, stdout: '', stderr: String(e?.message ?? e), _threw: true }))
  return { ...res, wallSec: +(nowSec() - t0).toFixed(1) }
}

function claudeCommand(arm) {
  const flags = [
    '-p',
    '--output-format stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--no-session-persistence',
    `--max-budget-usd ${BUDGET}`,
    ...arm.flags,
  ].join(' ')
  return `cd ${WORK} && cat PROMPT.md | claude ${flags} 2> /home/user/claude.err | tee /home/user/stream.jsonl; echo "CLAUDE_EXIT=\${PIPESTATUS[1]}"`
}

/** Credentials the scenario asks to forward from this machine into the sandbox. */
function hostEnv(exp) {
  const out = {}
  for (const k of exp.passEnv ?? []) if (process.env[k]) out[k] = process.env[k]
  if (exp.needsAws) {
    // A scoped key configured for this project beats the machine's default
    // profile, which on this machine is the account root.
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      out.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID
      out.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY
      out.AWS_REGION = process.env.AWS_REGION || 'us-east-1'
      out.AWS_DEFAULT_REGION = out.AWS_REGION
      return out
    }
    const cfg = (k) => { try { return execSync(`aws configure get ${k}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' } }
    try {
      // AWS CLI v2 can export directly; v1 cannot, so fall back to the profile.
      const raw = execSync('aws configure export-credentials --format env-no-export',
                           { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      for (const line of raw.split('\n')) {
        const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
        if (m) out[m[1]] = m[2]
      }
    } catch {
      out.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || cfg('aws_access_key_id')
      out.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || cfg('aws_secret_access_key')
      const tok = process.env.AWS_SESSION_TOKEN || cfg('aws_session_token')
      if (tok) out.AWS_SESSION_TOKEN = tok
    }
    if (!out.AWS_ACCESS_KEY_ID || !out.AWS_SECRET_ACCESS_KEY)
      throw new Error('this scenario needs AWS credentials; none were found via the AWS CLI or the environment')
    out.AWS_REGION = out.AWS_REGION || process.env.AWS_REGION || cfg('region') || 'us-east-1'
    out.AWS_DEFAULT_REGION = out.AWS_REGION
  }
  return out
}

/** Objective, judge-free measurements of a markdown deliverable. */
function documentMetrics(md) {
  const lines = md.split('\n')
  const words = md.split(/\s+/).filter(Boolean).length
  const headings = lines.filter((l) => /^#{1,6}\s/.test(l)).length
  const h2 = lines.filter((l) => /^##\s/.test(l)).length
  const bullets = lines.filter((l) => /^\s*[-*+]\s/.test(l)).length
  const tableRows = lines.filter((l) => /^\s*\|.*\|\s*$/.test(l)).length
  const codeBlocks = (md.match(/```/g) ?? []).length / 2
  const numbers = (md.match(/\b\d+(\.\d+)?\s*(%|x|×|k|K|M|ms|s\b|tokens?|USD|\$)/g) ?? []).length
  const dollars = (md.match(/\$[\d,]+(\.\d+)?/g) ?? []).length
  // does it actually separate safe levers from quality-trading ones?
  const risk = /accuracy risk|quality risk|no accuracy|lossless|risk[- ]free|degrad/i.test(md)
  return { words, chars: md.length, headings, h2, bullets, tableRows,
           codeBlocks: Math.floor(codeBlocks), quantifiedClaims: numbers + dollars,
           addressesAccuracyRisk: risk }
}

// ---------------------------------------------------------------- one arm
async function runArm(arm, trace = null) {
  const started = new Date().toISOString()
  const t0 = nowSec()
  const rec = { arm: arm.id, label: arm.label, model: arm.model ?? MODEL, levers: arm.levers, started, steps: {} }

  // One span per arm, one per step inside it. Tracing never blocks the arm:
  // a span that cannot be written is a span that silently is not there.
  const span = trace?.child({
    name: `arm ${arm.id}`,
    inputs: { arm: arm.id, label: arm.label, levers: arm.levers },
    metadata: { runId: RUN_ID, task: TASK, scenario: EXPERIMENT, model: MODEL, budgetUsd: BUDGET },
    tags: ['arm', arm.id, `task:${TASK}`, `scenario:${EXPERIMENT}`],
  })
  const step = (name, opts = {}) => span?.child({ name, runType: 'tool', ...opts })

  const beat = (step, extra = {}) => {
    try {
      const f = path.join(OUT, 'status.json')
      let cur = {}
      try { cur = JSON.parse(fs.readFileSync(f, 'utf8')) } catch {}
      cur.runId = RUN_ID; cur.model = MODEL; cur.experiment = EXPERIMENT; cur.task = TASK; cur.taskTitle = TASKCFG.title; cur.session = SESSION
      cur.pid = process.pid
      cur.arms = cur.arms || {}
      cur.arms[arm.id] = { ...(cur.arms[arm.id] || {}), arm: arm.id, step, at: new Date().toISOString(),
                           sandboxId: rec.sandboxId ?? null, startedAt: started, ...extra }
      cur.updatedAt = new Date().toISOString()
      fs.writeFileSync(f, JSON.stringify(cur, null, 2))
    } catch {}
  }
  rec.beat = beat
  beat('creating-sandbox')

  log(arm.id, 'creating sandbox…')
  const TEMPLATE = process.env.E2B_TEMPLATE || null
  const sbx = await Sandbox.create(...(TEMPLATE ? [TEMPLATE, {
    timeoutMs: SANDBOX_MS,
    metadata: { harnessDemo: '1', runId: RUN_ID, arm: arm.id, experiment: EXPERIMENT },
  }] : [{
    timeoutMs: SANDBOX_MS,
    metadata: { harnessDemo: '1', runId: RUN_ID, arm: arm.id, experiment: EXPERIMENT },
  }]))
  rec.sandboxId = sbx.sandboxId
  log(arm.id, `sandbox ${C.g}${sbx.sandboxId}${C.r}`)
  span?.child({ name: 'sandbox created', runType: 'tool', inputs: { template: TEMPLATE ?? 'default' },
                metadata: { sandboxId: sbx.sandboxId, timeoutMs: SANDBOX_MS } })
      .end({ outputs: { sandboxId: sbx.sandboxId } })

  try {
    const probe = await sh(sbx, arm.id, 'node -v; npm -v; python3 -V; whoami; nproc')
    rec.steps.probe = probe.stdout.trim()
    log(arm.id, `env: ${probe.stdout.trim().split('\n').join(' | ')}`)

    beat('installing-claude')
    log(arm.id, 'installing @anthropic-ai/claude-code…')
    const inst = await sh(sbx, arm.id,
      'command -v claude >/dev/null && claude --version || (npm install -g @anthropic-ai/claude-code 2>&1 | tail -3 && claude --version)',
      { timeoutMs: 900000 })
    rec.steps.install = { exitCode: inst.exitCode, wallSec: inst.wallSec, out: inst.stdout.trim() }
    step('install claude-code', { inputs: {} })
      ?.end({ outputs: { version: inst.stdout.trim().split('\n').pop(), wallSec: inst.wallSec },
              error: inst.exitCode === 0 ? null : `exit ${inst.exitCode}` })
    if (inst.exitCode !== 0) throw new Error(`claude install failed:\n${inst.stdout}\n${inst.stderr}`)
    log(arm.id, `claude installed in ${inst.wallSec}s → ${inst.stdout.trim().split('\n').pop()}`)

    await sbx.commands.run(`mkdir -p ${WORK}/tests ${WORK}/.claude/skills/verify`)
    await sbx.files.write(arm.files())
    for (const cmd of arm.post ?? []) await sbx.commands.run(cmd)
    const ls = await sh(sbx, arm.id, `ls -a ${WORK}`)
    log(arm.id, `workspace: ${ls.stdout.trim().split('\n').filter(x => x !== '.' && x !== '..').join(' ')}`)

    // ---- the agent run
    beat('running-agent')
    if (arm.setup) {
      beat('scenario-setup')
      log(arm.id, 'scenario setup…')
      LIVE?.push(arm.id, `$ ${arm.setup.slice(0, 90)}`, { dim: true })
      const su = await sh(sbx, arm.id, `cd ${WORK} && ${arm.setup}`, { timeoutMs: 600000, envs: { ...AUTH.envs, ...(arm.env ?? {}) } })
      rec.steps.setup = { exitCode: su.exitCode, wallSec: su.wallSec, out: (su.stdout + su.stderr).slice(-1500) }
      step('scenario setup', { inputs: { script: arm.setup } })
        ?.end({ outputs: { wallSec: su.wallSec, tail: (su.stdout + su.stderr).slice(-600) },
                error: su.exitCode === 0 ? null : `exit ${su.exitCode}` })
      LIVE?.push(arm.id, su.exitCode === 0 ? 'setup ok' : `setup FAILED (${su.exitCode})`, { dim: true })
      for (const l of (su.stdout + su.stderr).trim().split('\n').slice(-4)) LIVE?.push(arm.id, l.slice(0, 100), { dim: true })
      if (su.exitCode !== 0) throw new Error(`scenario setup failed:\n${(su.stdout + su.stderr).slice(-600)}`)
    }

    if (arm.service) {
      // A real background process: commands.run(background) survives the call that starts it,
      // unlike `nohup … &` inside a foreground command, which E2B reaps.
      beat('starting-service')
      LIVE?.push(arm.id, `service: ${arm.service.slice(0, 80)}`, { dim: true })
      rec.serviceHandle = await sbx.commands.run(arm.service, { background: true, envs: { ...AUTH.envs, ...(arm.env ?? {}) }, timeoutMs: 0 })
        .catch((e) => { LIVE?.push(arm.id, `service failed to start: ${e?.message ?? e}`); return null })
    }
    if (arm.ready) {
      beat('waiting-ready')
      const rc = await sh(sbx, arm.id, arm.ready, { timeoutMs: 420000, envs: { ...AUTH.envs, ...(arm.env ?? {}) } })
      rec.steps.ready = { exitCode: rc.exitCode, out: (rc.stdout + rc.stderr).slice(-800) }
      LIVE?.push(arm.id, rc.exitCode === 0 ? 'service ready' : `service NOT ready (${rc.exitCode})`, { dim: true })
      if (rc.exitCode !== 0) {
        const log = await sh(sbx, arm.id, 'tail -30 /home/user/*.log 2>/dev/null; ps -eo pid,comm --sort=-pcpu | head -6', { timeoutMs: 30000 })
        throw new Error(`scenario service never became ready:\n${(rc.stdout + rc.stderr).slice(-500)}\n--- sandbox ---\n${log.stdout.slice(-700)}`)
      }
    }

    log(arm.id, `running agent · budget $${BUDGET} · cap ${Math.round(AGENT_MS / 60000)}m`)
    const promptText = arm.files().find((f) => f.path.endsWith('PROMPT.md'))?.data ?? ''
    const agentSpan = span?.child({
      name: 'agent', runType: 'llm',
      inputs: { prompt: promptText, flags: arm.flags, command: claudeCommand(arm) },
      metadata: { model: MODEL, ls_model_name: MODEL, ls_provider: 'anthropic',
                  sandboxId: sbx.sandboxId, budgetUsd: BUDGET, capMinutes: Math.round(AGENT_MS / 60000) },
      tags: ['agent', arm.id],
    })
    const envs = { ...AUTH.envs, ...(arm.env ?? {}), CI: '1', IS_SANDBOX: '1' }
    const t1 = nowSec()
    let tail = ''            // partial JSONL line across chunks
    let turns = 0
    let finalEvent = null
    const live = { turns: 0, out: 0, cacheRead: 0, cacheWrite: 0, input: 0, lastTool: null }
    const onLine = (line) => {
      if (!line.trim()) return
      let ev
      try { ev = JSON.parse(line) } catch { LIVE?.push(arm.id, line.slice(0, 120), { dim: true }); return }
      if (ev.type === 'assistant') {
        turns++
        const u = ev.message?.usage
        if (u) {                       // per-message usage: live totals without waiting for the result event
          live.out += u.output_tokens ?? 0
          live.input += u.input_tokens ?? 0
          live.cacheRead += u.cache_read_input_tokens ?? 0
          live.cacheWrite += u.cache_creation_input_tokens ?? 0
        }
        const tool = (ev.message?.content ?? []).find((b) => b.type === 'tool_use')
        if (tool) live.lastTool = tool.name
      }
      live.turns = turns
      // Real-time spend cap. Claude Code cannot price a third-party provider, so
      // when the scenario declares pricing we meter it here and stop the arm.
      if (arm.budget > 0 && (arm.priceIn > 0 || arm.priceOut > 0)) {
        live.spend = ((live.input + live.cacheRead + live.cacheWrite) * arm.priceIn
                      + live.out * arm.priceOut) / 1e6
        if (live.spend > arm.budget && !rec.budgetStopped) {
          rec.budgetStopped = true
          LIVE?.push(arm.id, `BUDGET CAP $${arm.budget} REACHED ($${live.spend.toFixed(4)}) — stopping`, {})
          log(arm.id, `budget cap $${arm.budget} reached — killing agent`)
          sbx.commands.run('pkill -f "claude -p" || true', { timeoutMs: 15000 }).catch(() => {})
        }
      }
      if (ev.type === 'result') finalEvent = ev
      for (const item of summarize(ev) ?? []) LIVE?.push(arm.id, item.t, { dim: item.dim })
      if (ev.type !== 'result') {
        const el = Math.round(nowSec() - t1)
        LIVE?.status(arm.id, `working · ${turns} turns · ${Math.floor(el / 60)}m${String(el % 60).padStart(2, '0')}s`)
      }
      beat('running-agent', { turns, live, agentStartedAt: new Date(t1 * 1000).toISOString() })
    }
    const run = await sh(sbx, arm.id, claudeCommand(arm), {
      timeoutMs: AGENT_MS, envs, quiet: true,
      stream: (chunk) => {
        tail += chunk
        const parts = tail.split('\n')
        tail = parts.pop() ?? ''
        for (const l of parts) onLine(l)
      },
    })
    if (tail.trim()) onLine(tail)
    rec.steps.agent = { exitCode: run.exitCode, wallSec: run.wallSec, turns, tail: run.stdout.trim().slice(-400) }
    rec.agentSpan = agentSpan            // closed once the result event is in hand
    rec.meteredSpend = live.spend ?? null
    // Claude Code prices every response as Anthropic. When the arm is served by
    // another provider, that number is fiction — recompute from declared rates.
    if (arm.priceIn > 0 || arm.priceOut > 0) {
      rec.pricing = { inPerM: arm.priceIn, outPerM: arm.priceOut, source: 'scenario' }
      const u = finalEvent?.usage ?? {}
      const inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      rec.trueCost = (inTok * arm.priceIn + (u.output_tokens ?? 0) * arm.priceOut) / 1e6
    }
    rec.budgetStopped = rec.budgetStopped ?? false
    if (rec.budgetStopped) rec.fatalNote = `stopped by the harness budget cap of $${arm.budget}`
    log(arm.id, `agent finished in ${Math.round(run.wallSec)}s`)

    const errRaw = await sbx.files.read('/home/user/claude.err').catch(() => '')
    rec.claudeStderrTail = errRaw.trim().slice(-1500)
    if (!finalEvent) {
      // fall back to the tee'd stream if the callback missed the tail
      const jl = await sbx.files.read('/home/user/stream.jsonl').catch(() => '')
      for (const l of jl.split('\n').reverse()) {
        try { const ev = JSON.parse(l); if (ev.type === 'result') { finalEvent = ev; break } } catch {}
      }
    }
    rec.result = finalEvent
    await agentSpan?.end({
      outputs: {
        result: finalEvent?.result ?? null,
        num_turns: finalEvent?.num_turns ?? turns,
        total_cost_usd: finalEvent?.total_cost_usd ?? null,
        usage_metadata: usagePayload(finalEvent?.usage ?? {}, finalEvent?.modelUsage
          ? Object.keys(finalEvent.modelUsage)[0] : MODEL),
      },
      error: finalEvent && !finalEvent.is_error ? null
           : (finalEvent?.result ?? `agent exited ${run.exitCode} with no result event`),
    })
    if (!rec.result) {
      LIVE?.push(arm.id, `no result event${errRaw ? ' — ' + errRaw.trim().split('\n').pop()?.slice(0, 90) : ''}`)
      log(arm.id, 'agent produced no result')
    }

    if (arm.teardown) {
      const td = await sh(sbx, arm.id, `cd ${WORK} && ${arm.teardown}`, { timeoutMs: 120000, envs: { ...AUTH.envs, ...(arm.env ?? {}) } })
      rec.steps.teardown = (td.stdout + td.stderr).slice(-4000)
      LIVE?.push(arm.id, 'teardown captured', { dim: true })
    }

    // ---- grade
    beat('grading')
    if (TASKCFG.kind === 'document') {
      const doc = await sbx.files.read(`${WORK}/${TASKCFG.file}`).catch(() => '')
      rec.document = doc
      rec.grade = doc
        ? { kind: 'document', total: 0, passed: 0, import_ok: true, failures: [],
            metrics: documentMetrics(doc) }
        : { kind: 'document', total: 0, passed: 0, import_ok: false, failures: [],
            note: `${TASKCFG.file} was never written` }
      log(arm.id, doc ? `document: ${rec.grade.metrics.words} words, ${rec.grade.metrics.headings} headings`
                      : `${TASKCFG.file} missing`)
    } else {
    log(arm.id, 'grading with hidden suite…')
    await sbx.files.write([
      { path: '/home/user/grade/test_hidden.py', data: fs.readFileSync(path.join(TASKDIR, 'test_hidden.py'), 'utf8') },
      { path: '/home/user/grade/grade.py', data: rd('lib/grade.py') },
    ])
    const g = await sh(sbx, arm.id, `cd /home/user/grade && GRADE_DIR=${WORK} GRADE_MODULE=${TASKCFG.module} python3 grade.py`, { timeoutMs: 120000 })
    try { rec.grade = JSON.parse(g.stdout.trim().split('\n').pop()) } catch { rec.grade = { error: g.stdout + g.stderr } }
    }
    const gr = rec.grade
    step('grade', { inputs: { suite: TASKCFG.kind === 'document' ? 'document metrics' : 'hidden pytest suite' } })
      ?.end({ outputs: { passed: gr.passed ?? null, total: gr.total ?? null,
                         import_ok: gr.import_ok ?? null, metrics: gr.metrics ?? null },
              error: gr.error ?? gr.note ?? null })
    if (gr.kind !== 'document')
      log(arm.id, gr.total ? `hidden suite: ${gr.passed}/${gr.total} passed` : `grading failed: ${(gr.note || gr.error || '').slice(0, 200)}`)

    // ---- artifacts
    const dir = path.join(OUT, arm.id)
    fs.mkdirSync(dir, { recursive: true })
    for (const f of [TASKCFG.file, 'PLAN.md', 'STRATEGY.md']) {
      const c = await sbx.files.read(`${WORK}/${f}`).catch(() => null)
      if (c !== null) fs.writeFileSync(path.join(dir, f), c)
    }
    const tests = await sh(sbx, arm.id, `cd ${WORK} && for f in tests/*.py; do echo "===== $f"; cat "$f"; done 2>/dev/null`)
    if (tests.stdout.trim()) fs.writeFileSync(path.join(dir, 'agent-tests.txt'), tests.stdout)
    const wc = await sh(sbx, arm.id, `cd ${WORK} && wc -l ${TASKCFG.file} tests/*.py 2>/dev/null | tail -1`)
    rec.linesOfCode = wc.stdout.trim()
    if (rec.steps.teardown) fs.writeFileSync(path.join(dir, 'teardown.txt'), rec.steps.teardown)
    if (rec.steps.setup) fs.writeFileSync(path.join(dir, 'setup.txt'), rec.steps.setup.out ?? '')
    if (rec.result) fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(rec.result, null, 2))
    if (errRaw) fs.writeFileSync(path.join(dir, 'claude.err'), errRaw)
    const jl = await sbx.files.read('/home/user/stream.jsonl').catch(() => '')
    if (jl) fs.writeFileSync(path.join(dir, 'stream.jsonl'), jl)

    rec.totalWallSec = +(nowSec() - t0).toFixed(1)
    beat('done', { passed: rec.grade?.passed ?? null, total: rec.grade?.total ?? null,
                   cost: rec.result?.total_cost_usd ?? null, finished: true })
    await span?.end({
      outputs: { passed: rec.grade?.passed ?? null, total: rec.grade?.total ?? null,
                 cost_usd: rec.result?.total_cost_usd ?? null, turns: rec.result?.num_turns ?? null,
                 wallSec: rec.totalWallSec, linesOfCode: rec.linesOfCode ?? null,
                 usage_metadata: usagePayload(rec.result?.usage ?? {}, MODEL) },
      error: rec.fatalNote ?? null,
    })
    delete rec.beat
    delete rec.agentSpan
    return rec
  } catch (e) {
    rec.fatal = String(e?.stack ?? e)
    beat('failed', { finished: true, error: String(e?.message ?? e).slice(0, 300) })
    await rec.agentSpan?.end({ error: String(e?.message ?? e).slice(0, 400) })
    await span?.end({ outputs: { wallSec: +(nowSec() - t0).toFixed(1) }, error: String(e?.message ?? e).slice(0, 600) })
    delete rec.beat
    delete rec.agentSpan
    log(arm.id, `${C.rd}FATAL: ${e?.message ?? e}${C.r}`)
    rec.totalWallSec = +(nowSec() - t0).toFixed(1)
    return rec
  } finally {
    await sbx.kill().catch(() => {})
    log(arm.id, 'sandbox killed')
  }
}

// ---------------------------------------------------------------- report
const n = (v, d = 0) => (v ?? 0).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })

function metrics(rec) {
  const r = rec.result ?? {}
  const u = r.usage ?? {}
  const inp = u.input_tokens ?? 0
  const cw = u.cache_creation_input_tokens ?? 0
  const cr = u.cache_read_input_tokens ?? 0
  const out = u.output_tokens ?? 0
  const g = rec.grade ?? {}
  const cost = rec.trueCost ?? r.total_cost_usd ?? 0
  return {
    cost, turns: r.num_turns ?? 0,
    apiSec: r.duration_ms ? r.duration_ms / 1000 : (rec.steps?.agent?.wallSec ?? 0),
    inp, cw, cr, out,
    billedIn: inp + cw + cr,
    cacheHit: (inp + cw + cr) ? cr / (inp + cw + cr) : 0,
    passed: g.passed ?? 0, total: g.total ?? 0,
    pass: g.total ? g.passed / g.total : 0,
    costPerPass: g.passed ? cost / g.passed : null,
  }
}

function report(recs) {
  const rows = recs.map((r) => ({ r, m: metrics(r) }))
  const L = [
    '', '='.repeat(78),
    '  SAME TASK, TWO HARNESSES — E2B sandboxes, hidden-suite graded',
    '='.repeat(78), '',
  ]
  const F = [
    ['hidden suite passed', ({ m }) => `${m.passed}/${m.total}  (${n(m.pass * 100, 1)}%)`],
    ['cost (USD)', ({ m }) => `$${n(m.cost, 4)}`],
    ['cost per passing test', ({ m }) => (m.costPerPass == null ? '—' : `$${n(m.costPerPass, 4)}`)],
    ['assistant turns', ({ m }) => n(m.turns)],
    ['output tokens', ({ m }) => n(m.out)],
    ['input tokens (fresh)', ({ m }) => n(m.inp)],
    ['cache writes', ({ m }) => n(m.cw)],
    ['cache reads', ({ m }) => n(m.cr)],
    ['prompt-cache hit rate', ({ m }) => `${n(m.cacheHit * 100, 1)}%`],
    ['agent wall time', ({ m }) => `${n(m.apiSec, 0)}s`],
    ['sandbox wall time', ({ r }) => `${n(r.totalWallSec, 0)}s`],
    ['delivered lines', ({ r }) => (r.linesOfCode || '—').replace(/\s*total$/, '')],
  ]
  const w0 = 24, w = 26
  L.push(' '.repeat(w0) + rows.map(({ r }) => (r.arm === 'baseline' ? C.a : C.b) + r.arm.slice(0, w - 2).padEnd(w) + C.r).join(''))
  L.push('-'.repeat(w0 + w * rows.length))
  for (const [label, fn] of F) L.push(label.padEnd(w0) + rows.map((x) => String(fn(x)).padEnd(w)).join(''))
  L.push('')

  const [A, B] = rows
  if (A && B && A.m.cost && B.m.cost) {
    const d = (x, y) => (y ? ((x - y) / y) * 100 : 0)
    L.push('  optimized vs baseline:')
    L.push(`    cost            ${d(B.m.cost, A.m.cost) >= 0 ? '+' : ''}${n(d(B.m.cost, A.m.cost), 1)}%`)
    L.push(`    output tokens   ${d(B.m.out, A.m.out) >= 0 ? '+' : ''}${n(d(B.m.out, A.m.out), 1)}%`)
    L.push(`    turns           ${d(B.m.turns, A.m.turns) >= 0 ? '+' : ''}${n(d(B.m.turns, A.m.turns), 1)}%`)
    L.push(`    correctness     ${d(B.m.pass, A.m.pass) >= 0 ? '+' : ''}${n(d(B.m.pass, A.m.pass), 1)}%`)
    if (A.m.costPerPass && B.m.costPerPass)
      L.push(`    cost/passing    ${d(B.m.costPerPass, A.m.costPerPass) >= 0 ? '+' : ''}${n(d(B.m.costPerPass, A.m.costPerPass), 1)}%`)
    L.push('')
  }
  for (const { r, m } of rows) {
    if (!m.total) continue
    const f = (r.grade?.failures ?? []).map((x) => x.split('.').slice(-2).join('.'))
    if (f.length) L.push(`  ${r.arm} failed: ${f.slice(0, 12).join(', ')}${f.length > 12 ? ` … +${f.length - 12}` : ''}`)
  }
  L.push('', `  artifacts: results/${RUN_ID}/`, '')
  return L.join('\n')
}

// ---------------------------------------------------------------- main
async function main() {
  if (process.argv.includes('--list')) {
    const names = listExperiments()
    console.log('\nscenarios:\n')
    for (const nm of names) {
      const e = loadExperiment(nm)
      const bits = [e.rawFlags && 'flags', e.files.length && 'files', e.strategy && 'prompt'].filter(Boolean).join('+')
      console.log(`  ${nm.padEnd(18)} ${(bits || 'empty').padEnd(18)} ${e.description}`)
    }
    console.log(`\n  opt demo run --scenarios <name>      (default: ${EXPERIMENT})\n`)
    return
  }
  if (process.argv.includes('--dry')) {
    const exp = loadExperiment(EXPERIMENT)
    const arms = [CONTROL ? experimentArm(loadExperiment(CONTROL), 'baseline') : controlArm(), experimentArm(exp)]
    console.log(`\ndry run · scenario "${exp.id}" · nothing is booted, nothing is billed\n`)
    for (const a of arms) {
      const colour = a.id === 'baseline' ? C.a : C.b
      console.log(`${colour}${'-'.repeat(74)}${C.r}`)
      console.log(`${colour}${a.label}${C.r}\n`)
      const common = ['-p', '--output-format stream-json', '--verbose', '--dangerously-skip-permissions',
                      '--no-session-persistence', `--max-budget-usd ${BUDGET}`]
      console.log(`  claude ${[...common, ...a.flags].join(' ')}\n`)
      const files = a.files()
      console.log('  workspace:')
      for (const f of files) console.log(`    ${f.path.replace(WORK + '/', '').padEnd(34)} ${String(f.data.length).padStart(6)} B`)
      for (const c of a.post ?? []) console.log(`    ${C.dim}${c.replace(WORK + '/', '')}${C.r}`)
      const prompt = files.find((f) => f.path.endsWith('PROMPT.md'))?.data ?? ''
      console.log(`\n  PROMPT.md (${prompt.split(/\s+/).filter(Boolean).length} words):`)
      console.log(prompt.trimEnd().split('\n').map((l) => `    ${C.dim}${l}${C.r}`).join('\n'))
      console.log('')
    }
    const [c, e] = arms
    const cp = c.files().find((f) => f.path.endsWith('PROMPT.md')).data
    const ep = e.files().find((f) => f.path.endsWith('PROMPT.md')).data
    console.log('-'.repeat(74))
    const bits = [
      `+${e.flags.length - c.flags.length} flag(s)`,
      `+${e.files().length - c.files().length} file(s)`,
      cp === ep ? 'no strategy prompt' : `strategy prompt +${ep.length - cp.length} chars`,
      ...(e.setup ? ['sandbox setup'] : []),
      ...(Object.keys(e.env ?? {}).length ? [`env ${Object.keys(e.env).join(',')}`] : []),
    ]
    console.log(`  delta: ${bits.join(', ')}`)
    if (cp === ep && !e.setup && !Object.keys(e.env ?? {}).length && e.flags.length === c.flags.length && e.files().length === c.files().length)
      console.log(`  ${C.y}the two arms are identical — this scenario changes nothing${C.r}`)
    else if (cp === ep)
      console.log(`  ${C.dim}prompts are identical by design; the difference is environmental${C.r}`)
    console.log('')
    return
  }
  if (!E2B_KEY) { console.error('E2B_API_KEY is not set (put it in .env). Get one at https://console.e2b.dev/?tab=keys'); process.exit(1) }

  if (process.argv.includes('--probe')) {
    const s = await Sandbox.create({ timeoutMs: 120000 })
    const p = await s.commands.run('node -v; npm -v; python3 -V; whoami; nproc; free -m | head -2')
    console.log(`sandbox ${s.sandboxId}\n${p.stdout}`)
    await s.kill()
    console.log(`auth: ${AUTH ? AUTH.mode : 'NONE - run `claude setup-token`, put CLAUDE_CODE_OAUTH_TOKEN in .env'}`)
    return
  }

  const armsUseAnthropic = [CONTROL, EXPERIMENT].some((n) => {
    if (!n) return true                       // the stock control always uses Anthropic
    try { return !/ANTHROPIC_BASE_URL/.test(loadExperiment(n).env ? Object.keys(loadExperiment(n).env).join(' ') : '') }
    catch { return true }
  })
  if (!AUTH && armsUseAnthropic) {
    console.error([
      'ANTHROPIC_API_KEY is not set. Put it in .env:',
      '',
      "    read -rs 'k?ANTHROPIC_API_KEY: ' && printf 'ANTHROPIC_API_KEY=%s\\n' \"$k\" >> .env && unset k",
      '',
      '  Get one at https://console.anthropic.com/settings/keys',
    ].join('\n'))
    process.exit(1)
  }

  fs.mkdirSync(OUT, { recursive: true })
  const exp = loadExperiment(EXPERIMENT)
  // Normally the control is a bare stock session. --control <scenario> replaces it,
  // which is how you compare two providers without a stock arm in the middle.
  const controlBase = CONTROL ? experimentArm(loadExperiment(CONTROL), 'baseline') : controlArm()
  let arms = [controlBase, experimentArm(exp)]
  if (CONTROL && CONTROL === EXPERIMENT) {
    console.error(`--control and the scenario are both "${CONTROL}" — the arms would be identical`)
    process.exit(1)
  }
  if (ONLY) arms = arms.filter((a) => a.id.startsWith(ONLY))
  console.log(`\nrun ${RUN_ID}`)
  console.log(`  task        ${TASK} — ${TASKCFG.title} (${TASKCFG.file})`)
  if (CONTROL) console.log(`  control     ${CONTROL} (replaces the stock session)`)
  console.log(`  scenario    ${exp.id}${exp.description ? ` — ${exp.description}` : ''}`)
  console.log(`  model       ${MODEL} (both arms) · budget $${BUDGET}/arm · auth ${AUTH.mode}`)
  console.log(`  arms        ${arms.map((a) => a.id).join('  vs  ')}\n`)
  // One trace per run, so two arms of the same experiment sit side by side in
  // LangSmith and every later run lands next to this one.
  await ensureProject()
  const trace = tracingOn() ? startTrace(`run ${EXPERIMENT} · ${TASK}`, {
    inputs: { runId: RUN_ID, task: TASK, taskTitle: TASKCFG.title, scenario: exp.id,
              description: exp.description, model: MODEL, arms: arms.map((a) => a.id) },
    metadata: { runId: RUN_ID, task: TASK, scenario: exp.id, model: MODEL,
                auth: AUTH.mode, budgetUsd: BUDGET, host: os.hostname() },
    tags: ['run', `task:${TASK}`, `scenario:${exp.id}`, `model:${MODEL}`],
  }) : null
  if (trace) console.log(`  ${C.dim}tracing to LangSmith project ${LS_PROJECT} · ${projectUrl()}${C.r}\n`)

  LIVE = new Live(arms.map((a) => ({ id: a.id, label: a.label, color: a.id === 'baseline' ? C.a : C.b })),
                  { rows: Number(process.env.LIVE_ROWS ?? 16) })
  LIVE.start()
  let recs
  try { recs = await Promise.all(arms.map((a) => runArm(a, trace))) } finally { LIVE.stop(); LIVE = null }
  fs.writeFileSync(path.join(OUT, 'run.json'), JSON.stringify({ runId: RUN_ID, model: MODEL, auth: AUTH.mode, experiment: exp.id, control: CONTROL, session: SESSION, task: TASK, taskTitle: TASKCFG.title, description: exp.description, arms: recs }, null, 2))
  const txt = report(recs)
  console.log(txt)
  fs.writeFileSync(path.join(OUT, 'report.txt'), txt.replace(/\x1b\[[0-9;]*m/g, ''))

  if (TASKCFG.kind === 'document' && recs.every((r) => r.document)) {
    console.log(`  ${C.y}judging the two documents (blind, randomised order)…${C.r}`)
    const { judgeRun } = await import('./judge.mjs')
    const j = await judgeRun(RUN_ID).catch((e) => ({ error: String(e?.message ?? e) }))
    if (j.error) console.log(`  ${C.rd}judge unavailable: ${j.error}${C.r}`)
    else {
      const data = JSON.parse(fs.readFileSync(path.join(OUT, 'run.json'), 'utf8'))
      data.judgement = j
      fs.writeFileSync(path.join(OUT, 'run.json'), JSON.stringify(data, null, 2))
      console.log(`  ${C.g}winner: ${j.winner}${C.r} (${j.margin}) · ${Object.entries(j.totals).map(([a, t]) => `${a} ${t}/60`).join('  ')}`)
    }
  }

  const html = path.join(OUT, 'report.html')
  fs.writeFileSync(html, buildHtml({ id: RUN_ID, data: { runId: RUN_ID, model: MODEL, auth: AUTH.mode, session: SESSION, experiment: exp.id, description: exp.description, arms: recs } }))
  console.log(`  spider chart: ${path.relative(ROOT, html)}`)

  await trace?.end({
    outputs: Object.fromEntries(recs.map((r) => [r.arm, {
      passed: r.grade?.passed ?? null, total: r.grade?.total ?? null,
      cost_usd: r.result?.total_cost_usd ?? null, turns: r.result?.num_turns ?? null,
      wallSec: r.totalWallSec ?? null, fatal: r.fatal ? String(r.fatal).split('\n')[0] : null,
    }])),
    error: recs.every((r) => r.fatal) ? 'every arm failed' : null,
  })
  if (trace) console.log(`  langsmith:    ${projectUrl()}\n`)
  else console.log('')
}

main().catch((e) => { console.error(e); process.exit(1) })
