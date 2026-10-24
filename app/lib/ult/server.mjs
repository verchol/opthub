/**
 * LLM Ultra Light — the router behind `opt claude optimize` (and other agents to come).
 *
 *   POST /v1/messages              classify → decide → forward → audit
 *   POST /v1/messages/count_tokens forwarded to the remote provider unchanged
 *   GET  /healthz                  liveness
 *   GET  /ult/status               counts for this run
 *   anything else                  forwarded to the remote provider, audited as passthrough
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { extractFeatures, publicFeatures } from './features.mjs'
import { Classifier } from './classifier.mjs'
import { ContextStore } from './context-store.mjs'
import { decide, priceOf } from './policy.mjs'
import { AuditLog } from './audit.mjs'
import { forward, forwardLocal, writeBuffered, relayFailure, remoteHeaders, localHeaders, sanitizeForLocal, scopeForLocal, adaptForModel, adaptHeaders, ultCredential } from './upstream.mjs'
import { LocalGate, caps as capsOf, fitCheck, estimateTokens, loadProfile } from './capacity.mjs'

export const ULT_VERSION = '0.1.0'

/** Priced from real usage; cache writes at the 5-minute rate (the conservative side). */
export function priceUsage(usage, model, cfg) {
  if (!usage || !model) return null
  if (model.startsWith('local:')) return 0
  const p = priceOf(model, cfg.prices)
  if (!p) return null
  const [pin, pout] = p
  const c = cfg.cache
  // The API splits cache writes by TTL; 1-hour writes cost 2x input, 5-minute 1.25x.
  const w1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const w5m = usage.cache_creation ? (usage.cache_creation.ephemeral_5m_input_tokens ?? 0) : (usage.cache_creation_input_tokens ?? 0)
  return ((usage.input_tokens ?? 0) * pin
    + (usage.cache_read_input_tokens ?? 0) * pin * c.read
    + w5m * pin * c.write5m + w1h * pin * c.write1h
    + (usage.output_tokens ?? 0) * pout) / 1e6
}

const readBody = (req) => new Promise((resolve, reject) => {
  const parts = []
  req.on('data', d => parts.push(d))
  req.on('end', () => resolve(Buffer.concat(parts)))
  req.on('error', reject)
})

/**
 * @param {object} o
 * @param {object} o.config        resolved ULT config
 * @param {string} o.runDir        where audit.jsonl and run.json go
 * @param {string|null} o.contextFile  persisted classifier context (null = memory only)
 * @param {object} [o.env]
 * @param {Function} [o.fetchImpl]
 * @param {boolean} [o.inDocker]   use local.dockerBaseUrl
 * @param {string|null} [o.stateDir] where `opt models bench` profiles live (capacity caps from measurement)
 */
export function createUlt({ config, runDir, contextFile = null, env = process.env, fetchImpl = fetch, inDocker = false, configHash = null, stateDir = null, log = () => {} }) {
  fs.mkdirSync(runDir, { recursive: true })
  const store = new ContextStore({ file: config.classifier?.context?.persist === false ? null : contextFile, history: config.classifier?.context?.historyPerSession ?? 50 })
  const classifier = new Classifier({ config: config.classifier, store, jevKey: env.JEV_API_KEY, fetchImpl })
  const audit = new AuditLog(path.join(runDir, 'audit.jsonl'))
  const credential = ultCredential(env)
  const remoteBase = config.remote.baseUrl.replace(/\/$/, '')
  const localBase = (inDocker ? config.local.dockerBaseUrl : config.local.baseUrl)?.replace(/\/$/, '')
  // Local capacity: checked once (fit) and per request (context, slots, breaker). See capacity.mjs.
  const gate = config.local.enabled ? new LocalGate({ caps: capsOf(config.local, stateDir ? loadProfile(stateDir, config.local.model) : null) }) : null
  if (gate) {
    gate.fitter = (model) => fitCheck({ baseUrl: localBase, model, numCtx: gate.c.numCtx, kvType: config.local.kvCacheType,
      ...(config.local.hostMemoryBytes ? { totalMem: config.local.hostMemoryBytes } : {}), fetchImpl })
    gate.fitFor(config.local.model)   // checked at start; other local models on first use
  }
  const stats = { started: new Date().toISOString(), mode: config.mode, policy: config.policy.version, pin: config.policy.pin ?? null,
    local: config.local.enabled ? config.local.model : null, jev: !!config.classifier?.jev?.enabled,
    capacity: gate ? { caps: gate.c, refused: gate.counts } : null,
    requests: 0, byClass: {}, byDecision: {}, acted: 0, wouldAct: 0, fallbacks: 0, costUsd: 0, counterfactualUsd: 0, last: null }

  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
    ult: ULT_VERSION, started: stats.started, mode: config.mode, policy: config.policy.version,
    configHash, credential: credential?.kind ?? 'client-passthrough', local: config.local.enabled ? `${localBase} ${config.local.model}` : 'disabled',
    config,
  }, null, 2))

  async function passthrough(req, res, url, raw) {
    const r = await forward({ url: remoteBase + url, method: req.method, headers: remoteHeaders(req.headers, credential), body: raw.length ? raw : undefined, res, fetchImpl })
    if (!r.ok) relayFailure(res, r)
    audit.append({ kind: 'passthrough', path: url.split('?')[0], method: req.method, status: r.status, latency_ms: r.latencyMs })
  }

  async function messages(req, res, url, raw) {
    let body
    try { body = JSON.parse(raw.toString('utf8')) } catch { return passthrough(req, res, url, raw) }
    const t0 = Date.now()
    const f = extractFeatures(body)
    const c = await classifier.classify(f)
    const threadTarget = store.threadTarget(f.thread)
    const d = decide({ cls: c.cls, confidence: c.confidence, features: f, config, threadTarget })
    const acted = config.mode === 'route' && d.wouldAct

    const original = () => forward({ url: remoteBase + url, headers: remoteHeaders(req.headers, credential), body: raw, res, fetchImpl })
    let r, decision = acted ? d.decision : 'keep', target = acted ? d.target : f.requestedModel, fallbackFrom = null, capacity = null
    // A local proposal is checked against capacity in both modes, so shadow logs say whether it would have run.
    const localModel = d.decision === 'local' ? d.target.slice(6) : null
    const scoped = d.scoped ? scopeForLocal(body, localModel, { budgetTokens: config.local.scopedTokens ?? 3000 }) : null
    const admission = localModel && gate ? await gate.admit(estimateTokens(scoped ?? body), localModel) : null
    if (admission && !admission.ok) { capacity = { reason: admission.reason, why: admission.why }; gate.count(admission.reason) }
    if (acted && d.decision === 'local' && capacity) {
      decision = 'keep'; target = f.requestedModel
      r = await original()
    } else if (acted && d.decision === 'local') {
      gate?.start()
      r = await forwardLocal({ url: `${localBase}/v1/messages`, headers: localHeaders(req.headers),
        body: JSON.stringify(scoped ?? sanitizeForLocal(body, localModel)), tools: scoped ? [] : body.tools ?? [],
        firstTokenMs: gate?.c.firstTokenMs, timeoutMs: config.local.timeoutMs, fetchImpl })
      const outcome = r.ok ? 'ok' : r.error === 'slow' || r.error === 'malformed' ? r.error : 'failed'
      gate?.end(outcome)
      if (r.ok) writeBuffered(res, r)
      else { capacity = { reason: outcome, why: r.detail ?? r.error }; gate?.count(outcome) }
    } else if (acted && d.decision === 'route') {
      const routed = adaptForModel(body, d.target, config.models)
      if (env.ULT_DEBUG_SHAPE) log(`routed request shape: ${JSON.stringify(Object.fromEntries(Object.entries(routed).filter(([k]) => !['messages', 'system', 'tools', 'metadata'].includes(k))))} beta=${req.headers['anthropic-beta'] ?? ''}`)
      r = await forward({ url: remoteBase + url, headers: adaptHeaders(remoteHeaders(req.headers, credential), d.target, config.models), body: JSON.stringify(routed), res, fetchImpl })
    } else {
      r = await original()
    }
    // Retry on the requested model — except for credential failures, which the same key
    // would hit again. A 400 is retried: the routed model may reject a field the original accepts.
    if (!r.ok && acted && ![401, 403].includes(r.status)) {
      let message = null
      try { message = JSON.parse(r.errorBody ?? '')?.error?.message?.slice(0, 300) ?? null } catch {}
      fallbackFrom = { target: d.target, error: r.error, status: r.status, message }
      decision = 'fallback'; target = f.requestedModel
      r = await original()
    }
    if (!r.ok) relayFailure(res, r)

    // A new thread that was routed stays on its target (cache stays warm).
    if (r.ok && acted && !fallbackFrom && !d.scoped && config.policy.stickyThreads && f.messages <= 2 && !threadTarget) store.pinThread(f.thread, d.target)

    const actualModel = decision === 'local' ? target : (r.model ?? target)
    const cost = priceUsage(r.usage, target, config)
    const counterfactual = priceUsage(r.usage, f.requestedModel, config)
    const entry = audit.append({
      kind: 'request', path: url.split('?')[0], session: f.session, thread: f.thread,
      requested_model: f.requestedModel, stream: f.stream,
      features: (({ promptSha256, session, thread, requestedModel, stream, ...rest }) => rest)(publicFeatures(f)),
      class: c.cls, confidence: +(c.confidence ?? 0).toFixed(3), source: c.source, why: c.why, jev: c.jev ?? null,
      mode: config.mode, decision, acted: acted && !fallbackFrom, proposed: { decision: d.decision, target: d.target },
      target, actual_model: actualModel, reason: d.reason, fallback_from: fallbackFrom, capacity, scoped: !!d.scoped,
      scoped_tokens: scoped ? estimateTokens(scoped) : null,
      est_keep_usd: d.estKeepUsd, est_route_usd: d.estRouteUsd,
      status: r.status, error: r.ok ? null : r.error, latency_ms: Date.now() - t0, ttft_ms: r.ttftMs ?? null,
      usage: r.usage ?? null, cost_usd: cost, counterfactual_usd: counterfactual,
      prompt_sha256: f.promptSha256, prompt_chars: f.promptChars,
      ...(config.audit?.prompts && f.humanTurn ? { prompt_text: f.promptText } : {}),
    })
    stats.requests++
    stats.byClass[c.cls] = (stats.byClass[c.cls] ?? 0) + 1
    stats.byDecision[decision] = (stats.byDecision[decision] ?? 0) + 1
    if (entry.acted) stats.acted++
    if (fallbackFrom) stats.fallbacks++
    stats.costUsd += cost ?? 0
    stats.counterfactualUsd += counterfactual ?? 0
    if (config.mode === 'shadow' && d.wouldAct) stats.wouldAct++
    // What the status line shows: the latest request the person's work produced (side calls excluded).
    if (c.cls !== 'background/utility' || !stats.last) {
      stats.last = { at: entry.ts, class: c.cls, source: c.source, decision, target, acted: entry.acted,
        proposed: d.wouldAct ? { decision: d.decision, target: d.target } : null, fallback: !!fallbackFrom, status: r.status }
    }
    const note = fallbackFrom ? ` [${fallbackFrom.target} failed: ${fallbackFrom.status} ${fallbackFrom.message ?? ''}]` : config.mode === 'shadow' && d.wouldAct ? ` [shadow: would ${d.decision} ${d.target}]` : ''
    log(`${entry.seq} ${c.cls} (${c.source} ${entry.confidence}) → ${decision}${note} · ${r.status}`)
  }

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/'
    const p = url.split('?')[0]
    try {
      if (req.method === 'GET' && p === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, ult: ULT_VERSION, mode: config.mode })) }
      if (req.method === 'GET' && p === '/ult/status') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(stats, null, 2)) }
      const raw = await readBody(req)
      if (req.method === 'POST' && p === '/v1/messages') return await messages(req, res, url, raw)
      return await passthrough(req, res, url, raw)
    } catch (e) {
      log(`error: ${e?.stack ?? e}`)
      try { audit.append({ kind: 'error', path: p, error: String(e?.message ?? e) }) } catch {}
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `ULT: ${e?.message ?? e}` } })) }
      else res.end()
    }
  })

  return {
    server, stats, store, auditFile: audit.file,
    listen: (port = config.listen.port, host = config.listen.host) => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => resolve(server.address()))
    }),
    close: () => new Promise(resolve => { store.flush(); server.close(() => resolve()); server.closeAllConnections?.() }),
    summary: () => stats,
  }
}
