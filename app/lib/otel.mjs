/**
 * A local OpenTelemetry receiver for Claude Code: `opt monitor on` points Claude Code's OTLP
 * exporter here, and the hub (or `opt monitor collect`) stores what arrives as one ndjson file
 * per day under OPT_HOME/otel. Nothing leaves the machine.
 *
 * Claude Code sends three signals over OTLP/HTTP with JSON bodies (http/json):
 *   /v1/logs     events: claude_code.api_request, tool_result, tool_decision, compaction, ...
 *   /v1/metrics  counters: claude_code.active_time.total, cost.usage, token.usage, ...
 *   /v1/traces   spans (beta): claude_code.interaction > llm_request / tool > tool.blocked_on_user
 *
 * Records are flattened on the way in, one line each:
 *   { k: 'log', t, name, a }   { k: 'metric', t, name, v, a }   { k: 'span', t, end, name, trace, id, parent, a, err }
 * Prompt text and tool inputs never arrive unless the user sets Claude Code's OTEL_LOG_* gates,
 * which opt monitor leaves off.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'
import { stateDir } from './state.mjs'

export const OTLP_PORT = Number(process.env.OPT_OTLP_PORT ?? 4320)
const KEEP_DAYS = Number(process.env.OPT_OTEL_KEEP_DAYS ?? 30)
const MAX_BODY = 32 * 1024 * 1024
const dir = () => stateDir('otel')
const dayFile = (ms) => path.join(dir(), new Date(ms).toISOString().slice(0, 10) + '.ndjson')

/** OTLP JSON AnyValue → a plain value. intValue arrives as a string (int64). */
function val(v) {
  if (!v || typeof v !== 'object') return v ?? null
  if ('stringValue' in v) return v.stringValue
  if ('intValue' in v) return Number(v.intValue)
  if ('doubleValue' in v) return Number(v.doubleValue)
  if ('boolValue' in v) return !!v.boolValue
  if ('arrayValue' in v) return (v.arrayValue?.values ?? []).map(val)
  if ('kvlistValue' in v) return attrs(v.kvlistValue?.values)
  if ('bytesValue' in v) return v.bytesValue
  return null
}
const attrs = (list) => Object.fromEntries((list ?? []).map((x) => [x.key, val(x.value)]))
const ms = (nano) => (nano == null || nano === '' || nano === '0' ? null : Number(BigInt(nano) / 1000000n))

/** One OTLP export request → flat records. `signal` is 'logs' | 'metrics' | 'traces'. */
export function flatten(signal, body) {
  const out = []
  if (signal === 'logs') {
    for (const rl of body.resourceLogs ?? []) {
      const res = attrs(rl.resource?.attributes)
      for (const sl of rl.scopeLogs ?? []) for (const r of sl.logRecords ?? []) {
        const a = { ...res, ...attrs(r.attributes) }
        out.push({ k: 'log', t: ms(r.timeUnixNano) ?? ms(r.observedTimeUnixNano) ?? Date.now(), name: a['event.name'] ? `claude_code.${String(a['event.name']).replace(/^claude_code\./, '')}` : String(val(r.body) ?? ''), a })
      }
    }
  } else if (signal === 'metrics') {
    for (const rm of body.resourceMetrics ?? []) {
      const res = attrs(rm.resource?.attributes)
      for (const sm of rm.scopeMetrics ?? []) for (const m of sm.metrics ?? []) {
        const data = m.sum ?? m.gauge ?? null
        for (const p of data?.dataPoints ?? [])
          out.push({ k: 'metric', t: ms(p.timeUnixNano) ?? Date.now(), name: m.name, v: p.asDouble != null ? Number(p.asDouble) : Number(p.asInt ?? 0), a: { ...res, ...attrs(p.attributes) } })
      }
    }
  } else if (signal === 'traces') {
    for (const rs of body.resourceSpans ?? []) {
      const res = attrs(rs.resource?.attributes)
      for (const ss of rs.scopeSpans ?? []) for (const s of ss.spans ?? [])
        out.push({ k: 'span', t: ms(s.startTimeUnixNano), end: ms(s.endTimeUnixNano), name: s.name, trace: s.traceId, id: s.spanId,
                   parent: s.parentSpanId || null, a: { ...res, ...attrs(s.attributes) }, err: s.status?.code === 2 || s.status?.code === 'STATUS_CODE_ERROR' })
    }
  }
  return out
}

/** Append records to their day files. */
export function store(records) {
  const byFile = {}
  for (const r of records) (byFile[dayFile(r.t ?? Date.now())] ??= []).push(JSON.stringify(r))
  for (const [f, lines] of Object.entries(byFile)) fs.appendFileSync(f, lines.join('\n') + '\n')
  return records.length
}

export const STATS = { received: 0, batches: 0, last: null, protobufWarned: false }

/**
 * Handle POST {prefix}/v1/{logs,metrics,traces}. Returns false when the path is not an OTLP one,
 * so a server can mount this beside its own routes.
 */
export function handleOtlp(req, res, pathname, prefix = '') {
  const m = pathname.match(new RegExp(`^${prefix}/v1/(logs|metrics|traces)$`))
  if (!m) return false
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return true }
  const ct = String(req.headers['content-type'] ?? '')
  if (/protobuf/.test(ct)) {
    if (!STATS.protobufWarned) { STATS.protobufWarned = true; console.error('  otel: got protobuf; set OTEL_EXPORTER_OTLP_PROTOCOL=http/json (opt monitor on does)') }
    res.writeHead(415, { 'content-type': 'text/plain' }); res.end('send http/json'); return true
  }
  const chunks = []; let size = 0
  req.on('data', (c) => { size += c.length; if (size > MAX_BODY) req.destroy(); else chunks.push(c) })
  req.on('end', () => {
    try {
      let buf = Buffer.concat(chunks)
      if (/gzip/.test(String(req.headers['content-encoding'] ?? ''))) buf = zlib.gunzipSync(buf)
      const n = store(flatten(m[1], JSON.parse(buf.toString('utf8') || '{}')))
      STATS.received += n; STATS.batches++; STATS.last = Date.now()
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}')
    } catch (e) {
      res.writeHead(400, { 'content-type': 'text/plain' }); res.end(String(e?.message ?? e).slice(0, 200))
    }
  })
  return true
}

/** Delete day files older than OPT_OTEL_KEEP_DAYS. */
export function prune(now = Date.now()) {
  const cut = new Date(now - KEEP_DAYS * 864e5).toISOString().slice(0, 10)
  for (const f of fs.readdirSync(dir())) if (/^\d{4}-\d{2}-\d{2}\.ndjson$/.test(f) && f.slice(0, 10) < cut) fs.rmSync(path.join(dir(), f), { force: true })
}

/** The receiver on its own port (127.0.0.1 only). GET /health answers for `opt monitor status`. */
export function startCollector({ port = OTLP_PORT, log = false } = {}) {
  try { prune() } catch {}
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname
    if (p === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, collector: 'opt', dir: dir(), ...STATS })) }
    const before = STATS.received
    if (handleOtlp(req, res, p)) { if (log) res.on('finish', () => STATS.received > before && console.log(`  ${new Date().toLocaleTimeString()}  ${p}  +${STATS.received - before}`)); return }
    res.writeHead(404); res.end()
  })
  return new Promise((resolve) => {
    server.on('error', (e) => resolve({ error: e.code === 'EADDRINUSE' ? `port ${port} is busy (another collector?)` : String(e.message) }))
    server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${port}` }))
  })
}

/** Everything stored since `sinceMs`, oldest day first. */
export function readOtel({ sinceMs = Date.now() - 7 * 864e5 } = {}) {
  let files = []
  try { files = fs.readdirSync(dir()).filter((f) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(f)).sort() } catch { return [] }
  const from = new Date(sinceMs).toISOString().slice(0, 10)
  const out = []
  for (const f of files) {
    if (f.slice(0, 10) < from) continue
    for (const line of fs.readFileSync(path.join(dir(), f), 'utf8').split('\n')) {
      if (!line) continue
      try { const r = JSON.parse(line); if ((r.t ?? 0) >= sinceMs) out.push(r) } catch {}
    }
  }
  return out
}
