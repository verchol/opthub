/**
 * Turn Claude Code transcripts (+ this harness's own runs) into simple session
 * records: the fields that classify a session and let it be compared.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// OPT_PROJECTS_DIR points every reader at another transcript store, e.g. a demo with only demo sessions
const PROJ = process.env.OPT_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects')
// API list prices $/1M tok, per exact model, from the Optimization Atlas (lib/atlas.mjs) — the table
// that used to live here priced every Opus at $15/$75 and Fable at $3/$15, so Opus 5 sessions
// showed three times their cost. Cache reads bill 0.1x input, writes 1.25x.
import { priceFor } from './atlas.mjs'
const tier = (m = '') => /opus/i.test(m) ? 'opus' : /sonnet/i.test(m) ? 'sonnet' : /haiku/i.test(m) ? 'haiku' : /fable/i.test(m) ? 'fable' : 'other'
const SECRET = /sk-ant-(api03|oat01)-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY/
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name)
    if (f.isDirectory()) walk(p, out)
    else if (f.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

/** Classify what kind of work a session did, from its intent + tools. */
function classify(intent, tools, artifacts) {
  const i = intent.toLowerCase()
  const t = new Set(tools)
  let kind = 'other'
  if (/refactor|implement|fix|add |build |create .*\.(py|js|ts)|write a function/.test(i)) kind = 'code'
  else if (/pitch|landscape|strategy|document|memo|report|story|write (a|the)/.test(i)) kind = 'doc'
  else if (/debug|why|error|failing|broken|trace/.test(i)) kind = 'debug'
  else if (/summar|explain|read|check|find|what |which |list /.test(i)) kind = 'explore'
  if (kind === 'other' && (t.has('Edit') || t.has('Write'))) kind = 'code'
  return kind
}

export function processTranscript(file, { withSeries = false } = {}) {
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch { return null }
  let intent = '', model = '', cwd = '', firstTs = null, lastTs = null
  let cost = 0, turns = 0, out = 0, inTok = 0, secrets = false
  let cacheRead = 0, cacheWrite = 0, freshIn = 0, thinking = 0
  let compactions = 0, prevWin = 0
  // who drove the session: 'cli' is a person at a terminal, 'sdk-cli' a script; humanPrompts counts typed turns
  let entry = '', humanPrompts = 0
  // Context size at each request is what the model was handed that turn:
  // fresh input + everything served from or written to the prompt cache.
  const ctx = []
  const toolSeries = []            // one entry per assistant turn: tool used (or '')
  const series = []                // per-turn detail, only when asked for
  const toolCounts = {}
  const artifacts = new Map()      // filename -> bytes written
  if (SECRET.test(raw)) secrets = true

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    if (e.cwd && !cwd) cwd = e.cwd
    const ts = e.timestamp ? Date.parse(e.timestamp) : null
    if (ts) { firstTs ??= ts; lastTs = ts }
    if (e.entrypoint && !entry) entry = e.entrypoint
    if (e.type === 'user' && !e.isMeta) {
      const c = e.message?.content
      if (typeof c === 'string' ? !c.startsWith('<') : Array.isArray(c) && c.some((x) => x.type === 'text' && !String(x.text).startsWith('<'))) humanPrompts++
    }
    if (e.type === 'user' && !intent) {
      const c = e.message?.content
      const txt = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b.type === 'text')?.text ?? '') : ''
      if (txt && !txt.startsWith('<')) intent = clean(txt).slice(0, 200)
    }
    if (e.type === 'assistant') {
      turns++
      const m = e.message?.model; if (m) model = m
      const u = e.message?.usage
      if (u) {
        const p = priceFor(m)
        cost += (((u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1) * p.in + (u.output_tokens ?? 0) * p.out) / 1e6
        out += u.output_tokens ?? 0
        const win = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
        inTok += win
        if (win > 0) ctx.push(win)
        freshIn += u.input_tokens ?? 0
        cacheRead += u.cache_read_input_tokens ?? 0
        cacheWrite += u.cache_creation_input_tokens ?? 0
        // the field is output_tokens_details.thinking_tokens, not reasoning_tokens
        const th = u.output_tokens_details?.thinking_tokens ?? 0
        thinking += th
        // a large drop in carried context between requests is a compaction (or a
        // resumed session starting a fresh window) — countable without the series
        if (prevWin && win > 0 && win < prevWin * 0.7) compactions++
        if (win > 0) prevWin = win
        if (withSeries) series.push({
          // cost is the running total at this turn, which is what a cumulative chart wants
          i: turns, ts, ctx: win, costCum: +cost.toFixed(6),
          out: u.output_tokens ?? 0, think: th,
          fresh: u.input_tokens ?? 0,
          cr: u.cache_read_input_tokens ?? 0, cw: u.cache_creation_input_tokens ?? 0,
        })
      }
      let usedTool = ''
      for (const b of e.message?.content ?? []) {
        if (b.type !== 'tool_use') continue
        usedTool = b.name
        toolCounts[b.name] = (toolCounts[b.name] ?? 0) + 1
        if (/^Write$/.test(b.name) && b.input?.file_path)
          artifacts.set(b.input.file_path.split('/').pop(), (b.input.content ?? '').length)
        else if (/^Edit|MultiEdit$/.test(b.name) && b.input?.file_path)
          artifacts.set(b.input.file_path.split('/').pop(), Math.max(artifacts.get(b.input.file_path.split('/').pop()) ?? 0, 1))
      }
      toolSeries.push(usedTool)
    }
  }
  if (!turns) return null
  const arts = [...artifacts.entries()].map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
  const topArtifact = arts[0]?.name ?? null
  const kind = classify(intent, Object.keys(toolCounts), arts)
  const sorted = [...ctx].sort((a, b) => a - b)
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
  return {
    id: path.basename(file, '.jsonl'),
    model: model || 'unknown', modelTier: tier(model),
    intent: intent || '(no prompt)',
    durationMin: firstTs && lastTs ? +((lastTs - firstTs) / 60000).toFixed(1) : 0,
    // when the session was created, which is not the same question as when it
    // last wrote: a resumed session is days old and still going
    startedAt: firstTs ? new Date(firstTs).toISOString() : null,
    endedAt: lastTs ? new Date(lastTs).toISOString() : null,
    cost: +cost.toFixed(4), turns, outTokens: out, inTokens: inTok,
    // context window: what the model actually carried, per request
    ctxPeak: sorted.length ? sorted[sorted.length - 1] : 0,
    ctxMedian: median,
    ctxLast: ctx.length ? ctx[ctx.length - 1] : 0,
    ctxRequests: ctx.length,
    freshInTokens: freshIn, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
    cacheHit: inTok ? +(cacheRead / inTok).toFixed(4) : 0,
    thinkingTokens: thinking,
    compactions,
    toolCalls: Object.values(toolCounts).reduce((a, b) => a + b, 0),
    toolCounts, toolSeries,
    artifacts: arts, topArtifact: topArtifact ?? 'none',
    artifactBytes: arts.reduce((a, x) => a + (x.bytes || 0), 0),
    hasArtifact: arts.length > 0,
    kind, cwd: cwd.replace(os.homedir(), '~'),
    entry: entry || 'unknown', humanPrompts,
    costBucket: cost < 0.5 ? '<$0.5' : cost < 2 ? '$0.5–2' : cost < 8 ? '$2–8' : '$8+',
    live: lastTs ? (Date.now() - lastTs) < 5 * 60 * 1000 : false,   // active in last 5 min
    secrets,
    ...(withSeries ? { series } : {}),
  }
}

/** The transcript file for a session id, or null. */
export function findTranscript(id) {
  if (!/^[0-9a-fA-F-]{6,}$/.test(id)) return null
  return walk(PROJ).find((f) => path.basename(f, '.jsonl').startsWith(id)) ?? null
}

/** One session with its per-turn series — too big to carry in the list payload. */
export function sessionDetail(id) {
  const f = findTranscript(id)
  if (!f) return null
  return processTranscript(f, { withSeries: true })
}

/**
 * Parsed transcripts, keyed by path, invalidated by mtime.
 *
 * Without this every /api/sessions call re-read and re-parsed the whole store —
 * 584 files, 99 MB — which measured 3.8-5.4s. Watch mode polls every 2s, so the
 * calls overlapped and the page could not finish a frame. A session only needs
 * re-parsing when its file has actually changed, which is one or two of them.
 */
const CACHE = new Map()   // path -> { mtimeMs, record }

export function buildIndex({ limit = 500 } = {}) {
  const files = walk(PROJ).map((f) => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, limit)
  const live = new Set(files.map(({ f }) => f))
  for (const k of CACHE.keys()) if (!live.has(k)) CACHE.delete(k)   // deleted by retention
  const sessions = files.map(({ f, t }) => {
    const hit = CACHE.get(f)
    if (hit && hit.mtimeMs === t) return hit.record
    const record = processTranscript(f)
    CACHE.set(f, { mtimeMs: t, record })
    return record
  }).filter(Boolean)
  const totals = {
    count: sessions.length,
    cost: +sessions.reduce((a, s) => a + s.cost, 0).toFixed(2),
    withArtifacts: sessions.filter((s) => s.hasArtifact).length,
    // a transcript written to in the last five minutes is a session still going
    live: sessions.filter((s) => s.live).length,
    byKind: {}, byModel: {},
  }
  for (const s of sessions) { totals.byKind[s.kind] = (totals.byKind[s.kind] ?? 0) + 1; totals.byModel[s.modelTier] = (totals.byModel[s.modelTier] ?? 0) + 1 }

  // ROI: value delivered per dollar, where value = log-scaled artifact bytes.
  // Percentile-ranked among sessions that actually produced an artifact, so the
  // number reads as "artifacts-per-dollar, better than N% of producing sessions".
  const producers = sessions.filter((s) => s.hasArtifact)
  for (const s of sessions) s.roiRaw = s.hasArtifact ? Math.log10(1 + s.artifactBytes) / (s.cost + 0.1) : null
  const ranked = producers.map((s) => s.roiRaw).sort((a, b) => a - b)
  for (const s of sessions) {
    if (!s.hasArtifact) { s.roi = null; continue }
    const below = ranked.filter((r) => r < s.roiRaw).length
    s.roi = Math.max(1, Math.round((below / Math.max(1, ranked.length - 1)) * 99) + 1)
  }
  totals.roiMedian = producers.length ? producers.map((s) => s.roi).sort((a, b) => a - b)[Math.floor(producers.length / 2)] : null
  return { generatedAt: new Date().toISOString(), totals, sessions }
}
