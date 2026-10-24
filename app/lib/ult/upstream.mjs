/**
 * Forwarding to the remote provider (Anthropic) or a local model (Ollama's
 * Anthropic-compatible /v1/messages, verified on Ollama 0.18).
 *
 * Streaming is passed through byte for byte while usage is read from the SSE events.
 * `forward` does not touch the client response until the upstream has answered with a
 * 2xx, so a failed route can still fall back to the requested model.
 */

const PASS_HEADERS = ['anthropic-version', 'anthropic-beta', 'content-type', 'accept', 'user-agent', 'x-app', 'anthropic-dangerous-direct-browser-access']
const OAUTH_BETA = 'oauth-2025-04-20'

/** Credentials ULT holds. The agent only ever has a dummy key. */
/**
 * Which credential the router uses, from its own environment (the launcher decides what to put
 * there — see credentials.mjs). The Claude subscription token is the default; an API key is used
 * only when AUTH_MODE / ULT_AUTH_MODE is api-key. Never falls back from one to the other.
 */
export function ultCredential(env = process.env) {
  const usable = (v) => v && !String(v).startsWith('op://') ? v : null
  if ((env.ULT_AUTH_MODE ?? env.AUTH_MODE) === 'api-key') {
    const key = usable(env.ANTHROPIC_API_KEY)
    return key ? { kind: 'api-key', value: key, env: 'ANTHROPIC_API_KEY' } : null
  }
  const tok = usable(env.CLAUDE_CODE_OAUTH_TOKEN)
  return tok ? { kind: 'oauth', value: tok, env: 'CLAUDE_CODE_OAUTH_TOKEN' } : null
}

/**
 * One free request to prove the credential works before a sandbox is started for it.
 * count_tokens costs nothing. A subscription (OAuth) token is only accepted on requests that
 * identify as Claude Code, so the check does too; a "Claude Code only" answer still proves the
 * token authenticated, and counts as valid.
 * @returns {Promise<{ok:boolean, status:number, message:string|null, restricted?:boolean}>}
 */
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
export async function verifyCredential(credential, baseUrl = 'https://api.anthropic.com', fetchImpl = fetch) {
  const client = { 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
  if (credential?.kind === 'oauth') client['anthropic-beta'] = 'claude-code-20250219'
  const headers = remoteHeaders(client, credential)
  const body = { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'ping' }] }
  if (credential?.kind === 'oauth') body.system = [{ type: 'text', text: CLAUDE_CODE_IDENTITY }]
  try {
    const r = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/messages/count_tokens`, {
      method: 'POST', headers, signal: AbortSignal.timeout(8000), body: JSON.stringify(body),
    })
    if (r.ok) return { ok: true, status: r.status, message: null }
    let message = null
    try { message = (await r.json())?.error?.message ?? null } catch {}
    if (credential?.kind === 'oauth' && r.status !== 401 && /claude code/i.test(message ?? '')) return { ok: true, status: r.status, message, restricted: true }
    return { ok: false, status: r.status, message }
  } catch (e) {
    return { ok: false, status: 0, message: e?.name === 'TimeoutError' ? 'timed out' : String(e?.cause?.code ?? e?.message) }
  }
}

export function remoteHeaders(clientHeaders, credential) {
  const h = {}
  for (const k of PASS_HEADERS) if (clientHeaders[k]) h[k] = clientHeaders[k]
  if (credential?.kind === 'api-key') h['x-api-key'] = credential.value
  else if (credential?.kind === 'oauth') {
    h.authorization = `Bearer ${credential.value}`
    const betas = new Set(String(h['anthropic-beta'] ?? '').split(',').map(s => s.trim()).filter(Boolean))
    betas.add(OAUTH_BETA)
    h['anthropic-beta'] = [...betas].join(',')
  } else {
    // No credential in ULT: pass the client's own (host mode with a logged-in claude).
    if (clientHeaders['x-api-key']) h['x-api-key'] = clientHeaders['x-api-key']
    if (clientHeaders.authorization) h.authorization = clientHeaders.authorization
  }
  return h
}

export function localHeaders(clientHeaders) {
  return { 'content-type': 'application/json', 'anthropic-version': clientHeaders['anthropic-version'] ?? '2023-06-01' }
}

/** Fields a local model server rejects or ignores badly. */
export function sanitizeForLocal(body, model) {
  const b = structuredClone(body)
  b.model = model
  for (const k of ['thinking', 'context_management', 'output_config', 'container', 'mcp_servers', 'service_tier']) delete b[k]
  const strip = (v) => {
    if (Array.isArray(v)) v.forEach(strip)
    else if (v && typeof v === 'object') { delete v.cache_control; Object.values(v).forEach(strip) }
  }
  strip(b.system); strip(b.messages); strip(b.tools)
  if (Array.isArray(b.messages)) {
    // Thinking blocks from earlier remote turns mean nothing to a local model.
    for (const m of b.messages) if (Array.isArray(m.content)) m.content = m.content.filter(c => c?.type !== 'thinking' && c?.type !== 'redacted_thinking')
  }
  return b
}

/**
 * Adapt a request built for one model to the model it is routed to. Claude Code sends
 * settings only its main model accepts (Haiku 4.5 rejects adaptive thinking with a 400,
 * observed 2026-09-30). Unknown targets are sent unchanged; the fallback catches the rest.
 */
export function adaptForModel(body, target, models = {}) {
  const b = structuredClone(body)
  b.model = target
  const base = target.replace(/-\d{8}$/, '')
  const caps = models[target] ?? models[base]
  if (!caps || typeof caps !== 'object') return b
  if (caps.maxOutput && b.max_tokens > caps.maxOutput) b.max_tokens = caps.maxOutput
  if (b.thinking && caps.thinking !== 'adaptive' && (b.thinking.type === 'adaptive' || caps.thinking === 'none')) {
    delete b.thinking
    if (Array.isArray(b.messages)) for (const m of b.messages) if (Array.isArray(m.content)) m.content = m.content.filter(c => c?.type !== 'thinking' && c?.type !== 'redacted_thinking')
  }
  if (!b.thinking && b.context_management?.edits) {
    // Clearing thinking needs thinking on; drop that edit, keep the others.
    b.context_management.edits = b.context_management.edits.filter(e => !String(e?.type).startsWith('clear_thinking'))
    if (!b.context_management.edits.length) delete b.context_management
  }
  if (caps.systemMessages === false && Array.isArray(b.messages) && b.messages.some(m => m?.role === 'system')) {
    // Mid-conversation system messages (a beta) fold into the top-level system prompt.
    const extra = b.messages.filter(m => m?.role === 'system').map(m => typeof m.content === 'string' ? m.content : (m.content ?? []).map(c => c?.text ?? '').join('\n')).filter(Boolean)
    b.messages = b.messages.filter(m => m?.role !== 'system')
    const sys = typeof b.system === 'string' ? [{ type: 'text', text: b.system }] : Array.isArray(b.system) ? b.system : []
    b.system = [...sys, ...extra.map(text => ({ type: 'text', text }))]
  }
  if (caps.effort === false) {
    if (b.output_config) {
      delete b.output_config.effort
      if (!Object.keys(b.output_config).length) delete b.output_config
    }
    // Per-turn control (a beta) puts output_config on individual messages as well.
    if (Array.isArray(b.messages)) for (const m of b.messages) delete m.output_config
  }
  return b
}

/** Beta flags the target does not support make the API apply settings it rejects. */
export function adaptHeaders(headers, target, models = {}) {
  const caps = models[target] ?? models[target.replace(/-\d{8}$/, '')]
  if (!caps?.dropBetas?.length || !headers['anthropic-beta']) return headers
  const kept = headers['anthropic-beta'].split(',').map(s => s.trim()).filter(b => b && !caps.dropBetas.some(p => b.startsWith(p)))
  const h = { ...headers }
  if (kept.length) h['anthropic-beta'] = kept.join(','); else delete h['anthropic-beta']
  return h
}

/** Incremental SSE reader: pulls usage out of message_start and message_delta. */
export class UsageTap {
  constructor() { this.buf = ''; this.usage = {}; this.model = null; this.stopReason = null }
  push(chunk) {
    this.buf += chunk
    let i
    while ((i = this.buf.indexOf('\n\n')) >= 0) {
      const evt = this.buf.slice(0, i); this.buf = this.buf.slice(i + 2)
      const data = evt.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('')
      if (!data) continue
      let d; try { d = JSON.parse(data) } catch { continue }
      if (d.type === 'message_start' && d.message) {
        this.model = d.message.model ?? this.model
        Object.assign(this.usage, d.message.usage ?? {})
      } else if (d.type === 'message_delta') {
        if (d.usage) for (const [k, v] of Object.entries(d.usage)) if (v != null) this.usage[k] = v
        this.stopReason = d.delta?.stop_reason ?? this.stopReason
      }
    }
  }
}

/**
 * @param {object} o
 * @param {string} o.url            full upstream URL
 * @param {object} o.headers
 * @param {string} o.body           JSON text
 * @param {import('node:http').ServerResponse} o.res   client response
 * @param {number} o.timeoutMs
 * @returns {Promise<{ok, status, usage, model, ttftMs, latencyMs, error?, errorBody?}>}
 *   ok=false with nothing written to `res` means the caller may fall back.
 */
export async function forward({ url, headers, body, res, timeoutMs = 600000, fetchImpl = fetch, method = 'POST' }) {
  const t0 = Date.now()
  let up
  try {
    up = await fetchImpl(url, { method, headers, body: method === 'GET' ? undefined : body, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    return { ok: false, status: 0, error: e?.name === 'TimeoutError' ? 'timeout' : `unreachable: ${e?.cause?.code ?? e?.message}`, latencyMs: Date.now() - t0 }
  }
  if (!up.ok) {
    const errorBody = await up.text().catch(() => '')
    return { ok: false, status: up.status, error: `http-${up.status}`, errorBody, headers: up.headers, latencyMs: Date.now() - t0 }
  }
  const ct = up.headers.get('content-type') ?? ''
  const out = {}
  up.headers.forEach((v, k) => { if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(k)) out[k] = v })
  res.writeHead(up.status, out)
  let ttftMs = null
  if (ct.includes('text/event-stream') && up.body) {
    const tap = new UsageTap()
    const dec = new TextDecoder()
    for await (const chunk of up.body) {
      if (ttftMs === null) ttftMs = Date.now() - t0
      res.write(chunk)
      tap.push(dec.decode(chunk, { stream: true }))
    }
    res.end()
    return { ok: true, status: up.status, usage: tap.usage, model: tap.model, stopReason: tap.stopReason, ttftMs, latencyMs: Date.now() - t0 }
  }
  const text = await up.text()
  ttftMs = Date.now() - t0
  res.end(text)
  let usage = {}, model = null
  try { const j = JSON.parse(text); usage = j.usage ?? {}; model = j.model ?? null } catch {}
  return { ok: true, status: up.status, usage, model, ttftMs, latencyMs: Date.now() - t0 }
}

/**
 * A local model's answer, held back until it is known to be usable. Nothing reaches the client
 * until the whole answer is in: no first token within `firstTokenMs` is `slow`, a tool call whose
 * name was not offered or whose input is not a JSON object is `malformed`, and either way the
 * caller can still send the request to the remote model. Local answers are short by policy
 * (background calls, tool-less turns), so buffering costs little.
 * @returns {Promise<{ok, status, error?, chunks?, headers?, usage, model, ttftMs, latencyMs}>}
 */
export async function forwardLocal({ url, headers, body, tools = [], firstTokenMs = 5000, timeoutMs = 120000, fetchImpl = fetch }) {
  const t0 = Date.now()
  const ctl = new AbortController()
  let why = 'slow'
  let timer = setTimeout(() => ctl.abort(), firstTokenMs)
  const fail = (error, status = 0, extra = {}) => { clearTimeout(timer); ctl.abort(); return { ok: false, status, error, latencyMs: Date.now() - t0, ...extra } }
  let up
  try {
    up = await fetchImpl(url, { method: 'POST', headers, body, signal: ctl.signal })
  } catch (e) {
    return fail(ctl.signal.aborted ? why : `failed: ${e?.cause?.code ?? e?.message}`)
  }
  if (!up.ok) return fail(`failed: http-${up.status}`, up.status, { errorBody: await up.text().catch(() => '') })
  const chunks = []
  let ttftMs = null
  try {
    for await (const chunk of up.body) {
      if (ttftMs === null) {
        ttftMs = Date.now() - t0
        clearTimeout(timer); why = 'timeout'
        timer = setTimeout(() => ctl.abort(), Math.max(0, timeoutMs - ttftMs))
      }
      chunks.push(Buffer.from(chunk))
    }
  } catch {
    return fail(why)
  }
  clearTimeout(timer)
  const text = Buffer.concat(chunks).toString('utf8')
  const sse = (up.headers.get('content-type') ?? '').includes('text/event-stream')
  const offered = new Set(tools.map((t) => t?.name).filter(Boolean))
  const calls = sse ? toolCallsFromSse(text) : toolCallsFromJson(text)
  const bad = calls.find((c) => !offered.has(c.name) || !c.input || typeof c.input !== 'object' || Array.isArray(c.input))
  if (bad) return fail('malformed', 200, { detail: !offered.has(bad.name) ? `tool ${bad.name} was not offered` : 'tool input is not a JSON object' })
  let usage = {}, model = null
  if (sse) { const tap = new UsageTap(); tap.push(text + '\n\n'); usage = tap.usage; model = tap.model }
  else { try { const j = JSON.parse(text); usage = j.usage ?? {}; model = j.model ?? null } catch { return fail('malformed', 200, { detail: 'not JSON' }) } }
  const out = {}
  up.headers.forEach((v, k) => { if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(k)) out[k] = v })
  return { ok: true, status: up.status, headers: out, chunks, usage, model, ttftMs, latencyMs: Date.now() - t0 }
}

/** Send a buffered local answer to the client. */
export function writeBuffered(res, r) {
  res.writeHead(r.status, r.headers)
  for (const c of r.chunks) res.write(c)
  res.end()
}

function toolCallsFromJson(text) {
  try { return (JSON.parse(text).content ?? []).filter((b) => b?.type === 'tool_use').map((b) => ({ name: b.name, input: b.input })) } catch { return [] }
}

function toolCallsFromSse(text) {
  const open = new Map(), calls = []
  for (const evt of text.split('\n\n')) {
    const data = evt.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
    if (!data) continue
    let d; try { d = JSON.parse(data) } catch { continue }
    if (d.type === 'content_block_start' && d.content_block?.type === 'tool_use') open.set(d.index, { name: d.content_block.name, json: '', input: d.content_block.input })
    else if (d.type === 'content_block_delta' && d.delta?.type === 'input_json_delta' && open.has(d.index)) open.get(d.index).json += d.delta.partial_json ?? ''
    else if (d.type === 'content_block_stop' && open.has(d.index)) {
      const c = open.get(d.index); open.delete(d.index)
      let input = null
      try { input = c.json ? JSON.parse(c.json) : (c.input ?? {}) } catch { input = null }
      calls.push({ name: c.name, input })
    }
  }
  for (const c of open.values()) calls.push({ name: c.name, input: null })     // never closed
  return calls
}

/** Relay an upstream failure to the client unchanged (when no fallback applies). */
export function relayFailure(res, r) {
  if (res.headersSent) return res.end()
  const status = r.status || 502
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(r.errorBody || JSON.stringify({ type: 'error', error: { type: 'api_error', message: `ULT: upstream ${r.error}` } }))
}
