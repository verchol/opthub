/**
 * Claude Code's own errors and turn latency, read from the transcripts (~/.claude/projects).
 *
 *   API errors       system api_error entries: a request failed and Claude Code retried (status code kept)
 *   shown to you     assistant messages flagged isApiErrorMessage: the retries ran out, the turn stopped
 *   tool errors      tool_result blocks with is_error, by tool name
 *   interrupts       "[Request interrupted by user]"
 *   hook errors      stop_hook_summary entries that carry hookErrors
 *   turn latency     system turn_duration entries: how long Claude took to answer each prompt
 *
 * Only counts, codes, tool names and durations are kept — never message text. Each file's summary
 * is cached by size and mtime, so the hub re-reads only transcripts that changed.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROJ = process.env.OPT_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects')
const CACHE = new Map()   // file -> { key, summary }

/** The status code or kind of one API error, from its message only. */
export function errorKind(msg) {
  const m = String(msg ?? '')
  const code = /\b(4\d\d|5\d\d)\b/.exec(m)?.[1]
  if (/credit balance/i.test(m)) return 'credit'
  if (/login expired|oauth|authentication|authenticate|401/i.test(m)) return '401 auth'
  if (/went to sleep/i.test(m)) return 'machine slept'
  if (/hit your .*limit|usage limit/i.test(m)) return 'usage limit'
  if (code === '429' || /rate.?limit/i.test(m)) return '429 rate limit'
  if (code === '529' || /overloaded/i.test(m)) return '529 overloaded'
  if (/prompt is too long|context/i.test(m) && /long|limit|window/i.test(m)) return 'context too long'
  if (/timeout|timed out|ETIMEDOUT/i.test(m)) return 'timeout'
  if (/ECONNRESET|ECONNREFUSED|socket|network|fetch failed|connection error/i.test(m)) return 'network'
  if (code) return code.startsWith('5') ? '5xx server' : code
  return 'other'
}

/** One transcript → counts. */
export function scanTranscript(text) {
  const s = { apiErrors: {}, shown: {}, toolErrors: {}, toolCalls: 0, interrupts: 0, hookErrors: 0, compactions: 0, turnMs: [], first: null, last: null }
  const toolName = {}
  for (const line of text.split('\n')) {
    if (!line) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    if (e.timestamp) { s.first ??= e.timestamp; s.last = e.timestamp }
    if (e.type === 'system') {
      if (e.subtype === 'api_error') { const k = errorKind(e.error?.message ?? e.content); s.apiErrors[k] = (s.apiErrors[k] ?? 0) + 1 }
      else if (e.subtype === 'turn_duration' && e.durationMs > 0) s.turnMs.push(e.durationMs)
      else if (e.subtype === 'stop_hook_summary' && e.hookErrors?.length) s.hookErrors += e.hookErrors.length
      else if (e.subtype === 'compact_boundary') s.compactions++
      continue
    }
    const content = e.message?.content
    if (e.type === 'assistant') {
      if (e.isApiErrorMessage) { const t = Array.isArray(content) ? content.map((b) => b.text ?? '').join(' ') : content; const k = errorKind(t); s.shown[k] = (s.shown[k] ?? 0) + 1 }
      if (Array.isArray(content)) for (const b of content) if (b?.type === 'tool_use') { toolName[b.id] = b.name; s.toolCalls++ }
    } else if (e.type === 'user') {
      if (typeof content === 'string') { if (content.startsWith('[Request interrupted')) s.interrupts++; continue }
      for (const b of content ?? []) {
        if (b?.type === 'tool_result' && b.is_error) { const n = toolName[b.tool_use_id] ?? 'unknown'; s.toolErrors[n] = (s.toolErrors[n] ?? 0) + 1 }
        if (b?.type === 'text' && b.text?.startsWith('[Request interrupted')) s.interrupts++
      }
    }
  }
  return s
}

function files(sinceMs) {
  const out = []
  const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) out.push(p) } }
  walk(PROJ)
  return out.map((f) => { try { return { f, st: fs.statSync(f) } } catch { return null } }).filter((x) => x && x.st.mtimeMs >= sinceMs)
}

/** Every session touched since `sinceMs`, by session id (the transcript's file name). */
export function sessionErrors(sinceMs) {
  const out = {}
  for (const { f, st } of files(sinceMs)) {
    const key = `${st.size}:${st.mtimeMs}`
    let c = CACHE.get(f)
    if (!c || c.key !== key) { let text = ''; try { text = fs.readFileSync(f, 'utf8') } catch { continue } c = { key, summary: scanTranscript(text) }; CACHE.set(f, c) }
    out[path.basename(f, '.jsonl')] = c.summary
  }
  return out
}

const add = (into, from) => { for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v; return into }
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0)

/** Totals across sessions, the sessions with most errors, and each session's turn-latency p95. */
export function errorsSummary(bySid) {
  const t = { apiErrors: {}, shown: {}, toolErrors: {}, toolCalls: 0, interrupts: 0, hookErrors: 0, compactions: 0, sessions: 0, withErrors: 0 }
  const perSession = []
  for (const [sid, s] of Object.entries(bySid)) {
    t.sessions++
    add(t.apiErrors, s.apiErrors); add(t.shown, s.shown); add(t.toolErrors, s.toolErrors)
    t.toolCalls += s.toolCalls; t.interrupts += s.interrupts; t.hookErrors += s.hookErrors; t.compactions += s.compactions
    const n = sum(s.apiErrors) + sum(s.shown) + sum(s.toolErrors)
    if (n) t.withErrors++
    perSession.push({ sid, api: sum(s.apiErrors), shown: sum(s.shown), tool: sum(s.toolErrors), interrupts: s.interrupts, total: n })
  }
  t.api = sum(t.apiErrors); t.shownTotal = sum(t.shown); t.tool = sum(t.toolErrors)
  t.toolErrorRate = t.toolCalls ? t.tool / t.toolCalls : 0
  t.topTools = Object.entries(t.toolErrors).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, n]) => ({ name, n }))
  t.worst = perSession.filter((x) => x.total).sort((a, b) => b.total - a.total).slice(0, 5)
  return t
}

/** Nearest-rank percentile. */
export const pctl = (xs, p) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))] : null }
