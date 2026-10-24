/**
 * `opt install` — set up the local tier (release plan "Local cloud", step 1). It checks, and with
 * --yes fixes, what the router's local route depends on:
 *
 *   Ollama          at least 0.14.0 (Anthropic Messages API); the plan pins 0.40.10
 *   server settings OLLAMA_CONTEXT_LENGTH >= 65536 (Ollama's advice for coding agents),
 *                   OLLAMA_NUM_PARALLEL = the router's in-flight cap, OLLAMA_KV_CACHE_TYPE=q8_0 and
 *                   OLLAMA_FLASH_ATTENTION=1 (a quantized KV cache needs flash attention)
 *   models          a profile: `full` (default) or `lean`, below
 *   capacity        an `opt models bench` profile for the worker on this machine
 *
 * --yes runs only what is safe to run unattended: `launchctl setenv` for the settings (macOS; the
 * Ollama app must then be restarted) and `ollama pull` for missing models (downloads). It never
 * installs or upgrades Ollama itself, and never edits shell profiles; it prints those commands.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { benchFile } from './ult/capacity.mjs'

export const OLLAMA_MIN = '0.14.0'
export const OLLAMA_PIN = '0.40.10'

/**
 * What to pull, by role. Sizes from the Ollama registry manifests, 2026-10-24.
 *   decider  tev1, the classifier when rules are unsure (Jev's Choice contract)
 *   side     Claude Code's side calls: titles, topic checks
 *   small    small tool-less tasks: explain, summarize, PR text (`--routing local`)
 *   coder    coding questions; a MoE with ~3B active, so fast for its size
 *   reasoner a second strong candidate, so the hub's per-model scores have something to compare
 */
export const PROFILES = {
  full: [['decider', 'tev1', 4.5], ['side', 'qwen2.5-coder:1.5b', 1.0], ['small', 'qwen3:8b', 5.2],
         ['coder', 'qwen3-coder:30b', 18.6], ['reasoner', 'gpt-oss:20b', 13.8]],
  lean: [['decider', 'tev1', 4.5], ['side', 'qwen2.5-coder:1.5b', 1.0], ['small', 'qwen3:8b', 5.2]],
}

const cmp = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 10000 }, (err, stdout) => resolve(err ? null : String(stdout).trim())))

/** What is there now. Every probe is read-only. */
export async function survey({ baseUrl, worker, stateDir, platform = process.platform, exec = run, fetchImpl = fetch, env = process.env }) {
  const v = await exec('ollama', ['--version'])
  const version = /(\d+\.\d+\.\d+)/.exec(v ?? '')?.[1] ?? null
  const server = await fetchImpl(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).then((j) => j.version).catch(() => null)
  const names = ['OLLAMA_CONTEXT_LENGTH', 'OLLAMA_NUM_PARALLEL', 'OLLAMA_KV_CACHE_TYPE', 'OLLAMA_FLASH_ATTENTION']
  const settings = {}
  for (const k of names) settings[k] = platform === 'darwin' ? ((await exec('launchctl', ['getenv', k])) || null) : (env[k] ?? null)
  const tags = await fetchImpl(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => ({ models: [] }))
  const models = (tags.models ?? []).map((m) => m.name)
  return { version, server, settings, models, bench: fs.existsSync(benchFile(stateDir, worker)) }
}

/** Steps from a survey: each with ok, what is there, what is wanted, and how to fix it. */
export function plan(s, { worker, profile = 'full', maxInFlight = 1, platform = process.platform }) {
  const steps = []
  const has = (m) => s.models.some((n) => n === m || n === `${m}:latest`)
  steps.push({ id: 'ollama', ok: !!s.version && cmp(s.version, OLLAMA_MIN) >= 0, have: s.version ?? 'not installed',
               want: `>= ${OLLAMA_MIN} (pinned ${OLLAMA_PIN})`, fix: s.version ? 'brew upgrade ollama' : 'brew install ollama   (or https://ollama.com/download)', auto: null })
  if (s.version && cmp(s.version, OLLAMA_PIN) < 0 && cmp(s.version, OLLAMA_MIN) >= 0)
    steps.push({ id: 'ollama-pin', ok: false, advisory: true, have: s.version, want: OLLAMA_PIN, fix: 'brew upgrade ollama', auto: null })
  steps.push({ id: 'server', ok: !!s.server, have: s.server ?? 'not reachable', want: 'running', fix: platform === 'darwin' ? 'open -a Ollama' : 'ollama serve', auto: null })
  const want = { OLLAMA_CONTEXT_LENGTH: '65536', OLLAMA_NUM_PARALLEL: String(maxInFlight), OLLAMA_KV_CACHE_TYPE: 'q8_0', OLLAMA_FLASH_ATTENTION: '1' }
  for (const [k, w] of Object.entries(want)) {
    const have = s.settings[k]
    const ok = k === 'OLLAMA_CONTEXT_LENGTH' ? Number(have) >= Number(w) : have === w
    steps.push({ id: k, ok, have: have ?? 'unset', want: k === 'OLLAMA_CONTEXT_LENGTH' ? `>= ${w}` : w,
                 fix: platform === 'darwin' ? `launchctl setenv ${k} ${w}   # then restart the Ollama app` : `set ${k}=${w} in the ollama service environment`,
                 auto: platform === 'darwin' ? ['launchctl', ['setenv', k, w]] : null, restart: true })
  }
  for (const [role, m, gb] of PROFILES[profile]) steps.push({ id: `${role} ${m}`, ok: has(m), have: has(m) ? 'pulled' : `missing, ${gb} GB`, want: 'pulled', fix: `ollama pull ${m}`, auto: ['ollama', ['pull', m]], gb })
  steps.push({ id: 'bench', ok: s.bench, have: s.bench ? 'measured' : 'none', want: 'a capacity profile', fix: `opt models bench ${worker}`, auto: null })
  return steps
}

export async function cmdInstall(argv, { baseUrl, worker, maxInFlight, stateDir }) {
  const C = { b: '\x1b[1m', d: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', x: '\x1b[0m' }
  const yes = argv.includes('--yes')
  const i = argv.indexOf('--profile')
  const profile = argv.includes('--lean') ? 'lean' : i >= 0 ? argv[i + 1] : 'full'
  if (!PROFILES[profile]) { console.log(`\n  ${C.r}✗${C.x} no profile ${profile}: full (default) or lean\n`); return 2 }
  const s = await survey({ baseUrl, worker, stateDir })
  const steps = plan(s, { worker, profile, maxInFlight })
  const todoGb = steps.filter((st) => !st.ok && st.gb).reduce((a, st) => a + st.gb, 0)
  console.log(`\n  ${C.b}opt install${C.x} --profile ${profile}  ${C.d}the local tier: Ollama ${OLLAMA_PIN}, ${PROFILES[profile].map(([, m]) => m).join(', ')}, a capacity profile${todoGb ? ` · ${todoGb.toFixed(1)} GB to download` : ''}${C.x}\n`)
  for (const st of steps) {
    const mark = st.ok ? `${C.g}✓${C.x}` : st.advisory ? `${C.y}!${C.x}` : `${C.r}✗${C.x}`
    console.log(`  ${mark} ${st.id.padEnd(24)} ${String(st.have).padEnd(16)} ${C.d}want ${st.want}${C.x}${st.ok ? '' : `\n      ${C.d}${st.fix}${C.x}`}`)
  }
  const todo = steps.filter((st) => !st.ok && st.auto)
  if (!todo.length) { console.log(`\n  ${steps.every((st) => st.ok || st.advisory) ? `${C.g}ready${C.x}` : 'the rest needs you: run the commands above'}\n`); return 0 }
  if (!yes) { console.log(`\n  ${C.d}--yes runs ${todo.length} of these (settings and model downloads); the others are yours.${C.x}\n`); return 0 }
  let restart = false
  for (const st of todo) {
    const [cmd, args] = st.auto
    console.log(`  ${C.d}$ ${cmd} ${args.join(' ')}${C.x}`)
    const code = await new Promise((r) => execFile(cmd, args, { timeout: 0, maxBuffer: 1 << 26 }, (err) => r(err ? 1 : 0)))
    if (code) console.log(`    ${C.r}failed${C.x}`)
    restart ||= !!st.restart
  }
  if (restart) console.log(`\n  ${C.y}restart the Ollama app${C.x} so it reads the new settings, then run ${C.b}opt install${C.x} again.\n`)
  return 0
}
