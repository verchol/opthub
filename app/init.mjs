/**
 * init.mjs — is everything this rig depends on actually up?
 *
 * `opt init` is the command you run when something is wrong and you do not yet
 * know what, or when you come back to the project after a week. It checks each
 * dependency in turn, says which ones answer, and reads every session on disk to
 * report what has actually been running: models, context windows, tools.
 *
 * It is read-only and boots nothing. The only spend is one 4-token request to
 * check whether the Anthropic credential is alive — and that is the check people
 * most often want, because an exhausted key fails silently inside a sandbox
 * fifteen minutes later.
 */
import fs from 'node:fs'
import path from 'node:path'
import { collectSessions, contextPicture, toolTags } from './sessions.mjs'
import { RUNNERS } from './runners.mjs'
import { PROJECT as LS_PROJECT, projectUrl, enabled as tracingOn } from './langsmith.mjs'

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', m: '\x1b[35m',
            d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }

const OK = `${C.g}●${C.x}`, BAD = `${C.r}●${C.x}`, WARN = `${C.y}●${C.x}`
const n = (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'))
const k = (v) => (v == null ? '—' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M'
  : v >= 1e3 ? (v / 1e3).toFixed(0) + 'k' : String(Math.round(v)))

// Widths are measured without colour codes, or every column drifts.
const bare = (s) => String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '')
const pad = (s, w) => {
  const t = String(s ?? ''), len = bare(t).length
  if (len <= w) return t + ' '.repeat(w - len)
  // Truncating past an escape sequence would leave the terminal mid-colour, so
  // only plain strings are cut; coloured ones are the caller's job to size.
  return /\x1b\[/.test(t) ? t : t.slice(0, Math.max(0, w - 1)) + '…'
}
const W = Math.min(Math.max(process.stdout.columns || 100, 88), 118)
const RULE = '─'.repeat(W - 4)

/** A section header that reads as a divider rather than a shout. */
const head = (t, right = '') => {
  const label = ` ${t.toUpperCase()} `
  const fill = Math.max(0, W - 4 - label.length - bare(right).length - 1)
  return `\n  ${C.b}${label}${C.x}${C.d}${'─'.repeat(fill)}${C.x} ${right}`
}
const line = (mark, label, detail = '') => `   ${mark} ${pad(label, 23)}${C.d}${detail}${C.x}`

/**
 * A proportional bar. Terminals have no pixels, so the unit is a cell and the
 * eighth-blocks carry the remainder — the difference between 3% and 7% is
 * visible instead of both rounding to nothing.
 */
function bar(frac, width = 18, colour = C.c) {
  const f = Math.max(0, Math.min(1, frac || 0))
  let whole = Math.floor(f * width)
  let rem = Math.round((f * width - whole) * 8)
  if (rem === 8) { whole += 1; rem = 0 }        // a full eighth is just a block
  const parts = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
  const filled = '█'.repeat(Math.min(whole, width)) + (whole < width && rem ? parts[rem] : '')
  return colour + filled + C.x + C.d + '·'.repeat(Math.max(0, width - bare(filled).length)) + C.x
}

/** name → count, as ranked bars. */
function ranked(entries, { width = 18, top = 6, colour = C.c, fmt = (v) => n(v) } = {}) {
  const list = [...entries].sort((a, b) => b[1] - a[1]).slice(0, top)
  const max = list[0]?.[1] || 1
  return list.map(([label, v]) =>
    `      ${pad(label, 26)}${bar(v / max, width, colour)} ${C.d}${fmt(v)}${C.x}`)
}

async function get(url, headers, ms = 15000) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(ms) })
    return r.ok ? await r.json() : { __error: `${r.status} ${(await r.text()).slice(0, 120)}` }
  } catch (e) { return { __error: String(e?.message ?? e).slice(0, 120) } }
}

/** Every credential the rig can use, where it came from, and whether it answers. */
async function checkCredentials({ secrets, preflight }) {
  const live = [preflight.ok, !!process.env.E2B_API_KEY,
                !!(process.env.LANGSMITH_API_KEY || process.env.LANGCHAIN_API_KEY)].filter(Boolean).length
  const L = [head('credentials', `${C.d}${live}/3 core${C.x}`)]
  const src = (key) => {
    const r = secrets?.[key]
    if (!r?.source) return null
    return r.ref ? `${r.source}  ${r.ref}` : r.source
  }

  const e2b = process.env.E2B_API_KEY
  L.push(line(e2b ? OK : BAD, 'E2B_API_KEY', e2b ? `${src('E2B_API_KEY') ?? 'environment'} (${e2b.length} chars)` : 'missing — nothing can boot'))

  if (preflight.mode === 'API key') {
    L.push(line(preflight.ok ? OK : BAD, 'ANTHROPIC_API_KEY',
      preflight.ok ? `${src('ANTHROPIC_API_KEY') ?? 'set'} — live` : preflight.reason))
    if (!preflight.ok && preflight.fix) L.push(`      ${C.d}${preflight.fix}${C.x}`)
  } else if (preflight.mode) {
    L.push(line(WARN, 'CLAUDE_CODE_OAUTH_TOKEN', 'set, but a subscription token cannot be checked from here'))
  } else {
    L.push(line(BAD, 'anthropic auth', preflight.reason ?? 'none set'))
  }

  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
  if (oauth && preflight.mode === 'API key')
    L.push(line(WARN, 'CLAUDE_CODE_OAUTH_TOKEN', 'present as a fallback — expiry is not checkable from here'))

  const ls = process.env.LANGSMITH_API_KEY || process.env.LANGCHAIN_API_KEY
  L.push(line(ls ? OK : WARN, 'LANGSMITH_API_KEY', ls ? 'set — tracing on' : 'unset — runs will not be traced'))

  const aws = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
  L.push(line(aws ? OK : C.d + '·' + C.x, 'AWS credentials',
    aws ? `${src('AWS_ACCESS_KEY_ID') ?? 'set'} — region ${process.env.AWS_REGION ?? 'unset'}` : 'unset — the Bedrock runner is unavailable'))
  return L.join('\n')
}

async function checkE2B() {
  const L = [head('e2b')]
  const key = process.env.E2B_API_KEY
  if (!key) { L.push(line(BAD, 'api', 'no key')); return { text: L.join('\n'), templates: [] } }

  const tpl = await get('https://api.e2b.dev/templates', { 'X-API-KEY': key })
  const live = await get('https://api.e2b.dev/sandboxes?state=running', { 'X-API-KEY': key })

  if (tpl.__error) L.push(line(BAD, 'templates', tpl.__error))
  else {
    L.push(line(OK, 'templates', `${tpl.length} available`))
    for (const t of tpl) {
      const name = (t.aliases ?? [])[0] ?? t.templateID
      L.push(`      ${C.c}${pad(name, 20)}${C.x}${C.d}${t.cpuCount} vCPU · ${Math.round(t.memoryMB / 1024)} GB · ` +
             `${Math.round(t.diskSizeMB / 1024)} GB disk · spawned ${t.spawnCount ?? 0}× · ${t.buildStatus}${C.x}`)
    }
  }
  if (live.__error) L.push(line(WARN, 'running now', live.__error))
  else L.push(line(live.length ? WARN : OK, 'running now',
    live.length ? `${live.length} sandbox(es) — ${live.map((s) => s.sandboxID).join(', ')}` : 'none (nothing is burning time)'))
  return { text: L.join('\n'), templates: tpl.__error ? [] : tpl }
}

async function checkLangSmith() {
  const L = [head('langsmith')]
  const key = process.env.LANGSMITH_API_KEY || process.env.LANGCHAIN_API_KEY
  if (!key || !tracingOn()) { L.push(line(WARN, 'tracing', 'off — set LANGSMITH_API_KEY to record runs')); return L.join('\n') }

  const sessions = await get('https://api.smith.langchain.com/sessions?limit=100', { 'x-api-key': key })
  if (sessions.__error) { L.push(line(BAD, 'api', sessions.__error)); return L.join('\n') }
  const proj = sessions.find?.((p) => p.name === LS_PROJECT)
  if (!proj) {
    L.push(line(WARN, `project ${LS_PROJECT}`, 'not created yet — the first traced run creates it'))
    return L.join('\n')
  }
  let count = null
  try {
    const r = await fetch('https://api.smith.langchain.com/runs/query', {
      method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ session: [proj.id], limit: 100, is_root: true }),
      signal: AbortSignal.timeout(15000),
    })
    if (r.ok) count = (await r.json()).runs?.length ?? null
  } catch {}
  L.push(line(OK, `project ${LS_PROJECT}`,
    `${count == null ? '?' : count} trace(s) · last run ${proj.last_run_start_time?.slice(0, 19)?.replace('T', ' ') ?? 'never'}`))
  L.push(`      ${C.c}${projectUrl()}${C.x}`)
  return L.join('\n')
}

function checkRunners({ templates, preflight }) {
  const L = [head('model runners')]
  const names = new Set(templates.flatMap((t) => t.aliases ?? []))
  for (const r of Object.values(RUNNERS)) {
    let ok = true, why = r.label
    if (r.needsAnthropicAuth && !preflight.ok) { ok = false; why = `${r.label} — no working Anthropic credential` }
    if (r.template && !names.has(r.template)) { ok = false; why = `${r.label} — template "${r.template}" not built` }
    if (r.needsAws && !(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)) {
      ok = false; why = `${r.label} — AWS credentials unset`
    }
    L.push(line(ok ? OK : BAD, r.id, why))
  }
  return L.join('\n')
}

function checkContent(ROOT) {
  const L = [head('tasks & scenarios')]
  const ls = (d) => { try { return fs.readdirSync(path.join(ROOT, d)) } catch { return [] } }
  const tasks = ls('tasks').filter((t) => fs.existsSync(path.join(ROOT, 'tasks', t, 'task.json')))
  const scen = ls('scenarios').filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => f.replace(/\.md$/, ''))
  L.push(line(tasks.length ? OK : WARN, 'tasks', tasks.map((t) => {
    const graded = fs.existsSync(path.join(ROOT, 'tasks', t, 'test_hidden.py'))
    return graded ? t : `${t}${C.d}(ungraded)${C.x}${C.d}`
  }).join(' · ')))
  L.push(line(scen.length ? OK : WARN, 'scenarios', scen.join(' · ')))
  return L.join('\n')
}

/**
 * Every session on disk, read and summarised: which models ran, how much context
 * they actually used, and which tools they reached for.
 */
function analyseSessions(ROOT, { detail = 12 } = {}) {
  const all = collectSessions(ROOT, { sinceMs: null })
  const L = [head('sessions')]
  if (!all.length) { L.push(line(WARN, 'none', 'nothing has run yet')); return L.join('\n') }

  const e2b = all.filter((s) => s.kind === 'e2b').length
  const noUsage = all.filter((s) => s.state === 'no usage').length
  const models = new Map(), tools = new Map()
  const peaks = []
  let cost = 0, tokens = 0

  const rows = []
  for (const s of all) {
    if (s.model) models.set(s.model, (models.get(s.model) ?? 0) + 1)
    for (const t of toolTags(s.toolCounts)) tools.set(t.label, (tools.get(t.label) ?? 0) + t.n)
    cost += s.cost ?? 0
    tokens += s.tokens?.total ?? 0
    const pic = contextPicture(s)
    if (pic.available) peaks.push(pic.peak)
    rows.push({ s, pic })
  }
  peaks.sort((a, b) => a - b)
  const median = peaks.length ? peaks[Math.floor(peaks.length / 2)] : null

  L.push(line(OK, 'on disk', `${n(all.length)} sessions — ${e2b} e2b arm(s), ${n(all.length - e2b)} local` +
    (noUsage ? `, ${n(noUsage)} with no usage record` : '')))
  L.push(line(OK, 'spend', `$${cost.toFixed(2)} API-list equivalent over ${k(tokens)} tokens`))

  L.push(`\n      ${C.d}models${C.x}`)
  L.push(...ranked([...models.entries()], { colour: C.c }))

  L.push(`\n      ${C.d}tools reached for${C.x}`)
  L.push(...ranked([...tools.entries()], { colour: C.m, top: 8 }))

  if (peaks.length) {
    L.push(`\n      ${C.d}context peak — ${peaks.length} measurable, median ${k(median)}, largest ${k(peaks.at(-1))}${C.x}`)
    // Buckets, not a mean: context use is wildly skewed and an average hides it.
    const buckets = [[0, 25e3, 'under 25k'], [25e3, 100e3, '25k–100k'], [100e3, 250e3, '100k–250k'],
                     [250e3, 500e3, '250k–500k'], [500e3, Infinity, 'over 500k']]
    const counts = buckets.map(([lo, hi, label]) => [label, peaks.filter((p) => p >= lo && p < hi).length])
    const max = Math.max(...counts.map((c) => c[1]), 1)
    for (const [label, c] of counts)
      L.push(`      ${pad(label, 26)}${bar(c / max, 18, C.y)} ${C.d}${c}${C.x}`)
  }

  L.push('')
  L.push(`   ${C.d}${pad('SESSION', 22)}${pad('MODEL', 20)}${pad('CONTEXT USED', 30)}TOOLS${C.x}`)
  for (const { s, pic } of rows.slice(0, detail)) {
    const frac = pic.available ? pic.peak / pic.window : null
    const tint = frac == null ? C.d : frac > 0.8 ? C.r : frac > 0.5 ? C.y : C.g
    // 10 cells of bar + one space + 18 columns of text = 29, then one to spare.
    const gauge = pic.available ? bar(frac, 10, tint) : C.d + '·'.repeat(10) + C.x
    // Say *why* there is no picture. "no model call" was wrong for an arm whose
    // stream was simply never pulled back — it made plenty of calls.
    const missing = !pic.why ? 'unknown'
      : /never produced a stream|no billable request/.test(pic.why) ? 'never ran'
      : /not captured/.test(pic.why) ? 'stream not kept'
      : /no usage-bearing/.test(pic.why) ? 'no usage recorded'
      : 'unreadable'
    const label = pic.available
      ? pad(`${k(pic.peak)}/${k(pic.window)}${pic.windowInferred ? ' ?' : ''}`, 19)
      : pad(missing, 19)
    const top = toolTags(s.toolCounts).slice(0, 3).map((t) => `${t.label}·${t.n}`).join(' ')
    const ref = s.kind === 'e2b' ? C.m + pad(s.ref, 22) + C.x : pad(s.ref, 22)
    L.push(`   ${ref}${C.d}${pad(s.model ?? '—', 20)}${C.x}${gauge} ${C.d}${label}${top || '—'}${C.x}`)
  }
  if (all.length > detail)
    L.push(`   ${C.d}… ${n(all.length - detail)} more — ${C.x}opt session --all${C.d} for the full table${C.x}`)
  L.push(`   ${C.d}? = window inferred rather than reported${C.x}`)
  return L.join('\n')
}

export async function initReport(ROOT, { secrets, preflight, detail = 12 } = {}) {
  const out = []
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ')
  out.push('')
  out.push(`  ${C.b}opt init${C.x}  ${C.d}${RULE.slice(0, W - 14)}${C.x}`)
  out.push(`  ${C.d}everything this rig depends on \u00b7 ${when} \u00b7 read-only, boots nothing${C.x}`)
  out.push(await checkCredentials({ secrets, preflight }))
  const e2b = await checkE2B()
  out.push(e2b.text)
  out.push(await checkLangSmith())
  out.push(checkRunners({ templates: e2b.templates, preflight }))
  out.push(checkContent(ROOT))
  out.push(analyseSessions(ROOT, { detail }))

  // The verdict: can anything actually run right now, and by what route?
  const names = new Set(e2b.templates.flatMap((t) => t.aliases ?? []))
  const usable = Object.values(RUNNERS).filter((r) =>
    (!r.needsAnthropicAuth || preflight.ok) &&
    (!r.template || names.has(r.template)) &&
    (!r.needsAws || (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)))
  out.push('')
  out.push(`  ${C.d}${RULE}${C.x}`)
  if (!process.env.E2B_API_KEY)
    out.push(`  ${C.r}${C.b}  DOWN  ${C.x}  nothing can run — ${C.b}E2B_API_KEY${C.x} is missing`)
  else if (!usable.length)
    out.push(`  ${C.r}${C.b}  DOWN  ${C.x}  no runner is usable — fix a credential above, then re-run ${C.b}opt init${C.x}`)
  else {
    const partial = usable.length < Object.keys(RUNNERS).length
    out.push(`  ${partial ? C.y : C.g}${C.b}   UP   ${C.x}  ${usable.length} of ${Object.keys(RUNNERS).length} runners usable: ` +
             `${C.m}${usable.map((r) => r.id).join('  ')}${C.x}`)
    out.push(`  ${' '.repeat(8)}  ${C.d}opt demo run${C.x}${C.d} to compare two harnesses \u00b7 ` +
             `${C.x}opt replay --new${C.d} for the local\u2192sandbox experiment${C.x}`)
  }
  out.push('')
  return out.join('\n')
}
