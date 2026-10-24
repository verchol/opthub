/**
 * opt monitor — put Claude Code on OpenTelemetry, and show where its telemetry goes.
 *
 *   opt monitor on       write Claude Code's OTEL settings into ~/.claude/settings.json (backed up first)
 *   opt monitor off      remove exactly the settings `on` wrote
 *   opt monitor status   settings, the local collector, LangSmith tracing, and what has arrived
 *   opt monitor collect  run the OTLP receiver alone (the hub runs one too)
 *
 * `on` sends metrics, events and spans to the opt collector on 127.0.0.1 (http/json, port 4320),
 * or to any OTLP endpoint with --endpoint. The OTEL_LOG_* content gates stay off, so no prompt text,
 * tool input or file content is exported. New Claude Code sessions pick the settings up; running ones don't.
 */
import fs from 'node:fs'
import path from 'node:path'
import { OTLP_PORT, startCollector, readOtel } from './otel.mjs'
import { claudeSettingsPath, readClaudeSettings, langsmithConfig, langsmithProject } from './behaviour.mjs'
import { stateDir } from './state.mjs'

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
const MANAGED = () => path.join(stateDir('otel'), 'managed.json')
const LS_PLUGIN = 'langsmith-tracing@langsmith-claude-code-plugins'

function argOf(args, name, def = null) { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def }

/** The env block `on` writes. Traces are Claude Code's beta spans: they carry permission waits and time to first token. */
export function otelEnv({ endpoint = `http://127.0.0.1:${OTLP_PORT}`, traces = true, interval = 15000 } = {}) {
  const env = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_METRIC_EXPORT_INTERVAL: String(interval),
  }
  if (traces) Object.assign(env, { CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1', OTEL_TRACES_EXPORTER: 'otlp' })
  return env
}

/** Write settings atomically, keeping a timestamped backup of what was there. */
function writeSettings(settings) {
  const file = claudeSettingsPath()
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.opt-backup-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`)
  else fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.opt-tmp`
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

/**
 * Apply `want` to the settings env block. Returns what changed, or null when nothing did.
 * Each changed key is remembered with its earlier value, so `off` can put it back.
 */
export function applyEnv(want, { dry = false } = {}) {
  const settings = readClaudeSettings()
  const env = { ...(settings.env ?? {}) }
  const changes = []
  for (const [k, v] of Object.entries(want)) if (env[k] !== v) { changes.push([k, env[k], v]); env[k] = v }
  if (!changes.length) return null
  if (!dry) {
    writeSettings({ ...settings, env })
    const managed = readManaged()
    for (const [k, was, v] of changes) managed[k] = { set: v, was: k in managed ? managed[k].was : was ?? null }
    fs.writeFileSync(MANAGED(), JSON.stringify(managed, null, 2))
  }
  return changes
}

function readManaged() { try { return JSON.parse(fs.readFileSync(MANAGED(), 'utf8')) } catch { return {} } }

/** Undo `on`: each key it changed goes back to its earlier value, unless the user has changed it since. */
export function removeEnv({ dry = false } = {}) {
  const managed = readManaged()
  const settings = readClaudeSettings()
  const env = { ...(settings.env ?? {}) }
  const removed = [], restored = [], kept = []
  for (const [k, { set, was }] of Object.entries(managed)) {
    if (env[k] !== set) { if (k in env) kept.push(k); continue }
    if (was == null) { delete env[k]; removed.push(k) } else { env[k] = was; restored.push(k) }
  }
  if (!dry && (removed.length || restored.length)) writeSettings({ ...settings, env })
  if (!dry) fs.rmSync(MANAGED(), { force: true })
  return { removed, restored, kept }
}

async function collectorHealth(endpoint) {
  try {
    const u = new URL(endpoint)
    if (!/^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname)) return { external: true }
    const r = await fetch(`${u.origin}/health`, { signal: AbortSignal.timeout(1500) })
    return r.ok ? await r.json() : { down: true }
  } catch { return { down: true } }
}

const ago = (ms) => { if (!ms) return 'never'; const s = (Date.now() - ms) / 1000; return s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago` }

async function status() {
  const env = readClaudeSettings().env ?? {}
  const settings = readClaudeSettings()
  const on = env.CLAUDE_CODE_ENABLE_TELEMETRY === '1'
  console.log(`\n  ${C.b}Claude Code telemetry${C.x}  ${C.d}${claudeSettingsPath()}${C.x}`)
  console.log(`  OTEL       ${on ? `${C.g}on${C.x}` : `${C.y}off${C.x}  (opt monitor on)`}`)
  if (on) {
    const sig = ['METRICS', 'LOGS', 'TRACES'].map((s) => `${s.toLowerCase()}=${env[`OTEL_${s}_EXPORTER`] ?? 'none'}`).join(' ')
    console.log(`  exporters  ${sig}${env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA === '1' ? '' : `  ${C.d}(spans need CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1)${C.x}`}`)
    console.log(`  endpoint   ${env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '—'}  ${env.OTEL_EXPORTER_OTLP_PROTOCOL ?? ''}`)
    const gates = ['OTEL_LOG_USER_PROMPTS', 'OTEL_LOG_TOOL_DETAILS', 'OTEL_LOG_TOOL_CONTENT'].filter((k) => env[k] === '1')
    console.log(`  content    ${gates.length ? `${C.y}exported: ${gates.join(', ')}${C.x}` : 'not exported (prompts, tool inputs and output stay out)'}`)
    const h = await collectorHealth(env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '')
    console.log(`  collector  ${h.external ? `${C.d}external endpoint, not checked${C.x}` : h.down ? `${C.r}not running${C.x} — start the hub (opt hub start) or opt monitor collect` : `${C.g}up${C.x}  ${h.received} records since it started, last ${ago(h.last)}`}`)
  }
  const recs = readOtel({ sinceMs: Date.now() - 7 * 864e5 })
  const sids = new Set(recs.map((r) => r.a?.['session.id']).filter(Boolean))
  console.log(`  stored     ${recs.length} records, ${sids.size} sessions, last ${ago(recs.length ? Math.max(...recs.map((r) => r.t ?? 0)) : null)}  ${C.d}${stateDir('otel')}${C.x}`)

  const cfg = langsmithConfig()
  const plugin = settings.enabledPlugins?.[LS_PLUGIN] === true
  console.log(`\n  ${C.b}LangSmith tracing${C.x}  ${C.d}(the ${LS_PLUGIN} plugin)${C.x}`)
  console.log(`  plugin     ${plugin ? `${C.g}enabled${C.x}` : `${C.y}not installed${C.x}  — in Claude Code: /plugin marketplace add langchain-ai/langsmith-claude-code-plugins, then /plugin install ${LS_PLUGIN}`}`)
  console.log(`  tracing    ${cfg.tracing ? `${C.g}on${C.x}` : `${C.y}off${C.x}  (TRACE_TO_LANGSMITH=true)`}   project ${cfg.project}   ${cfg.endpoint}`)
  if (!cfg.key) console.log(`  read-back  ${C.y}no LANGSMITH_API_KEY${C.x} — the hub needs one to read traces back`)
  else {
    try {
      const p = await langsmithProject(cfg)
      console.log(`  read-back  ${p ? `${C.g}ok${C.x}  last trace ${ago(Date.parse(p.last))}` : `${C.y}no project "${cfg.project}" yet${C.x}`}`)
    } catch (e) { console.log(`  read-back  ${C.r}${String(e.message).slice(0, 120)}${C.x}`) }
  }
  if (plugin && cfg.tracing) console.log(`  ${C.d}the plugin sends prompts, responses and tool results to LangSmith (redacting known credential formats)${C.x}`)
  console.log(`\n  ${C.d}Analytics → Behaviour in the hub reads both.${C.x}\n`)
}

export async function cmdMonitor(sub, args = []) {
  const dry = args.includes('--dry')
  if (sub === 'on') {
    const endpoint = argOf(args, '--endpoint') ?? `http://127.0.0.1:${argOf(args, '--port', OTLP_PORT)}`
    const want = otelEnv({ endpoint, traces: !args.includes('--no-traces') })
    const lsEndpoint = argOf(args, '--langsmith-endpoint'), lsProject = argOf(args, '--langsmith-project')
    if (lsEndpoint) want.LANGSMITH_ENDPOINT = lsEndpoint
    if (lsProject) want.CC_LANGSMITH_PROJECT = lsProject
    if (lsEndpoint || lsProject || args.includes('--langsmith')) want.TRACE_TO_LANGSMITH = 'true'
    const changes = applyEnv(want, { dry })
    if (!changes) { console.log(`\n  already on — nothing to change in ${claudeSettingsPath()}\n`); return 0 }
    console.log(`\n  ${dry ? 'would set' : 'set'} in ${claudeSettingsPath()}${dry ? '' : ' (backup beside it)'}:`)
    for (const [k, was, v] of changes) console.log(`    ${k}=${v}${was != null ? `  ${C.d}(was ${was})${C.x}` : ''}`)
    if (!dry) {
      console.log(`\n  New Claude Code sessions export to ${endpoint}; sessions already open keep their old settings.`)
      if (!argOf(args, '--endpoint')) {
        const h = await collectorHealth(endpoint)
        console.log(h.down ? `  ${C.y}Nothing is listening there yet:${C.x} opt hub start (or opt monitor collect).` : `  ${C.g}The collector is up.${C.x}`)
      }
      if (lsEndpoint) console.log(`  LangSmith traces now go to ${lsEndpoint}. A self-hosted LangSmith needs an Enterprise license key.`)
    }
    console.log('')
    return 0
  }
  if (sub === 'off') {
    const { removed, restored, kept } = removeEnv({ dry })
    if (!removed.length && !restored.length) console.log('\n  nothing opt monitor wrote is left in the settings')
    if (removed.length) console.log(`\n  ${dry ? 'would remove' : 'removed'}: ${removed.join(', ')}`)
    if (restored.length) console.log(`  ${dry ? 'would restore' : 'restored'} the earlier value of: ${restored.join(', ')}`)
    if (kept.length) console.log(`  ${C.d}kept (changed since): ${kept.join(', ')}${C.x}`)
    console.log('')
    return 0
  }
  if (sub === 'collect') {
    const port = Number(argOf(args, '--port', OTLP_PORT))
    const s = await startCollector({ port, log: true })
    if (s.error) { console.error(`  ${s.error}`); return 1 }
    console.log(`\n  opt collector → ${s.url}  (OTLP http/json; writing ${stateDir('otel')}; ctrl-c to stop)\n`)
    await new Promise(() => {})
  }
  if (sub && sub !== 'status') {
    console.log(`
  ${C.b}opt monitor on${C.x} [--endpoint URL] [--port N] [--no-traces] [--dry]
                 [--langsmith] [--langsmith-project NAME] [--langsmith-endpoint URL]
  ${C.b}opt monitor off${C.x} [--dry]
  ${C.b}opt monitor status${C.x}
  ${C.b}opt monitor collect${C.x} [--port N]
`)
    return 1
  }
  await status()
  return 0
}

