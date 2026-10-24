/**
 * `opt optimize` — run one task, non-interactively, in the local Docker sandbox,
 * with one strategy from config/optimizations.json applied. The sandbox exits when
 * the task does.
 *
 *   source tree   mounted read-only at /work/src, copied to /work/out/workspace
 *   output        $OPT_HOME/sandbox-out/<task>/ on the host (= /work/out inside)
 *                   task.md        the instruction (local only, never in the audit log)
 *                   events.jsonl   claude -p --output-format stream-json
 *                   workspace/     the tree after the run
 *   network       only the egress allowlist (sandbox/docker/allowlist.txt)
 *
 * Strategies that need a proxy or Bedrock (open weights, LiteLLM caching, gateway
 * plugins) are refused with the reason, rather than silently run as something else.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { STATE } from './state.mjs'

export const AUTOCOMPACT = '100k'
// The catalog's model ids, as the Anthropic API names them. Bedrock-only models have no entry.
const ANTHROPIC_MODEL = { opus45: 'opus', sonnet46: 'sonnet' }
const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.cache'])

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/** Catalog entry → what the local sandbox does with it, or {error} saying why it cannot. */
export function localPlan(entry) {
  if (!entry) return { error: 'unknown strategy' }
  if (entry.runnable === false || !entry.arm) return { error: `${entry.id} needs a gateway in the request path (${entry.requires ?? 'sandbox/e2b/kong'}); the local sandbox has none` }
  const arm = entry.arm, flags = [], env = {}, notes = []
  if (arm.llmlight) return { error: `${entry.id} is an LLM Light routing profile; it needs the ULT router in the request path (opt claude optimize)` }
  if (arm.model && arm.model !== 'baseline') {
    const m = ANTHROPIC_MODEL[arm.model]
    if (!m) return { error: `${entry.id} runs ${arm.model}, which is served from Bedrock through LiteLLM; the local sandbox talks to the Anthropic API only` }
    flags.push(`--model ${m}`)
  }
  if (arm.effort) flags.push(`--effort ${arm.effort}`)
  if (arm.compaction) flags.push(`--autocompact ${AUTOCOMPACT}`)
  if (arm.budgetUsd) flags.push(`--max-budget-usd ${Number(arm.budgetUsd)}`)
  const lc = arm.litellm ?? {}
  const unsupported = Object.keys(lc).filter((k) => k !== 'routes')
  if (unsupported.length) return { error: `${entry.id} is a LiteLLM proxy feature (${unsupported.join(', ')}); the local sandbox has no proxy yet` }
  const alias = (v) => lc.routes?.[v] ? (ANTHROPIC_MODEL[lc.routes[v]] ?? null) : v
  const cc = arm.claude ?? {}
  if (cc.subagentModel) { const m = alias(cc.subagentModel); if (!m) return { error: `${entry.id} routes subagents to a Bedrock-only model` }; env.CLAUDE_CODE_SUBAGENT_MODEL = m }
  if (cc.backgroundModel) { const m = alias(cc.backgroundModel); if (!m) return { error: `${entry.id} routes side calls to a Bedrock-only model` }; env.ANTHROPIC_DEFAULT_HAIKU_MODEL = m; env.ANTHROPIC_SMALL_FAST_MODEL = m }
  if (lc.routes) notes.push('LiteLLM routes are applied as direct model names (no proxy in the local sandbox)')
  if (cc.thinkingTokens != null) env.MAX_THINKING_TOKENS = String(cc.thinkingTokens)
  if (cc.maxOutputTokens != null) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(cc.maxOutputTokens)
  for (const [k, v] of Object.entries(cc.env ?? {})) env[k] = String(v)
  if (cc.maxTurns) flags.push(`--max-turns ${Number(cc.maxTurns)}`)
  if (cc.fallbackModel) flags.push(`--fallback-model ${shq(cc.fallbackModel)}`)
  if (cc.appendSystemPrompt) flags.push(`--append-system-prompt ${shq(cc.appendSystemPrompt)}`)
  if (arm.flags) flags.push(arm.flags)
  return { flags, env, appendPrompt: arm.appendPrompt ?? null, settings: cc.settings ?? null, notes }
}

/** The script the container runs. It copies the tree, runs claude headless, and exits. */
export function containerScript(plan, { timeoutSec, extraFlags = [] }) {
  const exports = Object.entries(plan.env).map(([k, v]) => `export ${k}=${shq(v)}`)
  const settings = plan.settings ? [`mkdir -p ~/.claude && printf %s ${shq(JSON.stringify(plan.settings))} > ~/.claude/settings.json`] : []
  const ex = [...SKIP].map((d) => `--exclude=${shq(d)}`).join(' ')
  return [
    'set -u',
    ...exports,
    ...settings,
    'mkdir -p /work/out/workspace',
    `tar -C /work/src ${ex} -cf - . | tar -C /work/out/workspace -xf -`,
    'cd /work/out/workspace',
    'echo "{\\"phase\\":\\"agent\\",\\"ts\\":\\"$(date -u +%FT%TZ)\\"}" > /work/out/phase.json',
    `timeout ${timeoutSec} claude -p "$(cat /work/out/task.md)" --output-format stream-json --verbose --dangerously-skip-permissions ${[...plan.flags, ...extraFlags].join(' ')} > /work/out/events.jsonl 2> /work/out/stderr.log`,
    'code=$?',
    'echo "$code" > /work/out/exit_code',
    'exit $code',
  ].join('\n')
}

/** The last `result` event of a stream-json run. */
export function readResult(eventsFile) {
  let result = null, model = null, turns = 0
  if (!fs.existsSync(eventsFile)) return { result, model, turns }
  for (const line of fs.readFileSync(eventsFile, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    if (e.type === 'system' && e.subtype === 'init') model = e.model ?? model
    if (e.type === 'assistant') turns++
    if (e.type === 'result') result = e
  }
  return { result, model, turns }
}

const hashFile = (f) => { try { return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex') } catch { return null } }
function walk(dir, base = dir, out = []) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (SKIP.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, base, out); else if (e.isFile()) out.push(path.relative(base, p))
  }
  return out
}

/** Files the run added or changed, measured from the trees — not claimed by the agent. */
export function diffTrees(src, work) {
  const added = [], changed = []
  for (const rel of walk(work)) {
    const a = path.join(src, rel)
    if (!fs.existsSync(a)) added.push(rel)
    else if (hashFile(a) !== hashFile(path.join(work, rel))) changed.push(rel)
  }
  return { added, changed }
}

// At most this many sandboxes at once. Each one is a full Claude Code process; past a handful,
// the Docker VM starts swapping and a one-second `ls` inside a sandbox takes minutes.
let PARALLEL = Number(process.env.OPT_SANDBOX_PARALLEL ?? 6), running = 0
const waiting = []
export const setParallel = (n) => { if (n > 0) PARALLEL = n }
export const parallelLimit = () => PARALLEL
const acquire = () => new Promise((r) => { if (running < PARALLEL) { running++; r() } else waiting.push(r) })
const release = () => { const next = waiting.shift(); if (next) next(); else running-- }

/** Run the container, waiting for a free slot first. Resolves with the exit code. */
export async function runSandbox(opts) {
  await acquire()
  try { return await runSandboxNow(opts) } finally { release() }
}

function runSandboxNow({ sandboxSh, src, outDir, name, script, env, onTick }) {
  return new Promise((resolve) => {
    const child = spawn('bash', [sandboxSh, 'run', src, 'bash', '-lc', script], {
      // docker names allow [a-zA-Z0-9_.-]; a stacked strategy's '+' is not one of them
      env: { ...process.env, ...env, OPT_SANDBOX_OUT: outDir, SANDBOX_NAME: name.replace(/[^a-zA-Z0-9_.-]/g, '_') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let err = ''
    child.stdout.on('data', () => {})
    child.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-4000) })
    const t = setInterval(() => onTick?.(), 5000)
    child.on('close', (code) => { clearInterval(t); resolve({ code, stderr: err }) })
  })
}

export const outRoot = () => path.join(STATE, 'sandbox-out')
export const tilde = (p) => p.replace(os.homedir(), '~')

/** Several levers as one run. Two levers that set the same flag or variable cannot be stacked. */
export function mergePlans(plans) {
  const bad = plans.find((p) => p.error)
  if (bad) return bad
  const flags = [], env = {}, notes = [], seen = new Set()
  let appendPrompt = null, settings = null
  for (const p of plans) {
    for (const fl of p.flags) {
      const k = fl.split(' ')[0]
      if (seen.has(k)) return { error: `two levers both set ${k}; they cannot be stacked` }
      seen.add(k); flags.push(fl)
    }
    for (const [k, v] of Object.entries(p.env)) { if (k in env && env[k] !== v) return { error: `two levers both set ${k}` }; env[k] = v }
    if (p.appendPrompt) appendPrompt = appendPrompt ? `${appendPrompt}\n\n${p.appendPrompt}` : p.appendPrompt
    if (p.settings) settings = { ...(settings ?? {}), ...p.settings }
    notes.push(...p.notes)
  }
  return { flags, env, appendPrompt, settings, notes }
}
