/**
 * Analytics → Behaviour: how Claude Code sessions actually run, turn by turn.
 *
 * Two sources describe the same thing — a session as a list of turns, each turn a list of model
 * calls and tool calls — and both are read into one shape:
 *
 *   LangSmith  the langsmith-tracing plugin's traces (cloud, or self-hosted via LANGSMITH_ENDPOINT):
 *              root run "Claude Code Turn" per prompt, llm / tool runs under it, thread_id = session id
 *   OTEL       Claude Code's own spans, stored locally by the opt collector (lib/otel.mjs):
 *              claude_code.interaction > llm_request / tool > tool.blocked_on_user
 *
 * A session found in both is read from OTEL, which also knows permission waits and time to first
 * token. Only names, times, token counts and statuses are read: never prompts or tool inputs.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readOtel } from './otel.mjs'
import { priceFor } from './atlas.mjs'

const CLOUD = 'https://api.smith.langchain.com'
// Claude's prompt cache lives 5 minutes from its last use; a turn after a longer gap re-writes it
export const CACHE_TTL_MS = 5 * 60e3
// a gap past this is the person away, not reading: it counts as a break, not as idle time in the session
export const AWAY_MS = 30 * 60e3
// tools whose whole run is Claude waiting on the person
const ASKS = /^(AskUserQuestion|ExitPlanMode)$/

/** Claude Code's user settings env block: where the plugin's project and endpoint are set. */
export function claudeSettingsPath() {
  return process.env.OPT_CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json')
}
export function readClaudeSettings() {
  try { return JSON.parse(fs.readFileSync(claudeSettingsPath(), 'utf8')) } catch { return {} }
}

/** Where the plugin sends traces, and the key to read them back with. The key never leaves the server. */
export function langsmithConfig() {
  const env = readClaudeSettings().env ?? {}
  const pick = (...ks) => { for (const k of ks) { const v = process.env[k] || env[k]; if (v) return v } return '' }
  return {
    endpoint: pick('LANGSMITH_ENDPOINT').replace(/\/+$/, '') || CLOUD,
    project: pick('CC_LANGSMITH_PROJECT') || 'claude-code',
    key: pick('CC_LANGSMITH_API_KEY', 'LANGSMITH_API_KEY', 'LANGCHAIN_API_KEY'),
    tracing: String(env.TRACE_TO_LANGSMITH ?? process.env.TRACE_TO_LANGSMITH ?? '') === 'true',
  }
}

async function ls(cfg, method, p, body) {
  const res = await fetch(cfg.endpoint + p, {
    method, headers: { 'x-api-key': cfg.key, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`LangSmith ${p} → ${res.status} ${(await res.text()).slice(0, 120)}`)
  return res.json()
}

/** The project's id and when it last received a run, or null when it does not exist. */
export async function langsmithProject(cfg = langsmithConfig()) {
  const d = await ls(cfg, 'GET', `/api/v1/sessions?name=${encodeURIComponent(cfg.project)}&limit=1`)
  const p = (Array.isArray(d) ? d : [d]).find((x) => x?.name === cfg.project)
  return p ? { id: p.id, last: p.last_run_start_time ?? null } : null
}

// v2 returns no cost on these runs, so turns are priced from each model call's usage
const SELECTS = ['ID', 'NAME', 'RUN_TYPE', 'START_TIME', 'END_TIME', 'THREAD_ID', 'TRACE_ID', 'PARENT_RUN_IDS',
                 'STATUS', 'ERROR', 'IS_ROOT', 'METADATA']
const t = (s) => (s ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z') : null)

/** Every run in the window, paged (v2 query: 1000 a page, 300 requests / 10 s). */
async function langsmithRuns(cfg, projectId, sinceMs, maxPages = 25) {
  const runs = []
  let cursor = null
  for (let i = 0; i < maxPages; i++) {
    const d = await ls(cfg, 'POST', '/api/v2/runs/query', {
      project_ids: [projectId], min_start_time: new Date(sinceMs).toISOString(), page_size: 1000, selects: SELECTS,
      ...(cursor ? { cursor } : {}),
    })
    runs.push(...(d.items ?? []))
    cursor = d.next_cursor
    if (!cursor || !(d.items ?? []).length) return { runs, truncated: false }
  }
  return { runs, truncated: true }
}

/** LangSmith runs → turns. Depth 1 under a root is the main thread; deeper is a subagent's. */
export function turnsFromLangsmith(runs) {
  const turns = {}
  for (const r of runs) if (r.is_root && r.name === 'Claude Code Turn') {
    const md = r.metadata ?? {}
    turns[r.id] = {
      sid: r.thread_id || md.thread_id || r.trace_id, start: t(r.start_time), end: t(r.end_time),
      status: r.status === 'error' ? (/interrupt/i.test(r.error ?? '') ? 'interrupt' : 'error') : (r.status ?? (r.end_time ? 'success' : 'pending')),
      project: md.cwd ? path.basename(md.cwd) : String(md.repository_name ?? '').split('/').pop(), cost: 0,
      llm: [], tools: [], subagents: 0, subLlm: 0, src: 'langsmith',
    }
  }
  for (const r of runs) {
    const ps = r.parent_run_ids ?? []
    const turn = turns[ps[0]]
    if (!turn || r.is_root) continue
    const main = ps.length === 1
    if (r.run_type === 'llm') {
      const u = r.metadata?.usage_metadata ?? {}, d = u.input_token_details ?? {}
      const cr = Number(d.cache_read ?? 0), cw = Number(d.cache_creation ?? 0), model = r.metadata?.ls_model_name ?? ''
      // LangChain's input_tokens counts cache reads and writes too
      const inn = Math.max(0, Number(u.input_tokens ?? 0) - cr - cw), out = Number(u.output_tokens ?? 0)
      turn.cost += priced(model, inn, out, cr, cw)
      if (!main) { turn.subLlm++; continue }
      turn.llm.push({ start: t(r.start_time), end: t(r.end_time), model, in: inn, out, cr, cw, ok: r.status !== 'error' })
    } else if (r.run_type === 'tool' && main) {
      turn.tools.push({ name: r.name, start: t(r.start_time), end: t(r.end_time), ok: r.status !== 'error', wait: null })
      if (r.name === 'Agent' || r.name === 'Task') turn.subagents++
    }
  }
  return Object.values(turns)
}

/** Claude Code's own spans (and api_request events, for cost) → turns. */
export function turnsFromOtel(records) {
  const spans = records.filter((r) => r.k === 'span')
  const byId = Object.fromEntries(spans.map((s) => [s.id, s]))
  const costByReq = {}
  for (const r of records) if (r.k === 'log' && r.name === 'claude_code.api_request' && r.a.request_id) costByReq[r.a.request_id] = Number(r.a.cost_usd ?? 0)
  const turns = {}
  for (const s of spans) if (s.name === 'claude_code.interaction')
    turns[s.id] = { sid: s.a['session.id'] ?? s.trace, start: s.t, end: s.end, status: s.err ? 'error' : 'success', project: '',
                    cost: 0, llm: [], tools: [], subagents: 0, subLlm: 0, src: 'otel', ttft: [], retries: 0 }
  const turnOf = (s) => { let p = s; for (let i = 0; p && i < 8; i++) { if (turns[p.id]) return turns[p.id]; p = byId[p.parent] } return null }
  const toolSpans = {}
  for (const s of spans) {
    if (s.name === 'claude_code.interaction') continue
    const turn = turnOf(s); if (!turn) continue
    const sub = !!s.a.agent_id
    if (s.name === 'claude_code.llm_request') {
      const c = costByReq[s.a.request_id]
      const m = s.a.model ?? '', cr = Number(s.a.cache_read_tokens ?? 0), cw = Number(s.a.cache_creation_tokens ?? 0)
      const inn = Number(s.a.input_tokens ?? 0), out = Number(s.a.output_tokens ?? 0)
      turn.cost += c ?? priced(m, inn, out, cr, cw)
      if (Number(s.a.attempt ?? 1) > 1) turn.retries++
      if (sub) { turn.subLlm++; continue }
      turn.llm.push({ start: s.t, end: s.end, model: m, in: inn, out, cr, cw, ok: s.a.success !== false, stop: s.a.stop_reason ?? null })
      if (s.a.ttft_ms != null) turn.ttft.push(Number(s.a.ttft_ms))
    } else if (s.name === 'claude_code.tool' && !sub) {
      const x = { name: s.a.tool_name_safe ?? s.a.tool_name ?? 'tool', start: s.t, end: s.end, ok: !s.err, wait: null, cls: s.a.bash_command_class ?? null }
      toolSpans[s.id] = x; turn.tools.push(x)
      if (/^(Agent|Task)$/.test(x.name)) turn.subagents++
    }
  }
  for (const s of spans) {
    const x = toolSpans[s.parent]; if (!x) continue
    if (s.name === 'claude_code.tool.blocked_on_user') { x.wait = Number(s.a.duration_ms ?? (s.end - s.t)); x.decision = s.a.decision; x.source = s.a.source }
    if (s.name === 'claude_code.tool.execution' && s.a.success === false) x.ok = false
  }
  return Object.values(turns)
}

function priced(model, inn, out, cr, cw) {
  const p = priceFor(model) ?? { in: 3, out: 15 }
  return (inn * p.in + cw * p.in * 1.25 + cr * p.in * 0.1 + out * p.out) / 1e6
}

// ---------------------------------------------------------------- numbers
const sum = (a) => a.reduce((x, y) => x + y, 0)
export function q(a, p) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }
/** Total length of the union of [start, end) intervals: parallel tool calls are not counted twice. */
export function union(iv) {
  const s = iv.filter(([a, b]) => a != null && b != null && b > a).sort((x, y) => x[0] - y[0])
  let tot = 0, cs = null, ce = null
  for (const [a, b] of s) { if (ce == null || a > ce) { if (ce != null) tot += ce - cs; cs = a; ce = b } else if (b > ce) ce = b }
  return ce != null ? tot + ce - cs : 0
}
export const GAP_BUCKETS = [[10e3, '<10s'], [30e3, '10–30s'], [60e3, '30s–1m'], [120e3, '1–2m'], [300e3, '2–5m'], [900e3, '5–15m'],
                            [1800e3, '15–30m'], [3600e3, '30–60m'], [4 * 3600e3, '1–4h'], [Infinity, '>4h']]

/**
 * One session's turns (sorted) → its behaviour. A gap is the time from one turn's end to the next
 * turn's start: the person reading, thinking, or away. A cold turn is one whose first model call
 * wrote more prompt cache than it read; after a gap past the cache's 5-minute life that re-write is
 * what the idle time cost, priced at list rates (write 1.25x input against a read at 0.1x).
 */
export function sessionBehaviour(turns, now = Date.now()) {
  turns.sort((a, b) => a.start - b.start)
  const gaps = [], cold = []
  let coldCost = 0, coldAfterIdle = 0
  turns.forEach((tn, i) => {
    tn.gap = null
    if (i > 0) { const pe = turns[i - 1].end ?? turns[i - 1].start; tn.gap = Math.max(0, tn.start - pe); gaps.push(tn.gap) }
    const first = [...tn.llm].sort((a, b) => a.start - b.start)[0]
    tn.cold = !!(i > 0 && first && first.cw > first.cr)
    if (tn.cold) {
      const p = priceFor(first.model)?.in ?? 3
      const extra = first.cw * p * (1.25 - 0.1) / 1e6
      tn.coldCost = extra; coldCost += extra; cold.push(i)
      if (tn.gap != null && tn.gap > CACHE_TTL_MS) coldAfterIdle++
    }
    tn.dur = tn.end != null ? tn.end - tn.start : null
    tn.llmMs = union(tn.llm.map((c) => [c.start, c.end]))
    tn.toolMs = union(tn.tools.map((c) => [c.start, c.end]))
  })
  const first = turns[0], last = turns[turns.length - 1]
  const wall = Math.max(0, (last.end ?? last.start) - first.start)
  const busy = sum(turns.map((x) => x.dur ?? 0))
  const idle = sum(gaps.filter((g) => g < AWAY_MS)), away = sum(gaps.filter((g) => g >= AWAY_MS))
  const tools = turns.flatMap((x) => x.tools), llm = turns.flatMap((x) => x.llm)
  const tok = (k) => sum(llm.map((c) => c[k]))
  const models = {}; for (const c of llm) models[c.model] = (models[c.model] ?? 0) + 1
  // Claude waiting on the person inside a turn: permission prompts (OTEL) and questions it asked
  const waits = tools.map((x) => (x.wait > 0 ? x.wait : ASKS.test(x.name) && x.end != null ? x.end - x.start : null)).filter((x) => x > 0)
  return {
    sid: first.sid, project: turns.find((x) => x.project)?.project ?? '', src: first.src,
    start: first.start, end: last.end ?? last.start, open: last.end == null && now - last.start < 3600e3,
    turns: turns.length, wall, busy, idle, away, breaks: gaps.filter((g) => g >= AWAY_MS).length,
    idleShare: busy + idle ? idle / (busy + idle) : 0,
    medGap: q(gaps.filter((g) => g < AWAY_MS), 0.5), longestGap: gaps.length ? Math.max(...gaps) : 0,
    cold: cold.length, coldAfterIdle, coldCost,
    llmMs: sum(turns.map((x) => x.llmMs)), toolMs: sum(turns.map((x) => x.toolMs)),
    cost: sum(turns.map((x) => x.cost ?? 0)),
    llmCalls: llm.length, toolCalls: tools.length, toolErrors: tools.filter((x) => !x.ok).length,
    subagents: sum(turns.map((x) => x.subagents)), subLlm: sum(turns.map((x) => x.subLlm)),
    interrupts: turns.filter((x) => x.status === 'interrupt').length,
    errors: turns.filter((x) => x.status === 'error').length,
    abandoned: turns.filter((x) => x.end == null && now - x.start > 3600e3).length,
    waitMs: sum(waits), waits: waits.length,
    cacheHit: tok('cr') / Math.max(1, tok('cr') + tok('cw') + tok('in')),
    model: Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '',
    // one row per turn for the session strip: start, end, cold, cost, tool calls, model calls, interrupted
    strip: turns.map((x) => [x.start, x.end, x.cold ? 1 : 0, Math.round((x.cost ?? 0) * 1e4) / 1e4, x.tools.length, x.llm.length, x.status === 'interrupt' ? 1 : 0]),
    gaps, durs: turns.map((x) => x.dur).filter((x) => x != null),
  }
}

/** Every session in the window, plus the cross-session numbers the page charts. */
export function behaviour(turns, { otel = [], project = '', projectOf = null, now = Date.now() } = {}) {
  const bySid = {}
  for (const tn of turns) {
    if (!tn.project && projectOf) tn.project = projectOf(tn.sid) ?? ''
    ;(bySid[tn.sid] ??= []).push(tn)
  }
  let sessions = Object.values(bySid).map((ts) => sessionBehaviour(ts, now))
  if (project) sessions = sessions.filter((s) => s.project === project)
  const keep = new Set(sessions.map((s) => s.sid))
  const all = turns.filter((x) => keep.has(x.sid))

  const gaps = sessions.flatMap((s) => s.gaps), durs = sessions.flatMap((s) => s.durs)
  const gapHist = GAP_BUCKETS.map(([hi, label], i) => ({ label, hi, n: gaps.filter((g) => g < hi && g >= (i ? GAP_BUCKETS[i - 1][0] : 0)).length,
    cold: all.filter((x) => x.cold && x.gap != null && x.gap < hi && x.gap >= (i ? GAP_BUCKETS[i - 1][0] : 0)).length }))

  const tools = {}
  for (const tn of all) for (const c of tn.tools) {
    const r = (tools[c.name] ??= { name: c.name, calls: 0, errors: 0, d: [], waits: [] })
    r.calls++; if (!c.ok) r.errors++
    if (c.end != null && c.start != null) r.d.push(c.end - c.start)
    const w = c.wait > 0 ? c.wait : ASKS.test(c.name) && c.end != null ? c.end - c.start : 0
    if (w > 0) r.waits.push(w)
  }
  const toolRows = Object.values(tools).map((r) => ({ name: r.name, calls: r.calls, errors: r.errors, p50: q(r.d, 0.5), p95: q(r.d, 0.95),
    total: sum(r.d), wait: sum(r.waits), waits: r.waits.length })).sort((a, b) => b.total - a.total)

  // weekday × hour of busy minutes, in the server's (the user's) local time
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0))
  for (const tn of all) if (tn.dur) { const d = new Date(tn.start); heat[(d.getDay() + 6) % 7][d.getHours()] += tn.dur / 60e3 }

  const S = (k) => sum(sessions.map((s) => s[k]))
  const ttft = all.flatMap((x) => x.ttft ?? [])
  const out = {
    kpi: {
      sessions: sessions.length, turns: S('turns'), wall: S('wall'), busy: S('busy'), idle: S('idle'), away: S('away'), breaks: S('breaks'),
      idleShare: S('busy') + S('idle') ? S('idle') / (S('busy') + S('idle')) : 0,
      medGap: q(gaps.filter((g) => g < AWAY_MS), 0.5), p50Turn: q(durs, 0.5), p90Turn: q(durs, 0.9),
      llmMs: S('llmMs'), toolMs: S('toolMs'), cost: S('cost'), cold: S('cold'), coldAfterIdle: S('coldAfterIdle'), coldCost: S('coldCost'),
      toolCalls: S('toolCalls'), toolErrors: S('toolErrors'), llmCalls: S('llmCalls'), subagents: S('subagents'),
      interrupts: S('interrupts'), errors: S('errors'), abandoned: S('abandoned'), waitMs: S('waitMs'), waits: S('waits'),
      cacheHit: (() => { const l = all.flatMap((x) => x.llm); const cr = sum(l.map((c) => c.cr)); return cr / Math.max(1, cr + sum(l.map((c) => c.cw + c.in))) })(),
      ttftP50: q(ttft, 0.5), retries: sum(all.map((x) => x.retries ?? 0)),
    },
    sessions: sessions.map(({ gaps: _g, durs: _d, ...s }) => s).sort((a, b) => b.start - a.start),
    gapHist, tools: toolRows, heat,
    projects: [...new Set(Object.values(bySid).map((ts) => ts.find((x) => x.project)?.project).filter(Boolean))].sort(),
  }
  if (otel.length) out.otel = otelSummary(otel, keep)
  return out
}

/** What only Claude Code's own telemetry knows: active time, permission decisions, API errors, compactions. */
export function otelSummary(records, keep = null) {
  const inS = (r) => !keep || !r.a?.['session.id'] || keep.has(r.a['session.id'])
  const m = (name, by) => { const o = {}; for (const r of records) if (r.k === 'metric' && r.name === name && inS(r)) { const k = by ? r.a[by] ?? '?' : 'all'; o[k] = (o[k] ?? 0) + r.v } return o }
  const ev = (name) => records.filter((r) => r.k === 'log' && r.name === name && inS(r))
  const count = (list, k) => { const o = {}; for (const r of list) { const v = String(r.a[k] ?? '?'); o[v] = (o[v] ?? 0) + 1 } return o }
  const decisions = ev('claude_code.tool_decision')
  return {
    activeTime: m('claude_code.active_time.total', 'type'),          // seconds: user (typing) vs cli (Claude working)
    lines: m('claude_code.lines_of_code.count', 'type'),
    commits: m('claude_code.commit.count').all ?? 0, prs: m('claude_code.pull_request.count').all ?? 0,
    editDecisions: m('claude_code.code_edit_tool.decision', 'decision'),
    decisionSources: count(decisions, 'source'), decisions: count(decisions, 'decision'),
    apiErrors: count(ev('claude_code.api_error'), 'status_code'), retriesExhausted: ev('claude_code.api_retries_exhausted').length,
    compactions: ev('claude_code.compaction').length, subagentsDone: ev('claude_code.subagent_completed').length,
    skills: count(ev('claude_code.skill_activated'), 'skill.name'),
    modeChanges: count(ev('claude_code.permission_mode_changed'), 'to_mode'),
    records: records.length, last: records.length ? Math.max(...records.map((r) => r.t ?? 0)) : null,
  }
}

// ---------------------------------------------------------------- the hub's endpoint
const CACHE = {}
/**
 * /api/behaviour: turns from both sources for the last `days`, cached a minute per window so the
 * page's polling never reaches LangSmith's rate limit.
 */
export async function behaviourPayload({ days = 7, project = '', source = 'auto', projectOf = null } = {}) {
  const now = Date.now(), sinceMs = now - days * 864e5
  const key = `${days}|${source}`
  let c = CACHE[key]
  if (!c || now - c.at > 60e3) {
    const cfg = langsmithConfig()
    const info = { langsmith: { endpoint: cfg.endpoint, project: cfg.project, key: !!cfg.key, tracing: cfg.tracing, ok: false }, otel: {} }
    let lsTurns = []
    if (source !== 'otel' && cfg.key) {
      try {
        const p = await langsmithProject(cfg)
        if (!p) info.langsmith.error = `no project "${cfg.project}" yet`
        else {
          const { runs, truncated } = await langsmithRuns(cfg, p.id, sinceMs)
          lsTurns = turnsFromLangsmith(runs)
          Object.assign(info.langsmith, { ok: true, runs: runs.length, truncated, last: t(p.last) })
        }
      } catch (e) { info.langsmith.error = String(e?.message ?? e).slice(0, 200) }
    } else if (!cfg.key) info.langsmith.error = 'no LANGSMITH_API_KEY'
    const otel = source !== 'langsmith' ? readOtel({ sinceMs }) : []
    const otTurns = turnsFromOtel(otel)
    info.otel = { records: otel.length, spans: otel.filter((r) => r.k === 'span').length, last: otel.length ? Math.max(...otel.map((r) => r.t ?? 0)) : null }
    // a session OTEL traced is read from OTEL; LangSmith fills in the rest
    const otSids = new Set(otTurns.map((x) => x.sid))
    c = CACHE[key] = { at: now, info, otel, turns: [...otTurns, ...lsTurns.filter((x) => !otSids.has(x.sid))] }
  }
  // sessionBehaviour annotates turns in place; give it fresh copies so cached ones stay clean
  const turns = c.turns.map((x) => ({ ...x }))
  return { days, project, at: c.at, sources: c.info, cacheTtlMs: CACHE_TTL_MS, ...behaviour(turns, { otel: c.otel, project, projectOf, now }) }
}
