#!/usr/bin/env node
/**
 * opt claude -p — Claude Code, headless, in optimize mode.
 *
 *   opt claude -p "<task>" [flags] [-- <claude args>]
 *
 * Optimize mode is everything opt has, around one `claude -p`:
 *
 *   sandbox      the local Docker sandbox: read-only source, a copy to work in, egress allowlist
 *   gateway      LLM Ultra Light, provisioned per run in its own container, in route mode: it
 *                classifies every request and moves side calls to a cheaper or local model.
 *                It holds the credential; the agent gets a placeholder key.
 *   profile      the project's rung on the profile ladder (lib/claude-profile.mjs): effort, lean
 *                working rules, attached skills. It moves after every compared run.
 *
 * --compare runs plain `claude -p` beside it — same task, same tree, same sandbox, same credential,
 * no gateway, no profile — then audits every claim the comparison makes (lib/claims.mjs).
 *
 *   opt claude example [name]        the repo's example (examples/claude-p/), both ways, audited
 *   opt claude runs                  recent runs
 *   opt claude audit [run]           re-check a run's claims from its files alone
 *   opt claude profile [--reset]     the project's rung, and why it is there
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { stateDir, STATE } from './lib/state.mjs'
import { withMachine } from './lib/model-scores.mjs'
import { warmLocal, localModels } from './lib/ult/capacity.mjs'
import { loadConfig } from './lib/ult/config.mjs'
import { projectKey } from './lib/ult/context-store.mjs'
import { launcherCredential } from './lib/ult/credentials.mjs'
import { ensureSandbox, reapOrphans, routerRunArgs, DUMMY_KEY, NET_INT } from './optimize-live.mjs'
import { runSandbox, readResult, diffTrees, outRoot, tilde } from './lib/local-run.mjs'
import { startTask, sha256 } from './lib/task-audit.mjs'
import { verdictOf } from './core.mjs'
import { loadProfile, saveProfile, resetProfile, planFor, recordOutcome, skillDirs, LEVELS } from './lib/claude-profile.mjs'
import { auditClaims, armEvidence, printClaims, listClaudeRuns } from './lib/claims.mjs'
import { SANDBOX_SH } from '../sandbox/docker/index.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const C = process.stderr.isTTY ? { b: '\x1b[1m', d: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', x: '\x1b[0m' } : { b: '', d: '', g: '', y: '', r: '', x: '' }
const err = (...a) => console.error(...a)
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const EXAMPLES = path.join(ROOT, 'examples', 'claude-p')
const RUNNER = { '.py': 'python3', '.sh': 'bash', '.js': 'node', '.mjs': 'node' }
const PORT = 8787
// One throwaway turn per side before a comparison: it writes that side's prompt-cache prefix
// (system prompt, tools, skills), so every measured run starts warm and neither side's cost
// depends on what happened to be cached from an earlier run.
const WARM_PROMPT = 'Reply with the single word: ready.'
// What the optimized agent holds instead of your credential; the gateway swaps in the real one.
// It has the shape of the credential the plain side uses, so Claude Code behaves the same on both
// sides (default model, prompt-cache lifetime, request headers): only the optimizations differ.
export const PLACEHOLDER_OAUTH = 'sk-ant-oat01-opthub-gateway-placeholder-not-a-real-token-0000000000'
const placeholderFor = (cred) => (cred.kind === 'oauth' ? { CLAUDE_CODE_OAUTH_TOKEN: PLACEHOLDER_OAUTH, ANTHROPIC_API_KEY: '' } : { ANTHROPIC_API_KEY: DUMMY_KEY, CLAUDE_CODE_OAUTH_TOKEN: '' })
const money = (v) => (v == null ? '—' : `$${v < 1 ? v.toFixed(4) : v.toFixed(2)}`)
const median = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null }
const seconds = (s) => { const m = /^(\d+)\s*([smh]?)$/.exec(String(s)); return m ? Number(m[1]) * ({ s: 1, m: 60, h: 3600 }[m[2] || 'm']) : null }

export const USAGE = `
  ${C.b}opt claude -p${C.x} "<task>" [flags] [-- <claude args>]    Claude Code headless, in optimize mode:
                            sandbox + LLM Ultra Light gateway + the project's tuned profile and skills

       --compare               also run plain claude -p on the same input, then audit the claims
       --repeats 3             runs per side (under 3, a difference is a direction, not a finding)
       --check <file>          hidden check (.py .sh .js) run against each result, outside the agent's view
       --dir <path>            the project (default: .)  — mounted read-only, worked on in a copy
       --level guarded|balanced|aggressive    this run's rung (default: the project's)
       --model <id>            main model, both sides
       --local-model <tag>     the gateway's local target (opt models)    --no-local
       --routing local         small tasks on local Ollama, the rest and every failure on the frontier model
       --skill <dir|name>      attach a skill (repeatable): a directory, or one of opt's own (opt-lean);
                               <project>/.opthub/skills is always attached
       --no-warm               skip the one-turn cache warm-up each side gets before a comparison
       --timeout 10m  --budget <usd>  --json  --dry-run

  ${C.b}opt claude example${C.x} [name]          the repo's example, optimized and plain, then the claims audit
  ${C.b}opt claude runs${C.x}                    recent runs, with their verdicts and claim counts
  ${C.b}opt claude audit${C.x} [run]             re-check a run's claims from its files alone
  ${C.b}opt claude profile${C.x} [--dir] [--reset]   the project's rung on the ladder and its history
  ${C.b}opt claude optimize${C.x} …              the interactive session behind the gateway
`

// ---------------------------------------------------------------- args
export function parseArgs(argv) {
  const dd = argv.indexOf('--')
  const extra = dd >= 0 ? argv.slice(dd + 1) : []
  const a = dd >= 0 ? argv.slice(0, dd) : argv
  const f = { skills: [], _: [], extra }
  for (let i = 0; i < a.length; i++) {
    const t = a[i]
    const [k, inline] = t.startsWith('--') && t.includes('=') ? [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)] : [t, undefined]
    const val = () => { if (inline !== undefined) return inline; if (i + 1 >= a.length) throw new Error(`${k} needs a value`); return a[++i] }
    switch (k) {
      case '-p': case '--print': f.prompt = val(); break
      case '--dir': f.dir = val(); break
      case '--compare': case '--baseline': f.compare = true; break
      case '--repeats': f.repeats = Number(val()); break
      case '--check': f.check = val(); break
      case '--level': f.level = val(); break
      case '--model': f.model = val(); break
      case '--local-model': f.localModel = val(); break
      case '--no-local': f.noLocal = true; break
      case '--routing': f.routing = val(); break
      case '--skill': f.skills.push(val()); break
      case '--timeout': f.timeout = val(); break
      case '--budget': f.budget = Number(val()); break
      case '--json': f.json = true; break
      case '--no-warm': f.noWarm = true; break
      case '--dry-run': f.dryRun = true; break
      case '--reset': f.reset = true; break
      case '-h': case '--help': f.help = true; break
      default:
        if (t.startsWith('-')) throw new Error(`unknown flag ${t} (claude's own flags go after --)`)
        f._.push(t)
    }
  }
  if (f.level && !LEVELS.some((l) => l.id === f.level)) throw new Error(`--level must be one of ${LEVELS.map((l) => l.id).join(', ')}`)
  return f
}

// ---------------------------------------------------------------- helpers
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const run = (cmd, args, o = {}) => new Promise((resolve) => {
  const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...o })
  let stdout = '', stderr = ''
  c.stdout?.on('data', (d) => stdout += d); c.stderr?.on('data', (d) => stderr += d)
  c.on('close', (status) => resolve({ status, stdout, stderr }))
  c.on('error', (e) => resolve({ status: -1, stdout: '', stderr: e.message }))
})

const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.cache'])
/** One digest for the whole source tree: what both sides start from. */
export function treeDigest(dir) {
  const files = []
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (SKIP.has(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) files.push(p) } }
  walk(dir)
  const h = crypto.createHash('sha256')
  for (const f of files.sort()) h.update(path.relative(dir, f) + '\0' + crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') + '\n')
  return h.digest('hex')
}

/** The script one side runs in its container. Both sides get the same copy step and the same claude invocation shape. */
export function armScript({ optimized, plan, model, timeoutSec, budget, extra, ws = 'workspace' }) {
  const flags = [
    ...(model ? ['--model', shq(model)] : []),
    ...(optimized ? plan.flags.map((x, i) => (i % 2 ? shq(x) : x)) : []),
    ...(optimized ? ['--append-system-prompt', shq(plan.rules)] : []),
    ...(budget ? ['--max-budget-usd', String(Number(budget))] : []),
    ...extra.map(shq),
  ]
  const ex = [...SKIP].map((d) => `--exclude=${shq(d)}`).join(' ')
  return [
    'set -u',
    ...(optimized ? Object.entries(plan.env).map(([k, v]) => `export ${k}=${shq(v)}`) : []),
    ...(optimized ? [
      'mkdir -p ~/.claude/skills && { [ -d /work/out/claude-home/skills ] && cp -R /work/out/claude-home/skills/. ~/.claude/skills/ || true; }',
      // proof for the audit: a hash of the key this container holds, never the key
      'printf %s "${ANTHROPIC_API_KEY:-}${CLAUDE_CODE_OAUTH_TOKEN:-}" | sha256sum > /work/out/agent-key.sha256',
    ] : []),
    `mkdir -p /work/out/${ws}`,
    `tar -C /work/src ${ex} -cf - . | tar -C /work/out/${ws} -xf -`,
    `cd /work/out/${ws}`,
    `timeout ${timeoutSec} claude -p "$(cat /work/out/task.md)" --output-format stream-json --verbose --dangerously-skip-permissions ${flags.join(' ')} > /work/out/events.jsonl 2> /work/out/stderr.log`,
    'code=$?',
    'echo "$code" > /work/out/exit_code',
    'exit $code',
  ].join('\n')
}

/** One gateway container for one optimized run: started, attached to the sandbox network, healthy. */
async function startRouter({ name, alias, routerDir, config, hash, cred, key }) {
  fs.mkdirSync(routerDir, { recursive: true })
  fs.writeFileSync(path.join(routerDir, 'ult.config.json'), JSON.stringify({ agent: 'claude', config, hash }, null, 2))
  const owner = ['--label', `opthub.session=${name}`, '--label', `opthub.launcher=${process.pid}@${os.hostname()}`]
  const env = { ...process.env, ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', [cred.env]: cred.value }
  let r = await run('docker', routerRunArgs({ name, owner, runDir: routerDir, ctxDir: stateDir('ult', 'context'), key, cred, port: PORT }), { env })
  if (r.status !== 0) throw new Error(`gateway container failed to start: ${r.stderr.trim()}`)
  r = await run('docker', ['network', 'connect', '--alias', alias, NET_INT, name])
  if (r.status !== 0) throw new Error(`could not attach the gateway to ${NET_INT}: ${r.stderr.trim()}`)
  const ip = (await run('docker', ['inspect', '-f', `{{(index .NetworkSettings.Networks "${NET_INT}").IPAddress}}`, name])).stdout.trim()
  const probe = `fetch('http://127.0.0.1:${PORT}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`
  for (let i = 0; i < 80; i++) {
    if ((await run('docker', ['exec', name, 'node', '-e', probe])).status === 0) return { name, alias, ip }
    await new Promise((res) => setTimeout(res, 125))
  }
  throw new Error(`gateway did not become healthy: ${(await run('docker', ['logs', name])).stderr.slice(-400)}`)
}

/** The hidden check, in a second sandbox, against the finished workspace mounted read-only. */
async function runCheck({ checkFile, work, outDir, name, env }) {
  const cDir = path.join(outDir, 'check')
  fs.mkdirSync(cDir, { recursive: true })
  const file = 'check' + path.extname(checkFile)
  fs.copyFileSync(checkFile, path.join(cDir, file))
  await runSandbox({ sandboxSh: SANDBOX_SH, src: work, outDir: cDir, name, env,
    script: `cd /work/src && ${RUNNER[path.extname(checkFile)]} /work/out/${file} > /work/out/check.log 2>&1; echo $? > /work/out/check_code; exit 0` })
  try { return Number(fs.readFileSync(path.join(cDir, 'check_code'), 'utf8').trim()) === 0 ? 'pass' : 'fail' } catch { return 'error' }
}

/**
 * The main model both sides run, so the comparison is like for like. Claude Code picks a different
 * default for a subscription login than for an API key (which is what the gateway side looks like),
 * so it is always passed explicitly: --model, else the model in ~/.claude/settings.json, else the
 * one your most recent session used.
 */
export function defaultModel() {
  try { const m = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).model; if (m) return { model: m, from: '~/.claude/settings.json' } } catch {}
  const root = path.join(os.homedir(), '.claude', 'projects')
  let newest = null
  try {
    for (const d of fs.readdirSync(root)) for (const f of fs.readdirSync(path.join(root, d))) {
      if (!f.endsWith('.jsonl')) continue
      const p = path.join(root, d, f), t = fs.statSync(p).mtimeMs
      if (!newest || t > newest.t) newest = { p, t }
    }
  } catch {}
  if (newest) {
    const tail = fs.readFileSync(newest.p, 'utf8').slice(-400000)
    const all = [...tail.matchAll(/"model":"(claude-[a-z0-9-]+)"/g)].map((m) => m[1]).filter((m) => !/haiku/.test(m))
    if (all.length) return { model: all.at(-1), from: 'your most recent session' }
  }
  return { model: 'claude-sonnet-5-5', from: 'the default' }
}

// ---------------------------------------------------------------- run
export async function runP(f) {
  const dir = path.resolve((f.dir ?? '.').replace(/^~(?=$|\/)/, os.homedir()))
  if (!fs.existsSync(dir)) { err(`no such directory: ${dir}`); return { code: 2 } }
  let prompt = f.prompt
  if (prompt === '-') prompt = fs.readFileSync(0, 'utf8')
  if (!prompt?.trim()) { err('nothing to run: opt claude -p "<task>"'); return { code: 2 } }
  prompt = prompt.trim()
  const checkFile = f.check ? path.resolve(f.check) : null
  if (checkFile && (!fs.existsSync(checkFile) || !RUNNER[path.extname(checkFile)])) { err(`--check: ${f.check} is missing or not a .py/.sh/.js file`); return { code: 2 } }
  if (checkFile && checkFile.startsWith(dir + path.sep)) err(`  ${C.y}note: the check is inside the project, so the agent can read it${C.x}`)
  const repeats = Math.max(1, f.repeats || 1)
  const timeoutSec = seconds(f.timeout ?? '10m') ?? 600

  const key = projectKey(dir)
  const profile = loadProfile(key)
  const plan = planFor(f.level ?? profile.level)
  const skills = skillDirs(dir, f.skills)
  const { config, hash } = loadConfig({ projectDir: dir, flags: { mode: 'route', ...(f.localModel ? { localModel: f.localModel } : {}), ...(f.noLocal ? { noLocal: true } : {}), ...(f.routing ? { routing: f.routing } : {}) } })
  withMachine(config, STATE)
  if (config.local.enabled && !f.dryRun) for (const model of localModels(config)) warmLocal({ baseUrl: config.local.baseUrl, model, keepAlive: config.local.keepAlive })
  const dm = f.model ? { model: f.model, from: '--model' } : defaultModel()
  f = { ...f, model: dm.model }
  const runId = `cp-${stamp()}-${crypto.randomBytes(2).toString('hex')}`
  const runDir = path.join(outRoot(), runId)
  // The working directory is in Claude Code's system prompt. One name per comparison, shared by both
  // sides and the warm-up, means no side starts with this exact prompt already cached from an earlier run.
  const ws = `ws-${runId.slice(3)}`

  err(`\n  ${C.b}opt claude -p${C.x} ${C.d}${runId}${C.x}`)
  err(`  project   ${tilde(dir)} ${C.d}(read-only; each run works in its own copy)${C.x}`)
  err(`  model     ${dm.model} ${C.d}both sides · from ${dm.from}${C.x}`)
  err(`  profile   ${C.b}${plan.level}${C.x} ${C.d}${plan.flags.join(' ') || 'no flags'} · lean rules · skills ${skills.map((s) => path.basename(s)).join(', ') || 'none'}${f.level ? ' (--level)' : ''}${C.x}`)
  err(`  gateway   LLM Ultra Light, route mode · local ${config.local.enabled ? config.local.model : 'off'} ${C.d}· config ${hash}${C.x}`)
  err(`  runs      optimized ×${repeats}${f.compare ? ` + plain claude -p ×${repeats}, in parallel` : ''}${checkFile ? ` · hidden check ${path.basename(checkFile)}` : ''}`)
  if (f.dryRun) {
    err(`\n${C.d}# optimized side, in the sandbox, ANTHROPIC_BASE_URL → the gateway, a placeholder key:${C.x}`)
    err(armScript({ optimized: true, plan, model: f.model, timeoutSec, budget: f.budget, extra: f.extra }))
    if (f.compare) { err(`\n${C.d}# plain side, the real credential, no gateway:${C.x}`); err(armScript({ optimized: false, plan, model: f.model, timeoutSec, budget: f.budget, extra: f.extra })) }
    return { code: 0 }
  }

  // one credential, the same kind for both sides: the gateway holds it on the optimized side
  const cred = launcherCredential(process.env)
  if (!cred) { err(`\n  ${C.r}no Claude credential${C.x}: opt claude optimize login  (your subscription), or AUTH_MODE=api-key with ANTHROPIC_API_KEY`); return { code: 2 } }
  err(`  auth      ${cred.kind === 'oauth' ? 'Claude subscription' : 'API key (bills credits)'} ${C.d}from ${cred.source}${C.x}`)

  const t0 = Date.now()
  // an idle Mac sleeps mid-run and freezes every sandbox with it; keep it awake until this process exits
  if (process.platform === 'darwin') try { spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).on('error', () => {}).unref() } catch {}
  const r0 = await run('docker', ['version', '--format', '{{.Server.Version}}'])
  if (r0.status !== 0) { err(`  ${C.r}Docker is not running${C.x}`); return { code: 20 } }
  await Promise.all([reapOrphans(), ensureSandbox()])

  const task = startTask('claude-p', {
    run: runId, project: tilde(dir), project_key: key, task_sha256: sha256(prompt), task_chars: prompt.length,
    level: plan.level, flags: plan.flags, env: Object.keys(plan.env), rules_sha256: sha256(plan.rules), skills: skills.map((s) => path.basename(s)),
    gateway: { mode: 'route', config: hash, local: config.local.enabled ? config.local.model : null }, compare: !!f.compare, repeats,
    check: checkFile ? path.basename(checkFile) : null, auth: cred.kind,
  })
  fs.mkdirSync(runDir, { recursive: true })
  const treeSha = treeDigest(dir)

  const arms = []
  for (let i = 1; i <= repeats; i++) arms.push({ side: 'optimized', label: `optimized-${i}` })
  if (f.compare) for (let i = 1; i <= repeats; i++) arms.push({ side: 'baseline', label: `plain-${i}` })
  const common = '--env DISABLE_AUTOUPDATER=1 --env CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1'
  const credEnv = { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', [cred.env]: cred.value }
  const routers = []
  const live = new Map()
  let shown = arms
  const tick = () => {
    if (!process.stderr.isTTY) return
    const line = `${Math.round((Date.now() - t0) / 1000)}s · ` + shown.map((a) => `${a.label} ${live.get(a.label) ?? 'starting'}`).join('   ')
    process.stderr.write(`\r  ${C.d}${line.slice(0, (process.stderr.columns || 120) - 4).padEnd(Math.min(110, (process.stderr.columns || 120) - 4))}${C.x}`)
  }

  async function runArm(a, { warm = false } = {}) {
    const outDir = path.join(runDir, a.label)
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'task.md'), warm ? WARM_PROMPT : prompt)
    const optimized = a.side === 'optimized'
    let env
    if (optimized) {
      live.set(a.label, 'gateway…'); tick()
      const id = `${runId.slice(3)}-${a.label.split('-').pop()}`.replace(/[^a-z0-9-]/gi, '')
      const rt = await startRouter({ name: `opthub-ult-${id}`, alias: `ult-${id}`, routerDir: path.join(outDir, 'router'), config, hash, cred, key })
      routers.push(rt); a.rt = rt
      // behind a non-Anthropic base URL Claude Code turns tool search off and sends every tool schema
      // with every request (+8k tokens each); the gateway forwards anthropic-beta verbatim, so keep it on
      for (const s of skills) fs.cpSync(s, path.join(outDir, 'claude-home', 'skills', path.basename(s)), { recursive: true })
      env = { ...placeholderFor(cred),
        SANDBOX_EXTRA_ARGS: `${common} --add-host ${rt.alias}:${rt.ip} --env ANTHROPIC_BASE_URL=http://${rt.alias}:${PORT} --env ENABLE_TOOL_SEARCH=true --env NO_PROXY=localhost,127.0.0.1,${rt.alias} --env no_proxy=localhost,127.0.0.1,${rt.alias}` }
    } else env = { ...credEnv, SANDBOX_EXTRA_ARGS: common }
    if (!warm) task.event('run-start', { run: a.label, side: a.side })
    const ev = path.join(outDir, 'events.jsonl')
    const poll = setInterval(() => { live.set(a.label, `${readResult(ev).turns} turns`); tick() }, 1500)
    const { code } = await runSandbox({ sandboxSh: SANDBOX_SH, src: dir, outDir, name: `${runId}-${a.label}`,
      script: armScript({ optimized, plan, model: f.model, timeoutSec, budget: f.budget, extra: warm ? ['--max-turns', '1', ...f.extra] : f.extra, ws }), env })
    clearInterval(poll)
    const work = path.join(outDir, ws)
    const diff = fs.existsSync(work) ? diffTrees(dir, work) : { added: [], changed: [] }
    a.exit = code; a.timedOut = code === 124
    a.files = [...diff.added.map((x) => '+' + x), ...diff.changed.map((x) => '~' + x)]
    if (checkFile && !warm && fs.existsSync(work)) { live.set(a.label, 'checking'); tick(); a.check = await runCheck({ checkFile, work, outDir, name: `${runId}-${a.label}-check`, env: { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' } }) }
    live.set(a.label, code === 0 ? `done${a.check ? ' · ' + a.check : ''}` : 'failed'); tick()
  }

  const warmArms = f.compare && !f.noWarm ? [{ side: 'optimized', label: 'warm-optimized' }, { side: 'baseline', label: 'warm-plain' }] : []
  try {
    if (warmArms.length) { shown = warmArms; await Promise.all(warmArms.map((a) => runArm(a, { warm: true }))); shown = arms }
    await Promise.all(arms.map((a) => runArm(a)))
  }
  catch (e) { task.fail(e); err(`\n  ${C.r}${e.message}${C.x}`); await stopRouters(routers, runDir, [...warmArms, ...arms]); return { code: 1 } }
  await stopRouters(routers, runDir, [...warmArms, ...arms])
  const warmup = Object.fromEntries(warmArms.map((a) => [a.side, armEvidence(runDir, a).cost]))
  if (process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(Math.min(120, process.stderr.columns || 120)) + '\r')

  // ---- the numbers, from the evidence each run left
  const ev = Object.fromEntries(arms.map((a) => [a.label, armEvidence(runDir, a)]))
  const rows = arms.map((a) => ({ ...a, cost_usd: ev[a.label].cost, duration_ms: ev[a.label].durationMs, is_error: ev[a.label].isError || a.exit !== 0,
    turns: ev[a.label].events.result?.num_turns ?? null, model: ev[a.label].events.init?.model ?? null, router: ev[a.label].router, check: a.check ?? null }))
  const opt = rows.filter((r) => r.side === 'optimized'), base = rows.filter((r) => r.side === 'baseline')
  // a comparison across two models measures the models, not optimize mode
  const models = new Set(rows.filter((r) => !r.is_error).map((r) => r.model))
  const verdict = !base.length ? null : models.size > 1
    ? { verdict: 'inconclusive', reason: `the sides ran different models (${[...models].join(' vs ')}), so this compares models, not optimize mode` }
    : verdictOf(base, opt, { hasCheck: !!checkFile, goal: 'cost' })
  let move = null
  if (f.compare && !f.level) { move = recordOutcome(profile, { level: plan.level, verdict: verdict?.verdict, run: runId, cost: median(opt.map((r) => r.cost_usd)), baseCost: median(base.map((r) => r.cost_usd)), check: opt[0]?.check }); saveProfile(profile) }

  const runJson = {
    run: runId, kind: 'claude-p', task_id: task.id, started: new Date(t0).toISOString(), seconds: Math.round((Date.now() - t0) / 1000),
    project: tilde(dir), task_sha256: sha256(prompt), tree_sha256: treeSha, auth: cred.kind,
    placeholder_sha256: sha256(Object.values(placeholderFor(cred)).join('')),
    profile: { level: plan.level, flags: plan.flags, env: plan.env, rules_sha256: sha256(plan.rules), skills: skills.map((s) => path.basename(s)) },
    gateway: { config: hash, local: config.local.enabled ? config.local.model : null }, compare: !!f.compare, repeats,
    warmup: warmArms.length ? { prompt_sha256: sha256(WARM_PROMPT), cost_usd: warmup, note: 'one turn per side before the measured runs; not in the comparison' } : null,
    check: checkFile ? { name: path.basename(checkFile), sha256: sha256(fs.readFileSync(checkFile)) } : null,
    arms: rows.map(({ label, side, exit, timedOut, files, check, cost_usd, duration_ms, turns, model, is_error }) => ({ label, side, exit, timed_out: timedOut, is_error, model, turns, cost_usd, duration_ms, check, files })),
    verdict, profile_move: move,
  }
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(runJson, null, 2))
  task.end({ verdict: verdict?.verdict ?? null, cost_usd: +(rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0) + Object.values(warmup).reduce((s, v) => s + (v ?? 0), 0)).toFixed(4), runs: rows.length, failed: rows.filter((r) => r.is_error).length, level_to: move?.to ?? null })

  const audit = auditClaims(runDir)
  if (f.json) { console.log(JSON.stringify({ ...runJson, claims: audit.summary }, null, 2)); return { code: opt.every((r) => !r.is_error) ? 0 : 1, runDir } }

  // ---- report (stderr), then the answer (stdout), as claude -p prints it
  report({ rows, opt, base, verdict, move, checkFile, runDir })
  if (warmArms.length) err(`  warm-up   ${C.d}one turn a side to warm the prompt cache: plain ${money(warmup.baseline)} · optimized ${money(warmup.optimized)} (not in the comparison)${C.x}`)
  printClaims(audit.claims, audit.summary)
  err(`\n  ${C.d}${Math.round((Date.now() - t0) / 1000)}s end to end · ${tilde(runDir)} · claims.md · opt claude audit ${runId}${C.x}\n`)
  const answer = ev[opt[0].label].events.result?.result
  if (answer) console.log(answer)
  return { code: opt.every((r) => !r.is_error) ? 0 : 1, runDir, runId }
}

/** Keep each gateway's log beside its run, then remove the container. */
async function stopRouters(routers, runDir, arms) {
  await Promise.all(routers.map(async (rt) => {
    const arm = arms.find((a) => a.rt === rt)
    const logs = await run('docker', ['logs', rt.name])
    if (arm) fs.writeFileSync(path.join(runDir, arm.label, 'router', 'ult.log'), logs.stdout + logs.stderr)
    await run('docker', ['rm', '-f', rt.name])
  }))
}

function report({ rows, opt, base, verdict, move, checkFile }) {
  const side = (rs) => ({ cost: median(rs.map((r) => r.cost_usd)), secs: median(rs.map((r) => r.duration_ms && r.duration_ms / 1000)), turns: median(rs.map((r) => r.turns)),
    model: rs[0]?.model ?? '—', check: checkFile ? `${rs.filter((r) => r.check === 'pass').length}/${rs.length} pass` : '—', failed: rs.filter((r) => r.is_error).length })
  const O = side(opt)
  const moved = opt.flatMap((r) => r.router?.moved ?? [])
  const decisions = {}
  for (const r of opt) for (const [k, v] of Object.entries(r.router?.byDecision ?? {})) decisions[k] = (decisions[k] ?? 0) + v
  const ch = (b, s) => (b == null || s == null || !b ? '' : `${s <= b ? C.g : C.r}${s - b >= 0 ? '+' : '−'}${Math.abs((s - b) / b * 100).toFixed(0)}%${C.x}`)
  if (base.length) {
    const B = side(base)
    const row = (k, b, s, d = '') => err(`  ${k.padEnd(10)}${String(b).padEnd(20)}${String(s).padEnd(20)}${d}`)
    err(`\n  ${C.d}${''.padEnd(10)}${'plain claude -p'.padEnd(20)}${'optimize mode'.padEnd(20)}change${C.x}`)
    row('cost', money(B.cost), money(O.cost), ch(B.cost, O.cost))
    row('time', B.secs != null ? `${Math.round(B.secs)}s` : '—', O.secs != null ? `${Math.round(O.secs)}s` : '—', ch(B.secs, O.secs))
    row('turns', B.turns ?? '—', O.turns ?? '—', ch(B.turns, O.turns))
    row('model', B.model, O.model)
    if (checkFile) row('check', B.check, O.check)
    const vc = verdict.verdict === 'keep' ? C.g : verdict.verdict === 'drop' ? C.r : C.y
    err(`\n  ${vc}${C.b}${{ keep: '✓ optimize mode wins', drop: '✗ plain claude -p wins', inconclusive: '? inconclusive' }[verdict.verdict]}${C.x}  ${verdict.reason}`)
  } else {
    err(`\n  ${O.failed ? C.r + '✗ failed' : C.g + '✓ done'}${C.x}  ${money(O.cost)} · ${O.turns ?? '—'} turns · ${O.secs != null ? Math.round(O.secs) + 's' : '—'} · ${O.model}${checkFile ? ` · check ${O.check}` : ''}`)
  }
  err(`  gateway   ${Object.entries(decisions).map(([k, v]) => `${k} ${v}`).join(' · ') || 'no requests'}${moved.length ? ` ${C.d}(${[...new Set(moved)].join('; ')})${C.x}` : ''}`)
  for (const r of opt.slice(0, 1)) if (r.files?.length) err(`  files     ${r.files.slice(0, 6).join('  ')}${r.files.length > 6 ? ` +${r.files.length - 6}` : ''} ${C.d}(measured from the tree)${C.x}`)
  if (move) err(`  profile   ${move.from === move.to ? move.to : `${move.from} → ${C.b}${move.to}${C.x}`} ${C.d}${move.why}${C.x}`)
  for (const r of rows.filter((x) => x.is_error)) err(`  ${C.r}${r.label}: ${r.timedOut ? 'timed out' : `exit ${r.exit}`} — see ${r.label}/stderr.log${C.x}`)
}

// ---------------------------------------------------------------- the other verbs
function runDirs() {
  try { return fs.readdirSync(outRoot()).filter((d) => d.startsWith('cp-') && fs.existsSync(path.join(outRoot(), d, 'run.json'))).sort().reverse() } catch { return [] }
}

/** Every run, re-audited from its files (the same listing the hub shows). */
function cmdRuns() {
  const rs = listClaudeRuns(outRoot(), 20)
  if (!rs.length) { err('\n  no runs yet: opt claude example\n'); return 0 }
  err(`\n  ${C.d}${'RUN'.padEnd(26)}${'LEVEL'.padEnd(12)}${'PLAIN'.padEnd(10)}${'OPTIMIZED'.padEnd(11)}${'VERDICT'.padEnd(14)}CLAIMS (re-audited)${C.x}`)
  for (const r of rs) {
    const cl = r.claims
    err(`  ${r.run.padEnd(26)}${String(r.level).padEnd(12)}${(r.compare ? money(r.plainCost) : '—').padEnd(10)}${money(r.optCost).padEnd(11)}${(r.verdict?.verdict ?? 'no compare').padEnd(14)}${cl ? `${cl.verified} ✓ ${cl.failed ? C.r + cl.failed + ' ✗' + C.x : '0 ✗'}${cl.failed ? C.d + '  ' + r.failed.map((f) => f.id).join(', ') + C.x : ''}` : '—'}`)
  }
  err(`\n  ${C.d}a run with any failed claim is not proof; opt claude audit <run> shows why${C.x}\n`)
  return 0
}

function cmdAuditRun(f) {
  const id = f._[1] ?? runDirs()[0]
  if (!id) { err('\n  no runs to audit\n'); return 1 }
  const dir = path.join(outRoot(), id)
  if (!fs.existsSync(path.join(dir, 'run.json'))) { err(`no run ${id}`); return 1 }
  const a = auditClaims(dir, { dummyKey: DUMMY_KEY })   // older runs recorded no placeholder: they used DUMMY_KEY
  if (f.json) { console.log(JSON.stringify(a.claims, null, 2)); return a.summary.failed ? 1 : 0 }
  err(`\n  ${C.b}${id}${C.x} ${C.d}re-audited from its files${C.x}`)
  printClaims(a.claims, a.summary)
  err(`\n  ${C.d}${tilde(path.join(dir, 'claims.md'))}${C.x}\n`)
  return a.summary.failed ? 1 : 0
}

function cmdProfile(f) {
  const dir = path.resolve(f.dir ?? '.')
  const key = projectKey(dir)
  if (f.reset) { resetProfile(key); err(`\n  ${tilde(dir)}: profile reset to the default rung\n`); return 0 }
  const p = loadProfile(key)
  err(`\n  ${C.b}${tilde(dir)}${C.x}  on ${C.b}${p.level}${C.x}`)
  for (const l of LEVELS) err(`  ${l.id === p.level ? C.g + '▸' : ' '} ${l.id.padEnd(12)}${C.x}${C.d}${l.adds}${C.x}`)
  const h = (p.history ?? []).slice(-8)
  if (h.length) { err(`\n  ${C.d}last outcomes${C.x}`); for (const x of h) err(`  ${x.at.slice(0, 16).replace('T', ' ')}  ${x.level.padEnd(11)}${String(x.verdict ?? '—').padEnd(14)}${money(x.base_cost)} → ${money(x.cost)}${x.check ? ` · ${x.check}` : ''}`) }
  else err(`\n  ${C.d}no compared runs yet: opt claude -p "…" --compare${C.x}`)
  err('')
  return 0
}

export function examples() {
  try { return fs.readdirSync(EXAMPLES).filter((d) => fs.existsSync(path.join(EXAMPLES, d, 'task.md'))) } catch { return [] }
}

async function cmdExample(f, opts) {
  const name = f._[1] ?? examples()[0]
  const ex = path.join(EXAMPLES, name ?? '')
  if (!name || !fs.existsSync(path.join(ex, 'task.md'))) { err(`\n  examples: ${examples().join(', ') || 'none'}\n`); return 2 }
  err(`\n  ${C.b}example ${name}${C.x} ${C.d}${tilde(ex)} — the same input, optimized and plain, then every claim audited${C.x}`)
  const r = await runP({ ...f, prompt: fs.readFileSync(path.join(ex, 'task.md'), 'utf8'), dir: path.join(ex, 'project'),
    check: fs.existsSync(path.join(ex, 'check.py')) ? path.join(ex, 'check.py') : f.check, compare: true }, opts)
  return r.code
}

export async function main(argv, opts = {}) {
  let f
  try { f = parseArgs(argv) } catch (e) { err(`${C.r}${e.message}${C.x}${USAGE}`); return 2 }
  if (f.help) { err(USAGE); return 0 }
  const verb = f._[0]
  if (verb === 'runs') return cmdRuns()
  if (verb === 'audit') return cmdAuditRun(f)
  if (verb === 'profile') return cmdProfile(f)
  if (verb === 'example' || verb === 'examples') return cmdExample(f, opts)
  if (f.prompt != null) return (await runP(f, opts)).code
  err(USAGE)
  return verb ? 2 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main(process.argv.slice(2)))
