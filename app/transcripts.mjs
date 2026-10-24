/**
 * transcripts.mjs — the Claude Code sessions that ran on this machine.
 *
 * `~/.claude/projects/<slug>/<sessionId>.jsonl` is the same record stream the
 * sandbox arms produce, so a local session and an E2B arm can be measured the
 * same way: usage-bearing assistant records give tokens, cost and the context
 * window; `isSidechain` marks subagent traffic.
 *
 * Two things this deliberately does not hide, both borrowed from lenops:
 *
 *   * Sessions with **no usage record at all** are real. A prompt-only shell or
 *     a title-generation fire writes a `user` record and no assistant record —
 *     no model, no tokens, no cost anywhere on disk. Dropping them would
 *     under-report what ran, so they are listed with `—`.
 *
 *   * Cost is **API-list equivalent, not a bill**. Subscription traffic is not
 *     billed per token. It is the right unit for sizing an optimization and the
 *     wrong unit for reading as money owed.
 *
 * The store is pruned on `cleanupPeriodDays` (default 30), so a window reaching
 * past the oldest surviving transcript is truncated by deletion, not by silence.
 * `oldestOnDisk` reports where that boundary is.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects')

// API list rates, $/Mtok in/out — the same table lenops prices with.
const PRICE = {
  'claude-opus-5': [5, 25], 'claude-opus-4-8': [5, 25], 'claude-opus-4-1': [15, 75],
  'claude-sonnet-5': [2, 10], 'claude-sonnet-4-5': [3, 15],
  'claude-haiku-4-5-20251001': [1, 5], 'claude-haiku-4-5': [1, 5],
}
const DEFAULT_MODEL = 'claude-opus-5'
const W5 = 1.25, W1H = 2.0, READ = 0.1
const WRITERS = /^(Write|Edit|MultiEdit|NotebookEdit)$/

/**
 * What a call should be counted as. `Skill` on its own says nothing — the
 * interesting fact is *which* skill ran, so the name comes along.
 */
export function toolKey(c) {
  if (c.name === 'Skill' && c.input?.skill) return `Skill:${c.input.skill}`
  if (c.name === 'Task' && c.input?.subagent_type) return `Task:${c.input.subagent_type}`
  return c.name
}

/** API-list-equivalent cost of one request. */
function requestCost(model, u) {
  const [inp, out] = PRICE[model] ?? PRICE[DEFAULT_MODEL]
  const cc = u.cache_creation ?? {}
  let w1h = cc.ephemeral_1h_input_tokens ?? 0
  let w5m = cc.ephemeral_5m_input_tokens ?? 0
  if (!w1h && !w5m) w1h = u.cache_creation_input_tokens ?? 0   // older records carry no breakdown
  return ((u.cache_read_input_tokens ?? 0) * inp * READ
        + w1h * inp * W1H + w5m * inp * W5
        + (u.input_tokens ?? 0) * inp
        + (u.output_tokens ?? 0) * out) / 1e6
}

/** First real thing the user typed — not a slash-command envelope or a harness caveat. */
function userText(rec) {
  let c = rec.message?.content
  if (Array.isArray(c)) c = c.filter((p) => p?.type === 'text' || typeof p?.text === 'string')
                             .map((p) => p.text ?? '').join(' ')
  if (typeof c !== 'string') return null
  const t = c.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ').replace(/<[^>]+>/g, ' ').trim()
  if (!t || /^(Caveat:|\[Request interrupted)/.test(t)) return null
  return t.split(/\s+/).join(' ').slice(0, 400)
}

// Parsing 50MB of JSONL on every UI refresh would be absurd; a file only needs
// re-reading when it actually changed.
const CACHE = new Map()   // path -> { mtimeMs, size, records }

function readFileRecords(file) {
  const st = fs.statSync(file)
  const hit = CACHE.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.records
  const records = []
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    let r; try { r = JSON.parse(line) } catch { continue }
    if (!r.timestamp) continue
    // keep only what a session row needs, so the cache stays small
    const keep = {
      t: Date.parse(r.timestamp), type: r.type, sid: r.sessionId ?? r.session_id ?? null,
      cwd: r.cwd ?? null, entry: r.entrypoint ?? null, side: !!r.isSidechain,
      version: r.version ?? null, branch: r.gitBranch ?? null,
    }
    if (!Number.isFinite(keep.t)) continue
    if (r.type === 'user' && !r.isSidechain) keep.text = userText(r)
    if (r.type === 'assistant') {
      const u = r.message?.usage
      if (u) {
        keep.model = r.message?.model ?? null
        keep.u = {
          input: u.input_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          thinking: u.output_tokens_details?.thinking_tokens ?? 0,
          cost: requestCost(r.message?.model ?? DEFAULT_MODEL, u),
        }
      }
      const tools = (r.message?.content ?? []).filter((c) => c?.type === 'tool_use')
      if (tools.length) {
        // a subagent's tool calls are its own work, but they are still this
        // session's spend, so they are counted and marked rather than dropped
        keep.tools = tools.map(toolKey)
        keep.wrote = tools.filter((c) => WRITERS.test(c.name))
                          .map((c) => c.input?.file_path ?? c.input?.notebook_path)
                          .filter(Boolean)
      }
    }
    records.push(keep)
  }
  CACHE.set(file, { mtimeMs: st.mtimeMs, size: st.size, records })
  return records
}

function listTranscripts(root) {
  const out = []
  let dirs
  try { dirs = fs.readdirSync(root) } catch { return out }
  for (const d of dirs) {
    const dir = path.join(root, d)
    let entries
    try { if (!fs.statSync(dir).isDirectory()) continue; entries = fs.readdirSync(dir) } catch { continue }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue
      const p = path.join(dir, f)
      try { out.push({ path: p, mtimeMs: fs.statSync(p).mtimeMs }) } catch {}
    }
  }
  return out
}

/** Timestamp of the oldest record still on disk — the retention floor. */
export function oldestOnDisk(root = PROJECTS_ROOT) {
  let best = null
  for (const { path: p } of listTranscripts(root)) {
    const first = readFileRecords(p)[0]?.t ?? null
    if (first != null) best = best == null ? first : Math.min(best, first)
  }
  return best
}

/**
 * Local sessions whose activity falls inside the window, newest first.
 * `sinceMs` null means everything on disk.
 */
export function collectLocalSessions({ sinceMs = null, root = PROJECTS_ROOT, now = Date.now() } = {}) {
  const cutoff = sinceMs == null ? -Infinity : now - sinceMs
  const byId = new Map()

  for (const { path: file, mtimeMs } of listTranscripts(root)) {
    // a file last written before the cutoff cannot hold a record inside it
    if (mtimeMs < cutoff) continue
    for (const r of readFileRecords(file)) {
      if (r.t < cutoff) continue
      const sid = r.sid ?? path.basename(file, '.jsonl')
      let s = byId.get(sid)
      if (!s) {
        s = { sid, file, cwd: r.cwd, entry: r.entry, start: r.t, end: r.t,
              requests: 0, cost: 0, models: new Map(), intent: null, prompts: [], wrote: new Set(),
              tools: 0, toolCounts: new Map(), sideTools: 0,
              sideRequests: 0, sideTokens: 0, version: r.version, branch: r.branch,
              tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 },
              series: [] }
        byId.set(sid, s)
      }
      if (r.cwd) s.cwd = s.cwd ?? r.cwd
      if (r.version) s.version = r.version
      s.start = Math.min(s.start, r.t)
      s.end = Math.max(s.end, r.t)
      if (r.text) {
        if (!s.intent) s.intent = r.text
        if (s.prompts.length < 40) s.prompts.push({ at: r.t, text: r.text })
      }
      if (r.tools) {
        s.tools += r.tools.length
        if (r.side) s.sideTools += r.tools.length
        for (const name of r.tools) s.toolCounts.set(name, (s.toolCounts.get(name) ?? 0) + 1)
      }
      for (const w of r.wrote ?? []) s.wrote.add(w)
      if (!r.u) continue
      const ctx = r.u.input + r.u.cacheRead + r.u.cacheWrite
      if (r.side) { s.sideRequests++; s.sideTokens += ctx }
      else { s.requests++; if (ctx) s.series.push({ t: ctx, at: r.t }) }
      s.cost += r.u.cost
      s.models.set(r.model, (s.models.get(r.model) ?? 0) + 1)
      for (const k of ['input', 'cacheRead', 'cacheWrite', 'output', 'thinking']) s.tokens[k] += r.u[k]
    }
  }

  return [...byId.values()].sort((a, b) => b.start - a.start)
}
