/**
 * sessions.mjs — every agent session this rig has run, as a table, and the
 * context-window picture behind any one of them.
 *
 * A "session" is one arm of one run: a single Claude Code process in a single
 * sandbox. `opt session` lists them; `opt session <ref>` reconstructs what that
 * session's context window actually looked like — the same shape `/context`
 * draws inside Claude Code, rebuilt here from the arm's stream.jsonl.
 *
 * The reconstruction is honest about its limits. Claude Code measures its own
 * context live and can name each contributor; from the outside all we have is
 * the per-request token accounting, so we recover three segments:
 *
 *   prefix    the first request's input — system prompt, tool schemas,
 *             CLAUDE.md, and the task spec, all of which are sent once and
 *             then cached
 *   messages  everything the prefix grew by — conversation, tool results
 *   free      the rest of the model's window
 *
 * Those three are exact (they come from the API's own token counts). What is
 * *not* recoverable is the split inside `prefix` between system prompt, tools
 * and memory — Claude Code knows it, the token accounting does not.
 */
import http from 'node:http'
import { STATE } from './lib/state.mjs'
import { spawn } from 'node:child_process'
import { collectLocalSessions, oldestOnDisk, toolKey, PROJECTS_ROOT } from './transcripts.mjs'
import fs from 'node:fs'
import path from 'node:path'

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', m: '\x1b[35m',
            d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }

// files the harness writes for its own bookkeeping — not things the agent made
const BOOKKEEPING = new Set(['result.json', 'stream.jsonl', 'setup.txt', 'teardown.txt', 'claude.err'])

const n = (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'))
const compact = (v) => {
  if (v == null) return '—'
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k'
  return String(Math.round(v))
}
const dur = (s) => (s == null ? '—'
  : s < 90 ? `${Math.round(s)}s`
  : `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`)
const usd = (v) => (v == null ? '—' : '$' + v.toFixed(v < 1 ? 4 : 2))
const clip = (s, w) => { s = String(s ?? '') ; return s.length <= w ? s : s.slice(0, w - 1) + '…' }
const stripLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length
const pad = (s, w) => clip(s, w).padEnd(w)
const rpad = (s, w) => String(s ?? '').padStart(w)

// ---------------------------------------------------------------- collect

/** Description a scenario file declares in its frontmatter. */
function scenarioDescription(ROOT, id) {
  try {
    const src = fs.readFileSync(path.join(ROOT, 'scenarios', `${id}.md`), 'utf8')
    return /^description:\s*(.+)$/m.exec(src.split('---')[1] ?? '')?.[1]?.trim() ?? null
  } catch { return null }
}

function artifactsIn(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => !f.startsWith('.') && !BOOKKEEPING.has(f))
    .sort()
    .map((f) => {
      const p = path.join(dir, f)
      const st = fs.statSync(p)
      if (!st.isFile()) return null
      let lines = null
      try { lines = fs.readFileSync(p, 'utf8').split('\n').length } catch {}
      return { name: f, bytes: st.size, lines }
    })
    .filter(Boolean)
}

/**
 * When a session started, in epoch ms.
 *
 * The run id is itself a timestamp, so it works even for a run whose arms never
 * recorded one. Runs with an id that is not a timestamp (the synthetic
 * smoketest) are undated on purpose — they are not results and should fall
 * outside any time window.
 */
function runStartedMs(runId, arm, live) {
  const iso = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(runId)
  if (iso) return Date.parse(`${iso[1]}T${iso[2]}:${iso[3]}:${iso[4]}.${iso[5]}Z`)
  const t = arm?.started ?? live?.startedAt ?? live?.agentStartedAt
  const parsed = t ? Date.parse(t) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

/** "48h", "7d", "90m", "all" \u2192 a window in ms, or null for no filter. */
export function parseSince(spec) {
  if (spec == null) return null
  const raw = String(spec).trim().toLowerCase()
  if (!raw || raw === 'all' || raw === 'any' || raw === '0') return null
  const m = /^(\d+(?:\.\d+)?)\s*([mhdw])?$/.exec(raw)
  if (!m) return undefined                                   // unparseable \u2014 caller reports it
  const mult = { m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[m[2] ?? 'h']
  return Number(m[1]) * mult
}

export const DEFAULT_SINCE_MS = 48 * 3600e3

/** Sessions started within `sinceMs` of now. Undated sessions are never in a window. */
export function withinWindow(sessions, sinceMs, now = Date.now()) {
  if (sinceMs == null) return sessions
  return sessions.filter((x) => x.startedMs != null && now - x.startedMs <= sinceMs)
}

export function describeWindow(sinceMs) {
  if (sinceMs == null) return 'all time'
  const h = sinceMs / 3600e3
  if (h < 1) return `${Math.round(sinceMs / 60e3)}m`
  if (h > 48 && h % 24 === 0) return `${h / 24}d`      // past two days, days read better
  return `${h % 1 ? h.toFixed(1) : h}h`
}

/**
 * One row per arm of every run on disk, newest first.
 * Finished runs come from run.json; in-flight ones from status.json, so a
 * session that is still going shows up here with whatever is known so far.
 */
export function collectArmSessions(ROOT) {
  const RESULTS = path.join(STATE, 'results')
  if (!fs.existsSync(RESULTS)) return []
  const out = []

  for (const runId of fs.readdirSync(RESULTS).filter((d) => !d.startsWith('.')).sort().reverse()) {
    const dir = path.join(RESULTS, runId)
    if (!fs.statSync(dir).isDirectory()) continue
    const rd = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { return null } }
    const final = rd('run.json')
    const status = rd('status.json')
    if (!final && !status) continue

    const scenario = final?.experiment ?? status?.experiment ?? '—'
    const task = final?.task ?? status?.task ?? 'sheet'
    const taskTitle = final?.taskTitle ?? status?.taskTitle ?? task
    const scenarioDesc = final?.description ?? scenarioDescription(ROOT, scenario)
    const arms = final?.arms ?? Object.values(status?.arms ?? {})

    for (const a of arms) {
      const armId = a.arm
      const live = status?.arms?.[armId] ?? null
      const res = a.result ?? null
      const u = res?.usage ?? {}
      const mu = res?.modelUsage ?? {}
      const armDir = path.join(dir, armId)
      const streamPath = path.join(armDir, 'stream.jsonl')

      const model = Object.keys(mu).find((k) => /opus|sonnet/.test(k))
                 ?? Object.keys(mu)[0]
                 ?? final?.model ?? status?.model ?? null

      const state = a.fatal && !a.grade?.total ? 'failed'
        : res?.is_error ? 'errored'
        : final ? 'done'
        : (live?.step === 'done' ? 'done' : live?.step === 'failed' ? 'failed'
          : live?.step ? (live.step.startsWith('running') ? 'running' : live.step) : 'unknown')

      const tokens = {
        input: u.input_tokens ?? live?.live?.input ?? null,
        cacheWrite: u.cache_creation_input_tokens ?? live?.live?.cacheWrite ?? null,
        cacheRead: u.cache_read_input_tokens ?? live?.live?.cacheRead ?? null,
        output: u.output_tokens ?? live?.live?.out ?? null,
        thinking: u.output_tokens_details?.thinking_tokens ?? null,
      }
      tokens.total = ['input', 'cacheWrite', 'cacheRead', 'output']
        .reduce((s, k) => s + (tokens[k] ?? 0), 0) || null

      const isControl = armId === 'control'
      const intent = isControl
        ? 'control baseline — stock defaults, no strategy'
        : (scenarioDesc ?? `scenario: ${scenario}`)

      out.push({
        kind: 'e2b',
        where: `e2b/${task}`,
        runId,
        startedMs: runStartedMs(runId, a, live),
        runShort: /^\d{4}-\d{2}-\d{2}T/.test(runId)
          ? runId.replace(/^\d{4}-\d{2}-\d{2}T/, '').replace(/-\d{3}Z$/, '').replace(/-/g, ':')
          : runId,
        arm: armId,
        label: a.label ?? armId,
        scenario, task, taskTitle, intent, isControl,
        state,
        model,
        sandboxId: a.sandboxId ?? live?.sandboxId ?? null,
        startedAt: a.started ?? live?.startedAt ?? null,
        agentStartedAt: live?.agentStartedAt ?? null,
        wallSec: a.totalWallSec ?? (live?.startedAt && live?.at
          ? (Date.parse(live.at) - Date.parse(live.startedAt)) / 1000
          : live?.startedAt ? (Date.now() - Date.parse(live.startedAt)) / 1000 : null),
        agentSec: a.steps?.agent?.wallSec ?? (res?.duration_ms != null ? res.duration_ms / 1000 : null),
        apiSec: res?.duration_api_ms != null ? res.duration_api_ms / 1000 : null,
        ttftMs: res?.ttft_ms ?? null,
        turns: res?.num_turns ?? a.steps?.agent?.turns ?? live?.turns ?? null,
        tokens,
        cost: res?.total_cost_usd ?? live?.cost ?? null,
        modelUsage: mu,
        subagents: res?.subagent_stats?.spawned ?? 0,
        grade: a.grade ? { passed: a.grade.passed, total: a.grade.total, note: a.grade.note ?? '' }
             : (live?.total != null ? { passed: live.passed, total: live.total, note: '' } : null),
        linesOfCode: a.linesOfCode ?? null,
        levers: a.levers ?? [],
        fatal: a.fatal ?? null,
        resultText: res?.result ?? null,
        artifacts: artifactsIn(armDir),
        dir: armDir,
        streamPath: fs.existsSync(streamPath) ? streamPath : null,
        get toolCounts() { return this.streamPath ? readArmStream(this.streamPath)?.tools ?? null : null },
      })
    }
  }

  for (const x of out) x.ref = `${x.runShort}\u00b7${x.arm}`
  return out
}

/**
 * A local Claude Code session, in the same shape as an arm.
 *
 * `wallSec` here is span — first record to last inside the window — not time
 * spent working. A session resumed across days spans days; that is a fact about
 * resumption, not about effort.
 *
 * `artifacts` are files touched through Write/Edit tools. A session that writes
 * through Bash (a heredoc, a script) leaves no such record and shows none —
 * absence here means "not written through a file tool", not "produced nothing".
 */
function normalizeLocal(x, now) {
  const model = [...x.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const tokens = {
    input: x.tokens.input, cacheWrite: x.tokens.cacheWrite, cacheRead: x.tokens.cacheRead,
    output: x.tokens.output, thinking: x.tokens.thinking,
  }
  tokens.total = tokens.input + tokens.cacheWrite + tokens.cacheRead + tokens.output || null

  const artifacts = [...x.wrote].map((p) => {
    let bytes = null, lines = null
    try { const st = fs.statSync(p); bytes = st.size; lines = fs.readFileSync(p, 'utf8').split('\n').length } catch {}
    return { name: path.basename(p), bytes, lines, path: p }
  }).sort((a, b) => a.name.localeCompare(b.name))

  const project = x.cwd ? path.basename(x.cwd) : 'unknown'
  return {
    kind: 'local',
    ref: x.sid.slice(0, 8),
    sessionId: x.sid,
    runId: x.sid,
    runShort: x.sid.slice(0, 8),
    arm: project,
    label: project,
    where: project,
    scenario: null, task: project, taskTitle: x.cwd ?? project,
    intent: x.intent ?? '(no prompt recorded)',
    isControl: false,
    state: x.requests === 0 ? 'no usage' : (now - x.end < 5 * 60e3 ? 'active' : 'done'),
    model,
    sandboxId: null,
    startedMs: x.start,
    startedAt: new Date(x.start).toISOString(),
    wallSec: (x.end - x.start) / 1000,
    agentSec: null, apiSec: null, ttftMs: null,
    turns: x.requests || null,
    tokens,
    cost: x.requests ? x.cost : null,
    costBasis: 'list',
    modelUsage: {},
    subagents: x.sideRequests,
    subagentTokens: x.sideTokens,
    grade: null, linesOfCode: null, levers: [], fatal: null, resultText: null,
    artifacts,
    dir: x.cwd,
    streamPath: null,
    series: x.series,
    cwd: x.cwd, entry: x.entry, version: x.version, toolCalls: x.tools,
    toolCounts: x.toolCounts, sideTools: x.sideTools, prompts: x.prompts,
  }
}

/**
 * Every session, both kinds, newest first.
 *
 * `sources` selects which halves to gather; the window is applied here rather
 * than at render time because reading every transcript on disk to throw most of
 * them away would be silly.
 */
export function collectSessions(ROOT, { sinceMs = DEFAULT_SINCE_MS, sources = ['e2b', 'local'],
                                        now = Date.now() } = {}) {
  const out = []
  if (sources.includes('e2b')) out.push(...withinWindow(collectArmSessions(ROOT), sinceMs, now))
  if (sources.includes('local'))
    out.push(...collectLocalSessions({ sinceMs, now }).map((x) => normalizeLocal(x, now)))
  out.sort((a, b) => (b.startedMs ?? 0) - (a.startedMs ?? 0))
  out.forEach((x, i) => { x.idx = i + 1 })
  return out
}

/**
 * How many sessions of these kinds exist at all, so the table can say what the
 * window hid rather than quietly shrinking.
 */
export function countAll(ROOT, { sources = ['e2b', 'local'], now = Date.now() } = {}) {
  return (sources.includes('e2b') ? collectArmSessions(ROOT).length : 0)
       + (sources.includes('local') ? collectLocalSessions({ sinceMs: null, now }).length : 0)
}

/** Resolve "3", "control", "11:54:42·control", or a run-id fragment to one session. */
export function findSession(sessions, ref) {
  if (!ref) return null
  if (/^\d+$/.test(ref)) return sessions[+ref - 1] ?? null
  const norm = (s) => s.toLowerCase().replace(/[·:.\-_]/g, '')
  const q = norm(ref)
  return sessions.find((s) => norm(s.ref) === q)
      ?? sessions.find((s) => norm(s.ref).includes(q))
      ?? sessions.find((s) => norm(`${s.runId}${s.arm}`).includes(q))
      ?? null
}

// ---------------------------------------------------------------- /context

// An arm's stream is read once per change, not once per render.
const STREAM_CACHE = new Map()   // path -> { mtimeMs, size, parsed }

/**
 * Everything a session view needs out of one stream.jsonl: the main thread's
 * context series, what subagents spent in their own windows, and which tools
 * were actually called.
 */
export function readArmStream(streamPath) {
  let st
  try { st = fs.statSync(streamPath) } catch { return null }
  const hit = STREAM_CACHE.get(streamPath)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.parsed

  let lines
  try { lines = fs.readFileSync(streamPath, 'utf8').trim().split('\n') } catch { return null }
  const parsed = { series: [], subagentTokens: 0, tools: new Map(), sideTools: 0 }
  const totalIn = (u) => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)

  for (const line of lines) {
    let j; try { j = JSON.parse(line) } catch { continue }
    if (j.type !== 'assistant' || !j.message) continue
    const side = !!j.parent_tool_use_id
    for (const c of j.message.content ?? []) {
      if (c?.type !== 'tool_use') continue
      const key = toolKey(c)
      parsed.tools.set(key, (parsed.tools.get(key) ?? 0) + 1)
      if (side) parsed.sideTools++
    }
    const u = j.message.usage
    if (!u) continue
    const t = totalIn(u)
    if (!t) continue
    if (side) { parsed.subagentTokens += t; continue }   // a subagent's own window, not this one
    parsed.series.push({ t, at: j.timestamp ?? null, out: u.output_tokens ?? 0 })
  }
  STREAM_CACHE.set(streamPath, { mtimeMs: st.mtimeMs, size: st.size, parsed })
  return parsed
}

/**
 * `mcp__claude-in-chrome__computer` is accurate and unreadable in a tag. The
 * server name collapses to its last word, which is the part people say out
 * loud: chrome/computer, Notion/search, langsmith/fetch_runs.
 */
export function toolLabel(name) {
  const skill = /^Skill:(.+)$/.exec(name)
  if (skill) return `/${skill[1]}`
  const task = /^Task:(.+)$/.exec(name)
  if (task) return `@${task[1]}`
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  if (!m) return name
  const server = m[1].split(/[-_]/).filter(Boolean).at(-1)
  return `${server}/${m[2]}`
}

/** skills, subagents, MCP servers and built-ins read differently; tag them so. */
export function toolKind(name) {
  if (name.startsWith('Skill:')) return 'skill'
  if (name.startsWith('Task:')) return 'agent'
  if (name.startsWith('mcp__')) return 'mcp'
  return 'tool'
}

/** name -> count, biggest first, as a plain array. */
export function toolTags(counts) {
  if (!counts) return []
  const entries = counts instanceof Map ? [...counts.entries()] : Object.entries(counts)
  return entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .map(([name, n]) => ({ name, label: toolLabel(name), kind: toolKind(name), n }))
}


const CONTEXT_WINDOW_FALLBACK = 200000
/** The window sizes Claude Code actually runs with, smallest first. */
const STANDARD_WINDOWS = [200000, 1000000]
/** A drop this steep between consecutive requests means the thread was compacted. */
const COMPACTION_DROP = 0.7

/**
 * Rebuild the context window from an arm's stream.
 *
 * Each assistant message reports the tokens its request carried; summed, that
 * is exactly how full the window was at that moment. Walking the series gives
 * the peak, the final state, and any compaction — the points where the total
 * fell off a cliff because the thread was summarised and restarted.
 */
export function contextPicture(session, windowOverride = null) {
  const pic = {
    available: false, window: null, prefix: 0, peak: 0, final: 0,
    compactions: 0, series: [], subagentTokens: 0, requests: 0, why: null,
    windowInferred: false, alsoFits: null, windowReported: null,
  }

  const win = windowOverride
    ?? Object.values(session.modelUsage ?? {}).map((m) => m.contextWindow)
         .filter(Boolean).sort((a, b) => b - a)[0]
  pic.window = win ?? CONTEXT_WINDOW_FALLBACK

  // A local transcript already carries its series; only an arm needs the stream
  // parsed. Transcripts do not record the window, so it is inferred from the
  // smallest standard size the peak actually fits in.
  if (session.series) {
    pic.series = session.series
    if (!pic.series.length) {
      pic.why = 'this session made no billable request \u2014 nothing reached the model'
      return pic
    }
    const peak = Math.max(...pic.series.map((x) => x.t))
    const fits = STANDARD_WINDOWS.find((w) => peak <= w) ?? STANDARD_WINDOWS.at(-1)
    pic.window = win ?? fits
    // Only ambiguous while a larger standard window would also fit: a peak above
    // 200k leaves one size standing, a peak below it proves nothing either way.
    pic.alsoFits = win ? null : (STANDARD_WINDOWS.filter((w) => w > fits)[0] ?? null)
    pic.windowInferred = !win && !!pic.alsoFits
    pic.subagentTokens = session.subagentTokens ?? 0
    return finish(pic)
  }

  if (!session.streamPath) {
    pic.why = session.state === 'failed' || session.state === 'errored'
      ? 'the agent never produced a stream — nothing reached the model'
      : 'no stream.jsonl was captured for this session'
    return pic
  }

  const parsed = readArmStream(session.streamPath)
  if (!parsed) {
    pic.why = 'stream.jsonl could not be read'
    return pic
  }
  pic.series = parsed.series
  pic.subagentTokens = parsed.subagentTokens

  if (!pic.series.length) {
    pic.why = 'the stream carried no usage-bearing assistant messages'
    return pic
  }

  return finish(pic)
}

/** peak, final and compaction count, once a series is in hand. */
function finish(pic) {
  pic.available = true
  pic.requests = pic.series.length
  pic.prefix = pic.series[0].t
  pic.final = pic.series.at(-1).t
  for (const [i, p] of pic.series.entries()) {
    pic.peak = Math.max(pic.peak, p.t)
    if (i && p.t < pic.series[i - 1].t * COMPACTION_DROP) pic.compactions++
  }

  // A session cannot use more window than it has. When the reported size says
  // otherwise the report is what is wrong — a proxy in front of the API hides
  // which variant is really answering, and Claude Code falls back to the
  // default. Believe the tokens, and say the reported figure was rejected.
  if (pic.peak > pic.window) {
    pic.windowReported = pic.window
    pic.window = STANDARD_WINDOWS.find((w) => pic.peak <= w) ?? pic.peak
    pic.windowInferred = true
    pic.alsoFits = null
  }
  return pic
}

/** The three segments, as fractions of the window — what the grid draws. */
export function contextSegments(pic) {
  const messages = Math.max(0, pic.peak - pic.prefix)
  const free = Math.max(0, pic.window - pic.peak)
  return [
    { key: 'prefix', label: 'system prompt + tools + task spec', tokens: pic.prefix },
    { key: 'messages', label: 'conversation, tool results', tokens: messages },
    { key: 'free', label: 'free space', tokens: free },
  ]
}

// ---------------------------------------------------------------- terminal

/** The columns both surfaces can order by. Missing values always sink. */
export const SORTS = {
  start: { numeric: true, get: (s) => s.startedMs },
  src: { numeric: false, get: (s) => s.kind },
  session: { numeric: false, get: (s) => s.ref },
  where: { numeric: false, get: (s) => s.where },
  intent: { numeric: false, get: (s) => s.intent },
  state: { numeric: false, get: (s) => s.state },
  dur: { numeric: true, get: (s) => s.wallSec },
  turns: { numeric: true, get: (s) => s.turns },
  tokens: { numeric: true, get: (s) => s.tokens.total },
  cost: { numeric: true, get: (s) => s.cost },
  artifacts: { numeric: true, get: (s) => s.artifacts.length },
}

export function sortSessions(rows, key = 'start', dir = -1) {
  const spec = SORTS[key]
  if (!spec) return rows
  return rows.slice().sort((a, b) => {
    const x = spec.get(a), y = spec.get(b)
    const xm = x == null || x === '', ym = y == null || y === ''
    if (xm || ym) return xm && ym ? 0 : (xm ? 1 : -1)
    return (spec.numeric ? (x - y) : String(x).localeCompare(String(y), undefined, { numeric: true })) * dir
  })
}


export function renderTable(sessions, sinceMs = DEFAULT_SINCE_MS,
                            { hidden = 0, retention = null, sortKey = 'start', sortDir = -1 } = {}) {
  const W = { idx: 4, src: 7, ref: 22, where: 13, intent: 30, state: 12, dur: 9, turns: 6, tok: 10, cost: 10 }
  const L = []
  L.push('')
  L.push(`  ${C.d}${sinceMs == null ? 'all time' : `last ${describeWindow(sinceMs)}`}` +
         `${hidden ? ` · ${hidden} session${hidden === 1 ? '' : 's'} outside the window` : ''}` +
         `${sortKey !== 'start' ? ` · by ${sortKey}, ${sortDir < 0 ? 'high to low' : 'low to high'}` : ''}${C.x}`)
  if (!sessions.length) {
    L.push('')
    L.push(`  ${C.d}nothing in that window — ${C.x}opt session --since 7d${C.d} or ${C.x}opt session --all${C.x}`)
    L.push('')
    return L.join('\n')
  }
  L.push('  ' + C.d +
    pad('#', W.idx) + pad('SRC', W.src) + pad('SESSION', W.ref) + pad('WHERE', W.where) +
    pad('INTENT', W.intent) + pad('STATE', W.state) + rpad('DUR', W.dur) + rpad('TURNS', W.turns) +
    rpad('TOKENS', W.tok) + rpad('COST', W.cost) + '  ARTIFACTS' + C.x)

  const tint = { done: C.g, running: C.y, active: C.y, failed: C.r, errored: C.r, 'no usage': C.d }
  for (const s of sessions) {
    const gr = s.grade?.total ? ` ${s.grade.passed}/${s.grade.total}` : ''
    const st = (tint[s.state] ?? C.d) + pad(s.state + gr, W.state) + C.x
    const arts = s.artifacts.length
      ? s.artifacts.map((a) => a.name).slice(0, 3).join(' ') + (s.artifacts.length > 3 ? ` +${s.artifacts.length - 3}` : '')
      : C.d + '—' + C.x
    L.push('  ' +
      C.d + pad(String(s.idx), W.idx) + C.x +
      (s.kind === 'e2b' ? C.m : C.d) + pad(s.kind, W.src) + C.x +
      (s.isControl ? '' : C.c) + pad(s.ref, W.ref) + (s.isControl ? '' : C.x) +
      C.d + pad(s.where, W.where) + C.x +
      pad(s.intent, W.intent - 1) + ' ' + st +
      rpad(dur(s.wallSec), W.dur) + rpad(s.turns ?? '—', W.turns) +
      rpad(compact(s.tokens.total), W.tok) + rpad(usd(s.cost), W.cost) + '  ' + arts)
  }

  const sum = (f) => sessions.reduce((t, s) => t + (f(s) ?? 0), 0)
  const e2b = sessions.filter((s) => s.kind === 'e2b').length
  const noUsage = sessions.filter((s) => s.state === 'no usage').length
  L.push('')
  L.push('  ' + C.d + pad('', W.idx) +
    pad(`${sessions.length} sessions · ${e2b} e2b, ${sessions.length - e2b} local` +
        (noUsage ? ` (${noUsage} with no usage record)` : ''), W.src + W.ref + W.where + W.intent + W.state) +
    rpad('\u2014', W.dur) + rpad(sum((s) => s.turns), W.turns) +
    rpad(compact(sum((s) => s.tokens.total)), W.tok) + rpad(usd(sum((s) => s.cost)), W.cost) + C.x)
  L.push('')
  L.push(`  ${C.d}cost is API-list equivalent, not a bill \u2014 subscription traffic is not billed per token${C.x}`)
  if (sessions.length - e2b) {
    L.push(`  ${C.d}local DUR is span, first record to last \u2014 a resumed session spans days; the${C.x}`)
    L.push(`  ${C.d}column does not add up across sessions, so the total omits it${C.x}`)
    L.push(`  ${C.d}local artifacts count Write/Edit writes only \u2014 a file written by Bash leaves no record${C.x}`)
  }
  if (retention != null && (sinceMs == null || Date.now() - sinceMs < retention)) {
    const days = Math.round((Date.now() - retention) / 864e5)
    L.push('')
    L.push(`  ${C.y}your window starts before the oldest transcript on disk${C.x} ` +
           `${C.d}(${new Date(retention).toISOString().slice(0, 10)}, ${days}d old).${C.x}`)
    L.push(`  ${C.d}~/.claude/projects is pruned on cleanupPeriodDays, default 30 \u2014 the earlier${C.x}`)
    L.push(`  ${C.d}part was deleted, not idle. Every total above is a floor.${C.x}`)
  }
  L.push('')
  for (const [cmd, what] of [
    ['opt session <#>', 'context window for one session'],
    ['opt session ui', 'the same table in a browser, click a row'],
    ['opt session --since 7d', 'widen the window (--all for everything)'],
    ['opt session --e2b', 'experiment arms only (--local for this machine)'],
    ['opt session --sort cost', 'order by a column (-cost to reverse)'],
  ]) L.push(`  ${C.d}${cmd.padEnd(25)}${what}${C.x}`)
  L.push('')
  return L.join('\n')
}

const GRID_COLS = 50, GRID_ROWS = 10

export function renderContext(s, windowOverride = null) {
  const pic = contextPicture(s, windowOverride)
  const L = ['']
  L.push(`  ${C.b}${s.ref}${C.x}  ${C.d}${s.runId}${C.x}`)
  L.push(`  ${C.d}${s.taskTitle}${C.x}`)
  L.push(`  ${s.intent}`)
  L.push('')

  if (!pic.available) {
    L.push(`  ${C.y}no context picture${C.x} — ${pic.why}`)
    if (s.fatal) L.push(`  ${C.r}fatal:${C.x} ${clip(s.fatal.split('\n')[0], 100)}`)
    L.push('')
  } else {
    const segs = contextSegments(pic)
    const cells = GRID_COLS * GRID_ROWS
    const per = pic.window / cells
    const paint = []
    const colorOf = { prefix: C.c, messages: C.m, free: C.d }
    for (const seg of segs) {
      const k = Math.round(seg.tokens / per)
      for (let i = 0; i < k && paint.length < cells; i++) paint.push(seg.key)
    }
    while (paint.length < cells) paint.push('free')

    L.push(`  ${C.d}${s.model ?? 'model'} · ${n(pic.window)} token window` +
           `${pic.windowInferred ? ' (assumed)' : ''} · ${n(per)} tokens per cell${C.x}`)
    L.push('')
    for (let r = 0; r < GRID_ROWS; r++) {
      let line = '  '
      for (let c = 0; c < GRID_COLS; c++) {
        const k = paint[r * GRID_COLS + c]
        line += colorOf[k] + (k === 'free' ? '·' : '█') + C.x
      }
      L.push(line)
    }
    L.push('')
    for (const seg of segs) {
      const pct = (seg.tokens / pic.window) * 100
      L.push('  ' + colorOf[seg.key] + (seg.key === 'free' ? '·' : '█') + C.x + ' ' +
        pad(seg.label, 36) + rpad(n(seg.tokens), 10) + rpad(pct.toFixed(1) + '%', 8))
    }
    L.push('')
    const usedPct = (pic.peak / pic.window) * 100
    L.push(`  ${C.d}peak${C.x}     ${rpad(n(pic.peak), 10)}  ${C.d}${usedPct.toFixed(1)}% of the window, over ${pic.requests} requests${C.x}`)
    L.push(`  ${C.d}final${C.x}    ${rpad(n(pic.final), 10)}  ${C.d}${((pic.final / pic.window) * 100).toFixed(1)}%${C.x}`)
    if (pic.compactions)
      L.push(`  ${C.y}compacted${C.x} ${pic.compactions}×  ${C.d}the thread was summarised and restarted${C.x}`)
    if (pic.subagentTokens)
      L.push(`  ${C.d}subagents${C.x} ${rpad(n(pic.subagentTokens), 10)}  ${C.d}tokens in their own windows, ${s.subagents} spawned${C.x}`)
    L.push('')
    if (pic.windowReported) {
      L.push(`  ${C.y}the reported window was too small to be true${C.x} ${C.d}\u2014 this session claimed` +
             ` ${n(pic.windowReported)}${C.x}`)
      L.push(`  ${C.d}tokens but carried ${n(pic.peak)}. A proxy in front of the API hides which variant${C.x}`)
      L.push(`  ${C.d}is answering, so ${n(pic.window)} is used instead. Pin it with ${C.x}--window${C.d} if you know better.${C.x}`)
      L.push('')
    }
    if (pic.alsoFits) {
      const alt = (pic.peak / pic.alsoFits) * 100
      L.push(`  ${C.y}the window size is assumed${C.x} ${C.d}\u2014 a local transcript does not record it, and this${C.x}`)
      L.push(`  ${C.d}peak fits both sizes. On a ${n(pic.alsoFits)} window the fill is ${alt.toFixed(1)}%, not ` +
             `${((pic.peak / pic.window) * 100).toFixed(1)}%.${C.x}`)
      L.push(`  ${C.d}Pin it with ${C.x}opt session ${s.ref} --window ${pic.alsoFits >= 1e6 ? '1m' : pic.alsoFits}${C.x}`)
      L.push('')
    }
    L.push(`  ${C.d}the split inside the prefix — system prompt vs tools vs memory — is not${C.x}`)
    L.push(`  ${C.d}recoverable from token accounting; only Claude Code itself can name it.${C.x}`)
    L.push('')
  }

  const t = s.tokens
  const reuse = t.cacheRead && t.total ? (t.cacheRead / (t.cacheRead + (t.cacheWrite ?? 0) + (t.input ?? 0))) * 100 : null
  L.push(`  ${C.d}${'─'.repeat(70)}${C.x}`)
  L.push('')
  L.push(`  ${pad('billed', 14)}${C.d}in${C.x} ${n(t.input)}   ${C.d}cache write${C.x} ${n(t.cacheWrite)}   ${C.d}cache read${C.x} ${n(t.cacheRead)}`)
  L.push(`  ${pad('', 14)}${C.d}out${C.x} ${n(t.output)}${t.thinking ? ` ${C.d}(${n(t.thinking)} thinking)${C.x}` : ''}   ${C.d}total${C.x} ${n(t.total)}`)
  if (reuse != null) L.push(`  ${pad('cache reuse', 14)}${reuse.toFixed(1)}%`)
  L.push(`  ${pad('turns', 14)}${s.turns ?? '—'}${s.subagents ? `   ${C.d}${s.subagents} subagents${C.x}` : ''}`)
  L.push(`  ${pad('duration', 14)}${dur(s.wallSec)} ${C.d}total${C.x}   ${dur(s.agentSec)} ${C.d}agent${C.x}   ${dur(s.apiSec)} ${C.d}api${C.x}`)
  L.push(`  ${pad('cost', 14)}${usd(s.cost)}`)
  if (s.grade?.total) {
    const good = s.grade.passed === s.grade.total
    L.push(`  ${pad('graded', 14)}${good ? C.g : C.r}${s.grade.passed}/${s.grade.total}${C.x}${s.linesOfCode ? `   ${C.d}${s.linesOfCode}${C.x}` : ''}`)
  }
  if (s.sandboxId) L.push(`  ${pad('sandbox', 14)}${C.d}${s.sandboxId}${C.x}`)
  L.push('')

  const tags = toolTags(s.toolCounts)
  if (tags.length) {
    const calls = tags.reduce((t, x) => t + x.n, 0)
    const skills = tags.filter((t) => t.kind === 'skill').length
    L.push(`  ${C.d}TOOLS & SKILLS${C.x}  ${C.d}${calls} call${calls === 1 ? '' : 's'} \u00b7 ${tags.length} kind${tags.length === 1 ? '' : 's'}` +
           `${skills ? ` \u00b7 ${skills} skill${skills === 1 ? '' : 's'}` : ''}` +
           `${s.sideTools ? ` \u00b7 ${s.sideTools} from subagents` : ''}${C.x}`)
    // one tag per column-ish, wrapped by hand so the terminal never reflows badly
    const tint = { skill: C.m, agent: C.y, mcp: C.c, tool: '' }
    let line = '   '
    for (const t of tags) {
      const cell = ` ${tint[t.kind]}${t.label}${t.kind === 'tool' ? '' : C.x}${C.d}\u00b7${t.n}${C.x} `
      if (stripLen(line) + stripLen(cell) > 96) { L.push(line); line = '   ' }
      line += cell
    }
    if (stripLen(line) > 3) L.push(line)
    L.push('')
  }
  if (s.levers.length) {
    L.push(`  ${C.d}LEVERS${C.x}`)
    for (const l of s.levers) L.push(`    ${C.d}·${C.x} ${clip(l, 96)}`)
    L.push('')
  }
  if (s.artifacts.length) {
    L.push(`  ${C.d}ARTIFACTS${C.x}  ${C.d}${s.dir}${C.x}`)
    for (const a of s.artifacts)
      L.push(`    ${pad(a.name, 24)}${C.d}${rpad(a.lines != null ? a.lines + ' lines' : '', 12)}${rpad((a.bytes / 1024).toFixed(1) + ' KB', 11)}${C.x}`)
    L.push('')
  }
  if (s.resultText) {
    L.push(`  ${C.d}THE AGENT'S OWN SUMMARY${C.x}`)
    for (const line of clip(s.resultText, 400).split('\n')) L.push(`    ${C.d}${clip(line, 96)}${C.x}`)
    L.push('')
  }
  return L.join('\n')
}

// ---------------------------------------------------------------- browser

/** Everything the page needs, computed once per request. */
export function sessionsPayload(ROOT, sinceMs = DEFAULT_SINCE_MS, sources = ['e2b', 'local']) {
  const sessions = collectSessions(ROOT, { sinceMs, sources })
  // Reading every transcript on disk to throw most away would be wasteful, so
  // the window is applied here and the chips re-ask the server.
  return {
    now: Date.now(),
    sinceMs: sinceMs ?? null,
    sources,
    outside: countAll(ROOT, { sources }) - sessions.length,
    sessions: sessions.map((s) => {
      const pic = contextPicture(s)
      const altPct = pic.alsoFits ? (pic.peak / pic.alsoFits) * 100 : null
      return {
        idx: s.idx, ref: s.ref, runId: s.runId, arm: s.arm, isControl: s.isControl,
        kind: s.kind, where: s.where, startedMs: s.startedMs, cwd: s.cwd ?? null,
        scenario: s.scenario, task: s.task, taskTitle: s.taskTitle, intent: s.intent,
        state: s.state, model: s.model, sandboxId: s.sandboxId,
        wallSec: s.wallSec, agentSec: s.agentSec, apiSec: s.apiSec,
        turns: s.turns, tokens: s.tokens, cost: s.cost, subagents: s.subagents,
        grade: s.grade, linesOfCode: s.linesOfCode, levers: s.levers,
        tools: toolTags(s.toolCounts), sideTools: s.sideTools ?? 0,
        fatal: s.fatal, resultText: s.resultText, artifacts: s.artifacts, dir: s.dir,
        context: pic.available
          ? { available: true, window: pic.window, prefix: pic.prefix, peak: pic.peak,
              final: pic.final, compactions: pic.compactions, requests: pic.requests,
              subagentTokens: pic.subagentTokens, segments: contextSegments(pic),
              windowInferred: pic.windowInferred, alsoFits: pic.alsoFits, altPct,
              windowReported: pic.windowReported,
              series: pic.series.map((p) => p.t) }
          : { available: false, why: pic.why, window: pic.window },
      }
    }),
  }
}

const PAGE = String.raw`<!doctype html><html><head><meta charset="utf-8">
<title>sessions</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800&family=JetBrains+Mono:wght@400;500;700&family=Source+Serif+4:opsz,wght@8..60,400&display=swap">
<style>
:root{--ground:#F3F5F5;--surface:#FFF;--ink:#12181A;--muted:#5A6B6E;--rule:#D7DEDE;--rs:#B4BFBF;
 --a:#A8611F;--as:#F7EDE1;--b:#0E6E65;--bs:#E1F0EE;--free:#DDE3E3;
 --d:'Archivo',system-ui,sans-serif;--bd:'Source Serif 4',Georgia,serif;--m:'JetBrains Mono',ui-monospace,monospace}
@media (prefers-color-scheme:dark){:root{--ground:#0D1214;--surface:#151B1E;--ink:#E3EAE9;--muted:#8B9C9E;
 --rule:#232D30;--rs:#37474A;--a:#E2A462;--as:#2B2015;--b:#46BFAF;--bs:#0E2A27;--free:#1E2629}}
*{box-sizing:border-box}body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--bd);font-size:15px;line-height:1.55}
.wrap{max-width:1180px;margin:0 auto;padding:36px 22px 64px;display:flex;flex-direction:column;gap:22px}
.eyebrow{font-family:var(--m);font-size:10.5px;letter-spacing:.15em;text-transform:uppercase;color:var(--muted)}
h1{font-family:var(--d);font-weight:800;font-size:32px;letter-spacing:-.025em;margin:6px 0 0}
.sub{color:var(--muted);font-size:14.5px;margin:8px 0 0;max-width:64ch}
table{width:100%;border-collapse:collapse;font-size:13.5px;background:var(--surface);border:1px solid var(--rule)}
th,td{padding:8px 10px;border-bottom:1px solid var(--rule);text-align:left;vertical-align:top}
thead th{font-family:var(--m);font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--rs);white-space:nowrap;cursor:pointer;user-select:none}
thead th:hover{color:var(--ink)}
thead th.sorted{color:var(--b)}
thead th .car{opacity:.55;margin-left:4px;font-size:9px}
tbody tr{cursor:pointer}
tbody tr:hover{background:var(--bs)}
tbody tr.on{background:var(--bs);box-shadow:inset 2px 0 0 var(--b)}
.num{text-align:right;font-family:var(--m);font-variant-numeric:tabular-nums;white-space:nowrap}
.ref{font-family:var(--m);font-size:12px;white-space:nowrap}
.ref b{font-weight:700}
.arm{color:var(--a)}.arm.ctl{color:var(--muted)}
.src-e2b{color:var(--a)}.src-local{color:var(--muted)}
.intent{color:var(--muted);font-size:13px;max-width:34ch;line-height:1.45;max-height:4.35em;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.st{font-family:var(--m);font-size:11px;padding:2px 7px;border:1px solid var(--rule);white-space:nowrap}
.st.done{color:var(--b);border-color:var(--b)}.st.failed,.st.errored{color:var(--a);border-color:var(--a)}
.arts{font-family:var(--m);font-size:11px;color:var(--muted);max-width:22ch}
tfoot td{font-family:var(--m);font-size:11.5px;color:var(--muted);border-bottom:none}
.panel{background:var(--surface);border:1px solid var(--rule);border-top:3px solid var(--b);padding:20px 22px;display:flex;flex-direction:column;gap:16px}
.panel h2{font-family:var(--d);font-weight:700;font-size:19px;margin:0}
.panel .who{font-family:var(--m);font-size:11.5px;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(50,1fr);gap:2px;max-width:620px}
.cell{aspect-ratio:1;border-radius:1px}
.c-prefix{background:var(--b)}.c-messages{background:var(--a)}.c-free{background:var(--free)}
.legend{display:flex;flex-direction:column;gap:5px;font-family:var(--m);font-size:11.5px}
.legend div{display:grid;grid-template-columns:12px 1fr auto auto;gap:10px;align-items:center}
.legend i{width:10px;height:10px;display:block}
.legend .t{color:var(--muted)}.legend .v{font-variant-numeric:tabular-nums}.legend .p{font-variant-numeric:tabular-nums;color:var(--muted);width:52px;text-align:right}
.cols{display:grid;grid-template-columns:1.15fr 1fr;gap:22px}
.cols.one{grid-template-columns:1fr}
@media(max-width:860px){.cols{grid-template-columns:1fr}.grid{max-width:100%}}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-family:var(--m);font-size:11.5px}
.kv span:nth-child(odd){color:var(--muted)}
.kv span:nth-child(even){font-variant-numeric:tabular-nums}
.note{font-family:var(--m);font-size:10.5px;color:var(--muted);border-left:2px solid var(--rule);padding-left:10px}
.lev{font-family:var(--m);font-size:11px;color:var(--muted);display:flex;flex-direction:column;gap:3px}
.tags{display:flex;flex-wrap:wrap;gap:5px}
.tag{font-family:var(--m);font-size:11px;padding:3px 8px;border:1px solid var(--rule);background:var(--surface);color:var(--ink);white-space:nowrap}
.tag b{font-weight:500}
.tag i{font-style:normal;color:var(--muted);margin-left:5px}
.tag.top{border-color:var(--b);color:var(--b)}
.tag.top i{color:var(--b);opacity:.7}
.tag.skill{border-color:var(--a);color:var(--a);background:var(--as)}
.tag.skill i{color:var(--a);opacity:.75}
.tag.agent{border-style:dashed}
.tag.mcp b{color:var(--muted)}
.scrim{position:fixed;inset:0;background:rgba(10,16,18,.42);backdrop-filter:blur(2px);z-index:40;
 display:flex;align-items:flex-start;justify-content:center;padding:28px 20px;overflow:auto}
@media (prefers-color-scheme:dark){.scrim{background:rgba(0,0,0,.6)}}
.sheet{position:relative;width:100%;max-width:1080px;background:var(--surface);border:1px solid var(--rule);
 border-top:3px solid var(--b);box-shadow:0 26px 70px rgba(10,16,18,.28);margin:auto}
.sheet .panel{border:none;border-top:none;box-shadow:none}
.x{position:absolute;top:10px;right:12px;z-index:2;font-family:var(--m);font-size:16px;line-height:1;
 padding:5px 9px;border:1px solid var(--rule);background:var(--surface);color:var(--muted);cursor:pointer}
.x:hover{color:var(--ink);border-color:var(--rs)}
.nav{position:absolute;top:12px;right:52px;z-index:2;font-family:var(--m);font-size:10.5px;color:var(--muted)}
tbody tr.on td:first-child{position:relative}
.spark{display:flex;align-items:flex-end;gap:1px;height:34px}
.spark i{flex:1;background:var(--rs);min-height:1px}
.empty{color:var(--muted);font-family:var(--m);font-size:12px}
.bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bar .lab{font-family:var(--m);font-size:10.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--muted);margin-right:2px}
.win{font-family:var(--m);font-size:11.5px;padding:4px 11px;border:1px solid var(--rule);background:var(--surface);color:var(--muted);cursor:pointer}
.win:hover{border-color:var(--rs);color:var(--ink)}
.win.on{border-color:var(--b);color:var(--b);background:var(--bs)}
.bar .hid{font-family:var(--m);font-size:11px;color:var(--muted);margin-left:auto}
.foot{font-family:var(--m);font-size:10.5px;color:var(--muted);border-top:1px solid var(--rule);padding-top:12px}
</style></head><body><div class="wrap" id="root">loading…</div>
<script>
const n=(v)=>v==null?'—':Math.round(v).toLocaleString('en-US');
const k=(v)=>v==null?'—':v>=1e6?(v/1e6).toFixed(2)+'M':v>=1e3?(v/1e3).toFixed(1)+'k':String(Math.round(v));
const dur=(s)=>s==null?'—':s<90?Math.round(s)+'s':Math.floor(s/60)+'m'+String(Math.round(s%60)).padStart(2,'0')+'s';
const usd=(v)=>v==null?'—':'$'+v.toFixed(v<1?4:2);
const esc=(s)=>String(s??'').replace(/[&<>]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const COLS=50, ROWS=10;
const WINDOWS=[['6h',6*3600e3],['24h',24*3600e3],['48h',48*3600e3],['7d',7*864e5],['30d',30*864e5],['all',null]];
const SOURCES=[['both','both'],['e2b','e2b'],['local','local']];
// key, header, numeric?, accessor. 'start' is the natural order the server sends.
const COLUMNS=[
  ['start','#',  true, (s)=>s.startedMs],
  ['src',  'Src',false,(s)=>s.kind],
  ['ref',  'Session',false,(s)=>s.kind==='e2b'?s.ref:s.ref],
  ['where','Where',false,(s)=>s.where],
  ['intent','Intent',false,(s)=>s.intent],
  ['state','State',false,(s)=>s.state],
  ['dur',  'Dur', true, (s)=>s.wallSec],
  ['turns','Turns',true,(s)=>s.turns],
  ['tokens','Tokens',true,(s)=>s.tokens.total],
  ['cost', 'Cost',true, (s)=>s.cost],
  ['arts', 'Artifacts',true,(s)=>s.artifacts.length],
];
const COL=Object.fromEntries(COLUMNS.map((c)=>[c[0],c]));
let DATA=null, sel=0, since=48*3600e3, src='both', shown=[], busy=false;
let sortKey='start', sortDir=-1;      // newest first, the order the server sends
let open=false;                       // the detail sheet, over the table rather than below it

/** Missing values sink to the bottom whichever way the column is pointing. */
function sorted(rows){
  const [,,numeric,get]=COL[sortKey]||COL.start;
  return rows.slice().sort((a,b)=>{
    const x=get(a), y=get(b);
    const xm=x==null||x==='', ym=y==null||y==='';
    if(xm||ym) return xm&&ym?0:(xm?1:-1);
    if(numeric) return (x-y)*sortDir;
    return String(x).localeCompare(String(y),undefined,{numeric:true})*sortDir;
  });
}

function grid(ctx){
  if(!ctx.available) return '<p class="empty">no context picture — '+esc(ctx.why)+'</p>';
  const cells=COLS*ROWS, per=ctx.window/cells, out=[];
  for(const s of ctx.segments){
    const c=Math.round(s.tokens/per);
    for(let i=0;i<c&&out.length<cells;i++) out.push(s.key);
  }
  while(out.length<cells) out.push('free');
  return '<div class="grid">'+out.map((s)=>'<i class="cell c-'+s+'"></i>').join('')+'</div>';
}

function legend(ctx){
  if(!ctx.available) return '';
  return '<div class="legend">'+ctx.segments.map((s)=>
    '<div><i class="c-'+s.key+'"></i><span class="t">'+esc(s.label)+'</span>'+
    '<span class="v">'+n(s.tokens)+'</span>'+
    '<span class="p">'+(s.tokens/ctx.window*100).toFixed(1)+'%</span></div>').join('')+'</div>';
}

function panel(s){
  const c=s.context, t=s.tokens;
  const reuse=t.cacheRead?(t.cacheRead/(t.cacheRead+(t.cacheWrite||0)+(t.input||0))*100):null;
  const spark=c.available&&c.series.length>1
    ? '<div class="spark">'+c.series.map((v)=>'<i style="height:'+Math.max(2,v/Math.max(...c.series)*100)+'%"></i>').join('')+'</div>'
    : '';
  const kv=[
    ['peak', c.available?n(c.peak)+'  ('+(c.peak/c.window*100).toFixed(1)+'% of '+k(c.window)+(c.windowInferred?', assumed':'')+')':'—'],
    ['final', c.available?n(c.final):'—'],
    ['requests', c.available?n(c.requests):'—'],
    ['compactions', c.available?(c.compactions||'none'):'—'],
    ['billed in', n(t.input)],
    ['cache write', n(t.cacheWrite)],
    ['cache read', n(t.cacheRead)],
    ['output', n(t.output)+(t.thinking?'  ('+n(t.thinking)+' thinking)':'')],
    ['total tokens', n(t.total)],
    ['cache reuse', reuse==null?'—':reuse.toFixed(1)+'%'],
    ['turns', s.turns??'—'],
    ['tool calls', s.tools&&s.tools.length?s.tools.reduce((a,t)=>a+t.n,0)+'  ('+s.tools.length+' kinds)':'—'],
    ['subagents', s.subagents?s.subagents+' ('+k(c.subagentTokens)+' tok in their own windows)':'none'],
    ['duration', dur(s.wallSec)+' total · '+dur(s.agentSec)+' agent · '+dur(s.apiSec)+' api'],
    ['cost', usd(s.cost)],
    ['graded', s.grade&&s.grade.total?s.grade.passed+'/'+s.grade.total:'—'],
    ['sandbox', s.sandboxId||'—'],
  ];
  return '<div class="panel">'+
    '<div><div class="eyebrow">context window</div><h2>'+esc(s.ref)+'</h2>'+
    '<div class="who">'+esc(s.kind==='local'?(s.cwd||s.where):s.taskTitle)+' · '+esc(s.intent)+'</div></div>'+
    '<div class="cols'+(c.available?'':' one')+'"><div>'+grid(c)+
      (c.available?'<div class="who" style="margin-top:10px">'+n(c.window/(COLS*ROWS))+' tokens per cell · '+esc(s.model||'')+'</div>':'')+
      (spark?'<div style="margin-top:14px"><div class="eyebrow">context over the session</div>'+spark+'</div>':'')+
    '</div><div style="display:flex;flex-direction:column;gap:14px">'+legend(c)+
      '<div class="kv">'+kv.map(([a,b])=>'<span>'+esc(a)+'</span><span>'+esc(b)+'</span>').join('')+'</div>'+
    '</div></div>'+
    (c.available&&c.windowReported?'<p class="note"><b>The reported window was too small to be true.</b> This session claimed a '+n(c.windowReported)+' window but carried '+n(c.peak)+' tokens. A proxy in front of the API hides which variant is answering, so '+n(c.window)+' is used instead.</p>':'')+
    (c.available&&c.alsoFits?'<p class="note"><b>The window size is assumed.</b> A local transcript does not record it, and this peak fits both sizes: on a '+n(c.alsoFits)+' window the fill is '+c.altPct.toFixed(1)+'%, not '+(c.peak/c.window*100).toFixed(1)+'%. Pin it with <code>opt session '+esc(s.ref)+' --window '+(c.alsoFits>=1e6?'1m':c.alsoFits)+'</code>.</p>':'')+
    (c.available?'<p class="note">prefix, messages and free space come from the API’s own per-request token counts, so they are exact. The split <em>inside</em> the prefix — system prompt vs tool schemas vs memory — is not recoverable from token accounting; only Claude Code itself can name it.</p>':'')+
    (s.kind==='local'?'<p class="note">Cost is API-list equivalent, not a bill. <b>duration</b> is span — first record to last — not time spent working. <b>artifacts</b> count Write/Edit writes only; a file written through Bash leaves no record.</p>':'')+
    (s.fatal?'<p class="note">fatal: '+esc(s.fatal.split('\n')[0])+'</p>':'')+
    (s.tools&&s.tools.length?(()=>{
      const calls=s.tools.reduce((a,t)=>a+t.n,0), top=s.tools[0].n;
      const skills=s.tools.filter((t)=>t.kind==='skill').length;
      return '<div><div class="eyebrow">tools &amp; skills · '+calls+' call'+(calls===1?'':'s')+', '+s.tools.length+' kind'+
        (s.tools.length===1?'':'s')+(skills?' · '+skills+' skill'+(skills===1?'':'s'):'')+
        (s.sideTools?' · '+s.sideTools+' from subagents':'')+'</div>'+
        '<div class="tags">'+s.tools.map((t)=>
          '<span class="tag '+t.kind+(t.n===top&&t.kind!=='skill'?' top':'')+'" title="'+esc(t.name)+'"><b>'+
          esc(t.label)+'</b><i>'+t.n+'</i></span>').join('')+
        '</div></div>';
    })():'')+
    (s.levers&&s.levers.length?'<div><div class="eyebrow">levers</div><div class="lev">'+s.levers.map((l)=>'<span>· '+esc(l)+'</span>').join('')+'</div></div>':'')+
    (s.artifacts.length?'<div><div class="eyebrow">artifacts</div><div class="lev">'+s.artifacts.map((a)=>'<span>'+esc(a.name)+' — '+(a.lines!=null?a.lines+' lines, ':'')+(a.bytes/1024).toFixed(1)+' KB</span>').join('')+'<span style="opacity:.6">'+esc(s.dir)+'</span></div></div>':'')+
    (s.resultText?'<div><div class="eyebrow">the agent’s own summary</div><p class="sub" style="font-size:13.5px">'+esc(s.resultText.slice(0,600))+'</p></div>':'')+
  '</div>';
}

function bar(outside){
  return '<div class="bar"><span class="lab">window</span>'+
    WINDOWS.map(([lab,ms])=>'<button class="win'+(ms===since?' on':'')+'" data-w="'+(ms==null?'':ms)+'">'+lab+'</button>').join('')+
    '<span class="lab" style="margin-left:14px">source</span>'+
    SOURCES.map(([lab,v])=>'<button class="win src'+(v===src?' on':'')+'" data-s="'+v+'">'+lab+'</button>').join('')+
    (outside?'<span class="hid">'+outside+' session'+(outside===1?'':'s')+' outside</span>':'')+
  '</div>';
}

function draw(){
  const y=window.scrollY;
  const S=DATA.sessions;
  if(sel>=S.length) sel=Math.max(0,S.length-1);
  const outside=DATA.outside||0;
  if(!S.length){
    document.getElementById('root').innerHTML=
      '<div><div class="eyebrow">opt session</div><h1>every session, e2b and local</h1></div>'+
      bar(outside)+'<p class="empty">nothing in this window — widen it above.</p>';
    wireBar();
    return;
  }
  const tot=(f)=>S.reduce((a,s)=>a+(f(s)||0),0);
  const view=sorted(S);
  shown=view;
  const rows=view.map((s,i)=>
    '<tr data-i="'+i+'"'+(i===sel?' class="on"':'')+'>'+
    '<td class="num" style="color:var(--muted)">'+s.idx+'</td>'+
    '<td class="ref src-'+s.kind+'">'+esc(s.kind)+'</td>'+
    '<td class="ref">'+(s.kind==='e2b'
      ? '<b>'+esc(s.ref.split('·')[0])+'</b>·<span class="arm'+(s.isControl?' ctl':'')+'">'+esc(s.arm)+'</span>'
      : '<b>'+esc(s.ref)+'</b>')+'</td>'+
    '<td class="ref" style="color:var(--muted)">'+esc(s.where)+'</td>'+
    '<td><div class="intent">'+esc(s.intent)+'</div></td>'+
    '<td><span class="st '+esc(s.state)+'">'+esc(s.state)+(s.grade&&s.grade.total?' '+s.grade.passed+'/'+s.grade.total:'')+'</span></td>'+
    '<td class="num">'+dur(s.wallSec)+'</td>'+
    '<td class="num">'+(s.turns??'—')+'</td>'+
    '<td class="num">'+k(s.tokens.total)+'</td>'+
    '<td class="num">'+usd(s.cost)+'</td>'+
    '<td class="arts">'+(s.artifacts.length?esc(s.artifacts.map((a)=>a.name).join(' ')):'—')+'</td></tr>').join('');

  document.getElementById('root').innerHTML=
    '<div><div class="eyebrow">opt session</div><h1>every session, e2b and local</h1>'+
    '<p class="sub">Every Claude Code session in the window: the arms this rig ran in E2B, and the ones that ran on this machine. Click a row for its context window.</p></div>'+
    bar(outside)+
    '<table><thead><tr>'+COLUMNS.map(([k,label,num])=>
      '<th data-k="'+k+'" class="'+(num&&k!=='start'&&k!=='arts'?'num ':'')+(sortKey===k?'sorted':'')+'" '+
      'title="sort by '+label.toLowerCase()+'">'+label+
      (sortKey===k?'<span class="car">'+(sortDir<0?'\u25bc':'\u25b2')+'</span>':'')+'</th>').join('')+'</tr></thead>'+
    '<tbody>'+rows+'</tbody>'+
    '<tfoot><tr><td></td><td colspan="5">'+S.length+' sessions · '+
      S.filter((s)=>s.kind==='e2b').length+' e2b, '+S.filter((s)=>s.kind==='local').length+' local</td>'+
    '<td class="num">—</td><td class="num">'+tot((s)=>s.turns)+'</td>'+
    '<td class="num">'+k(tot((s)=>s.tokens.total))+'</td><td class="num">'+usd(tot((s)=>s.cost))+'</td><td></td></tr></tfoot></table>'+
    (open&&view[sel]?'<div class="scrim" id="scrim"><div class="sheet">'+
      '<button class="x" id="close" title="close (esc)">×</button>'+
      '<span class="nav">'+(sel+1)+' / '+view.length+' · ↑↓</span>'+
      panel(view[sel])+'</div></div>':'')+
    '<div class="foot">refreshes every 5s · click a row for its context window · ↑↓ to move · click a column to sort'+
      (sortKey!=='start'?' · sorted by '+COL[sortKey][1].toLowerCase()+', '+(sortDir<0?'high to low':'low to high'):'')+'</div>';

  window.scrollTo(0,y);
  wireBar();
  for(const th of document.querySelectorAll('thead th')){
    th.onclick=()=>{
      const k=th.dataset.k, keep=shown[sel]?shown[sel].ref:null;
      if(sortKey===k) sortDir=-sortDir;
      else {sortKey=k; sortDir=COL[k][2]?-1:1}   // numbers start big, text starts at A
      draw();
      if(keep){const i=shown.findIndex((s)=>s.ref===keep); if(i>=0){sel=i;draw()}}
    };
  }
  for(const tr of document.querySelectorAll('tbody tr'))
    tr.onclick=()=>{sel=+tr.dataset.i;open=true;draw()};
  const scrim=document.getElementById('scrim');
  if(scrim) scrim.onclick=(e)=>{if(e.target===scrim){open=false;draw()}};
  const x=document.getElementById('close');
  if(x) x.onclick=()=>{open=false;draw()};
}

function wireBar(){
  for(const b of document.querySelectorAll('.win')){
    b.onclick=()=>{
      if(b.dataset.s!==undefined) src=b.dataset.s;
      else since=b.dataset.w?+b.dataset.w:null;
      sel=0; tick();
    };
  }
}

document.addEventListener('keydown',(e)=>{
  if(!DATA||!DATA.sessions.length)return;
  if(e.key==='Escape'&&open){open=false;draw();e.preventDefault();return}
  if(e.key==='ArrowDown'){sel=Math.min(shown.length-1,sel+1);draw();e.preventDefault()}
  if(e.key==='ArrowUp'){sel=Math.max(0,sel-1);draw();e.preventDefault()}
  if((e.key==='Enter'||e.key===' ')&&!open){open=true;draw();e.preventDefault()}
});

let first=true;
async function tick(){
  if(busy) return;
  busy=true;
  try{
    const q=first?'':'?since='+(since==null?'all':since)+'&src='+src;
    const r=await fetch('/data'+q,{cache:'no-store'});
    const d=await r.json();
    const keep=shown[sel]?shown[sel].ref:null;      // hold the selection across refreshes
    if(first){since=d.sinceMs===undefined?since:d.sinceMs;first=false}
    DATA=d; draw();
    if(keep){
      const i=shown.findIndex((s)=>s.ref===keep);
      if(i>=0&&i!==sel){sel=i;draw()}
    }
  }catch(e){}
  finally{busy=false}
}
tick(); setInterval(tick,5000);
</script></body></html>`

export function startSessionsUi(ROOT, { port = 8793, open = true, sinceMs = DEFAULT_SINCE_MS,
                                        sources = ['e2b', 'local'] } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/data')) {
      const q = new URL(req.url, 'http://x').searchParams
      const since = q.has('since') ? (q.get('since') === 'all' ? null : Number(q.get('since'))) : sinceMs
      const src = q.get('src')
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(sessionsPayload(ROOT, since,
        src === 'e2b' ? ['e2b'] : src === 'local' ? ['local'] : sources)))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  return new Promise((resolve) => {
    server.on('error', () => resolve({ error: `port ${port} busy` }))
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${port}/`
      if (open) {
        const o = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
        try { spawn(o, [url], { detached: true, stdio: 'ignore' }).unref() } catch {}
      }
      resolve({ url, server })
    })
  })
}
